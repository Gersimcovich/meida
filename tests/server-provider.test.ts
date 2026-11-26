import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeBars,
  normalizeOptions,
  normalizeQuote,
  regularMarketOpen,
  SchwabProvider,
} from "../server/schwab.js";

const now = Date.parse("2026-11-25T15:30:00Z");
const quote = {
  assetMainType: "EQUITY",
  realtime: true,
  quote: {
    lastPrice: 101,
    bidPrice: 100.99,
    askPrice: 101.01,
    netPercentChange: 1,
    totalVolume: 5000,
    quoteTime: now,
  },
  reference: { description: "Example" },
};
const candle = {
  datetime: now - 60_000,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 500,
};
const contract = {
  symbol: "XYZ  261218C00100000",
  description: "XYZ call",
  putCall: "CALL",
  expirationDate: "2026-12-18T21:00:00.000+00:00",
  strikePrice: 100,
  multiplier: 100,
  nonStandard: false,
  bid: 2,
  ask: 2.1,
  totalVolume: 1000,
  openInterest: 200,
  volatility: 45,
  delta: 0.6,
  quoteTimeInLong: now,
};
const chain = {
  status: "SUCCESS",
  isDelayed: false,
  isChainTruncated: false,
  callExpDateMap: { "2026-12-18:23": { "100.0": [contract] } },
};
const hours = {
  equity: {
    EQ: {
      date: "2026-11-25",
      isOpen: true,
      sessionHours: {
        regularMarket: [
          {
            start: "2026-11-25T09:30:00-05:00",
            end: "2026-11-25T16:00:00-05:00",
          },
        ],
      },
    },
  },
};

test("quote timestamps and entitlement are never replaced with retrieval time", () => {
  assert.equal(normalizeQuote("XYZ", quote)?.timestamp, now);
  assert.equal(normalizeQuote("XYZ", quote)?.delayed, false);
  assert.equal(
    normalizeQuote("XYZ", {
      ...quote,
      realtime: undefined,
      quote: { ...quote.quote, quoteTime: undefined },
    })?.timestamp,
    0,
  );
  assert.equal(
    normalizeQuote("XYZ", { ...quote, realtime: undefined })?.delayed,
    true,
  );
  assert.equal(
    normalizeQuote("XYZ", {
      ...quote,
      quote: { ...quote.quote, lastPrice: undefined },
    }),
    null,
  );
  assert.equal(
    normalizeQuote("XYZ", { ...quote, assetMainType: "OPTION" }),
    null,
  );
});

test("candles reject malformed OHLC and duplicate timestamps", () => {
  assert.deepEqual(
    normalizeBars({
      candles: [
        candle,
        candle,
        { ...candle, datetime: now, high: 98 },
        { ...candle, datetime: now + 1, volume: -1 },
      ],
    }),
    [
      {
        timestamp: candle.datetime,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 500,
      },
    ],
  );
});

test("options preserve provider timestamps and exclude adjusted or unknown deliverables", () => {
  const normalized = normalizeOptions("XYZ", chain);
  assert.equal(normalized.options[0].timestamp, now);
  assert.equal(normalized.options[0].delayed, false);
  assert.equal(normalized.options[0].openInterest, 200);
  const variants = {
    ...chain,
    isDelayed: undefined,
    isChainTruncated: true,
    callExpDateMap: {
      "2026-12-18:23": {
        "100.0": [
          {
            ...contract,
            quoteTimeInLong: undefined,
            delta: -999,
            volatility: NaN,
          },
          { ...contract, symbol: "adjusted", nonStandard: true },
          { ...contract, symbol: "unknown", multiplier: undefined },
          {
            ...contract,
            symbol: "deliverable",
            optionDeliverablesList: [{ symbol: "XYZ", deliverableUnits: 100 }],
          },
          { ...contract, symbol: "missing-volume", totalVolume: undefined },
        ],
      },
    },
  };
  const result = normalizeOptions("XYZ", variants);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].timestamp, 0);
  assert.equal(result.options[0].delayed, true);
  assert.equal(result.options[0].delta, null);
  assert.equal(result.options[0].impliedVolatility, null);
  assert(result.warnings.some((x) => x.includes("3 adjusted")));
  assert(result.warnings.some((x) => x.includes("1 incomplete")));
  assert(result.warnings.some((x) => x.includes("truncated")));
});

test("official REST contract-map shape and bidPrice fields are supported alongside array responses", () => {
  const official = {
    ...contract,
    bid: undefined,
    ask: undefined,
    bidPrice: 3,
    askPrice: 3.2,
    isNonStandard: false,
    isMini: false,
  };
  const result = normalizeOptions("XYZ", {
    ...chain,
    callExpDateMap: { "2026-12-18:23": { "100.0": official } },
  });
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].bid, 3);
  assert.equal(result.options[0].ask, 3.2);
  assert.equal(result.options[0].timestamp, now);
  const exclusions = normalizeOptions("XYZ", {
    ...chain,
    callExpDateMap: {
      "2026-12-18:23": {
        "100": { ...official, isNonStandard: true },
        "101": { ...official, isMini: true },
        "102": { ...official, bidPrice: -1, bid: 3 },
      },
    },
  });
  assert.equal(exclusions.options.length, 0);
  assert(exclusions.warnings.some((x) => x.includes("2 adjusted")));
  assert(exclusions.warnings.some((x) => x.includes("1 incomplete")));
});

test("market status honors actual intervals, date, holidays, and early closing", () => {
  assert.equal(regularMarketOpen(hours, now), true);
  assert.equal(
    regularMarketOpen(hours, Date.parse("2026-11-25T13:00:00Z")),
    false,
  );
  assert.equal(
    regularMarketOpen(hours, Date.parse("2026-11-25T21:00:00Z")),
    false,
  );
  assert.equal(regularMarketOpen(hours, now + 86_400_000), false);
  assert.equal(
    regularMarketOpen(
      { equity: { EQ: { date: "2026-11-25", isOpen: false } } },
      now,
    ),
    false,
  );
  assert.equal(
    regularMarketOpen(
      {
        equity: {
          EQ: {
            ...hours.equity.EQ,
            sessionHours: {
              regularMarket: [
                {
                  start: "2026-11-25T09:30:00-05:00",
                  end: "2026-11-25T10:00:00-05:00",
                },
              ],
            },
          },
        },
      },
      now,
    ),
    false,
  );
});

test("provider normalizes responses, bounds option scope, and caches daily references", async () => {
  const calls: { path: string; params: Record<string, string> }[] = [];
  const provider = new SchwabProvider(
    async (path, params) => {
      calls.push({ path, params });
      if (path === "/quotes") return { XYZ: quote };
      if (path === "/markets") return hours;
      if (path === "/chains") return chain;
      return { candles: [candle] };
    },
    () => now,
  );
  const result = await provider.snapshot(["XYZ"]);
  assert.equal(result.mode, "schwab");
  assert.equal(result.marketOpen, true);
  assert.equal(result.symbols[0].options.length, 1);
  assert.equal(
    calls.find((x) => x.path === "/chains")?.params.strikeCount,
    "20",
  );
  assert.equal(
    calls.find((x) => x.path === "/chains")?.params.toDate,
    "2027-01-24",
  );
  assert.equal(
    calls.find((x) => x.params.frequencyType === "minute")?.params
      .needExtendedHoursData,
    "false",
  );
  await provider.snapshot(["XYZ"]);
  assert.equal(
    calls.filter((x) => x.params.frequencyType === "daily").length,
    1,
  );
});

test("partial failures are explicit and missing hours suppress live activity", async () => {
  const provider = new SchwabProvider(
    async (path) => {
      if (path === "/quotes") return { XYZ: quote };
      throw new Error("secret-bearing provider body must not leak");
    },
    () => now,
  );
  const result = await provider.snapshot(["XYZ", "MISSING"]);
  assert.equal(result.marketOpen, false);
  assert.equal(result.symbols.length, 1);
  assert.deepEqual(result.symbols[0].minuteBars, []);
  assert(result.warnings.some((x) => x.includes("MISSING")));
  assert(result.warnings.some((x) => x.includes("Market-session")));
  assert(!JSON.stringify(result).includes("secret-bearing"));
});

test("snapshot completion time is fresh and a scan crossing market close is marked closed", async () => {
  const started = Date.parse("2026-11-25T20:59:50Z");
  const finished = Date.parse("2026-11-25T21:00:10Z");
  let clock = started;
  const provider = new SchwabProvider(
    async (path, params) => {
      if (path === "/quotes")
        return {
          XYZ: { ...quote, quote: { ...quote.quote, quoteTime: started } },
        };
      if (path === "/markets") return hours;
      if (path === "/chains") {
        clock = finished;
        return chain;
      }
      if (params.frequencyType === "minute")
        assert.equal(params.endDate, String(started));
      return { candles: [candle] };
    },
    () => clock,
  );
  const result = await provider.snapshot(["XYZ"]);
  assert.equal(result.asOf, finished);
  assert.equal(result.marketOpen, false);
  assert.equal(result.symbols[0].quote.timestamp, started);
  assert.equal(result.symbols[0].options[0].timestamp, now);
});

test("global quote failures and empty valid coverage fail rather than synthesize live data", async () => {
  await assert.rejects(
    new SchwabProvider(async () => {
      throw new Error("quote failure");
    }).snapshot(["XYZ"]),
    /quote failure/,
  );
  await assert.rejects(
    new SchwabProvider(async () => ({})).snapshot(["XYZ"]),
    /no complete equity quotes/,
  );
  await assert.rejects(
    new SchwabProvider(async () => ({})).snapshot([]),
    /one and twelve/,
  );
});
