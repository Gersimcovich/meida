import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Crosshair,
  ExternalLink,
  Eye,
  Filter,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Unplug,
  Waves,
  X,
} from "lucide-react";
import type {
  AppState,
  JournalEntry,
  Rules,
  ScanResult,
  Signal,
  SourceMode,
} from "../shared/types";

type View = "overview" | "watchlist" | "rules" | "journal" | "connections";
const NAV = [
  { id: "overview", label: "Signal overview", icon: Radar },
  { id: "watchlist", label: "Watchlist", icon: Eye },
  { id: "rules", label: "Alert rules", icon: SlidersHorizontal },
  { id: "journal", label: "Paper journal", icon: BookOpen },
] as const;
const RULES = [
  {
    id: "relative-volume",
    title: "Unusual stock volume",
    description:
      "Spot activity above the typical volume at this point in the session.",
    icon: Activity,
    tag: "Intraday",
  },
  {
    id: "opening-breakout",
    title: "Opening-range breakout",
    description:
      "Look for a price breakout supported by elevated relative volume.",
    icon: TrendingUp,
    tag: "Intraday",
  },
  {
    id: "vwap-cross",
    title: "VWAP cross",
    description:
      "Identify price crossing the session’s volume-weighted average.",
    icon: Waves,
    tag: "Intraday",
  },
  {
    id: "swing-breakout",
    title: "20-session breakout",
    description:
      "Find price exceeding the prior 20-session range with volume support.",
    icon: Crosshair,
    tag: "Swing",
  },
  {
    id: "option-activity",
    title: "Unusual options activity",
    description:
      "Compare contract volume with open interest and check quote liquidity.",
    icon: Layers3,
    tag: "Options",
  },
];
const usd = (n: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(n);
const pct = (n: number) => `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
const time = (n: number) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(n);
const day = (n: number) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  }).format(n);
async function api<T>(
  path: string,
  method = "GET",
  data?: unknown,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers:
      data === undefined ? undefined : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const payload = await response
    .json()
    .catch(() => ({ error: "The server returned an unreadable response." }));
  if (!response.ok)
    throw Object.assign(
      new Error(payload.error || "Something went wrong. Please try again."),
      { status: response.status, code: payload.code },
    );
  return payload;
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    const node = ref.current;
    node?.querySelector<HTMLElement>("input,button,select,textarea")?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
      if (event.key === "Tab") {
        const nodes = node?.querySelectorAll<HTMLElement>(
          "button:not([disabled]),input,select,textarea,a[href]",
        );
        if (!nodes?.length) return;
        const first = nodes[0],
          last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handle);
    return () => {
      document.removeEventListener("keydown", handle);
      prior?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function TraderRead({ signal }: { signal: Signal }) {
  const plan = signal.plan;
  if (!plan) return null;
  const actionLabels = {
    watch: "Watch for confirmation",
    "review-long": "Review long setup",
    "review-short": "Review short setup",
    "review-activity": "Review options activity",
  };
  const ActionIcon =
    plan.action === "review-long"
      ? ArrowUpRight
      : plan.action === "review-short"
        ? ArrowDownRight
        : plan.action === "review-activity"
          ? Layers3
          : Eye;
  return (
    <section className={`trader-read ${plan.action}`} aria-label="Trader read">
      <div className="trader-read-heading">
        <h3>
          <Crosshair size={16} />
          Trader read
        </h3>
        <span>CONDITIONAL PLAN</span>
      </div>
      <div className="trader-action">
        <ActionIcon size={18} />
        <strong>{actionLabels[plan.action]}</strong>
      </div>
      <p className="trader-headline">{plan.headline}</p>
      <dl className="trader-conditions">
        <div>
          <dt>Confirmation to look for</dt>
          <dd>{plan.trigger}</dd>
        </div>
        <div>
          <dt>Reassess or stand aside</dt>
          <dd>{plan.invalidation}</dd>
        </div>
      </dl>
      {plan.steps.length > 0 && (
        <details className="trader-next-steps">
          <summary>
            Next steps{" "}
            <span>
              {plan.steps.length} checks
              <ChevronDown size={14} />
            </span>
          </summary>
          <ol>
            {plan.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function PriceChart({ signal }: { signal: Signal }) {
  const data = signal.chart.filter((d) => Number.isFinite(d.price));
  if (data.length < 2)
    return (
      <div className="chart-empty">
        Price history is unavailable for this signal.
      </div>
    );
  const low = Math.min(...data.map((d) => d.price)),
    high = Math.max(...data.map((d) => d.price));
  const pad = Math.max((high - low) * 0.15, high * 0.001);
  const min = low - pad,
    max = high + pad;
  const points = data.map(
    (d, i) =>
      `${12 + (i / (data.length - 1)) * 372},${126 - ((d.price - min) / (max - min)) * 106}`,
  );
  const path = `M${points.join(" L")}`;
  const volumes = Math.max(...data.map((d) => d.volume), 1);
  return (
    <div className="chart">
      <div className="chart-top">
        <span>Session price history</span>
        <span>USD</span>
      </div>
      <svg
        role="img"
        aria-label={`${signal.symbol} underlying price history; ${usd(low)} to ${usd(high)}`}
        viewBox="0 0 396 172"
      >
        <defs>
          <linearGradient id="chart-gradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8170da" stopOpacity=".2" />
            <stop offset="100%" stopColor="#8170da" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[35, 75, 115].map((y) => (
          <line
            key={y}
            x1="12"
            x2="384"
            y1={y}
            y2={y}
            stroke="#e9e8ed"
            strokeDasharray="3 5"
          />
        ))}
        <path d={`${path} L384,136 L12,136 Z`} fill="url(#chart-gradient)" />
        {data.map((d, i) => (
          <rect
            key={`${d.time}-${i}`}
            x={12 + (i / (data.length - 1)) * 372}
            y={168 - (d.volume / volumes) * 23}
            width={Math.max(1, 330 / data.length)}
            height={(d.volume / volumes) * 23}
            rx="1"
            fill="#ded8f3"
          />
        ))}
        <path
          d={path}
          fill="none"
          stroke="#8972d9"
          strokeWidth="2.3"
          strokeLinejoin="round"
        />
        <circle
          cx="384"
          cy={126 - ((data[data.length - 1].price - min) / (max - min)) * 106}
          r="3.5"
          fill="#8972d9"
        />
      </svg>
      <div className="chart-axis">
        <span>{time(data[0].time)}</span>
        <span>
          Underlying ·{" "}
          {signal.mode === "demo" ? "synthetic replay" : "Schwab data"}
        </span>
        <span>{time(data[data.length - 1].time)}</span>
      </div>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null),
    [view, setView] = useState<View>("overview"),
    [loading, setLoading] = useState(true),
    [scanning, setScanning] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [session, setSession] = useState({
    authenticated: true,
    required: false,
  });
  const [journalSource, setJournalSource] = useState<SourceMode>("demo");
  const [horizon, setHorizon] = useState("all"),
    [asset, setAsset] = useState("all"),
    [query, setQuery] = useState(""),
    [selected, setSelected] = useState(""),
    [autoRefresh, setAutoRefresh] = useState(false),
    [mobileNav, setMobileNav] = useState(false);
  const [watchInput, setWatchInput] = useState(""),
    [rulesDraft, setRulesDraft] = useState<Rules | null>(null),
    [tradeSignal, setTradeSignal] = useState<Signal | null>(null),
    [closing, setClosing] = useState<JournalEntry | null>(null);
  const scanLock = useRef(false);
  const booted = useRef(false);
  const handleError = useCallback((e: unknown) => {
    const failure = e as Error & { status?: number; code?: string };
    setError(failure.message);
    if (failure.code === "OWNER_AUTH_REQUIRED") {
      setState(null);
      setSession({ required: true, authenticated: false });
      setAutoRefresh(false);
      setTradeSignal(null);
      setClosing(null);
    } else if (failure.status === 401) {
      setAutoRefresh(false);
      setState((s) =>
        s
          ? {
              ...s,
              lastScan: null,
              connection: {
                ...s.connection,
                connected: false,
                reconnectRequired: true,
                message: failure.message,
              },
            }
          : s,
      );
    }
  }, []);
  const scan = useCallback(
    async (mode: SourceMode) => {
      if (scanLock.current) return;
      scanLock.current = true;
      setScanning(true);
      setError("");
      try {
        const result = await api<ScanResult>("/api/scan", "POST", { mode });
        setState((s) => (s ? { ...s, lastScan: result, mode } : s));
        setSelected((current) =>
          result.signals.some((s) => s.id === current)
            ? current
            : result.signals[0]?.id || "",
        );
      } catch (e) {
        handleError(e);
      } finally {
        scanLock.current = false;
        setScanning(false);
      }
    },
    [handleError],
  );
  const loadWorkspace = useCallback(async () => {
    try {
      const login = await api<{ authenticated: boolean; required: boolean }>(
        "/api/session",
      );
      setSession(login);
      if (login.required && !login.authenticated) {
        setState(null);
        return;
      }
      const s = await api<AppState>("/api/state");
      setState(s);
      setJournalSource(s.mode);
      setRulesDraft(s.rules);
      setSelected(s.lastScan?.signals[0]?.id || "");
      if (!s.lastScan) void scan(s.mode);
    } catch (e) {
      handleError(e);
    } finally {
      setLoading(false);
    }
  }, [scan, handleError]);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void loadWorkspace();
  }, [loadWorkspace]);
  useEffect(() => {
    if (!autoRefresh || !state || busy) return;
    const id = setInterval(() => void scan(state.mode), 60000);
    return () => clearInterval(id);
  }, [autoRefresh, state?.mode, busy, scan]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(id);
  }, [notice]);
  const result = state?.lastScan;
  const filtered = useMemo(
    () =>
      result?.signals.filter(
        (s) =>
          (horizon === "all" || s.horizon === horizon) &&
          (asset === "all" || s.asset === asset) &&
          `${s.symbol} ${s.instrument} ${s.title}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ) || [],
    [result, horizon, asset, query],
  );
  const chosen = filtered.find((s) => s.id === selected) || filtered[0];
  const navigate = (next: View) => {
    setView(next);
    setMobileNav(false);
  };
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };
  const login = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const password = String(new FormData(form).get("password"));
    void act(async () => {
      await api("/api/login", "POST", { password });
      form.reset();
      await loadWorkspace();
    });
  };
  const logout = () =>
    void act(async () => {
      await api("/api/logout", "POST", {});
      setState(null);
      setSession({ required: true, authenticated: false });
      setAutoRefresh(false);
      setTradeSignal(null);
      setClosing(null);
      setNotice("");
    });
  const switchMode = (mode: SourceMode) => {
    if (!state || scanLock.current || busy) return;
    if (mode === "schwab" && !state.connection.connected) {
      setView("connections");
      setNotice("Connect your Schwab account to scan live data.");
      return;
    }
    void act(async () => {
      await api("/api/mode", "POST", { mode });
      setState((s) => (s ? { ...s, mode, lastScan: null } : s));
      setJournalSource(mode);
      await scan(mode);
    });
  };
  const saveWatchlist = (symbols: string[]) =>
    void act(async () => {
      const data = await api<{ watchlist: string[] }>("/api/watchlist", "PUT", {
        symbols,
      });
      setState((s) =>
        s ? { ...s, watchlist: data.watchlist, lastScan: null } : s,
      );
      setWatchInput("");
      setNotice("Watchlist saved.");
      await scan(state!.mode);
    });
  const addSymbol = (event: FormEvent) => {
    event.preventDefault();
    const symbol = watchInput.trim().toUpperCase();
    if (!symbol) return;
    if (!/^[A-Z][A-Z0-9.\/-]{0,9}$/.test(symbol)) {
      setError("Enter a stock or ETF symbol, such as AAPL or BRK.B.");
      return;
    }
    if (state!.watchlist.includes(symbol)) {
      setError(`${symbol} is already on your watchlist.`);
      return;
    }
    saveWatchlist([...state!.watchlist, symbol]);
  };
  const saveRules = (event: FormEvent) => {
    event.preventDefault();
    if (!rulesDraft) return;
    void act(async () => {
      const data = await api<{ rules: Rules }>("/api/rules", "PUT", rulesDraft);
      setState((s) => (s ? { ...s, rules: data.rules, lastScan: null } : s));
      setRulesDraft(data.rules);
      setNotice("Alert rules saved.");
      await scan(state!.mode);
    });
  };
  const createTrade = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tradeSignal) return;
    const form = new FormData(event.currentTarget);
    void act(async () => {
      const { entry } = await api<{ entry: JournalEntry }>(
        "/api/journal",
        "POST",
        {
          signalId: tradeSignal.id,
          symbol: tradeSignal.symbol,
          instrument: tradeSignal.instrument,
          asset: tradeSignal.asset,
          mode: tradeSignal.mode,
          horizon: tradeSignal.horizon,
          direction: form.get("direction"),
          entryPrice: Number(form.get("entryPrice")),
          quantity: Number(form.get("quantity")),
          multiplier:
            tradeSignal.asset === "stock" ? 1 : Number(form.get("multiplier")),
          fees: Number(form.get("fees")),
          notes: String(form.get("notes")),
        },
      );
      setState((s) => (s ? { ...s, journal: [entry, ...s.journal] } : s));
      setTradeSignal(null);
      setNotice("Paper trade added to your journal.");
    });
  };
  const closeTrade = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!closing) return;
    const form = new FormData(event.currentTarget);
    void act(async () => {
      const { entry } = await api<{ entry: JournalEntry }>(
        `/api/journal/${encodeURIComponent(closing.id)}`,
        "PATCH",
        {
          exitPrice: Number(form.get("exitPrice")),
          fees: Number(form.get("fees")),
          notes: String(form.get("notes")),
        },
      );
      setState((s) =>
        s
          ? {
              ...s,
              journal: s.journal.map((j) => (j.id === entry.id ? entry : j)),
            }
          : s,
      );
      setClosing(null);
      setNotice("Paper trade closed.");
    });
  };
  if (loading)
    return (
      <div className="boot-screen">
        <div className="brand-mark">
          <Waves size={26} />
        </div>
        <span>meida</span>
        <LoaderCircle className="spin" size={22} />
        <p>Opening your market workspace</p>
      </div>
    );
  if (session.required && !session.authenticated)
    return (
      <div className="login-shell">
        <div className="login-story">
          <a className="brand" href="#">
            <span className="brand-mark">
              <Waves size={28} />
            </span>
            meida<span className="brand-period">.</span>
          </a>
          <div className="login-story-copy">
            <span className="eyebrow">YOUR MARKET, IN FOCUS</span>
            <h1>
              Find the signal.
              <br />
              Build your conviction.
            </h1>
            <p>
              A private workspace for unusual market activity, thoughtful
              research, and a record of what you learn.
            </p>
            <div className="login-features">
              <span>
                <Activity size={18} />
                Stock & options signals
              </span>
              <span>
                <BookOpen size={18} />
                Paper trade journal
              </span>
              <span>
                <ShieldCheck size={18} />
                Your personal workspace
              </span>
            </div>
          </div>
          <span className="login-story-foot">Observe. Test. Refine.</span>
        </div>
        <main className="login-main">
          <div className="login-card">
            <span className="login-lock">
              <LockKeyhole size={24} />
            </span>
            <h2>Welcome to your workspace</h2>
            <p>Enter your workspace password to continue.</p>
            <form onSubmit={login}>
              {error && (
                <div className="feedback error" role="alert">
                  <CircleHelp size={17} />
                  <span>{error}</span>
                </div>
              )}
              <label>
                Workspace password
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  autoFocus
                  placeholder="Enter your password"
                />
              </label>
              <button className="button primary full-width" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <LockKeyhole size={16} />
                )}{" "}
                {busy ? "Signing in…" : "Open workspace"}
              </button>
            </form>
            <p className="login-footnote">
              <ShieldCheck size={15} />
              This password protects Meida. It is separate from your Schwab
              login.
            </p>
          </div>
          <span className="login-version">
            meida / personal research workspace
          </span>
        </main>
      </div>
    );
  if (!state)
    return (
      <div className="boot-screen">
        <Radar size={36} />
        <h1>Workspace unavailable</h1>
        <p role="alert">
          {error || "The app could not connect to its server."}
        </p>
        <button
          className="button primary"
          onClick={() => window.location.reload()}
        >
          Try again
        </button>
      </div>
    );
  const journal = state.journal.filter((j) => j.mode === journalSource),
    closed = journal.filter((j) => j.closedAt !== null),
    totalPnl = closed.reduce((sum, j) => sum + (j.pnl || 0), 0);
  const titles: Record<View, string> = {
    overview: "Signal overview",
    watchlist: "Your watchlist",
    rules: "Alert rules",
    journal: "Paper journal",
    connections: "Connections",
  };
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "open" : ""}`}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            navigate("overview");
          }}
        >
          <span className="brand-mark">
            <Waves size={25} />
          </span>
          meida<span className="brand-period">.</span>
        </a>
        <div className="workspace-pill">
          <div className="avatar">G</div>
          <div>
            <strong>Personal workspace</strong>
            <span>Research & discovery</span>
          </div>
          <LockKeyhole size={14} />
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav>
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {item.id === "overview" && (
                <span className="nav-count">{result?.signals.length || 0}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="nav-label integration-label">SETUP</div>
        <button
          className={`nav-item ${view === "connections" ? "active" : ""}`}
          onClick={() => navigate("connections")}
        >
          <Unplug size={19} />
          <span>Connections</span>
          <span
            className={`connection-dot ${state.connection.connected ? "connected" : ""}`}
          />
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <div className="sidebar-note-icon">
              <Sparkles size={18} />
            </div>
            <strong>Observe. Test. Refine.</strong>
            <p>
              Keep a record of your ideas.
              <br />
              Let the evidence build.
            </p>
            <button onClick={() => navigate("journal")}>
              Open paper journal <ChevronRight size={15} />
            </button>
          </div>
          <div className="source-status">
            <span
              className={`connection-dot ${state.mode === "schwab" && state.connection.connected ? "connected" : "demo"}`}
            />
            <div>
              <strong>
                {state.mode === "demo"
                  ? "Demo workspace"
                  : "Schwab market data"}
              </strong>
              <span>
                {state.mode === "demo"
                  ? "Synthetic data · no live orders"
                  : state.connection.connected
                    ? "Connected · read-only app"
                    : "Reconnect required"}
              </span>
            </div>
          </div>
          <div className="sidebar-foot">
            <span>meida / v0.1</span>
            {session.required ? (
              <button
                aria-label="Sign out of workspace"
                onClick={logout}
                disabled={busy}
              >
                <LogOut size={15} />
              </button>
            ) : (
              <ShieldCheck size={15} />
            )}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Open navigation"
              onClick={() => setMobileNav(true)}
            >
              <Menu size={21} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>{titles[view]}</strong>
          </div>
          <div className="topbar-right">
            <span className="private-tag">
              <LockKeyhole size={12} /> Personal
            </span>
            <span className="topbar-divider" />
            <button
              className="profile-avatar"
              aria-label="Open personal connection settings"
              onClick={() => navigate("connections")}
            >
              G
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR MARKET, IN FOCUS</div>
              <h1>{titles[view]}</h1>
              <p>
                {view === "overview"
                  ? "Unusual activity, explained. Clear conditions for your next step."
                  : view === "watchlist"
                    ? "A focused universe of stocks and ETFs worth watching."
                    : view === "rules"
                      ? "Define what deserves your attention. Keep the reasoning transparent."
                      : view === "journal"
                        ? "Turn observations into a record you can learn from."
                        : "Your data stays connected. Your credentials stay on the server."}
              </p>
            </div>
            <div className="heading-actions">
              <label className="source-select">
                <span className="sr-only">Data source</span>
                <select
                  value={state.mode}
                  onChange={(e) => switchMode(e.target.value as SourceMode)}
                  disabled={busy || scanning}
                >
                  <option value="demo">Demo data</option>
                  <option value="schwab">Schwab data</option>
                </select>
                <ChevronDown size={14} />
              </label>
              <button
                className="button primary"
                disabled={scanning || busy}
                onClick={() => void scan(state.mode)}
              >
                <RefreshCw size={16} className={scanning ? "spin" : ""} />
                {scanning ? "Scanning…" : "Run scan"}
              </button>
            </div>
          </div>
          {error && (
            <div className="feedback error" role="alert">
              <CircleHelp size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <div className="feedback success" role="status">
              <CheckCircle2 size={18} />
              <span>{notice}</span>
              <button
                className="icon-button"
                aria-label="Dismiss notification"
                onClick={() => setNotice("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div
            className={`data-banner ${state.mode === "demo" ? "" : "live-banner"}`}
          >
            <div className="banner-icon">
              {state.mode === "demo" ? (
                <Layers3 size={17} />
              ) : (
                <ShieldCheck size={17} />
              )}
            </div>
            <p>
              <strong>
                {state.mode === "demo"
                  ? "You’re exploring a demo."
                  : "Schwab market data"}
              </strong>{" "}
              {state.mode === "demo"
                ? "Prices and alerts are synthetic. Connect Schwab to research your own watchlist."
                : state.connection.message}
            </p>
            <button onClick={() => navigate("connections")}>
              {state.mode === "demo" ? "Connect Schwab" : "Manage connection"}
              <ChevronRight size={15} />
            </button>
          </div>
          {view === "overview" && (
            <>
              <section className="stats-grid" aria-label="Scan summary">
                <Stat
                  icon={Radar}
                  label="Signals surfaced"
                  value={String(result?.signals.length || 0)}
                  detail={`${state.rules.enabled.length} active detection rules`}
                  color="purple"
                />
                <Stat
                  icon={Activity}
                  label="Stock signals"
                  value={String(
                    result?.signals.filter((s) => s.asset === "stock").length ||
                      0,
                  )}
                  detail="Volume, trend & participation"
                  color="green"
                />
                <Stat
                  icon={Layers3}
                  label="Options signals"
                  value={String(
                    result?.signals.filter((s) => s.asset === "option")
                      .length || 0,
                  )}
                  detail="Activity with liquidity filters"
                  color="amber"
                />
                <Stat
                  icon={Eye}
                  label="Symbols scanned"
                  value={String(result?.scanned || 0)}
                  detail={`${state.watchlist.length} symbols on your watchlist`}
                  color="blue"
                />
              </section>
              {result?.quotes.length ? (
                <section className="market-strip" aria-label="Watchlist prices">
                  {result.quotes.slice(0, 5).map((q) => (
                    <button
                      key={q.symbol}
                      onClick={() => {
                        setQuery(q.symbol);
                        setAsset("all");
                        setHorizon("all");
                      }}
                    >
                      <span className="market-symbol">
                        {q.symbol}
                        <span>
                          {q.delayed
                            ? "Delayed"
                            : state.mode === "demo"
                              ? "Demo"
                              : "Quote"}
                        </span>
                      </span>
                      <span className="market-price">
                        {usd(q.last)}
                        <span
                          className={
                            q.changePercent >= 0 ? "positive" : "negative"
                          }
                        >
                          {pct(q.changePercent)}
                        </span>
                      </span>
                    </button>
                  ))}
                </section>
              ) : null}
              <div className="scanner-heading">
                <div>
                  <h2>
                    Signal feed{" "}
                    <span className="count-badge">{filtered.length}</span>
                  </h2>
                  <p>Research candidates from your watchlist</p>
                </div>
                <label className="auto-refresh">
                  <input
                    type="checkbox"
                    checked={autoRefresh}
                    onChange={(e) => setAutoRefresh(e.target.checked)}
                  />
                  <span className="toggle-track" />
                  Auto-scan · 60s
                </label>
              </div>
              <div className="feed-toolbar">
                <div className="segmented" aria-label="Trading horizon">
                  {[
                    ["all", "All signals"],
                    ["intraday", "Intraday"],
                    ["swing", "Swing"],
                  ].map(([value, label]) => (
                    <button
                      key={value}
                      className={horizon === value ? "selected" : ""}
                      aria-pressed={horizon === value}
                      onClick={() => setHorizon(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="feed-filters">
                  <label className="search-box">
                    <Search size={16} />
                    <input
                      aria-label="Search signals"
                      placeholder="Search symbol or signal"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query && (
                      <button
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </label>
                  <label className="asset-select">
                    <Filter size={14} />
                    <select
                      aria-label="Asset type"
                      value={asset}
                      onChange={(e) => setAsset(e.target.value)}
                    >
                      <option value="all">All assets</option>
                      <option value="stock">Stocks</option>
                      <option value="option">Options</option>
                    </select>
                    <ChevronDown size={14} />
                  </label>
                </div>
              </div>
              <div className="feed-layout">
                <section className="signal-list" aria-label="Market signals">
                  <div className="list-labels">
                    <span>SYMBOL / SIGNAL</span>
                    <span>PRICE</span>
                    <span>STRENGTH</span>
                  </div>
                  {filtered.length ? (
                    filtered.map((signal) => (
                      <button
                        key={signal.id}
                        className={`signal-row ${chosen?.id === signal.id ? "selected" : ""}`}
                        onClick={() => setSelected(signal.id)}
                        aria-pressed={chosen?.id === signal.id}
                      >
                        <span className={`ticker-icon ${signal.asset}`}>
                          {signal.symbol.slice(0, 2)}
                        </span>
                        <span className="signal-primary">
                          <span className="signal-symbol">
                            {signal.symbol}
                            <span className={`asset-badge ${signal.asset}`}>
                              {signal.asset === "option" ? "OPT" : "STK"}
                            </span>
                            <span
                              className={`direction-mark ${signal.direction}`}
                              title={signal.direction}
                            >
                              {signal.direction === "bullish" ? (
                                <ArrowUpRight size={15} />
                              ) : signal.direction === "bearish" ? (
                                <ArrowDownRight size={15} />
                              ) : (
                                <Waves size={15} />
                              )}
                            </span>
                          </span>
                          <span className="signal-name">{signal.title}</span>
                          {signal.asset === "option" && (
                            <span className="signal-contract">
                              {signal.instrument}
                            </span>
                          )}
                          <span className="signal-meta">
                            {signal.horizon === "intraday"
                              ? "Intraday"
                              : "Swing"}
                            <span>·</span>
                            {time(signal.timestamp)} ET
                          </span>
                        </span>
                        <span className="signal-price">
                          {usd(signal.price)}
                          <span
                            className={
                              signal.changePercent >= 0
                                ? "positive"
                                : "negative"
                            }
                          >
                            {pct(signal.changePercent)}
                            <small>underlying</small>
                          </span>
                        </span>
                        <span className="signal-strength">
                          <strong>
                            {signal.strength}
                            <span>/100</span>
                          </strong>
                          <span className="strength-track">
                            <i
                              style={{
                                width: `${Math.min(100, Math.max(0, signal.strength))}%`,
                              }}
                            />
                          </span>
                        </span>
                        <ChevronRight className="row-chevron" size={16} />
                      </button>
                    ))
                  ) : (
                    <Empty
                      icon={Search}
                      title={
                        scanning
                          ? "Scanning your watchlist…"
                          : "No signals in this view"
                      }
                      text={
                        query || horizon !== "all" || asset !== "all"
                          ? "Try another symbol or broaden your filters."
                          : "Your rules did not find a qualifying signal. No signal is a useful result, too."
                      }
                      action={
                        query || horizon !== "all" || asset !== "all" ? (
                          <button
                            className="button secondary"
                            onClick={() => {
                              setQuery("");
                              setHorizon("all");
                              setAsset("all");
                            }}
                          >
                            Clear filters
                          </button>
                        ) : undefined
                      }
                    />
                  )}
                  <div className="feed-footer">
                    <span>
                      <Clock3 size={13} />
                      {result
                        ? `${state.mode === "demo" ? "Replay" : "Scanned"} ${day(result.asOf)} · ${time(result.asOf)} ET`
                        : "Waiting for first scan"}
                    </span>
                    <span>
                      {result?.mode === "demo"
                        ? "SYNTHETIC"
                        : result?.marketOpen
                          ? "REGULAR SESSION"
                          : "MARKET CLOSED"}
                    </span>
                  </div>
                </section>
                <aside className="detail-panel">
                  {chosen ? (
                    <>
                      <div className="detail-header">
                        <span className="eyebrow">SIGNAL SPOTLIGHT</span>
                        <span className="pill">
                          {chosen.horizon === "intraday" ? "Intraday" : "Swing"}
                        </span>
                      </div>
                      <div className="detail-symbol">
                        <div className={`ticker-icon large ${chosen.asset}`}>
                          {chosen.symbol.slice(0, 2)}
                        </div>
                        <div>
                          <h2>
                            {chosen.symbol}
                            <span
                              className={`direction-pill ${chosen.direction}`}
                            >
                              {chosen.direction === "neutral"
                                ? "Activity"
                                : chosen.direction}
                            </span>
                          </h2>
                          <p>
                            {chosen.asset === "option"
                              ? chosen.instrument
                              : chosen.title}
                          </p>
                        </div>
                      </div>
                      <div className="detail-price">
                        {usd(chosen.price)}
                        <span
                          className={
                            chosen.changePercent >= 0 ? "positive" : "negative"
                          }
                        >
                          {pct(chosen.changePercent)} <small>underlying</small>
                        </span>
                      </div>
                      {chosen.plan && (
                        <TraderRead key={chosen.id} signal={chosen} />
                      )}
                      <PriceChart signal={chosen} />
                      <div className="detail-reason">
                        <h3>
                          <Sparkles size={15} />
                          Why this surfaced
                        </h3>
                        <p>{chosen.summary}</p>
                      </div>
                      <dl className="evidence-grid">
                        {chosen.evidence.map((e, i) => (
                          <div key={`${e.label}-${i}`}>
                            <dt>{e.label}</dt>
                            <dd>{e.value}</dd>
                          </div>
                        ))}
                      </dl>
                      {!chosen.plan && (
                        <div className="invalidation">
                          <Crosshair size={15} />
                          <div>
                            <strong>Reassess the idea when</strong>
                            <p>{chosen.invalidation}</p>
                          </div>
                        </div>
                      )}
                      {chosen.cautions.length > 0 && (
                        <details className="cautions">
                          <summary>
                            Context & limitations <ChevronDown size={14} />
                          </summary>
                          <ul>
                            {chosen.cautions.map((c, i) => (
                              <li key={i}>{c}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                      <button
                        className="button primary full-width"
                        onClick={() => setTradeSignal(chosen)}
                      >
                        <Plus size={17} />
                        Add paper trade
                      </button>
                      <p className="detail-footnote">
                        Strength is a rule-based ranking, not a probability of
                        profit.
                      </p>
                    </>
                  ) : (
                    <Empty
                      icon={Crosshair}
                      title="A closer look"
                      text="Select a signal to inspect its evidence, price history, and limitations."
                    />
                  )}
                </aside>
              </div>
              {result?.warnings.length ? (
                <details className="scan-warnings">
                  <summary>
                    <CircleHelp size={15} />
                    {result.warnings.length} data{" "}
                    {result.warnings.length === 1 ? "note" : "notes"}
                    <ChevronDown size={14} />
                  </summary>
                  <ul>
                    {result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          )}
          {view === "watchlist" && (
            <section className="panel">
              <div className="section-heading">
                <div>
                  <h2>A smaller universe. A sharper focus.</h2>
                  <p>
                    Up to 12 symbols per scan. Stocks and ETFs with listed
                    options are supported.
                  </p>
                </div>
                <span className="pill">
                  {state.watchlist.length} / 12 symbols
                </span>
              </div>
              <form className="watchlist-form" onSubmit={addSymbol}>
                <label className="search-box">
                  <Search size={17} />
                  <input
                    aria-label="Add a symbol"
                    placeholder="Enter a ticker, e.g. AAPL"
                    value={watchInput}
                    maxLength={10}
                    onChange={(e) =>
                      setWatchInput(e.target.value.toUpperCase())
                    }
                  />
                </label>
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    scanning ||
                    state.watchlist.length >= 12 ||
                    !watchInput.trim()
                  }
                >
                  <Plus size={16} />
                  Add symbol
                </button>
              </form>
              <div className="watchlist-grid">
                {state.watchlist.map((symbol) => {
                  const quote = result?.quotes.find((q) => q.symbol === symbol);
                  return (
                    <article className="watch-card" key={symbol}>
                      <div className="watch-card-heading">
                        <div className="ticker-icon">{symbol.slice(0, 2)}</div>
                        <div>
                          <h3>{symbol}</h3>
                          <p>{quote?.description || "Stock / ETF"}</p>
                        </div>
                        <button
                          className="icon-button"
                          disabled={busy || scanning}
                          onClick={() =>
                            saveWatchlist(
                              state.watchlist.filter((s) => s !== symbol),
                            )
                          }
                          aria-label={`Remove ${symbol} from watchlist`}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="watch-card-price">
                        <strong>{quote ? usd(quote.last) : "—"}</strong>
                        <span
                          className={
                            quote && quote.changePercent < 0
                              ? "negative"
                              : "positive"
                          }
                        >
                          {quote ? pct(quote.changePercent) : "Awaiting data"}
                        </span>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => {
                          setQuery(symbol);
                          setHorizon("all");
                          setAsset("all");
                          setView("overview");
                        }}
                      >
                        View signals <ChevronRight size={15} />
                      </button>
                    </article>
                  );
                })}
              </div>
              {!state.watchlist.length && (
                <Empty
                  icon={Eye}
                  title="Build your watchlist"
                  text="Add the first symbol you want to research."
                />
              )}
            </section>
          )}
          {view === "rules" && rulesDraft && (
            <form onSubmit={saveRules}>
              <div className="section-heading rules-heading">
                <div>
                  <h2>Your detection playbook</h2>
                  <p>
                    These thresholds identify research candidates. They are not
                    validated trading recommendations.
                  </p>
                </div>
                <button className="button primary" disabled={busy || scanning}>
                  <Check size={16} />
                  Save rules
                </button>
              </div>
              <div className="rule-layout">
                <section className="panel rule-panel">
                  {RULES.map((rule) => (
                    <label className="rule-card" key={rule.id}>
                      <span className="rule-icon">
                        <rule.icon size={21} />
                      </span>
                      <span>
                        <strong>
                          {rule.title}
                          <span className="pill">{rule.tag}</span>
                        </strong>
                        <p>{rule.description}</p>
                      </span>
                      <span className="rule-switch">
                        <input
                          type="checkbox"
                          checked={rulesDraft.enabled.includes(rule.id)}
                          onChange={(e) =>
                            setRulesDraft({
                              ...rulesDraft,
                              enabled: e.target.checked
                                ? [...rulesDraft.enabled, rule.id]
                                : rulesDraft.enabled.filter(
                                    (id) => id !== rule.id,
                                  ),
                            })
                          }
                        />
                        <span className="toggle-track" />
                      </span>
                    </label>
                  ))}
                </section>
                <section className="panel threshold-panel">
                  <h2>
                    <Settings2 size={19} />
                    Thresholds
                  </h2>
                  <p>Start selective. Adjust after reviewing the evidence.</p>
                  <NumberField
                    label="Minimum relative volume"
                    help="Compared with the same time in prior sessions."
                    value={rulesDraft.relativeVolume}
                    min={1}
                    max={20}
                    step={0.1}
                    unit="×"
                    onChange={(value) =>
                      setRulesDraft({ ...rulesDraft, relativeVolume: value })
                    }
                  />
                  <NumberField
                    label="Option volume / open interest"
                    help="Activity relative to outstanding contracts."
                    value={rulesDraft.optionVolumeRatio}
                    min={1}
                    max={100}
                    step={0.1}
                    unit="×"
                    onChange={(value) =>
                      setRulesDraft({ ...rulesDraft, optionVolumeRatio: value })
                    }
                  />
                  <NumberField
                    label="Minimum option volume"
                    value={rulesDraft.minOptionVolume}
                    min={1}
                    max={10000000}
                    step={1}
                    unit="contracts"
                    onChange={(value) =>
                      setRulesDraft({ ...rulesDraft, minOptionVolume: value })
                    }
                  />
                  <NumberField
                    label="Minimum open interest"
                    value={rulesDraft.minOpenInterest}
                    min={1}
                    max={10000000}
                    step={1}
                    unit="contracts"
                    onChange={(value) =>
                      setRulesDraft({ ...rulesDraft, minOpenInterest: value })
                    }
                  />
                  <NumberField
                    label="Maximum bid–ask spread"
                    help="Spread as a percentage of the quote midpoint."
                    value={rulesDraft.maxSpreadPercent}
                    min={0.1}
                    max={100}
                    step={0.1}
                    unit="%"
                    onChange={(value) =>
                      setRulesDraft({ ...rulesDraft, maxSpreadPercent: value })
                    }
                  />
                  <NumberField
                    label="Maximum days to expiration"
                    value={rulesDraft.maxDte}
                    min={1}
                    max={60}
                    step={1}
                    unit="days"
                    onChange={(value) =>
                      setRulesDraft({ ...rulesDraft, maxDte: value })
                    }
                  />
                </section>
              </div>
            </form>
          )}
          {view === "journal" && (
            <>
              <section className="stats-grid journal-stats">
                <Stat
                  icon={BookOpen}
                  label="Paper trades"
                  value={String(journal.length)}
                  detail={`${journalSource === "demo" ? "Demo" : "Schwab"} research journal`}
                  color="purple"
                />
                <Stat
                  icon={Clock3}
                  label="Open ideas"
                  value={String(journal.length - closed.length)}
                  detail="Awaiting an exit observation"
                  color="blue"
                />
                <Stat
                  icon={CheckCircle2}
                  label="Closed ideas"
                  value={String(closed.length)}
                  detail="Entries with a recorded exit"
                  color="green"
                />
                <Stat
                  icon={Activity}
                  label="Realized paper P&L"
                  value={usd(totalPnl)}
                  detail="User-entered fills, net of recorded fees"
                  color="amber"
                />
              </section>
              <section className="panel journal-panel">
                <div className="section-heading">
                  <div>
                    <h2>A record of your reasoning</h2>
                    <p>
                      Paper fills are entered by you. Include spread, slippage,
                      and all fees in your assumptions.
                    </p>
                  </div>
                  <div className="journal-actions">
                    <label className="source-select">
                      <span className="sr-only">Journal data source</span>
                      <select
                        aria-label="Journal data source"
                        value={journalSource}
                        onChange={(e) =>
                          setJournalSource(e.target.value as SourceMode)
                        }
                      >
                        <option value="demo">Demo journal</option>
                        <option value="schwab">Schwab journal</option>
                      </select>
                      <ChevronDown size={14} />
                    </label>
                    <button
                      className="button secondary"
                      onClick={() => navigate("overview")}
                    >
                      <Plus size={16} />
                      Find a signal
                    </button>
                  </div>
                </div>
                {journal.length ? (
                  <div className="table-scroll">
                    <table className="journal-table">
                      <thead>
                        <tr>
                          <th>INSTRUMENT</th>
                          <th>POSITION</th>
                          <th>ENTRY / EXIT</th>
                          <th>PAPER P&L</th>
                          <th>STATUS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {journal.map((entry) => (
                          <tr key={entry.id}>
                            <td>
                              <strong>{entry.symbol}</strong>
                              <span>
                                {entry.asset === "option"
                                  ? entry.instrument
                                  : entry.horizon === "intraday"
                                    ? "Intraday stock idea"
                                    : "Swing stock idea"}
                              </span>
                              {entry.notes && (
                                <details>
                                  <summary>Trade notes</summary>
                                  <p>{entry.notes}</p>
                                </details>
                              )}
                            </td>
                            <td>
                              <strong className="capitalize">
                                {entry.direction} · {entry.quantity}
                              </strong>
                              <span>
                                {entry.asset === "option"
                                  ? `${entry.multiplier} multiplier`
                                  : "shares"}{" "}
                                · {day(entry.openedAt)}
                              </span>
                            </td>
                            <td>
                              <strong>
                                {usd(entry.entryPrice)}{" "}
                                <span className="inline-muted">
                                  /{" "}
                                  {entry.exitPrice === null
                                    ? "—"
                                    : usd(entry.exitPrice)}
                                </span>
                              </strong>
                              <span>{usd(entry.fees)} total fees</span>
                            </td>
                            <td>
                              <strong
                                className={
                                  entry.pnl === null
                                    ? ""
                                    : entry.pnl >= 0
                                      ? "positive"
                                      : "negative"
                                }
                              >
                                {entry.pnl === null ? "—" : usd(entry.pnl)}
                              </strong>
                              <span>
                                {entry.closedAt
                                  ? day(entry.closedAt)
                                  : "Unrealized P&L not tracked"}
                              </span>
                            </td>
                            <td>
                              {entry.closedAt ? (
                                <span className="pill closed-pill">
                                  <Check size={13} />
                                  Closed
                                </span>
                              ) : (
                                <button
                                  className="button secondary small"
                                  onClick={() => setClosing(entry)}
                                >
                                  Record exit
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <Empty
                    icon={BookOpen}
                    title="Good research leaves a trail"
                    text="Open a signal and add a paper trade. Record your entry, reasoning, and eventual exit to evaluate the idea over time."
                    action={
                      <button
                        className="button primary"
                        onClick={() => navigate("overview")}
                      >
                        Explore signals
                      </button>
                    }
                  />
                )}
                <div className="journal-note">
                  <ShieldCheck size={16} />
                  This journal does not submit orders or represent actual
                  account performance.
                </div>
              </section>
            </>
          )}
          {view === "connections" && (
            <div className="connections-layout">
              <section className="panel connection-card">
                <div className="provider-heading">
                  <div className="schwab-mark">
                    charles
                    <br />
                    <strong>SCHWAB</strong>
                  </div>
                  <div>
                    <h2>Charles Schwab</h2>
                    <p>Trader API · Market Data Production</p>
                  </div>
                  <span
                    className={`pill ${state.connection.connected ? "closed-pill" : ""}`}
                  >
                    {state.connection.connected
                      ? "Connected"
                      : state.connection.reconnectRequired
                        ? "Reconnect required"
                        : "Not connected"}
                  </span>
                </div>
                <p className="connection-description">
                  Quotes, price history, and option chains power Meida’s own
                  signal calculations. Thinkorswim’s native Alert Book is not
                  imported.
                </p>
                <div className="connection-checks">
                  <ConnectionStep
                    done={state.connection.configured}
                    title="Configure your approved app"
                    text="Set your Schwab App Key, App Secret, callback URL, and encryption key in the server environment."
                  />
                  <ConnectionStep
                    done={state.connection.connected}
                    title="Authorize with Schwab"
                    text="Sign in through Schwab’s secure authorization page. Meida keeps brokerage tokens on the server."
                  />
                  <ConnectionStep
                    done={state.mode === "schwab" && state.connection.connected}
                    title="Start researching live data"
                    text="Select Schwab data and run a scan. Available data depends on your market-data permissions."
                  />
                </div>
                <div className="callback-box">
                  <span>Configured callback URL</span>
                  <div>
                    <code>
                      {state.connection.callbackUrl || "Not configured"}
                    </code>
                    {state.connection.callbackUrl && (
                      <button
                        className="icon-button"
                        aria-label="Copy callback URL"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(state.connection.callbackUrl)
                            .then(() => setNotice("Callback URL copied."))
                            .catch(() =>
                              setError(
                                "Copy is unavailable in this browser. Select and copy the callback URL manually.",
                              ),
                            )
                        }
                      >
                        <Copy size={16} />
                      </button>
                    )}
                  </div>
                </div>
                <p className="connection-status-text">
                  {state.connection.message}
                </p>
                <div className="connection-actions">
                  {state.connection.connected ? (
                    <>
                      <button
                        className="button primary"
                        disabled={busy || scanning}
                        onClick={() => switchMode("schwab")}
                      >
                        <Radar size={16} />
                        Scan Schwab data
                      </button>
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            await api(
                              "/api/auth/schwab/disconnect",
                              "POST",
                              {},
                            );
                            const next = await api<AppState>("/api/state");
                            setState(next);
                            setNotice("Schwab disconnected.");
                          })
                        }
                      >
                        Disconnect
                      </button>
                    </>
                  ) : state.connection.configured ? (
                    <a className="button primary" href="/api/auth/schwab/start">
                      <LockKeyhole size={16} />
                      {state.connection.reconnectRequired
                        ? "Reconnect Schwab"
                        : "Connect Schwab"}
                    </a>
                  ) : (
                    <button className="button primary" disabled>
                      <LockKeyhole size={16} />
                      Server setup required
                    </button>
                  )}
                </div>
              </section>
              <div className="connection-side">
                <section className="panel">
                  <ShieldCheck size={26} className="accent-icon" />
                  <h2>Private by design</h2>
                  <p>
                    Your App Secret and brokerage tokens are never sent to the
                    dashboard. This version runs as a personal research
                    workspace.
                  </p>
                  <ul className="clean-list">
                    <li>
                      <Check size={15} />
                      Server-side authorization
                    </li>
                    <li>
                      <Check size={15} />
                      Encrypted token storage
                    </li>
                    <li>
                      <Check size={15} />
                      No order execution
                    </li>
                  </ul>
                </section>
                <section className="panel">
                  <h2>Before you connect</h2>
                  <p>
                    Use an approved <strong>Market Data Production</strong> app.
                    Match the registered callback URL exactly. See{" "}
                    <code>docs/SETUP.md</code> in the repository for environment
                    configuration.
                  </p>
                  <a
                    className="text-button"
                    href="https://developer.schwab.com/products/trader-api--individual"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Schwab developer portal <ExternalLink size={14} />
                  </a>
                </section>
                <section className="commercial-note">
                  <CircleHelp size={18} />
                  <p>
                    Planning to offer Meida to customers? Commercial access and
                    market-data redistribution need separate review and
                    approval.
                  </p>
                </section>
              </div>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <Waves size={14} />
              Turn market activity into next steps.
            </span>
            <span>Research signals · No guaranteed outcomes</span>
          </footer>
        </main>
      </div>
      {tradeSignal && (
        <Modal title="Add a paper trade" onClose={() => setTradeSignal(null)}>
          <form onSubmit={createTrade}>
            {error && (
              <div className="feedback error" role="alert">
                {error}
              </div>
            )}
            <div className="modal-context">
              <strong>{tradeSignal.symbol}</strong>
              <span>
                {tradeSignal.title} ·{" "}
                {tradeSignal.mode === "demo" ? "Synthetic demo" : "Schwab data"}
              </span>
            </div>
            <p className="form-intro">
              Record your own hypothetical fill. Account for spread and slippage
              when choosing the entry price.
            </p>
            <div className="form-grid">
              <label>
                Direction
                <select
                  name="direction"
                  defaultValue={
                    tradeSignal.direction === "bearish" ? "short" : "long"
                  }
                >
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </label>
              <label>
                Entry price (USD)
                <input
                  name="entryPrice"
                  type="number"
                  min="0.0001"
                  step="any"
                  defaultValue={tradeSignal.price}
                  required
                />
              </label>
              <label>
                Quantity (
                {tradeSignal.asset === "option" ? "contracts" : "shares"})
                <input
                  name="quantity"
                  type="number"
                  min="1"
                  max="1000000"
                  step="1"
                  defaultValue="1"
                  required
                />
              </label>
              {tradeSignal.asset === "option" ? (
                <label>
                  Contract multiplier
                  <input
                    name="multiplier"
                    type="number"
                    min="1"
                    max="10000"
                    step="1"
                    defaultValue="100"
                    required
                  />
                  <small>
                    Verify the contract deliverable; adjusted options may
                    differ.
                  </small>
                </label>
              ) : null}
              <label>
                Total assumed fees (USD)
                <input
                  name="fees"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue="0"
                  required
                />
              </label>
              <label className="span-two">
                Your thesis & exit plan
                <textarea
                  name="notes"
                  rows={3}
                  maxLength={4000}
                  placeholder="What supports this idea? What would change your mind?"
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setTradeSignal(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={16} className="spin" />
                ) : (
                  <Plus size={16} />
                )}
                Save paper trade
              </button>
            </div>
          </form>
        </Modal>
      )}
      {closing && (
        <Modal
          title={`Record exit · ${closing.symbol}`}
          onClose={() => setClosing(null)}
        >
          <form onSubmit={closeTrade}>
            {error && (
              <div className="feedback error" role="alert">
                {error}
              </div>
            )}
            <p className="form-intro">
              Enter the hypothetical exit fill and total fees for the entire
              trade. Paper P&L includes position size and contract multiplier.
            </p>
            <div className="form-grid">
              <label>
                Exit price (USD)
                <input
                  name="exitPrice"
                  type="number"
                  min="0"
                  step="any"
                  defaultValue={closing.entryPrice}
                  required
                />
              </label>
              <label>
                Total trade fees (USD)
                <input
                  name="fees"
                  type="number"
                  min="0"
                  step="0.01"
                  defaultValue={closing.fees}
                  required
                />
              </label>
              <label className="span-two">
                Trade notes
                <textarea
                  name="notes"
                  rows={4}
                  maxLength={4000}
                  defaultValue={closing.notes}
                  placeholder="What happened? What did you learn?"
                />
              </label>
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setClosing(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={busy}>
                <Check size={16} />
                Record exit
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  detail,
  color,
}: {
  icon: typeof Radar;
  label: string;
  value: string;
  detail: string;
  color: string;
}) {
  return (
    <article className="stat-card">
      <div className="stat-top">
        <span>{label}</span>
        <span className={`stat-icon ${color}`}>
          <Icon size={18} />
        </span>
      </div>
      <strong className="stat-value">{value}</strong>
      <p>{detail}</p>
    </article>
  );
}
function Empty({
  icon: Icon,
  title,
  text,
  action,
}: {
  icon: typeof Radar;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div>
        <Icon size={25} />
      </div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}
function NumberField({
  label,
  help,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  help?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (n: number) => void;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <div>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          required
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <span>{unit}</span>
      </div>
      {help && <small>{help}</small>}
    </label>
  );
}
function ConnectionStep({
  done,
  title,
  text,
}: {
  done: boolean;
  title: string;
  text: string;
}) {
  return (
    <div className="connection-step">
      <span className={`step-icon ${done ? "done" : ""}`}>
        {done ? <Check size={16} /> : <span />}
      </span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}
