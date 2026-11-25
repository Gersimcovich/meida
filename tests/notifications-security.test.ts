import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../server/config.ts";
import { Store } from "../server/store.ts";
import { SchwabAuth, encryptToken } from "../server/auth.ts";
import { ScanCoordinator } from "../server/scanner.ts";
import { TelegramNotifications } from "../server/notifications.ts";
import { createApp } from "../server/app.ts";
import { TelegramError, type TelegramUpdate } from "../server/telegram.ts";
import { demoSnapshot } from "../shared/demo.ts";
import { scanMarket } from "../shared/signals.ts";
import { DEFAULT_RULES, type ScanResult } from "../shared/types.ts";

const password = "notification-security-test-password";
const fakeToken = `123456:${"a".repeat(30)}`;
const pairingCode = "b".repeat(48);
const chatId = "123456789";
const base = "/api/notifications/telegram";
const mutations: [string, string, unknown][] = [
  [`${base}/configure`, "POST", { token: fakeToken }],
  [`${base}/pair`, "POST", {}],
  [`${base}/confirm`, "POST", {}],
  [base, "PUT", { enabled: false, horizon: "all" }],
  [`${base}/test`, "POST", {}],
  [base, "DELETE", {}],
];

async function fixture() {
  const config = loadConfig({
    HOST: "0.0.0.0",
    APP_ORIGIN: "https://meida.example",
    OWNER_PASSWORD: password,
    TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  });
  const store = new Store(":memory:");
  const auth = new SchwabAuth(config, store);
  let calls = 0;
  const provider = {
    snapshot: async (): Promise<never> => {
      throw new Error("Unexpected provider access");
    },
  };
  const scanner = new ScanCoordinator({ store, auth, provider });
  const unexpected = async (): Promise<never> => {
    calls++;
    throw new Error("Unexpected Telegram access");
  };
  const notifications = new TelegramNotifications({
    config,
    store,
    auth,
    scanner,
    client: () => ({
      getMe: unexpected,
      assertPollingAvailable: unexpected,
      getUpdates: unexpected,
      sendMessage: unexpected,
    }),
  });
  const server = createServer(
    createApp({ config, store, auth, provider, scanner, notifications }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{
      status: number;
      body: any;
      headers: import("node:http").IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: address.port,
          path,
          method,
          headers: {
            Host: "meida.example",
            Origin: config.origin,
            "Content-Type": "application/json",
            ...headers,
          },
        },
        (response) => {
          let data = "";
          response.on("data", (chunk) => {
            data += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode || 0,
              body: JSON.parse(data),
              headers: response.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  const login = async () => {
    const response = await request("/api/login", "POST", { password });
    assert.equal(response.status, 200);
    const cookie = response.headers["set-cookie"]?.find((value) =>
      value.startsWith("meida_owner="),
    );
    assert.ok(cookie);
    return cookie.split(";")[0];
  };
  const seed = (paired: boolean) =>
    store.set(
      "telegramConnection",
      encryptToken(
        {
          token: fakeToken,
          username: "MeidaTestBot",
          chatId: paired ? chatId : null,
          pairing: paired
            ? null
            : { code: pairingCode, expiresAt: Date.now() + 600_000 },
        },
        config.encryptionKey,
      ),
    );
  const close = async () => {
    await notifications.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  };
  return { request, login, seed, close, store, calls: () => calls };
}

test("Telegram status and every mutation require the hosted owner session", async () => {
  const f = await fixture();
  try {
    f.seed(false);
    for (const [path, method, body] of [
      [base, "GET", undefined],
      ...mutations,
    ] as [string, string, unknown][]) {
      const response = await f.request(path, method, body);
      assert.equal(response.status, 401, `${method} ${path}`);
      assert.equal(response.body.code, "OWNER_AUTH_REQUIRED");
      for (const privateValue of [fakeToken, pairingCode, chatId])
        assert.ok(!JSON.stringify(response.body).includes(privateValue));
    }
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});

test("Telegram mutations reject foreign or missing origins even with an owner cookie", async () => {
  const f = await fixture();
  try {
    f.seed(true);
    const Cookie = await f.login();
    const before = f.store.get("telegramConnection", null);
    for (const [path, method, body] of mutations)
      for (const Origin of ["https://attacker.example", ""]) {
        assert.equal(
          (await f.request(path, method, body, { Cookie, Origin })).status,
          403,
          `${method} ${path}`,
        );
      }
    assert.equal(
      (
        await f.request(base, "GET", undefined, {
          Cookie,
          Host: "attacker.example",
        })
      ).status,
      403,
    );
    assert.equal(f.store.get("telegramConnection", null), before);
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});

test("authenticated Telegram status masks chat identity and never returns the bot token", async () => {
  const f = await fixture();
  try {
    const Cookie = await f.login();
    f.seed(true);
    const response = await f.request(base, "GET", undefined, { Cookie });
    assert.equal(response.status, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.body.chatLabel, "Private chat •••6789");
    assert.equal(response.body.pairingUrl, null);
    for (const privateValue of [fakeToken, chatId])
      assert.ok(!JSON.stringify(response.body).includes(privateValue));
    f.seed(false);
    const pairing = await f.request(base, "GET", undefined, { Cookie });
    assert.equal(
      pairing.body.pairingUrl,
      `https://t.me/MeidaTestBot?start=${pairingCode}`,
    );
    assert.ok(!JSON.stringify(pairing.body).includes(fakeToken));
    const invalid = await f.request(
      `${base}/configure`,
      "POST",
      { token: "a-private-invalid-token-do-not-reflect" },
      { Cookie },
    );
    assert.equal(invalid.status, 400);
    assert.ok(
      !JSON.stringify(invalid.body).includes(
        "a-private-invalid-token-do-not-reflect",
      ),
    );
    assert.equal(f.calls(), 0);
  } finally {
    await f.close();
  }
});

function workerFixture() {
  let now = Date.parse("2026-11-27T17:59:50Z");
  const store = new Store(":memory:");
  const config = loadConfig({ TOKEN_ENCRYPTION_KEY: "ab".repeat(32) });
  store.set("mode", "schwab");
  store.set(
    "telegramConnection",
    encryptToken(
      { token: fakeToken, username: "MeidaTestBot", chatId, pairing: null },
      config.encryptionKey,
    ),
  );
  store.set("telegramPreferences", { enabled: true, horizon: "all" });
  let updates: TelegramUpdate[] = [];
  let send: (() => Promise<void>) | null = null;
  let sends = 0;
  const original = scanMarket(demoSnapshot(["NVDA"]), DEFAULT_RULES);
  const result: ScanResult = {
    ...original,
    mode: "schwab",
    asOf: now,
    marketOpen: true,
    signals: original.signals
      .slice(0, 3)
      .map((signal) => ({ ...signal, mode: "schwab", timestamp: now })),
  };
  const auth = {
    revision: 0,
    status: () => ({
      configured: true,
      connected: true,
      reconnectRequired: false,
      callbackUrl: "",
      message: "",
    }),
    marketData: async () => ({
      equity: {
        EQ: {
          date: "2026-11-27",
          isOpen: true,
          sessionHours: {
            regularMarket: [
              {
                start: "2026-11-27T09:30:00-05:00",
                end: "2026-11-27T13:00:00-05:00",
              },
            ],
          },
        },
      },
    }),
  };
  const scanner = { revision: 0, run: async () => structuredClone(result) };
  const client = {
    getMe: async () => ({ id: 654321, username: "MeidaNewBot" }),
    assertPollingAvailable: async () => {},
    getUpdates: async () => updates,
    sendMessage: async () => {
      sends++;
      await send?.();
    },
  };
  const make = () =>
    new TelegramNotifications({
      config,
      store,
      auth,
      scanner,
      client: () => client,
      now: () => now,
    });
  const service = make();
  return {
    service,
    store,
    make,
    result,
    sends: () => sends,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    refresh: () => {
      result.asOf = now;
      result.signals.forEach((signal) => {
        signal.timestamp = now;
      });
    },
    setUpdates: (value: TelegramUpdate[]) => {
      updates = value;
    },
    onSend: (callback: (() => Promise<void>) | null) => {
      send = callback;
    },
    setTime: (value: string) => {
      now = Date.parse(value);
    },
    close: () => store.close(),
  };
}

test("queued live signals cannot be sent after an official early market close", async () => {
  const f = workerFixture();
  try {
    assert.ok(f.result.signals.length > 1);
    await f.service.tick();
    assert.equal(f.sends(), 1);
    f.advance(20_000); // 13:00:10 ET, inside generic weekday hours but beyond the official session.
    await f.service.tick();
    assert.equal(f.sends(), 1);
  } finally {
    f.close();
  }
});

test("an old bot delivery failure cannot disable or overwrite a newly paired destination", async () => {
  const f = workerFixture();
  let failSend!: (reason: Error) => void;
  let entered!: () => void;
  const sending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.onSend(() => {
    entered();
    return new Promise<void>((_resolve, reject) => {
      failSend = reject;
    });
  });
  try {
    const pending = f.service.tick();
    await sending;
    const status = await f.service.configure(`654321:${"z".repeat(30)}`);
    const code = new URL(status.pairingUrl!).searchParams.get("start")!;
    f.setUpdates([
      {
        update_id: 1,
        message: {
          text: `/start ${code}`,
          chat: { id: 987654321, type: "private" },
          from: { id: 987654321, is_bot: false },
        },
      },
    ]);
    await f.service.confirm();
    f.service.setPreferences({ enabled: true, horizon: "swing" });
    failSend(new TelegramError("authentication"));
    await pending;
    const current = f.service.status();
    assert.equal(current.enabled, true);
    assert.equal(current.horizon, "swing");
    assert.equal(current.botUsername, "MeidaNewBot");
    assert.equal(current.chatLabel, "Private chat •••4321");
    assert.equal(current.lastError, null);
  } finally {
    f.close();
  }
});

test("Telegram retry-after survives process restart before a retry becomes eligible", async () => {
  const f = workerFixture();
  try {
    f.setTime("2026-11-27T16:00:00Z");
    f.refresh();
    f.result.signals = f.result.signals.slice(0, 1);
    f.onSend(async () => {
      throw new TelegramError("rate_limit", 90);
    });
    await f.service.tick();
    assert.equal(f.sends(), 1);
    f.onSend(null);
    f.advance(20_000);
    f.refresh();
    const restarted = f.make();
    await restarted.tick();
    assert.equal(f.sends(), 1);
    f.advance(80_000);
    f.refresh();
    await restarted.tick();
    assert.equal(f.sends(), 2);
  } finally {
    f.close();
  }
});
