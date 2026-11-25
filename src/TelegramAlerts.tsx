import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Bell,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Send,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import type { SourceMode } from "../shared/types";
import type { TelegramStatus } from "../shared/notifications";

type Props = {
  mode: SourceMode;
  schwabConnected: boolean;
  onError: (error: unknown) => void;
};
type RequestError = Error & { status?: number; code?: string };
const base = "/api/notifications/telegram";
const stamp = (value: number) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(value) + " ET";

export default function TelegramAlerts({
  mode,
  schwabConnected,
  onError,
}: Props) {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [notice, setNotice] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const tokenInput = useRef<HTMLInputElement>(null);
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const mounted = useRef(false);
  const generation = useRef(0);
  const mutating = useRef(false);
  const fetching = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const setTokenInput = useCallback((node: HTMLInputElement | null) => {
    if (!node && tokenInput.current) tokenInput.current.value = "";
    tokenInput.current = node;
  }, []);

  const request = useCallback(
    async (path = "", method = "GET", body?: unknown) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const response = await fetch(base + path, {
          method,
          signal: controller.signal,
          headers:
            body === undefined
              ? undefined
              : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const result = await response
          .json()
          .catch(() => ({
            error: "Telegram status could not be read. Please try again.",
          }));
        if (!response.ok)
          throw Object.assign(
            new Error(
              result.error || "Telegram could not complete that request.",
            ),
            { status: response.status, code: result.code },
          );
        return result as TelegramStatus;
      } finally {
        controllers.current.delete(controller);
      }
    },
    [],
  );

  const report = useCallback((caught: unknown, polling = false) => {
    const failure = caught as RequestError;
    if (failure.name === "AbortError" || !mounted.current) return;
    if (failure.code === "OWNER_AUTH_REQUIRED") {
      errorHandler.current(failure);
      return;
    }
    (polling ? setPollError : setError)(
      failure.message ||
        "Telegram is temporarily unavailable. Please try again.",
    );
  }, []);

  const refresh = useCallback(async () => {
    if (fetching.current || mutating.current) return;
    fetching.current = true;
    const current = generation.current;
    try {
      const next = await request();
      if (mounted.current && current === generation.current) {
        setStatus(next);
        setPollError("");
      }
    } catch (caught) {
      if (current === generation.current) report(caught, true);
    } finally {
      if (current === generation.current) {
        fetching.current = false;
        if (mounted.current) setLoading(false);
      }
    }
  }, [request, report]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      fetching.current = false;
      clearInterval(timer);
      for (const controller of controllers.current) controller.abort();
      if (tokenInput.current) tokenInput.current.value = "";
    };
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const mutate = async (
    action: string,
    path: string,
    method: string,
    body: unknown,
    success: string,
    completed?: () => void,
  ) => {
    if (mutating.current) return;
    mutating.current = true;
    generation.current += 1;
    fetching.current = false;
    for (const controller of controllers.current) controller.abort();
    setPending(action);
    setError("");
    setNotice("");
    try {
      const next = await request(path, method, body);
      if (mounted.current) {
        setStatus(next);
        setPollError("");
        setNotice(success);
        completed?.();
      }
    } catch (caught) {
      report(caught);
    } finally {
      mutating.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const configure = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const token = tokenInput.current?.value.trim() || "";
    if (!token) return;
    void mutate(
      "configure",
      "/configure",
      "POST",
      { token },
      "Bot connected. Pair your private chat next.",
      () => {
        form.reset();
        if (tokenInput.current) tokenInput.current.value = "";
        setHasToken(false);
      },
    );
  };

  const busy = pending !== null;
  const canEnable = !!status?.paired && schwabConnected && mode === "schwab";
  const pairingExpired =
    !!status?.pairingExpiresAt && status.pairingExpiresAt <= Date.now();
  const pairingUrl =
    !pairingExpired && status?.pairingUrl?.startsWith("https://t.me/")
      ? status.pairingUrl
      : null;
  const statusLabel = !status
    ? "Loading"
    : !status.available
      ? "Unavailable"
      : status.enabled
        ? canEnable
          ? "Alerts on"
          : "Paused"
        : status.paired
          ? "Paired"
          : status.configured
            ? "Ready to pair"
            : "Not connected";

  return (
    <section
      className="panel telegram-panel"
      aria-labelledby="telegram-heading"
    >
      <div className="provider-heading">
        <div className="telegram-mark">
          <Send size={25} />
        </div>
        <div>
          <h2 id="telegram-heading">Telegram alerts</h2>
          <p>Your signal brief, wherever you are</p>
        </div>
        <span className={`pill ${status?.paired ? "closed-pill" : ""}`}>
          {statusLabel}
        </span>
      </div>
      <p className="connection-description">
        Send Meida’s conditional trader reads to your own private Telegram chat.
        You decide what to do; messages never place orders.
      </p>

      {(error || pollError) && (
        <div className="feedback error telegram-feedback" role="alert">
          <CircleHelp size={17} />
          <span>{error || pollError}</span>
        </div>
      )}
      {notice && (
        <div className="feedback success telegram-feedback" role="status">
          <CheckCircle2 size={17} />
          <span>{notice}</span>
        </div>
      )}

      {loading && !status ? (
        <div className="telegram-loading" role="status">
          <LoaderCircle size={18} className="spin" />
          Checking Telegram connection…
        </div>
      ) : !status ? (
        <button className="button secondary" onClick={() => void refresh()}>
          <RefreshCw size={16} />
          Retry connection check
        </button>
      ) : !status.available ? (
        <div className="telegram-unavailable">
          <LockKeyhole size={19} />
          <p>
            {status.message ||
              "Telegram setup is unavailable until server encryption is configured."}
          </p>
        </div>
      ) : (
        <>
          {!status.configured && (
            <div className="telegram-setup">
              <div className="telegram-step-heading">
                <span className="step-icon">
                  <span />
                </span>
                <div>
                  <h3>Create a dedicated bot</h3>
                  <p>
                    Open{" "}
                    <a
                      href="https://t.me/BotFather"
                      target="_blank"
                      rel="noreferrer"
                    >
                      @BotFather <ExternalLink size={12} />
                    </a>
                    , send <code>/newbot</code>, and follow the prompts. Use a
                    bot dedicated to Meida.
                  </p>
                </div>
              </div>
              <form className="telegram-token-form" onSubmit={configure}>
                <label htmlFor="telegram-bot-token">
                  Bot token
                  <input
                    ref={setTokenInput}
                    id="telegram-bot-token"
                    name="telegram-bot-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the token from BotFather"
                    required
                    maxLength={256}
                    disabled={busy}
                    onChange={(event) =>
                      setHasToken(event.target.value.trim().length > 0)
                    }
                  />
                </label>
                <p className="telegram-token-note">
                  <LockKeyhole size={13} />
                  Encrypted on the server. Never saved in browser storage.
                </p>
                <button className="button primary" disabled={busy || !hasToken}>
                  {pending === "configure" ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Check size={16} />
                  )}
                  Connect bot
                </button>
              </form>
            </div>
          )}

          {status.configured && !status.paired && (
            <div className="telegram-pairing">
              <div className="telegram-step-heading">
                <span className="step-icon">
                  <span />
                </span>
                <div>
                  <h3>Pair your private chat</h3>
                  <p>
                    {status.botUsername
                      ? `Your bot @${status.botUsername.replace(/^@/, "")} is ready. `
                      : "Your bot is ready. "}
                    Generate a private pairing link, open it in Telegram, and
                    press <strong>Start</strong>. Then confirm below.
                  </p>
                </div>
              </div>
              {pairingUrl ? (
                <>
                  <div className="telegram-actions">
                    <a
                      className="button primary"
                      href={pairingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={16} />
                      Open private pairing link
                    </a>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          "confirm",
                          "/confirm",
                          "POST",
                          {},
                          "Private chat paired. You can send a test message.",
                        )
                      }
                    >
                      {pending === "confirm" ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Check size={16} />
                      )}
                      I’ve started the bot
                    </button>
                  </div>
                  {status.pairingExpiresAt && (
                    <p className="telegram-pairing-expiry">
                      <Clock3 size={13} />
                      Pairing link expires {stamp(status.pairingExpiresAt)}.
                      Keep it private.
                    </p>
                  )}
                </>
              ) : (
                <div className="telegram-actions">
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        "pair",
                        "/pair",
                        "POST",
                        {},
                        "Pairing link ready. Open it in Telegram and press Start.",
                      )
                    }
                  >
                    {pending === "pair" ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <LockKeyhole size={16} />
                    )}
                    {pairingExpired
                      ? "Create a new pairing link"
                      : "Create private pairing link"}
                  </button>
                </div>
              )}
            </div>
          )}

          {status.paired && (
            <div className="telegram-paired">
              <span className="step-icon done">
                <Check size={16} />
              </span>
              <div>
                <strong>{status.chatLabel || "Private chat paired"}</strong>
                <span>
                  {status.botUsername
                    ? `@${status.botUsername.replace(/^@/, "")}`
                    : "Your dedicated Meida bot"}
                </span>
              </div>
              <ShieldCheck size={18} />
            </div>
          )}

          {status.paired && (
            <div className="telegram-settings">
              <label className="telegram-enable">
                <span>
                  <strong>Send market alerts</strong>
                  <span>
                    Scan in the background every 60 seconds during regular
                    market hours, even when this page is closed.
                  </span>
                </span>
                <span className="rule-switch">
                  <input
                    type="checkbox"
                    checked={status.enabled}
                    disabled={busy || (!status.enabled && !canEnable)}
                    onChange={(event) =>
                      void mutate(
                        "settings",
                        "",
                        "PUT",
                        {
                          enabled: event.target.checked,
                          horizon: status.horizon,
                        },
                        event.target.checked
                          ? "Telegram market alerts enabled."
                          : "Telegram market alerts paused.",
                      )
                    }
                  />
                  <span className="toggle-track" />
                </span>
              </label>
              {!canEnable && (
                <p className="telegram-enable-hint">
                  <CircleHelp size={14} />
                  {!schwabConnected
                    ? "Connect Schwab to enable market alerts."
                    : "Choose Schwab data at the top of the page to enable market alerts."}{" "}
                  Demo signals are never sent.
                </p>
              )}
              <div className="telegram-horizon">
                <label htmlFor="telegram-horizon">Trading horizon</label>
                <span className="source-select">
                  <select
                    id="telegram-horizon"
                    value={status.horizon}
                    disabled={busy || (status.enabled && !canEnable)}
                    onChange={(event) =>
                      void mutate(
                        "settings",
                        "",
                        "PUT",
                        {
                          enabled: status.enabled,
                          horizon: event.target.value,
                        },
                        "Telegram horizon updated.",
                      )
                    }
                  >
                    <option value="all">Intraday & swing</option>
                    <option value="intraday">Intraday only</option>
                    <option value="swing">Swing only</option>
                  </select>
                  <ChevronDown size={14} />
                </span>
              </div>
              <div className="telegram-actions">
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      "test",
                      "/test",
                      "POST",
                      {},
                      "Test message sent. Check your private Telegram chat.",
                    )
                  }
                >
                  {pending === "test" ? (
                    <LoaderCircle size={16} className="spin" />
                  ) : (
                    <Send size={16} />
                  )}
                  Send test message
                </button>
              </div>
            </div>
          )}

          {status.configured && (
            <div className="telegram-status-area">
              <p className="connection-status-text">{status.message}</p>
              {status.lastError && (
                <div className="telegram-delivery-error" role="status">
                  <CircleHelp size={15} />
                  <span>{status.lastError}</span>
                </div>
              )}
              <dl className="telegram-timestamps">
                <div>
                  <dt>Last background scan</dt>
                  <dd>
                    {status.lastScanAt
                      ? stamp(status.lastScanAt)
                      : "Not scanned yet"}
                  </dd>
                </div>
                <div>
                  <dt>Last market alert sent</dt>
                  <dd>
                    {status.lastSentAt
                      ? stamp(status.lastSentAt)
                      : "No market alerts yet"}
                  </dd>
                </div>
              </dl>
              <button
                className="text-button telegram-disconnect"
                disabled={busy}
                onClick={() =>
                  void mutate(
                    "disconnect",
                    "",
                    "DELETE",
                    undefined,
                    "Telegram disconnected. Background alerts are stopped.",
                  )
                }
              >
                {pending === "disconnect" ? (
                  <LoaderCircle size={14} className="spin" />
                ) : (
                  <Unplug size={14} />
                )}
                Disconnect Telegram
              </button>
            </div>
          )}
        </>
      )}

      <div className="telegram-delivery-note">
        <Bell size={16} />
        <p>
          Demo signals are never sent. Delivery sends the first qualifying alert
          for each instrument, rule, and direction per market day, up to 3
          messages per minute. Remaining candidates are sent only if still
          current.
        </p>
      </div>
    </section>
  );
}
