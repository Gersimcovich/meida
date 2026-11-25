import "dotenv/config";
import { readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import express from "express";
import { loadConfig } from "./config.ts";
import { Store } from "./store.ts";
import { SchwabAuth } from "./auth.ts";
import { SchwabProvider } from "./schwab.ts";
import { createApp } from "./app.ts";

const config = loadConfig();
if (config.hosted && process.env.NODE_ENV !== "production")
  throw new Error(
    "Hosted mode requires NODE_ENV=production and a built frontend.",
  );
if (config.origin.startsWith("https:") && !config.tlsCertFile && !config.hosted)
  throw new Error("Local HTTPS requires TLS_KEY_FILE and TLS_CERT_FILE.");
if (!config.origin.startsWith("https:") && config.tlsCertFile)
  throw new Error("Set APP_ORIGIN to https:// when configuring TLS.");
const store = new Store(config.databasePath);
const auth = new SchwabAuth(config, store);
const provider = new SchwabProvider((path, params) =>
  auth.marketData(path, params),
);
const app = createApp({ config, store, auth, provider });
const server = config.tlsCertFile
  ? createHttpsServer(
      {
        key: readFileSync(config.tlsKeyFile),
        cert: readFileSync(config.tlsCertFile),
      },
      app,
    )
  : createHttpServer(app);
let closeVite: (() => Promise<void>) | undefined;
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
  closeVite = () => vite.close();
}
server.listen(config.port, config.host, () => {
  console.log(`Meida is available at ${config.origin}`);
  app.locals.notifications.start();
});
async function shutdown() {
  await app.locals.notifications.stop();
  await closeVite?.();
  server.close(() => {
    store.close();
    process.exit(0);
  });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
