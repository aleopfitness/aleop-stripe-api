// /api/create-checkout-session.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // durci si besoin
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  try {
    const { lineItems, coupon, selectedPrograms, email, memberId } = req.body;

    if (!Array.isArray(lineItems) || !email || !memberId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // 1) Récupérer ou créer le customer Stripe
    let customer;
    const search = await stripe.customers.search({ query: `email:"${email}"` });
    if (search.data.length > 0) {
      customer = search.data[0];
      if (customer.email !== email) {
        customer = await stripe.customers.update(customer.id, { email });
      }
    } else {
      customer = await stripe.customers.create({ email });
    }

    // 2) Créer la session Checkout (subscription)
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: lineItems,
      discounts: coupon ? [{ coupon }] : [],
      success_url: 'https://aleopplatform.webflow.io/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://aleopplatform.webflow.io/cancel',
      client_reference_id: memberId, // pratique en debug
      customer: customer.id,
      // Metadatas pour session & abonnement (pour webhook)
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
