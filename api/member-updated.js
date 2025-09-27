/**
 * /api/member-updated.js
 * Dédié à member.updated → propage club de teamowner à la team
 * - Résout ID via email si manquant
 * - Check teamowner='1' + club + teamid
 * - Propagé via list all members + filter by teamid (fix 404 on /teams/{id})
 * - Svix + KV idempotence
 * - Env 'test'
 */

const fetch = require('node-fetch');
const { Webhook } = require('svix');
const { kvGet, kvSetEx } = require('./kv.js');

function verifyAndDetectEnvUpdated(payloadStr, headers) {
  const h = {
    "svix-id": headers["svix-id"] || headers["Svix-Id"] || headers["svix-id".toLowerCase()],
    "svix-timestamp": headers["svix-timestamp"] || headers["Svix-Timestamp"],
    "svix-signature": headers["svix-signature"] || headers["Svix-Signature"],
  };
  if (!h["svix-id"] || !h["svix-timestamp"] || !h["svix-signature"]) {
    const err = new Error("Missing Svix headers");
    err.status = 400;
    throw err;
  }
  const liveSecret = process.env.MS_WEBHOOK_SECRET_UPDATED_LIVE;
  const testSecret = process.env.MS_WEBHOOK_SECRET_UPDATED_TEST || process.env.MS_WEBHOOK_SECRET_UPDATED;
  if (liveSecret) {
    try {
      const wh = new Webhook(liveSecret);
      const event = wh.verify(Buffer.from(payloadStr, "utf-8"), h);
      return { env: "live", event };
    } catch (e) {}
  }
  if (testSecret) {
    try {
      const wh = new Webhook(testSecret);
      const event = wh.verify(Buffer.from(payloadStr, "utf-8"), h);
      return { env: "test", event };
    } catch (e) {}
  }
  const err = new Error("Invalid Svix signature for both UPDATED_LIVE and UPDATED_TEST");
  err.status = 400;
  throw err;
}

/* --- Utils --- */
function msApiKey(env) {
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
function msHeaders(key) {
  return { 'X-API-KEY': key, 'Content-Type': 'application/json' };
}
async function msPatchMember(env, memberId, customFields) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS-UPDATED] PATCH start', { env, memberId, keyPrefix: String(key).slice(0,6), updates: customFields });
  const r = await fetch(url, {
    method: 'PATCH',
    headers: msHeaders(key),
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  console.log('[MS-UPDATED] PATCH response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) {
    console.error('[MS-UPDATED] PATCH ERROR full', { status: r.status, txt });
    throw new Error(`MS update ${r.status}: ${txt}`);
  }
  console.log('[MS-UPDATED] PATCH OK', { status: r.status });
}
async function msGetMember(env, memberId) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS-UPDATED] GET start', { env, memberId, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  console.log('[MS-UPDATED] GET response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) throw new Error(`MS get ${r.status}: ${txt}`);
  let data;
  try {
    data = JSON.parse(txt || '{}');
    data = data.data || data; // Unwrap
  } catch (e) {
    console.error('[MS-UPDATED] GET parse error', e.message, txt.substring(0,300));
    throw e;
  }
  const fields = data.customFields || {};
  console.log('[MS-UPDATED] GET parsed fields', { memberId, fieldsPreview: Object.keys(fields) });
  return data;
}
async function msFindMemberIdByEmail(env, email){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${encodeURIComponent(email)}`;
  console.log('[MS-UPDATED] findByEmail start', { env, email, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok){
    if (r.status === 404) return null;
    console.error('[MS-UPDATED] findByEmail ERROR', r.status, txt.substring(0,300));
    throw new Error(`MS query ${r.status}: ${txt}`);
  }
  let d;
  try {
    d = JSON.parse(txt || '{}');
    d = d.data || d;
  } catch (e) {
    console.error('[MS-UPDATED] findByEmail parse error', e.message, txt.substring(0,300));
    throw e;
  }
  const id = Array.isArray(d) ? d[0]?.id : d?.id ?? null;
  console.log('[MS-UPDATED] findByEmail resolved id', { id });
  return id || null;
}
async function msGetTeamMembersByTeamId(env, teamIdStr, updatedMemberId) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members`; // List all members (assume <1000, no pagination for simplicity)
  console.log('[MS-UPDATED] GET ALL MEMBERS start', { env, teamIdStr, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  console.log('[MS-UPDATED] GET ALL MEMBERS response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) throw new Error(`MS get members ${r.status}: ${txt}`);
  let data;
  try {
    data = JSON.parse(txt || '{}');
    data = data.data || data; // Unwrap
  } catch (e) {
    console.error('[MS-UPDATED] GET ALL MEMBERS parse error', e.message, txt.substring(0,300));
    throw e;
  }
  console.log('[MS-UPDATED] GET ALL MEMBERS parsed', { totalMembers: (data || []).length });
  const teamMembers = (Array.isArray(data) ? data : []).filter(m => String(m.customFields?.teamid || '') === teamIdStr && m.id !== updatedMemberId);
  console.log('[MS-UPDATED] Filtered team members', { count: teamMembers.length, teamIdStr });
  return teamMembers;
}
async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      req.on('data', c => chunks.push(Buffer.from(c)));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    } catch (err) { reject(err); }
  });
}

/* --- Handler Dédié --- */
module.exports = async (req, res) => {
  console.log('[MS-UPDATED] Handler start', { method: req.method, url: req.url });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-signature, svix-timestamp');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  let raw;
  try {
    raw = await readRawBody(req);
    console.log('[MS-UPDATED] Raw body received', { length: raw.length, preview: raw.toString().substring(0,200) });
  } catch (e) {
    console.error('[MS-UPDATED] readRawBody error', e.message);
    return res.status(400).send('Invalid body');
  }
  const payloadStr = raw.toString();
  const headers = req.headers;
  const svix_signature = headers['svix-signature'];
  const svix_timestamp = headers['svix-timestamp'];
  const svix_id = headers['svix-id'];
  console.log('[MS-UPDATED] Svix headers', { svix_id: svix_id ? svix_id.substring(0,20) + '...' : 'MISSING' });
  let env, event;
try {
  const v = verifyAndDetectEnvUpdated(payloadStr, headers);
  env = v.env; event = v.event;
  console.log("[MS-UPDATED] Signature verified OK", { eventType: event.type, env });
} catch (e) {
  console.error("[MS-UPDATED] Svix verify error", { message: e.message });
  return res.status(400).send("Webhook signature error");
}
  const fullPayload = JSON.parse(payloadStr);
  console.log('[MS-UPDATED] Full payload parsed', { event: fullPayload.event, payloadKeys: Object.keys(fullPayload.payload || {}) });
  const type = fullPayload.event;
  const payloadData = fullPayload.payload || {};
  let updatedMemberId;
  if (type !== 'member.updated') {
    console.log('[MS-UPDATED] Skip non-updated event', type);
    return res.status(200).send(); // Skip autres events
  }
  // Résout ID
  updatedMemberId = payloadData.id;
  if (!updatedMemberId && payloadData.auth && payloadData.auth.email) {
    console.log('[MS-UPDATED] No direct id, resolving via email', { email: payloadData.auth.email });
    updatedMemberId = await msFindMemberIdByEmail(env, payloadData.auth.email);
  }
  console.log('=== MS-UPDATED START ===', { updatedMemberId });
  const evtKey = `ms-updated-processed:${env}:${svix_id}`; // KV clé dédiée
  const processed = await kvGet(evtKey);
  if (processed) {
    console.log('[MS-UPDATED] Already processed', processed, 'skip');
    return res.status(200).send();
  }
  try {
    if (!updatedMemberId) {
      console.log('[MS-UPDATED] Missing updatedMemberId');
      await kvSetEx(evtKey, 1, 3600);
      return res.status(200).send();
    }
    let updatedMember;
    try {
      updatedMember = await msGetMember(env, updatedMemberId);
    } catch (e) {
      console.error('[MS-UPDATED] msGetMember error', { updatedMemberId, eMessage: e.message });
      await kvSetEx(evtKey, 1, 3600);
      return res.status(200).send();
    }
    const customFields = updatedMember.customFields || {};
    console.log('[MS-UPDATED] Updated member fields', { updatedMemberId, teamowner: customFields.teamowner, club: customFields.club, teamid: customFields.teamid });
    // Propagation seulement si teamowner et club/teamid
    if (String(customFields.teamowner || '') === '1' && customFields.club && customFields.teamid) {
      const teamIdStr = String(customFields.teamid);
      const newClub = String(customFields.club);
      console.log('[MS-UPDATED] Owner updated club, propagating', { updatedMemberId, teamid: teamIdStr, newClub });
      const teamMembers = await msGetTeamMembersByTeamId(env, teamIdStr, updatedMemberId);
      let updatedCount = 0;
      for (const tm of teamMembers) {
        const tmId = tm.id;
        console.log('[MS-UPDATED] Updating club for member', { tmId, newClub });
        try {
          await msPatchMember(env, tmId, { club: newClub });
          updatedCount++;
        } catch (patchErr) {
          console.error('[MS-UPDATED] Patch error', { tmId, err: patchErr.message });
        }
      }
      console.log(`[MS-UPDATED] Propagated club to ${updatedCount} members`);
    } else {
      console.log('[MS-UPDATED] Skip propagation', { teamowner: customFields.teamowner, hasClub: !!customFields.club, hasTeamid: !!customFields.teamid });
    }
    await kvSetEx(evtKey, 1, 30 * 24 * 3600);
    console.log('=== MS-UPDATED END (SUCCESS) ===');
    return res.status(200).send();
  } catch (err) {
    console.error('=== MS-UPDATED ERROR ===', { message: err.message, stack: err.stack });
    await kvSetEx(evtKey, 1, 3600);
    return res.status(500).send('Handler error');
  }
};
