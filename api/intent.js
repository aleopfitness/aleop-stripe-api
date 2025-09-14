/**
 * /api/intent.js
 * Crée un intent d'achat et enregistre des pointeurs dans Upstash/Vercel KV.
 *
 * Input (POST JSON):
 *   { env, memberId, email, programs[], seats, priceId, createdAt }
 *
 * Sortie:
 *   200 { ok:true, intentId }   // intentId sans le préfixe "intent:"
 */

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* --- Upstash / Vercel KV : auto-detect des variables --- */
const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.KV_URL ||
  process.env.REDIS_URL;

const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.KV_REST_API_READ_ONLY_TOKEN;

function normalizeEmail(s){ return (s || '').trim().toLowerCase(); }
function uniq(a){ return Array.from(new Set(a || [])); }
function clampPrograms(list){
  const ok = new Set(FIELD_IDS);
  return uniq((list||[]).map(x=>String(x||'').trim().toLowerCase()).filter(x=>ok.has(x)));
}
function isTestEnv(v){ return String(v).toLowerCase() === 'test'; }

async function upstash(cmd, args){
  if (!UPSTASH_URL || !UPSTASH_TOKEN){
    const miss = [
      !UPSTASH_URL ? 'UPSTASH_REDIS_REST_URL/KV_REST_API_URL/KV_URL/REDIS_URL' : null,
      !UPSTASH_TOKEN ? 'UPSTASH_REDIS_REST_TOKEN/KV_REST_API_TOKEN' : null
    ].filter(Boolean).join(' & ');
    throw new Error('Upstash missing config: ' + miss);
  }
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type':'application/json' },
    body: JSON.stringify([cmd, ...args])
  });
  const data = await r.json().catch(()=>null);
  if (!r.ok) throw new Error(`Upstash ${cmd} ${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function kvSet(key, val, ttlSec){
  const v = typeof val === 'string' ? val : JSON.stringify(val);
  return ttlSec ? upstash('SET', [key, v, 'EX', ttlSec]) : upstash('SET', [key, v]);
}
async function kvGet(key){
  const r = await upstash('GET', [key]);
  return (r && typeof r.result === 'string') ? r.result : null;
}

function newIntentId(){
  const ts  = Date.now().toString(36);
  const rnd = Math.floor(Math.random()*36**6).toString(36).padStart(6,'0');
  return `i_${ts}_${rnd}`;
}

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  try{
    const body = (typeof req.body === 'object' && req.body) ? req.body : JSON.parse(req.body||'{}');
    let { env, memberId, email, programs = [], seats, priceId, createdAt } = body || {};

    env = isTestEnv(env) ? 'test' : 'live';
    if (!memberId || typeof memberId !== 'string') return res.status(400).json({ ok:false, error:'memberId required' });
    email = normalizeEmail(email);
    if (!email) return res.status(400).json({ ok:false, error:'email required' });

    programs = clampPrograms(programs);
    if (!programs.length) return res.status(400).json({ ok:false, error:'programs required (non-empty & valid IDs)' });
    if (!priceId || typeof priceId !== 'string') return res.status(400).json({ ok:false, error:'priceId required' });

    const intentId  = newIntentId();
    const intentKey = `intent:${intentId}`;

    const intent = {
      id: intentKey,               // clé KV
      env,
      memberId,
      email,
      programs,
      seats: Number.isFinite(+seats) ? Math.max(0, parseInt(seats,10)) : programs.length,
      priceId,
      createdAt: createdAt || new Date().toISOString(),
      status: 'pending'
    };

    // Stockage principal (TTL 30 jours)
    await kvSet(intentKey, intent, 60*60*24*30);

    // Pointeurs (env + miroirs + défauts) → JSON { intentId, env, t }
    const ptr = { intentId, env, t: Date.now() };
    const mirror = env === 'live' ? 'test' : 'live';

    await kvSet(`latest-intent:${env}:${memberId}`, ptr, 60*60*24*30);
    await kvSet(`latest-intent-email:${env}:${email}`, ptr, 60*60*24*30);

    await kvSet(`latest-intent:${mirror}:${memberId}`, ptr, 60*60*24*30);
    await kvSet(`latest-intent-email:${mirror}:${email}`, ptr, 60*60*24*30);

    await kvSet(`latest-intent:default:${memberId}`, ptr, 60*60*24*30);
    await kvSet(`latest-intent-email:default:${email}`, ptr, 60*60*24*30);

    // read-after-write anti latence
    for (let i=0;i<3;i++){
      const chk = await kvGet(intentKey);
      if (chk) break;
      await new Promise(r=>setTimeout(r, 120*(i+1)));
    }

    console.log('[INTENT] created', { env, memberId, email, programs, priceId, intentId });
    return res.status(200).json({ ok:true, intentId });
  }catch(e){
    console.error('[INTENT] error:', e && e.message ? e.message : e);
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
