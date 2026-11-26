import { resolve } from "node:path";

export interface Config {
  host: string;
  port: number;
  origin: string;
  databasePath: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: string;
  tlsKeyFile: string;
  tlsCertFile: string;
  hosted: boolean;
  ownerPassword: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost", "0.0.0.0"].includes(host)) {
    throw new Error(
      "HOST must be a loopback address or 0.0.0.0 for protected hosted use.",
    );
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer from 1 to 65535.");
  const origin = new URL(
    env.APP_ORIGIN || `http://${host === "::1" ? "[::1]" : host}:${port}`,
  ).origin;
  const url = new URL(origin);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("APP_ORIGIN must use HTTP or HTTPS.");
  const hosted =
    host === "0.0.0.0" ||
    !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  const ownerPassword = env.OWNER_PASSWORD || "";
  if (
    hosted &&
    (url.protocol !== "https:" ||
      ownerPassword.length < 20 ||
      ownerPassword.length > 1024 ||
      !ownerPassword.trim())
  )
    throw new Error(
      "Public hosting requires HTTPS APP_ORIGIN and OWNER_PASSWORD of at least 20 characters; otherwise use a loopback address.",
    );
  if (hosted && ["0.0.0.0", "::", "[::]"].includes(url.hostname))
    throw new Error(
      "APP_ORIGIN must be the actual HTTPS hostname of your hosted service.",
    );
  const redirectUri =
    env.SCHWAB_REDIRECT_URI || `${origin}/api/auth/schwab/callback`;
  const callback = new URL(redirectUri);
  if (
    callback.origin !== origin ||
    callback.pathname !== "/api/auth/schwab/callback" ||
    callback.search ||
    callback.hash
  ) {
    throw new Error(
      "SCHWAB_REDIRECT_URI must exactly match APP_ORIGIN + /api/auth/schwab/callback.",
    );
  }
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY || "";
  if (encryptionKey && !/^[a-f\d]{64}$/i.test(encryptionKey))
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must contain 64 hexadecimal characters (32 random bytes).",
    );
  const tlsKeyFile = env.TLS_KEY_FILE || "";
  const tlsCertFile = env.TLS_CERT_FILE || "";
  if (!!tlsKeyFile !== !!tlsCertFile)
    throw new Error("Set both TLS_KEY_FILE and TLS_CERT_FILE.");
  return {
    host,
    port,
    origin,
    databasePath: env.DATABASE_PATH || resolve("data/meida.sqlite"),
    clientId: env.SCHWAB_CLIENT_ID || "",
    clientSecret: env.SCHWAB_CLIENT_SECRET || "",
    redirectUri,
    encryptionKey,
    tlsKeyFile,
    tlsCertFile,
    hosted,
    ownerPassword,
  };
}
