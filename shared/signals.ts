import type {
  Bar,
  MarketSnapshot,
  OptionContract,
  Rules,
  ScanResult,
  Signal,
  SymbolSnapshot,
} from "./types.js";

const MINUTE = 60_000;
const MAX_AGE = 120_000;
const OPEN_MINUTE = 9 * 60 + 30;
const CLOSE_MINUTE = 16 * 60;
const ny = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Exchange-local day/minute, including daylight-saving transitions. */
function sessionTime(timestamp: number) {
  const parts = Object.fromEntries(
    ny.formatToParts(timestamp).map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const finite = (value: number) => Number.isFinite(value);
const positive = (value: number) => finite(value) && value > 0;
const fresh = (timestamp: number, now: number) =>
  finite(timestamp) &&
  timestamp > 0 &&
  now - timestamp <= MAX_AGE &&
  timestamp <= now + 5_000;
const dollars = (value: number) => `$${value.toFixed(2)}`;
const count = (value: number) => Math.round(value).toLocaleString("en-US");
const strength = (ratio: number, confirmation = 0) =>
  Math.min(
    98,
    Math.round(45 + Math.log2(Math.max(1, ratio)) * 16 + confirmation),
  );

const reviewSteps = [
  "Recheck a current two-sided quote and the spread; skip an entry if execution costs undermine the setup.",
  "Check earnings, news and scheduled events before entry; this feed does not establish that no catalyst is pending.",
  "Choose a maximum dollar loss before entering and size the position using the planned entry and invalidation. Allow for fees, slippage and gaps.",
  "Record the entry and exit conditions in the paper journal first. A stop order can fill beyond its trigger price.",
];

/** Conditional next steps reference measured levels; they are not executable orders. */
function directionalGuidance(
  kind: "opening-range" | "vwap" | "swing",
  bullish: boolean,
  level: number,
  relativeVolume: number,
): Pick<Signal, "plan" | "invalidation"> {
  const side = bullish ? "long" : "short";
  const holds = bullish ? "above" : "below";
  const reverses = bullish ? "below" : "above";
  const invalidation =
    kind === "swing"
      ? `A daily close back ${reverses} ${dollars(level)} fails the breakout.`
      : kind === "vwap"
        ? `A confirmed close ${reverses} the evolving session VWAP reverses the cross.`
        : `A close back ${reverses} ${dollars(level)} returns price inside the range.`;
  const trigger =
    kind === "swing"
      ? `Consider a ${side} only if the session closes ${holds} ${dollars(level)}, the prior 20-session ${bullish ? "high" : "low"}, and a later entry has a current, liquid quote. Daily-close confirmation is pending.`
      : kind === "vwap"
        ? `Consider a ${side} only if a new completed one-minute candle holds ${holds} the updated session VWAP (currently ${dollars(level)}), relative volume remains at least ${relativeVolume.toFixed(1)}×, and the entry quote is current and liquid.`
        : `Consider a ${side} only if a new completed one-minute candle holds ${holds} ${dollars(level)}, the 15-minute opening-range ${bullish ? "high" : "low"}, relative volume remains at least ${relativeVolume.toFixed(1)}×, and the entry quote is current and liquid.`;
  return {
    invalidation,
    plan: {
      action: bullish ? "review-long" : "review-short",
      headline: `A ${side} setup to review after confirmation`,
      trigger,
      invalidation,
      steps: [
        ...(kind === "vwap"
          ? [
              "Recompute the session VWAP before deciding; its value moves as new candles complete.",
            ]
          : []),
        ...(!bullish
          ? [
              "Confirm borrow availability, borrowing costs and account permissions before considering a short. None are verified by this signal.",
            ]
          : []),
        ...reviewSteps,
      ],
    },
  };
}

function validBar(bar: Bar) {
  return (
    finite(bar.timestamp) &&
    positive(bar.open) &&
    positive(bar.high) &&
    positive(bar.low) &&
    positive(bar.close) &&
    finite(bar.volume) &&
    bar.volume >= 0 &&
    bar.high >= Math.max(bar.open, bar.close, bar.low) &&
    bar.low <= Math.min(bar.open, bar.close)
  );
}

function minuteContext(item: SymbolSnapshot, asOf: number) {
  const session = sessionTime(asOf);
  const cutoff = Math.min(session.minute - 1, CLOSE_MINUTE - 1);
  const sessions = new Map<string, Map<number, Bar>>();
  for (const bar of item.minuteBars) {
    if (!validBar(bar) || bar.timestamp + MINUTE > asOf) continue;
    const time = sessionTime(bar.timestamp);
    if (
      time.minute < OPEN_MINUTE ||
      time.minute > cutoff ||
      time.day > session.day
    )
      continue;
    const minutes = sessions.get(time.day) ?? new Map<number, Bar>();
    // Duplicate provider candles must never inflate volume.
    minutes.set(time.minute, bar);
    sessions.set(time.day, minutes);
  }
  const expected = cutoff - OPEN_MINUTE + 1;
  const complete = (minutes: Map<number, Bar>) =>
    expected > 0 && minutes.size === expected;
  const currentMap = sessions.get(session.day) ?? new Map<number, Bar>();
  const current = [...currentMap.values()].sort(
    (a, b) => a.timestamp - b.timestamp,
  );
  const previous = [...sessions.entries()]
    .filter(([day, minutes]) => day < session.day && complete(minutes))
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 20);
  const sumVolume = (bars: Iterable<Bar>) =>
    [...bars].reduce((sum, bar) => sum + bar.volume, 0);
  const volume = sumVolume(current);
  const baseline = previous.length
    ? previous.reduce((sum, [, bars]) => sum + sumVolume(bars.values()), 0) /
      previous.length
    : 0;
  const rvol =
    complete(currentMap) && previous.length >= 5 && positive(baseline)
      ? volume / baseline
      : null;
  return {
    day: session.day,
    minute: session.minute,
    current,
    volume,
    baseline,
    baselineSessions: previous.length,
    rvol,
  };
}

function dailyReference(item: SymbolSnapshot, day: string) {
  const days = new Map<string, Bar>();
  for (const bar of item.dailyBars) {
    if (!validBar(bar)) continue;
    const barDay = sessionTime(bar.timestamp).day;
    if (barDay < day) days.set(barDay, bar);
  }
  return [...days.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 20)
    .map(([, bar]) => bar);
}

function optionMetrics(
  option: OptionContract,
  snapshot: MarketSnapshot,
  rules: Rules,
  day: string,
) {
  if (
    option.delayed ||
    !fresh(option.timestamp, snapshot.asOf) ||
    !positive(option.bid) ||
    !positive(option.ask) ||
    option.ask < option.bid
  )
    return null;
  if (
    !finite(option.volume) ||
    option.volume < rules.minOptionVolume ||
    !positive(option.openInterest) ||
    option.openInterest < rules.minOpenInterest
  )
    return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(option.expiration)) return null;
  const expiration = Date.parse(`${option.expiration}T00:00:00Z`);
  if (
    !finite(expiration) ||
    new Date(expiration).toISOString().slice(0, 10) !== option.expiration
  )
    return null;
  const dte = (expiration - Date.parse(`${day}T00:00:00Z`)) / 86_400_000;
  const midpoint = (option.ask + option.bid) / 2;
  const spread = ((option.ask - option.bid) / midpoint) * 100;
  const ratio = option.volume / option.openInterest;
  if (
    dte < 1 ||
    dte > rules.maxDte ||
    spread > rules.maxSpreadPercent ||
    ratio < rules.optionVolumeRatio
  )
    return null;
  return { dte, midpoint, spread, ratio };
}

/** Deterministic scanner. Strength is a ranking heuristic, never a probability of profit. */
export function scanMarket(snapshot: MarketSnapshot, rules: Rules): ScanResult {
  const warnings = [...snapshot.warnings];
  const signals: Signal[] = [];
  const quotes = snapshot.symbols.map((item) => item.quote);
  const result = () => ({
    mode: snapshot.mode,
    asOf: snapshot.asOf,
    marketOpen: snapshot.marketOpen,
    signals,
    quotes,
    warnings: [...new Set(warnings)],
    scanned: snapshot.symbols.length,
  });
  if (!finite(snapshot.asOf) || snapshot.asOf <= 0) {
    warnings.push(
      "The snapshot has no valid observation time. Signals were suppressed.",
    );
    return result();
  }
  if (!snapshot.marketOpen) {
    warnings.push(
      "Regular market session is closed or unverified. No new signals are generated.",
    );
    return result();
  }
  const scanTime = sessionTime(snapshot.asOf);
  if (scanTime.minute < OPEN_MINUTE || scanTime.minute >= CLOSE_MINUTE) {
    warnings.push(
      "Outside regular equity market hours. No new signals are generated.",
    );
    return result();
  }
  for (const item of snapshot.symbols) {
    const { quote } = item;
    if (
      quote.delayed ||
      !fresh(quote.timestamp, snapshot.asOf) ||
      !positive(quote.last)
    ) {
      warnings.push(
        `${quote.symbol}: delayed, stale, or invalid quote; signals suppressed.`,
      );
      continue;
    }
    const context = minuteContext(item, snapshot.asOf);
    const { current, rvol } = context;
    const stockBookValid =
      positive(quote.bid) && positive(quote.ask) && quote.ask >= quote.bid;
    if (!stockBookValid)
      warnings.push(
        `${quote.symbol}: missing or crossed equity bid/ask; stock signals suppressed.`,
      );
    const last = current.at(-1);
    const previous = current.at(-2);
    const recentBars =
      last && snapshot.asOf - (last.timestamp + MINUTE) <= MAX_AGE;
    const chart = current.slice(-70).map((bar) => ({
      time: bar.timestamp,
      price: bar.close,
      volume: bar.volume,
    }));
    const base = (
      rule: string,
      instrument = quote.symbol,
    ): Pick<
      Signal,
      | "id"
      | "symbol"
      | "instrument"
      | "timestamp"
      | "mode"
      | "price"
      | "changePercent"
      | "chart"
      | "rule"
    > => ({
      id: `${snapshot.mode}:${context.day}:${rule}:${instrument}`,
      symbol: quote.symbol,
      instrument,
      timestamp: last ? last.timestamp + MINUTE : quote.timestamp,
      mode: snapshot.mode,
      price: quote.last,
      changePercent: finite(quote.changePercent) ? quote.changePercent : 0,
      chart,
      rule,
    });
    const volumeEvidence = [
      { label: "Relative volume", value: `${rvol?.toFixed(2) ?? "N/A"}×` },
      { label: "Completed-bar volume", value: count(context.volume) },
      {
        label: "Same-time baseline",
        value: `${count(context.baseline)} · ${context.baselineSessions} sessions`,
      },
    ];
    const volumeCaution =
      "Volume compares completed regular-session minutes with the same minutes in prior sessions. Splits and unusual sessions can distort the baseline.";
    if (rvol === null)
      warnings.push(
        `${quote.symbol}: RVOL needs a complete current session through the last closed minute and at least 5 complete same-time historical sessions.`,
      );
    if (
      stockBookValid &&
      rvol !== null &&
      rvol >= rules.relativeVolume &&
      recentBars
    ) {
      if (rules.enabled.includes("relative-volume"))
        signals.push({
          ...base("relative-volume"),
          asset: "stock",
          horizon: "intraday",
          title: "Unusual stock volume",
          direction: "neutral",
          strength: strength(rvol),
          summary: `${quote.symbol} has traded ${rvol.toFixed(2)}× its usual same-time volume.`,
          evidence: volumeEvidence,
          cautions: [
            volumeCaution,
            "Elevated volume alone does not establish trade direction or predict returns.",
          ],
          invalidation: `Participation fades if same-time relative volume falls below ${rules.relativeVolume.toFixed(1)}×.`,
          plan: {
            action: "watch",
            headline: "Wait for price to establish a direction",
            trigger:
              "Consider a trade only if a separate, completed price breakout or VWAP cross confirms a direction and the entry quote is current and liquid. Unusual volume alone is not a buy or sell call.",
            invalidation: `Participation fades if same-time relative volume falls below ${rules.relativeVolume.toFixed(1)}×.`,
            steps: [
              "Watch for a price-confirmation signal and its measured invalidation level before choosing long or short.",
              ...reviewSteps,
            ],
          },
        });
      const opening = current.filter(
        (bar) => sessionTime(bar.timestamp).minute < OPEN_MINUTE + 15,
      );
      if (
        rules.enabled.includes("opening-breakout") &&
        opening.length === 15 &&
        last &&
        previous &&
        context.minute > OPEN_MINUTE + 15
      ) {
        const high = Math.max(...opening.map((bar) => bar.high));
        const low = Math.min(...opening.map((bar) => bar.low));
        const bullish = previous.close <= high && last.close > high;
        const bearish = previous.close >= low && last.close < low;
        if (bullish || bearish)
          signals.push({
            ...base("opening-breakout"),
            asset: "stock",
            horizon: "intraday",
            title: bullish
              ? "Opening-range breakout"
              : "Opening-range breakdown",
            direction: bullish ? "bullish" : "bearish",
            strength: strength(rvol, 12),
            summary: `A completed one-minute candle crossed ${bullish ? "above" : "below"} the first 15-minute range with expanded volume.`,
            evidence: [
              {
                label: "15-minute range",
                value: `${dollars(low)} – ${dollars(high)}`,
              },
              { label: "Confirmed close", value: dollars(last.close) },
              ...volumeEvidence,
            ],
            cautions: [
              volumeCaution,
              "Opening-range breaks can fail. The reference range excludes all later candles.",
            ],
            ...directionalGuidance(
              "opening-range",
              bullish,
              bullish ? high : low,
              rules.relativeVolume,
            ),
          });
      }
      if (
        rules.enabled.includes("vwap-cross") &&
        last &&
        previous &&
        current.length >= 16
      ) {
        let total = 0;
        let weighted = 0;
        const vwaps = current.map((bar) => {
          total += bar.volume;
          weighted += ((bar.high + bar.low + bar.close) / 3) * bar.volume;
          return total > 0 ? weighted / total : NaN;
        });
        const vwap = vwaps.at(-1)!;
        const previousVwap = vwaps.at(-2)!;
        const bullish = previous.close <= previousVwap && last.close > vwap;
        const bearish = previous.close >= previousVwap && last.close < vwap;
        if (positive(vwap) && (bullish || bearish))
          signals.push({
            ...base("vwap-cross"),
            asset: "stock",
            horizon: "intraday",
            title: bullish ? "VWAP reclaim" : "VWAP loss",
            direction: bullish ? "bullish" : "bearish",
            strength: strength(rvol, 8),
            summary: `Price crossed ${bullish ? "above" : "below"} the session's candle-based VWAP on a completed bar.`,
            evidence: [
              { label: "Approximate VWAP", value: dollars(vwap) },
              { label: "Confirmed close", value: dollars(last.close) },
              ...volumeEvidence,
            ],
            cautions: [
              "VWAP uses typical candle price × volume; it is an approximation, not trade-level VWAP.",
              volumeCaution,
            ],
            ...directionalGuidance("vwap", bullish, vwap, rules.relativeVolume),
          });
      }
      if (rules.enabled.includes("swing-breakout") && last) {
        const reference = dailyReference(item, context.day);
        if (reference.length < 20)
          warnings.push(
            `${quote.symbol}: swing breakout needs 20 completed daily sessions.`,
          );
        else {
          const high = Math.max(...reference.map((bar) => bar.high));
          const low = Math.min(...reference.map((bar) => bar.low));
          const bullish = last.close > high;
          const bearish = last.close < low;
          if (bullish || bearish)
            signals.push({
              ...base("swing-breakout"),
              asset: "stock",
              horizon: "swing",
              title: bullish
                ? "20-session high breakout"
                : "20-session low breakdown",
              direction: bullish ? "bullish" : "bearish",
              strength: strength(rvol, 16),
              summary: `A completed intraday candle moved ${bullish ? "above" : "below"} the previous 20 sessions' range. Daily-close confirmation is still pending.`,
              evidence: [
                {
                  label: "Prior 20-session range",
                  value: `${dollars(low)} – ${dollars(high)}`,
                },
                {
                  label: "Confirmed intraday close",
                  value: dollars(last.close),
                },
                ...volumeEvidence,
              ],
              cautions: [
                "This is an intraday alert at a swing level; the current session is excluded from the reference and its daily close is not yet confirmed.",
                volumeCaution,
              ],
              ...directionalGuidance(
                "swing",
                bullish,
                bullish ? high : low,
                rules.relativeVolume,
              ),
            });
        }
      }
    }
    if (rules.enabled.includes("option-activity"))
      for (const option of item.options) {
        if (option.underlying !== quote.symbol) continue;
        const metrics = optionMetrics(option, snapshot, rules, context.day);
        if (!metrics) continue;
        signals.push({
          ...base("option-activity", option.symbol),
          timestamp: option.timestamp,
          asset: "option",
          horizon: metrics.dte <= 7 ? "intraday" : "swing",
          title: "Unusual options activity",
          direction: "neutral",
          strength: strength(metrics.ratio, 4),
          price: metrics.midpoint,
          summary: `${option.description || option.symbol}: session volume is ${metrics.ratio.toFixed(2)}× prior-day open interest.`,
          evidence: [
            {
              label: "Contract",
              value: `${option.type} · ${dollars(option.strike)} · ${option.expiration}`,
            },
            {
              label: "Volume / open interest",
              value: `${count(option.volume)} / ${count(option.openInterest)} · ${metrics.ratio.toFixed(2)}×`,
            },
            {
              label: "Bid / ask",
              value: `${dollars(option.bid)} / ${dollars(option.ask)}`,
            },
            {
              label: "Quoted spread",
              value: `${metrics.spread.toFixed(2)}% of midpoint`,
            },
            {
              label: "Days to expiration",
              value: `${metrics.dte} calendar days`,
            },
            {
              label: "Implied volatility",
              value:
                option.impliedVolatility !== null &&
                finite(option.impliedVolatility)
                  ? `${option.impliedVolatility.toFixed(1)}%`
                  : "Unavailable",
            },
          ],
          cautions: [
            "Volume / open interest does not prove opening trades, institutional activity, buying, or a directional bet.",
            "Shown price is the current midpoint, not an executable fill. The chart shows the underlying stock.",
            "Open interest is a prior-clearing snapshot. Adjusted contracts can have nonstandard deliverables; confirm the contract multiplier before paper entry.",
          ],
          invalidation: `Reassess if the quoted spread exceeds ${rules.maxSpreadPercent}% or a current two-sided quote is unavailable.`,
          plan: {
            action: "review-activity",
            headline: "Investigate activity before choosing a trade",
            trigger:
              "Consider an options trade only if independent underlying-price confirmation, a defined-risk structure and a current, liquid option quote support it. Volume/open interest supplies no buy or sell direction.",
            invalidation: `Reassess if the quoted spread exceeds ${rules.maxSpreadPercent}% or a current two-sided quote is unavailable.`,
            steps: [
              `Inspect the ${dollars(option.strike)} ${option.type.toLowerCase()} with ${metrics.dte} calendar days to expiration. Session volume may include closing trades or legs of a spread.`,
              "Compare implied volatility, time decay and the underlying's price setup; a call is not proof of bullish buying and a put is not proof of bearish buying.",
              "Define the position's maximum loss and confirm its deliverable and multiplier before choosing quantity. The displayed midpoint is not a promised fill.",
              ...reviewSteps,
            ],
          },
        });
      }
  }
  signals.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  // Providers can accidentally repeat symbols/contracts; emit one daily identity.
  const unique = new Map(signals.map((signal) => [signal.id, signal]));
  signals.splice(0, signals.length, ...unique.values());
  return result();
}
