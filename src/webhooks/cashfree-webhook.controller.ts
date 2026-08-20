import {
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { CashfreeWebhookPayload } from '../cashfree/cashfree.types';
import { CashfreeSignatureService } from './cashfree-signature.service';
import { CashfreeWebhookService } from './cashfree-webhook.service';

type RawBodyRequest = Request & { rawBody?: Buffer };

/**
 * Cashfree's entry point. Publicly reachable; the signature is the authentication.
 *
 * The handler takes the raw request rather than a validated DTO on purpose. The
 * global pipe's `forbidNonWhitelisted` would reject a provider payload the moment
 * Cashfree added a field, and rejecting real webhooks over a schema mismatch is a
 * far worse failure than tolerating unknown keys we never read.
 */
@Controller('webhooks/cashfree')
export class CashfreeWebhookController {
  private readonly logger = new Logger(CashfreeWebhookController.name);

  constructor(
    private readonly signatures: CashfreeSignatureService,
    private readonly webhooks: CashfreeWebhookService,
  ) {}

  /**
   * Always 200 once the event is durably stored, even when downstream processing
   * decides to do nothing. Cashfree retries on non-2xx, and re-delivering an event
   * we have already banked adds load without adding information.
   */
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest) {
    const verification = this.signatures.verify(
      req.rawBody,
      this.header(req, 'x-webhook-signature'),
      this.header(req, 'x-webhook-timestamp'),
    );

    if (!verification.verified) {
      this.logger.warn(`Rejected Cashfree webhook: ${verification.reason}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }

    const payload = this.parse(req.rawBody!);
    const eventId = this.signatures.resolveEventId(
      payload,
      this.header(req, 'x-idempotency-key'),
    );

    const outcome = await this.webhooks.handle(eventId, payload);
    return { received: true, outcome };
  }

  private parse(rawBody: Buffer): CashfreeWebhookPayload {
    try {
      return JSON.parse(rawBody.toString('utf8')) as CashfreeWebhookPayload;
    } catch {
      // Signature already matched, so this is our problem rather than an attack.
      throw new UnauthorizedException('Webhook body is not valid JSON');
    }
  }

  private header(req: Request, name: string): string | undefined {
    const value = req.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
