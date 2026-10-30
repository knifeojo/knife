# Ledger for Android

A Flutter client for the self-hosted Ledger server in `../finance-app`. The phone does not keep a copy of the ledger. It stores a server URL and a session token, and calls the JSON API under `/api/v1`.

The server URL is not compiled into the app. You set it on the first screen, so the same build can talk to a laptop today and a Mac mini later.

## Screens

| Screen | What it does |
|---|---|
| Server | Checks `GET /api/v1/health`, then saves the origin |
| Sign in | Email and password, or create an account |
| Home | This month’s balance, income, expenses, net, recurring vs one-off split (each tile opens its rows), the Everyday breakdown, **What you spent on** (each person or business once, every spelling matched), **Recurring, by name** (fixed, variable or several times a month), categories, and recent rows. When payments with no purpose dominate, a prompt opens Review |
| Everyday | Everyday spending for the month by category and by payee, with its transactions |
| Review | The web Review questions with each payment’s full bank narration and one-tap purpose words found in it (“WARDROBE”, “SCHOOL”) |
| Accounts | Each account, its masked number, and its balance |
| Activity | Transactions with categories and Recurring / One-off chips, plus search, a category filter and a pattern filter (Recurring, One-off, Everyday) |
| Upload | Pick a PDF or CSV on the phone and send it to `POST /api/v1/statements` |
| Afford | “Can I really afford this?” Enter a price, get yes, stretch or no from `POST /api/v1/affordability`, with what would help (loans to clear, spending to cut, one-offs) and the figures behind it, recurring bills and one-offs shown apart |
| Loans | Settings → Your loans. Loans entered by hand (`/api/v1/loans`): balance left, instalments, next and last payment. A lender SMS (outstanding balance, amount due, due date, instalment, overdue, or cleared) updates the matching loan and shows **Last update**. It does not create a transaction. Three or more repayments to a lender with no loan on file are filed automatically (`source: inferred`) and labelled **Seen from repayments**. Add, edit, close or reopen. A loan with statement repayments after its balance date is marked out of date. Afford shows the balance on a loan line, or **Add your balance** when there is none. When a loan is paid off, Home shows a dismissible card and a notification, once: “Renmoney is fully paid. That frees up about ₦X a month.” A loan that was already over when first detected is closed quietly. The current month’s **Left** includes that freed instalment |
| Your people | Settings → Your people (or the people icon on Review). Who the names in your statements are: add family with plain sentences ("My wife is Ada Okafor"), change a relationship, add or reject bank spellings, merge duplicates, remove, and undo. Each person shows what their payments are labelled and the totals per month. Review asks "Who is NAME to you?" first, with one-tap relationships and the AI's guess highlighted |
| Settings | Re-run categorization, bank-alert **Sync now** / last email sync, **SMS bank alerts** (opt-in, 90-day backfill, captured / sent), open Review, show the server, sign out, or forget the server |

Afford does no maths on the phone. The server works out the answer from the ledger (see “Can I really afford this?” in `../finance-app/README.md`). The phone only turns what you type (“2.5m”, “500k”) into kobo and shows the result.

## Run the server so the phone can reach it

On the machine that hosts Ledger (`finance-app`):

```bash
npm install
cp .env.example .env          # set ENCRYPTION_KEY, see the file
npm run setup
npx next dev -H 0.0.0.0 -p 3000
```

`0.0.0.0` matters. `next dev` on its own listens on localhost only, which Tailscale cannot reach.

Install Tailscale on that machine and on the phone, and sign both into the same tailnet. On the laptop:

```bash
tailscale ip -4
```

Use that address in the app, for example `http://100.64.0.8:3000`. Allow inbound TCP 3000 on the tailnet interface if the laptop firewall blocks it.

The debug APK allows cleartext HTTP so this works. Tailscale encrypts the path between the two devices. Do not point the app at an HTTP server on a public network. A release build does not allow cleartext; put HTTPS in front of Ledger (`tailscale serve`) before you install one.

Sign in with the same email and password as the web app, or create an account on the phone. Real statements stay on the server. The sample file `finance-app/public/sample-gtbank-statement.csv` is made-up data you can copy to the phone to try an upload.

## Build a debug APK

You need Flutter stable (this project was checked with 3.47) and the Android SDK.

```bash
cd ledger_mobile
flutter pub get
flutter analyze
flutter test
flutter build apk --debug
```

The APK is written to:

```text
build/app/outputs/flutter-apk/app-debug.apk
```

Install it with the phone connected:

```bash
adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

Or copy the APK onto the phone and open it. Android will ask you to allow installs from that source.

## Updates

From `finance-app`, `npm run app:release` builds the debug APK and writes `latest.apk` plus `latest.json` (version, build number, sha256, size) under `~/ledger-private/releases`, or `APP_RELEASE_DIR`. The server serves those to a signed-in phone at `GET /api/v1/app/latest` and `GET /api/v1/app/apk`.

The app checks on start, on resume, and once a day. A newer build number is downloaded in the background. The file is kept only when the sha256 matches. A notification and an **Update ready** banner then open the Android package installer.

The first time, Android asks you to allow installs from this source (Ledger). Allow it once. After that, **Update ready** installs the new APK.

## Tests

```bash
flutter analyze
flutter test
```

`flutter test` covers money formatting (minor units, no floats), the server URL rules, JSON parsing, the HTTP client (bearer token and multipart upload), and the screens for server setup, sign-in, the home summary, accounts, categories, recurring and one-off chips, matched payees and named recurring groups, the Everyday drill-down, Review (full narrations, hint answers), Re-run categorization, the affordability answer (verdict, what would help, recurring bills and one-off spends), and loans (parsing with and without the new fields, the loan API calls, the list, the add and edit form, and the balance on Afford advice). A server without `/api/v1/loans` gets a message to update it instead of a crash. `test/people_test.dart` covers the people models, the "Who is … to you?" card (stats, narrations, AI guess, vendor, Someone else, Skip, Not a person), the Your people screen (list, monthly totals, add from text, relationship, spellings, merge, remove, undo, older server) and family obligations on Afford.

## Security notes

- The session token is a bearer token. The database stores only its SHA-256. It lasts 30 days. Sign out revokes that token and leaves a browser session alone.
- The token is stored in the app’s private SharedPreferences, not the Android keystore. A rooted phone or a backup of the app data can read it.
- There is no certificate pinning. The password and the token go to whatever origin you type. Check the URL before you sign in.
- There is no MFA. Do not expose the Ledger port to the public internet. A tailnet is the intended path.
- Statement files and PDF passwords are sent once and are not saved by the app or the server.
- Login uses the same “invalid email or password” message for an unknown account and a wrong password. Signup still says when the email is already registered.

## Bank SMS (sideloaded APK)

Google Play does not allow `RECEIVE_SMS` / `READ_SMS` for a personal-finance listing. This works on the sideloaded Samsung APK.

Turn it on under **Settings → Bank alerts → SMS bank alerts**. Android asks for SMS access once. The opt-in is saved only if you allow it. If you deny it, the switch stays off. If Android will not ask again, the app links to its settings page. Turning the switch off clears the opt-in.

Also set **Battery → Unrestricted** for Ledger once (Samsung: Settings → Apps → Ledger → Battery). Android will not run the background upload reliably while the app is closed if the app is battery-optimised. Do not force-stop Ledger; that blocks SMS delivery until you open the app again.

The phone keeps texts that look like account alerts (amount, debit/credit, balance, masked account, bank-style sender). `GTBank`, `GTWorld`, `FirstBank`, `Sterling` and `Providus` are tracked automatically. A new sender asks once: **Track texts from X?** Personal chats, OTPs, promos, telco senders (Globacom, Glo, MTN, Airtel, 9mobile) and airtime or data-bundle texts never leave the phone. A bank debit that names the account and says DR still does, even when the description is airtime.

The first time you turn it on, Ledger offers to read account and loan texts from the last 90 days. Saying yes to a new sender such as Renmoney also reads that sender’s inbox for the last 90 days. After this update, if SMS was already on, Ledger asks once to import financial texts from the last 30 days that the old sender list skipped. Known banks upload. A new sender still asks once. The server dedups each text on `sourceId`.

Messages go to `POST /api/v1/alerts/sms` with `sender`, `body`, `receivedAt` and a stable `sourceId`. The server dedups that id, so a retry or an overlapping flush does not create a second transaction. A message leaves the phone queue only after a 2xx. Upload runs from a WorkManager job as soon as a text arrives (even if the app is closed), every 15 minutes as a safety net, on app start, on resume, and from **Sync now**. The Bank alerts section shows **Last synced** and how many were captured and sent. The worker reads the server URL and session token from Flutter’s `FlutterSharedPreferences` (`flutter.server_url`, `flutter.session_token`). SMS bodies are not written to logs.

App alerts use the same upload. Settings → Bank alerts, and the first-run screen, have **Allow notification access**, which opens Android’s notification listener settings. Ledger drops non-financial notifications on the phone. Messaging, social and telco apps are excluded. A new bank app asks once: **Track alerts from App?** Approved alerts post with `channel: "push"`. `sourceId` is a hash of package, post time and text. The server counts one transaction when the same debit also arrives by SMS or email.

Settings → **Add email** opens Sign in with Google in the browser. The server callback is `PUBLIC_BASE_URL/api/v1/email/google/callback`. You can connect more than one Gmail inbox, and Yahoo or IMAP stays in the same list. Remove an inbox from that list.

See `../finance-app/docs/alert-ingestion.md` for iPhone Shortcuts and the macOS Messages importer.

## Known gaps

- No Google sign-in, no offline ledger, no editing of categories, no import-issue review. Those stay on the web app.
- The token store should move to encrypted storage.
- Web login is still not rate-limited. The mobile login route is, inside one server process.
