// /api/stripe-webhook.js
const fetch = require('node-fetch');
const Stripe = require('stripe');
const { kvGet, kvSetEx } = require('./kv.js');

/* ---------- CONFIG PROGRAMS / CHAMPS MS ---------- */
/** IMPORTANT : ici on suppose que les IDs des custom fields MS sont exactement ces slugs.
 *  Si tes champs MS ont d'autres IDs techniques, remplace les clés ci-dessous. */
const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* ---------- HELPERS STRIPE ---------- */
function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key);
}

// Vérifie la signature contre les 2 secrets (TEST puis LIVE). Détermine l'env sans ambiguïté.
function verifyWithDualSecrets(rawBody, sig) {
  const s = stripeClient();
  const testSecret = process.env.STRIPE_WEBHOOK_SECRET_TEST;
  const liveSecret = process.env.STRIPE_WEBHOOK_SECRET_LIVE;

  if (!testSecret && !liveSecret) {
    // fallback: secret unique (pas conseillé)
    const only = process.env.STRIPE_WEBHOOK_SECRET;
    if (!only) throw new Error('No Stripe webhook secret configured');
    return { event: s.webhooks.constructEvent(rawBody, sig, only), env: process.env.WEBHOOK_ENV || 'test' };
  }

  if (testSecret) {
    try { return { event: s.webhooks.constructEvent(rawBody, sig, testSecret), env: 'test' }; } catch(_) {}
  }
  if (liveSecret) {
    try { return { event: s.webhooks.constructEvent(rawBody, sig, liveSecret), env: 'live' }; } catch(_) {}
  }
  throw new Error('Invalid signature for both TEST and LIVE secrets');
}

/* ---------- HELPERS MEMBERSTACK ADMIN ---------- */
function msApiKey(env) {
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY; // fallback
}

async function msFindMemberIdByEmail(env, email) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const r = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
    headers: { 'X-API-KEY': key }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`MS query ${r.status}: ${t}`);
  }
  const data = await r.json();
  return data?.data?.[0]?.id || null;
}

async function msPatchMember(env, memberId, customFields) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields })
  });
  if (!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

/* ---------- UTILS ---------- */
async function retry(fn, tries = 3, baseDelayMs = 300) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
  }
  throw lastErr;
}

function buildFlagsFromPrograms(programs) {
  const set = new Set((programs || []).map(s => String(s || '').toLowerCase()));
  const updates = {};
  FIELD_IDS.forEach(id => { updates[id] = set.has(id) ? "1" : "0"; });
  return updates;
}

function allZeroFlags() {
  const updates = {};
  FIELD_IDS.forEach(id => updates[id] = "0");
  return updates;
}

/* ---------- HANDLER ---------- */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  // Lire raw body (obligatoire pour signature)
  let body = ''; req.setEncoding('utf8'); req.on('data', c => body += c); await new Promise(r => req.on('end', r));
  const sig = req.headers['stripe-signature'];

  // 1) Vérif signature & ENV
  let event, env;
  try {
    ({ event, env } = verifyWithDualSecrets(body, sig));
  } catch (e) {
    console.error('Stripe signature error:', e.message);
    return res.status(400).send('Invalid signature');
  }

  const type = event.type;
  console.log('Stripe webhook hit:', { type, env });

  // On gère : paiement initial + renouvellements + changements + annulation
  const HANDLE = new Set([
    'checkout.session.completed',
    'invoice.paid',
    'customer.subscription.updated',
    'customer.subscription.deleted'
  ]);
  if (!HANDLE.has(type)) return res.status(200).send();

  try {
    const obj = event.data.object;
    const stripeCustomerId = obj.customer || obj.customer_id || null;
    const emailKey = (obj.customer_details?.email || obj.customer_email || '').trim().toLowerCase() || null;

    // Idempotence simple
    const evtKey = `processed:${env}:${event.id}`;
    const already = await kvGet(evtKey);
    if (already) return res.status(200).send(); // déjà traité

    // Chemin A — événements “positifs” (completed/paid) → appliquer INTENT (source front)
    if (type === 'checkout.session.completed' || type === 'invoice.paid') {
      // 1) Retrouver le pointeur d'intent par email (principe), avec retry
      let ptr = null;
      if (emailKey) {
        ptr = await retry(() => kvGet(`latest-intent-email:${env}:${emailKey}`), 3, 300).catch(() => null);
      }
      // Fallback par memberId si possible
      let memberId = null;
      if (!ptr && emailKey) {
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(() => null);
        if (memberId) {
          ptr = await kvGet(`latest-intent:${env}:${memberId}`);
        }
      }

      if (!ptr?.intentId) {
        console.log(`No intent pointer found for env=${env}, email=${emailKey} → skip (no-op)`);
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }

      // 2) Charger l'intent complet (retry & anti latency)
      const intentKey = `intent:${ptr.intentId}`;
      let intent = null;
      for (let i = 0; i < 3; i++) {
        intent = await kvGet(intentKey);
        if (intent) break;
        await new Promise(r => setTimeout(r, 300 * (i + 1)));
      }
      if (!intent || intent.status === 'applied') {
        console.log(`Intent unusable for ${intentKey} → skip`);
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }

      // 3) Résoudre le memberId
      memberId = memberId || intent.memberId || (emailKey ? await msFindMemberIdByEmail(env, emailKey).catch(() => null) : null);
      if (!memberId) {
        console.log('MemberId not resolved → skip');
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }

      // 4) Construire flags 1/0 depuis l’intent
      const updates = buildFlagsFromPrograms(intent.programs);

      // 5) PATCH MS
      await msPatchMember(env, memberId, updates);

      // 6) Marquer intent appliqué + idempotence + mapping customer→member
      await kvSetEx(intentKey, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60);
      await kvSetEx(evtKey, 1, 7*24*60*60);
      if (stripeCustomerId) await kvSetEx(`map:scus:${env}:${stripeCustomerId}`, { memberId }, 30*24*60*60);

      console.log(`Stripe applied (${env}) member=${memberId} updates=${JSON.stringify(updates)}`);
      return res.status(200).send();
    }

    // Chemin B — updated/deleted : resync minimal
    if (type === 'customer.subscription.deleted') {
      // On force tout à 0 (accès révoqué)
      let memberId = null;
      // Essaye mapping customer→member appris
      if (stripeCustomerId) {
        const m = await kvGet(`map:scus:${env}:${stripeCustomerId}`);
        memberId = m?.memberId || null;
      }
      // Fallback email
      if (!memberId && emailKey) {
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(() => null);
      }
      if (!memberId) {
        console.log('Deleted: member introuvable → skip (no-op)');
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }
      const updates = allZeroFlags();
      await msPatchMember(env, memberId, updates);
      await kvSetEx(evtKey, 1, 7*24*60*60);
      console.log(`Subscription deleted → all flags 0 for member=${memberId}`);
      return res.status(200).send();
    }

    if (type === 'customer.subscription.updated') {
      // Cas simple : on ré-applique le dernier intent connu (si trouvé), sinon no-op
      let memberId = null;
      if (stripeCustomerId) {
        const m = await kvGet(`map:scus:${env}:${stripeCustomerId}`);
        memberId = m?.memberId || null;
      }
      if (!memberId && emailKey) {
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(() => null);
      }
      if (!memberId) {
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }
      // Reprendre le dernier intent par member
      const ptr = await kvGet(`latest-intent:${env}:${memberId}`);
      if (!ptr?.intentId) {
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }
      const intent = await kvGet(`intent:${ptr.intentId}`);
      if (!intent) {
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }
      const updates = buildFlagsFromPrograms(intent.programs);
      await msPatchMember(env, memberId, updates);
      await kvSetEx(evtKey, 1, 7*24*60*60);
      console.log(`Subscription updated → re-applied last intent for member=${memberId}`);
      return res.status(200).send();
    }

    // Fallback
    await kvSetEx(evtKey, 1, 7*24*60*60);
    return res.status(200).send();

  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(500).send('Handler error');
  }
};
