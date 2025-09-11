// /api/intent.js
const { kvSetEx, kvGet } = require('./kv.js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'Method Not Allowed' });

  try{
    const b = (typeof req.body === 'object' && req.body !== null) ? req.body : JSON.parse(req.body||'{}');
    const { env, memberId, email, programs = [], seats = 0, priceId, createdAt } = b || {};
    if (!memberId || !Array.isArray(programs) || programs.length === 0){
      return res.status(400).json({ ok:false, error:'memberId + non-empty programs required' });
    }

    const ENV = (env === 'live' || env === 'test') ? env : 'test';
    const MIRROR = (ENV === 'live') ? 'test' : 'live';
    const emailKey = (email || '').trim().toLowerCase() || undefined;

    const intentId = `i_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;
    const intent = {
      intentId, env:ENV, memberId, email:emailKey,
      programs, seats, priceId, createdAt: createdAt || new Date().toISOString(),
      status:'pending'
    };

    // write intent
    await kvSetEx(`intent:${intentId}`, intent, 7*24*3600);

    // pointers (env courant)
    const p = { intentId, env:ENV, t:Date.now() };
    await kvSetEx(`latest-intent:${ENV}:${memberId}`, p, 7*24*3600);
    if (emailKey) await kvSetEx(`latest-intent-email:${ENV}:${emailKey}`, p, 7*24*3600);

    // mirror (autre env)
    await kvSetEx(`latest-intent:${MIRROR}:${memberId}`, p, 7*24*3600);
    if (emailKey) await kvSetEx(`latest-intent-email:${MIRROR}:${emailKey}`, p, 7*24*3600);

    // default
    await kvSetEx(`latest-intent:default:${memberId}`, p, 7*24*3600);
    if (emailKey) await kvSetEx(`latest-intent-email:default:${emailKey}`, p, 7*24*3600);

    // read-back anti latence
    for (let i=0;i<3;i++){
      const check = await kvGet(`intent:${intentId}`);
      if (check) break;
      await new Promise(r=>setTimeout(r, 200*(i+1)));
    }

    res.status(200).json({ ok:true, intentId });
  }catch(e){
    console.error('intent error:', e.message);
    res.status(500).json({ ok:false, error:e.message });
  }
};
