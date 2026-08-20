import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { PaymentConfig } from '../config/payment.config';

export type HotelResponse = {
  status: number;
  body: unknown;
};

/** Transport failure, so no status code exists to act on. Always retryable. */
export class HotelUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HotelUnreachableError';
  }
}

/**
 * Sends one HMAC-signed notification to the hotel backend.
 *
 * The signature covers `${timestamp}.${body}` with the shared secret. Signing the
 * timestamp is what gives the hotel's skew check teeth: a captured request cannot
 * be kept alive by rewriting the header, because that invalidates the digest.
 */
@Injectable()
export class HotelNotifierService {
  private readonly logger = new Logger(HotelNotifierService.name);

  constructor(private readonly config: PaymentConfig) {}

  async send(eventId: string, payload: unknown): Promise<HotelResponse> {
    if (!this.config.hotelBaseUrl) {
      throw new HotelUnreachableError('HOTEL_BASE_URL is not configured');
    }

    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac(
      'sha256',
      this.config.hotelNotificationSigningSecret,
    )
      .update(`${timestamp}.${body}`)
      .digest('hex');

    let response: Response;
    try {
      response = await fetch(
        `${this.config.hotelBaseUrl}/internal/payments/notifications`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Alterera-Event-Id': eventId,
            'X-Alterera-Timestamp': timestamp,
            'X-Alterera-Signature': signature,
          },
          body,
          signal: AbortSignal.timeout(this.config.hotelTimeoutMs),
        },
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Hotel notification ${eventId} did not reach us: ${reason}`,
      );
      throw new HotelUnreachableError(reason);
    }

    return { status: response.status, body: await this.readJson(response) };
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { raw: text.slice(0, 500) };
    }
  }
}
