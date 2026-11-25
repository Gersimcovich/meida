# Private Meida setup

Meida is a single-owner research app for stocks and standard options. It runs on Node.js 24 or newer, persists data in SQLite, and never submits brokerage orders. Its initial source is **Demo**: synthetic examples remain explicitly labeled and separate from Schwab data.

## Railway hosting

Deploy the repository's Dockerfile as one Railway service with **one replica** and a persistent volume mounted at `/data`. Keep these settings on the Railway service itself:

| Setting              | Value                             |
| -------------------- | --------------------------------- |
| Dockerfile path      | `Dockerfile`                      |
| Health-check path    | `/api/health`                     |
| Health-check timeout | 120 seconds                       |
| Restart policy       | On failure, at most 3 retries     |
| Replicas             | 1 in the existing volume's region |

Railway automatically detects the root Dockerfile. These settings do not require a repository Config as Code file. Legacy `railway.json`/`railway.toml` support ends on December 1, 2026; persist and verify the service settings before removing any legacy file. Do not alter the existing volume, domain, or secret variables during that migration. See [Railway's migration guide](https://docs.railway.com/infrastructure-as-code#migrating-from-config-as-code).

Use these runtime variables in Railway's private variable editor:

```dotenv
HOST=0.0.0.0
PORT=3000
NODE_ENV=production
APP_ORIGIN=https://your-service.up.railway.app
SCHWAB_REDIRECT_URI=https://your-service.up.railway.app/api/auth/schwab/callback
DATABASE_PATH=/data/meida.sqlite
OWNER_PASSWORD=your_long_random_private_password
TOKEN_ENCRYPTION_KEY=64_hex_characters_generated_privately
SCHWAB_CLIENT_ID=your_app_key
SCHWAB_CLIENT_SECRET=your_app_secret
```

Use your service's actual HTTPS domain in both URL values. The registered Schwab callback must match `SCHWAB_REDIRECT_URI` exactly. Railway terminates HTTPS; leave `TLS_KEY_FILE` and `TLS_CERT_FILE` unset when hosted. The health-check path is `/api/health`; it returns only `{ "ok": true }`.

`OWNER_PASSWORD` must be at least 20 characters. Generate a random password rather than reusing one. Generate the encryption key separately with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Enter secrets directly into Railway variables, never into chat, source files, screenshots, or Git. The app refuses public hosting without HTTPS and the owner password, and hosted mode refuses the development server.

Open the deployed URL and sign in with the owner password. All data and Schwab authorization routes require an owner session. Sessions use random tokens in Secure, HttpOnly, SameSite=Lax cookies; only token hashes are stored. Sessions expire after 12 hours, logout revokes them, and changing `OWNER_PASSWORD` invalidates existing sessions. Login attempts are rate limited. This is one private workspace, not a customer account system.

## Connect Schwab Market Data Production

1. In the [Schwab Developer Portal](https://developer.schwab.com/products/trader-api--individual), create your app with **Market Data Production** access. Wait for its status to be **Ready For Use**. Portal access alone is not app approval.
2. Register the exact hosted callback shown by Meida's Connections screen, for example `https://your-service.up.railway.app/api/auth/schwab/callback`. If you previously registered the local callback, update the Schwab app to the hosted callback before connecting.
3. Add your own App Key and App Secret to Railway's private `SCHWAB_CLIENT_ID` and `SCHWAB_CLIENT_SECRET` variables. Preserve `TOKEN_ENCRYPTION_KEY` across deployments; changing it makes saved Schwab and Telegram credentials unreadable and requires reconnection.
4. Restart/redeploy after variable changes, sign in to Meida, then choose **Connections → Connect Schwab**. Complete authorization directly with Schwab. OAuth uses `scope=readonly` and returns you to Meida.
5. Choose Schwab as your data source and run a scan. Quotes must be fresh, confirmed real-time, and in a confirmed regular market session to generate live signals. Missing or incomplete feeds are reported; there is no automatic fallback to demo prices.

The official endpoints are `https://api.schwabapi.com/v1/oauth/authorize`, `https://api.schwabapi.com/v1/oauth/token`, and `https://api.schwabapi.com/marketdata/v1`. Credentials stay on the server. Access and refresh tokens are encrypted with AES-256-GCM in SQLite. The browser receives connection status, never brokerage tokens. Access-token expiry honors Schwab's `expires_in`; rejected refresh credentials show a reconnect requirement, while transient provider errors can be retried.

Do not copy the OAuth client ID or callback from the portal's Swagger example: those belong to the portal. If a secret has been shared in chat or a screenshot, rotate it in Schwab before configuring the app. Disconnect removes Meida's locally stored tokens; revoke the app at Schwab separately to revoke the external authorization grant.

## Connect private Telegram alerts

Open **Connections → Telegram alerts** and follow [the Telegram setup guide](TELEGRAM.md). Create a dedicated bot with **@BotFather**, enter its token in Meida's token field, open the generated pairing link, press **Start** in Telegram, and select **I've started the bot** in Meida. The pairing link expires after ten minutes. Use **Send test message** to verify receipt before enabling market alerts.

The existing `TOKEN_ENCRYPTION_KEY` encrypts the bot connection in SQLite. No Telegram-specific environment variable or manually entered chat ID is required. Setup is unavailable without that encryption key, including in local development. Do not put the bot token in chat, Git, or screenshots.

To enable **Send market alerts**, Schwab must be connected and selected as the data source. Choose **Intraday & swing**, **Intraday only**, or **Swing only**. Enabled monitoring runs on the server while the browser is closed; the service must remain running. Pausing Telegram alerts stops that background monitoring. Disconnecting Schwab or selecting Demo also pauses it. Telegram messages contain research signals and never place orders.

The integration is implemented, but actual Telegram acceptance and receipt must be verified with the owner's bot. A successful test checks the Telegram path; it does not verify Schwab data, signal availability, or future notification delivery.

## Data coverage and persistence

- The watchlist supports 12 stock/ETF symbols. The scanner requests quotes, one-minute history, daily history, bounded option chains, and official market-session intervals. It does not import the thinkorswim Alert Book.
- Live scans run manually, through dashboard auto-scan every 60 seconds while the page is open, or through server monitoring every 60 seconds when Telegram market alerts are enabled. Background scans require connected/selected Schwab data and confirmed regular market hours. All scan paths share a serialized execution gate with at least 30 seconds between Schwab scan attempts. Daily history is cached for 15 minutes. Provider timestamps and partial failures remain visible.
- Option requests use `strikeCount=20` for nearby strikes and cover at most 60 calendar days. This is not the entire options market. Adjusted, mini, and unverified-multiplier contracts are excluded. Volume/open-interest measures activity, not opening trades, institutional identity, or trade direction.
- SQLite persists watchlists, rules, encrypted Schwab/Telegram credentials, Telegram preferences and delivery receipts, latest snapshots per source, deduplicated signal records, hashed owner sessions, and paper trades. Back up the persistent volume and encryption key separately. Run only one service replica against this SQLite database.
- The Telegram worker runs every 20 seconds and sends at most one qualifying market alert per tick, up to three per minute. Only Schwab-source snapshots/signals no older than 120 seconds qualify. Candidates must remain in the latest applicable scan; there is no stale backlog replay. The first alert for each instrument, rule, direction, market session, and destination is deduplicated, with receipts retained for three days. Rate-limit responses apply a cooldown. An ambiguous send or timeout is not retried automatically, which can mean a missed alert. See [Telegram delivery limits](TELEGRAM.md#delivery-behavior-and-limits).
- Journal fees are **total round-trip fees**. Closing a trade replaces this total if supplied; it does not add it twice. Include spread, slippage, and fees in paper-price assumptions. Stocks use multiplier 1; options require an explicit multiplier and whole contract quantities. A worthless option can close at zero.
- Trades retain demo/Schwab source labels. Paper trades never become brokerage orders.

## Local development

```sh
npm install
cp .env.example .env
npm run dev
```

Open `http://127.0.0.1:3000` for the local demo. Loopback mode does not require an owner password and must not be forwarded through a public tunnel. Run `npm test` for automated checks, `npm run build` for type checking and the frontend build, and `npm start` to serve the production build.

For local Schwab authorization only, create a locally trusted certificate using a tool such as [mkcert](https://github.com/FiloSottile/mkcert), keep its private key outside the repository, set `TLS_KEY_FILE`/`TLS_CERT_FILE`, and use `APP_ORIGIN=https://127.0.0.1:3000` with the exact callback `https://127.0.0.1:3000/api/auth/schwab/callback`. This is separate from hosted Railway configuration.

`.env`, certificates, SQLite files, and `data/` are ignored by Git. Do not commit runtime data or secrets.

## Before customer use

Customer access needs tenant isolation, individual user accounts, per-user credentials and data, durable job coordination across instances, retention controls, and operational monitoring. The current Telegram worker is a single-process, single-owner service, not a customer delivery system. An individual API approval does not automatically confer commercial or market-data redistribution rights. Confirm the applicable Schwab and exchange permissions before offering access to customers.

## Troubleshooting

- **Sign-in rate limited:** wait 15 minutes before retrying. The limiter intentionally uses the direct peer address rather than trusting client-supplied forwarding headers.
- **Connection not configured:** supply App Key, App Secret, and the 32-byte encryption key in server variables.
- **Unexpected host / same-origin request required:** use the exact `APP_ORIGIN`, including the same domain. Mutations require an `Origin` header equal to that value.
- **Authorization state expired:** restart connection from Meida. State expires after ten minutes, is tied to the initiating browser cookie, and is consumed once.
- **Reconnect required:** authorize again with Schwab. Refresh grants can expire or be revoked; no fixed lifetime is assumed.
- **No signals:** check source, market session, freshness, baseline history coverage, watchlist, and thresholds. A successful scan can find no candidates.
- **Data denied:** verify product approval and market-data entitlements. Meida does not fabricate unavailable data.
- **Telegram unavailable, unpaired, or paused:** follow [Telegram troubleshooting](TELEGRAM.md#troubleshooting). Check the encryption key, pairing expiry, selected data source, Schwab connection, and **Send market alerts** setting.

Live authorization and actual account entitlements still require verification with the configured Schwab app; fixture tests cannot establish them. Telegram delivery likewise requires pairing the owner's bot and checking receipt of the explicit test message.
