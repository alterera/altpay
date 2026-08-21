import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, type PoolConfig } from 'pg';

function stripPrismaQueryParams(connectionString: string): string {
  return connectionString
    .replace(/([?&])sslmode=[^&]*&?/g, '$1')
    .replace(/([?&])uselibpqcompat=[^&]*&?/g, '$1')
    // Prisma-only; runtime pg uses search_path instead.
    .replace(/([?&])schema=[^&]*&?/g, '$1')
    .replace(/\?&/, '?')
    .replace(/[?&]$/, '');
}

function resolvePgSchema(connectionString: string): string | undefined {
  const normalized = connectionString.replace(/^postgresql:/, 'http:');
  const schema = new URL(normalized).searchParams.get('schema');
  return schema && schema.length > 0 ? schema : undefined;
}

function resolveSearchPath(
  schema: string | undefined,
): Pick<PoolConfig, 'options'> | Record<string, never> {
  if (!schema) {
    return {};
  }

  return { options: `-c search_path=${schema}` };
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
  const schema = resolvePgSchema(connectionString);
  const pool = new Pool({
    connectionString: stripPrismaQueryParams(connectionString),
    ...resolvePgSsl(connectionString),
    ...resolveSearchPath(schema),
  });

  return new PrismaPg(pool);
}
