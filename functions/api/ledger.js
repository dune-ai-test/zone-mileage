/**
 * Zone Mileage - D1 ledger endpoint for Cloudflare Pages Functions.
 *
 *   GET /api/ledger  -> current ledger + version
 *   PUT /api/ledger  -> replace the ledger
 *
 * D1 is bound in the Cloudflare dashboard, not in a wrangler.toml:
 *   Pages project -> Settings -> Functions -> D1 database bindings
 *   Variable name: DB
 *
 * The table is created on the first request, so schema.sql is optional.
 */

const API_MARK = { 'x-zone-mileage-api': 'ledger/1' };
const MAX_PAYLOAD_BYTES = 512_000;
const ROW_ID = 'default';

let schemaReady = false;

function headers(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...API_MARK,
    ...extra,
  };
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers() });
}

function isValidLedger(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && Array.isArray(data.vehicles)
    && Array.isArray(data.entries)
  );
}

async function ensureSchema(env) {
  if (!env || !env.DB) {
    return 'The DB binding is missing. Add it in Pages > Settings > Functions > D1 database bindings.';
  }

  if (schemaReady) return '';

  try {
    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS ledger (
         id         TEXT PRIMARY KEY,
         payload    TEXT NOT NULL,
         updated_at INTEGER NOT NULL,
         version    INTEGER NOT NULL DEFAULT 1
       )`
    ).run();
    schemaReady = true;
    return '';
  } catch (error) {
    return error && error.message ? error.message : 'Could not initialize the D1 schema.';
  }
}

export async function onRequestGet({ env }) {
  const schemaError = await ensureSchema(env);
  if (schemaError) return reply({ error: schemaError }, 503);

  try {
    const row = await env.DB
      .prepare('SELECT payload, updated_at, version FROM ledger WHERE id = ?')
      .bind(ROW_ID)
      .first();

    if (!row) {
      return reply({ app: 'zone-mileage', empty: true }, 404);
    }

    let data;
    try {
      data = JSON.parse(row.payload);
    } catch {
      return reply({ error: 'The stored ledger is not valid JSON.' }, 500);
    }

    return reply({
      app: 'zone-mileage',
      data,
      version: Number(row.version) || 1,
      updatedAt: Number(row.updated_at) || 0,
    });
  } catch (error) {
    return reply(
      { error: error && error.message ? error.message : 'Could not read the ledger.' },
      500
    );
  }
}

export async function onRequestPut({ request, env }) {
  const schemaError = await ensureSchema(env);
  if (schemaError) return reply({ error: schemaError }, 503);

  let raw;
  try {
    raw = await request.text();
  } catch {
    return reply({ error: 'Could not read the request body.' }, 400);
  }

  if (raw.length > MAX_PAYLOAD_BYTES) {
    return reply({ error: 'That ledger is too large for D1 (512 KB maximum).' }, 413);
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return reply({ error: 'The request body is not valid JSON.' }, 400);
  }

  if (!isValidLedger(body && body.data)) {
    return reply({ error: 'The request does not contain a valid ledger.' }, 422);
  }

  const payload = JSON.stringify(body.data);
  if (payload.length > MAX_PAYLOAD_BYTES) {
    return reply({ error: 'That ledger is too large for D1 (512 KB maximum).' }, 413);
  }

  const now = Date.now();

  try {
    await env.DB
      .prepare(
        `INSERT INTO ledger (id, payload, updated_at, version)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(id) DO UPDATE SET
           payload = excluded.payload,
           updated_at = excluded.updated_at,
           version = ledger.version + 1`
      )
      .bind(ROW_ID, payload, now)
      .run();

    const row = await env.DB
      .prepare('SELECT version, updated_at FROM ledger WHERE id = ?')
      .bind(ROW_ID)
      .first();

    return reply({
      ok: true,
      version: row ? Number(row.version) || 1 : 1,
      updatedAt: row ? Number(row.updated_at) || now : now,
    });
  } catch (error) {
    return reply(
      { error: error && error.message ? error.message : 'Could not save the ledger.' },
      500
    );
  }
}

export async function onRequestOptions() {
  // Same-origin only: no Access-Control-Allow-Origin, so browsers refuse
  // cross-origin writes instead of letting another site overwrite the ledger.
  return new Response(null, {
    status: 204,
    headers: headers({ allow: 'GET, PUT, OPTIONS' }),
  });
}
