# Bank alerts: email, SMS, IMAP, forwarding

Ledger turns Nigerian bank alerts into ledger rows in near real time. Everything is **read-only**. Alert bodies and names are never sent to a cloud model.

After pulling this change, from `finance-app`:

```bash
npm install
npm run db:push
```

## Environment

| Variable | Purpose |
|---|---|
| `ALERT_SYNC_MINUTES` | Background Gmail/IMAP interval. Default `5`. |
| `ALERT_SYNC` | Set to `0` to disable the loop (tests do this automatically). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail read-only. Personal Cloud project, External consent, **test users** listed. See [gmail-oauth.md](gmail-oauth.md). |
| `IMAP_PASSWORD` or `YAHOO_APP_PASSWORD` | App password for IMAP. **Not** stored in the database. Also accepted from `~/.ledger/secrets.env` (`LEDGER_SECRET_FILE` overrides the path). |
| `IMAP_PASSWORD_<connectionId>` | Per-mailbox password when you have more than one. |
| `INBOUND_EMAIL_SECRET` | Shared secret for `POST /api/inbound/email` (`X-Inbound-Secret` or `Authorization: Bearer`). |
| `INBOUND_EMAIL_DOMAIN` | Public domain for `alerts-<token>@domain`. Leave unset to run locally with no domain. |
| `POSTMARK_INBOUND_SECRET` | Alternate inbound secret; `X-Postmark-Signature` HMAC-SHA256 is also accepted. |
| `SMS_SENDERS` | Extra SMS sender IDs (comma-separated) on top of the built-in bank allowlist. |
| `LEDGER_USER_EMAIL` | Account used by `npm run alerts:mac-messages`. |

Never put IMAP passwords, inbound secrets, or raw alert samples in the repo. Unparsed samples, when saved, go to `~/.ledger/alert-samples` (or `ALERT_SAMPLE_DIR`).

## Gmail (owner, now)

1. Create a Google Cloud OAuth client on a **personal** account. Add yourself as a test user. Scopes: `gmail.readonly` only ([gmail-oauth.md](gmail-oauth.md)).
2. Sign in → Accounts → Connect Gmail.
3. Background sync starts with the Next.js server (`next dev -H 0.0.0.0`). **Sync now** and last-synced time are on Accounts and Settings (web + Flutter).
4. Incremental: Gmail `historyId` when it is still valid, otherwise `after:` date. Restarts are safe; processed message ids make overlap free. Token refresh and exponential backoff are built in.

**Import past alerts** (Accounts) clears the watermark and scans again (default 365-day first lookback).

## Yahoo Mail / IMAP

1. Yahoo → Account security → generate an **app password** (not your login password).
2. Accounts → Yahoo Mail and other IMAP: host `imap.mail.yahoo.com`, port `993`, your Yahoo email.
3. On the Mac that runs Ledger, put `IMAP_PASSWORD=xxxx` in `.env` or `~/.ledger/secrets.env`. Restart `next dev`. The API never returns this value.
4. Sync now, or wait for the background loop.

## Personal forwarding address (friends later)

Each user gets `alerts-<token>@<INBOUND_EMAIL_DOMAIN>`. Locally, no domain is required: Settings shows the token and tells you to set the domain when you have a public inbound receiver.

`POST /api/inbound/email` accepts:

- Generic JSON: `{ to, from, subject, text?, html?, date?, messageId? }`
- Cloudflare Email Workers (`to` / `from` / `subject` / `text` / `html`)
- Postmark inbound (`To`, `From`, `Subject`, `TextBody`, `HtmlBody`, `MessageID`)

Verify with `X-Inbound-Secret` (or Postmark signature). The `to` address maps the token to a user. Gmail forwarding confirmation codes/links are stored and shown in Settings — they are not parsed as transactions.

**Gmail setup for a friend**

1. Settings → copy the forwarding address.
2. Gmail → Settings → Forwarding and POP/IMAP → Add a forwarding address.
3. Open Ledger Settings and tap the confirmation code or link.
4. Download **Gmail filters** (Settings) and import them (Gmail → Filters and Blocked Addresses → Import). Only known bank senders are forwarded.

**Deployment options** (no domain needed to develop):

- Local only: Gmail OAuth + IMAP + Android SMS over Tailscale. Skip inbound.
- Cloudflare Email Routing → Worker `POST`s to your Mac/mini with `X-Inbound-Secret`.
- Postmark inbound webhook to the same path.

## Android SMS (sideloaded APK)

Google Play restricts `RECEIVE_SMS` / `READ_SMS`. This path is for the sideloaded Samsung APK, not a Play listing.

1. Settings → Bank alerts → turn on **SMS bank alerts**. The app explains that only `GTBank`, `GTWorld`, `FirstBank`, `Sterling` and `Providus` are read.
2. Grant SMS permission when Android asks (`READ_SMS` and `RECEIVE_SMS`). The opt-in flag is set only if you allow it. Denying leaves the switch off. If Android will not ask again, the dialog opens the app’s settings.
3. The first time you enable it, Ledger offers a one-time import of bank SMS from the start of the current month. Same sender filter as the live receiver. Personal numbers and telcos (`303`, `GloDataSale`, …) are dropped on the phone and never uploaded. SMS bodies are not logged.
4. Queued bank SMS go to `POST /api/v1/alerts/sms` as `{ sender, body, receivedAt, sourceId }` (or `messages: [...]`). `sourceId` is a stable hash of sender, timestamp and body so a retry is the same SMS. The server dedups that id within SMS, and parses `body` (amount, direction, account, narration, balance, date in the text) to merge with email and statement rows. `receivedAt` is the original SMS time, used when the text has no date. Upload runs on **Sync now**, when the app opens, and right after capture while the app is online. A message is removed from the phone queue only after the server accepts it.
5. Bank alerts shows the last SMS sync time and the captured / sent counts.

A `NotificationListenerService` stub exists for bank-app push notifications as a fallback if SMS permission is unavailable later.

## iPhone Shortcuts

`POST /api/v1/alerts/sms` accepts a personal token (Settings → iPhone Shortcuts token).

1. Shortcuts → Automation → Create Personal Automation → **Message** → Sender `GTBank` (repeat per bank ID).
2. Action: **Get Contents of URL**.
   - URL: `http://<tailscale-ip>:3000/api/v1/alerts/sms`
   - Method: POST
   - Headers: `Content-Type: application/json`, `X-Ledger-Sms-Token: <token>`
   - Body (JSON): `{ "sender": "GTBank", "body": "<Message Content>", "receivedAt": "<Current Date>" }`
3. Use the **Shortcut Input** / Message Content variable for `body`.
4. Turn off “Ask Before Running” if you want it unattended. The phone must reach the Mac over Tailscale.

The same JSON works from curl for debugging.

## macOS Messages importer

On the self-hosted Mac (Full Disk Access for Terminal or your Node binary):

```bash
LEDGER_USER_EMAIL=you@example.com npm run alerts:mac-messages
```

Read-only against `~/Library/Messages/chat.db`. Only configured bank sender IDs are selected. When `text` is null, `attributedBody` is scanned for the alert string. Non-bank threads are never opened. Run on an interval via `cron` or `launchd` if you like.

## Dedup and Review

SMS, email alerts and statement rows for the same account / amount / direction / time window / similar narration merge. When a statement already covers that day, an alert with the same account, amount and direction merges with one unclaimed statement row on that Lagos day or the next one (WAT value date versus an evening SMS). A row already linked to a statement, or to an alert of the same channel, is not claimed again. A repeat a week later does not merge. Accounts imported before coverage was stored get their span from the earliest and latest statement row (`npm run alerts:backfill-coverage`), without opening review flags. `npm run alerts:link-sms` prints date, direction and amount for SMS that now match exactly one statement row; add `--apply` to write. Apply keeps the statement row (category, person, transfer pair, fees) and records the SMS on it. Statement is the source of truth: it links rather than duplicates. Source badges show every observation.

- **Fees** (`Commission on NIP Transfer`, VAT, stamp duty, …) link to the adjacent transfer (same minute, same account) as category Fees.
- **Balance gaps**: previous Bal ± Amt ≠ this Bal → “possible missed transaction” in Review.
- **Reconciliation** after a statement covers a date: alert without a statement row, or statement row without an alert.
- **Unparsed** alerts from bank senders wait in Review. Samples stay local.

## Parsers

One registry (`src/core/alerts`), keyed by channel + sender.

| Parser | Status |
|---|---|
| GTBank email | Existing high-confidence HTML parser |
| GTBank SMS (`GTBank`) | High confidence (DR and CR) |
| FirstBank SMS debit + credit | High confidence |
| Sterling Money In / Money Out | High confidence; marketing ignored |
| Providus SMS | Low confidence stub → Review |
| First Bank / Sterling **email**, other bank SMS | Stubs + test scaffolding (TODO: real samples) |
| Generic Amt/NGN/Dr/Cr/Bal fallback | Low confidence → Review, never auto-posted |
