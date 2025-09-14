/**
 * api/stripe-webhook.js
 *
 * ✅ Corrige Memberstack:
 *   - Utilise 'X-API-KEY' au lieu de 'Authorization: Bearer'
 *   - URIs sans /v2 : https://admin.memberstack.com/members/{...}
 *
 * Gère les événements Stripe (test & live) :
 *   - checkout.session.completed  -> Active programmes achetés
 *   - invoice.paid                -> (sécurité) Active
 *   - customer.subscription.deleted -> Désactive
 *   - customer.subscription.updated -> Ré-applique selon status
 *
 * Stocke et retrouve l'intent via Upstash (pointeurs latest-intent-*)
 */

const crypto = require('crypto');
const Stripe = require('stripe');
const STRIPE = Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

// ---------- Config ----------
const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

// Upstash (REST)
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Stripe webhook secret
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// ------------- Utils -------------
function log(...args){ console.log('[WEBHOOK]', ...args); }
function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function normalizeEmail(s){
  return (s || '').trim().toLowerCase();
}

function msApiKey(env){
  // Pour test, on prend MEMBERSTACK_API_KEY_TEST en priorité, sinon MEMBERSTACK_API_KEY
  if (env === 'live') return process.env.MEMBERSTACK_API_KEY_LIVE;
  return process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
function msHeaders(key){
  return { 'X-API-KEY': key, 'Content-Type':'application/json' };
}

async function upstash(command, args){
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash missing config');
  const body = JSON.stringify([command, ...args]);
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok) throw new Error(`Upstash ${command} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function kvSet(key, val, ttlSec){
  if (ttlSec) return upstash('SET', [key, typeof val==='string'?val:JSON.stringify(val), 'EX', ttlSec]);
  return upstash('SET', [key, typeof val==='string'?val:JSON.stringify(val)]);
}
async function kvGet(key){
  const r = await upstash('GET', [key]);
  return r && typeof r.result === 'string' ? r.result : null;
}
async function kvDel(key){
  return upstash('DEL', [key]);
}

// -------- Memberstack Admin REST (v2 sans /v2 dans l’URL) --------
async function msFindMemberIdByEmail(env, email){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${encodeURIComponent(email)}`; // GET par email
  // Petit log non-sensible
  console.log('[MS] findByEmail', { env, email, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok){
    // 404 si pas trouvé, on renvoie null
    if (r.status === 404) return null;
    throw new Error(`MS query ${r.status}: ${txt}`);
  }
  const d = JSON.parse(txt || '{}');
  // Format attendu: { data: [{ id: 'mem_xxx', ...}] } ou objet direct selon implémentations
  const id = d && d.data && d.data[0] && d.data[0].id ? d.data[0].id : (d && d.id ? d.id : null);
  return id || null;
}

async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] PATCH customFields', { env, memberId, updates: customFields, keyPrefix: String(key).slice(0,6) });
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

// -------- Intent helpers --------
function pointerKeysForEmail(email){
  const e = normalizeEmail(email);
  return [
    `latest-intent-email:test:${e}`,
    `latest-intent-email:live:${e}`,
    `latest-intent-email:${e}`,
  ];
}
function pointerKeysForMember(memberId){
  return [
    `latest-intent:test:${memberId}`,
    `latest-intent:live:${memberId}`,
    `latest-intent:${memberId}`,
  ];
}

async function loadIntentByEmail(email){
  const keys = pointerKeysForEmail(email);
  for (let k of keys){
    const val = await kvGet(k);
    if (val){
      console.log('[INTENT] ptr hit', k, '->', val);
      const data = await kvGet(val);
      if (data){
        try{ return JSON.parse(data); }catch(e){}
      }
    }
  }
  return null;
}
async function loadIntentByMember(memberId){
  const keys = pointerKeysForMember(memberId);
  for (let k of keys){
    const val = await kvGet(k);
    if (val){
      console.log('[INTENT] ptr hit', k, '->', val);
      const data = await kvGet(val);
      if (data){
        try{ return JSON.parse(data); }catch(e){}
      }
    }
  }
  return null;
}

function buildCustomFields(programs, active){
  const map = {};
  for (const f of FIELD_IDS){
    map[f] = '0';
  }
  if (active && Array.isArray(programs)){
    for (const p of programs){
      if (FIELD_IDS.includes(p)) map[p] = '1';
    }
  }
  return map;
}

// -------- Stripe raw body utils (nécessaire pour vérifier la signature) --------
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

// -------- Main handler --------
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
  log('Stripe event', { type, env, livemode: event.livemode });

  try{
    // ---- Extraire email / customer selon type ----
    let email = null;
    let customerId = null;

    if (type === 'checkout.session.completed'){
      const s = event.data.object;
      email = s.customer_details && s.customer_details.email ? s.customer_details.email : null;
      customerId = s.customer || null;
    } else if (type === 'invoice.paid' || type === 'invoice.payment_failed'){
      const inv = event.data.object;
      customerId = inv.customer || null;
      email = inv.customer_email || (inv.customer_details && inv.customer_details.email) || null;
    } else if (type === 'customer.subscription.deleted' || type === 'customer.subscription.updated'){
      const sub = event.data.object;
      customerId = sub.customer || null;
      // pas d'email direct → on utilisera le mapping client->member ou un intent précédent
    }

    // ---- Tenter de retrouver le memberId et l'intent ----
    let intent = null;
    let memberId = null;

    // 1) par email (le plus simple après checkout)
    if (email){
      intent = await loadIntentByEmail(email);
    }

    // 2) si on a un memberId dans l'intent → OK
    if (intent && intent.memberId) memberId = intent.memberId;

    // 3) sinon, si on a un email mais pas d'intent → tenter Memberstack par email
    if (!intent && email){
      const mId = await msFindMemberIdByEmail(env, normalizeEmail(email));
      if (mId) memberId = mId;
    }

    // 4) si toujours rien, tenter via un intent par memberId (si on l’a d’ailleurs)
    if (!intent && memberId){
      intent = await loadIntentByMember(memberId);
    }

    // 5) fallback: si on a customerId Stripe, tu peux maintenir un mapping scus:{id} -> {memberId,email}
    if (!memberId && customerId){
      const mapRaw = await kvGet(`map:scus:${customerId}`);
      if (mapRaw){
        try{
          const map = JSON.parse(mapRaw);
          if (map.memberId) memberId = map.memberId;
          if (!intent && map.email) intent = await loadIntentByEmail(map.email);
        }catch(e){}
      }
    }

    // ---- Déterminer action selon type ----
    const activateTypes = new Set(['checkout.session.completed', 'invoice.paid']);
    const deactivateTypes = new Set(['customer.subscription.deleted']);
    const maybeUpdateTypes = new Set(['customer.subscription.updated']);

    // Programmes et custom fields
    let programs = (intent && Array.isArray(intent.programs)) ? intent.programs : [];
    let applyActive = false;

    if (activateTypes.has(type)){
      applyActive = true;
    } else if (deactivateTypes.has(type)){
      applyActive = false;
      // en cas de delete, si pas d'intent, on met tout à 0
      if (!programs || programs.length === 0) programs = FIELD_IDS.slice(0);
    } else if (maybeUpdateTypes.has(type)){
      // selon status de la sub
      const sub = event.data.object;
      const activeStatuses = new Set(['active','trialing','past_due','incomplete']); // ajuste si besoin
      applyActive = activeStatuses.has(sub.status);
      if (!programs || programs.length === 0){
        // si on n'a pas de programmes en mémoire, on ne sait pas quoi activer → pas d'update destructive
        console.log('[INFO] subscription.updated sans programmes connus -> skip fields');
        return res.status(200).json({ ok:true, info:'no-programs-known' });
      }
    } else {
      // événement non géré: ACK
      return res.status(200).json({ ok:true, ignored:true });
    }

    if (!memberId){
      console.warn('[WARN] No memberId resolved -> skip MS update');
      return res.status(200).json({ ok:true, skipped:'no-member-id' });
    }

    // Construire la payload customFields
    const customFields = buildCustomFields(programs, applyActive);

    // PATCH Memberstack
    await msPatchMember(env, memberId, customFields);

    // Marquer intent appliqué + mapper le customerId → member/email pour futurs événements
    if (intent && intent.id){
      await kvSet(intent.id, JSON.stringify({ ...intent, appliedAt: Date.now() }), 60*60*24*30);
    }
    if (customerId){
      await kvSet(`map:scus:${customerId}`, JSON.stringify({ memberId, email: email || (intent && intent.email) || null }), 60*60*24*180);
    }

    return res.status(200).json({ ok:true, memberId, applied: applyActive, programs });
  }catch(err){
    console.error('Webhook handler error:', err && err.stack || err);
    return res.status(500).json({ ok:false, error: String(err && err.message || err) });
  }
};

// ⚠️ Si tu es dans Next.js (pages/api), ajoute ceci dans le même fichier :
// export const config = { api: { bodyParser: false } };
