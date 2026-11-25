import test from "node:test";
import assert from "node:assert/strict";
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
