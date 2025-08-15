const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method === 'POST') {
    const { lineItems, coupon, selectedPrograms } = req.body;
    try {
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: lineItems,
        discounts: coupon ? [{ coupon }] : [],
        success_url: 'https://aleopplatform.webflow.io/success?session_id={CHECKOUT_SESSION_ID}', // Adapte à ta page success
        cancel_url: 'https://aleopplatform.webflow.io/cancel',
        metadata: { selected_programs: selectedPrograms.join(',') } // Pour webhook update Memberstack
      });
      res.status(200).json({ id: session.id });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).end('Method Not Allowed');
  }
};
