import type { Bar, MarketSnapshot, OptionContract, SymbolSnapshot } from './types.js';

/** Fixed, synthetic replay. These figures are not historical or current market data. */
export const DEMO_AS_OF = Date.parse('2026-11-24T19:10:00Z');
const profiles: Record<string, { name: string; price: number; volume: number; rvol: number; pattern: 'breakout' | 'reclaim' | 'breakdown' | 'range'; option: 'CALL' | 'PUT'; dte: number }> = {
  NVDA: { name: 'NVIDIA Corporation', price: 186.42, volume: 15_000, rvol: 3.42, pattern: 'breakout', option: 'CALL', dte: 3 },
  TSLA: { name: 'Tesla, Inc.', price: 346.80, volume: 8_000, rvol: 2.86, pattern: 'breakdown', option: 'PUT', dte: 24 },
  AMD: { name: 'Advanced Micro Devices', price: 221.36, volume: 7_000, rvol: 2.65, pattern: 'reclaim', option: 'CALL', dte: 24 },
  AAPL: { name: 'Apple Inc.', price: 273.14, volume: 6_000, rvol: 1.24, pattern: 'range', option: 'CALL', dte: 3 },
  MSFT: { name: 'Microsoft Corporation', price: 482.65, volume: 4_000, rvol: 2.18, pattern: 'range', option: 'CALL', dte: 24 },
  META: { name: 'Meta Platforms, Inc.', price: 622.38, volume: 3_000, rvol: 1.32, pattern: 'range', option: 'PUT', dte: 24 },
  SPY: { name: 'SPDR S&P 500 ETF Trust', price: 674.52, volume: 12_000, rvol: 1.11, pattern: 'range', option: 'CALL', dte: 3 },
  QQQ: { name: 'Invesco QQQ Trust', price: 607.23, volume: 10_000, rvol: 2.44, pattern: 'breakout', option: 'CALL', dte: 24 },
};
export const DEMO_SYMBOLS = Object.keys(profiles);

const round = (value: number) => Math.round(value * 100) / 100;
function weekdaysBefore(day: string, length: number) {
  const dates: string[] = [];
  const cursor = new Date(`${day}T12:00:00Z`);
  while (dates.length < length) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates.reverse();
}

function minuteBar(timestamp: number, open: number, close: number, volume: number): Bar {
  return { timestamp, open: round(open), high: round(Math.max(open, close) + close * 0.00045), low: round(Math.min(open, close) - close * 0.00045), close: round(close), volume: Math.round(volume) };
}

function createSymbol(symbol: string, index: number): SymbolSnapshot {
  const profile = profiles[symbol];
  const previousDays = weekdaysBefore('2026-11-24', 25);
  const currentStart = Date.parse('2026-11-24T14:30:00Z');
  const minuteBars: Bar[] = [];
  const minuteVolume = (minute: number) => profile.volume * (1.3 + 0.5 * Math.cos(minute / 389 * Math.PI * 2));
  for (const day of previousDays.slice(-7)) {
    const start = Date.parse(`${day}T14:30:00Z`);
    for (let minute = 0; minute < 390; minute++) {
      const close = profile.price * (0.985 + Math.sin(minute / 29 + index) * 0.003);
      minuteBars.push(minuteBar(start + minute * 60_000, close * 0.9999, close, minuteVolume(minute)));
    }
  }
  const prices = Array.from({ length: 280 }, (_, minute) => {
    const wave = Math.sin(minute / 11 + index) * 0.0009 + Math.sin(minute / 23) * 0.0007;
    switch (profile.pattern) {
      case 'breakout': return profile.price * (0.982 + minute / 279 * 0.004 + wave);
      case 'breakdown': return profile.price * (1.027 - minute / 279 * 0.024 + wave);
      case 'reclaim': return profile.price * (0.996 + wave);
      default: return profile.price * (1 + Math.sin(minute / 17 + index) * 0.0015);
    }
  });
  if (profile.pattern === 'reclaim') {
    prices[278] = profile.price * 0.989;
    prices[279] = profile.price;
  } else if (profile.pattern === 'breakout') {
    // Establish a higher opening-range ceiling, then cross it on the last closed minute.
    prices[6] = profile.price * 0.991;
    prices[278] = profile.price * 0.988;
    prices[279] = profile.price;
  } else prices[279] = profile.price;
  prices.forEach((price, minute) => minuteBars.push(minuteBar(currentStart + minute * 60_000, minute === 0 ? price * 0.9999 : prices[minute - 1], price, minuteVolume(minute) * profile.rvol)));
  const dailyBars = previousDays.map((day, dayIndex) => {
    const factor = profile.pattern === 'breakout' ? 0.95 + dayIndex / 24 * 0.028
      : profile.pattern === 'breakdown' ? 1.025 + dayIndex / 24 * 0.025 : 1 + Math.sin(dayIndex / 3) * 0.018;
    const close = round(profile.price * factor);
    return { timestamp: Date.parse(`${day}T16:00:00Z`), open: round(close * 0.997), high: round(close * 1.008), low: round(close * 0.992), close, volume: Math.round(profile.volume * 390 * 1.3) };
  });
  const expiration = new Date(Date.parse('2026-11-24T00:00:00Z') + profile.dte * 86_400_000).toISOString().slice(0, 10);
  const strike = Math.round(profile.price / 5) * 5;
  const mid = round(profile.price * (profile.dte < 7 ? 0.011 : 0.023));
  const openInterest = 800 + index * 117;
  const option: OptionContract = {
    symbol: `${symbol} ${expiration} ${strike}${profile.option[0]}`, underlying: symbol,
    description: `${symbol} ${expiration} ${strike} ${profile.option.toLowerCase()}`,
    expiration, strike, type: profile.option, bid: round(mid - 0.05), ask: round(mid + 0.05),
    volume: Math.round(openInterest * (index === 6 ? 1.2 : 2.5 + index * 0.28)), openInterest,
    impliedVolatility: round(28 + index * 3.7), delta: profile.option === 'CALL' ? 0.54 : -0.48,
    timestamp: DEMO_AS_OF - 8_000, delayed: false,
  };
  const previousClose = dailyBars.at(-1)!.close;
  return {
    quote: { symbol, description: profile.name, last: profile.price, bid: round(profile.price - 0.01), ask: round(profile.price + 0.01), changePercent: round((profile.price / previousClose - 1) * 100), volume: minuteBars.filter(bar => bar.timestamp >= currentStart).reduce((sum, bar) => sum + bar.volume, 0), timestamp: DEMO_AS_OF - 2_000, delayed: false },
    minuteBars, dailyBars, options: [option],
  };
}

export function demoSnapshot(watchlist: string[]): MarketSnapshot {
  const requested = [...new Set(watchlist)];
  const supported = requested.filter(symbol => profiles[symbol]);
  const unsupported = requested.filter(symbol => !profiles[symbol]);
  return {
    mode: 'demo', asOf: DEMO_AS_OF, marketOpen: true,
    symbols: supported.map(symbol => createSymbol(symbol, DEMO_SYMBOLS.indexOf(symbol))),
    warnings: [
      'Synthetic demo replay · November 24, 2026, 2:10 PM ET. Prices, volumes, options, and alerts are illustrative; they are not actual market observations.',
      ...(unsupported.length ? [`No synthetic demo fixture for ${unsupported.join(', ')}. These symbols will be scanned when Schwab is connected.`] : []),
    ],
  };
}
