import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store } from './store.ts';
import type { ConnectionStatus } from '../shared/types.ts';

interface TokenSet { accessToken: string; refreshToken: string; expiresAt: number }
type Fetcher = typeof fetch;
const AUTH_URL = 'https://api.schwabapi.com/v1/oauth/authorize';
const TOKEN_URL = 'https://api.schwabapi.com/v1/oauth/token';
const MARKET_URL = 'https://api.schwabapi.com/marketdata/v1';

export class ProviderError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}
export function encryptToken(value: unknown, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
export function decryptToken<T>(value: string, hexKey: string): T {
  const data = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')) as T;
}
export function equalSecret(a: string, b: string): boolean {
  const first = Buffer.from(a); const second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}

export class SchwabAuth {
  private refreshPromise: Promise<TokenSet> | null = null;
  private reconnect = false;
  private pending = new Map<string, number>();
  private generation = 0;
  constructor(private config: Config, private store: Store, private fetcher: Fetcher = fetch) {}
  get configured() { return !!(this.config.clientId && this.config.clientSecret && this.config.encryptionKey); }
  get revision() { return this.generation; }
  private readTokens(): TokenSet | null {
    const encrypted = this.store.get<string | null>('schwabTokens', null);
    if (!encrypted || !this.config.encryptionKey) return null;
    try { return decryptToken<TokenSet>(encrypted, this.config.encryptionKey); }
    catch { this.reconnect = true; return null; }
  }
  status(): ConnectionStatus {
    const tokens = this.readTokens();
    const configured = this.configured;
    return {
      configured, connected: !!tokens && !this.reconnect, reconnectRequired: this.reconnect,
      callbackUrl: this.config.redirectUri,
      message: !configured ? 'Configure Schwab credentials and the encryption key on this server.' : this.reconnect ? 'Schwab authorization expired or could not be read. Reconnect your account.' : tokens ? 'Schwab connected. Quotes are fetched when you run a scan.' : 'Ready to authorize Market Data Production with Schwab.',
    };
  }
  start(): { state: string; url: string } {
    if (!this.configured) throw new ProviderError('Schwab credentials and encryption key are not configured.', 409);
    for (const [state, expiry] of this.pending) if (expiry < Date.now()) this.pending.delete(state);
    if (this.pending.size > 100) this.pending.clear();
    const state = randomBytes(32).toString('hex');
    this.pending.set(state, Date.now() + 10 * 60_000);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code', scope: 'readonly', state }).toString();
    return { state, url: url.toString() };
  }
  async callback(code: string, state: string, cookieState: string) {
    const expiry = this.pending.get(state);
    if (!state || !cookieState || !equalSecret(state, cookieState) || !expiry || expiry < Date.now()) {
      throw new ProviderError('Authorization state is invalid or expired. Start the connection again.', 400);
    }
    this.pending.delete(state);
    const generation = this.generation;
    const tokens = await this.exchange(new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: this.config.redirectUri }));
    if (generation !== this.generation) throw new ProviderError('This connection attempt was canceled. Start again.', 409);
    this.save(tokens); this.reconnect = false;
    this.generation++; this.pending.clear();
  }
  disconnect() { this.generation++; this.store.delete('schwabTokens'); this.pending.clear(); this.reconnect = false; }
  private save(tokens: TokenSet) { this.store.set('schwabTokens', encryptToken(tokens, this.config.encryptionKey)); }
  private async exchange(body: URLSearchParams, previousRefresh?: string): Promise<TokenSet> {
    let response: Response;
    try {
      response = await this.fetcher(TOKEN_URL, {method:'POST', headers:{Authorization:`Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')}`, 'Content-Type':'application/x-www-form-urlencoded'}, body, signal:AbortSignal.timeout(15_000)});
    } catch { throw new ProviderError('Could not reach Schwab authorization. Try again.'); }
    if (!response.ok) {
      let oauthError = '';
      try { const body = await response.json() as {error?:unknown}; if (typeof body.error === 'string') oauthError = body.error; } catch { /* provider bodies are never exposed */ }
      if (response.status === 401 || (response.status === 400 && ['invalid_grant','invalid_client'].includes(oauthError))) throw new ProviderError('Schwab rejected authorization. Check your app configuration or reconnect.',401);
      if (response.status === 429) throw new ProviderError('Schwab authorization is rate limited. Wait before trying again.',429);
      throw new ProviderError('Schwab authorization is temporarily unavailable. Try again later.',502);
    }
    const value = await response.json() as Record<string, unknown>;
    const refreshToken = typeof value.refresh_token === 'string' ? value.refresh_token : previousRefresh;
    if (typeof value.access_token !== 'string' || !value.access_token || !refreshToken || typeof value.expires_in !== 'number' || value.expires_in <= 0) {
      throw new ProviderError('Schwab returned an incomplete authorization response.');
    }
    return {accessToken:value.access_token, refreshToken, expiresAt:Date.now() + value.expires_in * 1000};
  }
  private async token(forceRefresh = false): Promise<TokenSet> {
    if (!this.configured) throw new ProviderError('Configure Schwab server credentials before scanning live data.', 409);
    const tokens = this.readTokens();
    if (!tokens || this.reconnect) throw new ProviderError('Connect Schwab before scanning live data.', 401);
    if (!forceRefresh && tokens.expiresAt > Date.now() + 60_000) return tokens;
    if (!this.refreshPromise) {
      const generation = this.generation;
      this.refreshPromise = this.exchange(new URLSearchParams({grant_type:'refresh_token', refresh_token:tokens.refreshToken}), tokens.refreshToken)
        .then(next => {
          if (generation !== this.generation) throw new ProviderError('Schwab was disconnected while authorization was refreshing.', 401);
          this.save(next); return next;
        }).catch(error => {
          if (generation === this.generation && error instanceof ProviderError && error.status === 401) this.reconnect = true;
          throw error;
        }).finally(() => { this.refreshPromise = null; });
    }
    return this.refreshPromise;
  }
  async marketData(path: string, params: Record<string, string>): Promise<unknown> {
    if (!['/quotes','/chains','/pricehistory','/markets'].includes(path)) throw new ProviderError('Unsupported market-data endpoint.', 400);
    const generation = this.generation;
    const stillConnected = () => { if (generation !== this.generation) throw new ProviderError('Schwab connection changed during the request.',409); };
    const url = new URL(`${MARKET_URL}${path}`); url.search = new URLSearchParams(params).toString();
    const request = async (tokens: TokenSet) => {
      try { return await this.fetcher(url, {headers:{Authorization:`Bearer ${tokens.accessToken}`,Accept:'application/json'}, signal:AbortSignal.timeout(20_000)}); }
      catch { throw new ProviderError('Schwab market data request timed out or could not connect.'); }
    };
    let response = await request(await this.token());
    stillConnected();
    if (response.status === 401) { response = await request(await this.token(true)); stillConnected(); }
    if (!response.ok) {
      if (response.status === 401) this.reconnect = true;
      const message = response.status === 429 ? 'Schwab rate limit reached. Wait before scanning again.' : response.status === 401 ? 'Schwab authorization expired. Reconnect your account.' : response.status === 403 ? 'Schwab denied market data access. Verify your product approval and data entitlements.' : `Schwab market data returned HTTP ${response.status}.`;
      throw new ProviderError(message, response.status === 429 ? 429 : response.status === 401 ? 401 : 502);
    }
    try { return await response.json(); } catch { throw new ProviderError('Schwab returned an unreadable market-data response.'); }
  }
}
