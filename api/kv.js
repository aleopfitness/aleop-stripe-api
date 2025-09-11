// /api/kv.js
const fetch = require('node-fetch');

function isVercelKV() { return !!process.env.KV_REST_API_URL; }
function base()       { return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function token()      { return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }

function authHeadersJSON() { return { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }; }
function authHeaders()     { return { Authorization: `Bearer ${token()}` }; }

async function kvSetEx(key, obj, ttlSec) {
  const urlBase = base();
  const val = JSON.stringify(obj);
  if (isVercelKV()) {
    const url = `${urlBase}/set/${encodeURIComponent(key)}?ex=${ttlSec}`;
    const r = await fetch(url, { method:'POST', headers: authHeadersJSON(), body: JSON.stringify({ value: val }) });
    if (!r.ok) throw new Error(`KV set fail ${r.status}: ${await r.text()}`);
  } else {
    // Upstash Redis REST nu
    const url = `${urlBase}/set/${encodeURIComponent(key)}/${encodeURIComponent(val)}?EX=${ttlSec}`;
    const r = await fetch(url, { method:'POST', headers: authHeaders() });
    if (!r.ok) throw new Error(`KV set fail ${r.status}: ${await r.text()}`);
  }
}

async function kvGet(key) {
  const url = `${base()}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: authHeaders() });
  const txt = await r.text();
  if (!r.ok) throw new Error(`KV get fail ${r.status}: ${txt}`);
  let json; try { json = JSON.parse(txt); } catch { return null; }
  if (!json || json.result == null) return null;
  try { return JSON.parse(json.result); } catch { return null; }
}

async function kvDel(key) {
  const url = `${base()}/del/${encodeURIComponent(key)}`;
  const r = await fetch(url, { method:'POST', headers: authHeaders() });
  if (!r.ok) throw new Error(`KV del fail ${r.status}: ${await r.text()}`);
}

module.exports = { kvSetEx, kvGet, kvDel };
