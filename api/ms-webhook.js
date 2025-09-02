// /api/ms-webhook.js
// Webhook Memberstack (Svix) : applique les accès après ajout d'un paid plan.
// Écrit UNIQUEMENT tes champs custom underscore : Athletyx, Booty_Shape, Upper_Shape, Power_Flow
// - Extraction robuste des IDs (memberId / planId), y compris fallback par pattern.

const { Webhook } = require('svix');
const fetch = require('node-fetch');

// ---------- KV helpers (Upstash / Vercel KV) ----------
function kvBase() { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvHeaders() { const t = kvToken(); if (!t) throw new Error('KV token missing'); return { Authorization: `Bearer ${t}` }; }
async function kvJson(res){ if(!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`); return res.json(); }
async function kvGet(key){ const res = await fetch(`${kvBase()}/get/${encodeURIComponent(key)}`, { headers: kvHeaders() }); const d = await kvJson(res); return d?.result ? JSON.parse(d.result) : null; }
async function kvSetEx(key, value, ttl){ const res = await fetch(`${kvBase()}/setex/${encodeURIComponent(key)}/${ttl}`, { method:'POST', headers:{...kvHeaders(),'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ value: JSON.stringify(value) })}); await kvJson(res); }

// ---------- Memberstack Admin API ----------
async function msUpdateFields(memberId, updates){
  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method:'PATCH',
    headers:{ 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
  if(!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

// ---------- TES plans -> seats (informative) ----------
const PLAN_TO_SEATS = {
  'pln_aleop-1-license-7x1ng0yup': 1,
  'pln_aleop-2-licenses-671nh0yv8': 2,
  'pln_aleop-3-licenses-6hfd0a8b': 3,
  'pln_aleop-4-licenses-kf1lq0vb7': 4,
  'pln_aleop-5-licenses-00fb0aa9': 5,
  'pln_aleop-6-licenses-t9hp0fjy': 6,
  'pln_aleop-7-licenses-38hq0fvb': 7,
  'pln_aleop-8-licenses-1zhs0fw1': 8,
  'pln_aleop-9-licenses-iefe0a7f': 9
};

// ---------- mapping slug panier -> champ underscore ----------
const SLUG_TO_FIELD = {
  'athletyx':    'Athletyx',
  'booty-shape': 'Booty_Shape',
  'upper-shape': 'Upper_Shape',
  'power-flow':  'Power_Flow'
};
const ALL_FIELDS = ['Athletyx','Booty_Shape','Upper_Shape','Power_Flow'];

// ---------- utils: safe-get + recherche fallback ----------
function get(obj, path){
  return path.split('.').reduce((o,k)=>o && o[k]!==undefined ? o[k] : undefined, obj);
}

// Retourne la 1ère valeur string d'une clé parmi candidates (deep)
function findByKeys(obj, candidates){
  let found;
  (function walk(o){
    if (found) return;
    if (o && typeof o === 'object') {
      for (const [k,v] of Object.entries(o)) {
        if (found) break;
        if (candidates.includes(k) && typeof v === 'string' && v) { found = v; break; }
        if (typeof v === 'object' && v) walk(v);
      }
    }
  })(obj);
  return found;
}
// Retourne la 1ère string qui matche un pattern (deep)
function findByPattern(obj, regex){
  let found;
  (function walk(o){
    if (found) return;
    if (o && typeof o === 'object') {
      for (const v of Object.values(o)) {
        if (found) break;
        if (typeof v === 'string' && regex.test(v)) { found = v; break; }
        if (typeof v === 'object' && v) walk(v);
      }
    }
  })(obj);
  return found;
}

module.exports = async (req, res) => {
  // lire le body brut (obligatoire pour Svix)
  let payload=''; req.setEncoding('utf8'); req.on('data',c=>payload+=c); await new Promise(r=>req.on('end',r));

  const svixId = req.headers['svix-id'];
  const svixTs = req.headers['svix-timestamp'];
  const svixSig = req.headers['svix-signature'];
  if(!svixId || !svixTs || !svixSig) return res.status(400).send('Missing Svix headers');
  if(!process.env.MS_WEBHOOK_SECRET) { console.error('MS_WEBHOOK_SECRET missing'); return res.status(500).send('Server misconfigured'); }

  // vérifier la signature
  let evt;
  try {
    const wh = new Webhook(process.env.MS_WEBHOOK_SECRET);
    evt = wh.verify(payload, { 'svix-id': svixId, 'svix-timestamp': svixTs, 'svix-signature': svixSig });
  } catch(e) {
    console.error('Invalid Svix signature:', e.message);
    return res.status(400).send('Invalid signature');
  }

  const type = evt?.type || evt?.event;
  const data = evt?.data || evt?.payload || {};

  if (type === 'member.plan.added') {
    try {
      // 1) Extraction robuste des IDs
      let memberId =
        get(data,'member.id') ||
        get(data,'memberId') ||
        get(data,'member') ||
        findByKeys(data, ['memberId','member_id']) ||
        findByPattern(data, /^mem_[a-zA-Z0-9]+$/);

      let planId =
        get(data,'plan.id') ||
        get(data,'planId') ||
        get(data,'newPlan.id') ||
        get(data,'plan') ||
        findByKeys(data, ['planId','plan_id']) ||
        findByPattern(data, /^pln_[a-zA-Z0-9-]+$/);

      if(!memberId || !planId) {
        console.log('Missing IDs', {
          type,
          haveMemberId: !!memberId,
          havePlanId: !!planId,
          sample: JSON.stringify(data, null, 2).slice(0, 1500) // snippet utile sans flood
        });
        return res.send(); // 200 → évite les retries en boucle sur tests
      }

      const seats = PLAN_TO_SEATS[planId] || null;

      // 2) Retrouver l'intent KV (programmes choisis)
      const ptr = await kvGet(`latest-intent:${memberId}`);
      if (ptr?.intentId) {
        const intent = await kvGet(`intent:${ptr.intentId}`);
        if (intent && intent.status !== 'applied') {
          const selectedSlugs = new Set((intent.programs || []).map(s => String(s).toLowerCase()));

          // set 1/0 uniquement sur les champs underscore
          const updates = {};
          ALL_FIELDS.forEach(fieldKey => {
            const slug = Object.keys(SLUG_TO_FIELD).find(k => SLUG_TO_FIELD[k] === fieldKey);
            updates[fieldKey] = selectedSlugs.has(slug) ? "1" : "0";
          });

          await msUpdateFields(memberId, updates);
          await kvSetEx(`intent:${intent.intentId}`, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60);

          console.log(`Applied ${memberId}: plan=${planId} seats=${seats ?? 'n/a'} updates=${JSON.stringify(updates)}`);
          return res.send();
        }
      }

      // 3) Fallback : pas d’intent -> on met toutes les licences à "0"
      const updates = {}; ALL_FIELDS.forEach(f => { updates[f] = "0"; });
      await msUpdateFields(memberId, updates);
      console.log(`Applied fallback ${memberId}: plan=${planId} seats=${seats ?? 'n/a'} all programs=0`);
      return res.send();

    } catch(err) {
      console.error('ms-webhook error:', err.message);
      return res.status(500).send('Webhook handler error');
    }
  }

  // on ignore les autres events pour l’instant
  return res.send();
};
