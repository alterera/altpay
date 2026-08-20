import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { PaymentConfig } from '../config/payment.config';

/**
 * Authenticates the hotel backend calling in.
 *
 * A static bearer token is adequate for this direction because the calls it
 * guards only ever create or cancel a checkout session — they cannot move money
 * or change a reservation. The reverse direction, which can, is HMAC-signed
 * instead.
 */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly config: PaymentConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('A service token is required');
    }

    if (!this.matches(header.slice('Bearer '.length))) {
      throw new UnauthorizedException('Invalid service token');
    }

    return true;
  }

  private matches(presented: string): boolean {
    const expected = Buffer.from(this.config.hotelServiceToken, 'utf8');
    const actual = Buffer.from(presented, 'utf8');
    // Length inequality is checked first because timingSafeEqual throws on it —
    // and the check itself would leak the length either way.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }
}
