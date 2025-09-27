/**
 * /api/member-updated.js
 * Dédié à member.updated → propage club de teamowner à la team
 * - Résout ID via email si manquant
 * - Check teamowner='1' + club + teamid
 * - Propagé via list all members + filter by teamid (fix 404 on /teams/{id})
 * - Svix + KV idempotence
 * - Env dynamique (APP_ENV default pour webhooks)
 */

const fetch = require('node-fetch');
const { Webhook } = require('svix');
const { kvGet, kvSetEx } = require('./kv.js');

/* --- Utils --- */
function msApiKey(env) {
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST;
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
    throw new Error(`MS query ${r.status}: ${txt}`);
  }
  const d = JSON.parse(txt || '{}');
  const id = d?.data?.[0]?.id ?? d?.id ?? null;
  console.log('[MS-UPDATED] findByEmail result', { id });
  return id || null;
}
async function msGetAllMembers(env, limit=1000){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members?page=1&limit=${limit}`;
  console.log('[MS-UPDATED] getAll start', { env, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  console.log('[MS-UPDATED] getAll response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) throw new Error(`MS getAll ${r.status}: ${txt}`);
  let data;
  try {
    data = JSON.parse(txt || '{}');
    data = data.data || data;
  } catch (e) {
    console.error('[MS-UPDATED] getAll parse error', e.message, txt.substring(0,300));
    throw e;
  }
  console.log('[MS-UPDATED] getAll parsed', { count: data.length });
  return data;
}
async function msGetTeamMembersByTeamId(env, teamIdStr, ownerId){
  console.log('[MS-UPDATED] getTeamMembersByTeamId start', { env, teamIdStr, ownerId });
  const allMembers = await msGetAllMembers(env);
  const teamMembers = allMembers.filter(m => String(m.customFields?.teamid || '') === teamIdStr && m.id !== ownerId);
  console.log('[MS-UPDATED] Filtered team members', { count: teamMembers.length });
  return teamMembers;
}
/* --- Handler --- */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  const env = process.env.APP_ENV || 'test';  // Dynamique pour webhooks (no query)
  console.log('[MS-UPDATED] Handler start', { env });
  const msWebhookSecret = env === 'live' ? process.env.MS_WEBHOOK_SECRET_UPDATED_LIVE : process.env.MS_WEBHOOK_SECRET_UPDATED_TEST;
  if (!msWebhookSecret) {
    console.error('[MS-UPDATED] Secret missing', { env });
    return res.status(403).send('Missing secret');
  }
  let rawBody;
  try {
    rawBody = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
    console.log('[MS-UPDATED] Raw body received', { length: rawBody.length, preview: rawBody.substring(0,200) });
  } catch (e) {
    console.error('[MS-UPDATED] Body read error', e.message);
    return res.status(400).send('Invalid request');
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.error('[MS-UPDATED] Parse error', e.message, rawBody.substring(0,300));
    return res.status(400).send('Invalid JSON');
  }
  const type = payload.type;
  const svix_id = req.headers['svix-id'];
  const svix_timestamp = req.headers['svix-timestamp'];
  const svix_signature = req.headers['svix-signature'];
  console.log('[MS-UPDATED] Svix headers', { svix_id });
  if (!svix_id || !svix_timestamp || !svix_signature) {
    console.error('[MS-UPDATED] Missing Svix headers');
    return res.status(400).send('Missing headers');
  }
  const wh = new Webhook(msWebhookSecret);
  let evt;
  try {
    evt = wh.verify(rawBody, {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature
    });
  } catch (err) {
    console.error('[MS-UPDATED] Verify error', err.message);
    return res.status(400).send('Invalid signature');
  }
  const payloadData = evt.data || {};
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
