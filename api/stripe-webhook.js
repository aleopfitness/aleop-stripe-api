/**
 * /api/stripe-webhook.js
 * Stripe (test/live) → retrouve l'intent en KV → met à jour Memberstack customFields
 * - Compatible avec tes pointeurs { intentId, env, t } écrits par TON intent.js
 * - KV: utilise kv.js (Vercel KV) avec logs
 * - Test mode: ?test=1&key=XXX pour debug kvGet isolé
 * - Memberstack: header 'X-API-KEY' + URLs SANS '/v2'
 * - Raw body Stripe (signature)
 *
 * ⚠️ Si tu es sur Next.js (pages/api), ajoute en bas:
 *    export const config = { api: { bodyParser: false } };
 */

const Stripe = require('stripe');
const { kvGet, kvSetEx: kvSet } = require('./kv.js');  // Import aligné

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* --- SECRETS --- */
const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

/* --- Utils --- */
function normalizeEmail(s){ return (s || '').trim().toLowerCase(); }

function msApiKey(env){
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
function msHeaders(key){
  return { 'X-API-KEY': key, 'Content-Type':'application/json' };
}

function buildFlags(programs, active=true){
  const set = new Set((programs||[]).map(s => String(s).toLowerCase()));
  const out = {};
  for (const f of FIELD_IDS) out[f] = active && set.has(f) ? '1' : '0';
  return out;
}

/* --- Stripe raw body --- */
async function readRawBody(req){
  return new Promise((resolve, reject) => {
    try{
      const chunks = [];
      req.on('data', c => chunks.push(Buffer.from(c)));
      req.on('end',  () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    }catch(err){ reject(err); }
  });
}

/* --- Memberstack Admin REST --- */
async function msFindMemberIdByEmail(env, email){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${encodeURIComponent(email)}`;
  console.log('[MS] findByEmail', { env, email, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok){
    if (r.status === 404) return null;
    throw new Error(`MS query ${r.status}: ${txt}`);
  }
  const d = JSON.parse(txt || '{}');
  const id = d?.data?.[0]?.id ?? d?.id ?? null;
  return id || null;
}

async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] PATCH', { env, memberId, keyPrefix: String(key).slice(0,6), fields: customFields });
  const r = await fetch(url, {
    method: 'PATCH',
    headers: msHeaders(key),
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  if (!r.ok){
    console.error('[MS] PATCH ERROR', r.status, txt.substring(0,300));
    throw new Error(`MS update ${r.status}: ${txt}`);
  }
  console.log('[MS] PATCH OK', { status: r.status });
}

/* --- Test Mode (debug KV sans Stripe) --- */
async function testKvGet(req) {
  const url = new URL(req.url, 'http://x');
  const testKey = url.searchParams.get('key');
  if (!testKey) return { ok: false, error: 'Missing ?key=XXX' };
  console.log('[TEST] Starting KV test for key:', testKey);
  const raw = await kvGet(testKey);
  console.log('[TEST] Raw kvGet result:', raw, '(type:', typeof raw, ')');
  let parsed = null;
  if (raw) {
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e) { console.error('[TEST] Parse error:', e); }
  }
  console.log('[TEST] Parsed:', parsed);
  return { ok: true, raw, parsed };
}

/* --- Handler --- */
module.exports = async (req, res) => {
  // Test mode d'abord (prioritaire, pas besoin raw body)
  const url = new URL(req.url, 'http://x');
  if (url.searchParams.get('test') === '1') {
    const result = await testKvGet(req);
    return res.status(result.ok ? 200 : 400).json(result);
  }

  // CORS
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type, Stripe-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).send('Method Not Allowed');

  if (!STRIPE_SECRET_KEY)     return res.status(500).send('STRIPE_SECRET_KEY missing');
  if (!STRIPE_WEBHOOK_SECRET) return res.status(500).send('STRIPE_WEBHOOK_SECRET missing');

  let raw;
  try{ raw = await readRawBody(req); }
  catch(e){ console.error('readRawBody error', e); return res.status(400).send('Invalid body'); }

  const sig = req.headers['stripe-signature'] || '';
  let event, env;
  try{
    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    event = stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET);
    env = event.livemode ? 'live' : 'test';
  }catch(e){
    console.error('Stripe constructEvent error:', e && e.message ? e.message : e);
    return res.status(400).send('Webhook signature error');
  }

  const type = event.type;
  console.log('=== WEBHOOK START ===', { type, env, livemode: event.livemode, eventId: event.id });

  const ACTIVATE   = new Set(['checkout.session.completed','invoice.paid']);
  const DEACTIVATE = new Set(['customer.subscription.deleted']);
  const MAYBE      = new Set(['customer.subscription.updated']); // optionnel

  try{
    const obj = event.data.object;
    const emailKey = normalizeEmail(
      obj?.customer_details?.email || obj?.customer_email || ''
    ) || null;
    const stripeCustomerId = obj?.customer || obj?.customer_id || null;

    console.log('[WEBHOOK] Extracted data:', { emailKey, stripeCustomerId, objType: obj.object });

    const evtKey = `processed:${env}:${event.id}`;
    if (await kvGet(evtKey)) {
      console.log('[WEBHOOK] Already processed, skip');
      return res.status(200).send();
    }

    /* ========== ACTIVATE ========== */
    if (ACTIVATE.has(type)){
      console.log('[ACTIVATE] Starting activation flow');
      // Retrouver le pointeur PAR EMAIL (conforme à ton intent.js) – utilise kvGet importé
      let ptr = null;
      let triedPtrKeys = [];
      if (emailKey){
        const keysToTry = [
          `latest-intent-email:${env}:${emailKey}`,
          `latest-intent-email:${env==='live'?'test':'live'}:${emailKey}`,
          `latest-intent-email:default:${emailKey}`
        ];
        console.log('[PTR] Trying keys for email:', emailKey, keysToTry);
        for (let k of keysToTry) {
          triedPtrKeys.push(k);
          const rawPtr = await kvGet(k);
          console.log('[PTR] Raw from kvGet for', k, ':', rawPtr, '(type:', typeof rawPtr, ')');  // Log raw
          if (rawPtr) {
            try { ptr = typeof rawPtr === 'string' ? JSON.parse(rawPtr) : rawPtr; } catch(e) { console.error('[PTR] Parse error:', e); }
            if (ptr) break;
          }
        }
      }

      if (!ptr){
        console.log('[PTR] NOT FOUND after tries:', triedPtrKeys);
        // on ACK pour que Stripe retente plus tard
        return res.status(200).send();
      }
      console.log('[PTR] Found:', ptr);

      // ptr.intentId → clé KV principale intent:${intentId}
      const intentKey = `intent:${ptr.intentId}`;
      let intent = null;
      console.log('[INTENT] Fetching from', intentKey);
      for (let i=0; i<3; i++){
        const raw = await kvGet(intentKey);
        console.log(`[INTENT] Raw from kvGet retry ${i+1}:`, raw, '(type:', typeof raw, ')');  // Log raw détaillé
        if (raw){ 
          try{ intent = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch(e) { console.error('[INTENT] Parse error:', e); intent = raw; }
        }
        if (intent) break;
        console.log(`[INTENT] Waiting 200ms before retry ${i+1}`);
        await new Promise(r=>setTimeout(r, 200*(i+1)));
      }
      if (!intent || intent.status === 'applied'){
        console.log('[INTENT] unusable (null or applied):', !!intent, intent?.status);
        await kvSet(evtKey, 1, 3600);
        return res.status(200).send();
      }
      console.log('[INTENT] Loaded:', { programs: intent.programs, seats: intent.seats });

      // Résoudre memberId: on privilégie l’intent (ton front le passait)
      let memberId = intent.memberId;
      console.log('[MS] Initial memberId from intent:', memberId);
      if (!memberId && emailKey){
        console.log('[MS] Resolving memberId via API for', emailKey);
        memberId = await msFindMemberIdByEmail(env, emailKey).catch(e => { console.error('[MS] Find error:', e); return null; });
        console.log('[MS] Resolved memberId:', memberId);
      }
      if (!memberId){
        console.log('[MS] memberId not resolved -> skip');
        return res.status(200).send();
      }

      const updates = buildFlags(intent.programs, true);
      console.log('[MS] Updating fields:', updates);
      await msPatchMember(env, memberId, updates);

      // NOUVEAU : Si team plan (seats >1), set isPrincipal='1' pour sync invites (merge avec updates)
      if (intent.seats > 1) {
        const teamUpdates = { ...updates, isPrincipal: '1' };
        console.log('[MS] Setting isPrincipal for team principal');
        await msPatchMember(env, memberId, teamUpdates);
      }

      // Marque appliqué + map stripe customer -> member
      await kvSet(intentKey, { ...intent, status:'applied', appliedAt: Date.now() }, 60*60*24*30);
      await kvSet(evtKey, 1, 30*24*3600);
      if (stripeCustomerId){
        await kvSet(`map:scus:${env}:${stripeCustomerId}`, { memberId, email: emailKey || intent.email || null }, 30*24*3600);
      }
      console.log(`[SUCCESS] Applied -> member=${memberId}, programs=${intent.programs.join(',')}`);
      console.log('=== WEBHOOK END (SUCCESS) ===');
      return res.status(200).send();
    }

    // ... (garde DEACTIVATE, MAYBE, OTHER, catch sans change)
  }catch(err){
    console.error('=== WEBHOOK ERROR ===', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    console.log('=== WEBHOOK END (ERROR) ===');
    return res.status(500).send('Handler error');
  }
};
