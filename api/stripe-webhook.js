// /api/stripe-webhook.js
const fetch = require('node-fetch');
const Stripe = require('stripe');
const { kvGet, kvSetEx } = require('./kv.js');

/** IDs EXACTS de tes 9 custom fields Memberstack
 *  ⚠️ Si les IDs techniques MS sont différents des slugs,
 *  remplace ici les clés. */
const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* ---------- STRIPE ---------- */
function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key);
}

// Un seul secret possible: STRIPE_WEBHOOK_SECRET
function verifyWithSingleSecret(rawBody, sig) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  const s = stripeClient();
  const event = s.webhooks.constructEvent(rawBody, sig, secret);
  // env déduit simplement par livemode
  const env = event.livemode ? 'live' : 'test';
  return { event, env };
}

/* ---------- MEMBERSTACK ADMIN ---------- */
function msApiKey(env) {
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
async function msFindMemberIdByEmail(env, email) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const r = await fetch(`https://admin.memberstack.com/v2/members?email=${encodeURIComponent(email)}`, {
    headers: { 'Authorization': `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(`MS query ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.data?.[0]?.id || null;
}
async function msPatchMember(env, memberId, customFields) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const r = await fetch(`https://admin.memberstack.com/v2/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields })
  });
  if (!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

/* ---------- UTILS ---------- */
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
async function retry(fn, tries = 3, delayMs = 300) {
  let last;
  for (let i=0;i<tries;i++) {
    try { return await fn(); } catch(e){ last = e; }
    await new Promise(r=>setTimeout(r, delayMs*(i+1)));
  }
  throw last;
}

/* ---------- HANDLER ---------- */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  // raw body pour signature
  let body = ''; req.setEncoding('utf8'); req.on('data', c => body += c); await new Promise(r => req.on('end', r));
  const sig = req.headers['stripe-signature'];

  let event, env;
  try {
    ({ event, env } = verifyWithSingleSecret(body, sig));
  } catch (e) {
    console.error('Stripe signature error:', e.message);
    return res.status(400).send('Invalid signature');
  }

  const type = event.type;
  console.log('Stripe webhook hit:', { type, env, livemode: event.livemode });

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

    // Anti-doublon
    const evtKey = `processed:${env}:${event.id}`;
    if (await kvGet(evtKey)) return res.status(200).send();

    // === CHEMIN A : completed / paid => applique INTENT ===
    if (type === 'checkout.session.completed' || type === 'invoice.paid') {
      let memberId = null;

      // 1) pointer intent via email
      let ptr = null;
      if (emailKey) ptr = await retry(() => kvGet(`latest-intent-email:${env}:${emailKey}`), 3, 250).catch(() => null);
      if (!ptr && emailKey) {
        // fallback: pointer via memberId
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(() => null);
        if (memberId) ptr = await kvGet(`latest-intent:${env}:${memberId}`);
      }
      if (!ptr?.intentId) {
        console.log(`No intent pointer for env=${env}, email=${emailKey} → skip`);
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }

      // 2) charger intent
      const intentKey = `intent:${ptr.intentId}`;
      let intent = null;
      for (let i=0;i<3;i++){
        intent = await kvGet(intentKey);
        if (intent) break;
        await new Promise(r=>setTimeout(r, 250*(i+1)));
      }
      if (!intent || intent.status === 'applied') {
        console.log(`Intent unusable: ${intentKey}`);
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }

      // 3) resolve memberId
      memberId = memberId || intent.memberId || (emailKey ? await msFindMemberIdByEmail(env, emailKey).catch(()=>null) : null);
      if (!memberId) {
        console.log('MemberId not resolved → skip');
        await kvSetEx(evtKey, 1, 7*24*60*60);
        return res.status(200).send();
      }

      // 4) build & patch
      const updates = buildFlagsFromPrograms(intent.programs);
      await msPatchMember(env, memberId, updates);

      // 5) mark applied + map customer→member + idempotence
      await kvSetEx(intentKey, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60);
      await kvSetEx(evtKey, 1, 7*24*60*60);
      if (stripeCustomerId) await kvSetEx(`map:scus:${env}:${stripeCustomerId}`, { memberId }, 30*24*60*60);

      console.log(`Stripe applied (${env}) member=${memberId} updates=${JSON.stringify(updates)}`);
      return res.status(200).send();
    }

    // === CHEMIN B : deleted => tout à 0 ===
    if (type === 'customer.subscription.deleted') {
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
      await msPatchMember(env, memberId, allZeroFlags());
      await kvSetEx(evtKey, 1, 7*24*60*60);
      console.log(`Subscription deleted → flags reset to 0 (member=${memberId})`);
      return res.status(200).send();
    }

    // === CHEMIN C : updated => ré-applique dernier intent connu (simple & suffisant) ===
    if (type === 'customer.subscription.updated') {
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
      const ptr = await kvGet(`latest-intent:${env}:${memberId}`);
      if (!ptr?.intentId) { await kvSetEx(evtKey, 1, 7*24*60*60); return res.status(200).send(); }
      const intent = await kvGet(`intent:${ptr.intentId}`);
      if (!intent) { await kvSetEx(evtKey, 1, 7*24*60*60); return res.status(200).send(); }

      const updates = buildFlagsFromPrograms(intent.programs);
      await msPatchMember(env, memberId, updates);
      await kvSetEx(evtKey, 1, 7*24*60*60);
      console.log(`Subscription updated → re-applied last intent (member=${memberId})`);
      return res.status(200).send();
    }

    await kvSetEx(evtKey, 1, 7*24*60*60);
    return res.status(200).send();

  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(500).send('Handler error');
  }
};
