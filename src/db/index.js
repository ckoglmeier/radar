import 'dotenv/config';
import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL) {
  console.error('Error: DATABASE_URL is not set. Copy .env.example to .env and configure your Neon connection string.');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

export async function query(text, params = []) {
  return sql.query(text, params);
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
