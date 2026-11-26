import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import type { AuthorizationStatus, ConnectionStatus } from "../shared/types.ts";

interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}
type Fetcher = typeof fetch;
const AUTH_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const MARKET_URL = "https://api.schwabapi.com/marketdata/v1";
const ATTEMPT_TTL = 10 * 60_000;
const ATTEMPT_INDEX = "schwabOAuthAttempts";
const ATTEMPT_PREFIX = "schwabOAuthAttempt:";
const AUTHORIZATION_STATUS = "schwabAuthorizationStatus";
const GENERATION_KEY = "schwabAuthorizationGeneration";
interface OAuthAttempt {
  createdAt: number;
  expiresAt: number;
  fingerprint: string;
}
interface SavedAuthorizationStatus extends AuthorizationStatus {
  fingerprint: string;
  attemptHash?: string;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
export function encryptToken(value: unknown, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hexKey, "hex"), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}
export function decryptToken<T>(value: string, hexKey: string): T {
  const data = Buffer.from(value, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(hexKey, "hex"),
    data.subarray(0, 12),
  );
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(data.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  ) as T;
}
export function equalSecret(a: string, b: string): boolean {
  const first = Buffer.from(a);
  const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export class SchwabAuth {
  private refreshPromise: Promise<TokenSet> | null = null;
  private reconnect = false;
  constructor(
    private config: Config,
    private store: Store,
    private fetcher: Fetcher = fetch,
    private now: () => number = Date.now,
  ) {
    this.pendingAttempts();
    const saved = this.savedAuthorization();
    if (saved?.status === "exchanging")
      this.setAuthorization(
        "failed",
        "The authorization exchange was interrupted. Start the connection again.",
        saved.startedAt,
        saved.attemptHash,
      );
  }
  get configured() {
    return !!(
      this.config.clientId &&
      this.config.clientSecret &&
      this.config.encryptionKey
    );
  }
  get revision() {
    return this.store.get<number>(GENERATION_KEY, 0);
  }
  private advanceGeneration() {
    // Persist the epoch so an older process cannot revive credentials after disconnect.
    this.store.set(GENERATION_KEY, randomBytes(6).readUIntBE(0, 6));
  }
  private get fingerprint() {
    return digest(
      JSON.stringify([this.config.clientId, this.config.redirectUri]),
    );
  }
  private pendingAttempts(): Record<string, OAuthAttempt> {
    const saved = this.store.get<Record<string, OAuthAttempt>>(
      ATTEMPT_INDEX,
      {},
    );
    const pending: Record<string, OAuthAttempt> = {};
    const now = this.now();
    for (const [hash, attempt] of Object.entries(saved)) {
      if (
        /^[a-f0-9]{64}$/.test(hash) &&
        attempt &&
        attempt.fingerprint === this.fingerprint &&
        Number.isFinite(attempt.createdAt) &&
        attempt.createdAt <= now &&
        Number.isFinite(attempt.expiresAt) &&
        attempt.expiresAt > now &&
        attempt.expiresAt <= attempt.createdAt + ATTEMPT_TTL
      )
        pending[hash] = attempt;
      else this.store.delete(`${ATTEMPT_PREFIX}${hash}`);
    }
    if (Object.keys(saved).length !== Object.keys(pending).length)
      this.store.set(ATTEMPT_INDEX, pending);
    return pending;
  }
  private clearAttempts() {
    const pending = this.store.get<Record<string, OAuthAttempt>>(
      ATTEMPT_INDEX,
      {},
    );
    for (const hash of Object.keys(pending))
      this.store.delete(`${ATTEMPT_PREFIX}${hash}`);
    this.store.delete(ATTEMPT_INDEX);
  }
  private savedAuthorization(): SavedAuthorizationStatus | null {
    const saved = this.store.get<SavedAuthorizationStatus | null>(
      AUTHORIZATION_STATUS,
      null,
    );
    return saved?.fingerprint === this.fingerprint ? saved : null;
  }
  private setAuthorization(
    status: AuthorizationStatus["status"],
    message: string,
    startedAt?: number,
    attemptHash?: string,
  ) {
    const diagnostic: SavedAuthorizationStatus = {
      status,
      message,
      updatedAt: this.now(),
      fingerprint: this.fingerprint,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(attemptHash ? { attemptHash } : {}),
    };
    this.store.set(AUTHORIZATION_STATUS, diagnostic);
  }
  private authorizationStatus(hasTokens: boolean): AuthorizationStatus {
    const pending = this.pendingAttempts();
    let saved = this.savedAuthorization();
    if (
      saved?.status === "awaiting_return" &&
      (!saved.attemptHash || !pending[saved.attemptHash])
    ) {
      this.setAuthorization(
        "failed",
        "The authorization attempt expired. Start the connection again.",
        saved.startedAt,
        saved.attemptHash,
      );
      saved = this.savedAuthorization();
    }
    if (!saved)
      return {
        status: hasTokens && !this.reconnect ? "connected" : "idle",
        updatedAt: 0,
        message:
          hasTokens && !this.reconnect
            ? "Schwab authorization is available."
            : "No authorization attempt has been started.",
      };
    const {
      fingerprint: _fingerprint,
      attemptHash: _attemptHash,
      ...publicStatus
    } = saved;
    return publicStatus;
  }
  private consumeAttempt(
    state: string,
    cookieState: string,
  ): { hash: string; attempt: OAuthAttempt } {
    const invalid = () =>
      new ProviderError(
        "Authorization state is invalid or expired. Start the connection again.",
        400,
      );
    if (
      !/^[a-f0-9]{64}$/.test(state) ||
      !cookieState ||
      !equalSecret(state, cookieState)
    )
      throw invalid();
    const hash = digest(state);
    const pending = this.pendingAttempts();
    if (!pending[hash]) throw invalid();
    // DELETE ... RETURNING consumes this state once, including across process restarts.
    const attempt = this.store.take<OAuthAttempt>(`${ATTEMPT_PREFIX}${hash}`);
    delete pending[hash];
    this.store.set(ATTEMPT_INDEX, pending);
    if (
      !attempt ||
      attempt.fingerprint !== this.fingerprint ||
      attempt.expiresAt <= this.now()
    )
      throw invalid();
    return { hash, attempt };
  }
  private readTokens(): TokenSet | null {
    const encrypted = this.store.get<string | null>("schwabTokens", null);
    if (!encrypted || !this.config.encryptionKey) return null;
    try {
      return decryptToken<TokenSet>(encrypted, this.config.encryptionKey);
    } catch {
      this.reconnect = true;
      return null;
    }
  }
  status(): ConnectionStatus {
    const tokens = this.readTokens();
    const configured = this.configured;
    return {
      configured,
      connected: !!tokens && !this.reconnect,
      reconnectRequired: this.reconnect,
      callbackUrl: this.config.redirectUri,
      authorization: this.authorizationStatus(!!tokens),
      message: !configured
        ? "Configure Schwab credentials and the encryption key on this server."
        : this.reconnect
          ? "Schwab authorization expired or could not be read. Reconnect your account."
          : tokens
            ? "Schwab connected. Quotes are fetched when you run a scan."
            : "Ready to authorize Market Data Production with Schwab.",
    };
  }
  start(): { state: string; url: string } {
    if (!this.configured)
      throw new ProviderError(
        "Schwab credentials and encryption key are not configured.",
        409,
      );
    const pending = this.pendingAttempts();
    const oldest = Object.entries(pending).sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    for (const [hash] of oldest.slice(0, Math.max(0, oldest.length - 99))) {
      delete pending[hash];
      this.store.delete(`${ATTEMPT_PREFIX}${hash}`);
    }
    const state = randomBytes(32).toString("hex");
    const hash = digest(state);
    const createdAt = this.now();
    const attempt = {
      createdAt,
      expiresAt: createdAt + ATTEMPT_TTL,
      fingerprint: this.fingerprint,
    };
    pending[hash] = attempt;
    this.store.set(`${ATTEMPT_PREFIX}${hash}`, attempt);
    this.store.set(ATTEMPT_INDEX, pending);
    this.setAuthorization(
      "awaiting_return",
      "Waiting for Schwab sign-in and consent to return to Meida.",
      createdAt,
      hash,
    );
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: "code",
      scope: "readonly",
      state,
    }).toString();
    return { state, url: url.toString() };
  }
  async callback(code: string, state: string, cookieState: string) {
    const { hash, attempt } = this.consumeAttempt(state, cookieState);
    const generation = this.revision;
    this.setAuthorization(
      "exchanging",
      "Schwab returned to Meida. Completing authorization.",
      attempt.createdAt,
      hash,
    );
    try {
      const tokens = await this.exchange(
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.config.redirectUri,
        }),
      );
      if (generation !== this.revision)
        throw new ProviderError(
          "This connection attempt was canceled. Start again.",
          409,
        );
      this.save(tokens);
      this.reconnect = false;
      this.advanceGeneration();
      this.clearAttempts();
      this.setAuthorization(
        "connected",
        "Schwab authorization completed successfully.",
        attempt.createdAt,
        hash,
      );
    } catch (error) {
      if (
        generation === this.revision &&
        this.savedAuthorization()?.attemptHash === hash
      )
        this.setAuthorization(
          "failed",
          "Meida could not complete the authorization exchange. Check the app credentials and callback configuration, then start again.",
          attempt.createdAt,
          hash,
        );
      throw error;
    }
  }
  deny(
    state: string,
    cookieState: string,
    reason: "denied" | "provider_error" = "denied",
  ): void {
    const { hash, attempt } = this.consumeAttempt(state, cookieState);
    this.setAuthorization(
      "failed",
      reason === "denied"
        ? "Schwab authorization was declined or canceled."
        : "Schwab returned an authorization error before issuing a code. Check the app status and callback configuration.",
      attempt.createdAt,
      hash,
    );
  }
  disconnect() {
    this.advanceGeneration();
    this.store.delete("schwabTokens");
    this.clearAttempts();
    this.reconnect = false;
    this.setAuthorization(
      "idle",
      "Schwab is disconnected. Start a new connection when ready.",
    );
  }
  private save(tokens: TokenSet) {
    this.store.set(
      "schwabTokens",
      encryptToken(tokens, this.config.encryptionKey),
    );
  }
  private async exchange(
    body: URLSearchParams,
    previousRefresh?: string,
  ): Promise<TokenSet> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError(
        "Could not reach Schwab authorization. Try again.",
      );
    }
    if (!response.ok) {
      let oauthError = "";
      try {
        const body = (await response.json()) as { error?: unknown };
        if (typeof body.error === "string") oauthError = body.error;
      } catch {
        /* provider bodies are never exposed */
      }
      if (
        response.status === 401 ||
        (response.status === 400 &&
          ["invalid_grant", "invalid_client"].includes(oauthError))
      )
        throw new ProviderError(
          "Schwab rejected authorization. Check your app configuration or reconnect.",
          401,
        );
      if (response.status === 429)
        throw new ProviderError(
          "Schwab authorization is rate limited. Wait before trying again.",
          429,
        );
      throw new ProviderError(
        "Schwab authorization is temporarily unavailable. Try again later.",
        502,
      );
    }
    const value = (await response.json()) as Record<string, unknown>;
    const refreshToken =
      typeof value.refresh_token === "string"
        ? value.refresh_token
        : previousRefresh;
    if (
      typeof value.access_token !== "string" ||
      !value.access_token ||
      !refreshToken ||
      typeof value.expires_in !== "number" ||
      value.expires_in <= 0
    ) {
      throw new ProviderError(
        "Schwab returned an incomplete authorization response.",
      );
    }
    return {
      accessToken: value.access_token,
      refreshToken,
      expiresAt: this.now() + value.expires_in * 1000,
    };
  }
  private async token(forceRefresh = false): Promise<TokenSet> {
    if (!this.configured)
      throw new ProviderError(
        "Configure Schwab server credentials before scanning live data.",
        409,
      );
    const tokens = this.readTokens();
    if (!tokens || this.reconnect)
      throw new ProviderError("Connect Schwab before scanning live data.", 401);
    if (!forceRefresh && tokens.expiresAt > this.now() + 60_000) return tokens;
    if (!this.refreshPromise) {
      const generation = this.revision;
      this.refreshPromise = this.exchange(
        new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refreshToken,
        }),
        tokens.refreshToken,
      )
        .then((next) => {
          if (generation !== this.revision)
            throw new ProviderError(
              "Schwab was disconnected while authorization was refreshing.",
              401,
            );
          this.save(next);
          return next;
        })
        .catch((error) => {
          if (
            generation === this.revision &&
            error instanceof ProviderError &&
            error.status === 401
          )
            this.reconnect = true;
          throw error;
        })
        .finally(() => {
          this.refreshPromise = null;
        });
    }
    return this.refreshPromise;
  }
  async marketData(
    path: string,
    params: Record<string, string>,
  ): Promise<unknown> {
    if (!["/quotes", "/chains", "/pricehistory", "/markets"].includes(path))
      throw new ProviderError("Unsupported market-data endpoint.", 400);
    const generation = this.revision;
    const stillConnected = () => {
      if (generation !== this.revision)
        throw new ProviderError(
          "Schwab connection changed during the request.",
          409,
        );
    };
    const url = new URL(`${MARKET_URL}${path}`);
    url.search = new URLSearchParams(params).toString();
    const request = async (tokens: TokenSet) => {
      try {
        return await this.fetcher(url, {
          headers: {
            Authorization: `Bearer ${tokens.accessToken}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        throw new ProviderError(
          "Schwab market data request timed out or could not connect.",
        );
      }
    };
    let response = await request(await this.token());
    stillConnected();
    if (response.status === 401) {
      response = await request(await this.token(true));
      stillConnected();
    }
    if (!response.ok) {
      if (response.status === 401) this.reconnect = true;
      const message =
        response.status === 429
          ? "Schwab rate limit reached. Wait before scanning again."
          : response.status === 401
            ? "Schwab authorization expired. Reconnect your account."
            : response.status === 403
              ? "Schwab denied market data access. Verify your product approval and data entitlements."
              : `Schwab market data returned HTTP ${response.status}.`;
      throw new ProviderError(
        message,
        response.status === 429 ? 429 : response.status === 401 ? 401 : 502,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new ProviderError(
        "Schwab returned an unreadable market-data response.",
      );
    }
  }
}
