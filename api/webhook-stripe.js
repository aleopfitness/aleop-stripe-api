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

  let selectedPrograms = [];
  let customerEmail;
  let isDelete = false;
  let isFailure = false;

  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      selectedPrograms = session.metadata.selected_programs ? session.metadata.selected_programs.split(',') : [];
      customerEmail = session.customer_details.email;
      break;

    case 'customer.subscription.updated':
      const sub = event.data.object;
      // Fetch add-ons from sub items to sync fields (e.g., if user upgraded)
      selectedPrograms = sub.items.data.map(item => {
        // Extract from metadata or product name (adapte à tes metadata product "type_programme")
        return item.plan.metadata.type_programme || item.plan.nickname.toLowerCase(); // Assume nickname like "athletyx"
      });
      customerEmail = (await stripe.customers.retrieve(sub.customer)).email;
      break;

    case 'customer.subscription.deleted':
      const subDeleted = event.data.object;
      isDelete = true;
      customerEmail = (await stripe.customers.retrieve(subDeleted.customer)).email;
      break;

    case 'invoice.paid':
      const invoice = event.data.object;
      // Re-sync if needed for renewals (e.g., prorate changes)
      const subId = invoice.subscription;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        selectedPrograms = sub.items.data.map(item => item.plan.metadata.type_programme || item.plan.nickname.toLowerCase());
        customerEmail = (await stripe.customers.retrieve(sub.customer)).email;
      }
      break;

    case 'invoice.payment_failed':
      const invoiceFailed = event.data.object;
      isFailure = true;
      customerEmail = (await stripe.customers.retrieve(invoiceFailed.customer)).email;
      // Optionnel: Send email notification via autre tool, ou suspend fields
      break;

    default:
      // Ignore other events
      res.send();
      return;
  }

  const memberId = await getMemberIdByEmail(customerEmail);
  if (memberId) {
    if (isDelete || isFailure) {
      await resetMemberFields(memberId); // Set all programme_* to false on delete or failure
    } else if (selectedPrograms.length > 0) {
      await updateMemberFields(memberId, selectedPrograms); // Update to true for selected
    }
  }

  res.send();
};

async function getMemberIdByEmail(email) {
  const res = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY }
  });
  const data = await res.json();
  return data.data[0]?.id;
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

async function resetMemberFields(memberId) {
  const updates = {
    'programme_athletyx': false,
    'programme_booty': false,
    'programme_upper': false,
    'programme_flow': false
    // Ajoute tous tes programs ici pour set false on delete/failure
  };
  await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
}
