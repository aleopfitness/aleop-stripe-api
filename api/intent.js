// /api/intent.js
// Version sans dépendance à ./kv.js — Upstash via REST direct

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function normalizeEmail(s){ return (s || '').trim().toLowerCase(); }
function uniq(a){ return Array.from(new Set(a || [])); }
function clampPrograms(list){
  const set = new Set(FIELD_IDS);
  return uniq((list || [])
    .map(x => String(x || '').trim().toLowerCase())
    .filter(x => set.has(x)));
}
function isTestEnv(v){ return String(v).toLowerCase() === 'test'; }

async function upstash(cmd, args){
  if (!UPSTASH_URL || !UPSTASH_TOKEN){
    const msg = `Upstash missing config: ${!UPSTASH_URL?'UPSTASH_REDIS_REST_URL ':''}${!UPSTASH_TOKEN?'UPSTASH_REDIS_REST_TOKEN':''}`.trim();
    throw new Error(msg);
  }
  const r = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([cmd, ...args])
  });
  const data = await r.json().catch(()=>null);
  if (!r.ok) throw new Error(`Upstash ${cmd} ${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function kvSet(key, val, ttlSec){
  const v = typeof val === 'string' ? val : JSON.stringify(val);
  return ttlSec
    ? upstash('SET', [key, v, 'EX', ttlSec])
    : upstash('SET', [key, v]);
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
    const b = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body||'{}');

    let { env, memberId, email, programs = [], seats, priceId, createdAt } = b || {};
    env = isTestEnv(env) ? 'test' : 'live';

    if (!memberId || typeof memberId !== 'string') {
      return res.status(400).json({ ok:false, error:'memberId required' });
    }
    email = normalizeEmail(email);
    if (!email) {
      return res.status(400).json({ ok:false, error:'email required' });
    }

    programs = clampPrograms(programs);
    if (programs.length === 0){
      return res.status(400).json({ ok:false, error:'programs required (non-empty & valid IDs)' });
    }

    if (!priceId || typeof priceId !== 'string'){
      return res.status(400).json({ ok:false, error:'priceId required' });
    }

    const intentId  = newIntentId();
    const intentKey = `intent:${intentId}`;

    const intent = {
      id: intentKey,
      env,
      memberId,
      email,
      programs,
      seats: Number.isFinite(+seats) ? Math.max(0, parseInt(seats,10)) : programs.length,
      priceId,
      createdAt: createdAt || new Date().toISOString(),
      status: 'pending'
    };

    // write intent (TTL 30 jours)
    await kvSet(intentKey, intent, 60*60*24*30);

    // pointers
    const p = { intentId: intentId, env, t: Date.now() };
    await kvSet(`latest-intent:${env}:${memberId}`, p, 60*60*24*30);
    await kvSet(`latest-intent-email:${env}:${email}`, p, 60*60*24*30);

    // miroirs (pour robustesse env)
    const MIRROR = env === 'live' ? 'test' : 'live';
    await kvSet(`latest-intent:${MIRROR}:${memberId}`, p, 60*60*24*30);
    await kvSet(`latest-intent-email:${MIRROR}:${email}`, p, 60*60*24*30);

    // défauts
    await kvSet(`latest-intent:default:${memberId}`, p, 60*60*24*30);
    await kvSet(`latest-intent-email:default:${email}`, p, 60*60*24*30);

    // read-after-write (anti-latence)
    for (let i=0;i<3;i++){
      const chk = await kvGet(intentKey);
      if (chk) break;
      await new Promise(r=>setTimeout(r, 150*(i+1)));
    }

    console.log('[INTENT] created', { env, memberId, email, programs, priceId, intentId });
    return res.status(200).json({ ok:true, intentId });
  }catch(e){
    console.error('[INTENT] error:', e && e.message ? e.message : e);
    return res.status(500).json({ ok:false, error: String(e && e.message || e) });
  }
};
