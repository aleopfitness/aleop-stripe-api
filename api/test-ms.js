const fetch = require('node-fetch');
module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const env = url.searchParams.get('env') || process.env.APP_ENV || 'test';  // Dynamique pour dual
  const key = env === 'live' ? process.env.MEMBERSTACK_API_KEY_LIVE : process.env.MEMBERSTACK_API_KEY_TEST;
  console.log(`[${env.toUpperCase()}] Key prefix:`, key ? key.substring(0, 10) : 'MISS');
  const r = await fetch('https://admin.memberstack.com/v2/members/mem_cmafsbtz700dl0wpv9csa0n8g', {  // Ton live memberId
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: { test: '1' } })
  });
  const txt = await r.text();
  console.log(`[${env.toUpperCase()}] Status:`, r.status, txt);
  res.json({ status: r.status, env });
};
