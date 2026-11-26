import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../server/config.ts";
import { Store } from "../server/store.ts";
import { SchwabAuth, encryptToken, decryptToken } from "../server/auth.ts";

const key = "ab".repeat(32);
const config = () =>
  loadConfig({
    SCHWAB_CLIENT_ID: "test-client",
    SCHWAB_CLIENT_SECRET: "test-secret",
    TOKEN_ENCRYPTION_KEY: key,
    APP_ORIGIN: "https://127.0.0.1:3000",
  });

test("configuration refuses public host, off-origin callback, and malformed encryption key", () => {
  assert.throws(() => loadConfig({ HOST: "0.0.0.0" }), /loopback/);
  assert.throws(
    () => loadConfig({ APP_ORIGIN: "https://example.com" }),
    /loopback/,
  );
  assert.throws(
    () => loadConfig({ SCHWAB_REDIRECT_URI: "https://evil.example/callback" }),
    /exactly match/,
  );
  assert.throws(
    () => loadConfig({ TOKEN_ENCRYPTION_KEY: "weak" }),
    /64 hexadecimal/,
  );
});

test("system SSL_CERT_FILE CA configuration is not mistaken for an app TLS certificate", () => {
  const value = loadConfig({
    SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
  });
  assert.equal(value.tlsCertFile, "");
  assert.equal(value.tlsKeyFile, "");
});

test("token encryption is randomized and authenticated", () => {
  const value = {
    accessToken: "sensitive-access",
    refreshToken: "sensitive-refresh",
  };
  const first = encryptToken(value, key);
  assert.notEqual(first, encryptToken(value, key));
  assert.ok(!first.includes("sensitive"));
  assert.deepEqual(decryptToken(first, key), value);
  assert.throws(() => decryptToken(first, "cd".repeat(32)));
  const tampered = Buffer.from(first, "base64");
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptToken(tampered.toString("base64"), key));
});

test("OAuth binds state to cookie, consumes it once, and keeps tokens out of status", async () => {
  const store = new Store(":memory:");
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const auth = new SchwabAuth(config(), store, async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({
      access_token: "private-access",
      refresh_token: "private-refresh",
      expires_in: 1800,
    });
  });
  const { state, url } = auth.start();
  assert.equal(new URL(url).origin, "https://api.schwabapi.com");
  assert.equal(new URL(url).searchParams.get("scope"), "readonly");
  await assert.rejects(auth.callback("code", state, "wrong"), /state/);
  assert.equal(calls.length, 0);
  await auth.callback("code", state, state);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.schwabapi.com/v1/oauth/token");
  assert.equal(
    new URLSearchParams(calls[0].init?.body as URLSearchParams).get("code"),
    "code",
  );
  assert.equal(auth.status().connected, true);
  assert.ok(!JSON.stringify(auth.status()).includes("private-access"));
  assert.ok(!store.get<string>("schwabTokens", "").includes("private-refresh"));
  await assert.rejects(auth.callback("code", state, state), /state/);
  auth.disconnect();
  assert.equal(auth.status().connected, false);
  assert.equal(store.get("schwabTokens", null), null);
  store.close();
});

test("concurrent market reads share one token refresh and reject execution endpoints", async () => {
  const store = new Store(":memory:");
  store.set(
    "schwabTokens",
    encryptToken(
      { accessToken: "expired", refreshToken: "refresh", expiresAt: 0 },
      key,
    ),
  );
  let refreshes = 0;
  let marketRequests = 0;
  const auth = new SchwabAuth(config(), store, async (url, init) => {
    if (String(url).includes("/oauth/token")) {
      refreshes++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ access_token: "new-access", expires_in: 1800 });
    }
    marketRequests++;
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer new-access",
    );
    return Response.json({ ok: true });
  });
  await Promise.all([
    auth.marketData("/quotes", {}),
    auth.marketData("/chains", {}),
  ]);
  assert.equal(refreshes, 1);
  assert.equal(marketRequests, 2);
  await assert.rejects(auth.marketData("/orders", {}), /Unsupported/);
  store.close();
});

test("expired authorization reports reconnect without disclosing provider response", async () => {
  const store = new Store(":memory:");
  store.set(
    "schwabTokens",
    encryptToken(
      { accessToken: "expired", refreshToken: "refresh", expiresAt: 0 },
      key,
    ),
  );
  const auth = new SchwabAuth(config(), store, async () =>
    Response.json(
      { error: "invalid_grant", details: "sensitive-provider-body" },
      { status: 400 },
    ),
  );
  await assert.rejects(
    auth.marketData("/quotes", {}),
    (error) =>
      error instanceof Error &&
      !error.message.includes("sensitive-provider-body"),
  );
  assert.equal(auth.status().reconnectRequired, true);
  assert.equal(auth.status().connected, false);
  store.close();
});

test("transient refresh failures retain authorization for a later retry", async () => {
  for (const status of [429, 500, 503]) {
    const store = new Store(":memory:");
    store.set(
      "schwabTokens",
      encryptToken(
        { accessToken: "expired", refreshToken: "refresh", expiresAt: 0 },
        key,
      ),
    );
    const auth = new SchwabAuth(
      config(),
      store,
      async () => new Response("private-provider-error", { status }),
    );
    await assert.rejects(auth.marketData("/quotes", {}));
    assert.equal(auth.status().reconnectRequired, false);
    assert.equal(auth.status().connected, true);
    store.close();
  }
});

test("disconnect during refresh cannot resurrect encrypted tokens", async () => {
  const store = new Store(":memory:");
  store.set(
    "schwabTokens",
    encryptToken(
      { accessToken: "expired", refreshToken: "refresh", expiresAt: 0 },
      key,
    ),
  );
  let complete: (response: Response) => void = () => {};
  const auth = new SchwabAuth(
    config(),
    store,
    async () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const pending = auth.marketData("/quotes", {});
  auth.disconnect();
  complete(
    Response.json({
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_in: 1800,
    }),
  );
  await assert.rejects(pending, /disconnected/);
  assert.equal(store.get("schwabTokens", null), null);
  assert.equal(auth.status().connected, false);
  store.close();
});

test("disconnect during authorization callback cannot resurrect encrypted tokens", async () => {
  const store = new Store(":memory:");
  let complete: (response: Response) => void = () => {};
  const auth = new SchwabAuth(
    config(),
    store,
    async () =>
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
  );
  const { state } = auth.start();
  const pending = auth.callback("code", state, state);
  auth.disconnect();
  complete(
    Response.json({
      access_token: "new-token",
      refresh_token: "new-refresh",
      expires_in: 1800,
    }),
  );
  await assert.rejects(pending, /canceled/);
  assert.equal(store.get("schwabTokens", null), null);
  assert.equal(auth.status().connected, false);
  store.close();
});

const tokenResponse = () =>
  Response.json({
    access_token: "test-private-access",
    refresh_token: "test-private-refresh",
    expires_in: 1800,
  });
const stateHash = (state: string) =>
  createHash("sha256").update(state).digest("hex");

test("pending OAuth survives reopening the database and stores only hashed state", async () => {
  const directory = mkdtempSync(join(tmpdir(), "meida-oauth-"));
  let store = new Store(join(directory, "app.sqlite"));
  try {
    const first = new SchwabAuth(config(), store, async () => tokenResponse());
    const { state } = first.start();
    const persisted = store.get<Record<string, unknown>>(
      "schwabOAuthAttempts",
      {},
    );
    assert.deepEqual(Object.keys(persisted), [stateHash(state)]);
    assert.ok(!JSON.stringify(persisted).includes(state));
    assert.ok(!JSON.stringify(persisted).includes("test-secret"));
    assert.equal(first.status().authorization?.status, "awaiting_return");
    store.close();
    store = new Store(join(directory, "app.sqlite"));
    const restored = new SchwabAuth(config(), store, async () =>
      tokenResponse(),
    );
    assert.equal(restored.status().authorization?.status, "awaiting_return");
    await restored.callback("private-authorization-code", state, state);
    assert.equal(restored.status().authorization?.status, "connected");
    assert.equal(restored.status().connected, true);
    assert.equal(
      store.get(`schwabOAuthAttempt:${stateHash(state)}`, null),
      null,
    );
    const publicState = JSON.stringify(restored.status());
    for (const secret of [
      state,
      stateHash(state),
      "private-authorization-code",
      "test-private-access",
      "test-private-refresh",
      "test-secret",
    ])
      assert.ok(!publicState.includes(secret));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("invalid cookies, unrelated state, and replay do not replace useful diagnostics", async () => {
  const store = new Store(":memory:");
  try {
    const auth = new SchwabAuth(config(), store, async () => tokenResponse());
    const { state } = auth.start();
    const diagnostic = auth.status().authorization;
    await assert.rejects(auth.callback("code", state, "wrong-cookie"), /state/);
    await assert.rejects(
      auth.callback("code", "f".repeat(64), "f".repeat(64)),
      /state/,
    );
    assert.deepEqual(auth.status().authorization, diagnostic);
    await auth.callback("code", state, state);
    const connected = auth.status().authorization;
    await assert.rejects(auth.callback("code", state, state), /state/);
    assert.deepEqual(auth.status().authorization, connected);
  } finally {
    store.close();
  }
});

test("OAuth attempts expire after ten minutes and pending storage stays bounded", async () => {
  const store = new Store(":memory:");
  let clock = 1_800_000_000_000;
  try {
    const auth = new SchwabAuth(
      config(),
      store,
      async () => tokenResponse(),
      () => clock,
    );
    const first = auth.start();
    for (let i = 0; i < 100; i++) {
      clock++;
      auth.start();
    }
    assert.equal(Object.keys(store.get("schwabOAuthAttempts", {})).length, 100);
    assert.equal(
      store.get(`schwabOAuthAttempt:${stateHash(first.state)}`, null),
      null,
    );
    await assert.rejects(
      auth.callback("code", first.state, first.state),
      /state/,
    );
    const last = auth.start();
    clock += 10 * 60_000;
    await assert.rejects(
      auth.callback("code", last.state, last.state),
      /state/,
    );
    assert.equal(auth.status().authorization?.status, "failed");
    assert.match(auth.status().authorization?.message || "", /expired/);
    assert.equal(Object.keys(store.get("schwabOAuthAttempts", {})).length, 0);
  } finally {
    store.close();
  }
});

test("changing app key or callback invalidates a persisted pending attempt", async () => {
  for (const kind of ["client", "callback"] as const) {
    const store = new Store(":memory:");
    try {
      const initial = new SchwabAuth(config(), store, async () =>
        tokenResponse(),
      );
      const { state } = initial.start();
      const changed = config();
      if (kind === "client") changed.clientId = "different-client";
      else
        changed.redirectUri = "https://other.example/api/auth/schwab/callback";
      let calls = 0;
      const auth = new SchwabAuth(changed, store, async () => {
        calls++;
        return tokenResponse();
      });
      await assert.rejects(auth.callback("code", state, state), /state/);
      assert.equal(calls, 0);
      assert.equal(auth.status().authorization?.status, "idle");
      assert.equal(
        store.get(`schwabOAuthAttempt:${stateHash(state)}`, null),
        null,
      );
    } finally {
      store.close();
    }
  }
});

test("persisted state is consumed before exchange and cannot be used concurrently", async () => {
  const store = new Store(":memory:");
  try {
    let complete!: (response: Response) => void;
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return new Promise<Response>((resolve) => {
        complete = resolve;
      });
    };
    const first = new SchwabAuth(config(), store, fetcher);
    const second = new SchwabAuth(config(), store, fetcher);
    const { state } = first.start();
    const pending = first.callback("code", state, state);
    assert.equal(first.status().authorization?.status, "exchanging");
    await assert.rejects(second.callback("code", state, state), /state/);
    assert.equal(calls, 1);
    complete(tokenResponse());
    await pending;
    assert.equal(second.status().connected, true);
  } finally {
    store.close();
  }
});

test("declined and provider-error callbacks consume valid attempts without reflecting external content", async () => {
  const store = new Store(":memory:");
  try {
    let calls = 0;
    const auth = new SchwabAuth(config(), store, async () => {
      calls++;
      return tokenResponse();
    });
    const denied = auth.start();
    assert.throws(() => auth.deny(denied.state, "incorrect"), /state/);
    assert.equal(auth.status().authorization?.status, "awaiting_return");
    auth.deny(denied.state, denied.state);
    assert.equal(
      auth.status().authorization?.message,
      "Schwab authorization was declined or canceled.",
    );
    await assert.rejects(
      auth.callback("code", denied.state, denied.state),
      /state/,
    );
    const providerError = auth.start();
    auth.deny(providerError.state, providerError.state, "provider_error");
    assert.equal(
      auth.status().authorization?.message,
      "Schwab returned an authorization error before issuing a code. Check the app status and callback configuration.",
    );
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test("exchange failures and interrupted exchanges expose only fixed safe diagnostics", async () => {
  const store = new Store(":memory:");
  try {
    const auth = new SchwabAuth(config(), store, async () =>
      Response.json(
        { error: "invalid_grant", detail: "private-provider-description" },
        { status: 400 },
      ),
    );
    const { state } = auth.start();
    await assert.rejects(auth.callback("private-code", state, state));
    assert.equal(auth.status().authorization?.status, "failed");
    assert.ok(
      !JSON.stringify(auth.status()).includes("private-provider-description"),
    );
    const saved = store.get<Record<string, unknown>>(
      "schwabAuthorizationStatus",
      {},
    );
    store.set("schwabAuthorizationStatus", { ...saved, status: "exchanging" });
    const restarted = new SchwabAuth(config(), store, async () =>
      tokenResponse(),
    );
    assert.equal(restarted.status().authorization?.status, "failed");
    assert.match(
      restarted.status().authorization?.message || "",
      /interrupted/,
    );
  } finally {
    store.close();
  }
});

test("disconnect through another auth instance cancels an in-flight exchange durably", async () => {
  const store = new Store(":memory:");
  try {
    let complete!: (response: Response) => void;
    const first = new SchwabAuth(
      config(),
      store,
      async () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const second = new SchwabAuth(config(), store, async () => tokenResponse());
    const { state } = first.start();
    const pending = first.callback("code", state, state);
    second.disconnect();
    complete(tokenResponse());
    await assert.rejects(pending, /canceled/);
    assert.equal(first.status().authorization?.status, "idle");
    assert.equal(store.get("schwabTokens", null), null);
  } finally {
    store.close();
  }
});
