const { ensureInit, upsertInventory } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  try {
    await ensureInit();
    const adminKey = process.env.ADMIN_KEY;
    if (adminKey && req.headers['x-admin-key'] !== adminKey) {
      return res.status(403).send('Forbidden');
    }
    const { priceId, stock } = req.body || {};
    if (!priceId || typeof stock !== 'number' || stock < 0) {
      return res.status(400).send('Provide priceId and non-negative numeric stock');
    }
    await upsertInventory(priceId, stock);
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).send('Failed to set inventory');
  }
};


