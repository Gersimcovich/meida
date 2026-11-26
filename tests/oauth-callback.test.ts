import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../server/config.ts";
import { Store } from "../server/store.ts";
import { SchwabAuth } from "../server/auth.ts";
import { createApp } from "../server/app.ts";

const password = "oauth-callback-test-owner-password";
const authorizationCode = "private-code+with/slash%and=characters";
const providerDetail = "private-provider-error-body-do-not-reflect";
const callbackPath = "/api/auth/schwab/callback";

async function fixture(
  tokenResponse: () => Response | Promise<Response> = () =>
    Response.json({
      access_token: "private-access-token",
      refresh_token: "private-refresh-token",
      expires_in: 1800,
    }),
) {
  const config = loadConfig({
    HOST: "0.0.0.0",
    APP_ORIGIN: "https://meida.example",
    OWNER_PASSWORD: password,
    SCHWAB_CLIENT_ID: "test-client-id",
    SCHWAB_CLIENT_SECRET: "test-client-secret",
    TOKEN_ENCRYPTION_KEY: "ab".repeat(32),
  });
  const store = new Store(":memory:");
  const exchanges: { url: string; code: string | null }[] = [];
  let auth!: SchwabAuth;
  let server!: Server;
  let port = 0;
  const fetcher: typeof fetch = async (url, init) => {
    exchanges.push({
      url: String(url),
      code: new URLSearchParams(init?.body as URLSearchParams).get("code"),
    });
    return tokenResponse();
  };
  const open = async () => {
    auth = new SchwabAuth(config, store, fetcher, () => Date.now());
    server = createServer(
      createApp({
        config,
        store,
        auth,
        provider: {
          snapshot: async () => {
            throw new Error("Unexpected market-data request");
          },
        },
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    port = address.port;
  };
  const closeServer = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  await open();
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    new Promise<{
      status: number;
      body: any;
      text: string;
      headers: import("node:http").IncomingHttpHeaders;
    }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
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
          let text = "";
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () =>
            resolve({
              status: response.statusCode || 0,
              body: response.headers["content-type"]?.includes(
                "application/json",
              )
                ? JSON.parse(text)
                : null,
              text,
              headers: response.headers,
            }),
          );
        },
      );
      req.on("error", reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  const login = await request("/api/login", "POST", { password });
  assert.equal(login.status, 200);
  const ownerCookie = login.headers["set-cookie"]
    ?.find((value) => value.startsWith("meida_owner="))
    ?.split(";")[0];
  assert.ok(ownerCookie);
  const start = async () => {
    const response = await request("/api/auth/schwab/start", "GET", undefined, {
      Cookie: ownerCookie,
      "Sec-Fetch-Site": "same-origin",
    });
    assert.equal(response.status, 302);
    const url = new URL(response.headers.location!);
    const cookie = response.headers["set-cookie"]?.find((value) =>
      value.startsWith("meida_oauth_state="),
    );
    assert.ok(cookie);
    const state = url.searchParams.get("state");
    assert.ok(state);
    return {
      state,
      Cookie: `${ownerCookie}; ${cookie.split(";")[0]}`,
      cookie,
      url,
    };
  };
  const callback = (
    fields: Record<string, string>,
    Cookie: string,
    headers: Record<string, string> = {},
  ) =>
    request(
      `${callbackPath}?${new URLSearchParams(fields)}`,
      "GET",
      undefined,
      { Cookie, ...headers },
    );
  const close = async () => {
    await closeServer();
    store.close();
  };
  return {
    config,
    store,
    request,
    start,
    callback,
    ownerCookie,
    exchanges,
    auth: () => auth,
    restart: async () => {
      await closeServer();
      await open();
    },
    close,
  };
}

function assertRedacted(
  response: { text: string; headers: import("node:http").IncomingHttpHeaders },
  values = [authorizationCode, providerDetail],
) {
  const rendered = `${response.text}\n${response.headers.location || ""}`;
  for (const value of values)
    assert.ok(
      !rendered.includes(value),
      "A callback response exposed sensitive input",
    );
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
}

test("OAuth callback exchanges the exact code once and selects Schwab data after success", async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    assert.equal(started.url.origin, "https://api.schwabapi.com");
    assert.equal(started.url.searchParams.get("client_id"), "test-client-id");
    assert.equal(
      started.url.searchParams.get("redirect_uri"),
      f.config.redirectUri,
    );
    for (const flag of [
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Path=/api/auth/schwab",
    ])
      assert.ok(started.cookie.includes(flag));
    const response = await f.callback(
      { code: authorizationCode, state: started.state },
      started.Cookie,
    );
    assert.equal(response.status, 303);
    assert.equal(response.headers.location, "/?connection=connected");
    assertRedacted(response, [authorizationCode, started.state]);
    assert.equal(f.store.mode, "schwab");
    assert.equal(f.auth().status().connected, true);
    assert.deepEqual(f.exchanges, [
      {
        url: "https://api.schwabapi.com/v1/oauth/token",
        code: authorizationCode,
      },
    ]);
    const replay = await f.callback(
      { code: authorizationCode, state: started.state },
      started.Cookie,
    );
    assert.equal(
      replay.headers.location,
      "/?connection=failed&reason=invalid_return",
    );
    assert.equal(f.exchanges.length, 1);
  } finally {
    await f.close();
  }
});

test("OAuth return survives an app restart with the original owner and state cookies", async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    await f.restart();
    const response = await f.callback(
      { code: authorizationCode, state: started.state },
      started.Cookie,
    );
    assert.equal(response.headers.location, "/?connection=connected");
    assert.equal(f.auth().status().connected, true);
    assert.equal(f.exchanges.length, 1);
  } finally {
    await f.close();
  }
});

test("denial consumes matching state and exposes only a constant reason", async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    const response = await f.callback(
      {
        error: "access_denied",
        error_description: providerDetail,
        state: started.state,
      },
      started.Cookie,
    );
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.location,
      "/?connection=failed&reason=declined",
    );
    assertRedacted(response, [providerDetail, started.state]);
    assert.equal(f.exchanges.length, 0);
    assert.equal(f.auth().status().connected, false);
    assert.equal(f.auth().status().authorization?.status, "failed");
    const replay = await f.callback(
      { code: authorizationCode, state: started.state },
      started.Cookie,
    );
    assert.equal(
      replay.headers.location,
      "/?connection=failed&reason=invalid_return",
    );
    assert.equal(f.exchanges.length, 0);
  } finally {
    await f.close();
  }
});

test("wrong or missing state cookies never exchange the code or destroy a valid pending return", async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    for (const Cookie of [
      f.ownerCookie,
      `${f.ownerCookie}; meida_oauth_state=${"f".repeat(64)}`,
    ]) {
      const response = await f.callback(
        { code: authorizationCode, state: started.state },
        Cookie,
      );
      assert.equal(
        response.headers.location,
        "/?connection=failed&reason=invalid_return",
      );
      assertRedacted(response, [authorizationCode, started.state]);
    }
    assert.equal(f.exchanges.length, 0);
    assert.equal(
      (
        await f.callback(
          { code: authorizationCode, state: started.state },
          started.Cookie,
        )
      ).headers.location,
      "/?connection=connected",
    );
    assert.equal(f.exchanges.length, 1);
  } finally {
    await f.close();
  }
});

test("expired pending states fail closed without a token request", async (t) => {
  const f = await fixture();
  try {
    const started = await f.start();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 600_001 });
    const response = await f.callback(
      { code: authorizationCode, state: started.state },
      started.Cookie,
    );
    assert.equal(
      response.headers.location,
      "/?connection=failed&reason=invalid_return",
    );
    assert.equal(f.exchanges.length, 0);
    assert.equal(f.auth().status().connected, false);
  } finally {
    t.mock.timers.reset();
    await f.close();
  }
});

test("missing owner session redirects only callback navigations while APIs remain protected", async () => {
  const f = await fixture();
  try {
    const started = await f.start();
    const oauthOnly = `meida_oauth_state=${started.state}`;
    const navigations: Record<string, string>[] = [
      { Accept: "text/html" },
      { "Sec-Fetch-Mode": "navigate" },
    ];
    for (const headers of navigations) {
      const response = await f.callback(
        { code: authorizationCode, state: started.state },
        oauthOnly,
        headers,
      );
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.location,
        "/?connection=failed&reason=owner_session",
      );
      assertRedacted(response, [authorizationCode, started.state]);
    }
    const api = await f.callback(
      { code: authorizationCode, state: started.state },
      oauthOnly,
      { Accept: "application/json" },
    );
    assert.equal(api.status, 401);
    assert.equal(api.body.code, "OWNER_AUTH_REQUIRED");
    assert.equal(
      (await f.request("/api/state", "GET", undefined, { Accept: "text/html" }))
        .status,
      401,
    );
    assert.equal(
      (
        await f.request("/api/auth/schwab/start", "GET", undefined, {
          Accept: "text/html",
        })
      ).status,
      401,
    );
    assert.equal(f.exchanges.length, 0);
    assert.equal(
      (
        await f.callback(
          { code: authorizationCode, state: started.state },
          started.Cookie,
        )
      ).headers.location,
      "/?connection=connected",
    );
  } finally {
    await f.close();
  }
});

test("malformed callbacks and provider errors never leak query values or token response bodies", async () => {
  const f = await fixture(() =>
    Response.json(
      { error: "invalid_grant", error_description: providerDetail },
      { status: 400 },
    ),
  );
  try {
    const started = await f.start();
    const malformed: Record<string, string>[] = [
      { code: authorizationCode },
      { code: authorizationCode, error: "access_denied", state: started.state },
      { state: started.state },
      { code: authorizationCode, state: "bad-state" },
    ];
    for (const fields of malformed) {
      const response = await f.callback(fields, started.Cookie);
      assert.equal(
        response.headers.location,
        "/?connection=failed&reason=invalid_return",
      );
      assertRedacted(response);
    }
    assert.equal(f.exchanges.length, 0);
    const failed = await f.callback(
      { code: authorizationCode, state: started.state },
      started.Cookie,
    );
    assert.equal(
      failed.headers.location,
      "/?connection=failed&reason=authorization_failed",
    );
    assertRedacted(failed);
    assert.equal(f.auth().status().connected, false);
    assert.ok(!JSON.stringify(f.auth().status()).includes(providerDetail));
    assert.ok(!JSON.stringify(f.auth().status()).includes(authorizationCode));
    const retry = await f.start();
    const denied = await f.callback(
      { error: providerDetail, state: retry.state },
      retry.Cookie,
    );
    assert.equal(
      denied.headers.location,
      "/?connection=failed&reason=authorization_failed",
    );
    assertRedacted(denied);
  } finally {
    await f.close();
  }
});
