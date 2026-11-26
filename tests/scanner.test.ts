import test from "node:test";
import assert from "node:assert/strict";
import { ScanCoordinator } from "../server/scanner.ts";
import { ProviderError } from "../server/auth.ts";
import { Store } from "../server/store.ts";
import type { ConnectionStatus, MarketSnapshot } from "../shared/types.ts";

function fixture(
  fetchSnapshot: (symbols: string[]) => Promise<MarketSnapshot> = async () =>
    emptySnapshot(),
) {
  const store = new Store(":memory:");
  let clock = 0;
  const auth = {
    connected: true,
    revision: 0,
    status(): ConnectionStatus {
      return {
        configured: true,
        connected: this.connected,
        reconnectRequired: !this.connected,
        callbackUrl: "https://example.invalid/api/auth/schwab/callback",
        message: "Test connection",
      };
    },
  };
  let providerCalls = 0;
  const coordinator = new ScanCoordinator(
    {
      store,
      auth,
      provider: {
        snapshot(symbols) {
          providerCalls++;
          return fetchSnapshot(symbols);
        },
      },
    },
    () => clock,
  );
  return {
    store,
    auth,
    coordinator,
    calls: () => providerCalls,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
}

function emptySnapshot(): MarketSnapshot {
  return {
    mode: "schwab",
    asOf: Date.parse("2026-11-24T19:10:00Z"),
    marketOpen: false,
    symbols: [],
    warnings: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const status = (expected: number) => (error: unknown) =>
  error instanceof ProviderError && error.status === expected;

test("demo scans need no connection, never call Schwab, and preserve selected source", async () => {
  const f = fixture();
  try {
    f.auth.connected = false;
    f.store.set("mode", "schwab");
    f.store.set("watchlist", ["NVDA"]);
    const result = await f.coordinator.run("demo");
    assert.equal(result.mode, "demo");
    assert.ok(result.signals.length > 0);
    assert.equal(f.calls(), 0);
    assert.equal(f.store.mode, "schwab");
    assert.deepEqual(f.store.get("lastScan:demo", null), result);
  } finally {
    f.store.close();
  }
});

test("live scans fail closed when disconnected without consuming cooldown", async () => {
  const f = fixture();
  try {
    f.auth.connected = false;
    await assert.rejects(f.coordinator.run("schwab"), status(401));
    assert.equal(f.calls(), 0);
    assert.equal(f.store.get("lastScan:schwab", null), null);
    f.auth.connected = true;
    const result = await f.coordinator.run("schwab");
    assert.equal(result.mode, "schwab");
    assert.equal(f.calls(), 1);
    assert.equal(f.store.mode, "demo");
    assert.deepEqual(f.store.get("lastScan:schwab", null), result);
  } finally {
    f.store.close();
  }
});

test("all callers share one lock and a 30-second live cooldown", async () => {
  const pending = deferred<MarketSnapshot>();
  const f = fixture(() => pending.promise);
  try {
    const first = f.coordinator.run("schwab");
    await assert.rejects(f.coordinator.run("schwab"), status(409));
    await assert.rejects(f.coordinator.run("demo"), status(409));
    assert.equal(f.calls(), 1);
    pending.resolve(emptySnapshot());
    await first;
    f.advance(29_999);
    await assert.rejects(f.coordinator.run("schwab"), status(429));
    f.advance(1);
    await f.coordinator.run("schwab");
    assert.equal(f.calls(), 2);
  } finally {
    f.store.close();
  }
});

test("settings invalidation discards in-flight results and releases the lock", async () => {
  const pending = deferred<MarketSnapshot>();
  const f = fixture(() => pending.promise);
  try {
    const first = f.coordinator.run("schwab");
    assert.equal(f.coordinator.revision, 0);
    f.coordinator.invalidate();
    f.store.set("watchlist", ["IBM"]);
    assert.equal(f.coordinator.revision, 1);
    pending.resolve(emptySnapshot());
    await assert.rejects(first, status(409));
    assert.equal(f.store.get("lastScan:schwab", null), null);
    f.advance(30_000);
    await f.coordinator.run("schwab");
  } finally {
    f.store.close();
  }
});

test("disconnect or reauthorization during a scan discards its result", async () => {
  for (const mutation of ["disconnect", "revision"] as const) {
    const pending = deferred<MarketSnapshot>();
    const f = fixture(() => pending.promise);
    try {
      const first = f.coordinator.run("schwab");
      if (mutation === "disconnect") f.auth.connected = false;
      else f.auth.revision++;
      pending.resolve(emptySnapshot());
      await assert.rejects(first, status(409));
      assert.equal(f.store.get("lastScan:schwab", null), null);
    } finally {
      f.store.close();
    }
  }
});

test("provider failures release the lock but retain live-request cooldown", async () => {
  let fail = true;
  const f = fixture(async () => {
    if (fail) throw new ProviderError("Schwab unavailable", 502);
    return emptySnapshot();
  });
  try {
    await assert.rejects(f.coordinator.run("schwab"), status(502));
    await assert.rejects(f.coordinator.run("schwab"), status(429));
    assert.equal(f.store.get("lastScan:schwab", null), null);
    fail = false;
    f.advance(30_000);
    await f.coordinator.run("schwab");
    assert.equal(f.calls(), 2);
  } finally {
    f.store.close();
  }
});

test("a live provider cannot persist demo data under a requested live scan", async () => {
  const f = fixture(async () => ({ ...emptySnapshot(), mode: "demo" }));
  try {
    await assert.rejects(f.coordinator.run("schwab"), status(502));
    assert.equal(f.store.get("lastScan:schwab", null), null);
    assert.equal(f.store.get("lastScan:demo", null), null);
  } finally {
    f.store.close();
  }
});
