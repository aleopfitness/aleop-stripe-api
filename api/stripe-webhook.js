// /api/stripe-webhook.js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const fetch = require('node-fetch');

/* ===== KV Utils ===== */
function kvBase() { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvHeaders() { 
  const t = kvToken(); 
  if (!t) throw new Error('KV token missing'); 
  return { Authorization: `Bearer ${t}` }; 
}
async function kvJson(res) {
  const text = await res.text();
  if (!res.ok) throw new Error(`KV ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { result: text }; }
}
async function kvGet(key) {
  const res = await fetch(`${kvBase()}/get/${encodeURIComponent(key)}`, { headers: kvHeaders() });
  const d = await kvJson(res);
  return d?.result ? JSON.parse(d.result) : null;
}
async function kvSetEx(key, value, ttl) {
  const url = `${kvBase()}/set/${encodeURIComponent(key)}?ex=${ttl}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...kvHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
  await kvJson(res);
}

/* ===== Memberstack Admin ===== */
function msApiKey(env) {
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : env === 'test'
    ? process.env.MEMBERSTACK_API_KEY_TEST
    : process.env.MEMBERSTACK_API_KEY;
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

/* ===== IDs Exact des Champs (Tes 9 finaux) ===== */
const FIELD_IDS = ['athletyx', 'upper', 'booty', 'flow', 'fight', 'cardio', 'mobility', 'cycle', 'force'];

/* ===== Vérif Signature Stripe ===== */
function verifyStripeSignature(rawBody, signature) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('Stripe webhook secret missing');
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}

/* ===== Déduire Env (Via PriceId ou Secret) ===== */
function getEnvFromEvent(event) {
  // Option: Si secrets séparés en Vercel
  if (process.env.STRIPE_WEBHOOK_SECRET_TEST && process.env.STRIPE_WEBHOOK_SECRET === process.env.STRIPE_WEBHOOK_SECRET_TEST) return 'test';
  // Via priceId (tes live sans 'test_')
  const priceId = event.data.object.line_items?.data?.[0]?.price?.id || '';
  if (priceId.includes('test_') || priceId.includes('price_test_')) return 'test'; // Adapte si tes test prefixed
  return 'live';
}

/* ===== Retry KV Get ===== */
async function retryKvGet(key, max = 3, delay = 1000) {
  for (let i = 0; i < max; i++) {
    const val = await kvGet(key);
    if (val) return val;
    await new Promise(r => setTimeout(r, delay * (i + 1)));
  }
  return null;
}

/* ===== Handler ===== */
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method Not Allowed' });

  let body = ''; req.setEncoding('utf8'); req.on('data', c => body += c); await new Promise(r => req.on('end', r));
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = verifyStripeSignature(body, sig);
  } catch (e) {
    console.error('Stripe signature error:', e.message);
    return res.status(400).send('Invalid signature');
  }

  const type = event.type;
  const env = getEnvFromEvent(event);
  console.log('Stripe webhook hit:', { type, env });

  if (type !== 'checkout.session.completed') return res.status(200).send();

  try {
    const session = event.data.object;
    const emailRaw = session.customer_details?.email?.trim().toLowerCase();
    if (!emailRaw) {
      console.log('No email in session → skip');
      return res.status(200).send();
    }
    const emailKey = emailRaw;

    // 1) Retrouver intent par email (env-specific)
    const ptrKey = `latest-intent-email:${env}:${emailKey}`;
    let ptr = await retryKvGet(ptrKey);
    if (!ptr?.intentId) {
      console.log(`No intent for email=${emailKey} env=${env} → skip`);
      return res.status(200).send();
    }

    const intent = await kvGet(`intent:${ptr.intentId}`);
    if (!intent || intent.status === 'applied') {
      console.log('Intent unusable → skip');
      return res.status(200).send();
    }
    if (intent.env && intent.env !== env) {
      console.log(`ENV mismatch intent=${intent.env} webhook=${env} → skip`);
      return res.status(200).send();
    }

    // 2) Build updates avec tes 9 IDs
    const selected = new Set((intent.programs || []).map(s => String(s).toLowerCase()));
    const updates = {};
    FIELD_IDS.forEach(id => { updates[id] = selected.has(id) ? "1" : "0"; });

    // 3) Get memberId par query MS (safe fallback)
    let memberId = session.metadata?.memberId; // Si futur metadata
    if (!memberId) {
      const key = msApiKey(env);
      const qRes = await fetch(`https://admin.memberstack.com/members?email=${encodeURIComponent(emailKey)}`, {
        headers: { 'X-API-KEY': key }
      });
      if (!qRes.ok) throw new Error(`MS query ${qRes.status}: ${await qRes.text()}`);
      const members = await qRes.json();
      memberId = members?.data?.[0]?.id;
    }
    if (!memberId) {
      console.log('No memberId for email → skip');
      return res.status(200).send();
    }

    // 4) PATCH MS
    await msPatchMember(env, memberId, updates);

    // 5) Mark applied
    try {
      await kvSetEx(`intent:${intent.intentId}`, { ...intent, status: 'applied', appliedAt: Date.now() }, 7 * 24 * 60 * 60);
    } catch (e) { console.warn('KV update failed:', e.message); }

    console.log(`Stripe applied (${env}) ${memberId}: ${JSON.stringify(updates)}`);
    return res.status(200).send();

  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(500).send('Handler error');
  }
};
