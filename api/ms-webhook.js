/**
 * /api/ms-webhook.js
 * Memberstack team events → copie customFields de l'owner vers team member
 * - Event: team.member.added → copie SEULEMENT programs flags + teamowner='0' + club (nommé par owner) + teamid (pour propagation future)
 * - Event: team.member.removed → deactivate
 * - Event: member.updated → si owner update club, propage à tous les members de la team (via teamid stocké)
 * - Svix signature vérifiée proprement (direct verify, sans createMessage)
 * - Env dynamique (detect from memberId 'sb' = test, else live; fallback APP_ENV)
 * - Logs détaillés pour debug
 * - Fix: evtKey sur svix_id pour idempotence robuste
 * - Fix: kvSetEx au lieu de kvSet (match export kv.js)
 * - Fix: String() coerce sur customFields values (num 1 vs '1' mismatch)
 * - Fix: Unwrap data.data pour GET response (MS wrappe single member en {data: {customFields: ...}})
 */

const fetch = require('node-fetch');
const { Webhook } = require('svix');
const { kvGet, kvSetEx } = require('./kv.js');
const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

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
  console.log('[MS] PATCH start', { env, memberId, keyPrefix: String(key).slice(0,6), updates: customFields });
  const r = await fetch(url, {
    method: 'PATCH',
    headers: msHeaders(key),
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  console.log('[MS] PATCH response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) {
    console.error('[MS] PATCH ERROR full', { status: r.status, txt });
    throw new Error(`MS update ${r.status}: ${txt}`);
  }
  console.log('[MS] PATCH OK', { status: r.status });
}
async function msGetMember(env, memberId) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] GET start', { env, memberId, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  console.log('[MS] GET response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) throw new Error(`MS get ${r.status}: ${txt}`);
  let data;
  try {
    data = JSON.parse(txt || '{}');
    data = data.data || data; // Unwrap {data: {customFields: ...}} pour single member
  } catch (e) {
    console.error('[MS] GET parse error', e.message, txt.substring(0,300));
    throw e;
  }
  return data;
}
async function msGetTeam(env, teamIdStr) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/teams/${teamIdStr}`;
  console.log('[MS] getTeam start', { env, teamIdStr, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  console.log('[MS] getTeam response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) throw new Error(`MS getTeam ${r.status}: ${txt}`);
  let data;
  try {
    data = JSON.parse(txt || '{}');
    data = data.data || data;
  } catch (e) {
    console.error('[MS] getTeam parse error', e.message, txt.substring(0,300));
    throw e;
  }
  console.log('[MS] getTeam parsed', { membersCount: (data.members || []).length });
  return data.members || [];
}
function buildFlags(programs, active=true) {
  const set = new Set((programs||[]).map(s => String(s).toLowerCase()));
  const out = {};
  for (const f of FIELD_IDS) out[f] = active && set.has(f) ? '1' : '0';
  return out;
}
/* --- Handler --- */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
  let rawBody;
  try {
    rawBody = await new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
    console.log('[MS] Raw body', { length: rawBody.length, preview: rawBody.substring(0,200) });
  } catch (e) {
    console.error('[MS] Body read error', e.message);
    return res.status(400).send('Invalid request');
  }
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.error('[MS] Parse error', e.message, rawBody.substring(0,300));
    return res.status(400).send('Invalid JSON');
  }
  // Detect env from payload memberId (fallback APP_ENV or 'test')
  const memberId = payload.payload?.memberId || payload.payload?.ownerId || payload.payload?.id || '';
  let env = process.env.APP_ENV || 'test';
  if (memberId) {
    env = memberId.includes('sb') ? 'test' : 'live';
  }
  console.log('[MS] Handler start', { env, detectedFrom: memberId });
  const msWebhookSecret = env === 'live' ? process.env.MS_WEBHOOK_SECRET_LIVE : process.env.MS_WEBHOOK_SECRET_TEST;
  if (!msWebhookSecret) {
    console.error('[MS] Secret missing', { env });
    return res.status(403).send('Missing secret');
  }
  const svix_id = req.headers['svix-id'];
  const svix_timestamp = req.headers['svix-timestamp'];
  const svix_signature = req.headers['svix-signature'];
  console.log('[MS] Svix headers', { svix_id });
  if (!svix_id || !svix_timestamp || !svix_signature) {
    console.error('[MS] Missing Svix headers');
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
    console.error('[MS] Verify error', err.message);
    return res.status(400).send('Invalid signature');
  }
  const type = payload.event;  // Correct for Memberstack payloads
  const evtKey = `ms-processed:${env}:${svix_id}`;
  const processed = await kvGet(evtKey);
  if (processed) {
    console.log('[MS] Already processed', processed, 'skip');
    return res.status(200).send();
  }
  const payloadData = evt.data || {};
  const teamId = payloadData.teamId;
  const ownerId = payloadData.ownerId;
  const newMemberId = payloadData.memberId;
  const updatedMemberId = payloadData.id;
  console.log('[MS] Event', { type, teamId, ownerId, newMemberId, updatedMemberId });
  try {
    if (type === 'team.member.added') {
      console.log('[MS] Added event', { newMemberId, ownerId });
      let owner;
      try {
        owner = await msGetMember(env, ownerId);
      } catch (e) {
        console.error('[MS] msGetMember owner error', { ownerId, eMessage: e.message });
        await kvSetEx(evtKey, 1, 3600);
        return res.status(200).send();
      }
      const customFields = owner.customFields || {};
      const programs = FIELD_IDS.filter(f => String(customFields[f] || '0') === '1');
      const club = String(customFields.club || '');
      const teamIdStr = String(teamId || '');
      console.log('[MS] Owner fields', { ownerId, programs: programs.join(','), club, teamid: customFields.teamid });
      if (newMemberId) {
        const updates = {
          ...buildFlags(programs, true),
          teamowner: '0',
          club: club,
          teamid: teamIdStr
        };
        console.log('[MS] Updating new member', { newMemberId, updates });
        await msPatchMember(env, newMemberId, updates);
        console.log(`[MS] Added/updated ${newMemberId}`);
      }
      // Set teamid sur l'owner s'il n'est pas déjà set (one-time)
      if (!customFields.teamid) {
        console.log('[MS] Setting teamid on owner (missing)');
        await msPatchMember(env, ownerId, { teamid: String(teamId) });
        console.log(`[MS] Set teamid=${teamId} on owner=${ownerId}`);
      }
    } else if (type === 'team.member.removed') {
      console.log('[MS] Removed event', { newMemberId });
      if (newMemberId) {
        await msPatch
