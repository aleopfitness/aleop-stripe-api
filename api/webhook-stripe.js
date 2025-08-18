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
  let stripeCustomerId;
  switch (event.type) {
    case 'checkout.session.completed':
      const session = event.data.object;
      selectedPrograms = session.metadata.selected_programs ? session.metadata.selected_programs.split(',') : [];
      customerEmail = session.customer_details.email;
      memberIdFromMetadata = session.metadata.memberstack_id;
      stripeCustomerId = session.customer; // ID customer Stripe
      console.log('Completed: Programs', selectedPrograms, 'Email', customerEmail, 'Member ID from metadata', memberIdFromMetadata, 'Stripe Customer ID', stripeCustomerId);
      break;
    case 'customer.subscription.updated':
      const sub = event.data.object;
      selectedPrograms = sub.items.data.map(item => item.plan.metadata.data_program || (item.plan.nickname ? item.plan.nickname.toLowerCase() : null)).filter(prog => prog !== null);
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
        selectedPrograms = sub.items.data.map(item => item.plan.metadata.data_program || (item.plan.nickname ? item.plan.nickname.toLowerCase() : null)).filter(prog => prog !== null);
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
  let memberId = memberIdFromMetadata;
  if (!memberId) {
    memberId = await getMemberIdByEmail(customerEmail);
    console.log('Fallback email utilisé pour ' + customerEmail + ', ID trouvé : ' + memberId);
  }
  console.log('Member ID used: ' + memberId);
  if (memberId) {
    try {
      if (isDelete || isFailure) {
        await removeMemberPlan(memberId, GENERAL_PLAN_ID);
        await resetMemberFields(memberId);
        console.log('Plan removed and fields reset for member ' + memberId);
      } else if (selectedPrograms.length > 0) {
        await addMemberPlan(memberId, GENERAL_PLAN_ID);
        await updateMemberFields(memberId, selectedPrograms);
        console.log('Plan added and fields updated for member ' + memberId + ' with programs ' + selectedPrograms);
      } else {
        console.log('Skipped update for ' + event.type + ' as programs empty');
      }
      // Update stripeCustomerId toujours si présent et event completed
      if (event.type === 'checkout.session.completed' && stripeCustomerId) {
        await updateStripeCustomerId(memberId, stripeCustomerId);
        console.log('Stripe Customer ID updated for member ' + memberId + ' to ' + stripeCustomerId);
      }
    } catch (err) {
      console.error('Erreur lors de l\'update Memberstack pour member ' + memberId + ' : ', err.message);
    }
  } else {
    console.log('No member found for email ' + customerEmail + ' or metadata ID');
  }
  res.send();
};
async function getMemberIdByEmail(email) {
  try {
    const res = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY }
    });
    const data = await res.json();
    console.log('Recherche Member par email ' + email + ' : ' + data.data.length + ' résultats trouvés');
    if (data.data.length > 1) {
      console.warn('Warning: Multiple members for email ' + email + ', taking the last (newest) one');
    }
    return data.data[data.data.length - 1]?.id || null;
  } catch (err) {
    console.error('Erreur getMemberIdByEmail : ', err.message);
    return null;
  }
}
async function addMemberPlan(memberId, planId) {
  try {
    const response = await fetch(`https://admin.memberstack.com/members/${memberId}/plans`, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId })
    });
    if (!response.ok) {
      throw new Error(`Erreur add plan : ${response.status} - ${await response.text()}`);
    }
  } catch (err) {
    console.error('Erreur addMemberPlan : ', err.message);
  }
}
async function removeMemberPlan(memberId, planId) {
  try {
    const response = await fetch(`https://admin.memberstack.com/members/${memberId}/plans/${planId}`, {
      method: 'DELETE',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY }
    });
    if (!response.ok) {
      throw new Error(`Erreur remove plan : ${response.status} - ${await response.text()}`);
    }
  } catch (err) {
    console.error('Erreur removeMemberPlan : ', err.message);
  }
}
async function updateMemberFields(memberId, programs) {
  const updates = {};
  const programToField = {
    'athletyx': 'athletyx',
    'booty': 'booty_shape',
    'upper': 'upper_shape',
    'flow': 'power_flow'
  };
  programs.forEach(prog => {
    const field = programToField[prog] || prog;
    updates[field] = "1";
  });
  try {
    const response = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: updates })
    });
    if (!response.ok) {
      throw new Error(`Erreur update fields : ${response.status} - ${await response.text()}`);
    }
  } catch (err) {
    console.error('Erreur updateMemberFields : ', err.message);
  }
}
async function resetMemberFields(memberId) {
  const updates = {
    'athletyx': "0",
    'booty_shape': "0",
    'upper_shape': "0",
    'power_flow': "0"
  };
  try {
    const response = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: updates })
    });
    if (!response.ok) {
      throw new Error(`Erreur reset fields : ${response.status} - ${await response.text()}`);
    }
  } catch (err) {
    console.error('Erreur resetMemberFields : ', err.message);
  }
}
async function updateStripeCustomerId(memberId, stripeCustomerId) {
  try {
    const response = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ stripeCustomerId })
    });
    if (!response.ok) {
      throw new Error(`Erreur update stripeCustomerId : ${response.status} - ${await response.text()}`);
    }
  } catch (err) {
    console.error('Erreur updateStripeCustomerId : ', err.message);
  }
}
