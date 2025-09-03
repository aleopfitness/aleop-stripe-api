const { Webhook } = require('svix');
const fetch = require('node-fetch');

/* KV helpers */
function kvBase(){ return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken(){ return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvHeaders(){ const t = kvToken(); if(!t) throw new Error('KV token missing'); return { Authorization:`Bearer ${t}` }; }
async function kvJson(res){ const tx = await res.text(); if(!res.ok) throw new Error(`KV ${res.status}: ${tx}`); try{ return JSON.parse(tx);}catch{ return {result:tx}; } }
async function kvGet(key){ const r = await fetch(`${kvBase()}/get/${encodeURIComponent(key)}`, { headers: kvHeaders() }); const d = await kvJson(r); return d?.result ? JSON.parse(d.result) : null; }
async function kvSetEx(key,val,ttl){ const r = await fetch(`${kvBase()}/set/${encodeURIComponent(key)}?ex=${ttl}`, { method:'POST', headers:{...kvHeaders(),'Content-Type':'application/json'}, body: JSON.stringify({ value: JSON.stringify(val) }) }); await kvJson(r); }

/* Memberstack Admin */
function msApiKey(env){ const base = process.env.MEMBERSTACK_API_KEY || ''; if(env==='live') return process.env.MEMBERSTACK_API_KEY_LIVE || base; if(env==='test') return process.env.MEMBERSTACK_API_KEY_TEST || base; return base; }
async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env); if(!key) throw new Error(`Missing Memberstack API key (env=${env})`);
  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method:'PATCH',
    headers:{ 'X-API-KEY': key, 'Content-Type':'application/json' },
    body: JSON.stringify({ customFields })
  });
  if(!r.ok){ const txt = await r.text().catch(()=> ''); console.error('Memberstack PATCH failed', { env, status:r.status, body:txt, sent: customFields }); throw new Error(`Memberstack update ${r.status}`); }
}

/* Slugs UI -> IDs EXACTS */
const SLUG_TO_ID = {
  'athletyx':'athletyx', 'booty-shape':'booty', 'upper-shape':'upper', 'power-flow':'flow',
  'fight':'fight', 'cycle':'cycle', 'force':'force', 'cardio':'cardio', 'mobility':'mobility'
};
const FIELD_IDS = Object.values(SLUG_TO_ID);

/* Utils */
function get(o,p){ return p.split('.').reduce((x,k)=>x&&x[k]!==undefined?x[k]:undefined,o); }
function findByKeys(obj, keys){ let out; (function walk(o){ if(out) return; if(o&&typeof o==='object'){ for(const [k,v] of Object.entries(o)){ if(out) break; if(keys.includes(k)&&typeof v==='string'&&v){ out=v; break;} if(v&&typeof v==='object') walk(v);} } })(obj); return out; }

/* Svix verify (live/test) */
function verifyWithEitherSecret(raw, headers){
  const id=headers['svix-id'], ts=headers['svix-timestamp'], sig=headers['svix-signature'];
  if(!id||!ts||!sig) throw new Error('Missing Svix headers');
  const tryV = (s)=>{ const wh=new Webhook(s); return wh.verify(raw,{ 'svix-id':id,'svix-timestamp':ts,'svix-signature':sig }); };
  const live=process.env.MS_WEBHOOK_SECRET_LIVE, test=process.env.MS_WEBHOOK_SECRET_TEST, single=process.env.MS_WEBHOOK_SECRET;
  if(live){ try{ return { env:'live', event: tryV(live) }; }catch{} }
  if(test){ try{ return { env:'test', event: tryV(test) }; }catch{} }
  if(single){ try{ return { env:'live', event: tryV(single) }; }catch{} }
  throw new Error('Invalid signature for provided secrets');
}

/* Handler */
module.exports = async (req, res) => {
  let body=''; req.setEncoding('utf8'); req.on('data',c=>body+=c); await new Promise(r=>req.on('end',r));

  let env, evt;
  try { ({ env, event: evt } = verifyWithEitherSecret(body, req.headers)); }
  catch(e){ console.error('Signature error:', e.message); return res.status(400).send('Invalid signature'); }

  const type = evt?.type || evt?.event;
  const payload = evt?.data || evt?.payload || {};
  console.log('MS webhook hit:', { env, type });
  if (type !== 'member.plan.added') return res.send();

  try {
    const memberId = get(payload,'member.id') || findByKeys(payload,['memberId','member_id']);
    const emailKey = (get(payload,'member.email') || findByKeys(payload,['email','member_email']) || '').trim().toLowerCase();
    if(!memberId && !emailKey){ console.log('Missing IDs & email → skip'); return res.send(); }

    // retrouver l’intent
    let ptr = memberId ? await kvGet(`latest-intent:${memberId}`) : null;
    if(!ptr && emailKey) ptr = await kvGet(`latest-intent-email:${emailKey}`);
    if(!ptr?.intentId){ console.log(`No intent for member=${memberId||'n/a'} email=${emailKey||'n/a'} → skip`); return res.send(); }

    const intent = await kvGet(`intent:${ptr.intentId}`);
    if(!intent || intent.status === 'applied'){ console.log('Intent unusable → skip'); return res.send(); }
    if (intent.env && intent.env !== env) { console.log(`ENV mismatch intent=${intent.env} webhook=${env} → skip`); return res.send(); }

    // construire updates : tout à "0", puis "1" pour les slugs choisis
    const selected = new Set((intent.programs || []).map(s => String(s).toLowerCase()));
    const updates = {}; FIELD_IDS.forEach(id => { updates[id] = "0"; });
    selected.forEach(slug => { const id = SLUG_TO_ID[slug]; if (id) updates[id] = "1"; });

    console.log('About to PATCH Memberstack', { env, memberId: memberId || intent.memberId, updates });
    await msPatchMember(env, memberId || intent.memberId, updates);

    try { await kvSetEx(`intent:${intent.intentId}`, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60); } catch(e){ console.warn('KV set failed:', e.message); }
    console.log(`Applied (${env}) ${memberId||intent.memberId}: ${JSON.stringify(updates)}`);
    return res.send();
  } catch (err) {
    console.error('ms-webhook error:', err.message);
    return res.status(500).send('Webhook handler error');
  }
};
