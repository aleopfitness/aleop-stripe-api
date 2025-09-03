const fetch = require('node-fetch');

function kvBase(){ return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function kvToken(){ return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function kvHeaders(){ const t = kvToken(); if(!t) throw new Error('KV token missing'); return { Authorization:`Bearer ${t}` }; }
async function kvJson(res){ const text = await res.text(); if(!res.ok) throw new Error(`KV ${res.status}: ${text}`); try { return JSON.parse(text); } catch { return { result: text }; } }
async function kvSetEx(key, value, ttl){
  const url = `${kvBase()}/set/${encodeURIComponent(key)}?ex=${ttl}`;
  const res = await fetch(url, {
    method:'POST',
    headers:{ ...kvHeaders(), 'Content-Type':'application/json' },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
  await kvJson(res);
}

const ALLOWED_SLUGS = [
  'athletyx','booty-shape','upper-shape','power-flow',
  'fight','cycle','force','cardio','mobility'
];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  try {
    const body = typeof req.body === 'object' && req.body !== null ? req.body : JSON.parse(req.body || '{}');
    let { env, memberId, email, programs = [], priceId, createdAt } = body || {};
    if (!memberId) return res.status(400).json({ ok:false, error:'memberId required' });

    const normalized = Array.from(new Set(
      (Array.isArray(programs)?programs:[])
        .map(s => String(s||'').toLowerCase().trim())
        .filter(s => ALLOWED_SLUGS.includes(s))
    ));
    const seats = normalized.length;
    if (seats < 1 || seats > 9) return res.status(400).json({ ok:false, error:'programs must have 1..9 items' });

    const envIn = (env==='test'||env==='live') ? env : undefined;
    const emailKey = (email||'').trim().toLowerCase() || undefined;

    const intentId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const intent = {
      intentId, env: envIn, memberId, email: emailKey,
      programs: normalized, seats,
      priceId: priceId || null,
      createdAt: createdAt || new Date().toISOString(),
      status:'pending'
    };

    await kvSetEx(`intent:${intentId}`, intent, 7*24*60*60);
    await kvSetEx(`latest-intent:${memberId}`, { intentId, env: envIn, t: Date.now() }, 7*24*60*60);
    if (emailKey) await kvSetEx(`latest-intent-email:${emailKey}`, { intentId, env: envIn, t: Date.now() }, 7*24*60*60);

    res.status(200).json({ ok:true, intentId });
  } catch (e) {
    console.error('intent error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
};
