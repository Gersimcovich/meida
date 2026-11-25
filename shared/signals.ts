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
    const chart = current
      .slice(-70)
      .map((bar) => ({
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
            invalidation: `A close back ${bullish ? "below" : "above"} ${dollars(bullish ? high : low)} returns price inside the range.`,
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
            invalidation: `A confirmed close ${bullish ? "below" : "above"} the evolving session VWAP reverses the cross.`,
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
              invalidation: `A daily close back ${bullish ? "below" : "above"} ${dollars(bullish ? high : low)} fails the breakout.`,
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
        });
      }
  }
  signals.sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  // Providers can accidentally repeat symbols/contracts; emit one daily identity.
  const unique = new Map(signals.map((signal) => [signal.id, signal]));
  signals.splice(0, signals.length, ...unique.values());
  return result();
}
