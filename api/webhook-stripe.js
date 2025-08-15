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

    // Other cases as before, add memberIdFromMetadata = sub.metadata.memberstack_id if needed for updated/paid (but for simplicity, use email fallback)
    // ...

    default:
      console.log('Ignored event: ' + event.type);
      res.send();
      return;
  }

  let memberId = memberIdFromMetadata; // Prefer metadata ID
  if (!memberId) {
    memberId = await getMemberIdByEmail(customerEmail); // Fallback to email
  }
  console.log('Member ID used: ' + memberId);
  if (memberId) {
    if (isDelete || isFailure) {
      await removeMemberPlan(memberId, GENERAL_PLAN_ID);
      await resetMemberFields(memberId);
      console.log('Plan removed and fields reset for member ' + memberId);
    } else if (selectedPrograms.length > 0) {
      await addMemberPlan(memberId, GENERAL_PLAN_ID);
      await updateMemberFields(memberId, selectedPrograms);
      console.log('Plan added and fields updated for member ' + memberId + ' with programs ' + selectedPrograms);
    }
  } else {
    console.log('No member found for email ' + customerEmail + ' or metadata ID');
  }

  res.send();
};

 // getMemberIdByEmail, addMemberPlan, removeMemberPlan, updateMemberFields, resetMemberFields as before
