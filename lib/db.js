const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inventory (
      price_id TEXT PRIMARY KEY,
      stock INTEGER NOT NULL CHECK (stock >= 0)
    );
    CREATE TABLE IF NOT EXISTS reservations (
      reservation_id TEXT NOT NULL,
      session_id TEXT,
      price_id TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (reservation_id, price_id)
    );
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      tokens INTEGER NOT NULL,
      last_refill_ms BIGINT NOT NULL
    );
  `);
}

let schemaReadyPromise = null;
async function ensureInit() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = initSchema().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

async function getStocksMap(priceIds) {
  if (!priceIds || priceIds.length === 0) return {};
  const res = await pool.query('SELECT price_id, stock FROM inventory WHERE price_id = ANY($1)', [priceIds]);
  const map = {};
  for (const row of res.rows) map[row.price_id] = Number(row.stock) || 0;
  return map;
}

async function upsertInventory(priceId, stock) {
  await pool.query(
    'INSERT INTO inventory (price_id, stock) VALUES ($1, $2) ON CONFLICT (price_id) DO UPDATE SET stock = EXCLUDED.stock',
    [priceId, Math.floor(stock)]
  );
}

async function reserveStock(reservationId, items) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const now = Date.now();
    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      if (qty <= 0) throw new Error('Invalid quantity');
      const updated = await client.query(
        'UPDATE inventory SET stock = stock - $1 WHERE price_id = $2 AND stock >= $1',
        [qty, item.price]
      );
      if (updated.rowCount === 0) {
        throw new Error('Insufficient stock for item ' + item.price);
      }
      await client.query(
        'INSERT INTO reservations (reservation_id, session_id, price_id, quantity, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [reservationId, null, item.price, qty, 'reserved', now]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function releaseReservation(reservationId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      'SELECT price_id, quantity FROM reservations WHERE reservation_id = $1 AND status = $2',
      [reservationId, 'reserved']
    );
    for (const row of res.rows) {
      await client.query('UPDATE inventory SET stock = stock + $1 WHERE price_id = $2', [row.quantity, row.price_id]);
    }
    await client.query(
      'UPDATE reservations SET status = $1 WHERE reservation_id = $2 AND status = $3',
      ['released', reservationId, 'reserved']
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function commitReservationBySession(sessionId) {
  await pool.query('UPDATE reservations SET status = $1 WHERE session_id = $2 AND status = $3', ['committed', sessionId, 'reserved']);
}

async function linkReservationToSession(sessionId, reservationId) {
  await pool.query('UPDATE reservations SET session_id = $1 WHERE reservation_id = $2', [sessionId, reservationId]);
}

async function findReservedReservationIdBySession(sessionId) {
  const row = await pool.query('SELECT reservation_id FROM reservations WHERE session_id = $1 AND status = $2 LIMIT 1', [sessionId, 'reserved']);
  return row.rows[0] ? row.rows[0].reservation_id : null;
}

// Simple token bucket rate limiter using Postgres
// rateLimit({ key: string, capacity: number, refillTokens: number, refillIntervalMs: number })
async function rateLimit({ key, capacity, refillTokens, refillIntervalMs }) {
  const now = Date.now();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query('SELECT tokens, last_refill_ms FROM rate_limits WHERE key = $1 FOR UPDATE', [key]);
    let tokens;
    let lastRefill;
    if (cur.rowCount === 0) {
      tokens = capacity;
      lastRefill = now;
      await client.query('INSERT INTO rate_limits (key, tokens, last_refill_ms) VALUES ($1, $2, $3)', [key, tokens, lastRefill]);
    } else {
      tokens = Number(cur.rows[0].tokens) || 0;
      lastRefill = Number(cur.rows[0].last_refill_ms) || now;
    }
    const elapsed = Math.max(0, now - lastRefill);
    if (elapsed >= refillIntervalMs) {
      const increments = Math.floor(elapsed / refillIntervalMs);
      tokens = Math.min(capacity, tokens + increments * refillTokens);
      lastRefill = lastRefill + increments * refillIntervalMs;
      await client.query('UPDATE rate_limits SET tokens = $1, last_refill_ms = $2 WHERE key = $3', [tokens, lastRefill, key]);
    }
    if (tokens <= 0) {
      await client.query('COMMIT');
      return { allowed: false, tokens: 0 };
    }
    tokens -= 1;
    await client.query('UPDATE rate_limits SET tokens = $1 WHERE key = $2', [tokens, key]);
    await client.query('COMMIT');
    return { allowed: true, tokens };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  ensureInit,
  initSchema,
  getStocksMap,
  upsertInventory,
  reserveStock,
  releaseReservation,
  commitReservationBySession,
  linkReservationToSession,
  findReservedReservationIdBySession,
  rateLimit
};


