require('dotenv').config();
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { Pool } = require('pg');
const crypto = require('crypto');

// Replace with your Stripe secret key (Test key for testing)
// Keep this out of client-side code.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY;

const stripe = require('stripe')(STRIPE_SECRET_KEY);

const app = express();
// Use JSON body parser for all routes EXCEPT the Stripe webhook (which needs raw body)
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  return bodyParser.json()(req, res, next);
});

// Postgres setup for inventory and reservations
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
  `);
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

// Basic Auth middleware for admin.html
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
function basicAuth(req, res, next) {
  if (!ADMIN_USER || !ADMIN_PASS) return next(); // not configured
  const hdr = req.headers.authorization || '';
  if (!hdr.startsWith('Basic ')) return res.status(401).set('WWW-Authenticate', 'Basic realm="admin"').end('Auth required');
  const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  return res.status(401).set('WWW-Authenticate', 'Basic realm="admin"').end('Invalid credentials');
}

app.get('/admin.html', basicAuth, (req, res, next) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.use(express.static(path.join(__dirname)));

// List active products with their default prices for the frontend
app.get('/products', async (req, res) => {
  try {
    const prices = await stripe.prices.list({ active: true, expand: ['data.product'] });
    const filtered = prices.data.filter(p => p.active && p.product && p.unit_amount != null);
    const priceIds = filtered.map(p => p.id);
    const stocks = await getStocksMap(priceIds);
    const items = filtered.map(p => ({
      id: p.product.id,
      name: typeof p.product === 'object' ? p.product.name : 'Product',
      description: typeof p.product === 'object' ? p.product.description : '',
      priceId: p.id,
      currency: p.currency,
      unitAmount: p.unit_amount,
      stock: stocks[p.id] || 0
    }));
    res.json({ products: items });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load products');
  }
});

// Simple admin endpoint to set inventory counts
app.post('/admin/inventory', async (req, res) => {
  try {
    const adminKey = process.env.ADMIN_KEY;
    if (adminKey && req.headers['x-admin-key'] !== adminKey) {
      return res.status(403).send('Forbidden');
    }
    const { priceId, stock } = req.body || {};
    if (!priceId || typeof stock !== 'number' || stock < 0) {
      return res.status(400).send('Provide priceId and non-negative numeric stock');
    }
    await upsertInventory(priceId, stock);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to set inventory');
  }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { line_items } = req.body;
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).send('No line items provided');
    }

    const mappedItems = line_items.map(item => {
      const stripePrice = item.price; // Use real Stripe Price ID from client
      const qty = Math.min(1, Math.max(0, Number(item.quantity) || 0));
      if (qty <= 0) {
        throw new Error('Invalid quantity');
      }
      return { price: stripePrice, quantity: qty };
    });

    // Reserve stock atomically before creating the session
    const reservationId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + '-' + Date.now();
    try {
      await reserveStock(reservationId, mappedItems);
    } catch (e) {
      return res.status(400).send(e.message || 'Insufficient stock');
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: mappedItems,
      success_url: `${req.protocol}://${req.get('host')}/success.html`,
      cancel_url: `${req.protocol}://${req.get('host')}/cancel.html`,
      metadata: { reservation_id: reservationId }
    });

    // Link reservation rows to this session
    await linkReservationToSession(session.id, reservationId);

    return res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    // Attempt to release reservation if we created one earlier in this request
    // Note: We keep reservationId in closure above; if session creation failed, release it
    try { if (reservationId) await releaseReservation(reservationId); } catch (_) {}
    return res.status(400).send(err.message);
  }
});

// Webhook to commit or release reservations based on Checkout status
// Stripe webhook with signature verification
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    if (endpointSecret) {
      const signature = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(req.body, signature, endpointSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const sessionId = session.id;
        const reservationId = session.metadata && session.metadata.reservation_id;
        if (reservationId) {
          await linkReservationToSession(sessionId, reservationId);
        }
        await commitReservationBySession(sessionId);
        break;
      }
      case 'checkout.session.expired': {
        const session = event.data.object;
        const sessionId = session.id;
        const reservationId = await findReservedReservationIdBySession(sessionId);
        if (reservationId) await releaseReservation(reservationId);
        break;
      }
      case 'checkout.session.async_payment_failed': {
        const session = event.data.object;
        const sessionId = session.id;
        const reservationId = await findReservedReservationIdBySession(sessionId);
        if (reservationId) await releaseReservation(reservationId);
        break;
      }
      default:
        // ignore
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(400).send(`Webhook error: ${err.message}`);
  }
});

const port = process.env.PORT || 4242;
initSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server running at http://localhost:${port}`);
      console.log('Publishable key (for reference):', STRIPE_PUBLISHABLE_KEY);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema', err);
    process.exit(1);
  });


