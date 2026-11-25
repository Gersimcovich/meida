import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../server/store.ts";
import { loadConfig } from "../server/config.ts";
import { TelegramNotifications } from "../server/notifications.ts";
import { TelegramError, type TelegramUpdate } from "../server/telegram.ts";
import { demoSnapshot } from "../shared/demo.ts";
import { scanMarket } from "../shared/signals.ts";
import { DEFAULT_RULES, type ScanResult } from "../shared/types.ts";

const token = "123456789:abcdefghijklmnopqrstuvwxyz_123456789";
function fixture() {
  let time = Date.parse("2026-11-25T15:00:00Z");
  const store = new Store(":memory:");
  const config = loadConfig({ TOKEN_ENCRYPTION_KEY: "ab".repeat(32) });
  let updates: TelegramUpdate[] = [];
  const sent: { chat: string; text: string }[] = [];
  let sendError: Error | null = null;
  let getUpdatesHook: (() => Promise<void>) | null = null;
  let scans = 0,
    hoursChecks = 0;
  let open = true,
    connected = true;
  const original = scanMarket(demoSnapshot(["NVDA"]), DEFAULT_RULES);
  let result: ScanResult = {
    ...original,
    mode: "schwab",
    marketOpen: true,
    asOf: time,
    signals: original.signals
      .slice(0, 4)
      .map((s) => ({ ...s, mode: "schwab", timestamp: time })),
  };
  const auth = {
    revision: 0,
    status: () => ({
      configured: true,
      connected,
      reconnectRequired: false,
      callbackUrl: "",
      message: "",
    }),
    marketData: async () => {
      hoursChecks++;
      return {
        equity: {
          EQ: {
            date: "2026-11-25",
            isOpen: open,
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
    },
  };
  const scanner = {
    revision: 0,
    run: async () => {
      scans++;
      return structuredClone(result);
    },
  };
  const client = {
    getMe: async () => ({ id: 123456789, username: "MeidaTestBot" }),
    assertPollingAvailable: async () => {},
    getUpdates: async () => {
      await getUpdatesHook?.();
      return updates;
    },
    sendMessage: async (chat: string, text: string) => {
      sent.push({ chat, text });
      if (sendError) throw sendError;
    },
  };
  const make = () =>
    new TelegramNotifications({
      config,
      store,
      auth,
      scanner,
      client: () => client,
      now: () => time,
    });
  const service = make();
  const pairingUpdate = (code: string, chat = 432100001): TelegramUpdate => ({
    update_id: 1,
    message: {
      text: `/start ${code}`,
      chat: { id: chat, type: "private" },
      from: { id: chat, is_bot: false },
    },
  });
  const pair = async () => {
    const state = await service.configure(token);
    const code = new URL(state.pairingUrl!).searchParams.get("start")!;
    updates = [pairingUpdate(code)];
    await service.confirm();
    store.set("mode", "schwab");
    service.setPreferences({ enabled: true, horizon: "all" });
  };
  return {
    store,
    config,
    service,
    make,
    client,
    auth,
    scanner,
    sent,
    pair,
    pairingUpdate,
    setUpdates: (value: TelegramUpdate[]) => {
      updates = value;
    },
    setUpdateHook: (value: (() => Promise<void>) | null) => {
      getUpdatesHook = value;
    },
    advance: (ms: number) => {
      time += ms;
    },
    refresh: () => {
      result.asOf = time;
      result.signals.forEach((s) => {
        s.timestamp = time;
      });
    },
    setTime: (value: string) => {
      time = Date.parse(value);
    },
    setOpen: (value: boolean) => {
      open = value;
    },
    setConnected: (value: boolean) => {
      connected = value;
    },
    setSendError: (value: Error | null) => {
      sendError = value;
    },
    result: () => result,
    scans: () => scans,
    hoursChecks: () => hoursChecks,
    close: () => store.close(),
  };
}

test("Telegram configuration is encrypted and never returns the bot token or full chat ID", async () => {
  const f = fixture();
  try {
    await f.pair();
    assert.equal(f.service.status().paired, true);
    assert.equal(f.service.status().chatLabel, "Private chat •••0001");
    assert.ok(!JSON.stringify(f.service.status()).includes(token));
    assert.ok(!JSON.stringify(f.service.status()).includes("432100001"));
    assert.ok(!f.store.get<string>("telegramConnection", "").includes(token));
    assert.equal(f.make().status().paired, true);
    assert.equal(f.service.status().pairingUrl, null);
  } finally {
    f.close();
  }
});

test("pairing ignores wrong code, group chats and another sender, and expires after ten minutes", async () => {
  const f = fixture();
  try {
    const status = await f.service.configure(token);
    const code = new URL(status.pairingUrl!).searchParams.get("start")!;
    const group = f.pairingUpdate(code);
    group.message!.chat.type = "group";
    const wrongSender = f.pairingUpdate(code);
    wrongSender.message!.from!.id++;
    f.setUpdates([f.pairingUpdate("incorrect"), group, wrongSender]);
    await assert.rejects(f.service.confirm(), /No matching/);
    assert.equal(f.service.status().paired, false);
    f.advance(600_001);
    f.setUpdates([f.pairingUpdate(code)]);
    await assert.rejects(f.service.confirm(), /expired/);
    assert.equal(f.service.status().pairingUrl, null);
  } finally {
    f.close();
  }
});

test("disconnect during pairing cannot restore a saved destination", async () => {
  const f = fixture();
  try {
    const status = await f.service.configure(token);
    const code = new URL(status.pairingUrl!).searchParams.get("start")!;
    f.setUpdates([f.pairingUpdate(code)]);
    f.setUpdateHook(async () => {
      f.service.disconnect();
    });
    await assert.rejects(f.service.confirm(), /changed/);
    assert.equal(f.service.status().configured, false);
  } finally {
    f.close();
  }
});

test("disabled, demo, disconnected, weekends and closed official sessions never scan or send", async () => {
  const f = fixture();
  try {
    await f.service.tick();
    assert.equal(f.hoursChecks(), 0);
    await f.pair();
    f.store.set("mode", "demo");
    await f.service.tick();
    f.store.set("mode", "schwab");
    f.setConnected(false);
    await f.service.tick();
    f.setConnected(true);
    f.setTime("2026-11-28T15:00:00Z");
    await f.service.tick();
    assert.equal(f.hoursChecks(), 0);
    f.setTime("2026-11-25T15:00:00Z");
    f.setOpen(false);
    await f.service.tick();
    assert.equal(f.hoursChecks(), 1);
    assert.equal(f.scans(), 0);
    assert.equal(f.sent.length, 0);
  } finally {
    f.close();
  }
});

test("worker scans once per minute, limits sends and persists per-direction duplicate suppression across restart", async () => {
  const f = fixture();
  try {
    await f.pair();
    assert.ok(f.result().signals.length > 1);
    await f.service.tick();
    await f.service.tick();
    assert.equal(f.scans(), 1);
    assert.equal(f.sent.length, 1);
    f.advance(20_000);
    await f.service.tick();
    assert.equal(f.scans(), 1);
    assert.equal(f.sent.length, 2);
    f.advance(20_000);
    await f.service.tick();
    assert.equal(f.scans(), 1);
    assert.ok(f.sent.length <= 3);
    const count = f.sent.length;
    const restarted = f.make();
    f.advance(20_000);
    f.refresh();
    await restarted.tick();
    const before = f.sent.length;
    assert.ok(before <= count + 1);
    f.advance(60_000);
    f.refresh();
    await restarted.tick();
    assert.equal(
      new Set(f.sent.map((m) => m.text.split("Observed")[0])).size,
      f.sent.length,
    );
    assert.equal(
      f.sent.every((m) => m.chat === "432100001"),
      true,
    );
    assert.ok(f.store.get<Record<string, unknown>>("telegramReceipts", {}));
  } finally {
    f.close();
  }
});

test("stale and demo scan payloads cannot be delivered, including after a queued tick", async () => {
  for (const invalid of ["stale", "demo", "closed"] as const) {
    const f = fixture();
    try {
      await f.pair();
      if (invalid === "stale") f.result().asOf -= 121_000;
      if (invalid === "demo") f.result().mode = "demo";
      if (invalid === "closed") f.result().marketOpen = false;
      await f.service.tick();
      assert.equal(f.sent.length, 0, invalid);
    } finally {
      f.close();
    }
  }
});

test("rule/source changes and disabling invalidate queued signals", async () => {
  const f = fixture();
  try {
    await f.pair();
    await f.service.tick();
    f.scanner.revision++;
    f.advance(20_000);
    await f.service.tick();
    assert.equal(f.sent.length, 1);
    f.service.setPreferences({ enabled: false, horizon: "all" });
    f.advance(60_000);
    f.refresh();
    await f.service.tick();
    assert.equal(f.sent.length, 1);
  } finally {
    f.close();
  }
});

test("429 observes retry delay; uncertain delivery is recorded and not replayed", async () => {
  const f = fixture();
  try {
    await f.pair();
    f.result().signals = f.result().signals.slice(0, 1);
    f.setSendError(new TelegramError("rate_limit", 90));
    await f.service.tick();
    assert.equal(f.sent.length, 1);
    f.setSendError(null);
    f.advance(60_000);
    f.refresh();
    await f.service.tick();
    assert.equal(f.sent.length, 1);
    f.advance(40_000);
    f.refresh();
    await f.service.tick();
    assert.equal(f.sent.length, 2);
    f.result().signals[0].direction =
      f.result().signals[0].direction === "bullish" ? "bearish" : "bullish";
    f.setSendError(new TelegramError("network"));
    f.advance(60_000);
    f.refresh();
    await f.service.tick();
    assert.equal(f.sent.length, 3);
    f.setSendError(null);
    f.advance(60_000);
    f.refresh();
    await f.make().tick();
    assert.equal(f.sent.length, 3);
  } finally {
    f.close();
  }
});

test("test messages require pairing, are explicitly labeled, and are rate limited", async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.test(), /Pair/);
    await f.pair();
    await f.service.test();
    assert.match(f.sent[0].text, /setup test, not a market signal/);
    await assert.rejects(f.service.test(), /Wait/);
  } finally {
    f.close();
  }
});
