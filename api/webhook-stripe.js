// /api/stripe-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

// ✅ Ton plan (FREE) Memberstack
const GENERAL_PLAN_ID = 'pln_general-access-7wge0qe1';

module.exports = async (req, res) => {
  // Lire le RAW body (important pour vérifier la signature Stripe)
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

  // -------- Helpers --------
  const parsePrograms = (meta) =>
    meta?.selected_programs ? meta.selected_programs.split(',').map(s => s.trim()).filter(Boolean) : [];

  const updatesFrom = (programs) => {
    const updates = {};
    programs.forEach(p => { updates[p] = "1"; }); // tes clés custom avec tirets (ex: 'upper-shape')
    return updates;
  };

  // Idempotence côté Memberstack
  async function addMemberPlan(memberId, planId) {
    const r = await fetch(`https://admin.memberstack.com/members/${memberId}/add-plan`, {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.MEMBERSTACK_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ planId })
    });
    if (r.ok) return;

    const txt = await r.text();
    try {
      const data = JSON.parse(txt);
      if (r.status === 400 && (data.code === 'already-have-plan' || /already have this plan/i.test(data.message))) {
        console.log(`Plan already present for ${memberId} — treated as success`);
        return; // ne pas throw
      }
    } catch (_) {}
    throw new Error(`add plan ${r.status}: ${txt}`);
  }

  async function removeMemberPlan(memberId, planId) {
    const r = await fetch(`https://admin.memberstack.com/members/${memberId}/remove-plan`, {
      method: 'POST',
      headers: {
        'X-API-KEY': process.env.MEMBERSTACK_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ planId })
    });
    if (r.ok) return;

    const txt = await r.text();
    try {
      const data = JSON.parse(txt);
      if (r.status === 400 && (data.code === 'plan-not-found' || /do not have this plan/i.test(data.message))) {
        console.log(`Plan already removed for ${memberId} — treated as success`);
        return; // ne pas throw
      }
    } catch (_) {}
    throw new Error(`remove plan ${r.status}: ${txt}`);
  }

  async function updateMemberFields(memberId, updates) {
    const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
      method: 'PATCH',
      headers: {
        'X-API-KEY': process.env.MEMBERSTACK_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ customFields: updates })
    });
    if (!r.ok) throw new Error(`update fields ${r.status}: ${await r.text()}`);
  }

  async function resetAllPrograms(memberId) {
    return updateMemberFields(memberId, {
      'athletyx': "0",
      'booty-shape': "0",
      'upper-shape': "0",
      'power-flow': "0"
    });
  }

  async function setStripeCustomerIdCF(memberId, stripeCustomerId) {
    if (!stripeCustomerId) return;
    // Le champ officiel Memberstack n'est pas éditable; on le stocke en custom field
    await updateMemberFields(memberId, { 'stripe_customer_id': String(stripeCustomerId) });
  }

  // -------- Routing des événements --------
  let selectedPrograms = [];
  let memberId = null;
  let stripeCustomerId = null;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        // ✅ Seul endroit où l'on AJOUTE le plan — si et seulement si le paiement est PAID
        const session = event.data.object;

        // Sécurité : on ne traite que les sessions d'abonnement
        if (session.mode !== 'subscription') break;

        // On ne procède que si le paiement est confirmé
        if (session.payment_status !== 'paid') {
          console.log(`Skip add-plan: payment_status=${session.payment_status}`);
          break;
        }

        selectedPrograms = parsePrograms(session.metadata);
        memberId = session.metadata?.memberstack_id || null;
        stripeCustomerId = typeof session.customer === 'string'
          ? session.customer
          : session.customer?.id || null;

        if (!memberId) {
          console.log('No memberId in session metadata — skipped');
          break;
        }

        // Ajouter le plan + maj des champs
        await addMemberPlan(memberId, GENERAL_PLAN_ID);
        if (selectedPrograms.length) {
          await updateMemberFields(memberId, updatesFrom(selectedPrograms));
        }
        await setStripeCustomerIdCF(memberId, stripeCustomerId);

        console.log(`Plan added & fields updated for ${memberId} [${selectedPrograms.join(', ')}]`);
        break;
      }

      case 'customer.subscription.updated': {
        // ❌ ne pas ajouter de plan ici (risque de doublons)
        const sub = event.data.object;
        selectedPrograms = parsePrograms(sub.metadata);
        memberId = sub.metadata?.memberstack_id || null;
        stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;

        if (!memberId) break;

        if (selectedPrograms.length) {
          await updateMemberFields(memberId, updatesFrom(selectedPrograms));
        }
        await setStripeCustomerIdCF(memberId, stripeCustomerId);
        console.log(`Fields updated for ${memberId} [${selectedPrograms.join(', ')}]`);
        break;
      }

      case 'invoice.paid': {
        // Paiement récurrent réussi → MAJ des champs seulement (pas d'add plan)
        const invoice = event.data.object;
        if (!invoice.subscription) break;

        const sub = await stripe.subscriptions.retrieve(invoice.subscription);
        selectedPrograms = parsePrograms(sub.metadata);
        memberId = sub.metadata?.memberstack_id || null;
        stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;

        if (!memberId) break;

        if (selectedPrograms.length) {
          await updateMemberFields(memberId, updatesFrom(selectedPrograms));
        }
        await setStripeCustomerIdCF(memberId, stripeCustomerId);
        console.log(`Fields updated (invoice.paid) for ${memberId} [${selectedPrograms.join(', ')}]`);
        break;
      }

      case 'invoice.payment_failed': {
        // Paiement échoué → retirer le plan + reset
        const inv = event.data.object;
        let sub = null;

        if (inv.subscription) {
          sub = await stripe.subscriptions.retrieve(inv.subscription);
          memberId = sub.metadata?.memberstack_id || null;
          stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;
        }

        if (!memberId) {
          // dernier recours : customer depuis invoice
          stripeCustomerId = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id || null;
          // pas de memberId fiable → on ne touche pas
          console.log('payment_failed without memberId — skipped remove-plan');
          break;
        }

        await removeMemberPlan(memberId, GENERAL_PLAN_ID);
        await resetAllPrograms(memberId);
        await setStripeCustomerIdCF(memberId, stripeCustomerId);
        console.log(`Plan removed & fields reset for ${memberId} (payment_failed)`);
        break;
      }

      case 'customer.subscription.deleted': {
        // Abonnement résilié → retirer le plan + reset
        const sub = event.data.object;
        memberId = sub.metadata?.memberstack_id || null;
        stripeCustomerId = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id || null;

        if (!memberId) {
          console.log('subscription.deleted without memberId — skipped');
          break;
        }

        await removeMemberPlan(memberId, GENERAL_PLAN_ID);
        await resetAllPrograms(memberId);
        await setStripeCustomerIdCF(memberId, stripeCustomerId);
        console.log(`Plan removed & fields reset for ${memberId} (subscription.deleted)`);
        break;
      }

      default:
        // on ignore le reste
        break;
    }

    return res.send(); // toujours 200 si on arrive ici
  } catch (err) {
    console.error(`Webhook processing error for ${memberId || 'unknown'}:`, err.message);
    return res.status(500).send('Webhook handler error');
  }
};
