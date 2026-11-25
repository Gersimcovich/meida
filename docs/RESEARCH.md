# Meida: market-data and signal research

Research date: 2026-11-25. This document records evidence and proposed product decisions. It is not a claim that every capability below is implemented or validated with a funded account.

## Recommended product boundary

Build a personal, read-only research workspace that computes its own alerts from Schwab market data. Keep data provenance, freshness, trigger inputs, and paper-trade outcomes visible. The initial application should help investigate candidates; an alert score is not a probability of profit.

Native thinkorswim alerts and an application-generated scanner are different integrations. No public endpoint for native thinkorswim Alert Book events, study alerts, or alert webhooks was established by this research. Do not advertise native-alert synchronization until Schwab documents and approves an interface. Email parsing would be a separate, explicitly configured integration with latency and duplicate-handling limitations.

## Evidence and verification levels

### Official public sources

- **Personal API scope:** [Schwab Trader API — Individual](https://developer.schwab.com/products/trader-api--individual) describes building an application for the developer's own self-directed brokerage account and lists authentication, market data, accounts, and trading capabilities. It does not establish customer redistribution rights.
- **Native alerts:** [Schwab's thinkorswim alert guide](https://www.schwab.com/learn/story/5-types-alerts-on-thinkorswim-platform) describes price, portfolio, calendar, news, and rating alerts delivered through sound, email, text, and mobile notifications. It does not describe an alert webhook.
- **Registration:** [Schwab's app creation guide](https://developer.schwab.com/user-guides/apis-and-apps/create-an-app) describes API-product access and a registered callback URL for returning users after authorization.
- **Commercial boundary:** [Schwab Online Services Agreement](https://www.schwab.com/legal/terms) restricts unapproved commercial use and market-information redistribution. The customer's specific API and exchange agreements also matter; these public terms alone do not settle a future product's exact licensing requirements.

The authenticated portal could not be independently opened during this research. The user subsequently supplied the Market Data Production REST specification and Streamer documentation, which provide primary documentation for the contracts summarized below. Documentation review is distinct from testing an authorized account: no live connectivity or account-specific entitlements have been established by this research.

### Official documentation supplied by the user

The user supplied the text of **Market Data Production — Market Data 1.0.0, OAS3**, including quotes, chains, price history, movers, market hours, instruments, and component schemas. The documented server is `https://api.schwabapi.com/marketdata/v1`. The originating product is [Schwab Market Data Production specifications](https://developer.schwab.com/products/trader-api--individual/details/specifications/Market%20Data%20Production). Some generated examples conflict with community-observed responses; those differences are explicitly identified below rather than treated as resolved.

The user also supplied **Market Data Production — Schwab Streamer API**. Its documented protocol supports WebSocket market data and account activity; authentication and entitlements come from the access token, and connection information comes from **GET User Preference**. A concise implementation-oriented summary is in [STREAMING.md](STREAMING.md). The source attachments and their illustrative credentials are intentionally not copied into the repository.

The user also supplied OAuth documentation showing `readonly` scope and these endpoints:

- Authorization: `https://api.schwabapi.com/v1/oauth/authorize`
- Token exchange: `https://api.schwabapi.com/v1/oauth/token`

Use the user's own approved application's client ID, registered callback, and server-held secret. A client ID displayed by the portal's Swagger interface belongs to that interface and is not an application credential for Meida. The supplied extract does not by itself establish every grant parameter, PKCE behavior, or token lifetime; verify those against the current app documentation.

**Product-access distinction:** the REST market-data MVP targets Market Data Production. The streamer additionally requires GET User Preference information. Community implementations place that endpoint under `/trader/v1/userPreference`, commonly associated with Accounts and Trading Production. Whether the particular app must enable that additional product for streaming must be confirmed with Schwab. Neither account access nor order execution is necessary for Meida's REST alert calculations.

### Community implementation references

These are useful compatibility evidence, not an official guarantee:

- [schwab-py HTTP client documentation](https://schwab-py.readthedocs.io/en/stable/client.html)
- [schwab-py client implementation](https://github.com/alexgolec/schwab-py/blob/main/schwab/client/base.py)
- [schwab-py authentication](https://schwab-py.readthedocs.io/en/stable/auth.html)
- [schwab-py streaming](https://schwab-py.readthedocs.io/en/stable/streaming.html)
- [Schwabdev request and response examples](https://github.com/tylerebowers/Schwabdev/blob/main/docs/pages-raw/api.md)

Community authentication documentation describes automatic access-token refresh and periodic user reauthorization, often around seven days. Use the actual token response's `expires_in`, retain rotated refresh tokens safely, and handle `invalid_grant` with a reconnect state. Do not treat a community-reported duration as a perpetual service contract.

## REST adapter reference

The four market-data requests below are supported by the **user-supplied official REST specification**; stream discovery's REST path remains community-confirmed. Actual account responses and entitlements still need a live smoke test. The API origin is `https://api.schwabapi.com`. Send bearer tokens only from the server. Use finite network timeouts, bounded concurrency, caching, and backoff for throttling; the supplied extract does not establish exact request-rate limits.

| Resource | Request shape | Relevant response structure |
| --- | --- | --- |
| Quotes | `GET /marketdata/v1/quotes?symbols=AAPL,MSFT` | Object keyed by symbol, with `realtime`, `quote`, `regular`, `reference`, and optional `fundamental` sections. |
| Option chain | `GET /marketdata/v1/chains?symbol=AAPL&contractType=ALL&strategy=SINGLE&strikeCount=10&includeUnderlyingQuote=true` | `status`, `isDelayed`, `underlyingPrice`, and call/put expiration maps. Bound expirations with `fromDate`/`toDate` in `YYYY-MM-DD` format. `isChainTruncated` appears in community examples but not in the supplied component schema. |
| Intraday history | `GET /marketdata/v1/pricehistory` with `symbol`, `periodType=day`, `frequencyType=minute`, `frequency=1`, explicit `startDate`/`endDate` epoch milliseconds, `needExtendedHoursData=false` | `candles` containing `open`, `high`, `low`, `close`, `volume`, `datetime`; inspect `empty` and actual coverage. |
| Trading calendar | `GET /marketdata/v1/markets?markets=equity,option&date=YYYY-MM-DD` | Nested market/product records such as `equity.EQ` and `option.EQO`, with `isOpen` and `sessionHours.regularMarket` start/end intervals. |
| Stream discovery, later | `GET /trader/v1/userPreference` | Stream connection and customer/session identifiers; product-access requirement remains to be verified. |

Quote fields used by the scanner include `quote.bidPrice`, `askPrice`, `lastPrice`, `closePrice`, `netPercentChange`, `totalVolume`, `quoteTime`, and `tradeTime`; the last two appear as epoch milliseconds in the supplied examples and community implementations. `reference.description` supplies a display name. `regular.regularMarketLastPrice` and `regularMarketTradeTime` distinguish regular-session trade information. Preserve the difference between a fresh quote and an old last trade. The optional `indicative` parameter requests corresponding ETF indicative symbols; it is not an entitlement switch. The `fields` parameter selects root sections; omitting it requests the full response.

**Option-chain schema discrepancy:** community examples nest maps as `callExpDateMap["YYYY-MM-DD:DTE"][strike]` or `putExpDateMap[...]`, with an **array** of contracts at each strike and fields named `bid`, `ask`, `last`, `mark`, and `nonStandard`. The user-supplied official generated example instead shows a **single contract object** at each strike with `bidPrice`, `askPrice`, `lastPrice`, `markPrice`, and `isNonStandard`. Support these known variants explicitly and test each; do not silently assume one example proves live response shape. Shared fields include `totalVolume`, `openInterest`, `quoteTimeInLong`, `tradeTimeInLong`, `volatility`, Greeks, `strikePrice`, `expirationDate`, `daysToExpiration`, `multiplier`, and deliverable information. Retain exact padded option symbols. Treat empty/truncated chains explicitly; do not claim a full-chain put/call ratio from a subset of strikes or expirations. The official `entitlement` parameter offers `PN`, `NP`, and `PP` for retail tokens; selecting a string does not grant rights that the user lacks.

For history, the supplied specification permits minute frequencies of 1, 5, 10, 15, or 30. A `periodType=day` period accepts 1, 2, 3, 4, 5, or 10; do not request `period=20` to obtain 20 sessions. Request explicit date bounds and determine readiness from returned usable sessions. Without `endDate`, the documented default is the previous business day's close, so a live-session request must specify an end bound. Lookback availability is not guaranteed by these parameter definitions. Omitting `period` when using explicit bounds follows the community client's guidance; verify behavior against the approved app. `needPreviousClose=true` asks for the previous close and its date.

`isOpen` indicates a trading date, not that the present instant is inside the regular session. Compare current time with the returned timezone-aware intervals. Use `America/New_York` for session grouping and handle daylight saving, holidays, and early closes. A Monday-to-Friday 09:30–16:00 rule is insufficient. The official date range is **today through one year ahead**. A community wrapper's claim that seven prior days are accepted conflicts with this; historical calendars need another verified source or previously retained calendar records.

**Other example limitation:** the supplied single-symbol quote endpoint displays a candle/history example under its quote response. Prefer the coherent bulk-quote contract and verify real payloads; do not implement the anomalous sample as a quotation schema. Error examples also repeat unrelated field-validation text across endpoints. Preserve status, sanitized provider details, and `Schwab-Client-CorrelId` for diagnostics rather than depending on those sample strings.

### Normalization and data quality

- Preserve provider event time, ingestion time, feed classification, session, and missing fields. A missing delayed/realtime flag is **unknown**, not proof of live data.
- Validate finite values, positive prices, nonnegative volume, and noncrossed bid/ask. Do not replace missing OI, IV, timestamps, or history with zero for scoring.
- Check the quote age and the last-trade age separately. Suppress fresh-alert claims from stale, halted, closed, or unknown-quality observations.
- Equity cumulative volume can include extended hours. The supplied streamer documentation explicitly says it does. For regular-session RVOL, sum regular-session candles for both numerator and denominator.
- Treat provider volume resets, corrections, repeated snapshots, and out-of-order updates as state transitions. A negative cumulative-volume difference is not negative trading activity.
- Exclude incomplete current bars from completed-bar tests. Store source observations needed to explain an alert, subject to applicable retention rights.
- No synthetic example may silently become live data when a connection fails. Demo and connected modes must be unmistakable.

## Signal research and suggested initial rules

Thresholds below are starting hypotheses for evaluation, not proven trading edges. Prefer a compact set of interpretable signals over many correlated indicators.

| Signal | Formula or rule | Interpretation and limitation |
| --- | --- | --- |
| Time-matched stock RVOL | Today's cumulative regular-session volume through completed minute `m` / mean volume through the same minute over 20 prior comparable sessions. Initial candidate threshold: 2×. | Detects unusual participation. Return unavailable for insufficient history or a zero baseline. Do not annualize a partial day's volume linearly. |
| Volume-backed breakout | Completed bar closes beyond a prior-session high/low or a completed opening range, together with elevated RVOL. | Price provides direction; volume provides context. Exclude current-session data from a previous-session reference and wait for an opening range to finish. |
| VWAP reclaim/loss | Price crosses a regular-session VWAP with confirmation on a completed bar. | Candle-derived `sum(((high+low+close)/3)*volume)/sum(volume)` is approximate VWAP, not exact transaction VWAP. Retain prior state to detect a crossing. |
| Option volume/OI | Contract session volume / previously published OI, with an absolute volume floor. Initial research filters: ratio ≥2 and volume ≥500. | An activity flag. It does not prove opening orders, institutional accumulation, or bullish/bearish intent. Zero OI is a missing ratio, not infinity. |
| Options volume acceleration | Contract/underlying volume in a comparable interval versus its own historical interval baseline. | Requires stored historical observations or licensed historical options data; today's chain cannot supply that history. |
| IV change | Difference in IV for a matched contract or controlled tenor/moneyness series; specify percentage-point units. | Expiry rolls and moneyness changes can create false shifts. IV is not a directional forecast. |
| IV rank / percentile, later | Rank: `100*(current-min)/(max-min)`; percentile: percentage of historical observations below current, over a declared comparable lookback. | They are different metrics. Require a real historical IV series, adequate coverage, and a zero-range rule. |
| Liquidity alert | Spread = `ask-bid`; relative spread = spread / midpoint. Pair with quote age, sizes, volume, and OI. | A high-volume option can still be costly to trade. Wide-spread candidates should be flagged or excluded rather than ranked higher merely for activity. |
| Event proximity, later | Known earnings, dividend, macro-event, and expiration dates with source/time. | Verify a licensed calendar/news feed; do not assume native thinkorswim news alerts are exposed by market-data endpoints. |

A displayed `volume × current midpoint × multiplier` is an **estimated premium proxy**, not observed premium traded. Actual traded premium requires executions. Use the contract's multiplier and deliverable information; adjusted contracts need special handling. A put/call ratio does not identify which side initiated trades, and large call volume can represent selling, hedging, spreads, or rolling.

Primary evidence behind these design choices:

- [Schwab — Trading Near the Bells](https://www.schwab.com/learn/story/trading-near-bells) describes the typical concentration of volume near the open and close. This motivates time-matched intraday comparisons.
- [Schwab — Volume and Price Trends](https://www.schwab.com/learn/story/ways-volume-can-help-confirm-price-trends) discusses using volume to contextualize trends and breakouts; this is rationale for investigation, not proof of predictive profitability.
- [OCC/OIC — Open Interest](https://www.optionseducation.org/news/open-interest-why-it-matters) distinguishes session volume from outstanding contracts and describes clearing-based OI calculation.
- [Cboe Open-Close Volume Summary](https://datashop.cboe.com/cboe-options-open-close-volume-summary) illustrates the specialized data required to distinguish buy/sell, opening/closing, and participant categories.
- [Schwab — Wide Bid/Ask Spreads](https://www.schwab.com/learn/story/large-bidask-options-spreads-volatile-markets) explains the relevance of spreads to costs and execution.
- [Schwab — IV Rankings](https://workplace.schwab.com/story/using-implied-volatility-percentiles) discusses IV's historical and event context.

## Measuring whether alerts are useful

An alert stream is not a tested trading strategy. Define the intended decision horizon, entry, exit, invalidation, position size, and simultaneous-position rules before measuring returns. Store rule versions with each observation.

1. **Separate discovery and evaluation.** Tune on an earlier development window; validate on later chronological windows; preserve a final untouched holdout. Walk the training window forward without retuning on the test period. Purge/embargo overlapping outcome horizons where observations share future returns.
2. **Avoid lookahead.** Use only bars complete at signal time, OI available at that time, contemporaneous index membership, and events known then. Next-day OI may later help study an alert but must not enter the original signal. Handle splits, adjusted contracts, delisted symbols, survivorship, and point-in-time universe selection explicitly.
3. **Model executable prices.** A signal generated at a bar close cannot automatically fill at that same historical close. Start with the next observable tradable quote after a stated latency. For options, buy at ask and sell at bid in a conservative baseline, with fees, spread changes, slippage, contract multiplier, partial fills, and size limits. A midpoint touch does not prove a fill.
4. **Measure more than win rate.** Report sample size, coverage, net expectancy, average win/loss, profit factor, drawdown, exposure, turnover, and loss tails. For signals alone, report forward returns and favorable/adverse excursion at predeclared horizons. Include uncertainty and stability by market regime, symbol, time of day, liquidity, and DTE.
5. **Account for experimentation.** Record the number of rules and parameter variants tried; avoid selecting a winning backtest after extensive unreported searching. Compare with simple baselines and test whether combined signals add value beyond the stock's underlying move.
6. **Forward paper observation.** Log alerts as they happen, then evaluate outcomes without rewriting triggers. Keep simulated fills distinct from actual brokerage executions. Missing or stale data must create an evaluation gap, not an attractive zero-cost fill.

These controls are proposed research methodology; Meida must not claim that a walk-forward study or profitable strategy has been completed until it has actual data and results.

## Personal-to-customer roadmap

### Personal foundation

Use the owner's approved app and brokerage authorization, a server-held token store, a bounded watchlist, explicit freshness checks, user-controlled rule settings, and a journal. Keep the broker adapter read-only: do not expose order placement, cancellation, or account-transfer endpoints merely because a broader API product supports them. Reconcile the supplied schemas with authorized responses, verify entitlement behavior, and run live smoke tests before labeling the connection operational.

### Reliable personal service

Add scheduled collection or a single streaming worker, durable history and deduplication, reconnection health, market-calendar handling, and reproducible evaluation. Maintain separate provider, normalization, signal, storage, and delivery interfaces. Store immutable trigger inputs and a rule version so results can be explained. Notification destinations require explicit user configuration; OAuth authorization alone does not authorize sending messages elsewhere.

### Customer pilot

Resolve Schwab product approval and exchange/vendor rights for display, derived alerts, non-display processing, retention, and redistribution **before** exposing personal-account data to customers. Confirm customer entitlement and professional/nonprofessional requirements with the provider. Bringing each customer's OAuth connection does not automatically eliminate licensing obligations.

Implement authenticated customer identities, tenant ownership on every query and write, isolated broker connections and caches, per-tenant quotas, revocation, and server-side authorization checks. Encrypt secrets with managed keys, redact tokens and account identifiers from logs, audit connection/rule/data-access events, and enforce retention/deletion policies. Keep example data isolated from customer records. Test tenant isolation and token lifecycle as system behavior, not just UI behavior.

Before promising customer recommendations or execution, determine the product's legal and operational role with appropriate advice. A signal-research product, personalized recommendations, and order execution create different obligations. Any eventual execution feature needs its own explicit scope, risk limits, order preview/confirmation policy, reconciliation, and incident handling; it should not be added implicitly to this research app.

## Unresolved items to verify with an authorized app

- Approved application status, callback URL, allowed scopes, current OAuth grant parameters, token lifecycle, and product access.
- Actual REST response variants versus the supplied schemas, units, null/sentinel values, delayed/entitlement behavior, throttling limits, and historical coverage.
- Whether GET User Preference requires Accounts and Trading Production for this app's streaming access.
- Stream field-table/example discrepancies, reconnect behavior, and actual service entitlements described in [STREAMING.md](STREAMING.md).
- Rights and suitable providers for historical option quotes, trade classification, earnings/news, and customer redistribution.
- The trading horizon and acceptable liquidity/risk constraints against which the owner wants signals evaluated.
