export type AlertHorizon = "all" | "intraday" | "swing";

export interface TelegramStatus {
  available: boolean;
  configured: boolean;
  paired: boolean;
  enabled: boolean;
  horizon: AlertHorizon;
  botUsername: string | null;
  chatLabel: string | null;
  pairingUrl: string | null;
  pairingExpiresAt: number | null;
  lastScanAt: number | null;
  lastSentAt: number | null;
  lastError: string | null;
  message: string;
}
