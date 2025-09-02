// /api/ms-webhook.js
// Webhook Memberstack (Svix) robuste : multi-env (test/live), fallback par email,
// et détection automatique des bons noms de custom fields avant PATCH.

const { Webhook } = require('svix');
const fetch = require('node-fetch');

/* ===== KV (Vercel KV / Upstash) ===== */
function kvBase(){ return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken(){ return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvHeaders(){ const t = kvToken(); if(!t) throw new Error('KV token missing'); return { Authorization:`Bearer ${t}` }; }
async function kvJson(res){
  const text = await res.text();
  if(!res.ok) throw new Error(`KV ${res.status}: ${text}`);
  try { return JSON.parse(text); } catch { return { result: text }; }
}
async function kvGet(key){
  const res = await fetch(`${kvBase()}/get/${encodeURIComponent(key)}`, { headers: kvHeaders() });
  const d = await kvJson(res);
  return d?.result ? JSON.parse(d.result) : null;
}
async function kvSetEx(key, value, ttl){
  const url = `${kvBase()}/set/${encodeURIComponent(key)}?ex=${ttl}`;
  const res = await fetch(url, {
    method:'POST',
    headers:{ ...kvHeaders(), 'Content-Type':'application/json' },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
  await kvJson(res);
}

/* ===== Memberstack Admin helpers ===== */
function msApiKey(env){
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : env === 'test'
    ? process.env.MEMBERSTACK_API_KEY_TEST
    : process.env.MEMBERSTACK_API_KEY;
}
async function msGetMember(env, memberId){
  const key = msApiKey(env);
  if(!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    headers: { 'X-API-KEY': key }
  });
  if(!r.ok) throw new Error(`Memberstack get ${r.status}: ${await r.text()}`);
  return r.json();
}
async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env);
  if(!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method:'PATCH',
    headers:{ 'X-API-KEY': key, 'Content-Type':'application/json' },
    body: JSON.stringify({ customFields })
  });
  if(!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

/* ===== Mapping programmes ===== */
const SLUGS = ['athletyx','booty-shape','upper-shape','power-flow'];
const CANDIDATE_FAMILIES = [
  // 1) TES CHAMPS UNDERSCORE (premier choix)
  { type:'underscore', map:{
    'athletyx': 'Athletyx',
    'booty-shape': 'Booty_Shape',
    'upper-shape': 'Upper_Shape',
    'power-flow': 'Power_Flow'
  }},
  // 2) kebab-case (au cas où le projet utilise les slugs)
  { type:'kebab', map:{
    'athletyx': 'athletyx',
    'booty-shape': 'booty-shape',
    'upper-shape': 'upper-shape',
    'power-flow': 'power-flow'
  }},
  // 3) underscore lowercase (parfois configuré comme ça)
  { type:'underscore-lc', map:{
    'athletyx': 'athletyx',
    'booty-shape': 'booty_shape',
    'upper-shape': 'upper_shape',
    'power-flow': 'power_flow'
  }}
];

function get(o, path){ return path.split('.').reduce((x,k)=>x&&x[k]!==undefined?x[k]:undefined,o); }
function findByKeys(obj, keys){
  let out; (function walk(o){ if(out) return; if(o && typeof o==='object'){
    for(const [k,v] of Object.entries(o)){ if(out) break;
      if(keys.includes(k) && typeof v==='string' && v){ out=v; break; }
      if(v && typeof v==='object') walk(v);
    }
  }})(obj); return out;
}
function findByPattern(obj, re){
  let out; (function walk(o){ if(out) return; if(o && typeof o==='object'){
    for(const v of Object.values(o)){ if(out) break;
      if(typeof v==='string' && re.test(v)){ out=v; break; }
      if(v && typeof v==='object') walk(v);
    }
  }})(obj); return out;
}

/* ===== Signature Svix multi-env ===== */
function verifyWithEitherSecret(raw, headers){
  const id=headers['svix-id'], ts=headers['svix-timestamp'], sig=headers['svix-signature'];
  if(!id || !ts || !sig) throw new Error('Missing Svix headers');
  const tryVerify = (secret)=>{ const wh=new Webhook(secret); return wh.verify(raw,{ 'svix-id':id,'svix-timestamp':ts,'svix-signature':sig }); };
  const live=process.env.MS_WEBHOOK_SECRET_LIVE, test=process.env.MS_WEBHOOK_SECRET_TEST, single=process.env.MS_WEBHOOK_SECRET;
  if(live){ try{ return { env:'live', event: tryVerify(live) }; }catch{} }
  if(test){ try{ return { env:'test', event: tryVerify(test) }; }catch{} }
  if(single){ try{ return { env:'live', event: tryVerify(single) }; }catch{} }
  throw new Error('Invalid signature for provided secrets');
}

/* ===== Build updates en se calant sur les clés existantes ===== */
function computeUpdatesForFamily(selectedSlugs, familyMap, existingKeysSet){
  const updates = {};
  let hit = 0;
  for (const slug of SLUGS) {
    const key = familyMap[slug];
    if (existingKeysSet.has(key)) {
      updates[key] = selectedSlugs.has(slug) ? "1" : "0";
      hit++;
    }
  }
  return { updates, hit };
}

/* ===== Handler ===== */
module.exports = async (req, res) => {
  // lire le body brut (requis pour la vérif Svix)
  let body=''; req.setEncoding('utf8'); req.on('data',c=>body+=c); await new Promise(r=>req.on('end',r));

  let env, evt;
  try { ({ env, event: evt } = verifyWithEitherSecret(body, req.headers)); }
  catch(e){ console.error('Signature error:', e.message); return res.status(400).send('Invalid signature'); }

  const type = evt?.type || evt?.event;
  const payload = evt?.data || evt?.payload || {};
  try { console.log('MS webhook hit:', { env, type }); } catch{}

  if(type !== 'member.plan.added') return res.send();

  try {
    // IDs + email
    let memberId =
      get(payload,'member.id') || payload.memberId ||
      findByKeys(payload,['memberId','member_id']) ||
      findByPattern(payload,/^mem_[A-Za-z0-9]+$/);
    const emailRaw =
      get(payload,'member.email') || payload.email ||
      findByKeys(payload,['email','member_email']);
    const emailKey = (emailRaw || '').trim().toLowerCase();

    if(!memberId && !emailKey){
      console.log('Missing IDs & email', { env, preview: JSON.stringify(payload).slice(0,900) });
      return res.send();
    }

    // 1) Récupère l'intent par memberId sinon par email
    let ptr = memberId ? await kvGet(`latest-intent:${memberId}`) : null;
    if(!ptr && emailKey) ptr = await kvGet(`latest-intent-email:${emailKey}`);

    if(!ptr?.intentId){
      console.log(`No intent found for member=${memberId||'n/a'} email=${emailKey||'n/a'} (env=${env}) → skip`);
      return res.send();
    }

    const intent = await kvGet(`intent:${ptr.intentId}`);
    if(!intent || intent.status === 'applied'){
      console.log(`Intent not usable (missing or already applied): ${ptr.intentId}`);
      return res.send();
    }
    if (intent.env && intent.env !== env) {
      console.log(`ENV mismatch: intent=${intent.env} webhook=${env} member=${memberId||'n/a'} email=${emailKey||'n/a'} → skip`);
      return res.send();
    }

    // 2) Lire le membre pour connaître les VRAIS noms de clés
    const memberData = await msGetMember(env, memberId || intent.memberId);
    const existing = Object.keys(memberData?.customFields || {});
    const existingSet = new Set(existing);

    // 3) Choisir la famille la plus pertinente
    const selected = new Set((intent.programs || []).map(s=>String(s).toLowerCase()));
    let best = { updates:{}, hit: 0, type: null };
    for (const fam of CANDIDATE_FAMILIES) {
      const { updates, hit } = computeUpdatesForFamily(selected, fam.map, existingSet);
      if (hit > best.hit) best = { updates, hit, type: fam.type };
    }

    if (best.hit === 0) {
      console.log(`No matching custom field keys on member (${env}). Existing: ${existing.join(', ')}`);
      return res.send(); // on ne force rien si aucune clé ne matche
    }

    // 4) PATCH seulement les clés existantes
    await msPatchMember(env, memberId || intent.memberId, best.updates);

    // 5) Marquer l’intent applied (non-bloquant)
    try {
      await kvSetEx(`intent:${intent.intentId}`, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60);
    } catch(e){ console.warn('KV set failed (non-blocking):', e.message); }

    console.log(`Applied (${env}) ${(memberId||intent.memberId)} using [${best.type}] -> ${JSON.stringify(best.updates)}`);
    return res.send();

  } catch (err) {
    console.error('ms-webhook error:', err.message);
    return res.status(500).send('Webhook handler error');
  }
};
