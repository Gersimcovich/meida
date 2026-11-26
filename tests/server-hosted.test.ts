import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../server/config.ts";
import { Store } from "../server/store.ts";
import { SchwabAuth } from "../server/auth.ts";
import { createApp } from "../server/app.ts";

const password = "private-test-password-long-enough-42";
async function fixture() {
  const config = loadConfig({
    HOST: "0.0.0.0",
    APP_ORIGIN: "https://meida.example",
    OWNER_PASSWORD: password,
  });
  const store = new Store(":memory:");
  const auth = new SchwabAuth(config, store);
  const app = createApp({
    config,
    store,
    auth,
    provider: {
      snapshot: async () => {
        throw new Error("not used");
      },
    },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    new Promise<{ status: number; body: any; cookies: string[] }>(
      (resolve, reject) => {
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
              ...extra,
            },
          },
          (res) => {
            let data = "";
            res.on("data", (part) => {
              data += part;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode || 0,
                body: JSON.parse(data),
                cookies: res.headers["set-cookie"] || [],
              }),
            );
          },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
      },
    );
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  };
  return { request, close, store };
}

test("public binding requires HTTPS and a strong owner password", () => {
  assert.throws(
    () => loadConfig({ HOST: "0.0.0.0" }),
    /Public hosting requires/,
  );
  assert.throws(
    () =>
      loadConfig({
        HOST: "0.0.0.0",
        APP_ORIGIN: "http://meida.example",
        OWNER_PASSWORD: password,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      loadConfig({
        HOST: "0.0.0.0",
        APP_ORIGIN: "https://meida.example",
        OWNER_PASSWORD: "short",
      }),
    /20 characters/,
  );
  assert.equal(
    loadConfig({
      HOST: "0.0.0.0",
      APP_ORIGIN: "https://meida.example",
      OWNER_PASSWORD: password,
    }).hosted,
    true,
  );
});

test("hosted API denies anonymous data and OAuth while health reveals only readiness", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      await f.request("/api/health", "GET", undefined, {
        Host: "internal-health-host",
      }),
      { status: 200, body: { ok: true }, cookies: [] },
    );
    const status = await f.request("/api/session");
    assert.deepEqual(status.body, { authenticated: false, required: true });
    for (const path of [
      "/api/state",
      "/api/journal",
      "/api/auth/schwab/start",
      "/api/auth/schwab/callback?code=private&state=x",
    ])
      assert.equal((await f.request(path)).status, 401, path);
    assert.equal((await f.request("/api/scan", "POST", {})).status, 401);
    assert.equal(
      (
        await f.request(
          "/api/login",
          "POST",
          { password },
          { Origin: "https://evil.example" },
        )
      ).status,
      403,
    );
  } finally {
    await f.close();
  }
});

test("owner login issues a secure cookie, protects secrets, and logout revokes the session", async () => {
  const f = await fixture();
  try {
    const login = await f.request("/api/login", "POST", { password });
    assert.equal(login.status, 200);
    assert.deepEqual(login.body, { authenticated: true });
    const rawCookie = login.cookies.find((cookie) =>
      cookie.startsWith("meida_owner="),
    );
    assert.ok(rawCookie);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"])
      assert.ok(rawCookie.includes(flag), flag);
    const Cookie = rawCookie.split(";")[0];
    assert.equal(
      (await f.request("/api/session", "GET", undefined, { Cookie })).body
        .authenticated,
      true,
    );
    const state = await f.request("/api/state", "GET", undefined, { Cookie });
    assert.equal(state.status, 200);
    assert.ok(!JSON.stringify(state.body).includes(password));
    const logout = await f.request("/api/logout", "POST", {}, { Cookie });
    assert.equal(logout.status, 200);
    assert.equal(
      (await f.request("/api/state", "GET", undefined, { Cookie })).status,
      401,
    );
    assert.equal(
      (await f.request("/api/session", "GET", undefined, { Cookie })).body
        .authenticated,
      false,
    );
  } finally {
    await f.close();
  }
});

test("owner login attempts are rate limited with generic credential errors", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 5; i++) {
      const result = await f.request("/api/login", "POST", {
        password: "incorrect",
      });
      assert.equal(result.status, 401);
      assert.match(result.body.error, /credentials/i);
    }
    assert.equal(
      (await f.request("/api/login", "POST", { password })).status,
      429,
    );
  } finally {
    await f.close();
  }
});
