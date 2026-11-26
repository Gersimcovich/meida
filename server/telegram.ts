import type { Signal } from "../shared/types.js";

const TOKEN_PATTERN = /^\d{5,20}:[A-Za-z0-9_-]{20,120}$/;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_MESSAGE_LENGTH = 4096;

const ERRORS = {
  configuration: { status: 400, message: "Telegram configuration is invalid." },
  invalid_request: { status: 400, message: "The Telegram request is invalid." },
  authentication: {
    status: 401,
    message:
      "Telegram bot authentication failed. Check the configured bot token.",
  },
  forbidden: {
    status: 403,
    message:
      "Telegram could not access this chat. Start the bot or check its permissions.",
  },
  conflict: {
    status: 409,
    message:
      "Telegram updates are being handled elsewhere. Use a dedicated bot for Meida.",
  },
  webhook: {
    status: 409,
    message:
      "This Telegram bot has an existing webhook. Use a dedicated bot or resolve its webhook configuration before polling.",
  },
  rate_limit: {
    status: 429,
    message:
      "Telegram is rate limiting requests. Retry after the indicated delay.",
  },
  response: {
    status: 502,
    message: "Telegram returned an invalid or oversized response.",
  },
  unavailable: {
    status: 502,
    message: "Telegram is temporarily unavailable. Try again later.",
  },
  network: {
    status: 502,
    message: "Telegram could not be reached. Check connectivity and try again.",
  },
  demo: {
    status: 400,
    message:
      "Only live Schwab signals can be formatted as Telegram research alerts.",
  },
} as const;
type TelegramErrorCode = keyof typeof ERRORS;

/** Errors deliberately contain no provider text, request URL, token, or nested cause. */
export class TelegramError extends Error {
  readonly status: number;
  readonly code: TelegramErrorCode;
  readonly retryAfter?: number;

  constructor(code: TelegramErrorCode, retryAfter?: number) {
    super(ERRORS[code].message);
    this.name = "TelegramError";
    this.code = code;
    this.status = ERRORS[code].status;
    if (
      code === "rate_limit" &&
      Number.isSafeInteger(retryAfter) &&
      retryAfter! > 0
    ) {
      this.retryAfter = Math.min(retryAfter!, 86_400);
    }
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number; type: string };
    from?: { id: number; is_bot: boolean };
  };
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
function integer(value: unknown): number | null {
  const parsed =
    typeof value === "string" && /^-?\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed)
    ? parsed
    : null;
}

function responseError(status: number, payload: RecordValue): TelegramError {
  if (status === 401 || status === 404)
    return new TelegramError("authentication");
  if (status === 403) return new TelegramError("forbidden");
  if (status === 409) return new TelegramError("conflict");
  if (status === 429)
    return new TelegramError(
      "rate_limit",
      integer(record(payload.parameters).retry_after) ?? undefined,
    );
  return new TelegramError("unavailable");
}

async function boundedJson(response: Response): Promise<RecordValue> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES)
    throw new TelegramError("response");
  if (!response.body) throw new TelegramError("response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new TelegramError("response");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error();
    return parsed as RecordValue;
  } catch {
    throw new TelegramError("response");
  }
}

export class TelegramClient {
  #token: string;
  #fetcher: typeof fetch;

  constructor(token: string, fetcher: typeof fetch = fetch) {
    if (!TOKEN_PATTERN.test(token)) throw new TelegramError("configuration");
    this.#token = token;
    this.#fetcher = fetcher;
  }

  async #request(
    method: "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage",
    body: RecordValue = {},
  ): Promise<unknown> {
    try {
      const response = await this.#fetcher(
        `https://api.telegram.org/bot${this.#token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(10_000),
        },
      );
      let payload: RecordValue;
      try {
        payload = await boundedJson(response);
      } catch (error) {
        if (!response.ok) throw responseError(response.status, {});
        throw error;
      }
      if (!response.ok || payload.ok !== true) {
        const status = integer(payload.error_code) ?? response.status;
        throw responseError(status, payload);
      }
      return payload.result;
    } catch (error) {
      if (error instanceof TelegramError) throw error;
      throw new TelegramError("network");
    }
  }

  async getMe(): Promise<{ id: number; username: string }> {
    const result = record(await this.#request("getMe"));
    const id = integer(result.id);
    if (
      id === null ||
      id <= 0 ||
      result.is_bot !== true ||
      typeof result.username !== "string" ||
      !/^[A-Za-z0-9_]{5,32}$/.test(result.username)
    )
      throw new TelegramError("response");
    return { id, username: result.username };
  }

  async assertPollingAvailable(): Promise<void> {
    const result = record(await this.#request("getWebhookInfo"));
    if (typeof result.url !== "string") throw new TelegramError("response");
    if (result.url !== "") throw new TelegramError("webhook");
  }

  async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
      throw new TelegramError("invalid_request");
    const result = await this.#request("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      limit: 100,
      timeout: 0,
      allowed_updates: ["message"],
    });
    if (!Array.isArray(result) || result.length > 100)
      throw new TelegramError("response");
    const updates: TelegramUpdate[] = [];
    for (const candidate of result) {
      const raw = record(candidate);
      const updateId = integer(raw.update_id);
      if (updateId === null || updateId < 0) continue;
      const update: TelegramUpdate = { update_id: updateId };
      const rawMessage = record(raw.message);
      const chat = record(rawMessage.chat);
      const chatId = integer(chat.id);
      if (
        chatId !== null &&
        chatId !== 0 &&
        typeof chat.type === "string" &&
        ["private", "group", "supergroup", "channel"].includes(chat.type)
      ) {
        const message: NonNullable<TelegramUpdate["message"]> = {
          chat: { id: chatId, type: chat.type },
        };
        if (
          typeof rawMessage.text === "string" &&
          rawMessage.text.length <= MAX_MESSAGE_LENGTH
        )
          message.text = rawMessage.text;
        const from = record(rawMessage.from);
        const fromId = integer(from.id);
        if (fromId !== null && fromId > 0 && typeof from.is_bot === "boolean")
          message.from = { id: fromId, is_bot: from.is_bot };
        update.message = message;
      }
      updates.push(update);
    }
    return updates.sort((a, b) => a.update_id - b.update_id);
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    const numericId = integer(chatId);
    if (
      !/^-?[1-9]\d{0,15}$/.test(chatId) ||
      numericId === null ||
      !text.trim() ||
      text.length > MAX_MESSAGE_LENGTH
    )
      throw new TelegramError("invalid_request");
    const result = record(
      await this.#request("sendMessage", {
        chat_id: String(numericId),
        text,
        link_preview_options: { is_disabled: true },
      }),
    );
    const messageId = integer(result.message_id);
    if (messageId === null || messageId <= 0)
      throw new TelegramError("response");
  }
}

const actionLabels = {
  watch: "Watch for confirmation",
  "review-long": "Review long setup",
  "review-short": "Review short setup",
  "review-activity": "Review options activity",
} as const;
const compact = (value: string, limit: number): string => {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit - 1)}…`;
};

/** Plain text; synthetic replay must never be advertised as a LIVE alert. */
export function formatAlert(signal: Signal, origin: string): string {
  if (signal.mode !== "schwab") throw new TelegramError("demo");
  if (
    !signal.plan ||
    !Number.isFinite(signal.timestamp) ||
    signal.timestamp <= 0
  )
    throw new TelegramError("invalid_request");
  let appUrl: URL;
  try {
    appUrl = new URL(origin);
  } catch {
    throw new TelegramError("configuration");
  }
  if (
    appUrl.username ||
    appUrl.password ||
    (appUrl.protocol !== "https:" &&
      !(
        appUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(appUrl.hostname)
      ))
  )
    throw new TelegramError("configuration");
  const safeUrl = `${appUrl.origin}/`;
  if (safeUrl.length > 300) throw new TelegramError("configuration");
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(signal.timestamp);
  const caution =
    signal.asset === "option"
      ? "Options volume/open interest does not establish trade direction, opening trades or institutional buying."
      : signal.cautions[0] ||
        "A research signal is not a trade instruction or a promise of profit.";
  const evidence = signal.evidence
    .slice(0, 6)
    .map((item) => `${compact(item.label, 55)}: ${compact(item.value, 145)}`)
    .join("\n");
  const message = [
    "Meida LIVE research alert",
    `${compact(signal.symbol, 30)} · ${signal.horizon === "swing" ? "Swing" : "Intraday"} · ${time} ET`,
    ...(signal.asset === "option" ? [compact(signal.instrument, 150)] : []),
    compact(signal.title, 100),
    `Action: ${actionLabels[signal.plan.action]}`,
    compact(signal.plan.headline, 150),
    "",
    evidence,
    "",
    `Confirmation: ${compact(signal.plan.trigger, 650)}`,
    `Invalidation: ${compact(signal.plan.invalidation, 450)}`,
    "",
    `Context: ${compact(caution, 450)}`,
    "Research only. Review current quotes and your risk budget before acting.",
    "",
    `Open Meida: ${safeUrl}`,
  ].join("\n");
  if (message.length >= 4000) throw new TelegramError("invalid_request");
  return message;
}
