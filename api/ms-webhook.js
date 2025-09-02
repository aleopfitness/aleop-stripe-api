// /api/ms-webhook.js
// Webhook Memberstack (Svix) : applique les accès après ajout d'un paid plan.
// Écrit UNIQUEMENT tes champs custom underscore : Athletyx, Booty_Shape, Upper_Shape, Power_Flow
// -> "1" si acheté, "0" sinon (via l'intent stocké côté serveur).

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

// ---------- TES planId -> seats (pas utilisé pour écrire des champs mais utile à garder)
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

// util
function get(obj, path){ return path.split('.').reduce((o,k)=>o&&o[k]!==undefined?o[k]:undefined,obj); }

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
      const memberId = get(data,'member.id') || get(data,'id') || get(data,'memberId');
      const planId   = get(data,'plan.id')   || get(data,'planId') || get(data,'newPlan.id');
      if(!memberId || !planId) { console.log('Missing IDs'); return res.send(); }

      // (facultatif) on garde la détection de seats via planId pour logs/cohérence
      const seats = PLAN_TO_SEATS[planId] || null;

      // retrouver l'intent (programmes choisis côté panier)
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
          console.log(`Applied ${memberId}: seats=${seats ?? 'n/a'}, updates=${JSON.stringify(updates)}`);
          return res.send();
        }
      }

      // fallback : pas d’intent -> on met toutes les licences à "0"
      const updates = {}; ALL_FIELDS.forEach(f => { updates[f] = "0"; });
      await msUpdateFields(memberId, updates);
      console.log(`Applied fallback ${memberId}: seats=${seats ?? 'n/a'}, all programs=0`);
      return res.send();

    } catch(err) {
      console.error('ms-webhook error:', err.message);
      return res.status(500).send('Webhook handler error');
    }
  }

  // on ignore les autres events pour l’instant
  return res.send();
};
