// /api/ms-webhook.js
// Webhook Memberstack (Svix) multi-env : accepte Test & Live, choisit la bonne API key,
// et met à jour UNIQUEMENT tes champs underscore : Athletyx, Booty_Shape, Upper_Shape, Power_Flow.

const { Webhook } = require('svix');
const fetch = require('node-fetch');

// ----- KV helpers -----
function kvBase()  { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvHeaders(){ const t = kvToken(); if (!t) throw new Error('KV token missing'); return { Authorization: `Bearer ${t}` }; }
async function kvJson(res){ if(!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`); return res.json(); }
async function kvGet(key){ const res = await fetch(`${kvBase()}/get/${encodeURIComponent(key)}`, { headers: kvHeaders() }); const d = await kvJson(res); return d?.result ? JSON.parse(d.result) : null; }
async function kvSetEx(key, value, ttl){
  const res = await fetch(`${kvBase()}/setex/${encodeURIComponent(key)}/${ttl}`, {
    method:'POST',
    headers:{...kvHeaders(),'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({ value: JSON.stringify(value) })
  });
  await kvJson(res);
}

// ----- Memberstack Admin (choix de la clé par env) -----
async function msUpdateFields(env, memberId, updates){
  const apiKey =
    env === 'live' ? process.env.MEMBERSTACK_API_KEY_LIVE :
    env === 'test' ? process.env.MEMBERSTACK_API_KEY_TEST : null;

  if (!apiKey) throw new Error(`Missing Memberstack API key for env=${env}`);

  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method:'PATCH',
    headers:{ 'X-API-KEY': apiKey, 'Content-Type':'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
  if(!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

// ----- mapping slug -> champs UNDERSCORE -----
const SLUG_TO_FIELD = {
  'athletyx':    'Athletyx',
  'booty-shape': 'Booty_Shape',
  'upper-shape': 'Upper_Shape',
  'power-flow':  'Power_Flow'
};
const ALL_FIELDS = ['Athletyx','Booty_Shape','Upper_Shape','Power_Flow'];

// utils
function get(obj, path){ return path.split('.').reduce((o,k)=>o && o[k]!==undefined ? o[k] : undefined, obj); }
function findByKeys(obj, keys){
  let out; (function walk(o){ if(out) return; if(o && typeof o==='object'){ for(const [k,v] of Object.entries(o)){ if(out) break;
    if(keys.includes(k) && typeof v==='string' && v){ out=v; break; }
    if(v && typeof v==='object') walk(v);
  }}})(obj); return out;
}
function findByPattern(obj, regex){
  let out; (function walk(o){ if(out) return; if(o && typeof o==='object'){ for(const v of Object.values(o)){ if(out) break;
    if(typeof v==='string' && regex.test(v)){ out=v; break; }
    if(v && typeof v==='object') walk(v);
  }}})(obj); return out;
}

// Vérifie la signature avec LIVE puis TEST. Retourne {env, event} si OK.
function verifyWithEitherSecret(rawBody, headers){
  const id  = headers['svix-id'];
  const ts  = headers['svix-timestamp'];
  const sig = headers['svix-signature'];
  if(!id || !ts || !sig) throw new Error('Missing Svix headers');

  const tryVerify = (secret) => {
    const wh = new Webhook(secret);
    return wh.verify(rawBody, { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig });
  };

  const live = process.env.MS_WEBHOOK_SECRET_LIVE;
  const test = process.env.MS_WEBHOOK_SECRET_TEST;

  if (live) {
    try { return { env:'live', event: tryVerify(live) }; } catch(_) {}
  }
  if (test) {
    try { return { env:'test', event: tryVerify(test) }; } catch(_) {}
  }
  throw new Error('Invalid signature for both LIVE and TEST secrets');
}

module.exports = async (req, res) => {
  // Lire le body brut (requis)
  let body=''; req.setEncoding('utf8'); req.on('data',c=>body+=c); await new Promise(r=>req.on('end',r));

  let env, evt;
  try {
    const v = verifyWithEitherSecret(body, req.headers);
    env = v.env; evt = v.event;
  } catch (e) {
    console.error('Signature error:', e.message);
    return res.status(400).send('Invalid signature');
  }

  const type    = evt?.type || evt?.event;
  const payload = evt?.data || evt?.payload || {};
  try { console.log('MS webhook hit:', { env, type }); } catch(_) {}

  if (type !== 'member.plan.added') return res.send();

  try {
    // IDs robustes (incl. payload.planConnection.planId pour les tests)
    let memberId =
      get(payload,'member.id') ||
      payload.memberId ||
      findByKeys(payload, ['memberId','member_id']) ||
      findByPattern(payload, /^mem_[A-Za-z0-9]+$/);

    let planId =
      get(payload,'plan.id') ||
      payload.planId ||
      get(payload,'planConnection.planId') ||
      findByKeys(payload, ['planId','plan_id']) ||
      findByPattern(payload, /^pln_[A-Za-z0-9-]+$/);

    if(!memberId || !planId) {
      console.log('Missing IDs', { env, haveMemberId: !!memberId, havePlanId: !!planId, preview: JSON.stringify(payload).slice(0, 900) });
      return res.send();
    }

    // Ignorer les "example webhooks" (IDs bidons)
    if (memberId.length < 10 || planId.length < 10) {
      console.log('Example webhook detected, skip update', { env, memberId, planId });
      return res.send();
    }

    // 1) Lire l’intent KV
    const ptr = await kvGet(`latest-intent:${memberId}`);
    if (ptr?.intentId) {
      const intent = await kvGet(`intent:${ptr.intentId}`);
      if (intent && intent.status !== 'applied') {
        const selectedSlugs = new Set((intent.programs || []).map(s => String(s).toLowerCase()));

        // 2) Construire updates underscore only
        const updates = {};
        ALL_FIELDS.forEach(fieldKey => {
          const slug = Object.keys(SLUG_TO_FIELD).find(k => SLUG_TO_FIELD[k] === fieldKey);
          updates[fieldKey] = selectedSlugs.has(slug) ? "1" : "0";
        });

        await msUpdateFields(env, memberId, updates);
        await kvSetEx(`intent:${intent.intentId}`, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60);
        console.log(`Applied (${env}) ${memberId}: updates=${JSON.stringify(updates)}`);
        return res.send();
      }
    }

    // 3) Fallback : pas d’intent → tout à "0"
    const updates = {}; ALL_FIELDS.forEach(f => { updates[f] = "0"; });
    await msUpdateFields(env, memberId, updates);
    console.log(`Applied fallback (${env}) ${memberId}: all programs=0`);
    return res.send();

  } catch (err) {
    console.error('ms-webhook error:', err.message);
    return res.status(500).send('Webhook handler error');
  }
};
