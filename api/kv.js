// /api/kv.js
const fetch = require('node-fetch');

function isVercelKV() { return !!process.env.KV_REST_API_URL; }
function base()       { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function token()      { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }

function authJSON() { return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }; }
function auth()     { return { Authorization: `Bearer ${token()}` }; }

async function kvSetEx(key, obj, ttlSec) {
  const v = JSON.stringify(obj);
  if (isVercelKV()) {
    const url = `${base()}/set/${encodeURIComponent(key)}?ex=${ttlSec}`;
    const r = await fetch(url, { method:'POST', headers:authJSON(), body: JSON.stringify({ value: v }) });
    if (!r.ok) throw new Error(`KV set ${r.status}: ${await r.text()}`);
  } else {
    const url = `${base()}/set/${encodeURIComponent(key)}/${encodeURIComponent(v)}?EX=${ttlSec}`;
    const r = await fetch(url, { method:'POST', headers:auth() });
    if (!r.ok) throw new Error(`KV set ${r.status}: ${await r.text()}`);
  }
}

async function kvGet(key) {
  const r = await fetch(`${base()}/get/${encodeURIComponent(key)}`, { headers:auth() });
  const txt = await r.text();
  if (!r.ok) throw new Error(`KV get ${r.status}: ${txt}`);
  let j; try { j = JSON.parse(txt); } catch { return null; }
  if (!j || j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

async function kvDel(key) {
  const r = await fetch(`${base()}/del/${encodeURIComponent(key)}`, { method:'POST', headers:auth() });
  if (!r.ok) throw new Error(`KV del ${r.status}: ${await r.text()}`);
}

module.exports = { kvSetEx, kvGet, kvDel };
