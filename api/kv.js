// /api/kv.js
const fetch = require('node-fetch');

function isVercelKV(){ return !!process.env.KV_REST_API_URL; }
function base(){ return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function token(){ return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function hJSON(){ return { Authorization:`Bearer ${token()}`, 'Content-Type':'application/json' }; }
function h(){ return { Authorization:`Bearer ${token()}` }; }

async function kvSetEx(key, obj, ttl){
  const v = JSON.stringify(obj);
  if (isVercelKV()){
    const url = `${base()}/set/${encodeURIComponent(key)}?ex=${ttl}`;
    const r = await fetch(url, { method:'POST', headers:hJSON(), body:JSON.stringify({ value:v }) });
    if (!r.ok) throw new Error(`KV set ${r.status}: ${await r.text()}`);
  } else {
    const url = `${base()}/set/${encodeURIComponent(key)}/${encodeURIComponent(v)}?EX=${ttl}`;
    const r = await fetch(url, { method:'POST', headers:h() });
    if (!r.ok) throw new Error(`KV set ${r.status}: ${await r.text()}`);
  }
}
async function kvGet(key){
  const r = await fetch(`${base()}/get/${encodeURIComponent(key)}`, { headers:h() });
  const txt = await r.text();
  if (!r.ok) throw new Error(`KV get ${r.status}: ${txt}`);
  let j; try{ j = JSON.parse(txt); }catch{ return null; }
  if (!j || j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

module.exports = { kvSetEx, kvGet };
