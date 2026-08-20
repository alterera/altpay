import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolConfig } from 'pg';

function stripSslQueryParams(connectionString: string): string {
  return connectionString
    .replace(/([?&])sslmode=[^&]*&?/g, '$1')
    .replace(/([?&])uselibpqcompat=[^&]*&?/g, '$1')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '');
}

function resolvePgSsl(connectionString: string): Pick<PoolConfig, 'ssl'> {
  const normalized = connectionString.replace(/^postgresql:/, 'http:');
  const sslmode = new URL(normalized).searchParams.get('sslmode');

  if (!sslmode || sslmode === 'disable') {
    return {};
  }

  const caPath =
    process.env.DATABASE_SSL_CA_PATH ??
    join(process.cwd(), 'certs', 'global-bundle.pem');

  if (existsSync(caPath)) {
    return {
      ssl: {
        ca: readFileSync(caPath, 'utf8'),
        rejectUnauthorized: true,
      },
    };
  }

  // Encrypt without verifying the server cert (matches Prisma v6 + sslmode=require).
  return {
    ssl: {
      rejectUnauthorized: false,
    },
  };
}

export function createPrismaPgAdapter(connectionString: string): PrismaPg {
  const pool = new Pool({
    connectionString: stripSslQueryParams(connectionString),
    ...resolvePgSsl(connectionString),
  });

  return new PrismaPg(pool);
}
