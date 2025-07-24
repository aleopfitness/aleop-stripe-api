const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  const { lineItems, memberId } = req.body;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems.map(item => ({
        ...item,
        price_data: {
          ...item.price_data,
          recurring: { interval: 'month' } // Mensuel, change en 'year' si annuel
        }
      })),
      mode: 'subscription', // Mode abonnement récurrent
      billing_address_collection: 'auto', // Collecte l'adresse pour factures
      success_url: `https://aleopplatform.webflow.io/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://aleopplatform.webflow.io/cancel`,
      metadata: { memberId, licences: JSON.stringify(lineItems.map(item => item.description)) },
    });
    res.status(200).json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
