// /api/health.js
const { kvGet } = require('./kv.js');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const probe = url.searchParams.get('probe');
    if (!probe) {
      res.setHeader('Cache-Control','no-store');
      return res.status(200).json({ ok:true, ts: Date.now() });
    }

    const env = url.searchParams.get('env') || 'test';
    const email = (url.searchParams.get('email') || '').trim().toLowerCase();
    const memberId = (url.searchParams.get('memberId') || '').trim();
    const mirror = env === 'live' ? 'test' : 'live';

    const tried = [];
    function add(k){ tried.push(k); return kvGet(k); }

    const result = { ok:true, env, email, memberId, tried: [] };

    // read email pointers
    let ptrEmail = null;
    if (email) {
      ptrEmail = await add(`latest-intent-email:${env}:${email}`)
              || await add(`latest-intent-email:${mirror}:${email}`)
              || await add(`latest-intent-email:default:${email}`);
      result.ptrEmail = ptrEmail || null;
    }

    // read memberId pointers
    let ptrMember = null;
    if (memberId) {
      ptrMember = await add(`latest-intent:${env}:${memberId}`)
               || await add(`latest-intent:${mirror}:${memberId}`)
               || await add(`latest-intent:default:${memberId}`);
      result.ptrMember = ptrMember || null;
    }

    // resolve intent
    const intentId = (ptrEmail && ptrEmail.intentId) || (ptrMember && ptrMember.intentId);
    if (intentId) {
      result.intent = await add(`intent:${intentId}`);
    } else {
      result.intent = null;
    }

    result.tried = tried;
    return res.status(200).json(result);
  } catch(e){
    return res.status(500).json({ ok:false, error:e.message });
  }
};
