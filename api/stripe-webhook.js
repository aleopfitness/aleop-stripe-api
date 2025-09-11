// /api/stripe-webhook.js
const fetch = require('node-fetch');
const Stripe = require('stripe');
const { kvGet, kvSetEx } = require('./kv.js');

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* Stripe (single secret) */
function stripeClient(){
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY missing');
  return new Stripe(key);
}
function verifyWithSingleSecret(rawBody, sig){
  const secret = process.env.STRIPE_WEBHOOK_SECRET; // TEST secret
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET missing');
  const s = stripeClient();
  const event = s.webhooks.constructEvent(rawBody, sig, secret);
  const env = event.livemode ? 'live' : 'test';
  return { event, env };
}

/* Memberstack v2 */
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

function buildFlags(programs){
  const set = new Set((programs||[]).map(s => String(s).toLowerCase()));
  const u = {}; FIELD_IDS.forEach(id => u[id] = set.has(id) ? "1" : "0"); return u;
}
function allZero(){ const u={}; FIELD_IDS.forEach(id=>u[id]="0"); return u; }

/* helper : log les clés essayées */
async function tryGet(label, key){
  const val = await kvGet(key);
  console.log('[PTR]', label, key, val && val.intentId ? `HIT(${val.intentId})` : 'MISS');
  return val;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

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

    const evtKey = `processed:${env}:${event.id}`;
    if (await kvGet(evtKey)) return res.status(200).send();

    /* ===== Paiement (initial/renouvellement) ===== */
    if (type === 'checkout.session.completed' || type === 'invoice.paid'){
      let ptr = null;
      const MIRROR = (env === 'live') ? 'test' : 'live';

      if (emailKey){
        ptr = await tryGet('email@env',     `latest-intent-email:${env}:${emailKey}`) ||
              await tryGet('email@mirror',  `latest-intent-email:${MIRROR}:${emailKey}`) ||
              await tryGet('email@default', `latest-intent-email:default:${emailKey}`);
      }

      let memberId = null;
      if (!ptr && emailKey){
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
        if (memberId){
          ptr = await tryGet('member@env',     `latest-intent:${env}:${memberId}`) ||
                await tryGet('member@mirror',  `latest-intent:${MIRROR}:${memberId}`) ||
                await tryGet('member@default', `latest-intent:default:${memberId}`);
        }
      }

      if (!ptr || !ptr.intentId){
        console.log('[PTR] RESULT: NOT FOUND -> skip');
        await kvSetEx(evtKey, 1, 30*24*3600);
        return res.status(200).send();
      }

      const intentKey = `intent:${ptr.intentId}`;
      let intent = null;
      for (let i=0;i<3;i++){
        intent = await kvGet(intentKey);
        console.log('[INTENT] fetch', intentKey, intent ? 'HIT' : 'MISS');
        if (intent) break;
        await new Promise(r=>setTimeout(r, 250*(i+1)));
      }
      if (!intent || intent.status === 'applied'){
        console.log('[INTENT] unusable -> skip');
        await kvSetEx(evtKey, 1, 30*24*3600);
        return res.status(200).send();
      }

      memberId = memberId || intent.memberId || (emailKey ? await msFindMemberIdByEmail(env, emailKey).catch(()=>null) : null);
      if (!memberId){
        console.log('[MS] memberId not resolved -> skip');
        await kvSetEx(evtKey, 1, 30*24*3600);
        return res.status(200).send();
      }

      const updates = buildFlags(intent.programs);
      await msPatchMember(env, memberId, updates);

      await kvSetEx(intentKey, { ...intent, status:'applied', appliedAt: Date.now() }, 7*24*3600);
      await kvSetEx(evtKey, 1, 30*24*3600);
      if (stripeCustomerId) await kvSetEx(`map:scus:${env}:${stripeCustomerId}`, { memberId }, 30*24*3600);

      console.log(`Stripe applied (${env}) member=${memberId}`);
      return res.status(200).send();
    }

    /* ===== Annulation -> tout à 0 ===== */
    if (type === 'customer.subscription.deleted'){
      let memberId = null;
      if (stripeCustomerId){
        const m = await kvGet(`map:scus:${env}:${stripeCustomerId}`);
        memberId = m && m.memberId || null;
        console.log('[MAP] scus -> member', { env, stripeCustomerId, memberId: !!memberId });
      }
      if (!memberId && emailKey) memberId = await msFindMemberIdByEmail(env, emailKey).catch(()=>null);
      if (!memberId){ await kvSetEx(evtKey, 1, 30*24*3600); return res.status(200).send(); }

      await msPatchMember(env, memberId, allZero());
      await kvSetEx(evtKey, 1, 30*24*3600);
      console.log(`Subscription deleted -> reset flags (member=${memberId})`);
      return res.status(200).send();
    }

    await kvSetEx(evtKey, 1, 30*24*3600);
    return res.status(200).send();

  }catch(err){
    console.error('Stripe webhook error:', err.message);
    return res.status(500).send('Handler error');
  }
};
