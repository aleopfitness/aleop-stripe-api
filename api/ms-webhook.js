// /api/ms-webhook.js
const { Webhook } = require('svix');
const fetch = require('node-fetch');

// KV helpers
function kvBase() { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken() { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvHeaders() { const t = kvToken(); if (!t) throw new Error('KV token missing'); return { Authorization: `Bearer ${t}` }; }
async function kvJson(res){ if(!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`); return res.json(); }
async function kvGet(key){ const res = await fetch(`${kvBase()}/get/${encodeURIComponent(key)}`, { headers: kvHeaders() }); const d = await kvJson(res); return d?.result ? JSON.parse(d.result) : null; }
async function kvSetEx(key, value, ttl){ const res = await fetch(`${kvBase()}/setex/${encodeURIComponent(key)}/${ttl}`, { method:'POST', headers:{...kvHeaders(),'Content-Type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({ value: JSON.stringify(value) })}); await kvJson(res); }

// Memberstack Admin
async function msUpdateFields(memberId, updates){
  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method:'PATCH',
    headers:{ 'X-API-KEY': process.env.MEMBERSTACK_API_KEY, 'Content-Type':'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
  if(!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

// TES planId -> seats
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

// IDs EXACTS des custom fields (kebab-case)
const PROGRAM_KEYS = ['athletyx','booty-shape','upper-shape','power-flow'];

function get(obj, path){ return path.split('.').reduce((o,k)=>o&&o[k]!==undefined?o[k]:undefined,obj); }

module.exports = async (req, res) => {
  // raw body for Svix
  let payload=''; req.setEncoding('utf8'); req.on('data',c=>payload+=c); await new Promise(r=>req.on('end',r));

  const svixId = req.headers['svix-id'];
  const svixTs = req.headers['svix-timestamp'];
  const svixSig = req.headers['svix-signature'];
  if(!svixId || !svixTs || !svixSig) return res.status(400).send('Missing Svix headers');
  if(!process.env.MS_WEBHOOK_SECRET) { console.error('MS_WEBHOOK_SECRET missing'); return res.status(500).send('Server misconfigured'); }

  // verify
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

      const seats = PLAN_TO_SEATS[planId];
      if(!seats){ console.log('Unknown plan', planId); return res.send(); }

      // retrouver le dernier intent
      const ptr = await kvGet(`latest-intent:${memberId}`);
      let programs = [];
      if (ptr?.intentId) {
        const intent = await kvGet(`intent:${ptr.intentId}`);
        if (intent && intent.status !== 'applied') {
          programs = Array.isArray(intent.programs) ? intent.programs.map(s=>String(s).toLowerCase()) : [];
          // appliquer les champs 1/0
          const updates = {
            active: "1",
            team_owner: "1",
            seats_total: String(seats),
            seats_used: "0"
          };
          PROGRAM_KEYS.forEach(k => { updates[k] = programs.includes(k) ? "1" : "0"; });

          await msUpdateFields(memberId, updates);
          await kvSetEx(`intent:${intent.intentId}`, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60);
          console.log(`Applied ${memberId}: seats=${seats}, programs=${programs.join(',')}`);
          return res.send();
        }
      }

      // fallback (pas d’intent) : activer le compte avec les seats, programmes à 0
      const updates = { active:"1", team_owner:"1", seats_total:String(seats), seats_used:"0" };
      PROGRAM_KEYS.forEach(k => { updates[k] = "0"; });
      await msUpdateFields(memberId, updates);
      console.log(`Applied fallback ${memberId}: seats=${seats}, programs=none`);
      return res.send();

    } catch(err) {
      console.error('ms-webhook error:', err.message);
      return res.status(500).send('Webhook handler error');
    }
  }

  return res.send();
};
