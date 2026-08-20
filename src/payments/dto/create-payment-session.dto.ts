import { Type } from 'class-transformer';
import {
  IsEmail,
  IsISO8601,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class SessionCustomerDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  email?: string;
}

/**
 * What the hotel backend sends to open a checkout.
 *
 * `amount` is a decimal string on purpose: it originates from a `Decimal(12,2)`
 * column, and a JSON float is the one representation guaranteed to lose that
 * exactness somewhere along the way.
 */
export class CreatePaymentSessionDto {
  @IsString()
  @MaxLength(200)
  paymentReference!: string;

  @IsString()
  @MaxLength(64)
  reservationReference!: string;

  @Matches(/^\d{1,10}(\.\d{1,2})?$/, {
    message: 'amount must be a decimal string such as "8700.00"',
  })
  amount!: string;

  @Matches(/^[A-Z]{3}$/, { message: 'currency must be a 3-letter ISO code' })
  currency!: string;

  @ValidateNested()
  @Type(() => SessionCustomerDto)
  customer!: SessionCustomerDto;

  @IsUrl({ require_tld: false })
  @MaxLength(500)
  returnUrl!: string;

  /** The reservation's hold expiry. Becomes the Cashfree order expiry. */
  @IsISO8601()
  expiresAt!: string;
}
