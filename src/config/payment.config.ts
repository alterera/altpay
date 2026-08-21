import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_API_VERSION = '2025-01-01';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_WEBHOOK_SKEW_SECONDS = 300;
const DEFAULT_HOTEL_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_RECONCILE_AFTER_MINUTES = 10;

const SANDBOX_BASE_URL = 'https://sandbox.cashfree.com/pg';
const PRODUCTION_BASE_URL = 'https://api.cashfree.com/pg';
const SANDBOX_CHECKOUT =
  'https://payments-test.cashfree.com/order/#{payment_session_id}';
const PRODUCTION_CHECKOUT =
  'https://payments.cashfree.com/order/#{payment_session_id}';

/**
 * Retry schedule for hotel notifications, in seconds after the previous attempt.
 * Front-loaded so a brief hotel restart resolves in under a minute, then widening
 * so a longer outage does not generate noise.
 */
const DEFAULT_BACKOFF_SECONDS = [30, 120, 600, 1800, 7200, 21600];

/**
 * Every setting the service reads, parsed once.
 *
 * See `docs/cashfree-contract.md` for what each Cashfree value means and where it
 * comes from. Secrets are read here and never logged.
 */
@Injectable()
export class PaymentConfig {
  private readonly logger = new Logger(PaymentConfig.name);

  constructor(private readonly config: ConfigService) {}

  get isProduction(): boolean {
    return this.config.get<string>('CASHFREE_ENV') === 'PRODUCTION';
  }

  /** Cashfree JS SDK mode — must match the environment that minted the session. */
  get cashfreeMode(): 'production' | 'sandbox' {
    return this.isProduction ? 'production' : 'sandbox';
  }

  get cashfreeBaseUrl(): string {
    const explicit = this.config.get<string>('CASHFREE_BASE_URL');
    if (explicit) return explicit.replace(/\/+$/, '');
    return this.isProduction ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
  }

  get cashfreeApiVersion(): string {
    return (
      this.config.get<string>('CASHFREE_API_VERSION') ?? DEFAULT_API_VERSION
    );
  }

  get cashfreeClientId(): string {
    return this.config.getOrThrow<string>('CASHFREE_CLIENT_ID');
  }

  /** Also the webhook signing key — Cashfree signs with the same secret. */
  get cashfreeClientSecret(): string {
    return this.config.getOrThrow<string>('CASHFREE_CLIENT_SECRET');
  }

  /**
   * Checkout URL template with a `{payment_session_id}` placeholder. Kept in
   * configuration because it is the one value in the Cashfree contract that has to
   * be confirmed per merchant account.
   */
  get checkoutUrlTemplate(): string {
    return (
      this.config.get<string>('CASHFREE_CHECKOUT_URL_TEMPLATE') ??
      (this.isProduction ? PRODUCTION_CHECKOUT : SANDBOX_CHECKOUT)
    );
  }

  get cashfreeTimeoutMs(): number {
    return this.positiveInt('CASHFREE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS);
  }

  get webhookMaxSkewSeconds(): number {
    return this.positiveInt(
      'CASHFREE_WEBHOOK_MAX_SKEW_SECONDS',
      DEFAULT_WEBHOOK_SKEW_SECONDS,
    );
  }

  /** Public URL Cashfree posts webhooks to, sent per order as `notify_url`. */
  get webhookNotifyUrl(): string {
    return this.config.get<string>('CASHFREE_NOTIFY_URL') ?? '';
  }

  /** Bearer token the hotel backend must present. */
  get hotelServiceToken(): string {
    return this.config.getOrThrow<string>('HOTEL_SERVICE_TOKEN');
  }

  get hotelBaseUrl(): string {
    return this.config.get<string>('HOTEL_BASE_URL')?.replace(/\/+$/, '') ?? '';
  }

  /** Shared secret we sign outbound notifications with. */
  get hotelNotificationSigningSecret(): string {
    return this.config.getOrThrow<string>('HOTEL_NOTIFICATION_SIGNING_SECRET');
  }

  get hotelTimeoutMs(): number {
    return this.positiveInt('HOTEL_TIMEOUT_MS', DEFAULT_HOTEL_TIMEOUT_MS);
  }

  get notificationMaxAttempts(): number {
    return this.positiveInt(
      'HOTEL_NOTIFICATION_MAX_ATTEMPTS',
      DEFAULT_MAX_ATTEMPTS,
    );
  }

  /** Delay before attempt N+1, clamped to the last configured step. */
  backoffSecondsForAttempt(attempt: number): number {
    const schedule = this.backoffSchedule;
    const index = Math.min(Math.max(attempt - 1, 0), schedule.length - 1);
    return schedule[index];
  }

  private get backoffSchedule(): number[] {
    const raw = this.config.get<string>('HOTEL_NOTIFICATION_BACKOFF_SECONDS');
    if (!raw) return DEFAULT_BACKOFF_SECONDS;

    const parsed = raw
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);

    return parsed.length ? parsed : DEFAULT_BACKOFF_SECONDS;
  }

  /** How long a transaction may sit PENDING before reconciliation looks at it. */
  get reconcileAfterMs(): number {
    return (
      this.positiveInt(
        'RECONCILE_PENDING_AFTER_MINUTES',
        DEFAULT_RECONCILE_AFTER_MINUTES,
      ) *
      60 *
      1000
    );
  }

  private positiveInt(key: string, fallback: number): number {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      this.logger.warn(
        `${key}="${raw}" is not a positive number; using ${fallback}`,
      );
      return fallback;
    }
    return Math.floor(parsed);
  }
}
