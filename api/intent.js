// /api/intent.js
const { kvSetEx, kvGet } = require('./kv.js');

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
      env,          // 'test'|'live' (front la met déjà)
      memberId,
      email,
      programs = [],  // ex: ['booty','upper']
      seats = 0,
      priceId,
      createdAt
    } = body || {};

    if (!memberId || !Array.isArray(programs) || programs.length === 0) {
      return res.status(400).json({ ok:false, error:'memberId + non-empty programs required' });
    }

    const envIn = (env === 'test' || env === 'live') ? env : 'test';
    const emailKey = (email || '').trim().toLowerCase() || undefined;

    const intentId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const intent = {
      intentId,
      env: envIn,
      memberId,
      email: emailKey,
      programs,
      seats,
      priceId,
      createdAt: createdAt || new Date().toISOString(),
      status:'pending'
    };

    // 1) Écrire intent + pointeurs
    await kvSetEx(`intent:${intentId}`, intent, 7*24*60*60);
    await kvSetEx(`latest-intent:${envIn}:${memberId}`, { intentId, env: envIn, t: Date.now() }, 7*24*60*60);
    if (emailKey) {
      await kvSetEx(`latest-intent-email:${envIn}:${emailKey}`, { intentId, env: envIn, t: Date.now() }, 7*24*60*60);
    }

    // 2) Read-back (anti latence région)
    for (let i = 0; i < 3; i++) {
      const check = await kvGet(`intent:${intentId}`);
      if (check) break;
      await new Promise(r => setTimeout(r, 200 * (i + 1))); // 200, 400, 600ms
    }

    res.status(200).json({ ok:true, intentId });
  } catch (e) {
    console.error('intent error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
};
