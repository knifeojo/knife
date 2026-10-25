# Security

## Hard rules (enforced in code, not just policy)

| Rule | Where |
|---|---|
| No bank credentials, PIN, OTP or card fields exist anywhere | Schema and UI have no such fields |
| No money movement | No transfer code path exists |
| Gmail scope is `gmail.readonly` only | `GMAIL_SCOPES` in `src/core/providers/gmail.ts`; callback rejects tokens missing readonly or carrying send/modify/compose scopes and revokes them |
| OAuth tokens never reach the browser | Stored AES-256-GCM encrypted (`src/lib/crypto.ts`); only server code decrypts |
| Email bodies are not stored | `syncEmailSource` writes `processed_emails` with id, sender, subject, date, status only |
| Account numbers are not stored | Parsers keep the last 4 digits; accounts store `****1234` |
| Statement files and PDF passwords are not kept | Files are parsed in memory; the PDF password is passed to the PDF reader only, never stored or logged |
| LLM cannot introduce numbers | Facts computed by SQL; `onlyUsesFactNumbers()` guard |

## AI data flow

- **Off by default per user.** Nothing goes to any model until the user turns AI on in Settings.
- **Local calls.** Local calls go to Ollama on `localhost` only. If `OLLAMA_BASE_URL` points anywhere but loopback, it is refused before any request is made, and local features switch off.
- **Routing.** With `AI_PROVIDER=hybrid` (the default), categorization runs locally. Second opinions on uncertain rows, Insights phrasing and chat go to Anthropic, but only when `ANTHROPIC_API_KEY` is set. Without a key everything stays local and Settings says so. `AI_PROVIDER=ollama` refuses the cloud for every feature, whatever env or users ask for. Users can move any feature to Local, Cloud or Off in Settings, within those limits.
- **One redaction module.** Every cloud request passes through `src/core/ai/redact.ts`. Tests snapshot the outgoing payloads and assert that no account number, name, email or phone number is present.

**What goes to the cloud**

| Feature | Sent |
|---|---|
| Escalation (or cloud categorization) | Only rows the rules could not label and the local model was unsure about, got wrong or could not answer. For each row: the redacted narration, payee and merchant (businesses by name, people as placeholders), direction, an amount range (₦50,000 to ₦100,000) and the month |
| Insights phrasing | The redacted question and the computed facts, with amounts rounded to three significant figures. No exact kobo and no pre-written answer |
| Chat | The redacted question and conversation, a redacted profile summary, and redacted, rounded tool results. Tools run locally against the signed-in user's data; placeholders in the model's tool inputs are mapped back to names locally |

**What never goes to the cloud**

- Your name (sent as `OWNER`) and people's names (sent as `PERSON_n`). Names are restored locally in the answer.
- Your account labels (sent as `ACCOUNT_n`).
- Account numbers, card numbers, BVN/NIN-like digit runs, phone numbers and emails. These are masked as `[ACCOUNT]`, `[CARD]`, `[ID]`, `[PHONE]`, `[EMAIL]` and `[NUMBER]`.
- Exact amounts and balances, and exact dates for categorization.
- Passwords, session tokens, OAuth tokens, `ENCRYPTION_KEY`, statement files and raw emails.
- Rows already labelled by rules or by the user.

**Model output**

- The categorizer only suggests. Its output, local or cloud, is validated against the category taxonomy and stored as a CategorySuggestion. A transaction changes only when the owner confirms it in Review, and Afford maths is always rule-based.
- The models never write amounts, dates or balances.
- Figures in chat and Insights must appear in the data that was sent. A number guard rejects anything else and falls back to the rule-based answer.
- Every tool is scoped to the signed-in user server-side; the model cannot choose whose data it reads.

**Logging.** Each AI request logs `ai.served` with feature, provider, model, outcome, duration and row count. Prompts, answers and names are never logged.

**Setting the key.** Create a key at console.anthropic.com → API keys, then put `ANTHROPIC_API_KEY=sk-ant-...` in the server's `.env` (or the host's secret store) and restart. Settings shows only whether it is set, never its value. To keep everything local, leave it unset or set `AI_PROVIDER=ollama`.

## Authentication and authorization

- Passwords: bcrypt, cost 12. Login returns the same error for unknown email and bad password.
- Sessions: 32-byte random token in an httpOnly, SameSite=Lax, Secure (prod) cookie. The DB stores only its SHA-256.
- `getCurrentUser()` is the only source of identity. No server action or route accepts a `userId` from the client.
- Every query filters on `userId`. `recategorize` looks up by `id AND userId` and throws `NotFoundError` otherwise. Tested in `tests/transactions/pipeline.test.ts` (user A cannot read or modify user B).
- Server actions get Next.js origin checks. The Gmail connect endpoint is POST-only.

### Mobile API (`/api/v1`)

- The phone uses the same session row as the web, but sends `Authorization: Bearer`. The API does not accept the cookie, so a browser page cannot call it with the web session by CSRF.
- The database stores SHA-256 of the token. Logout deletes only that token. A second session (the laptop browser) stays valid.
- Login returns the same 401 for an unknown email, a wrong password, a Google-only account, and malformed input. When there is no password hash, a dummy bcrypt compare runs so the response is not obviously faster.
- Signup and login are rate-limited in memory (8 logins per 15 minutes per IP and email, 5 signups per hour per IP). This resets on restart and is not shared across processes. The IP is the first `X-Forwarded-For` value, which a client can spoof unless a reverse proxy overwrites it.
- Statement uploads go through `importStatement`. The file and any PDF password are not stored or logged. The body is rejected when `Content-Length` is more than 6 MB, and each file still has to be under 5 MB.
- Responses send `Cache-Control: no-store`. Money is a string of minor units.
- No CORS headers are set. The client is the native app, not a browser.
- Signup still says when an email is already registered, matching the web form. Login does not.

## OAuth flow

1. POST `/api/gmail/connect` sets a 10-minute httpOnly `state.userId` cookie scoped to `/api/gmail`, redirects to Google with `access_type=offline`, `prompt=consent`.
2. GET `/api/gmail/callback` verifies state and that it belongs to the logged-in user, exchanges the code server-side, validates scopes, encrypts and stores tokens, runs the first sync.
3. Access tokens are refreshed server-side. A failed refresh marks the connection `error` and asks the user to reconnect.
4. Disconnect revokes at `oauth2.googleapis.com/revoke` and nulls both tokens.

## Logging

`src/lib/log.ts` redacts keys matching token/secret/password/body/html/text/account/bvn/pin/otp and scrubs Google token shapes and 10-digit NUBANs from strings. Log ids and counts, never rows or bodies.

## Known gaps (Phase 2)

- Email sender authenticity: a spoofed "GTBank" email that passes Gmail's filters could be ingested. Mitigation: check `Authentication-Results` (DKIM for gtbank.com) before parsing.
- Web login and signup are not rate-limited. The mobile API is, but only inside one process.
- No MFA, no email verification, no password reset.
- The Android app stores the bearer token in the app's private SharedPreferences, not the Android keystore. A rooted device or a backup of app data can read it. The token lasts 30 days.
- The debug APK allows cleartext HTTP so it can call a laptop over Tailscale. The tailnet encrypts that path. A release build does not allow cleartext; use HTTPS (`tailscale serve`) for a build you keep installed.
- No certificate pinning. A token sent to the wrong server URL is a password-equivalent secret for 30 days.
- `ENCRYPTION_KEY` rotation is not implemented (ciphertext is versioned `v1.` to allow it).
- Google restricted-scope verification (CASA assessment) is required before public launch.
