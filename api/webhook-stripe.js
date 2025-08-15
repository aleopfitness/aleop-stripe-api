const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

module.exports = async (req, res) => {
  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    body += chunk;
  }
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook Error:', err.message); // Log for debug in Vercel
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
      console.log('Completed: Programs', selectedPrograms, 'Email', customerEmail); // Log for debug
      break;

    // Other cases as before (updated, deleted, paid, failed) with console.log('Event type: ' + event.type);
    case 'customer.subscription.updated':
      const sub = event.data.object;
      selectedPrograms = sub.items.data.map(item => item.plan.metadata.type_programme || item.plan.nickname.toLowerCase());
      customerEmail = (await stripe.customers.retrieve(sub.customer)).email;
      console.log('Updated: Programs', selectedPrograms, 'Email', customerEmail);
      break;

    case 'customer.subscription.deleted':
      isDelete = true;
      customerEmail = (await stripe.customers.retrieve(event.data.object.customer)).email;
      console.log('Deleted: Email', customerEmail);
      break;

    case 'invoice.paid':
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        selectedPrograms = sub.items.data.map(item => item.plan.metadata.type_programme || item.plan.nickname.toLowerCase());
        customerEmail = (await stripe.customers.retrieve(sub.customer)).email;
        console.log('Paid: Programs', selectedPrograms, 'Email', customerEmail);
      }
      break;

    case 'invoice.payment_failed':
      isFailure = true;
      customerEmail = (await stripe.customers.retrieve(event.data.object.customer)).email;
      console.log('Failed: Email', customerEmail);
      break;

    default:
      console.log('Ignored event: ' + event.type);
      res.send();
      return;
  }

  const memberId = await getMemberIdByEmail(customerEmail);
  console.log('Member ID found: ' + memberId);
  if (memberId) {
    if (isDelete || isFailure) {
      await resetMemberFields(memberId);
      console.log('Fields reset for member ' + memberId);
    } else if (selectedPrograms.length > 0) {
      await updateMemberFields(memberId, selectedPrograms);
      console.log('Fields updated for member ' + memberId + ' with programs ' + selectedPrograms);
    }
  } else {
    console.log('No member found for email ' + customerEmail);
  }

  res.send();
};

// getMemberIdByEmail, updateMemberFields, resetMemberFields as before (add console.log if needed)
