# Ledger for Android

A Flutter client for the self-hosted Ledger server in `../finance-app`. The phone does not keep a copy of the ledger. It stores a server URL and a session token, and calls the JSON API under `/api/v1`.

The server URL is not compiled into the app. You set it on the first screen, so the same build can talk to a laptop today and a Mac mini later.

## Screens

| Screen | What it does |
|---|---|
| Server | Checks `GET /api/v1/health`, then saves the origin |
| Sign in | Email and password, or create an account |
| Home | This month’s balance, income, expenses, net, categories, and recent rows |
| Accounts | Each account, its masked number, and its balance |
| Activity | Transactions with categories, plus search and a category filter |
| Upload | Pick a PDF or CSV on the phone and send it to `POST /api/v1/statements` |
| Afford | Placeholder for the “Can I really afford this?” check |
| Settings | Shows the server, signs out, or forgets the server |

Afford does not calculate anything. The check (income, fixed obligations such as rent, family support, FairMoney and Renmoney, a buffer, and forward cash flow) is still to be built.

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

## Tests

```bash
flutter analyze
flutter test
```

`flutter test` covers money formatting (minor units, no floats), the server URL rules, JSON parsing, the HTTP client (bearer token and multipart upload), and the screens for server setup, sign-in, the home summary, accounts, categories, and the affordability placeholder.

## Security notes

- The session token is a bearer token. The database stores only its SHA-256. It lasts 30 days. Sign out revokes that token and leaves a browser session alone.
- The token is stored in the app’s private SharedPreferences, not the Android keystore. A rooted phone or a backup of the app data can read it.
- There is no certificate pinning. The password and the token go to whatever origin you type. Check the URL before you sign in.
- There is no MFA. Do not expose the Ledger port to the public internet. A tailnet is the intended path.
- Statement files and PDF passwords are sent once and are not saved by the app or the server.
- Login uses the same “invalid email or password” message for an unknown account and a wrong password. Signup still says when the email is already registered.

## Known gaps

- The affordability check is a placeholder.
- No Google sign-in, no offline ledger, no editing of categories, no import-issue review. Those stay on the web app.
- The token store should move to encrypted storage.
- Web login is still not rate-limited. The mobile login route is, inside one server process.
