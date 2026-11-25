# Schwab streaming integration notes

Source: user-supplied text titled **Market Data Production — Schwab Streamer API**, reviewed 2026-11-25. This is a concise summary of relevant protocol facts and engineering implications, not a reproduction of the source document. Streaming is a future integration boundary; these notes do not assert that a live stream is connected.

## Access and service selection

The documented transport is JSON over WebSockets. Obtain an OAuth access token from POST Token and connection details from GET User Preference. Use the returned connection information and the associated customer ID, correlation ID, channel, and function ID; do not hardcode values from documentation samples. Community clients use `/trader/v1/userPreference`; confirm any additional Accounts and Trading Production entitlement needed to call it. The current REST market-data MVP does not require streaming or brokerage order access.

Relevant documented services are `LEVELONE_EQUITIES`, `LEVELONE_OPTIONS`, and `CHART_EQUITY`. The document also lists books, screeners, futures/forex, and account activity. Their presence in a reference does not prove that the user's app is entitled to them. Account activity is unnecessary for the read-only scanner. No native thinkorswim Alert Book or study-alert service appears in the supplied service list.

The supplied document states **one simultaneous streamer connection per user**. Use one server worker to manage subscriptions for that connection, with browser clients consuming the app's normalized feed. Do not open one Schwab stream per browser tab. Customer fan-out remains subject to market-data rights and tenant isolation.

## Connection state machine

1. Obtain or refresh the access token server-side; retrieve authorized connection information.
2. Open the returned WebSocket and send `ADMIN` / `LOGIN` with the token and discovery fields.
3. Wait for a successful LOGIN response before sending subscriptions. Do not batch a login and dependent subscriptions merely because the request envelope can contain multiple commands.
4. Send subscription mutations serially, match acknowledgements using unique `requestid` values, and maintain confirmed versus requested state.
5. Process `response`, `notify`, and `data` envelopes separately. Heartbeats establish connection activity, not the freshness of every symbol.
6. On disconnect, mark the connection degraded and observations stale; reconnect with bounded exponential backoff and jitter, then restore desired subscriptions after successful login. Refresh discovery information when needed. Do not retain an unqualified “live” badge during recovery.

Command semantics:

| Command | Effect |
| --- | --- |
| `SUBS` | Replaces all subscribed symbols for that service. |
| `ADD` | Adds symbols without discarding existing subscriptions. |
| `UNSUBS` | Removes named symbols. |
| `VIEW` | Changes the selected fields for all symbols in that service. |
| `LOGOUT` | Ends the streaming connection. |

The response-code table includes ordinary success (`0`) and command-specific success codes (`26`–`29`). Authentication denial (`3`) severs the connection; connection-limit (`12`), symbol-limit (`19`), unavailable-service (`11`), malformed-command (`21`), failed-mutation (`22`–`25`), and stopped-stream (`30`) conditions need distinct handling. Do not retry permission or malformed-request failures indefinitely. The source notes that parallel subscription mutations can cause failures.

## Reconstructing observations

Level-one equity and option services use **change-only, conflated** delivery. Merge each sparse update into state keyed by service and symbol. An absent field means unchanged, not zero or null. Preserve initial asset metadata and feed classification across subsequent sparse updates. Retain field event times so fresh bids do not make an old last trade appear current.

The initial `delayed` flag has a subtle meaning. `false` identifies SIP data in the supplied document. `true` identifies a non-fee-liable feed, which may be delayed or may be real-time data from only a subset of exchanges. Label that state as constrained/delayed feed quality; do not assert a fixed delay or complete national-market coverage. A missing flag remains unknown.

Conflated last-price updates and cumulative-volume differences are **not** a complete trade tape. They cannot reliably identify a single trade, an options sweep, aggressor side, a multi-leg strategy, opening/closing activity, or actual premium paid. Such claims need an appropriate transaction-level dataset.

`CHART_EQUITY` uses sequence-bearing delivery. Preserve sequence and chart time, deduplicate repeated candles, upsert corrections rather than adding the same candle twice, and backfill gaps from permitted history. The source does not establish a universal end-of-bar finality guarantee: decide when a bar is complete using chart time/session context, and verify behavior against captured authorized fixtures.

## Selected field mappings

The mappings below summarize the detailed service field tables, not the generic response example. Numeric keys arrive as JSON strings.

| Service | Relevant numeric fields |
| --- | --- |
| `LEVELONE_EQUITIES` | `0` symbol; `1` bid; `2` ask; `3` last; `4`/`5` bid/ask sizes; `8` total volume; `10`/`11` day high/low; `12` previous close; `17` open; `27`/`28` regular quote/trade flags; `29` regular last; `32` security status; `33` mark; `34` quote time; `35` trade time; `36` regular trade time; `37`/`38` bid/ask times; `42` net percent change. |
| `LEVELONE_OPTIONS` | `0` symbol; `2` bid; `3` ask; `4` last; `8` total volume; `9` OI; `10` IV; `13` multiplier; `16`/`17` bid/ask sizes; `20` strike; `21` type; `22` underlying; `24` deliverables; `27` DTE; `28`–`32` delta/gamma/theta/vega/rho; `33` security status; `35` underlying price; `37` mark; `38` quote time; `39` trade time. |
| `CHART_EQUITY` | `0` symbol; `1` open; `2` high; `3` low; `4` close; `5` minute volume; `6` sequence; `7` chart time in epoch milliseconds; `8` chart day. |

**Documentation discrepancy:** an earlier generic equity response example uses field positions inconsistent with the detailed `LEVELONE_EQUITIES` table. Do not infer numeric mappings from that generic sample. Confirm the detailed table against current official docs and an authorized stream before release. The source also contains ambiguous size descriptions; avoid converting sizes to shares/contracts until the service-specific units have been validated.

Use exact option symbols returned by the chain. The documented format has a six-character space-padded root followed by expiration date, `C`/`P`, and the fixed-width strike encoding. Stripping internal spaces changes the subscription key.

## Volume and session implications

The supplied equity table says cumulative volume includes pre/postmarket activity and resets at 07:28 Eastern. The options table says cumulative volume resets at 03:30 Eastern. Open/high/low fields have separate reset and session rules. Never infer one common reset for every field or interpret a reset as negative trading.

For regular-session relative volume, derive today's numerator from regular-session candles and compare with historical candles through the same completed market minute. Filter by actual trading sessions, including shortened days, and exclude extended hours consistently. Do not compare a whole-day cumulative quote volume with a regular-session historical denominator.

## Required verification before enabling streaming

- Confirm the user's product access and discovered connection fields; authenticate without logging secrets.
- Validate field mappings and units with recorded, redacted fixtures.
- Exercise sparse updates, missing initial metadata, stale last trades, counter resets, correction/deduplication, disconnects, and gap backfill.
- Verify one-connection ownership, serialized mutations, command acknowledgements, reconnection, and expired-token recovery.
- Confirm quote entitlements and permitted storage/display rights. Keep customer redistribution disabled until rights and tenant boundaries are established.
