// /api/stripe-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

// ⚠️ Plan FREE à ajouter/retirer
const GENERAL_PLAN_ID = 'pln_general-access-7wge0qe1';

module.exports = async (req, res) => {
  // Lire le RAW body pour vérifier la signature Stripe
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { body += chunk; });
  await new Promise((resolve) => req.on('end', resolve));

  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook Error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Helpers
  const parsePrograms = (meta) =>
    meta?.selected_programs ? meta.selected_programs.split(',').map(s => s.trim()).filter(Boolean) : [];

  const addMemberPlan = async (memberId, planId) => {
    const r = await fetch(`https://admin.memberstack.com/members/${memberId}/add-plan`, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId })
    });
    if (!r.ok) throw new Error(`add plan ${r.status}: ${await r.text()}`);
  };

  const removeMemberPlan = async (memberId, planId) => {
    const r = await fetch(`https://admin.memberstack.com/members/${memberId}/remove-plan`, {
      method: 'POST',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId })
    });
    if (!r.ok) throw new Error(`remove plan ${r.status}: ${await r.text()}`);
  };

  const updateMemberFields = async (memberId, updates) => {
    const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields: updates })
    });
    if (!r.ok) throw new Error(`update fields ${r.status}: ${await r.text()}`);
  };

  const resetAllPrograms = async (memberId) => {
    // Tes clés sont avec des tirets (logs MB)
    return updateMemberFields(memberId, {
      'athletyx': "0",
      'booty-shape': "0",
      'upper-shape': "0",
      'power-flow': "0"
    });
  };

  const setStripeCustomerIdCF = async (memberId, stripeCustomerId) => {
    if (!stripeCustomerId) return;
    // On stocke l’ID Stripe en custom field car le champ officiel n’est pas éditable via API
    await updateMemberFields(memberId, { 'stripe_customer_id': String(stripeCustomerId) });
  };

  // Variables extraites par event
  let selectedPrograms = [];
  let memberId = null;
  let stripeCustomerId = null;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        selectedPrograms = parsePrograms(session.metadata);
        memberId = session.metadata?.memberstack_id || null;
        stripeCustomerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        selectedPrograms = parsePrograms(sub.metadata);
        memberId = sub.metadata?.memberstack_id || null;
        stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
        break;
      }
      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.subscription) {
          const sub = await stripe.subscriptions.retrieve(invoice.subscription);
          selectedPrograms = parsePrograms(sub.metadata);
          memberId = sub.metadata?.memberstack_id || null;
          stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        memberId = sub.metadata?.memberstack_id || null;
        stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
        // Pas de programmes -> on resetera plus bas
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        // Essayer de récupérer memberId via subscription metadata si possible
        if (inv.subscription) {
          const sub = await stripe.subscriptions.retrieve(inv.subscription);
          memberId = sub.metadata?.memberstack_id || null;
          stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
        }
        break;
      }
      default:
        // on ignore le reste
        return res.send();
    }

    if (!memberId) {
      console.log(`No memberId in metadata for ${event.type} - skipped to avoid wrong updates`);
      return res.send();
    }

    // Écrire le Stripe Customer ID dans un custom field (si dispo)
    if (stripeCustomerId) {
      await setStripeCustomerIdCF(memberId, stripeCustomerId);
    }

    // Gestion des plans & droits
    if (event.type === 'customer.subscription.deleted' || event.type === 'invoice.payment_failed') {
      // Retirer le plan + tout remettre à 0
      await removeMemberPlan(memberId, GENERAL_PLAN_ID);
      await resetAllPrograms(memberId);
      console.log(`Plan removed & fields reset for ${memberId}`);
    } else {
      // Activer le plan & cocher les programmes sélectionnés
      if (selectedPrograms.length > 0) {
        // Marquer "1" sur chaque programme payé
        const updates = {};
        selectedPrograms.forEach(p => { updates[p] = "1"; });
        await addMemberPlan(memberId, GENERAL_PLAN_ID);
        await updateMemberFields(memberId, updates);
        console.log(`Plan added & fields updated for ${memberId} with programs [${selectedPrograms.join(', ')}]`);
      } else {
        console.log(`Programs empty on ${event.type} — no fields update`);
      }
    }

    return res.send();
  } catch (err) {
    console.error(`Webhook processing error for ${memberId || 'unknown'}:`, err.message);
    return res.status(500).send('Webhook handler error');
  }
};
