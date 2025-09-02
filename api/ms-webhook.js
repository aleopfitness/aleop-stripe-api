// /api/ms-webhook.js
const { Webhook } = require('svix');
const fetch = require('node-fetch');

/* ===== KV ===== */
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

/* ===== Memberstack Admin ===== */
async function msUpdateFields(env, memberId, updates){
  const apiKey =
    env === 'live' ? process.env.MEMBERSTACK_API_KEY_LIVE :
    env === 'test' ? process.env.MEMBERSTACK_API_KEY_TEST :
    process.env.MEMBERSTACK_API_KEY;
  if(!apiKey) throw new Error(`Missing Memberstack API key for env=${env}`);

  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method:'PATCH',
    headers:{ 'X-API-KEY': apiKey, 'Content-Type':'application/json' },
    body: JSON.stringify({ customFields: updates })
  });
  if(!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

/* ===== Mapping programmes ===== */
// slugs "kebab" qu’on reçoit du front via intent.programs
const KEBA B_FIELDS = ['athletyx','booty-shape','upper-shape','power-flow'];
// correspondances underscore (si jamais)
const SLUG_TO_UNDERSCORE = {
  'athletyx':    'Athletyx',
  'booty-shape': 'Booty_Shape',
  'upper-shape': 'Upper_Shape',
  'power-flow':  'Power_Flow'
};

/* ===== Utils ===== */
function get(o, path){ return path.split('.').reduce((x,k)=>x&&x[k]!==undefined?x[k]:undefined,o); }
function findByKeys(obj, keys){
  let out; (function walk(o){ if(out) return; if(o && typeof o==='object'){ for(const [k,v] of Object.entries(o)){ if(out) break;
    if(keys.includes(k) && typeof v==='string' && v){ out=v; break; }
    if(v && typeof v==='object') walk(v);
  }}})(obj); return out;
}
function findByPattern(obj, re){
  let out; (function walk(o){ if(out) return; if(o && typeof o==='object'){ for(const v of Object.values(o)){ if(out) break;
    if(typeof v==='string' && re.test(v)){ out=v; break; }
    if(v && typeof v==='object') walk(v);
  }}})(obj); return out;
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

/* ===== Handler ===== */
module.exports = async (req, res) => {
  // lire le body brut
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

    // 1) On cherche l’intent d’abord par memberId (idempotent), sinon par email
    let ptr = memberId ? await kvGet(`latest-intent:${memberId}`) : null;
    if(!ptr && emailKey) ptr = await kvGet(`latest-intent-email:${emailKey}`);

    if(ptr?.intentId){
      const intent = await kvGet(`intent:${ptr.intentId}`);

      // garde d'env : si l’intent est taggé et ne correspond pas à l’env du webhook, on skippe
      if (intent?.env && intent.env !== env) {
        console.log(`ENV mismatch: intent=${intent.env} webhook=${env} member=${memberId||'n/a'} email=${emailKey||'n/a'} → skip`);
        return res.send();
      }

      if(intent && intent.status !== 'applied'){
        const selected = new Set((intent.programs || []).map(s=>String(s).toLowerCase()));

        // updates sur les 2 familles de clés : kebab (confirmé) + underscore (au cas où)
        const updates = {};
        // kebab
        KEBA B_FIELDS.forEach(k => { updates[k] = selected.has(k) ? "1" : "0"; });
        // underscore
        Object.entries(SLUG_TO_UNDERSCORE).forEach(([slug, unders]) => {
          updates[unders] = selected.has(slug) ? "1" : "0";
        });

        await msUpdateFields(env, (memberId || intent.memberId), updates);

        try {
          await kvSetEx(`intent:${intent.intentId}`, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*60*60);
        } catch(e){ console.warn('KV set failed (non-blocking):', e.message); }

        console.log(`Applied (${env}) ${(memberId||intent.memberId)}: updates=${JSON.stringify(updates)} via ${ptr.intentId}`);
        return res.send();
      }
    }

    // 2) Pas d’intent → ne rien écraser; log clair
    console.log(`No intent found for member=${memberId||'n/a'} email=${emailKey||'n/a'} (env=${env}) → skip (no-op)`);
    return res.send();

  } catch (err) {
    console.error('ms-webhook error:', err.message);
    return res.status(500).send('Webhook handler error');
  }
};
