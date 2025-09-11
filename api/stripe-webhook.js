// /api/stripe-webhook.js
const fetch = require('node-fetch');
const Stripe = require('stripe');
const { kvGet, kvSetEx, unwrapKVResult } = require('./kv.js');

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* ----- Stripe (single secret) ----- */
function stripeClient(){
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key);
}
function verifyWithSingleSecret(rawBody, sig){
  const secret = process.env.STRIPE_WEBHOOK_SECRET; // secret webhook TEST (ou LIVE ensuite)
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  const s = stripeClient();
  const event = s.webhooks.constructEvent(rawBody, sig, secret);
  const env = event.livemode ? 'live' : 'test';
  return { event, env };
}

/* ----- Memberstack v2 ----- */
function msApiKey(env){
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
async function msFindMemberIdByEmail(env, email){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing MS key for env=${env}`);
  const r = await fetch(`https://admin.memberstack.com/v2/members?email=${encodeURIComponent(email)}`, {
    headers: { 'Authorization': `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(`MS v2 query ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const id = d && d.data && d.data[0] && d.data[0].id ? d.data[0].id : null;
  console.log('[MS] findByEmail', { env, email, found: !!id });
  return id;
}
async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing MS key for env=${env}`);
  console.log('[MS] PATCH customFields', { env, memberId, updates: customFields });
  const r = await fetch(`https://admin.memberstack.com/v2/members/${memberId}`, {
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  if (!r.ok) { console.error('[MS] PATCH ERROR', r.status, txt.slice(0,200)); throw new Error(`MS v2 update ${r.status}: ${txt}`); }
  console.log('[MS] PATCH OK', { status: r.status });
}

/* ----- Utils ----- */
function buildFlags(programs){
  const set = new Set((programs||[]).map(s => String(s).toLowerCase()));
  const u = {}; FIELD_IDS.forEach(id => u[id] = set.has(id) ? "1" : "0"); return u;
}
function allZero(){ const u={}; FIELD_IDS.forEach(id=>u[id]="0"); return u; }

async function getPtrByEmailOrMember(env, emailKey){
  const MIRROR = (env === 'live') ? 'test' : 'live';

  // email pointers
  if (emailKey) {
    let ptr = await kvGet(`latest-intent-email:${env}:${emailKey}`)
           || await kvGet(`latest-intent-email:${MIRROR}:${emailKey}`)
           || await kvGet(`latest-intent-email:default:${emailKey}`);
    ptr = unwrapKVResult(ptr) || ptr;
    if (ptr && ptr.intentId) return { ptr, memberId: null };
  }

  // member pointers via MS lookup
  let memberId = null;
  if (emailKey) memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
  if (memberId) {
    let ptr = await kvGet(`latest-intent:${env}:${memberId}`)
           || await kvGet(`latest-intent:${MIRROR}:${memberId}`)
           || await kvGet(`latest-intent:default:${memberId}`);
    ptr = unwrapKVResult(ptr) || ptr;
    if (ptr && ptr.intentId) return { ptr, memberId };
  }

  return { ptr: null, memberId: null };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  // ⚠️ si tu es en Next.js API Routes, ajoute en bas du fichier:
  // export const config = { api: { bodyParser: false } };

  // raw body pour signature
  let body=''; req.setEncoding('utf8'); req.on('data',c=>body+=c); await new Promise(r=>req.on('end',r));
  const sig = req.headers['stripe-signature'];

  let event, env;
  try { ({ event, env } = verifyWithSingleSecret(body, sig)); }
  catch(e){ console.error('Stripe signature error:', e.message); return res.status(400).send('Invalid signature'); }

  const type = event.type;
  console.log('Stripe webhook hit:', { type, env, livemode: event.livemode });

  const HANDLE = new Set(['checkout.session.completed','invoice.paid','customer.subscription.deleted']);
  if (!HANDLE.has(type)) return res.status(200).send();

  try{
    const obj = event.data.object;
    const emailKey = ((obj.customer_details && obj.customer_details.email) || obj.customer_email || '').trim().toLowerCase() || null;
    const stripeCustomerId = obj.customer || obj.customer_id || null;

    // idempotence: on ne short-circuite que si déjà APPLIQUÉ précédemment
    const evtKey = `processed:${env}:${event.id}`;
    if (await kvGet(evtKey)) return res.status(200).send();

    /* ===== Paiement (initial/renouvellement) ===== */
    if (type === 'checkout.session.completed' || type === 'invoice.paid'){
      const { ptr, memberId: memberFromLookup } = await getPtrByEmailOrMember(env, emailKey);

      // ❌ Skip sans marquer processed (Stripe réessaiera)
      if (!ptr || !ptr.intentId){
        console.log(`[PTR] NOT FOUND for email=${emailKey || 'n/a'} (env/mirror/default checked)`);
        return res.status(200).send();
      }

      // fetch intent (avec mini retry) + unwrap
      const intentKey = `intent:${ptr.intentId}`;
      let intent = null;
      for (let i=0;i<3;i++){
        intent = await kvGet(intentKey);
        intent = unwrapKVResult(intent) || intent;
        console.log('[INTENT] fetch', intentKey, intent ? 'HIT' : 'MISS');
        if (intent) break;
        await new Promise(r=>setTimeout(r, 250*(i+1)));
      }

      // ❌ Skip sans processed si manquant ou déjà applied
      if (!intent || intent.status === 'applied'){
        console.log('[INTENT] unusable -> skip');
        return res.status(200).send();
      }

      let memberId = memberFromLookup || intent.memberId || (emailKey ? await msFindMemberIdByEmail(env, emailKey).catch(()=>null) : null);

      // ❌ Skip sans processed si on ne résout pas le memberId (Stripe réessaie)
      if (!memberId){
        console.log('[MS] memberId not resolved -> skip');
        return res.status(200).send();
      }

      const updates = buildFlags(intent.programs);
      await msPatchMember(env, memberId, updates);

      // ✅ Succès: on marque processed et applied
      await kvSetEx(intentKey, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*3600);
      await kvSetEx(evtKey, 1, 30*24*3600);
      if (stripeCustomerId) await kvSetEx(`map:scus:${env}:${stripeCustomerId}`, { memberId }, 30*24*3600);

      console.log(`Stripe applied (${env}) member=${memberId}`);
      return res.status(200).send();
    }

    /* ===== Annulation -> tout à 0 (on peut marquer processed ici) ===== */
    if (type === 'customer.subscription.deleted'){
      let memberId = null;
      if (stripeCustomerId){
        const m = await kvGet(`map:scus:${env}:${stripeCustomerId}`);
        const mv = unwrapKVResult(m) || m;
        memberId = mv && mv.memberId || null;
        console.log('[MAP] scus -> member', { env, stripeCustomerId, memberId: !!memberId });
      }
      if (!memberId && emailKey) memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
      if (!memberId){ return res.status(200).send(); }

      await msPatchMember(env, memberId, allZero());
      await kvSetEx(evtKey, 1, 30*24*3600);
      console.log(`Subscription deleted -> reset flags (member=${memberId})`);
      return res.status(200).send();
    }

    // autres types non gérés
    return res.status(200).send();

  }catch(err){
    console.error('Stripe webhook error:', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    return res.status(500).send('Handler error');
  }
};

// ⚠️ Si tu utilises Next.js API Routes : décommente cette ligne pour conserver le raw body
// export const config = { api: { bodyParser: false } };
