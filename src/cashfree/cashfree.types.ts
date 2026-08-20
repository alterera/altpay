/**
 * The Cashfree surface this service depends on, and nothing more.
 *
 * Field names and shapes come from `docs/cashfree-contract.md` (API version
 * 2025-01-01). Everything is optional where Cashfree does not guarantee it, so an
 * unexpectedly sparse response fails a check rather than throwing on a property
 * access.
 */

export type CashfreeOrderStatus =
  'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED';

export type CashfreeOrder = {
  cf_order_id?: string;
  order_id?: string;
  order_status?: CashfreeOrderStatus;
  order_amount?: number;
  order_currency?: string;
  payment_session_id?: string;
  order_expiry_time?: string;
};

export type CashfreePayment = {
  cf_payment_id?: string | number;
  payment_status?: 'SUCCESS' | 'FAILED' | 'USER_DROPPED' | 'PENDING';
  payment_amount?: number;
  payment_currency?: string;
  payment_message?: string;
  payment_time?: string;
  payment_group?: string;
};

/** Webhook envelope. Only the fields listed in the frozen contract are typed. */
export type CashfreeWebhookPayload = {
  type?: string;
  event_time?: string;
  data?: {
    order?: {
      order_id?: string;
      order_amount?: number;
      order_currency?: string;
    };
    payment?: CashfreePayment;
    error_details?: {
      error_code?: string;
      error_description?: string;
      error_reason?: string;
      error_source?: string;
    };
  };
};

export const WEBHOOK_SUCCESS = 'PAYMENT_SUCCESS_WEBHOOK';
export const WEBHOOK_FAILED = 'PAYMENT_FAILED_WEBHOOK';
export const WEBHOOK_USER_DROPPED = 'PAYMENT_USER_DROPPED_WEBHOOK';
