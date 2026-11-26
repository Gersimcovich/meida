import { demoSnapshot } from "../shared/demo.ts";
import { scanMarket } from "../shared/signals.ts";
import type {
  MarketSnapshot,
  ScanResult,
  SourceMode,
} from "../shared/types.ts";
import { ProviderError, type SchwabAuth } from "./auth.ts";
import type { Store } from "./store.ts";

export interface ScanDependencies {
  store: Pick<Store, "watchlist" | "rules" | "saveScan">;
  auth: Pick<SchwabAuth, "status" | "revision">;
  provider: { snapshot(symbols: string[]): Promise<MarketSnapshot> };
}

/** One shared execution gate for HTTP requests and server-side monitoring. */
export class ScanCoordinator {
  private inFlight = false;
  private lastLiveAttempt: number | null = null;
  private configurationRevision = 0;

  constructor(
    private readonly dependencies: ScanDependencies,
    private readonly now: () => number = Date.now,
  ) {}

  get revision(): number {
    return this.configurationRevision;
  }

  /** Call before mutating settings that would make an in-flight scan obsolete. */
  invalidate(): void {
    this.configurationRevision++;
  }

  async run(mode: SourceMode): Promise<ScanResult> {
    const { store, auth, provider } = this.dependencies;
    if (this.inFlight)
      throw new ProviderError("A scan is already running.", 409);
    if (mode === "schwab" && !auth.status().connected)
      throw new ProviderError("Connect Schwab before scanning live data.", 401);
    if (
      mode === "schwab" &&
      this.lastLiveAttempt !== null &&
      this.now() - this.lastLiveAttempt < 30_000
    )
      throw new ProviderError("Wait 30 seconds between Schwab scans.", 429);

    this.inFlight = true;
    const authRevision = auth.revision;
    const scanRevision = this.configurationRevision;
    const watchlist = store.watchlist;
    const rules = store.rules;
    if (mode === "schwab") this.lastLiveAttempt = this.now();

    try {
      const snapshot =
        mode === "demo"
          ? demoSnapshot(watchlist)
          : await provider.snapshot(watchlist);
      if (scanRevision !== this.configurationRevision)
        throw new ProviderError(
          "Scan settings changed while scanning. Run a new scan.",
          409,
        );
      if (
        mode === "schwab" &&
        (auth.revision !== authRevision || !auth.status().connected)
      )
        throw new ProviderError(
          "The Schwab connection changed during the scan. Run a new scan.",
          409,
        );
      if (snapshot.mode !== mode)
        throw new ProviderError(
          "The provider returned a different data source. The scan was discarded.",
          502,
        );
      const result = scanMarket(snapshot, rules);
      store.saveScan(result);
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}
