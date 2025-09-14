/**
 * /api/stripe-webhook.js
 * Stripe (test/live) → retrouve l'intent en KV → met à jour Memberstack customFields
 * - Compatible avec tes pointeurs { intentId, env, t } écrits par TON intent.js
 * - KV/Upstash: auto-détecte KV_REST_API_URL / KV_REST_API_TOKEN / KV_URL etc.
 * - Memberstack: header 'X-API-KEY' + URLs SANS '/v2'
 * - Raw body Stripe (signature)
 *
 * ⚠️ Si tu es sur Next.js (pages/api), ajoute en bas:
 *    export const config = { api: { bodyParser: false } };
 */

const Stripe = require('stripe');

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* --- SECRETS --- */
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/* --- KV / Upstash: auto-detect --- */
const KV_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.KV_URL ||
  process.env.REDIS_URL;

const KV_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.KV_REST_API_READ_ONLY_TOKEN;

/* --- Utils --- */
function normalizeEmail(s){ return (s || '').trim().toLowerCase(); }

function msApiKey(env){
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
function msHeaders(key){
  return { 'X-API-KEY': key, 'Content-Type':'application/json' };
}

async function kvCall(cmd, args){
  if (!KV_URL || !KV_TOKEN){
    const miss = [
      !KV_URL   ? 'UPSTASH_REDIS_REST_URL/KV_REST_API_URL/KV_URL/REDIS_URL' : null,
      !KV_TOKEN ? 'UPSTASH_REDIS_REST_TOKEN/KV_REST_API_TOKEN' : null
    ].filter(Boolean).join(' & ');
    throw new Error('KV missing config: ' + miss);
  }
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${KV_TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify([cmd, ...args])
  });
  const data = await r.json().catch(()=>null);
  if (!r.ok) throw new Error(`KV ${cmd} ${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function kvGet(key){
  const r = await kvCall('GET', [key]);
  return (r && typeof r.result === 'string') ? r.result : null;
}
async function kvSet(key, val, ttlSec){
  const v = typeof val === 'string' ? val : JSON.stringify(val);
  return ttlSec ? kvCall('SET', [key, v, 'EX', ttlSec]) : kvCall('SET', [key, v]);
}

function buildFlags(programs, active=true){
  const set = new Set((programs||[]).map(s => String(s).toLowerCase()));
  const out = {};
  for (const f of FIELD_IDS) out[f] = active && set.has(f) ? '1' : '0';
  return out;
}

/* --- Stripe raw body --- */
async function readRawBody(req){
  return new Promise((resolve, reject) => {
    try{
      const chunks = [];
      req.on('data', c => chunks.push(Buffer.from(c)));
      req.on('end',  () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    }catch(err){ reject(err); }
  });
}

/* --- Memberstack Admin REST --- */
async function msFindMemberIdByEmail(env, email){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${encodeURIComponent(email)}`;
  console.log('[MS] findByEmail', { env, email, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok){
    if (r.status === 404) return null;
    throw new Error(`MS query ${r.status}: ${txt}`);
  }
  const d = JSON.parse(txt || '{}');
  const id = d?.data?.[0]?.id ?? d?.id ?? null;
  return id || null;
}

async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] PATCH', { env, memberId, keyPrefix: String(key).slice(0,6), fields: customFields });
  const r = await fetch(url, {
    method: 'PATCH',
    headers: msHeaders(key),
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  if (!r.ok){
    console.error('[MS] PATCH ERROR', r.status, txt.substring(0,300));
    throw new Error(`MS update ${r.status}: ${txt}`);
  }
  console.log('[MS] PATCH OK', { status: r.status });
}

/* --- Handler --- */
module.exports = async (req, res) => {
  // CORS (Stripe s’en fout, mais ça ne gêne pas)
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).send('Method Not Allowed');

  if (!STRIPE_SECRET_KEY)     return res.status(500).send('STRIPE_SECRET_KEY missing');
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).send('STRIPE_WEBHOOK_SECRET missing');

  // Stripe a besoin du raw body
  let raw;
  try{ raw = await readRawBody(req); }
  catch(e){ console.error('readRawBody error', e); return res.status(400).send('Invalid body'); }

  const sig = req.headers['stripe-signature'] || '';
  let event, env;
  try{
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
    env = event.livemode ? 'live' : 'test';
  }catch(e){
    console.error('Stripe constructEvent error:', e && e.message ? e.message : e);
    return res.status(400).send('Webhook signature error');
  }

  const type = event.type;
  console.log('Stripe webhook hit:', { type, env, livemode: event.livemode });

  const ACTIVATE   = new Set(['checkout.session.completed','invoice.paid']);
  const DEACTIVATE = new Set(['customer.subscription.deleted']);
  const MAYBE      = new Set(['customer.subscription.updated']); // optionnel

  try{
    const obj = event.data.object;
    const emailKey = normalizeEmail(
      obj?.customer_details?.email || obj?.customer_email || ''
    ) || null;
    const stripeCustomerId = obj?.customer || obj?.customer_id || null;

    // Idempotence simple (évite double-traitement)
    const evtKey = `processed:${env}:${event.id}`;
    if (await kvGet(evtKey)) return res.status(200).send();

    /* ========== ACTIVATE ========== */
    if (ACTIVATE.has(type)){
      // Retrouver le pointeur PAR EMAIL (conforme à ton intent.js)
      let ptr = null;
      if (emailKey){
        ptr = (await kvGet(`latest-intent-email:${env}:${emailKey}`))
           || (await kvGet(`latest-intent-email:${env==='live'?'test':'live'}:${emailKey}`))
           || (await kvGet(`latest-intent-email:default:${emailKey}`));
      }

      if (!ptr){
        console.log('[PTR] NOT FOUND for email=', emailKey);
        // on ACK pour que Stripe retente plus tard
        return res.status(200).send();
      }
      try{ ptr = JSON.parse(ptr); }catch{}

      // ptr.intentId → clé KV principale intent:${intentId}
      const intentKey = `intent:${ptr.intentId}`;
      let intent = null;
      for (let i=0;i<4;i++){
        const raw = await kvGet(intentKey);
        if (raw){ try{ intent = JSON.parse(raw); }catch{ intent = raw; } }
        console.log('[INTENT] fetch', intentKey, intent ? 'HIT' : 'MISS');
        if (intent) break;
        await new Promise(r=>setTimeout(r, 180*(i+1)));
      }
      if (!intent || intent.status === 'applied'){
        console.log('[INTENT] unusable -> skip');
        await kvSet(evtKey, 1, 3600); // évite spam si déjà appliqué
        return res.status(200).send();
      }

      // Résoudre memberId: on privilégie l’intent (ton front le passait)
      let memberId = intent.memberId;
      if (!memberId && emailKey){
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
      }
      if (!memberId){
        console.log('[MS] memberId not resolved -> skip');
        return res.status(200).send();
      }

      const updates = buildFlags(intent.programs, true);
      await msPatchMember(env, memberId, updates);

      // Marque appliqué + map stripe customer -> member
      await kvSet(intentKey, { ...intent, status:'applied', appliedAt: Date.now() }, 60*60*24*30);
      await kvSet(evtKey, 1, 30*24*3600);
      if (stripeCustomerId){
        await kvSet(`map:scus:${env}:${stripeCustomerId}`, { memberId, email: emailKey || intent.email || null }, 30*24*3600);
      }
      console.log(`Applied -> member=${memberId}`);
      return res.status(200).send();
    }

    /* ========== DEACTIVATE ========== */
    if (DEACTIVATE.has(type)){
      let memberId = null;

      // d’abord via mapping stripeCustomerId s'il existe
      if (stripeCustomerId){
        const m = await kvGet(`map:scus:${env}:${stripeCustomerId}`);
        if (m){ try{ memberId = JSON.parse(m)?.memberId || null; }catch{} }
      }
      // sinon par email
      if (!memberId && emailKey){
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
      }
      if (!memberId){
        console.log('[MS] memberId not found for deactivation -> skip');
        return res.status(200).send();
      }

      await msPatchMember(env, memberId, buildFlags([], false)); // tout à 0
      await kvSet(evtKey, 1, 30*24*3600);
      console.log(`Deactivated -> member=${memberId}`);
      return res.status(200).send();
    }

    /* ========== MAYBE (optionnel) ========== */
    if (MAYBE.has(type)){
      // à implémenter selon ta politique (activeStatuses, etc.)
      return res.status(200).send();
    }

    // autres types → ACK
    return res.status(200).send();

  }catch(err){
    console.error('Webhook handler error:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    return res.status(500).send('Handler error');
  }
};

// ⚠️ Next.js (pages/api) : Stripe a besoin du raw body
/*
export const config = {
  api: { bodyParser: false }
};
*/
