import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ServiceTokenGuard } from '../auth/service-token.guard';
import { CreatePaymentSessionDto } from './dto/create-payment-session.dto';
import { PaymentSessionsService } from './payment-sessions.service';

@Controller('payment-sessions')
@UseGuards(ServiceTokenGuard)
export class PaymentSessionsController {
  constructor(private readonly sessions: PaymentSessionsService) {}

  /**
   * 201 for a new provider order, 200 when an existing one is returned. The
   * distinction is what lets the hotel backend tell a genuine retry apart from a
   * second order it did not intend to create.
   */
  @Post()
  async create(
    @Body() dto: CreatePaymentSessionDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, session } = await this.sessions.createSession(dto);
    res.status(created ? 201 : 200);
    return session;
  }

  @Post(':paymentReference/cancel')
  @HttpCode(200)
  cancel(@Param('paymentReference') paymentReference: string) {
    return this.sessions.cancelSession(paymentReference);
  }
}
