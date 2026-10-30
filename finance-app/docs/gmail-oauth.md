# Gmail OAuth setup

About 15 minutes. Until Google verifies the app, only test users you list can connect (up to 100).

1. Google Cloud console → create a project.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **OAuth consent screen** → External → app name, support email.
   - Scopes: add `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`, `.../auth/gmail.readonly`. Nothing else.
   - Test users: add each tester's Gmail address.
4. **Credentials → Create credentials → OAuth client ID** → Web application.
   - Authorized redirect URIs:
     - `http://localhost:3000/api/auth/google/callback` (Continue with Google sign-in, identity only)
     - `https://<your-public-host>/api/v1/email/google/callback` (every Gmail inbox connect: the website and the phone)
     - Do not register `APP_URL/api/gmail/callback`. Google only has the public Gmail callback.
5. Put the client id and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. `APP_URL` is where the website sends you after Gmail connects (`/app/accounts`). `PUBLIC_BASE_URL` is the https origin Google can reach (a Tailscale Funnel address works) and is the only host used in the Gmail `redirect_uri`. Restart `npm run dev`.

The phone starts Sign in with Google from Settings → Add email. The scope is `gmail.readonly` with offline access. Each inbox is its own EmailConnection with an encrypted refresh token. Several Gmail accounts can sit next to Yahoo or IMAP. Background sync runs the existing alert and statement parsers for every connected inbox. The same debit is counted once across inboxes, SMS and push when the amount, account and time match.
6. In the app: Log in → **Continue with Google**. New users land on the Gmail consent screen; click **Continue with Google** again to grant read-only mailbox access. Sign-in and Gmail access are deliberately separate consents.

## Before claiming "live"

- Send yourself (or collect from testers) 5 to 10 real GTBank alerts: debit, credit, POS, web, transfer, charges, USD account. Anonymize and add them as fixtures in `src/core/fixtures/gtbank-alerts.ts` with expected values in `tests/parsers/gtbank.test.ts`.
- Confirm the sender domain and subject format, then tighten `BANK_SOURCES[0].query` in `src/core/sources.ts` (or set `GMAIL_QUERY_GTBANK`).
- Check the Accounts → Sync history table: parse failures should be near zero.

## Production

`gmail.readonly` is a **restricted** scope. Public launch requires Google's OAuth verification including an annual third-party security assessment (CASA). Budget weeks, not days. Until then, run as a private beta with listed test users.
