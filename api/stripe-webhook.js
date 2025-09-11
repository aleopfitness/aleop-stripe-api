// /api/stripe-webhook.js
const fetch = require('node-fetch');
const Stripe = require('stripe');
const { kvGet, kvSetEx } = require('./kv.js');

// ⚠️ Remplace ces clés si les IDs techniques MS diffèrent des slugs
const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* ---------- STRIPE (single secret) ---------- */
function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key);
}
function verifyWithSingleSecret(rawBody, sig) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  const s = stripeClient();
  const event = s.webhooks.constructEvent(rawBody, sig, secret);
  const env = event.livemode ? 'live' : 'test';
  return { event, env };
}

/* ---------- MEMBERSTACK ADMIN (v2 -> fallback v1) ---------- */
function msApiKey(env) {
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}

async function msFindMemberIdByEmail(env, email) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing MS key for env=${env}`);
  // try v2
  try {
    const r2 = await fetch(`https://admin.memberstack.com/v2/members?email=${encodeURIComponent(email)}`, {
      headers: { 'Authorization': `Bearer ${key}` }
    });
    if (r2.ok) {
      const d = await r2.json();
      const id = d?.data?.[0]?.id;
      if (id) return id;
    } else {
      // continue to v1 fallback
    }
  } catch {}
  // fallback v1
  const r1 = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(email)}`, {
    headers: { 'X-API-KEY': key }
  });
  if (!r1.ok) throw new Error(`MS v1 query ${r1.status}: ${await r1.text()}`);
  const d1 = await r1.json();
  return d1?.data?.[0]?.id || null;
}

async function msPatchMember(env, memberId, customFields) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing MS key for env=${env}`);
  // try v2
  try {
    const r2 = await fetch(`https://admin.memberstack.com/v2/members/${memberId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ customFields })
    });
    if (r2.ok) return;
    // else fallthrough to v1
  } catch {}
  // fallback v1
  const r1 = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields })
  });
  if (!r1.ok) throw new Error(`MS v1 update ${r1.status}: ${await r1.text()}`);
}

/* ---------- UTILS ---------- */
function buildFlags(programs) {
  const set = new Set((programs || []).map(s => String(s).toLowerCase()));
  const u = {}; FIELD_IDS.forEach(id => u[id] = set.has(id) ? "1" : "0"); return u;
}
function allZero() { const u={}; FIELD_IDS.forEach(id=>u[id]="0"); return u; }
async function retry(fn, tries=3, d=250){ let e; for(let i=0;i<tries;i++){ try{return await fn();}catch(err){e=err;} await new Promise(r=>setTimeout(r,d*(i+1))); } throw e; }

/* ---------- HANDLER ---------- */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  let body=''; req.setEncoding('utf8'); req.on('data',c=>body+=c); await new Promise(r=>req.on('end',r));
  const sig = req.headers['stripe-signature'];

  let event, env;
  try { ({ event, env } = verifyWithSingleSecret(body, sig)); }
  catch(e){ console.error('Stripe signature error:', e.message); return res.status(400).send('Invalid signature'); }

  const type = event.type;
  console.log('Stripe webhook hit:', { type, env, livemode: event.livemode });

  const HANDLE = new Set(['checkout.session.completed','invoice.paid','customer.subscription.updated','customer.subscription.deleted']);
  if (!HANDLE.has(type)) return res.status(200).send();

  try {
    const obj = event.data.object;
    const emailKey = (obj.customer_details?.email || obj.customer_email || '').trim().toLowerCase() || null;
    const stripeCustomerId = obj.customer || obj.customer_id || null;

    // idempotence
    const evtKey = `processed:${env}:${event.id}`;
    if (await kvGet(evtKey)) return res.status(200).send();

    // ========== A) completed / paid : applique l'INTENT ==========
    if (type === 'checkout.session.completed' || type === 'invoice.paid') {
      let ptr = null;
      if (emailKey) ptr = await retry(()=>kvGet(`latest-intent-email:${env}:${emailKey}`),3,250).catch(()=>null);

      let memberId = null;
      if (!ptr && emailKey) {
        // **FIX 12:59** : fallback fiable MS v2→v1
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
        if (memberId) ptr = await kvGet(`latest-intent:${env}:${memberId}`);
      }
      if (!ptr?.intentId) {
        console.log(`No intent pointer for env=${env}, email=${emailKey} → skip`);
        await kvSetEx(evtKey, 1, 7*24*3600);
        return res.status(200).send();
      }

      const intentKey = `intent:${ptr.intentId}`;
      let intent = null;
      for (let i=0;i<3;i++){ intent = await kvGet(intentKey); if (intent) break; await new Promise(r=>setTimeout(r,250*(i+1))); }
      if (!intent || intent.status === 'applied') {
        console.log(`Intent unusable: ${intentKey}`);
        await kvSetEx(evtKey, 1, 7*24*3600);
        return res.status(200).send();
      }

      memberId = memberId || intent.memberId || (emailKey ? await msFindMemberIdByEmail(env, emailKey).catch(()=>null) : null);
      if (!memberId) {
        console.log('MemberId not resolved → skip');
        await kvSetEx(evtKey, 1, 7*24*3600);
        return res.status(200).send();
      }

      const updates = buildFlags(intent.programs);
      await msPatchMember(env, memberId, updates);

      await kvSetEx(intentKey, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*3600);
      await kvSetEx(evtKey, 1, 7*24*3600);
      if (stripeCustomerId) await kvSetEx(`map:scus:${env}:${stripeCustomerId}`, { memberId }, 30*24*3600);

      console.log(`Stripe applied (${env}) member=${memberId} updates=${JSON.stringify(updates)}`);
      return res.status(200).send();
    }

    // ========== B) deleted : tout à 0 ==========
    if (type === 'customer.subscription.deleted') {
      let memberId = null;
      if (stripeCustomerId) {
        const m = await kvGet(`map:scus:${env}:${stripeCustomerId}`); memberId = m?.memberId || null;
      }
      if (!memberId && emailKey) memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
      if (!memberId) { await kvSetEx(evtKey, 1, 7*24*3600); return res.status(200).send(); }

      await msPatchMember(env, memberId, allZero());
      await kvSetEx(evtKey, 1, 7*24*3600);
      console.log(`Subscription deleted → flags reset to 0 (member=${memberId})`);
      return res.status(200).send();
    }

    // ========== C) updated : ré-applique dernier intent ==========
    if (type === 'customer.subscription.updated') {
      let memberId = null;
      if (stripeCustomerId) {
        const m = await kvGet(`map:scus:${env}:${stripeCustomerId}`); memberId = m?.memberId || null;
      }
      if (!memberId && emailKey) memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
      if (!memberId) { await kvSetEx(evtKey, 1, 7*24*3600); return res.status(200).send(); }

      const ptr = await kvGet(`latest-intent:${env}:${memberId}`);
      if (!ptr?.intentId) { await kvSetEx(evtKey, 1, 7*24*3600); return res.status(200).send(); }
      const intent = await kvGet(`intent:${ptr.intentId}`);
      if (!intent) { await kvSetEx(evtKey, 1, 7*24*3600); return res.status(200).send(); }

      const updates = buildFlags(intent.programs);
      await msPatchMember(env, memberId, updates);
      await kvSetEx(evtKey, 1, 7*24*3600);
      console.log(`Subscription updated → re-applied last intent (member=${memberId})`);
      return res.status(200).send();
    }

    await kvSetEx(evtKey, 1, 7*24*3600);
    return res.status(200).send();
  } catch (e) {
    console.error('Stripe webhook error:', e.message);
    return res.status(500).send('Handler error');
  }
};
