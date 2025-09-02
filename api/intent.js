// /api/intent.js
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
async function kvSetEx(key, value, ttl){
  const url = `${kvBase()}/set/${encodeURIComponent(key)}?ex=${ttl}`;
  const res = await fetch(url, {
    method:'POST',
    headers:{ ...kvHeaders(), 'Content-Type':'application/json' },
    body: JSON.stringify({ value: JSON.stringify(value) })
  });
  await kvJson(res);
}

module.exports = async (req, res) => {
  // CORS simple
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || '{}');
    const { env, memberId, email, programs = [], seats = 0, priceId, createdAt } = JSON.parse(raw || '{}');

    if (env !== 'test' && env !== 'live') return res.status(400).json({ ok:false, error:'env must be test|live' });
    if (!memberId || !Array.isArray(programs)) return res.status(400).json({ ok:false, error:'memberId + programs required' });
    const emailKey = (email || '').trim().toLowerCase();

    const intentId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const intent = { intentId, env, memberId, email: emailKey, programs, seats, priceId, createdAt: createdAt || new Date().toISOString(), status:'pending' };

    // stocke l’intent (7 jours) + pointeurs par memberId et par email
    await kvSetEx(`intent:${intentId}`, intent, 7*24*60*60);
    await kvSetEx(`latest-intent:${memberId}`, { intentId, env, t: Date.now() }, 7*24*60*60);
    if (emailKey) await kvSetEx(`latest-intent-email:${emailKey}`, { intentId, env, t: Date.now() }, 7*24*60*60);

    res.status(200).json({ ok:true, intentId });
  } catch (e) {
    console.error('intent error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
};
