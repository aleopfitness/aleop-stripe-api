const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');
const GENERAL_PLAN_ID = 'pln_aleop-team-plan-ir1n30ize';
module.exports = async (req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    body += chunk;
  });
  await new Promise((resolve) => req.on('end', resolve));
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook Error:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }
  let selectedPrograms = [];
  let customerEmail;
  let memberIdFromMetadata;
  let isDelete = false;
  let isFailure = false;
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      selectedPrograms = session.metadata.selected_programs ? session.metadata.selected_programs.split(',') : [];
      customerEmail = session.customer_details.email;
      memberIdFromMetadata = session.metadata.memberstack_id;
      console.log('Completed: Programs', selectedPrograms, 'Email', customerEmail, 'Member ID from metadata', memberIdFromMetadata);
      break;
    case 'customer.subscription.updated':
      const sub = event.data.object;
      selectedPrograms = sub.items.data.map(item => item.plan.metadata.type_programme || (item.plan.nickname ? item.plan.nickname.toLowerCase() : null)).filter(prog => prog !== null);
      customerEmail = (await stripe.customers.retrieve(sub.customer)).email;
      memberIdFromMetadata = sub.metadata.memberstack_id;
      console.log('Updated: Programs', selectedPrograms, 'Email', customerEmail, 'Member ID from metadata', memberIdFromMetadata);
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
        selectedPrograms = sub.items.data.map(item => item.plan.metadata.type_programme || (item.plan.nickname ? item.plan.nickname.toLowerCase() : null)).filter(prog => prog !== null);
        customerEmail = (await stripe.customers.retrieve(sub.customer)).email;
        memberIdFromMetadata = sub.metadata.memberstack_id;
        console.log('Paid: Programs', selectedPrograms, 'Email', customerEmail, 'Member ID from metadata', memberIdFromMetadata);
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
  let memberId = memberIdFromMetadata; // Priorise ID from metadata
  if (!memberId) {
    memberId = await getMemberIdByEmail(customerEmail); // Fallback email if no ID
  }
  console.log('Member ID used: ' + memberId);
  if (memberId) {
    const programToField = {
      'athletyx': 'athletyx',
      'booty': 'booty_shape',
      'upper': 'upper_shape',
      'flow': 'power_flow'
    };
    if (isDelete || isFailure) {
      await removeMemberPlan(memberId, GENERAL_PLAN_ID);
      await resetMemberFields(memberId);
      console.log('Plan removed and fields reset for member ' + memberId);
    } else if (selectedPrograms.length > 0) {
      await addMemberPlan(memberId, GENERAL_PLAN_ID);
      await updateMemberFields(memberId, selectedPrograms, programToField); // Mapping ajouté
      console.log('Plan added and fields updated for member ' + memberId + ' with programs ' + selectedPrograms);
    }
  } else {
    console.log('No member found for email ' + customerEmail + ' or metadata ID');
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
async function addMemberPlan(memberId, planId) {
  await fetch(`https://admin.memberstack.com/members/${memberId}/plans`, {
    method: 'POST',
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId })
  });
}
async function removeMemberPlan(memberId, planId) {
  await fetch(`https://admin.memberstack.com/members/${memberId}/plans/${planId}`, {
    method: 'DELETE',
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY }
  });
}
async function updateMemberFields(memberId, programs, programToField) {
  const updates = {};
  programs.forEach(prog => {
    updates[programToField[prog]] = "1"; // Utilise mapping pour noms exacts
  });
  await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
}
async function resetMemberFields(memberId) {
  const updates = {
    'athletyx': "0",
    'booty_shape': "0",
    'upper_shape': "0",
    'power_flow': "0"
  };
  await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
}
