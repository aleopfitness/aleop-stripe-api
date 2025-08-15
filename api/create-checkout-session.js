const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  if (req.method === 'POST') {
    const { lineItems, coupon, selectedPrograms, email } = req.body;
    console.log('Email from front: ' + email);
    try {
      let customer;
      const customers = await stripe.customers.search({ query: `email:"${email}"` });
      let sessionParams = {
        mode: 'subscription',
        payment_method_types: ['card'],
        line_items: lineItems,
        discounts: coupon ? [{ coupon }] : [],
        success_url: 'https://aleopplatform.webflow.io/success?session_id={CHECKOUT_SESSION_ID}',
        cancel_url: 'https://aleopplatform.webflow.io/cancel',
        metadata: { selected_programs: selectedPrograms.join(',') }
      };

      if (customers.data.length > 0) {
        customer = customers.data[0];
        if (customer.email !== email) {
          await stripe.customers.update(customer.id, { email });
          console.log('Updated customer email to ' + email);
        }
        sessionParams.customer = customer.id; // Use customer, no customer_email
      } else {
        sessionParams.customer_email = email; // For new, use customer_email
      }

      const session = await stripe.checkout.sessions.create(sessionParams);
      res.status(200).json({ id: session.id });
    } catch (error) {
      console.log('Error: ' + error.message);
      res.status(500).json({ error: error.message });
    }
  } else {
    res.status(405).end('Method Not Allowed');
  }
};
