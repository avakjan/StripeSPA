const { ensureInit, getStocksMap, rateLimit } = require('../lib/db');
const Stripe = require('stripe');

module.exports = async (req, res) => {
  try {
    await ensureInit();
    // 60 req/min per IP
    const ip = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const rl = await rateLimit({ key: `products:${ip}`, capacity: 60, refillTokens: 60, refillIntervalMs: 60_000 });
    if (!rl.allowed) return res.status(429).send('Too Many Requests');
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
    res.status(200).json({ products: items });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to load products');
  }
};


