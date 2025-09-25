const Stripe = require('stripe');
const getRawBody = require('raw-body');
const { commitReservationBySession, releaseReservation, linkReservationToSession, findReservedReservationIdBySession } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || '';
  let event;
  try {
    const body = await getRawBody(req);
    if (endpointSecret) {
      const signature = req.headers['stripe-signature'];
      event = stripe.webhooks.constructEvent(body, signature, endpointSecret);
    } else {
      event = JSON.parse(body.toString());
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
        break;
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(400).send(`Webhook error: ${err.message}`);
  }
};


