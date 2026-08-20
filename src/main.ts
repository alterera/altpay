import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  // Cashfree signs the exact bytes it sends, so verification needs the untouched
  // body. Re-serialising the parsed JSON changes amounts like 170.00 into 170 and
  // the signature stops matching.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.setGlobalPrefix('api/v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // No CORS. Nothing here is called from a browser: the hotel backend calls in
  // server-to-server, and Cashfree posts webhooks. Anything arriving with an
  // Origin header is already suspect.

  const port = Number(process.env.PORT ?? 3002);
  await app.listen(port, '0.0.0.0');
  console.log(`Payment service listening on http://0.0.0.0:${port}/api/v1`);
}

void bootstrap();
