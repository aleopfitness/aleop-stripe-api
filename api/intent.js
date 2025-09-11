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
    const body = typeof req.body === 'object' && req.body !== null
      ? req.body
      : JSON.parse(typeof req.body === 'string' ? req.body : '{}');

    const {
      env,                // devient optionnel
      memberId,
      email,              // devient optionnel
      programs = [],
      seats = 0,
      priceId,
      createdAt
    } = body || {};

    // Validation
    if (!memberId || !Array.isArray(programs) || programs.length === 0) {
      console.log('Intent validation fail:', { memberId, programs });
      return res.status(400).json({ ok:false, error:'memberId + non-empty programs array required' });
    }

    // Normalisations optionnelles
    const envIn = (env === 'test' || env === 'live') ? env : undefined; // facultatif
    const emailKey = (email || '').trim().toLowerCase() || undefined;

    const intentId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const intent = {
      intentId,
      env: envIn,                 // peut être undefined
      memberId,
      email: emailKey,            // peut être undefined
      programs, // IDs MS directs
      seats,
      priceId,
      createdAt: createdAt || new Date().toISOString(),
      status:'pending'
    };

    console.log('Intent stored:', { intentId, memberId, emailKey, env: envIn, programs });

    // Stockage (7 jours) - env-specific pour latest
    await kvSetEx(`intent:${intentId}`, intent, 7*24*60*60);
    const envPrefix = envIn || 'default';
    await kvSetEx(`latest-intent:${envPrefix}:${memberId}`, { intentId, env: envIn, t: Date.now() }, 7*24*60*60);
    if (emailKey) {
      await kvSetEx(`latest-intent-email:${envPrefix}:${emailKey}`, { intentId, env: envIn, t: Date.now() }, 7*24*60*60);
    }

    res.status(200).json({ ok:true, intentId });
  } catch (e) {
    console.error('intent error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
};
