// /api/kv.js
const fetch = require('node-fetch');

function isVercelKV(){ return !!process.env.KV_REST_API_URL; }
function base(){ return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL; }
function token(){ return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN; }
function hJSON(){ return { Authorization:`Bearer ${token()}`, 'Content-Type':'application/json' }; }
function hPlain(){ return { Authorization:`Bearer ${token()}`, 'Content-Type':'text/plain' }; }
function h(){ return { Authorization:`Bearer ${token()}` }; }

// Normalise n'importe quel format de retour KV vers l'objet stocké
function unwrapKVResult(j){
  if (j == null) return null;
  const r = Object.prototype.hasOwnProperty.call(j, 'result') ? j.result : j;
  if (typeof r === 'string') { 
    try { 
      console.log('[KV] Parsing direct string r (length:', r.length, ')');  // Log pour debug
      return JSON.parse(r); 
    } catch(e) { 
      console.error('[KV] Parse error on r string:', e.message, 'preview:', r.substring(0,100)); 
      return r; 
    } 
  }
  if (r && typeof r === 'object' && Object.prototype.hasOwnProperty.call(r, 'value')) {
    const v = r.value;
    if (typeof v === 'string') { 
      try { 
        console.log('[KV] Parsing v string (length:', v.length, ')');  // Log pour debug
        const parsed = JSON.parse(v); 
        console.log('[KV] v parsed OK to object'); 
        return parsed; 
      } catch(e) { 
        console.error('[KV] Parse error on v string:', e.message, 'v content:', v.substring(0,200) + '...'); 
        return v; 
      } 
    }
    return v ?? null;
  }
  if (r && typeof r === 'object') return r;
  return null;
}

async function kvSetEx(key, obj, ttl){
  const v = JSON.stringify(obj);
  if (isVercelKV()){
    const url = `${base()}/set/${encodeURIComponent(key)}?ex=${ttl}`;
    console.log('[KV] SET Vercel URL:', url);
    // Fix: body = v direct (string), Content-Type text/plain pour stocker sans wrapper/escaping extra
    const r = await fetch(url, { method:'POST', headers:hPlain(), body: v });
    const txt = await r.text().catch(()=>'');
    if (!r.ok) { 
      console.error('[KV] SET ERROR Vercel', r.status, txt); 
      throw new Error(`KV set ${r.status}: ${txt}`); 
    }
    console.log('[KV] SET OK Vercel', r.status);
  } else {
    const url = `${base()}/set/${encodeURIComponent(key)}/${encodeURIComponent(v)}?EX=${ttl}`;
    console.log('[KV] SET Upstash URL:', url);
    const r = await fetch(url, { method:'POST', headers:h() });
    const txt = await r.text().catch(()=>'');
    if (!r.ok) { 
      console.error('[KV] SET ERROR Upstash', r.status, txt); 
      throw new Error(`KV set ${r.status}: ${txt}`); 
    }
    console.log('[KV] SET OK Upstash', r.status);
  }
}

async function kvGet(key){
  const url = isVercelKV() 
    ? `${base()}/get/${encodeURIComponent(key)}` 
    : `${base()}/get/${encodeURIComponent(key)}`;
  console.log('[KV] GET URL for key=' + key + ':', url);
  console.log('[KV] Using token prefix:', token() ? token().slice(0,10) + '...' : 'MISSING');
  const headers = isVercelKV() ? hJSON() : h();  // hJSON pour Vercel (mais GET n'a pas body)
  const r = await fetch(url, { headers });
  const txt = await r.text();
  console.log('[KV] Response for', key, ': status=' + r.status + ', text length=' + txt.length + ', text preview=' + (txt.substring(0,100) || 'EMPTY'));
  if (!r.ok) { 
    console.error('[KV] GET ERROR for', key, ':', r.status, txt); 
    throw new Error(`KV get ${r.status}: ${txt}`); 
  }
  let j; 
  try { 
    j = JSON.parse(txt); 
    console.log('[KV] j from parse:', typeof j, Object.keys(j || {}));  // Log structure j
  } catch(e) { 
    console.error('[KV] Parse txt error for', key, ':', e.message); 
    return null; 
  }
  const result = unwrapKVResult(j);
  console.log('[KV] Final parsed result for', key, ':', result ? (typeof result === 'object' ? 'OBJECT' : 'STRING') : 'NULL');
  return result;
}

module.exports = { kvSetEx, kvGet, unwrapKVResult };
