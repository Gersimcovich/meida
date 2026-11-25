import test from "node:test";
import assert from "node:assert/strict";
import { demoSnapshot, DEMO_AS_OF, DEMO_SYMBOLS } from "../shared/demo.js";
import { scanMarket } from "../shared/signals.js";
import {
  DEFAULT_RULES,
  type MarketSnapshot,
  type Rules,
} from "../shared/types.js";

const fixture = demoSnapshot(["NVDA", "AMD"]);
const fresh = () => structuredClone(fixture);
const only = (rule: string): Rules => ({ ...DEFAULT_RULES, enabled: [rule] });
const run = (snapshot: MarketSnapshot, rule?: string) =>
  scanMarket(snapshot, rule ? only(rule) : DEFAULT_RULES);

test("synthetic replay is deterministic, explicit, and respects supported watchlist symbols", () => {
  const snapshot = demoSnapshot(DEMO_SYMBOLS);
  const result = run(snapshot);
  assert.ok(result.signals.length >= 8);
  assert.ok(result.signals.some((signal) => signal.horizon === "intraday"));
  assert.ok(result.signals.some((signal) => signal.horizon === "swing"));
  assert.deepEqual(run(demoSnapshot(DEMO_SYMBOLS)), result);
  assert.ok(result.warnings[0].includes("Synthetic demo replay"));
  const unsupported = demoSnapshot(["XYZ", "NVDA", "NVDA"]);
  assert.deepEqual(
    unsupported.symbols.map((item) => item.quote.symbol),
    ["NVDA"],
  );
  assert.ok(unsupported.warnings.some((warning) => warning.includes("XYZ")));
});

test("RVOL uses completed, same-time regular-session candle volume", () => {
  const snapshot = fresh();
  const before = run(snapshot, "relative-volume");
  const nvda = before.signals.find((signal) => signal.symbol === "NVDA")!;
  assert.equal(
    nvda.evidence.find((item) => item.label === "Relative volume")!.value,
    "3.42×",
  );
  const item = snapshot.symbols[0];
  item.quote.volume = 9_999_999_999;
  const last = item.minuteBars.at(-1)!;
  item.minuteBars.push({ ...last, timestamp: DEMO_AS_OF, volume: 9_999_999 });
  item.minuteBars.push({
    ...last,
    timestamp: Date.parse("2026-11-24T13:00:00Z"),
    volume: 9_999_999,
  });
  assert.deepEqual(run(snapshot, "relative-volume").signals, before.signals);
});

test("duplicate candles do not inflate volume and incomplete baselines are rejected", () => {
  const snapshot = fresh();
  const expected = run(snapshot, "relative-volume");
  snapshot.symbols[0].minuteBars.push(
    ...snapshot.symbols[0].minuteBars.slice(0, 500),
  );
  assert.deepEqual(run(snapshot, "relative-volume").signals, expected.signals);
  // Keep only four complete previous sessions: insufficient even with full current data.
  snapshot.symbols[0].minuteBars = snapshot.symbols[0].minuteBars.filter(
    (bar) => bar.timestamp >= Date.parse("2026-11-18T14:30:00Z"),
  );
  const result = run(snapshot, "relative-volume");
  assert.ok(!result.signals.some((signal) => signal.symbol === "NVDA"));
  assert.ok(
    result.warnings.some((warning) => warning.startsWith("NVDA: RVOL needs")),
  );
});

test("missing current candle suppresses volume-based rules rather than guessing coverage", () => {
  const snapshot = fresh();
  snapshot.symbols[0].minuteBars = snapshot.symbols[0].minuteBars.filter(
    (bar) => bar.timestamp !== Date.parse("2026-11-24T16:01:00Z"),
  );
  const result = run(snapshot);
  assert.ok(
    !result.signals.some(
      (signal) => signal.symbol === "NVDA" && signal.asset === "stock",
    ),
  );
  assert.ok(
    result.signals.some(
      (signal) => signal.symbol === "NVDA" && signal.asset === "option",
    ),
  );
});

test("stale, delayed, future, and invalid equity quotes never become alerts", () => {
  for (const change of [
    { timestamp: DEMO_AS_OF - 120_001 },
    { delayed: true },
    { timestamp: DEMO_AS_OF + 5_001 },
    { last: 0 },
    { last: NaN },
  ]) {
    const snapshot = fresh();
    Object.assign(snapshot.symbols[0].quote, change);
    assert.ok(
      !run(snapshot).signals.some((signal) => signal.symbol === "NVDA"),
    );
  }
});

test("stock alerts require a valid two-sided book; options keep their own liquidity checks", () => {
  for (const change of [
    { bid: 0 },
    { ask: 0 },
    { bid: NaN },
    { bid: 188, ask: 186 },
  ]) {
    const snapshot = fresh();
    Object.assign(snapshot.symbols[0].quote, change);
    const result = run(snapshot);
    assert.ok(
      !result.signals.some(
        (signal) => signal.symbol === "NVDA" && signal.asset === "stock",
      ),
    );
    assert.ok(
      result.signals.some(
        (signal) => signal.symbol === "NVDA" && signal.asset === "option",
      ),
    );
    assert.ok(
      result.warnings.some((warning) =>
        warning.includes("missing or crossed equity bid/ask"),
      ),
    );
  }
});

test("closed or out-of-session snapshots never create fresh signals", () => {
  const snapshot = fresh();
  snapshot.marketOpen = false;
  assert.equal(run(snapshot).signals.length, 0);
  snapshot.marketOpen = true;
  snapshot.asOf = Date.parse("2026-11-24T22:00:00Z");
  assert.equal(run(snapshot).signals.length, 0);
  snapshot.asOf = NaN;
  assert.equal(run(snapshot).signals.length, 0);
});

test("options volume / open interest is neutral activity, never a directional interpretation", () => {
  const snapshot = fresh();
  snapshot.symbols[0].options[0].type = "PUT";
  const result = run(snapshot, "option-activity");
  assert.ok(result.signals.length > 0);
  assert.ok(result.signals.every((signal) => signal.direction === "neutral"));
  assert.equal(
    result.signals.find((signal) => signal.symbol === "NVDA")!.changePercent,
    snapshot.symbols[0].quote.changePercent,
  );
  assert.ok(
    result.signals[0].cautions.some((caution) =>
      caution.includes("does not prove opening trades"),
    ),
  );
  assert.ok(result.signals.every((signal) => signal.strength < 100));
});

test("option signal requires meaningful OI, volume, fresh quotes, acceptable spread and DTE", () => {
  for (const change of [
    { openInterest: 0 },
    { openInterest: 99 },
    { openInterest: NaN },
    { volume: 499 },
    { volume: 1000, openInterest: 800 },
    { bid: 4, ask: 3 },
    { bid: 0 },
    { bid: 1, ask: 5 },
    { timestamp: DEMO_AS_OF - 120_001 },
    { timestamp: DEMO_AS_OF + 60_000 },
    { delayed: true },
    { expiration: "2026-11-24" },
    { expiration: "2027-12-31" },
    { expiration: "2026-11-31" },
  ]) {
    const snapshot = fresh();
    Object.assign(snapshot.symbols[0].options[0], change);
    assert.ok(
      !run(snapshot, "option-activity").signals.some(
        (signal) => signal.symbol === "NVDA",
      ),
      JSON.stringify(change),
    );
  }
});

test("swing reference excludes current session and requires 20 completed sessions", () => {
  const snapshot = fresh();
  const expected = run(snapshot, "swing-breakout").signals;
  assert.ok(expected.length > 0);
  snapshot.symbols[0].dailyBars.push({
    timestamp: Date.parse("2026-11-24T16:00:00Z"),
    open: 186,
    high: 9999,
    low: 1,
    close: 186,
    volume: 99_999_999,
  });
  assert.deepEqual(run(snapshot, "swing-breakout").signals, expected);
  snapshot.symbols[0].dailyBars = snapshot.symbols[0].dailyBars.slice(-19);
  assert.ok(
    !run(snapshot, "swing-breakout").signals.some(
      (signal) => signal.symbol === "NVDA",
    ),
  );
});

test("the same exchange-local minute in summer gives the same RVOL as winter", () => {
  const snapshot = fresh();
  const before = run(snapshot, "relative-volume").signals[0].evidence;
  const offset = Date.parse("2026-07-14T18:10:00Z") - DEMO_AS_OF;
  snapshot.asOf += offset;
  for (const item of snapshot.symbols) {
    item.quote.timestamp += offset;
    for (const bar of item.minuteBars) bar.timestamp += offset;
    for (const bar of item.dailyBars) bar.timestamp += offset;
  }
  assert.deepEqual(
    run(snapshot, "relative-volume").signals[0].evidence,
    before,
  );
});

test("rules can be disabled and alert identities are stable and unique", () => {
  const snapshot = fresh();
  assert.equal(
    scanMarket(snapshot, { ...DEFAULT_RULES, enabled: [] }).signals.length,
    0,
  );
  const before = run(snapshot).signals.map((signal) => signal.id);
  snapshot.symbols.push(snapshot.symbols[0]);
  snapshot.symbols[0].options.push(snapshot.symbols[0].options[0]);
  const after = run(snapshot).signals.map((signal) => signal.id);
  assert.equal(new Set(after).size, after.length);
  assert.deepEqual(after, before);
});

test("every signal has conditional next steps with the same invalidation as its evidence", () => {
  const signals = run(demoSnapshot(DEMO_SYMBOLS)).signals;
  for (const signal of signals) {
    assert.ok(signal.plan.headline);
    assert.ok(signal.plan.trigger.includes("only if"));
    assert.equal(signal.plan.invalidation, signal.invalidation);
    assert.ok(
      signal.plan.steps.some((step) => step.includes("maximum dollar loss")),
    );
    assert.ok(
      signal.plan.steps.some((step) => step.includes("Check earnings")),
    );
    assert.ok(
      signal.plan.steps.some((step) =>
        step.includes("stop order can fill beyond"),
      ),
    );
    if (signal.direction === "bullish")
      assert.equal(signal.plan.action, "review-long");
    if (signal.direction === "bearish") {
      assert.equal(signal.plan.action, "review-short");
      assert.ok(
        signal.plan.steps.some((step) => step.includes("borrow availability")),
      );
    }
  }
});

test("unusual volume and call/put activity do not become directional trade calls", () => {
  const snapshot = fresh();
  const volume = run(snapshot, "relative-volume").signals;
  assert.ok(volume.every((signal) => signal.plan.action === "watch"));
  assert.ok(
    volume.every((signal) =>
      signal.plan.trigger.includes("separate, completed price breakout"),
    ),
  );
  for (const type of ["CALL", "PUT"] as const) {
    snapshot.symbols[0].options[0].type = type;
    const signal = run(snapshot, "option-activity").signals.find(
      (candidate) => candidate.symbol === "NVDA",
    )!;
    assert.equal(signal.plan.action, "review-activity");
    assert.equal(signal.direction, "neutral");
    assert.ok(signal.plan.trigger.includes("no buy or sell direction"));
  }
});

test("opening-range guidance uses the measured level rather than a fixed entry target", () => {
  const snapshot = demoSnapshot(["NVDA"]);
  const open = Date.parse("2026-11-24T14:30:00Z");
  for (const bar of snapshot.symbols[0].minuteBars) {
    if (bar.timestamp >= open && bar.timestamp < open + 15 * 60_000)
      bar.high = 185.33;
  }
  const signal = run(snapshot, "opening-breakout").signals[0];
  assert.equal(signal.plan.action, "review-long");
  assert.ok(
    signal.plan.trigger.includes(
      "new completed one-minute candle holds above $185.33",
    ),
  );
  assert.ok(signal.plan.invalidation.includes("below $185.33"));
  assert.ok(signal.plan.trigger.includes("entry quote is current and liquid"));
});

test("VWAP guidance uses the computed value and asks for an updated reference", () => {
  const signal = run(demoSnapshot(["AMD"]), "vwap-cross").signals[0];
  const measured = signal.evidence.find(
    (item) => item.label === "Approximate VWAP",
  )!.value;
  assert.equal(signal.plan.action, "review-long");
  assert.ok(signal.plan.trigger.includes(`currently ${measured}`));
  assert.ok(
    signal.plan.steps.some((step) =>
      step.includes("Recompute the session VWAP"),
    ),
  );
});

test("swing short guidance waits for the daily close and uses the prior-session low", () => {
  const snapshot = demoSnapshot(["TSLA"]);
  for (const bar of snapshot.symbols[0].dailyBars) bar.low = 348.5;
  const signal = run(snapshot, "swing-breakout").signals[0];
  assert.equal(signal.plan.action, "review-short");
  assert.ok(signal.plan.trigger.includes("session closes below $348.50"));
  assert.ok(
    signal.plan.trigger.includes("Daily-close confirmation is pending"),
  );
  assert.ok(signal.plan.invalidation.includes("above $348.50"));
  assert.ok(
    signal.plan.steps.some((step) =>
      step.includes("None are verified by this signal"),
    ),
  );
});
