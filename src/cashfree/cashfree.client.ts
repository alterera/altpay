import { Injectable, Logger } from '@nestjs/common';
import { PaymentConfig } from '../config/payment.config';
import { CashfreeOrder, CashfreePayment } from './cashfree.types';

export type CreateOrderInput = {
  /** Our `paymentReference`; Cashfree enforces uniqueness, which makes this idempotent. */
  orderId: string;
  amount: string;
  currency: string;
  reservationReference: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  returnUrl?: string;
  /** Mirrors the reservation hold, so the order cannot outlive the rooms. */
  expiresAt: Date;
};

export class CashfreeError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CashfreeError';
  }
}

/** Transport failure: the request may or may not have been seen. Always retryable. */
export class CashfreeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CashfreeUnavailableError';
  }
}

@Injectable()
export class CashfreeClient {
  private readonly logger = new Logger(CashfreeClient.name);

  constructor(private readonly config: PaymentConfig) {}

  async createOrder(input: CreateOrderInput): Promise<CashfreeOrder> {
    return this.request<CashfreeOrder>('POST', '/orders', {
      order_id: input.orderId,
      order_amount: Number(input.amount),
      order_currency: input.currency,
      order_expiry_time: input.expiresAt.toISOString(),
      order_note: `AlterStays booking ${input.reservationReference}`,
      customer_details: {
        customer_id: `res_${input.reservationReference}`,
        customer_name: input.customerName,
        customer_phone: this.normalisePhone(input.customerPhone),
        customer_email: input.customerEmail,
      },
      order_meta: {
        return_url: input.returnUrl,
        notify_url: this.config.webhookNotifyUrl || undefined,
      },
      order_tags: {
        reservationReference: input.reservationReference,
        paymentReference: input.orderId,
      },
    });
  }

  /**
   * The authority on whether a payment happened. Webhook bodies are a prompt to
   * check, never the answer — a forged or replayed body must not be able to
   * confirm a booking.
   */
  async fetchOrder(orderId: string): Promise<CashfreeOrder> {
    return this.request<CashfreeOrder>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}`,
    );
  }

  async fetchOrderPayments(orderId: string): Promise<CashfreePayment[]> {
    const payments = await this.request<CashfreePayment[]>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}/payments`,
    );
    return Array.isArray(payments) ? payments : [];
  }

  /**
   * Best-effort cancellation. Cashfree may answer `TERMINATION_REQUESTED`, and
   * will refuse outright if a transaction has just succeeded — so a success
   * webhook can still arrive after this returns.
   */
  async terminateOrder(orderId: string): Promise<CashfreeOrder> {
    return this.request<CashfreeOrder>(
      'PATCH',
      `/orders/${encodeURIComponent(orderId)}`,
      { order_status: 'TERMINATED' },
    );
  }

  buildCheckoutUrl(paymentSessionId: string): string {
    return this.config.checkoutUrlTemplate.replace(
      '{payment_session_id}',
      paymentSessionId,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.config.cashfreeBaseUrl}${path}`;
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-api-version': this.config.cashfreeApiVersion,
          'x-client-id': this.config.cashfreeClientId,
          'x-client-secret': this.config.cashfreeClientSecret,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.cashfreeTimeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Cashfree ${method} ${path} transport failure: ${reason}`,
      );
      throw new CashfreeUnavailableError(reason);
    }

    const payload = await this.readJson(response);

    if (!response.ok) {
      const { message, code } = this.errorFrom(payload);
      // Never logs the request body: it carries customer contact details.
      this.logger.error(
        `Cashfree ${method} ${path} returned ${response.status} (${code ?? 'no code'}): ${message}`,
      );
      throw new CashfreeError(response.status, message, code);
    }

    return payload as T;
  }

  private async readJson(response: Response): Promise<unknown> {
    const text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { message: text.slice(0, 500) };
    }
  }

  private errorFrom(payload: unknown): { message: string; code?: string } {
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;
      const message =
        typeof record.message === 'string'
          ? record.message
          : 'Cashfree rejected the request';
      const code = typeof record.code === 'string' ? record.code : undefined;
      return { message, code };
    }
    return { message: 'Cashfree rejected the request' };
  }

  /**
   * Cashfree wants a bare Indian mobile number; a `+91` prefix is rejected by some
   * payment methods.
   */
  private normalisePhone(phone?: string): string | undefined {
    if (!phone) return undefined;
    const digits = phone.replace(/\D/g, '');
    return digits.length > 10 ? digits.slice(-10) : digits;
  }
}
