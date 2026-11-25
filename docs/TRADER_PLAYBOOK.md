# From market observations to trader next steps

Research date: 2026-11-25. This is a focused review of broker, exchange, regulator, and options-industry education, translated into proposed Meida rules. It is not an exhaustive survey of the internet or evidence that a strategy is profitable. The matrix describes product behavior to implement and evaluate, not a claim that every feature is already available.

The useful output is a **conditional plan**, not an unexplained number: what changed, why it matters, what to check next, what would invalidate the idea, and whether the data and execution costs support acting. Keep user decisions separate from automated order execution.

## What different values actually tell us

There are three distinct kinds of values:

- **Definitions:** RVOL of 2 means twice the specified volume baseline; a 10% spread means the bid/ask difference is one tenth of midpoint. The formula and comparison period must be visible.
- **Conventions:** RSI 70/30 are common overbought/oversold reference levels. They are not universal reversal boundaries. A 20-session high or 15-minute opening range is a chosen observation window.
- **Strategy parameters:** RVOL ≥2, option volume ≥500, volume/OI ≥2, a spread ceiling, or a minimum reward/risk ratio are tunable hypotheses. The sources below do not establish any of them as a universally profitable trigger.

A large observation can warrant a stronger research alert without making the trade safer or more likely to profit. Do not convert signal strength, delta, or the number of agreeing indicators into a claimed probability of profit.

## Action hierarchy

| User-facing next step             | Meaning                                                                                 | What Meida must show                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Wait for reliable data**        | Freshness, feed quality, session, or history is insufficient.                           | Missing requirement and the last reliable observation.                                                                                                     |
| **Watch activity**                | Something unusual occurred, but direction or confirmation is missing.                   | Observed value, baseline, affected stock/contract, and the next price condition to monitor.                                                                |
| **Wait for confirmation**         | A potential setup is forming.                                                           | The exact completed-bar, price-level, or persistence condition still required.                                                                             |
| **Review a long / bearish setup** | A predeclared price condition completed and required filters passed.                    | Conditional entry area, invalidation, horizon, liquidity/cost checks, and remaining unknowns. A bearish setup does not require or authorize short selling. |
| **Review event or contract risk** | Options pricing, expiration, or an approaching event can dominate the directional idea. | The specific risk and alternative scenarios to simulate.                                                                                                   |
| **Review the existing plan**      | A saved or active plan reached its invalidation, target, or time condition.             | Which rule changed and when. Only refer to an actual position if the user has recorded or authorized access to it.                                         |

Data and liquidity failures take precedence over directional suggestions. An invalidation retires the old setup; recovery requires fresh confirmation, not automatic reuse of yesterday's alert.

## Stocks: observation-to-action matrix

These are Meida design hypotheses informed by the cited concepts. Confirmations reduce some false triggers but can delay entry and do not guarantee a better result.

| Input / candidate condition                                                                                                                                  | Conditional next step                                                                                                 | Confirmation required                                                                                                         | Invalidation / expiry                                                                                              | Common false positives and limitations                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Time-matched RVOL:** regular-session cumulative volume / mean at the same completed minute over prior comparable sessions. Research starting point: ≥2×.   | **Watch activity.** Inspect the current price location and verified catalyst; volume alone has no direction.          | A separately defined breakout, breakdown, or reclaim, with fresh quotes and adequate liquidity.                               | Retire if the intended price confirmation fails or the session/time window ends.                                   | Opening/closing auctions, index rebalances, earnings, thin historical baselines, and including extended hours in only one side of the ratio. [S1], [S2]                                                                   |
| **Opening-range breakout/breakdown:** price crosses the high/low of a fixed opening window. Example research window: first 15 or 30 regular-session minutes. | **Wait for the range to complete**, then review the relevant directional setup after a later completed-bar crossing.  | Frozen range boundaries; completed bar outside the range; chosen volume filter; optional retest/hold rule defined in advance. | A predeclared close back inside the range, failure to hold the retest, or a time cutoff.                           | Early auction price discovery, news gaps, widening spreads, and repeated range crossings. A range still expanding is not a fixed breakout level. The window is our hypothesis, not a sourced profit threshold. [S2], [S3] |
| **20-session breakout/breakdown:** completed bar beyond the highest high/lowest low of the previous 20 completed sessions.                                   | **Review a swing setup** only if the chosen entry interval confirms. State whether confirmation is intraday or daily. | Adequate daily history excluding the current session; consistent split treatment; volume and market/sector context.           | A chosen return through the reference level, failed retest, or maximum holding/confirmation window.                | A momentary wick, stale last trade, corporate-action discontinuity, a gap far beyond a sensible entry, or resistance just above the breakout. Twenty sessions is a configurable lookback. [S3], [S4]                      |
| **VWAP reclaim/loss:** prior completed close on one side of session VWAP and a new completed close on the other.                                             | **Review a reclaim/loss setup**, or keep watching if the rule also requires a retest.                                 | Consistent regular-session VWAP; sufficient volume; completed crossing; the configured hold or retest.                        | A completed reversal through the chosen invalidation level or repeated crossings that meet a predefined chop rule. | Flat/sideways sessions create whipsaws; VWAP lags. “Above VWAP” alone is not a new crossing. OHLCV-derived VWAP is an approximation to trade-based VWAP. [S5]                                                             |
| **Large gap or ATR-normalized move:** absolute move or distance from reference / prior completed ATR.                                                        | **Reassess entry and size.** Avoid presenting a large move as an instruction to chase.                                | Verified gap/corporate-action handling; fresh post-open price structure; entry and invalidation still meet the costed plan.   | Price exceeds the plan's maximum entry distance or the required position size falls below one tradable unit.       | ATR measures movement, not direction or an upper bound. A gap can continue; “already moved one ATR” does not prove reversal. [S6]                                                                                         |
| **Relative strength/weakness:** stock return minus a benchmark/sector return over the same interval.                                                         | **Prioritize research** on standouts or flag a directional setup that conflicts with its sector.                      | Aligned timestamps and session boundaries, suitable benchmark, independent price setup.                                       | The selected relative-strength condition reverses or its comparison horizon expires.                               | Beta, sector concentration, and different news exposures can explain the difference. Simple excess return is not risk-adjusted alpha. [S7]                                                                                |
| **RSI or moving-average trend context**, later. Example RSI references: above 70 / below 30.                                                                 | **Describe momentum or extension**, then wait for a separately defined price reversal/continuation condition.         | Declared interval/lookback, enough completed history, and a price structure consistent with the chosen strategy.              | Failure of that price structure; do not invalidate a trend solely because RSI remains high/low.                    | Strong trends can stay overbought/oversold; moving averages lag. RSI, MACD, and moving averages share price inputs, so three agreeing indicators are not three independent pieces of evidence. [S8]                       |

For cumulative RVOL, a high reading can remain elevated after an early spike. If the product says activity is **accelerating now**, it needs a separate recent-interval volume comparison. Do not infer acceleration from cumulative RVOL alone.

## Options: observation-to-action matrix

First establish the underlying-stock thesis. Then determine whether a particular contract is an appropriate expression to investigate. The same bullish stock idea can produce very different option outcomes across strikes, expirations, spreads, and IV levels.

| Input / candidate condition                                                                                | Conditional next step                                                                                                                            | Confirmation required                                                                                                                                    | Invalidation / expiry                                                                                                        | Common false positives and limitations                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Unusual contract volume / prior published OI.** Research filters: volume ≥500 and ratio ≥2.              | **Review options activity**, inspect expiration/strike concentration and the underlying; do not infer bullish call buying or bearish put buying. | Fresh chain and underlying prices; an independent directional setup; usable OI and contract metadata.                                                    | Stale observation, invalid contract, failure of underlying confirmation, or end of the research horizon.                     | Closing trades, repeated turnover, hedging, spreads, and rolls. OI is clearing-based; volume above OI does not prove today's open interest increased. Zero OI makes the ratio unavailable. [S9], [S10] |
| **High call/put volume ratio or apparent premium concentration.**                                          | **Investigate concentration** and identify exactly which strikes/expirations the calculation covers.                                             | Complete declared universe or a clear “sampled chain” label; transaction-level data if claiming trade side, actual premium, sweeps, or opening activity. | Coverage becomes incomplete or the interpretation relies on unavailable classification.                                      | Calls can be sold; puts can be hedges. `volume × current midpoint × multiplier` is a premium proxy, not premium paid. [S10]                                                                            |
| **Wide spread, low quoted size, stale bid/ask, or crossed quote.** Relative spread = `(ask-bid)/midpoint`. | **Wait for liquidity / exclude this contract.** Compare other contracts only if the underlying thesis remains valid.                             | Fresh noncrossed quotes, acceptable dollar and percentage cost, and size appropriate to the simulated order.                                             | Spread/cost exceeds the configured ceiling, depth is insufficient, or freshness fails.                                       | High volume/OI does not guarantee a good fill. A five-cent spread can be severe on a ten-cent option. Quoted size can disappear. [S11]                                                                 |
| **IV rises before earnings or another known event; high IV rank/percentile.**                              | **Review event risk** and simulate price-up/down/flat with IV falling after the event.                                                           | Verified event time, comparable IV history, contract-specific vega and expiration, and a costed scenario.                                                | The scenario's net payoff no longer supports the plan, the event timing is uncertain, or the user excludes event exposure.   | A correct stock direction can still lose through IV crush. High IV alone is not an instruction to sell options. Rank and percentile are different; neither predicts direction. [S12], [S13]            |
| **Delta / gamma / theta / vega exposure.**                                                                 | **Compare contract sensitivity and holding horizon.** Show approximate dollar exposure and scenario results, not a “cheap contract” label.       | Verified units/multiplier; fresh Greeks; price/time/IV scenarios; a defined maximum loss budget.                                                         | The required move or time-to-confirm is inconsistent with the selected contract, or scenario loss exceeds the chosen budget. | Delta is local sensitivity, not profit probability; gamma changes delta; theta and vega are model sensitivities, not guaranteed realized P&L. Linear approximations fail for large moves. [S14]        |
| **0DTE / near-expiration contract.**                                                                       | **Review expiration risk or skip under the user's rules.** Require a time exit and contract settlement context before a paper plan.              | Exact expiry/last-trading time, settlement/deliverable type, broker cutoff context, and adequate liquidity.                                              | Planned exit time arrives, broker cutoff approaches, or monitoring/data is insufficient.                                     | Rapidly changing exposure, full-premium loss for buyers, exercise/assignment consequences, and broker liquidation. Do not treat a calendar date alone as precise remaining trading time. [S15]         |

## Costed plans and position sizing

The user chooses the risk budget, eligible instruments, holding period, and whether overnight/event exposure is permitted. Meida should not invent these preferences or assume that an account balance makes a given risk level appropriate. Defining these choices before the trade follows the planning framework in [S17].

For an illustrative **long-stock paper plan**, let `E` be modeled entry, `I` the invalidation price below entry, `B` the user's dollar loss allowance, and `c` a per-share allowance for round-trip costs and adverse execution beyond the modeled prices:

```text
modeled_loss_per_share = (E - I) + c
shares_by_loss_allowance = floor(B / modeled_loss_per_share)
proposed_shares = min(shares_by_loss_allowance, capital_limit_in_shares, liquidity_limit_in_shares)
```

If `E <= I`, prices are invalid, or the result is below one share, do not generate a sized plan. Fixed fees need separate treatment, and cost components must not be counted twice. For a short-stock simulation, model borrow availability/cost, margin, and potentially unbounded loss; a bearish signal alone is insufficient to create that plan.

This is **modeled loss at an assumed exit**, not a guaranteed maximum loss. Stops can execute beyond their trigger, and stop-limits may not execute. Gaps, halts, and disappearing liquidity need stress scenarios. ATR can help express stop distance relative to recent volatility; it does not cap future moves. [S6], [S16]

For a simple long-option paper plan, show the full premium plus fees at risk before expiration/exercise, rather than relying only on a tight premium stop. Exercise can create an underlying position and additional exposure. Defined-risk spreads require their actual payoff, leg quantities, multiplier, assignment/settlement behavior, and costs; naked-option selling should not be generated by a generic “high IV” rule. [S15]

Estimate reward from a stated price scenario or target with a technical basis, then subtract costs. A displayed 2:1 reward/risk ratio is a property of those assumptions, not evidence of positive expectancy. If average net win is `W` and average net loss is `L`, break-even win probability is `L / (W + L)`; an actual estimate requires out-of-sample outcomes. With gross wins/losses and a constant per-trade cost `C`, it becomes `(L + C) / (W + L)`. These formulas do not supply the probability themselves.

## What a useful alert should say

The following are **fictional examples**, not current market observations:

> **Watch activity — EXAMPLE stock.** Volume is 2.4× its mean through the same completed market minute across 20 prior eligible sessions. Price remains inside the completed opening range. Next: watch for a five-minute close above 50.20 with the liquidity filter still passing. The directional setup is not confirmed. Data timestamp and feed classification: shown separately.

> **Review long setup — EXAMPLE stock.** A completed five-minute bar crossed the frozen 50.20 opening-range high; time-matched RVOL is 2.4×. Review the configured retest/hold condition and costed plan before acting. Retire this setup on the configured completed close back below 50.20 or its time cutoff. A new bar below the level changes the message to “setup invalidated.”

> **Wait for liquidity — EXAMPLE call.** Today's volume is 1,000 contracts versus prior OI of 200, a 5× activity ratio. Bid/ask is 1.00/1.30: a 0.30 spread, or 26.1% of midpoint. That fails this example's configured cost filter. Volume does not identify buyer intent. The app does not promote the activity flag into a directional trade instruction.

The UI should distinguish **“forming,” “confirmed under your rules,” and “invalidated”**. “Confirmed” means a rule completed, not that the future outcome is known. For missing event data, say “event calendar unavailable”; do not say “no event risk.”

## Engine output contract

Current action labels such as `watch`, `review-long`, `review-short`, and `review-activity` can express the basic next step. Keep confirmation state and data/risk gates separate so a single score cannot override a blocker.

Each actionable observation should carry:

- **Evidence:** instrument, provider event time, receipt time, feed classification, session, observed metric, baseline, sample coverage, and trigger bar.
- **Interpretation:** setup family, direction if established, rule version, and plain-language reason. Preserve the distinction between observed facts and hypotheses.
- **Next step:** exact remaining confirmation, conditional entry area if justified, invalidation rule, time expiry, and relevant cost/event checks.
- **State:** forming/confirmed/invalidated/expired, with the state-change time. Repeated snapshots of the same condition should update the card, not repeatedly notify.
- **Limitations:** missing history, delayed/limited feed, unavailable event data, unsupported trade classification, or unknown contract metadata.

Use deterministic calculations and state transitions for numbers, price levels, and eligibility. A language model may explain those structured facts, but it should not invent a catalyst, synthesize a missing quote, upgrade a blocked setup, or rewrite the triggering threshold. Save the structured inputs alongside the explanation for audit and evaluation.

## Staged route to real-time guidance

1. **Transparent snapshots:** compute a small watchlist from authorized REST quotes, chains, candles, and current session hours. Label refresh cadence and quote age. Support activity review and completed-bar price conditions with explanations. Polling is not tick-by-tick coverage.
2. **Reliable streaming:** add one authorized Schwab stream per user, sparse-update merging, event-time handling, gap recovery, and session resets as documented in [STREAMING.md](STREAMING.md). L1 updates are conflated and do not establish a complete trade tape. Signal cadence should match the strategy's completed-bar interval; receiving a new quote does not require sending a new action.
3. **Persistent research:** record versioned rules and forward paper outcomes. Evaluate chronological walk-forward windows and an untouched holdout, with latency, spread, slippage, fees, survivorship, and point-in-time data controls described in [RESEARCH.md](RESEARCH.md). Compare against simple baselines and report sample size/uncertainty, not just win rate.
4. **Additional evidence:** add a verified event calendar, comparable historical option/IV data, and licensed trade-level classification only when they support a tested use case. Do not infer sweeps or “smart money” from chain snapshots.
5. **Customer delivery:** complete the data-rights, tenant isolation, authorization, and audit work in [RESEARCH.md](RESEARCH.md). Add user-configured delivery channels, deduplication, alert expiry, and acknowledgment. Sending an alert and executing a brokerage order are separate capabilities and authorizations.

## Primary sources

The sources substantiate indicator definitions, market mechanics, and cautions. The exact Meida thresholds, action wording, state machine, and validation design are proposed engineering/research choices; they are not recommendations issued by these publishers.

- **S1:** [Schwab — Trading Near the Bells](https://www.schwab.com/learn/story/trading-near-bells): intraday volume patterns and opening/closing context.
- **S2:** [NYSE — Auctions](https://www.nyse.com/trade/auctions): auction mechanics and price discovery.
- **S3:** [Schwab — Volume and Price Trends](https://www.schwab.com/learn/story/ways-volume-can-help-confirm-price-trends): participation and breakout context.
- **S4:** [Fidelity — Chart Patterns transcript](https://www.fidelity.com/bin-public/060_www_fidelity_com/documents/learning-center/Transcript_Chart-patterns_v2.pdf): intrabar versus confirmation filters and false signals.
- **S5:** [Schwab — Volume-Weighted Indicators](https://www.schwab.com/learn/story/how-to-use-volume-weighted-indicators-trading): VWAP definition and interpretation.
- **S6:** [Schwab — Average True Range](https://www.schwab.com/learn/story/average-true-range-indicator-and-volatility): volatility, stop distance, and position sizing context.
- **S7:** [Schwab — Sector Strength](https://www.schwab.com/learn/story/using-thinkorswim-to-spot-sector-strength): identifying relative sector/company performance for further research.
- **S8:** [Fidelity — RSI](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI): common reference levels and persistence in strong trends.
- **S9:** [OIC — Open Interest](https://www.optionseducation.org/news/open-interest-why-it-matters): outstanding contracts versus session activity and clearing.
- **S10:** [Cboe — Open-Close Volume Summary](https://datashop.cboe.com/cboe-options-open-close-volume-summary): specialized participant/side/open-close classifications.
- **S11:** [Schwab — Wide Bid/Ask Spreads](https://www.schwab.com/learn/story/large-bidask-options-spreads-volatile-markets): liquidity, execution, and cost.
- **S12:** [OIC — The Crush Is Real](https://www.optionseducation.org/news/the-crush-is-real): event-related IV changes and option valuation.
- **S13:** [Schwab — Options Around Earnings](https://www.schwab.com/learn/story/trading-options-around-earnings-announcements): earnings-specific option scenarios.
- **S14:** [Schwab — Options Greeks](https://www.schwab.com/options/options-greeks): delta, gamma, theta, and vega sensitivities.
- **S15:** [FINRA — Zeroing In on 0DTE](https://syndication.finra.org/content/zeroing-options-trading-strategy-0dte): expiration-day exposure and broker/settlement considerations.
- **S16:** [SEC Investor.gov — Stop and Stop-Limit Orders](https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-15): trigger prices versus execution and non-fill risk.
- **S17:** [Schwab — Elements of a Trade Plan](https://www.schwab.com/learn/story/5-elements-smart-trade-plan): defining objectives, entry/exit rules, and position size.

[S1]: https://www.schwab.com/learn/story/trading-near-bells
[S2]: https://www.nyse.com/trade/auctions
[S3]: https://www.schwab.com/learn/story/ways-volume-can-help-confirm-price-trends
[S4]: https://www.fidelity.com/bin-public/060_www_fidelity_com/documents/learning-center/Transcript_Chart-patterns_v2.pdf
[S5]: https://www.schwab.com/learn/story/how-to-use-volume-weighted-indicators-trading
[S6]: https://www.schwab.com/learn/story/average-true-range-indicator-and-volatility
[S7]: https://www.schwab.com/learn/story/using-thinkorswim-to-spot-sector-strength
[S8]: https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI
[S9]: https://www.optionseducation.org/news/open-interest-why-it-matters
[S10]: https://datashop.cboe.com/cboe-options-open-close-volume-summary
[S11]: https://www.schwab.com/learn/story/large-bidask-options-spreads-volatile-markets
[S12]: https://www.optionseducation.org/news/the-crush-is-real
[S13]: https://www.schwab.com/learn/story/trading-options-around-earnings-announcements
[S14]: https://www.schwab.com/options/options-greeks
[S15]: https://syndication.finra.org/content/zeroing-options-trading-strategy-0dte
[S16]: https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-bulletins-15
[S17]: https://www.schwab.com/learn/story/5-elements-smart-trade-plan
