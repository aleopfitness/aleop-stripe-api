// /api/kv.js
const fetch = require('node-fetch');

function isVercelKV(){ return !!process.env.KV_REST_API_URL; }
function base(){ return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function token(){ return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function hJSON(){ return { Authorization:`Bearer ${token()}`, 'Content-Type':'application/json' }; }
function h(){ return { Authorization:`Bearer ${token()}` }; }

// Normalise n'importe quel format de retour KV vers l'objet stocké
function unwrapKVResult(j){
  if (j == null) return null;
  const r = Object.prototype.hasOwnProperty.call(j, 'result') ? j.result : j;
  if (typeof r === 'string') { try { return JSON.parse(r); } catch { return r; } }
  if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'value')) {
    const v = r.value;
    if (typeof v === 'string') { try { return JSON.parse(v); } catch { return v; } }
    return v ?? null;
  }
  if (r && typeof r === 'object') return r;
  return null;
}

async function kvSetEx(key, obj, ttl){
  const v = JSON.stringify(obj);
  if (isVercelKV()){
    const url = `${base()}/set/${encodeURIComponent(key)}?ex=${ttl}`;
    console.log('[KV] SET Vercel URL:', url);  // Nouveau log
    const r = await fetch(url, { method:'POST', headers:hJSON(), body:JSON.stringify({ value:v }) });
    const txt = await r.text().catch(()=>'');
    if (!r.ok) { 
      console.error('[KV] SET ERROR Vercel', r.status, txt); 
      throw new Error(`KV set ${r.status}: ${txt}`); 
    }
    console.log('[KV] SET OK Vercel', r.status);  // Nouveau log
  } else {
    const url = `${base()}/set/${encodeURIComponent(key)}/${encodeURIComponent(v)}?EX=${ttl}`;
    console.log('[KV] SET Upstash URL:', url);  // Nouveau log
    const r = await fetch(url, { method:'POST', headers:h() });
    const txt = await r.text().catch(()=>'');
    if (!r.ok) { 
      console.error('[KV] SET ERROR Upstash', r.status, txt); 
      throw new Error(`KV set ${r.status}: ${txt}`); 
    }
    console.log('[KV] SET OK Upstash', r.status);  // Nouveau log
  }
}

async function kvGet(key){
  const url = isVercelKV() 
    ? `${base()}/get/${encodeURIComponent(key)}` 
    : `${base()}/get/${encodeURIComponent(key)}`;
  console.log('[KV] GET URL for key=' + key + ':', url);  // Nouveau log clé + URL
  console.log('[KV] Using token prefix:', token() ? token().slice(0,10) + '...' : 'MISSING');  // Log token sans full
  const headers = isVercelKV() ? hJSON() : h();
  const r = await fetch(url, { headers });
  const txt = await r.text();
  console.log('[KV] Response for', key, ': status=' + r.status + ', text length=' + txt.length + ', text preview=' + (txt.substring(0,100) || 'EMPTY'));  // Log full response
  if (!r.ok) { 
    console.error('[KV] GET ERROR for', key, ':', r.status, txt); 
    throw new Error(`KV get ${r.status}: ${txt}`); 
  }
  let j; 
  try { j = JSON.parse(txt); } catch(e) { 
    console.error('[KV] Parse error for', key, ':', e.message); 
    return null; 
  }
  const result = unwrapKVResult(j);
  console.log('[KV] Parsed result for', key, ':', result ? 'NON-NULL (object/string)' : 'NULL');  // Log final
  return result;
}

module.exports = { kvSetEx, kvGet, unwrapKVResult };
