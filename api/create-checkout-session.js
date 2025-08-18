// /api/create-checkout-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  const FRONT_URL = process.env.FRONT_URL || 'https://aleopplatform.webflow.io';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  try {
    const { lineItems, coupon, selectedPrograms, email, memberId } = req.body;
    if (!Array.isArray(lineItems) || !email || !memberId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Customer Stripe
    let customer;
    const search = await stripe.customers.search({ query: `email:"${email}"` });
    if (search.data.length) {
      customer = search.data[0];
      if (customer.email !== email) customer = await stripe.customers.update(customer.id, { email });
    } else {
      customer = await stripe.customers.create({ email });
    }

    // Checkout Session (subscription)
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: lineItems,
      discounts: coupon ? [{ coupon }] : [],
      success_url: `${FRONT_URL}/app/success`,          // ✅ générique
      cancel_url:  `${FRONT_URL}/panier?status=canceled`, // ✅ retour panier
      client_reference_id: memberId,
      customer: customer.id,
      metadata: {
        selected_programs: selectedPrograms.join(','),
        memberstack_id: memberId
      },
      subscription_data: {
        metadata: {
          selected_programs: selectedPrograms.join(','),
          memberstack_id: memberId
        }
      }
    });

    return res.status(200).json({ id: session.id });
  } catch (error) {
    console.error('Erreur création session:', error);
    return res.status(500).json({ error: error.message });
  }
};
