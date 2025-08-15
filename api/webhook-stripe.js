const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const selectedPrograms = session.metadata.selected_programs.split(',');
    const customerEmail = session.customer_details.email;
    // Récupère memberId from Memberstack via email
    const memberId = await getMemberIdByEmail(customerEmail);
    if (memberId) {
      await updateMemberFields(memberId, selectedPrograms);
    }
  }

  res.send();
};

async function getMemberIdByEmail(email) {
  const res = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY }
  });
  const data = await res.json();
  return data.data[0]?.id; // Assume premier match, adapte si multiple
}

async function updateMemberFields(memberId, programs) {
  const updates = {};
  programs.forEach(prog => {
    updates[`programme_${prog}`] = true;
  });
  await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
}
