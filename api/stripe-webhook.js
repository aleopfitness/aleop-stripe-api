/**
 * api/stripe-webhook.js
 *
 * Stripe ↔ Memberstack ↔ Upstash (Test & Live)
 * - Memberstack Admin REST:
 *     - GET member by email:  https://admin.memberstack.com/members/{email}
 *     - PATCH member by id:   https://admin.memberstack.com/members/{memberId}
 *   Headers: { 'X-API-KEY': <SECRET>, 'Content-Type':'application/json' }
 *
 * Événements Stripe gérés:
 *   - checkout.session.completed  -> active programmes
 *   - invoice.paid                -> (sécurité) active
 *   - customer.subscription.deleted -> désactive
 *   - customer.subscription.updated -> (ré-applique selon status)
 *
 * NB (Next.js pages/api): ajouter en bas:
 *   export const config = { api: { bodyParser: false } };
 */

const Stripe = require('stripe');
const STRIPE = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

// Upstash (REST)
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Stripe webhook secret
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ---------- Utils ----------
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function normalizeEmail(s){ return (s || '').trim().toLowerCase(); }
function msApiKey(env){
  if (env === 'live') return process.env.MEMBERSTACK_API_KEY_LIVE;
  return process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
function msHeaders(key){
  return { 'X-API-KEY': key, 'Content-Type':'application/json' };
}

// ---------- Upstash ----------
async function upstash(command, args){
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash missing config');
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify([command, ...args])
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok) throw new Error(`Upstash ${command} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function kvSet(key, val, ttlSec){
  const v = (typeof val === 'string') ? val : JSON.stringify(val);
  if (ttlSec) return upstash('SET', [key, v, 'EX', ttlSec]);
  return upstash('SET', [key, v]);
}
async function kvGet(key){
  const r = await upstash('GET', [key]);
  return r && typeof r.result === 'string' ? r.result : null;
}

// ---------- Memberstack Admin REST ----------
async function msFindMemberIdByEmail(env, email){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${encodeURIComponent(email)}`;
  console.log('[MS] findByEmail', { env, email, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok){
    if (r.status === 404) return null; // email inconnu
    throw new Error(`MS query ${r.status}: ${txt}`);
  }
  const d = JSON.parse(txt || '{}');
  // Formats possibles: { data: [{ id: 'mem_...' }]} OU { id:'mem_...' }
  const id = d?.data?.[0]?.id ?? d?.id ?? null;
  return id || null;
}

async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] PATCH customFields', { env, memberId, keyPrefix: String(key).slice(0,6), updates: customFields });
  const r = await fetch(url, {
    method: 'PATCH',
    headers: msHeaders(key),
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  if (!r.ok){
    console.error('[MS] PATCH ERROR', r.status, txt.substring(0,300));
    throw new Error(`MS v2 update ${r.status}: ${txt}`);
  }
  console.log('[MS] PATCH OK', { status: r.status });
}

// ---------- Intent helpers ----------
function ptrKeysEmail(email){
  const e = normalizeEmail(email);
  return [
    `latest-intent-email:test:${e}`,
    `latest-intent-email:live:${e}`,
    `latest-intent-email:${e}`,
  ];
}
function ptrKeysMember(memberId){
  return [
    `latest-intent:test:${memberId}`,
    `latest-intent:live:${memberId}`,
    `latest-intent:${memberId}`,
  ];
}
async function loadIntentByEmail(email){
  for (const k of ptrKeysEmail(email)){
    const ref = await kvGet(k);
    if (ref){
      console.log('[INTENT] ptr hit', k, '->', ref);
      const raw = await kvGet(ref);
      if (raw){ try{ return JSON.parse(raw); }catch{} }
    }
  }
  return null;
}
async function loadIntentByMember(memberId){
  for (const k of ptrKeysMember(memberId)){
    const ref = await kvGet(k);
    if (ref){
      console.log('[INTENT] ptr hit', k, '->', ref);
      const raw = await kvGet(ref);
      if (raw){ try{ return JSON.parse(raw); }catch{} }
    }
  }
  return null;
}

function buildCustomFields(programs, active){
  const m = {};
  for (const f of FIELD_IDS) m[f] = '0';
  if (active && Array.isArray(programs)){
    for (const p of programs) if (FIELD_IDS.includes(p)) m[p] = '1';
  }
  return m;
}

// ---------- Stripe raw body ----------
async function readRawBody(req){
  return new Promise((resolve, reject) => {
    try{
      const chunks = [];
      req.on('data', (c)=>chunks.push(Buffer.from(c)));
      req.on('end', ()=>resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    }catch(err){ reject(err); }
  });
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  if (req.method !== 'POST'){
    res.setHeader('Allow', 'POST');
    return res.status(405).send('Method Not Allowed');
  }

  let buf;
  try{
    buf = await readRawBody(req);
  }catch(e){
    console.error('readRawBody error', e);
    return res.status(400).send('Invalid body');
  }

  const sig = req.headers['stripe-signature'];
  let event;
  try{
    if (!STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET missing');
    event = STRIPE.webhooks.constructEvent(buf, sig, STRIPE_WEBHOOK_SECRET);
  }catch(err){
    console.error('Stripe constructEvent error', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const env = event.livemode ? 'live' : 'test';
  const type = event.type;
  console.log('Stripe webhook hit:', { type, env, livemode: event.livemode });

  try{
    // --- extractions communes ---
    let email = null;
    let customerId = null;

    if (type === 'checkout.session.completed'){
      const s = event.data.object;
      email = s.customer_details?.email ?? null;
      customerId = s.customer ?? null;
    } else if (type === 'invoice.paid' || type === 'invoice.payment_failed'){
      const inv = event.data.object;
      customerId = inv.customer ?? null;
      email = inv.customer_email || inv.customer_details?.email || null;
    } else if (type === 'customer.subscription.deleted' || type === 'customer.subscription.updated'){
      const sub = event.data.object;
      customerId = sub.customer ?? null;
    }

    // --- retrouver intent + member ---
    let intent = null;
    let memberId = null;

    if (email) intent = await loadIntentByEmail(email);
    if (intent?.memberId) memberId = intent.memberId;

    if (!intent && email && !memberId){
      const found = await msFindMemberIdByEmail(env, normalizeEmail(email));
      if (found) memberId = found;
    }

    if (!intent && memberId){
      intent = await loadIntentByMember(memberId);
    }

    if (!memberId && customerId){
      const mapRaw = await kvGet(`map:scus:${customerId}`);
      if (mapRaw){
        try{
          const map = JSON.parse(mapRaw);
          if (map.memberId) memberId = map.memberId;
          if (!intent && map.email) intent = await loadIntentByEmail(map.email);
        }catch{}
      }
    }

    // --- déterminer action ---
    const activateTypes = new Set(['checkout.session.completed','invoice.paid']);
    const deactivateTypes = new Set(['customer.subscription.deleted']);
    const maybeUpdateTypes = new Set(['customer.subscription.updated']);

    let programs = (intent && Array.isArray(intent.programs)) ? intent.programs : [];
    let applyActive = false;

    if (activateTypes.has(type)){
      applyActive = true;
    } else if (deactivateTypes.has(type)){
      applyActive = false;
      if (!programs || programs.length === 0) programs = FIELD_IDS.slice(0); // tout à 0
    } else if (maybeUpdateTypes.has(type)){
      const sub = event.data.object;
      const activeStatuses = new Set(['active','trialing','past_due','incomplete']);
      applyActive = activeStatuses.has(sub.status);
      if (!programs || programs.length === 0){
        console.log('[INFO] subscription.updated sans programmes connus -> skip fields');
        return res.status(200).json({ ok:true, info:'no-programs-known' });
      }
    } else {
      return res.status(200).json({ ok:true, ignored:true });
    }

    if (!memberId){
      console.warn('[WARN] No memberId resolved -> skip MS update');
      return res.status(200).json({ ok:true, skipped:'no-member-id' });
    }

    const customFields = buildCustomFields(programs, applyActive);
    await msPatchMember(env, memberId, customFields);

    // persistance post-traitement
    if (intent?.id){
      await kvSet(intent.id, { ...intent, appliedAt: Date.now() }, 60*60*24*30);
    }
    if (customerId){
      await kvSet(`map:scus:${customerId}`, { memberId, email: email || intent?.email || null }, 60*60*24*180);
    }

    return res.status(200).json({ ok:true, memberId, applied: applyActive, programs });
  }catch(err){
    console.error('Webhook handler error:', err && err.stack || err);
    return res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};

// ⚠️ Si tu utilises Next.js pages/api :
/*
export const config = {
  api: { bodyParser: false }
};
*/
