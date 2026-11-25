import type { Bar, MarketSnapshot, OptionContract, Quote, SymbolSnapshot } from '../shared/types.js';

export type SchwabMarketFetcher = (path: string, params: Record<string, string>) => Promise<unknown>;
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const nonnegative = (value: unknown): value is number => finite(value) && value >= 0;
const day = 86_400_000;
const easternDate = (timestamp: number): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(timestamp);

/** Normalize provider candles; malformed and duplicate bars cannot become signal inputs. */
export function normalizeBars(payload: unknown): Bar[] {
  const candles = record(payload).candles;
  if (!Array.isArray(candles)) return [];
  const unique = new Map<number, Bar>();
  for (const candidate of candles) {
    const c = record(candidate);
    if (!positive(c.datetime) || !positive(c.open) || !positive(c.high) || !positive(c.low) || !positive(c.close) || !nonnegative(c.volume)) continue;
    if (c.high < Math.max(c.open, c.close, c.low) || c.low > Math.min(c.open, c.close, c.high)) continue;
    unique.set(c.datetime, { timestamp: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
  }
  return [...unique.values()].sort((a, b) => a.timestamp - b.timestamp);
}

/** A missing timestamp remains zero and an unknown entitlement remains delayed. */
export function normalizeQuote(symbol: string, payload: unknown): Quote | null {
  const root = record(payload);
  if (root.assetMainType && root.assetMainType !== 'EQUITY') return null;
  const quote = record(root.quote);
  const reference = record(root.reference);
  if (!positive(quote.lastPrice) || !nonnegative(quote.bidPrice) || !nonnegative(quote.askPrice) || !finite(quote.netPercentChange) || !nonnegative(quote.totalVolume)) return null;
  return {
    symbol,
    description: typeof reference.description === 'string' ? reference.description : symbol,
    last: quote.lastPrice, bid: quote.bidPrice, ask: quote.askPrice,
    changePercent: quote.netPercentChange, volume: quote.totalVolume,
    timestamp: positive(quote.quoteTime) ? quote.quoteTime : 0,
    delayed: root.realtime !== true,
  };
}

export function normalizeOptions(symbol: string, payload: unknown): { options: OptionContract[]; warnings: string[] } {
  const chain = record(payload);
  const warnings: string[] = [];
  const options = new Map<string, OptionContract>();
  let adjusted = 0;
  let invalid = 0;
  if (chain.isChainTruncated === true) warnings.push(`${symbol}: The option chain is truncated; activity coverage is incomplete.`);
  if (chain.isDelayed !== false) warnings.push(`${symbol}: Option data is delayed or its real-time entitlement is unknown.`);
  for (const [mapName, fallbackType] of [['callExpDateMap', 'CALL'], ['putExpDateMap', 'PUT']] as const) {
    for (const strikes of Object.values(record(chain[mapName]))) {
      for (const contracts of Object.values(record(strikes))) {
        // The supplied official REST schema shows a single contract per strike;
        // production/community payloads may instead return an array at that node.
        for (const candidate of Array.isArray(contracts) ? contracts : [contracts]) {
          const c = record(candidate);
          // The application contract has no deliverable model. Do not silently assume 100 shares.
          if (c.multiplier !== 100 || c.isNonStandard === true || c.nonStandard === true || c.isMini === true || c.mini === true || (Array.isArray(c.optionDeliverablesList) && c.optionDeliverablesList.length > 0)) { adjusted++; continue; }
          const expiration = typeof c.expirationDate === 'string' ? c.expirationDate.slice(0, 10) : '';
          // Prefer official bidPrice/askPrice when present. Invalid primary fields
          // must not be hidden by a legacy fallback in the same response.
          const bid = c.bidPrice === undefined ? c.bid : c.bidPrice;
          const ask = c.askPrice === undefined ? c.ask : c.askPrice;
          if (typeof c.symbol !== 'string' || !c.symbol || !/^\d{4}-\d{2}-\d{2}$/.test(expiration) || !Number.isFinite(Date.parse(expiration)) || !positive(c.strikePrice) || !nonnegative(bid) || !nonnegative(ask) || !nonnegative(c.totalVolume) || !nonnegative(c.openInterest)) { invalid++; continue; }
          const type = c.putCall === 'CALL' || c.putCall === 'PUT' ? c.putCall : fallbackType;
          options.set(c.symbol, {
            symbol: c.symbol, underlying: symbol,
            description: typeof c.description === 'string' ? c.description : `${symbol} ${expiration} ${c.strikePrice} ${type}`,
            expiration, strike: c.strikePrice, type, bid, ask,
            volume: c.totalVolume, openInterest: c.openInterest,
            impliedVolatility: nonnegative(c.volatility) ? c.volatility : null,
            delta: finite(c.delta) && Math.abs(c.delta) <= 1 ? c.delta : null,
            timestamp: positive(c.quoteTimeInLong) ? c.quoteTimeInLong : 0,
            delayed: chain.isDelayed !== false,
          });
        }
      }
    }
  }
  if (adjusted) warnings.push(`${symbol}: ${adjusted} adjusted or unverified-multiplier option contracts excluded.`);
  if (invalid) warnings.push(`${symbol}: ${invalid} incomplete option contracts excluded.`);
  return { options: [...options.values()], warnings };
}

/** isOpen identifies an open trading date; session intervals identify whether it is open now. */
export function regularMarketOpen(payload: unknown, timestamp: number): boolean {
  const equity = record(record(record(payload).equity).EQ);
  if (equity.isOpen !== true || equity.date !== easternDate(timestamp)) return false;
  const intervals = record(equity.sessionHours).regularMarket;
  if (!Array.isArray(intervals)) return false;
  return intervals.some((range: unknown) => {
    const r = record(range);
    const start = typeof r.start === 'string' ? Date.parse(r.start) : NaN;
    const end = typeof r.end === 'string' ? Date.parse(r.end) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && timestamp >= start && timestamp < end;
  });
}

export class SchwabProvider {
  private dailyCache = new Map<string, { expires: number; bars: Bar[] }>();
  constructor(private readonly fetcher: SchwabMarketFetcher, private readonly now: () => number = Date.now) {}

  async snapshot(symbols: string[]): Promise<MarketSnapshot> {
    if (!symbols.length || symbols.length > 12 || symbols.some(s => !/^[A-Z][A-Z0-9.\/-]{0,9}$/.test(s))) throw new Error('Supply between one and twelve valid stock symbols.');
    const requestTime = this.now();
    const warnings: string[] = [];
    const quotePayload = record(await this.fetcher('/quotes', { symbols: symbols.join(','), fields: 'quote,reference', indicative: 'false' }));
    let hours: unknown;
    try {
      hours = await this.fetcher('/markets', { markets: 'equity,option', date: easternDate(requestTime) });
      const equity = record(record(record(hours).equity).EQ);
      if (equity.date !== easternDate(requestTime) || typeof equity.isOpen !== 'boolean' || (equity.isOpen && !Array.isArray(record(equity.sessionHours).regularMarket))) warnings.push('Market-session information is incomplete; live signals are suppressed.');
    } catch { warnings.push('Market-session information is unavailable; live signals are suppressed.'); }

    const results: SymbolSnapshot[] = [];
    // Sequential per-symbol requests keep the personal app well below typical request limits.
    // Daily reference bars are cached; minute bars and chains are refreshed on every scan.
    for (const symbol of [...new Set(symbols)]) {
      const quote = normalizeQuote(symbol, quotePayload[symbol]);
      if (!quote) { warnings.push(`${symbol}: A complete equity quote was not returned; symbol excluded.`); continue; }
      if (!quote.timestamp) warnings.push(`${symbol}: The quote has no provider timestamp; fresh signals are unavailable.`);
      if (quote.delayed) warnings.push(`${symbol}: Equity data is delayed or its real-time entitlement is unknown.`);
      let minuteBars: Bar[] = [];
      let dailyBars: Bar[] = [];
      let options: OptionContract[] = [];
      try {
        const history = await this.fetcher('/pricehistory', {
          symbol, periodType: 'day', frequencyType: 'minute', frequency: '1',
          startDate: String(requestTime - 35 * day), endDate: String(requestTime), needExtendedHoursData: 'false', needPreviousClose: 'true',
        });
        minuteBars = normalizeBars(history);
        if (!minuteBars.length) warnings.push(`${symbol}: No valid minute history returned; intraday baselines are unavailable.`);
      } catch { warnings.push(`${symbol}: Minute history is unavailable; intraday baselines are unavailable.`); }
      try {
        const cached = this.dailyCache.get(symbol);
        if (cached && cached.expires > requestTime) dailyBars = cached.bars;
        else {
          dailyBars = normalizeBars(await this.fetcher('/pricehistory', { symbol, periodType: 'year', period: '1', frequencyType: 'daily', frequency: '1', needExtendedHoursData: 'false', needPreviousClose: 'true' }));
          this.dailyCache.set(symbol, { bars: dailyBars, expires: requestTime + 15 * 60_000 });
        }
        if (!dailyBars.length) warnings.push(`${symbol}: No valid daily history returned; swing reference levels are unavailable.`);
      } catch { warnings.push(`${symbol}: Daily history is unavailable; swing reference levels are unavailable.`); }
      try {
        const chain = record(await this.fetcher('/chains', {
          symbol, contractType: 'ALL', strikeCount: '20', includeUnderlyingQuote: 'true', strategy: 'SINGLE', range: 'ALL',
          fromDate: easternDate(requestTime), toDate: easternDate(requestTime + 60 * day),
        }));
        if (chain.status && chain.status !== 'SUCCESS') warnings.push(`${symbol}: The provider did not return a successful option chain.`);
        else {
          const normalized = normalizeOptions(symbol, chain);
          options = normalized.options;
          warnings.push(...normalized.warnings);
        }
      } catch { warnings.push(`${symbol}: Option chain unavailable; option activity is not scanned.`); }
      results.push({ quote, minuteBars, dailyBars, options });
    }
    if (!results.length) throw new Error('Schwab returned no complete equity quotes for this watchlist. Check symbols and market-data access.');
    // Bounded coverage is explicit; this is a watchlist scanner, not a market-wide feed.
    warnings.push('Options coverage is limited to nearby strikes and expirations within 60 calendar days. Snapshot volume does not identify opening trades or trade direction.');
    // Sequential provider calls can cross a freshness or market-close boundary.
    // Evaluate the completed snapshot against completion time, never retrieval start.
    const asOf = this.now();
    const marketOpen = regularMarketOpen(hours, asOf);
    return { mode: 'schwab', asOf, marketOpen, symbols: results, warnings };
  }
}
