# Meida

A personal workspace for researching unusual stock and options activity using Schwab market data.

The first version combines explainable intraday and swing signals, configurable alert rules, a watchlist, and a paper-trade journal. It calculates signals from market data; it does not import thinkorswim's native alerts or place orders.

## Run locally

Requires **Node.js 24 or newer**.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:3000`. The app starts with **synthetic demo data**. Demo prices and alerts are a fixed replay, not current market information. Watchlists, rules, and journal entries persist in the local SQLite database. No Schwab account is needed to explore the demo.

```sh
npm test       # Signal logic, provider normalization, API and auth boundaries
npm run build # Type-check and compile the UI
npm start     # Serve the production build locally
```

## Connect Schwab

Use a personal Schwab developer application with **Market Data Production** access. Developer portal access alone is not app approval. Follow [the setup guide](docs/SETUP.md) to configure server-side environment variables, HTTPS, and the exact registered OAuth callback. The client ID shown in Schwab's Swagger authorization dialog belongs to the documentation tool; use your own application's credentials.

The server performs authorization-code exchange and refresh, encrypts tokens at rest, and never sends brokerage tokens or client secrets to the browser. Local development binds to loopback. Hosted mode requires an HTTPS origin and a strong owner password, with server-side sessions protecting application data and brokerage authorization.

## Host privately on Railway

The repository includes a `Dockerfile`. Configure the service settings described in [the setup guide](docs/SETUP.md), use one instance and a persistent volume mounted at `/data`, and set `DATABASE_PATH=/data/meida.sqlite`. Configure the generated public HTTPS URL as `APP_ORIGIN` and append `/api/auth/schwab/callback` for both the Schwab registration and `SCHWAB_REDIRECT_URI`.

Store `OWNER_PASSWORD`, `TOKEN_ENCRYPTION_KEY`, and your Schwab application credentials in Railway's server-side variables. Set `HOST=0.0.0.0`, `PORT=3000`, and `NODE_ENV=production`. Hosted mode refuses to start without its required protection. The public web address serves a private owner login; application data remains behind authentication. See [the setup guide](docs/SETUP.md) for the complete configuration and operating limits.

The owner password protects a single personal workspace. This is not yet a customer-account system.

The live adapter uses read-only quote, option-chain, price-history, and market-hours endpoints. Polling is bounded and requests are rate-limited locally. Failed requests, delayed quotes, stale data, and insufficient history are visible rather than replaced with synthetic data. Live access still needs verification with an approved app and actual account entitlements; development tests use controlled API fixtures.

## Research workflow

1. Choose symbols in **Watchlist**.
2. Adjust volume, liquidity, and expiration thresholds in **Alert rules**.
3. Run a scan and filter **Intraday** or **Swing**, stocks or options.
4. Read the **Trader read** panel: watch activity, review a long or short setup, or investigate options activity. Check its measured confirmation level, invalidation, timestamps, and liquidity/event checks before deciding.
5. Record a hypothetical entry and exit in **Paper journal**, including fees and an explicit option multiplier where relevant.

Initial rules cover time-matched relative stock volume, opening-range breaks, candle-based VWAP crosses, 20-session breakouts, and unusual option volume relative to open interest. Scores rank the strength of rule inputs; they are not probabilities of profit. Options volume/open interest does not reveal whether contracts were bought, sold, opened, or closed. A paper journal records user-entered prices; it is not a broker fill simulator or validated strategy backtest.

## Architecture

```text
Schwab OAuth + market-data REST
          │ server only
          ▼
Express / TypeScript ── SQLite settings, encrypted tokens, paper journal
          │
          ├── normalized snapshots → deterministic signal engine
          │
          ▼
React dashboard (same origin)
```

Code is separated into `server/` (data provider, OAuth, storage, APIs), `shared/` (typed contracts, calculations, reproducible demo), and `src/` (dashboard).

## Research and next phase

See [the trader playbook](docs/TRADER_PLAYBOOK.md) for indicator meanings, conditional action matrices, execution-cost examples, and primary sources. See [research and sources](docs/RESEARCH.md) for verified capabilities, assumptions, signal definitions, and evaluation methodology. See [streaming notes](docs/STREAMING.md) for the user-supplied Schwab Streamer protocol and the steps required before adding WebSocket ingestion. This version uses REST snapshots, manually or every 60 seconds while auto-scan is enabled and the dashboard is open; it does not identify market-wide option sweeps, import native thinkorswim alerts, provide a news feed, or run a background scan after the app is closed.

Before customer access, obtain the appropriate commercial API and market-data redistribution permissions, add authenticated users and tenant isolation, deploy managed secret storage, and validate strategies out of sample with realistic trading costs. Personal API approval is not evidence of commercial distribution rights. Alerts are research candidates; profitability has not been established.
