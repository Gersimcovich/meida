import { createHash, randomBytes } from "node:crypto";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import {
  decryptToken,
  encryptToken,
  ProviderError,
  type SchwabAuth,
} from "./auth.ts";
import type { ScanCoordinator } from "./scanner.ts";
import { regularMarketOpen } from "./schwab.ts";
import { TelegramClient, TelegramError, formatAlert } from "./telegram.ts";
import type { ScanResult } from "../shared/types.ts";
import type { AlertHorizon, TelegramStatus } from "../shared/notifications.ts";

interface Connection {
  token: string;
  username: string;
  chatId: string | null;
  offset?: number;
  pairing: { code: string; expiresAt: number } | null;
}
interface Preferences {
  enabled: boolean;
  horizon: AlertHorizon;
}
interface Receipt {
  at: number;
  state: "attempted" | "accepted" | "uncertain";
}
interface Dependencies {
  config: Config;
  store: Store;
  auth: Pick<SchwabAuth, "status" | "revision" | "marketData">;
  scanner: Pick<ScanCoordinator, "run" | "revision">;
  client?: (
    token: string,
  ) => Pick<
    TelegramClient,
    "getMe" | "assertPollingAvailable" | "getUpdates" | "sendMessage"
  >;
  now?: () => number;
}
const ny = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
function session(time: number) {
  const p = Object.fromEntries(
    ny.formatToParts(time).map((v) => [v.type, v.value]),
  );
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    possible:
      !["Sat", "Sun"].includes(p.weekday) && minute >= 570 && minute < 960,
  };
}
const fresh = (time: number, now: number) =>
  Number.isFinite(time) &&
  time > 0 &&
  now - time <= 120_000 &&
  time <= now + 5_000;

/** Single-owner, single-process delivery. Ambiguous sends are never retried automatically. */
export class TelegramNotifications {
  private readonly now: () => number;
  private readonly client: NonNullable<Dependencies["client"]>;
  private generation = 0;
  private setupBusy = false;
  private sending = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastScanAttempt = -Infinity;
  private latest: {
    result: ScanResult;
    hours: unknown;
    revision: number;
    authRevision: number;
    generation: number;
  } | null = null;

  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.client = deps.client ?? ((token) => new TelegramClient(token));
  }
  private get nextSendAt(): number {
    return this.deps.store.get("telegramNextSendAt", 0);
  }
  private set nextSendAt(value: number) {
    this.deps.store.set("telegramNextSendAt", value);
  }
  private get nextTestAt(): number {
    return this.deps.store.get("telegramNextTestAt", 0);
  }
  private set nextTestAt(value: number) {
    this.deps.store.set("telegramNextTestAt", value);
  }
  private preferences(): Preferences {
    return this.deps.store.get("telegramPreferences", {
      enabled: false,
      horizon: "all",
    });
  }
  private connection(): Connection | null {
    const encrypted = this.deps.store.get<string | null>(
      "telegramConnection",
      null,
    );
    if (!encrypted || !this.deps.config.encryptionKey) return null;
    try {
      return decryptToken<Connection>(
        encrypted,
        this.deps.config.encryptionKey,
      );
    } catch {
      return null;
    }
  }
  private save(connection: Connection) {
    this.deps.store.set(
      "telegramConnection",
      encryptToken(connection, this.deps.config.encryptionKey),
    );
  }
  private error(message: string | null) {
    this.deps.store.set("telegramLastError", message);
  }
  status(): TelegramStatus {
    const c = this.connection(),
      p = this.preferences();
    const available = /^[a-f\d]{64}$/i.test(this.deps.config.encryptionKey);
    const pairing =
      c?.pairing && c.pairing.expiresAt > this.now() ? c.pairing : null;
    let message = "Create a dedicated Telegram bot, then connect it here.";
    if (!available)
      message =
        "The server needs its token-encryption key before Telegram setup.";
    else if (c && !c.chatId)
      message =
        "Open the pairing link, press Start in Telegram, then confirm here.";
    else if (c?.chatId && !p.enabled)
      message = "Private chat paired. Enable alerts when you are ready.";
    else if (p.enabled && !this.deps.auth.status().connected)
      message = "Alerts are paused until Schwab is connected.";
    else if (p.enabled && this.deps.store.mode !== "schwab")
      message =
        "Alerts are paused while Demo is selected. Choose Schwab data to resume.";
    else if (p.enabled)
      message =
        "Background alerts enabled. Fresh signals are checked every 60 seconds during confirmed regular market hours.";
    if (available && !c && this.deps.store.get("telegramConnection", null))
      message = "Saved Telegram credentials cannot be read. Reconnect the bot.";
    return {
      available,
      configured: !!c,
      paired: !!c?.chatId,
      enabled: p.enabled,
      horizon: p.horizon,
      botUsername: c?.username ?? null,
      chatLabel: c?.chatId ? `Private chat •••${c.chatId.slice(-4)}` : null,
      pairingUrl:
        c && pairing
          ? `https://t.me/${c.username}?start=${pairing.code}`
          : null,
      pairingExpiresAt: pairing?.expiresAt ?? null,
      lastScanAt: this.deps.store.get("telegramLastScanAt", null),
      lastSentAt: this.deps.store.get("telegramLastSentAt", null),
      lastError:
        this.deps.store.get("telegramScanError", null) ??
        this.deps.store.get("telegramLastError", null),
      message,
    };
  }
  private async setup<T>(work: () => Promise<T>): Promise<T> {
    if (this.setupBusy)
      throw new ProviderError("Telegram setup is already running.", 409);
    this.setupBusy = true;
    try {
      return await work();
    } catch (error) {
      if (error instanceof TelegramError)
        throw new ProviderError(
          error.message,
          error.status === 429 ? 429 : 502,
        );
      throw error;
    } finally {
      this.setupBusy = false;
    }
  }
  async configure(token: string) {
    if (!this.status().available)
      throw new ProviderError(
        "Configure the server token-encryption key first.",
        409,
      );
    return this.setup(async () => {
      const revision = ++this.generation;
      const client = this.client(token);
      const me = await client.getMe();
      await client.assertPollingAvailable();
      if (revision !== this.generation)
        throw new ProviderError("Telegram setup changed. Try again.", 409);
      this.save({
        token,
        username: me.username,
        chatId: null,
        pairing: {
          code: randomBytes(24).toString("hex"),
          expiresAt: this.now() + 600_000,
        },
      });
      this.deps.store.set("telegramPreferences", {
        ...this.preferences(),
        enabled: false,
      });
      this.latest = null;
      this.error(null);
      return this.status();
    });
  }
  async pair() {
    return this.setup(async () => {
      const c = this.connection();
      if (!c)
        throw new ProviderError("Configure your Telegram bot first.", 409);
      const revision = ++this.generation;
      await this.client(c.token).assertPollingAvailable();
      if (revision !== this.generation)
        throw new ProviderError("Telegram setup changed. Try again.", 409);
      c.chatId = null;
      c.pairing = {
        code: randomBytes(24).toString("hex"),
        expiresAt: this.now() + 600_000,
      };
      this.save(c);
      this.deps.store.set("telegramPreferences", {
        ...this.preferences(),
        enabled: false,
      });
      this.latest = null;
      return this.status();
    });
  }
  async confirm() {
    return this.setup(async () => {
      const c = this.connection();
      if (!c?.pairing || c.pairing.expiresAt <= this.now())
        throw new ProviderError(
          "The pairing link expired. Create a new pairing link.",
          409,
        );
      const revision = this.generation;
      const client = this.client(c.token);
      await client.assertPollingAvailable();
      for (let page = 0; page < 3; page++) {
        const updates = await client.getUpdates(c.offset);
        if (revision !== this.generation || c.pairing.expiresAt <= this.now())
          throw new ProviderError(
            "Telegram pairing changed or expired. Start again.",
            409,
          );
        for (const update of updates) {
          c.offset = Math.max(c.offset ?? 0, update.update_id + 1);
          const m = update.message;
          if (
            m?.chat.type === "private" &&
            m.from?.is_bot === false &&
            m.from.id === m.chat.id &&
            m.text?.trim() === `/start ${c.pairing.code}`
          ) {
            c.chatId = String(m.chat.id);
            c.pairing = null;
            this.generation++;
            this.save(c);
            this.error(null);
            return this.status();
          }
        }
        this.save(c);
        if (updates.length < 100) break;
      }
      throw new ProviderError(
        "No matching Start message yet. Open the pairing link and press Start, then confirm again.",
        409,
      );
    });
  }
  setPreferences(p: Preferences) {
    if (p.enabled && !this.connection()?.chatId)
      throw new ProviderError("Pair your private Telegram chat first.", 409);
    if (
      p.enabled &&
      (!this.deps.auth.status().connected || this.deps.store.mode !== "schwab")
    )
      throw new ProviderError(
        "Connect Schwab and select Schwab data before enabling alerts.",
        409,
      );
    this.generation++;
    this.latest = null;
    this.lastScanAttempt = -Infinity;
    this.deps.store.set("telegramPreferences", p);
    return this.status();
  }
  disconnect() {
    this.generation++;
    this.latest = null;
    this.deps.store.delete("telegramConnection");
    this.deps.store.set("telegramPreferences", {
      ...this.preferences(),
      enabled: false,
    });
    this.error(null);
    this.deps.store.delete("telegramScanError");
    return this.status();
  }
  async test() {
    const c = this.connection();
    if (!c?.chatId)
      throw new ProviderError("Pair your private Telegram chat first.", 409);
    if (
      this.setupBusy ||
      this.sending ||
      this.now() < Math.max(this.nextSendAt, this.nextTestAt)
    )
      throw new ProviderError(
        "Wait before sending another Telegram test.",
        429,
      );
    const generation = this.generation;
    this.sending = true;
    this.nextTestAt = this.now() + 60_000;
    this.nextSendAt = this.now() + 1_100;
    try {
      await this.client(c.token).sendMessage(
        c.chatId,
        `Meida connection test\nYour private Telegram chat is connected. This is a setup test, not a market signal.\n${this.deps.config.origin}`,
      );
      if (generation === this.generation) this.error(null);
      return this.status();
    } catch (error) {
      if (error instanceof TelegramError) {
        if (generation === this.generation && error.retryAfter)
          this.nextSendAt = this.now() + error.retryAfter * 1000;
        throw new ProviderError(
          error.message,
          error.status === 429 ? 429 : 502,
        );
      }
      throw error;
    } finally {
      this.sending = false;
    }
  }
  private eligible() {
    return (
      !this.stopped &&
      !this.setupBusy &&
      this.preferences().enabled &&
      !!this.connection()?.chatId &&
      this.deps.store.mode === "schwab" &&
      this.deps.auth.status().connected &&
      session(this.now()).possible
    );
  }
  /** Exposed for deterministic tests; runtime calls this every 20 seconds, scans at most once/minute. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const task = this.work().catch(() =>
      this.deps.store.set(
        "telegramScanError",
        "Background scanning could not complete. Check the Schwab connection and retry.",
      ),
    );
    this.running = task.finally(() => {
      this.running = null;
    });
    return this.running;
  }
  private async work() {
    if (!this.eligible()) {
      this.latest = null;
      return;
    }
    if (this.now() - this.lastScanAttempt >= 60_000) {
      this.lastScanAttempt = this.now();
      this.latest = null;
      const revision = this.deps.scanner.revision,
        authRevision = this.deps.auth.revision,
        generation = this.generation;
      try {
        const hours = await this.deps.auth.marketData("/markets", {
          markets: "equity,option",
          date: session(this.now()).date,
        });
        if (
          !this.eligible() ||
          revision !== this.deps.scanner.revision ||
          authRevision !== this.deps.auth.revision ||
          generation !== this.generation
        )
          return;
        if (!regularMarketOpen(hours, this.now())) {
          this.deps.store.delete("telegramScanError");
          return;
        }
        const result = await this.deps.scanner.run("schwab");
        if (
          !this.eligible() ||
          revision !== this.deps.scanner.revision ||
          authRevision !== this.deps.auth.revision ||
          generation !== this.generation
        )
          return;
        this.latest = { result, hours, revision, authRevision, generation };
        this.deps.store.set("telegramLastScanAt", this.now());
        this.deps.store.delete("telegramScanError");
      } catch (error) {
        if (error instanceof ProviderError && [409, 429].includes(error.status))
          return;
        if (generation === this.generation)
          this.deps.store.set(
            "telegramScanError",
            "Background scanning could not complete. Check the Schwab connection and data access.",
          );
        return;
      }
    }
    const latest = this.latest;
    if (
      !latest ||
      !this.eligible() ||
      latest.generation !== this.generation ||
      latest.revision !== this.deps.scanner.revision ||
      latest.authRevision !== this.deps.auth.revision ||
      this.sending ||
      this.now() < this.nextSendAt
    )
      return;
    const result = latest.result,
      now = this.now();
    if (
      result.mode !== "schwab" ||
      !result.marketOpen ||
      !regularMarketOpen(latest.hours, now) ||
      !fresh(result.asOf, now)
    )
      return;
    const c = this.connection()!,
      p = this.preferences();
    const receipts = this.deps.store.get<Record<string, Receipt>>(
      "telegramReceipts",
      {},
    );
    for (const [key, receipt] of Object.entries(receipts))
      if (now - receipt.at > 3 * 86_400_000) delete receipts[key];
    const candidates = result.signals
      .filter(
        (s) =>
          s.mode === "schwab" &&
          fresh(s.timestamp, now) &&
          (p.horizon === "all" || p.horizon === s.horizon),
      )
      .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
    for (const signal of candidates) {
      const key = createHash("sha256")
        .update(`${c.username}:${c.chatId}:${signal.id}:${signal.direction}`)
        .digest("hex");
      if (receipts[key]) continue;
      const text = formatAlert(signal, this.deps.config.origin);
      // Record BEFORE the network call: a crash or timeout may have happened after Telegram accepted it.
      receipts[key] = { at: now, state: "attempted" };
      this.deps.store.set("telegramReceipts", receipts);
      this.sending = true;
      this.nextSendAt = now + 20_000;
      try {
        await this.client(c.token).sendMessage(c.chatId!, text);
        receipts[key].state = "accepted";
        if (latest.generation === this.generation) {
          this.deps.store.set("telegramLastSentAt", this.now());
          this.error(null);
        }
      } catch (error) {
        if (error instanceof TelegramError && error.status === 429) {
          delete receipts[key];
          if (latest.generation === this.generation) {
            this.nextSendAt =
              this.now() + Math.max(20, error.retryAfter ?? 60) * 1000;
            this.error(
              "Telegram rate limited delivery. A still-current signal may be retried after the cooldown.",
            );
          }
        } else {
          receipts[key].state = "uncertain";
          if (latest.generation === this.generation) {
            this.error(
              "Telegram did not confirm delivery. This alert will not be retried automatically, to avoid duplicates. Use Send test to check the connection.",
            );
            if (
              error instanceof TelegramError &&
              [401, 403].includes(error.status)
            )
              this.deps.store.set("telegramPreferences", {
                ...p,
                enabled: false,
              });
          }
        }
      } finally {
        this.deps.store.set("telegramReceipts", receipts);
        this.sending = false;
      }
      break; // At most one signal every 20 seconds; no stale backlog or burst on reconnect.
    }
  }
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 20_000);
    this.timer.unref();
    void this.tick();
  }
  async stop() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
