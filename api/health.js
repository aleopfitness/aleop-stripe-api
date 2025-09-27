// /api/health.js
const { kvGet, unwrapKVResult } = require('./kv.js');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const probe = url.searchParams.get('probe');
    if (!probe) {
      res.setHeader('Cache-Control','no-store');
      return res.status(200).json({ ok:true, ts: Date.now() });
    }

    const env = url.searchParams.get('env') || process.env.APP_ENV || 'test';  // Dynamique pour dual
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const memberId = (url.searchParams.get('memberId') || '').trim();
    const mirror = env === 'live' ? 'test' : 'live';

    const tried = [];
    async function getK(k){ tried.push(k); const v = await kvGet(k); return unwrapKVResult(v) || v; }

    const out = { ok:true, env, email, memberId, tried: [] };
    let ptrEmail = null, ptrMember = null, intent = null;

    if (email) {
      ptrEmail = await getK(`latest-intent-email:${env}:${email}`)
              || await getK(`latest-intent-email:${mirror}:${email}`)
              || await getK(`latest-intent-email:default:${email}`);
    }
    if (memberId) {
      ptrMember = await getK(`latest-intent:${env}:${memberId}`)
               || await getK(`latest-intent:${mirror}:${memberId}`)
               || await getK(`latest-intent:default:${memberId}`);
    }

    const intentId = (ptrEmail && ptrEmail.intentId) || (ptrMember && ptrMember.intentId);
    if (intentId) intent = await getK(`intent:${intentId}`);

    out.ptrEmail = ptrEmail || null;
    out.ptrMember = ptrMember || null;
    out.intent = intent || null;
    out.tried = tried;

    return res.status(200).json(out);
  } catch(e){
    return res.status(500).json({ ok:false, error:e.message });
  }
};
