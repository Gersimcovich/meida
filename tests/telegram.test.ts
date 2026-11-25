import test from "node:test";
import assert from "node:assert/strict";
import {
  TelegramClient,
  TelegramError,
  formatAlert,
} from "../server/telegram.js";
import { demoSnapshot } from "../shared/demo.js";
import { scanMarket } from "../shared/signals.js";
import { DEFAULT_RULES, type Signal } from "../shared/types.js";

// Deliberately synthetic token. Every test injects a fetcher; none contact Telegram.
const token = "123456789:EXAMPLE_TEST_ONLY_abcdefghijklmnopqrstuvwxyz";
const ok = (result: unknown) => Response.json({ ok: true, result });
function mock(responses: Array<Response | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected mock request");
    return response;
  };
  return { client: new TelegramClient(token, fetcher), calls };
}
function liveSignal(asset: "stock" | "option" = "stock"): Signal {
  const signal = scanMarket(demoSnapshot(["NVDA"]), DEFAULT_RULES).signals.find(
    (candidate) => candidate.asset === asset,
  )!;
  return { ...signal, mode: "schwab" };
}

test("invalid tokens fail locally, and client serialization does not expose credentials", () => {
  for (const value of [
    "",
    "short",
    "1234:abcdefghijklmnopqrst",
    "123456:short",
    `${token}/getMe`,
    `${token}\n`,
  ]) {
    assert.throws(
      () =>
        new TelegramClient(value, async () => {
          throw new Error("Must not fetch");
        }),
      (error) =>
        error instanceof TelegramError &&
        error.status === 400 &&
        !error.message.includes(value || "empty token"),
    );
  }
  assert.equal(JSON.stringify(mock([]).client), "{}");
});

test("getMe uses only the fixed API endpoint with JSON POST, redirect rejection and timeout", async () => {
  const { client, calls } = mock([
    ok({
      id: "123456789",
      is_bot: true,
      username: "meida_example_bot",
      first_name: "Ignored",
    }),
  ]);
  assert.deepEqual(await client.getMe(), {
    id: 123456789,
    username: "meida_example_bot",
  });
  assert.equal(calls[0].url, `https://api.telegram.org/bot${token}/getMe`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "error");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {});
  const malformed = mock([
    ok({ id: 12, is_bot: false, username: "meida_bot" }),
  ]);
  await assert.rejects(
    malformed.client.getMe(),
    (error) => error instanceof TelegramError && error.code === "response",
  );
});

test("polling refuses an existing webhook without deleting or modifying it", async () => {
  const { client, calls } = mock([
    ok({ url: "https://existing.example/webhook?secret=not-for-logs" }),
  ]);
  await assert.rejects(client.assertPollingAvailable(), (error) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "webhook");
    assert.ok(!error.message.includes("existing.example"));
    return true;
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/getWebhookInfo"));
  await mock([ok({ url: "" })]).client.assertPollingAvailable();
});

test("updates are bounded, sorted, and narrowed without assuming missing sender identity", async () => {
  const { client, calls } = mock([
    ok([
      {
        update_id: "102",
        message: {
          text: "/start pairing-code",
          chat: { id: "77", type: "private", title: "Ignored" },
          from: { id: "77", is_bot: false, username: "Ignored" },
        },
      },
      {
        update_id: 101,
        message: {
          text: "hello",
          chat: { id: -123, type: "group" },
          from: { id: 10 },
        },
      },
      {
        update_id: 103,
        message: {
          text: "bad chat",
          chat: { id: "9007199254740993", type: "private" },
        },
      },
      { update_id: "invalid", message: { text: "ignored" } },
      { update_id: 104, edited_message: { text: "not subscribed" } },
    ]),
  ]);
  assert.deepEqual(await client.getUpdates(100), [
    {
      update_id: 101,
      message: { text: "hello", chat: { id: -123, type: "group" } },
    },
    {
      update_id: 102,
      message: {
        text: "/start pairing-code",
        chat: { id: 77, type: "private" },
        from: { id: 77, is_bot: false },
      },
    },
    { update_id: 103 },
    { update_id: 104 },
  ]);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    offset: 100,
    limit: 100,
    timeout: 0,
    allowed_updates: ["message"],
  });
  const invalid = mock([]);
  await assert.rejects(invalid.client.getUpdates(-1), TelegramError);
  assert.equal(invalid.calls.length, 0);
});

test("messages are plain text with previews disabled and invalid destinations rejected locally", async () => {
  const { client, calls } = mock([ok({ message_id: 12 })]);
  const text = "<b>plain</b> _literal_ [not markup](https://example.com)";
  await client.sendMessage("77", text);
  const body = JSON.parse(String(calls[0].init.body));
  assert.deepEqual(body, {
    chat_id: "77",
    text,
    link_preview_options: { is_disabled: true },
  });
  assert.ok(!("parse_mode" in body));
  for (const destination of ["@channel", "77/evil", "0", "9007199254740993"])
    await assert.rejects(
      client.sendMessage(destination, "test"),
      TelegramError,
    );
  await assert.rejects(client.sendMessage("77", " "), TelegramError);
  await assert.rejects(
    client.sendMessage("77", "x".repeat(4097)),
    TelegramError,
  );
  assert.equal(calls.length, 1);
});

test("rate-limit and network failures expose only fixed safe messages and validated retry delay", async () => {
  const privateText = `provider echoed ${token} https://api.telegram.org/bot${token}/getMe`;
  const limited = mock([
    Response.json(
      {
        ok: false,
        error_code: 429,
        description: privateText,
        parameters: { retry_after: "7" },
      },
      { status: 429 },
    ),
  ]);
  await assert.rejects(limited.client.getMe(), (error) => {
    assert.ok(error instanceof TelegramError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfter, 7);
    assert.ok(!JSON.stringify(error).includes(token));
    assert.ok(!error.message.includes(privateText));
    assert.equal(error.cause, undefined);
    return true;
  });
  await assert.rejects(
    mock([new Error(privateText)]).client.getMe(),
    (error) => {
      assert.ok(error instanceof TelegramError);
      assert.equal(error.code, "network");
      assert.ok(!error.stack?.includes(token));
      return true;
    },
  );
  await assert.rejects(
    mock([
      Response.json(
        { ok: false, error_code: 401, description: privateText },
        { status: 401 },
      ),
    ]).client.getMe(),
    (error) =>
      error instanceof TelegramError &&
      error.status === 401 &&
      !error.message.includes(token),
  );
});

test("invalid and oversized provider bodies cannot leak content or allocate unbounded response data", async () => {
  const oversized = new Response("x".repeat(512 * 1024 + 1));
  await assert.rejects(
    mock([oversized]).client.getMe(),
    (error) => error instanceof TelegramError && error.code === "response",
  );
  await assert.rejects(
    mock([new Response(token)]).client.getMe(),
    (error) =>
      error instanceof TelegramError &&
      error.code === "response" &&
      !error.message.includes(token),
  );
  await assert.rejects(
    mock([
      ok(Array.from({ length: 101 }, (_, update_id) => ({ update_id }))),
    ]).client.getUpdates(),
    TelegramError,
  );
});

test("live alert text includes measured evidence, conditional action, ET time, invalidation and safe app origin", () => {
  const signal = liveSignal();
  const text = formatAlert(
    signal,
    "https://meida.example/private?token=do-not-include#secret",
  );
  assert.ok(text.startsWith("Meida LIVE research alert"));
  assert.ok(text.includes("NVDA · Swing"));
  assert.ok(text.includes("2:10 PM ET"));
  assert.ok(text.includes("Action: Review long setup"));
  assert.ok(text.includes(signal.evidence[0].value));
  assert.ok(text.includes(signal.plan.trigger));
  assert.ok(text.includes(signal.plan.invalidation));
  assert.ok(text.endsWith("Open Meida: https://meida.example/"));
  assert.ok(!text.includes("do-not-include"));
  assert.ok(text.length < 4000);
});

test("options alerts remain neutral and synthetic data never gets a LIVE notification", () => {
  const signal = liveSignal("option");
  const text = formatAlert(signal, "http://127.0.0.1:3000");
  assert.ok(text.includes(signal.instrument));
  assert.ok(text.includes("Action: Review options activity"));
  assert.ok(
    text.includes(
      "Options volume/open interest does not establish trade direction",
    ),
  );
  assert.throws(
    () => formatAlert({ ...signal, mode: "demo" }, "https://meida.example"),
    (error) => error instanceof TelegramError && error.code === "demo",
  );
  for (const origin of [
    "javascript:alert(1)",
    "https://user:password@meida.example",
    "http://public.example",
  ])
    assert.throws(() => formatAlert(signal, origin), TelegramError);
});

test("untrusted long text is capped without losing the app link or actionable fields", () => {
  const signal = liveSignal("option");
  signal.symbol = "<b>".repeat(500);
  signal.instrument = "x".repeat(8000);
  signal.title = "title\nforged heading\u0000".repeat(500);
  signal.evidence = Array.from({ length: 100 }, () => ({
    label: "l".repeat(1000),
    value: "v".repeat(5000),
  }));
  signal.plan = {
    ...signal.plan,
    headline: "h".repeat(5000),
    trigger: "t".repeat(5000),
    invalidation: "i".repeat(5000),
  };
  const text = formatAlert(signal, "https://meida.example");
  assert.ok(text.length < 4000);
  assert.ok(text.includes("Confirmation:"));
  assert.ok(text.includes("Invalidation:"));
  assert.ok(text.endsWith("Open Meida: https://meida.example/"));
  assert.ok(!text.includes("\u0000"));
});
