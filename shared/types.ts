export type Horizon = "intraday" | "swing";
export type SourceMode = "demo" | "schwab";
export interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
export interface Quote {
  symbol: string;
  description: string;
  last: number;
  bid: number;
  ask: number;
  changePercent: number;
  volume: number;
  timestamp: number;
  delayed: boolean;
}
export interface OptionContract {
  symbol: string;
  underlying: string;
  description: string;
  expiration: string;
  strike: number;
  type: "CALL" | "PUT";
  bid: number;
  ask: number;
  volume: number;
  openInterest: number;
  impliedVolatility: number | null;
  delta: number | null;
  timestamp: number;
  delayed: boolean;
}
export interface SymbolSnapshot {
  quote: Quote;
  minuteBars: Bar[];
  dailyBars: Bar[];
  options: OptionContract[];
}
export interface MarketSnapshot {
  mode: SourceMode;
  asOf: number;
  marketOpen: boolean;
  symbols: SymbolSnapshot[];
  warnings: string[];
}
export interface Rules {
  relativeVolume: number;
  optionVolumeRatio: number;
  minOptionVolume: number;
  maxSpreadPercent: number;
  minOpenInterest: number;
  maxDte: number;
  enabled: string[];
}
export const DEFAULT_RULES: Rules = {
  relativeVolume: 2,
  optionVolumeRatio: 2,
  minOptionVolume: 500,
  maxSpreadPercent: 10,
  minOpenInterest: 100,
  maxDte: 60,
  enabled: [
    "relative-volume",
    "opening-breakout",
    "vwap-cross",
    "swing-breakout",
    "option-activity",
  ],
};
export interface Signal {
  id: string;
  symbol: string;
  instrument: string;
  asset: "stock" | "option";
  horizon: Horizon;
  rule: string;
  title: string;
  direction: "bullish" | "bearish" | "neutral";
  strength: number;
  price: number;
  changePercent: number;
  timestamp: number;
  mode: SourceMode;
  summary: string;
  evidence: { label: string; value: string }[];
  cautions: string[];
  invalidation: string;
  chart: { time: number; price: number; volume: number }[];
}
export interface ScanResult {
  mode: SourceMode;
  asOf: number;
  marketOpen: boolean;
  signals: Signal[];
  quotes: Quote[];
  warnings: string[];
  scanned: number;
}
export interface ConnectionStatus {
  configured: boolean;
  connected: boolean;
  reconnectRequired: boolean;
  callbackUrl: string;
  message: string;
}
export interface JournalEntry {
  id: string;
  signalId: string;
  symbol: string;
  instrument: string;
  asset: "stock" | "option";
  mode: SourceMode;
  horizon: Horizon;
  direction: "long" | "short";
  entryPrice: number;
  exitPrice: number | null;
  quantity: number;
  multiplier: number;
  fees: number;
  notes: string;
  openedAt: number;
  closedAt: number | null;
  pnl: number | null;
}
export interface AppState {
  mode: SourceMode;
  watchlist: string[];
  rules: Rules;
  connection: ConnectionStatus;
  journal: JournalEntry[];
  lastScan: ScanResult | null;
}
