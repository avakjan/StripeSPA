const Stripe = require('stripe');
const crypto = require('crypto');
const { ensureInit, reserveStock, linkReservationToSession, rateLimit } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    await ensureInit();
    // Simple per-IP rate limit: 10 requests per 60s
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const rl = await rateLimit({ key: `create-session:${ip}`, capacity: 10, refillTokens: 10, refillIntervalMs: 60_000 });
    if (!rl.allowed) {
      return res.status(429).send('Too Many Requests');
    }
    const { line_items } = req.body;
    if (!Array.isArray(line_items) || line_items.length === 0) {
      return res.status(400).send('No line items provided');
    }
    const mappedItems = line_items.map(item => {
      const stripePrice = item.price;
      const qty = Math.min(1, Math.max(0, Number(item.quantity) || 0));
      if (qty <= 0) throw new Error('Invalid quantity');
      return { price: stripePrice, quantity: qty };
    });

    const reservationId = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)) + '-' + Date.now();
    await reserveStock(reservationId, mappedItems);

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const successBase = process.env.PUBLIC_APP_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: mappedItems,
      success_url: `${successBase}/success.html`,
      cancel_url: `${successBase}/cancel.html`,
      metadata: { reservation_id: reservationId }
    });

    await linkReservationToSession(session.id, reservationId);
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(400).send(err.message);
  }
};


