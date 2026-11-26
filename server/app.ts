import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";
import type {
  AppState,
  JournalEntry,
  MarketSnapshot,
  SourceMode,
} from "../shared/types.ts";
import type { Config } from "./config.ts";
import { Store } from "./store.ts";
import { ProviderError, SchwabAuth } from "./auth.ts";
import { OwnerAuth } from "./owner.ts";
import { ScanCoordinator } from "./scanner.ts";
import { TelegramNotifications } from "./notifications.ts";

const modeSchema = z.enum(["demo", "schwab"]);
const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.\/-]{0,9}$/, "Use a valid stock or ETF symbol.");
const watchlistSchema = z
  .object({
    symbols: z
      .array(symbolSchema)
      .min(1)
      .max(12)
      .transform((items) => [...new Set(items)]),
  })
  .strict();
const ruleNames = [
  "relative-volume",
  "opening-breakout",
  "vwap-cross",
  "swing-breakout",
  "option-activity",
] as const;
const rulesSchema = z
  .object({
    relativeVolume: z.number().finite().min(1).max(20),
    optionVolumeRatio: z.number().finite().min(1).max(100),
    minOptionVolume: z.number().int().min(1).max(10_000_000),
    maxSpreadPercent: z.number().finite().min(0.1).max(100),
    minOpenInterest: z.number().int().min(1).max(10_000_000),
    maxDte: z.number().int().min(1).max(60),
    enabled: z
      .array(z.enum(ruleNames))
      .max(5)
      .transform((items) => [...new Set(items)]),
  })
  .strict();
const price = z.number().finite().positive().max(1_000_000_000);
const fees = z.number().finite().min(0).max(1_000_000);
const journalSchema = z
  .object({
    signalId: z.string().min(1).max(300),
    symbol: symbolSchema,
    instrument: z.string().trim().min(1).max(200),
    asset: z.enum(["stock", "option"]),
    mode: modeSchema,
    horizon: z.enum(["intraday", "swing"]),
    direction: z.enum(["long", "short"]),
    entryPrice: price,
    quantity: z.number().finite().positive().max(1_000_000),
    multiplier: z.number().int().positive().max(10_000),
    fees,
    notes: z.string().max(4000).default(""),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.asset === "stock" && entry.multiplier !== 1)
      ctx.addIssue({
        code: "custom",
        path: ["multiplier"],
        message: "Stocks use multiplier 1.",
      });
    if (entry.asset === "option" && !Number.isInteger(entry.quantity))
      ctx.addIssue({
        code: "custom",
        path: ["quantity"],
        message: "Option contracts must be whole numbers.",
      });
  });
const closeSchema = z
  .object({
    exitPrice: z.number().finite().min(0).max(1_000_000_000),
    fees: fees.optional(),
    notes: z.string().max(4000).optional(),
  })
  .strict();

interface Dependencies {
  config: Config;
  store: Store;
  auth: SchwabAuth;
  provider: { snapshot(symbols: string[]): Promise<MarketSnapshot> };
  scanner?: ScanCoordinator;
  notifications?: TelegramNotifications;
}

export function createApp({
  config,
  store,
  auth,
  provider,
  scanner: suppliedScanner,
  notifications: suppliedNotifications,
}: Dependencies) {
  const app = express();
  const scanner =
    suppliedScanner ?? new ScanCoordinator({ store, auth, provider });
  const notifications =
    suppliedNotifications ??
    new TelegramNotifications({ config, store, auth, scanner });
  app.locals.notifications = notifications;
  const owner = new OwnerAuth(config, store);
  app.disable("x-powered-by");
  // Hosted platform health checks may use an internal Host header. Never expose state here.
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  app.use((req, res, next) => {
    if (
      req.headers.host?.toLowerCase() !==
      new URL(config.origin).host.toLowerCase()
    )
      return res.status(403).json({
        error: "Unexpected host. Open the configured local app address.",
      });
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api/"))
      res.setHeader("Cache-Control", "no-store");
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.headers.origin !== config.origin
    )
      return res
        .status(403)
        .json({ error: "A same-origin request is required." });
    next();
  });
  app.use(express.json({ limit: "32kb" }));
  app.get("/api/session", (req, res) =>
    res.json({ authenticated: owner.session(req), required: owner.required }),
  );
  app.post("/api/login", async (req, res) => {
    if (!owner.required) return res.json({ authenticated: true });
    const body = z
      .object({ password: z.string().max(1024) })
      .strict()
      .safeParse(req.body);
    if (!body.success) throw new ProviderError("Invalid credentials.", 401);
    const token = await owner.login(
      body.data.password,
      req.socket.remoteAddress || "unknown",
    );
    res.cookie("meida_owner", token, owner.cookieOptions);
    res.json({ authenticated: true });
  });
  app.use("/api", (req, res, next) => {
    if (!owner.session(req)) {
      if (
        req.method === "GET" &&
        req.path === "/auth/schwab/callback" &&
        (req.headers["sec-fetch-mode"] === "navigate" ||
          req.headers.accept?.includes("text/html"))
      ) {
        return res.redirect(303, "/?connection=failed&reason=owner_session");
      }
      return res.status(401).json({
        error: "Sign in to your private Meida workspace.",
        code: "OWNER_AUTH_REQUIRED",
      });
    }
    next();
  });
  app.post("/api/logout", (req, res) => {
    owner.logout(req);
    res.clearCookie("meida_owner", {
      ...owner.cookieOptions,
      maxAge: undefined,
    });
    res.json({ authenticated: !owner.required });
  });
  app.get("/api/state", (_req, res) => {
    const state: AppState = {
      mode: store.mode,
      watchlist: store.watchlist,
      rules: store.rules,
      connection: auth.status(),
      journal: store.journal(),
      lastScan: store.lastScan,
    };
    res.json(state);
  });
  app.put("/api/watchlist", (req, res) => {
    const { symbols } = watchlistSchema.parse(req.body);
    scanner.invalidate();
    store.set("watchlist", symbols);
    store.delete("lastScan:demo");
    store.delete("lastScan:schwab");
    res.json({ watchlist: symbols });
  });
  app.put("/api/rules", (req, res) => {
    const rules = rulesSchema.parse(req.body);
    scanner.invalidate();
    store.set("rules", rules);
    store.delete("lastScan:demo");
    store.delete("lastScan:schwab");
    res.json({ rules });
  });
  app.post("/api/mode", (req, res) => {
    const { mode } = z.object({ mode: modeSchema }).strict().parse(req.body);
    scanner.invalidate();
    store.set("mode", mode);
    res.json({ mode });
  });
  app.post("/api/scan", async (req, res) => {
    const body = z
      .object({ mode: modeSchema.optional() })
      .strict()
      .parse(req.body || {});
    const mode: SourceMode = body.mode || store.mode;
    try {
      res.json(await scanner.run(mode));
    } catch (error) {
      if (error instanceof ProviderError && error.status === 429)
        res.setHeader("Retry-After", "30");
      throw error;
    }
  });
  app.get("/api/notifications/telegram", (_req, res) =>
    res.json(notifications.status()),
  );
  app.post("/api/notifications/telegram/configure", async (req, res) => {
    const { token } = z
      .object({
        token: z
          .string()
          .trim()
          .regex(
            /^\d{5,20}:[A-Za-z0-9_-]{20,120}$/,
            "Use the bot token supplied by BotFather.",
          ),
      })
      .strict()
      .parse(req.body);
    res.json(await notifications.configure(token));
  });
  app.post("/api/notifications/telegram/pair", async (_req, res) =>
    res.json(await notifications.pair()),
  );
  app.post("/api/notifications/telegram/confirm", async (_req, res) =>
    res.json(await notifications.confirm()),
  );
  app.put("/api/notifications/telegram", (req, res) => {
    const preferences = z
      .object({
        enabled: z.boolean(),
        horizon: z.enum(["all", "intraday", "swing"]),
      })
      .strict()
      .parse(req.body);
    res.json(notifications.setPreferences(preferences));
  });
  app.post("/api/notifications/telegram/test", async (_req, res) =>
    res.json(await notifications.test()),
  );
  app.delete("/api/notifications/telegram", (_req, res) =>
    res.json(notifications.disconnect()),
  );
  app.get("/api/journal", (_req, res) =>
    res.json({ journal: store.journal() }),
  );
  app.post("/api/journal", (req, res) => {
    const body = journalSchema.parse(req.body);
    const entry: JournalEntry = {
      ...body,
      id: randomUUID(),
      exitPrice: null,
      openedAt: Date.now(),
      closedAt: null,
      pnl: null,
    };
    store.saveEntry(entry);
    res.status(201).json({ entry });
  });
  app.patch("/api/journal/:id", (req, res) => {
    const body = closeSchema.parse(req.body);
    const entry = store.entry(req.params.id);
    if (!entry) throw new ProviderError("Paper trade not found.", 404);
    if (entry.closedAt !== null)
      throw new ProviderError("This paper trade is already closed.", 409);
    const totalFees = body.fees ?? entry.fees;
    const pnl =
      (body.exitPrice - entry.entryPrice) *
        (entry.direction === "long" ? 1 : -1) *
        entry.quantity *
        entry.multiplier -
      totalFees;
    const updated: JournalEntry = {
      ...entry,
      exitPrice: body.exitPrice,
      fees: totalFees,
      notes: body.notes ?? entry.notes,
      closedAt: Date.now(),
      pnl: Math.round(pnl * 100) / 100,
    };
    store.saveEntry(updated);
    res.json({ entry: updated });
  });
  const cookieSettings = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.origin.startsWith("https:"),
    path: "/api/auth/schwab",
    maxAge: 10 * 60_000,
  };
  app.get("/api/auth/schwab/start", (req, res) => {
    if (req.headers["sec-fetch-site"] === "cross-site")
      throw new ProviderError(
        "Open Meida before starting the connection.",
        403,
      );
    if (!config.origin.startsWith("https:"))
      throw new ProviderError(
        "Configure local HTTPS and register its exact callback URL before connecting Schwab.",
        409,
      );
    const result = auth.start();
    res.cookie("meida_oauth_state", result.state, cookieSettings);
    res.redirect(result.url);
  });
  app.get("/api/auth/schwab/callback", async (req, res) => {
    const parsed = z
      .object({
        code: z.string().min(1).max(4096).optional(),
        error: z.string().min(1).max(256).optional(),
        state: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .refine((value) => Boolean(value.code) !== Boolean(value.error))
      .safeParse(req.query);
    if (!parsed.success)
      return res.redirect(303, "/?connection=failed&reason=invalid_return");
    const { code, state, error } = parsed.data;
    const cookieState =
      (req.headers.cookie || "")
        .split(";")
        .map((item) => item.trim())
        .find((item) => item.startsWith("meida_oauth_state="))
        ?.slice("meida_oauth_state=".length) || "";
    res.clearCookie("meida_oauth_state", {
      ...cookieSettings,
      maxAge: undefined,
    });
    try {
      if (error) {
        auth.deny(
          state,
          cookieState,
          error === "access_denied" ? "denied" : "provider_error",
        );
        return res.redirect(
          303,
          `/?connection=failed&reason=${error === "access_denied" ? "declined" : "authorization_failed"}`,
        );
      }
      await auth.callback(code!, state, cookieState);
      scanner.invalidate();
      store.set("mode", "schwab");
      res.redirect(303, "/?connection=connected");
    } catch (failure) {
      const reason =
        failure instanceof ProviderError && failure.status === 400
          ? "invalid_return"
          : "authorization_failed";
      res.redirect(303, `/?connection=failed&reason=${reason}`);
    }
  });
  app.post("/api/auth/schwab/disconnect", (_req, res) => {
    scanner.invalidate();
    auth.disconnect();
    store.set("mode", "demo");
    store.delete("lastScan:schwab");
    res.json({ connection: auth.status(), mode: "demo" });
  });
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "API route not found." }),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof ZodError)
        return res.status(400).json({
          error: error.issues
            .map(
              (issue) => `${issue.path.join(".") || "Input"}: ${issue.message}`,
            )
            .join("; "),
        });
      if (error instanceof ProviderError)
        return res.status(error.status).json({ error: error.message });
      if (error instanceof SyntaxError && "body" in error)
        return res
          .status(400)
          .json({ error: "Request body must be valid JSON." });
      // Provider bodies, authorization headers, and callback query strings are never logged or returned.
      res.status(500).json({
        error:
          "The request could not be completed. Check server configuration and try again.",
      });
    },
  );
  return app;
}
