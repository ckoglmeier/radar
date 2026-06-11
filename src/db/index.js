import 'dotenv/config';
import { AsyncLocalStorage } from 'async_hooks';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error(
    'Error: DATABASE_URL is not set. Copy .env.example to .env and configure a connection.\n' +
    '  Local embedded database:  DATABASE_URL=file:./radar.db\n' +
    '  Neon / Postgres:          DATABASE_URL=postgresql://user:password@host/dbname'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Driver selection
// ---------------------------------------------------------------------------

function isPgliteUrl(url) {
  return url.startsWith('file:') || url.startsWith('pglite:');
}

function pglitePathFromUrl(url) {
  return url.replace(/^(file:|pglite:)/, '');
}

// ---------------------------------------------------------------------------
// PGlite singleton (lazy async init)
// ---------------------------------------------------------------------------

const _pgliteInstances = new Map(); // dataDir → PGlite instance

async function getPgliteInstance(dataDir) {
  if (_pgliteInstances.has(dataDir)) return _pgliteInstances.get(dataDir);
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(dataDir);
  await db.waitReady;
  _pgliteInstances.set(dataDir, db);
  return db;
}

// ---------------------------------------------------------------------------
// Neon client cache
// ---------------------------------------------------------------------------

const _neonClients = new Map(); // connectionString → neon client

async function getNeonClient(url) {
  if (_neonClients.has(url)) return _neonClients.get(url);
  const { neon } = await import('@neondatabase/serverless');
  const client = neon(url);
  _neonClients.set(url, client);
  return client;
}

// ---------------------------------------------------------------------------
// Unified query function (returns plain rows array for all drivers)
// ---------------------------------------------------------------------------

/**
 * Get the appropriate client for a given connection string.
 * Returns an object with a query(text, params) method that always yields rows[].
 */
async function getDriver(connectionString) {
  if (isPgliteUrl(connectionString)) {
    const dataDir = pglitePathFromUrl(connectionString);
    const db = await getPgliteInstance(dataDir);
    return {
      async query(text, params = []) {
        const result = await db.query(text, params);
        return result.rows;
      },
      // exec handles multi-statement DDL strings (PGlite splits on ;)
      async exec(sql) {
        await db.exec(sql);
      },
      isPglite: true,
    };
  } else {
    const client = await getNeonClient(connectionString);
    return {
      async query(text, params = []) {
        return client.query(text, params);
      },
      async exec(sql) {
        // Neon doesn't have exec; run statements individually
        const statements = sql
          .split(/;\s*\n/)
          .map(s => s.trim())
          .filter(s => s.length > 0);
        for (const stmt of statements) {
          await client.query(stmt);
        }
      },
      isPglite: false,
    };
  }
}

// Default driver (for DATABASE_URL)
let _defaultDriverPromise = null;

function getDefaultDriver() {
  if (!_defaultDriverPromise) {
    _defaultDriverPromise = getDriver(DATABASE_URL);
  }
  return _defaultDriverPromise;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage for withTenant()
// ---------------------------------------------------------------------------

// Stores a driver object (from getDriver()) for the current async context.
const tenantStorage = new AsyncLocalStorage();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Run fn with a specific connection string active; query() uses it automatically. */
export async function withTenant(connectionString, fn) {
  const driver = await getDriver(connectionString);
  return tenantStorage.run(driver, fn);
}

export async function query(text, params = []) {
  const driver = tenantStorage.getStore() ?? await getDefaultDriver();
  return driver.query(text, params);
}

/** Execute a raw multi-statement SQL string (used by runSchema and tests). */
export async function exec(sql) {
  const driver = tenantStorage.getStore() ?? await getDefaultDriver();
  return driver.exec(sql);
}

export async function runSchema(schemaSQL) {
  const driver = tenantStorage.getStore() ?? await getDefaultDriver();
  if (driver.isPglite) {
    // PGlite exec handles multi-statement strings natively
    await driver.exec(schemaSQL);
  } else {
    const statements = schemaSQL
      .split(/;\s*$/m)
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      await driver.query(stmt);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy default export (neon-only callers that use `sql` directly)
// For backwards compat: expose an object with a .query() method.
// ---------------------------------------------------------------------------

// Most code uses the exported query() function. The default export was `sql`
// (a neon tagged-template function). Since new code is PGlite-compatible, we
// export a proxy object. Any remaining direct `sql` usage in old code will
// still work because it goes through the driver.
const sqlProxy = {
  query: (text, params) => query(text, params),
};

export default sqlProxy;
