const fetch = require('node-fetch');
module.exports = async (req, res) => {
  const key = process.env.MEMBERSTACK_API_KEY_TEST;
  console.log('[TEST] Key prefix:', key ? key.substring(0, 10) : 'MISS');
  const r = await fetch('https://admin.memberstack.com/v2/members/mem_sb_cmeh0l3bz000f0xknf05h45zf', { // Ton memberId test
    method: 'PATCH',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ customFields: { test: '1' } })
  });
  console.log('[TEST] Status:', r.status, await r.text());
  res.json({ status: r.status });
};
