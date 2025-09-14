/**
 * api/intent.js
 *
 * Reçoit depuis le front:
 *   { env, memberId, email, programs, seats, priceId, createdAt }
 *
 * Stocke dans Upstash:
 *   - intent:<id> => { id, env, memberId, email, programs, seats, priceId, createdAt, status:'pending' }
 *   - latest-intent:<env>:<memberId>     -> intent:<id>
 *   - latest-intent:<memberId>          -> intent:<id>            (fallback)
 *   - latest-intent-email:<env>:<email> -> intent:<id>
 *   - latest-intent-email:<email>       -> intent:<id>            (fallback)
 *
 * Réponse:
 *   200 { ok:true, intentId }
 */

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

// Upstash (REST)
const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// ---------- Utils ----------
function normalizeEmail(s){ return (s || '').trim().toLowerCase(); }
function uniq(arr){ return Array.from(new Set(arr || [])); }
function clampPrograms(list){
  const ids = new Set(FIELD_IDS);
  return uniq((list || []).map(String).map(s=>s.trim().toLowerCase()).filter(x => ids.has(x)));
}
function isTestEnv(v){ return String(v).toLowerCase() === 'test'; }
function safeInt(n, def=0){
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.floor(x)) : def;
}
function newIntentId(){
  // i_<base36 timestamp>_<base36 rand>
  const ts = Date.now().toString(36);
  const rnd = Math.floor(Math.random()*36**6).toString(36).padStart(6,'0');
  return `i_${ts}_${rnd}`;
}

// ---------- Upstash ----------
async function upstash(command, args){
  if (!UPSTASH_URL || !UPSTASH_TOKEN) throw new Error('Upstash missing config');
  const res = await fetch(UPSTASH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([command, ...args])
  });
  const data = await res.json().catch(()=>null);
  if (!res.ok) throw new Error(`Upstash ${command} ${res.status}: ${JSON.stringify(data)}`);
  return data;
}
async function kvSet(key, val, ttlSec){
  const v = (typeof val === 'string') ? val : JSON.stringify(val);
  if (ttlSec) return upstash('SET', [key, v, 'EX', ttlSec]);
  return upstash('SET', [key, v]);
}

// ---------- CORS ----------
function setCors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

// ---------- Handler ----------
module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST'){
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).send('Method Not Allowed');
  }

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body||'{}') : (req.body || {});
    let { env, memberId, email, programs, seats, priceId, createdAt } = body;

    // --- validations de base ---
    env = isTestEnv(env) ? 'test' : 'live';
    if (!memberId || typeof memberId !== 'string') {
      return res.status(400).json({ ok:false, error:'memberId missing' });
    }
    email = normalizeEmail(email);
    if (!email){
      return res.status(400).json({ ok:false, error:'email missing' });
    }
    programs = clampPrograms(programs);
    const qty = programs.length;
    seats = safeInt(seats, qty);
    if (seats !== qty){
      // On force la cohérence: seats = nb de programmes
      seats = qty;
    }
    if (!priceId || typeof priceId !== 'string'){
      return res.status(400).json({ ok:false, error:'priceId missing' });
    }
    if (!createdAt || typeof createdAt !== 'string'){
      createdAt = new Date().toISOString();
    }

    // --- assembler l’objet intent ---
    const intentId = newIntentId();
    const intentKey = `intent:${intentId}`;

    const intent = {
      id: intentKey,
      env,
      memberId,
      email,
      programs,
      seats,
      priceId,
      createdAt,
      status: 'pending'
    };

    // --- stockage principal (intent) ---
    // TTL 30 jours
    await kvSet(intentKey, intent, 60*60*24*30);

    // --- pointeurs par memberId ---
    await kvSet(`latest-intent:${env}:${memberId}`, intentKey, 60*60*24*30);
    await kvSet(`latest-intent:${memberId}`,         intentKey, 60*60*24*30); // fallback

    // --- pointeurs par email ---
    await kvSet(`latest-intent-email:${env}:${email}`, intentKey, 60*60*24*30);
    await kvSet(`latest-intent-email:${email}`,         intentKey, 60*60*24*30); // fallback

    console.log('[INTENT] created', {
      env, memberId, email, programs, seats, priceId, intentId
    });

    return res.status(200).json({ ok:true, intentId: intentKey });
  }catch(err){
    console.error('intent error:', err && err.stack || err);
    return res.status(500).json({ ok:false, error: String(err?.message || err) });
  }
};

// ⚠️ Si tu utilises Next.js (pages/api), tu n’as rien à ajouter ici.
//    (Pas de vérif signature Stripe sur cette route, JSON standard)
