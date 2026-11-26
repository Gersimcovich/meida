import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_RULES,
  type JournalEntry,
  type Rules,
  type ScanResult,
  type SourceMode,
} from "../shared/types.ts";

export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal (id TEXT PRIMARY KEY, opened_at INTEGER NOT NULL, entry TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS alerts (id TEXT PRIMARY KEY, observed_at INTEGER NOT NULL, signal TEXT NOT NULL);`);
    if (path !== ":memory:") chmodSync(path, 0o600);
  }
  get<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  delete(key: string) {
    this.db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  }
  /** Consume a one-use value atomically, including across overlapping processes. */
  take<T>(key: string): T | null {
    const row = this.db
      .prepare("DELETE FROM settings WHERE key = ? RETURNING value")
      .get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }
  get watchlist(): string[] {
    return this.get("watchlist", [
      "NVDA",
      "AAPL",
      "MSFT",
      "TSLA",
      "AMD",
      "SPY",
    ]);
  }
  get rules(): Rules {
    return this.get("rules", structuredClone(DEFAULT_RULES));
  }
  get mode(): SourceMode {
    return this.get("mode", "demo");
  }
  get lastScan(): ScanResult | null {
    return this.get(`lastScan:${this.mode}`, null);
  }
  saveScan(scan: ScanResult) {
    this.set(`lastScan:${scan.mode}`, scan);
    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO alerts(id,observed_at,signal) VALUES(?,?,?)",
    );
    for (const signal of scan.signals)
      statement.run(
        `${scan.mode}:${signal.id}`,
        scan.asOf,
        JSON.stringify(signal),
      );
  }
  journal(): JournalEntry[] {
    return (
      this.db
        .prepare("SELECT entry FROM journal ORDER BY opened_at DESC LIMIT 2000")
        .all() as { entry: string }[]
    ).map((row) => JSON.parse(row.entry));
  }
  entry(id: string): JournalEntry | null {
    const row = this.db
      .prepare("SELECT entry FROM journal WHERE id = ?")
      .get(id) as { entry: string } | undefined;
    return row ? JSON.parse(row.entry) : null;
  }
  saveEntry(entry: JournalEntry) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO journal(id,opened_at,entry) VALUES(?,?,?)",
      )
      .run(entry.id, entry.openedAt, JSON.stringify(entry));
  }
  close() {
    this.db.close();
  }
}
