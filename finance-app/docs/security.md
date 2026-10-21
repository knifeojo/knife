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

- Off by default per user (Settings), and unavailable unless the server has an Anthropic API key.
- Sent to Anthropic when on: transaction descriptions with every run of 6+ digits removed, extracted payee names and memos, the user's own category labels, and a profile summary (account names, balances, income sources, labelled people, averages). Never logins, passwords, full account numbers or files.
- The model never writes amounts, dates or balances: the categorizer's output schema only allows category, subcategory, confidence and reason; the assistant's figures must come from tool results computed in the database, enforced by a number guard.
- Every tool is scoped to the signed-in user server-side; the model cannot choose whose data it reads.

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
