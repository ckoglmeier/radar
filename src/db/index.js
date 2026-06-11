import 'dotenv/config';
import { neon } from '@neondatabase/serverless';
import { AsyncLocalStorage } from 'async_hooks';

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL is not set. Copy .env.example to .env and configure your Neon connection string.');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ALS holds a neon() client for the current tenant when running inside withTenant().
const tenantStorage = new AsyncLocalStorage();
// Lazily-created clients keyed by connection string (one per tenant, reused across requests).
const clientCache = new Map();

/** Run fn with a per-tenant neon client active; query() uses it automatically. */
export function withTenant(connectionString, fn) {
  let client = clientCache.get(connectionString);
  if (!client) { client = neon(connectionString); clientCache.set(connectionString, client); }
  return tenantStorage.run(client, fn);
}

export async function query(text, params = []) {
  const client = tenantStorage.getStore() ?? sql;
  return client.query(text, params);
}

export async function runSchema(schemaSQL) {
  const statements = schemaSQL
    .split(/;\s*$/m)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  for (const stmt of statements) {
    await sql.query(stmt);
  }
}

export default sql;
