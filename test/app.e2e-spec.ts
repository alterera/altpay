import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();

    const scheduler = app.get(SchedulerRegistry);
    for (const name of [...scheduler.getCronJobs().keys()]) {
      scheduler.deleteCronJob(name);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('responds to the liveness probe', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health');
    const body = res.body as { status: string; database: string };
    expect(res.status).toBe(200);
    expect(['ok', 'degraded']).toContain(body.status);
    expect(['up', 'down']).toContain(body.database);
  });
});
