import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import type { CookieOptions, Request } from "express";
import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { ProviderError } from "./auth.ts";

const derive = promisify(scrypt);
const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const lifetime = 12 * 60 * 60_000;
const attemptWindow = 15 * 60_000;
interface Session {
  expiresAt: number;
  fingerprint: string;
  createdAt: number;
}
interface Attempt {
  id: number;
  time: number;
  client: string;
}
type RequestHeaders = Pick<Request, "headers">;

/** Single-owner authentication. Brokerage tokens never participate in browser sessions. */
export class OwnerAuth {
  readonly required: boolean;
  readonly cookieOptions: CookieOptions;
  private readonly salt = randomBytes(32);
  private readonly expected: Promise<Buffer>;
  private readonly fingerprint: string;
  private attempts: Attempt[] = [];
  private nextAttempt = 0;

  constructor(
    config: Config,
    private readonly store: Store,
    private readonly now: () => number = Date.now,
  ) {
    this.required = config.hosted;
    this.cookieOptions = {
      httpOnly: true,
      secure: config.origin.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: lifetime,
    };
    if (!this.required) {
      this.expected = Promise.resolve(Buffer.alloc(32));
      this.fingerprint = "";
      return;
    }
    if (!config.ownerPassword || config.ownerPassword.length > 1024)
      throw new Error("Hosted Meida requires an owner password.");
    let rotationSalt = store.get<string>("ownerRotationSalt", "");
    if (!/^[a-f0-9]{64}$/.test(rotationSalt)) {
      rotationSalt = randomBytes(32).toString("hex");
      store.set("ownerRotationSalt", rotationSalt);
    }
    // A stable, slow-derived fingerprint invalidates sessions on password rotation.
    // Never persist a fast unsalted password digest that enables cheap offline guesses.
    this.fingerprint = hash(
      scryptSync(config.ownerPassword, Buffer.from(rotationSalt, "hex"), 32),
    );
    this.expected = derive(
      config.ownerPassword,
      this.salt,
      32,
    ) as Promise<Buffer>;
    this.sessions();
  }

  private token(req: RequestHeaders): string | null {
    const matches = (req.headers.cookie || "")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.startsWith("meida_owner="));
    if (matches.length !== 1) return null;
    const token = matches[0].slice("meida_owner=".length);
    return /^[a-f0-9]{64}$/.test(token) ? token : null;
  }

  private sessions(): Record<string, Session> {
    const saved = this.store.get<Record<string, Session>>("ownerSessions", {});
    const sessions: Record<string, Session> = {};
    const now = this.now();
    for (const [key, value] of Object.entries(saved)) {
      if (
        /^[a-f0-9]{64}$/.test(key) &&
        value &&
        value.fingerprint === this.fingerprint &&
        Number.isFinite(value.expiresAt) &&
        value.expiresAt > now &&
        value.expiresAt <= now + lifetime &&
        Number.isFinite(value.createdAt)
      )
        sessions[key] = value;
    }
    if (Object.keys(saved).length !== Object.keys(sessions).length)
      this.store.set("ownerSessions", sessions);
    return sessions;
  }

  session(req: RequestHeaders): boolean {
    if (!this.required) return true;
    const token = this.token(req);
    return token !== null && !!this.sessions()[hash(token)];
  }

  async login(password: string, clientKey: string): Promise<string> {
    if (!this.required)
      throw new ProviderError(
        "Owner sign-in is not enabled for this local app.",
        400,
      );
    const now = this.now();
    const client = hash(clientKey.slice(0, 256));
    this.attempts = this.attempts.filter(
      (attempt) => attempt.time > now - attemptWindow,
    );
    if (
      this.attempts.length >= 30 ||
      this.attempts.filter((attempt) => attempt.client === client).length >= 5
    ) {
      throw new ProviderError(
        "Too many sign-in attempts. Try again in 15 minutes.",
        429,
      );
    }
    // Reserve before asynchronous work, so simultaneous attempts cannot bypass limits.
    const attempt = { id: ++this.nextAttempt, time: now, client };
    this.attempts.push(attempt);
    if (typeof password !== "string" || password.length > 1024 || !password)
      throw new ProviderError("Invalid credentials.", 401);
    const [supplied, expected] = await Promise.all([
      derive(password, this.salt, 32) as Promise<Buffer>,
      this.expected,
    ]);
    if (!timingSafeEqual(supplied, expected))
      throw new ProviderError("Invalid credentials.", 401);
    // Remove this successful reservation, preserving earlier failed attempts.
    this.attempts = this.attempts.filter((item) => item.id !== attempt.id);
    const token = randomBytes(32).toString("hex");
    const sessions = this.sessions();
    const oldest = Object.entries(sessions).sort(
      (a, b) => a[1].createdAt - b[1].createdAt,
    );
    for (const [key] of oldest.slice(0, Math.max(0, oldest.length - 99)))
      delete sessions[key];
    const issuedAt = this.now();
    sessions[hash(token)] = {
      createdAt: issuedAt,
      expiresAt: issuedAt + lifetime,
      fingerprint: this.fingerprint,
    };
    this.store.set("ownerSessions", sessions);
    return token;
  }

  logout(req: RequestHeaders): void {
    if (!this.required) return;
    const token = this.token(req);
    if (!token) return;
    const sessions = this.sessions();
    delete sessions[hash(token)];
    this.store.set("ownerSessions", sessions);
  }
}
