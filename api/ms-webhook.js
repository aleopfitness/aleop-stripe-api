/**
 * /api/ms-webhook.js
 * Memberstack team events → copie customFields de l'owner vers team member
 * - Event: team.member.added → copie SEULEMENT programs flags +...='0' + club (nommé par owner) + teamid (pour propagation future)
 * - Event: team.member.removed → deactivate
 * - Event: member.updated → si owner update club, propage à tous les members de la team (via teamid stocké)
 * - Svix signature vérifiée proprement (direct verify, sans createMessage)
 * - Env auto via signature (LIVE→TEST)
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
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
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
    data = data.data || data; // unwrap
  } catch (e) {
    console.error('[MS] GET parse error', e.message, txt.substring(0,300));
    throw e;
  }
  console.log('[MS] GET parsed', { memberId, hasCustomFields: !!data.customFields });
  return data;
}
async function msGetAllMembers(env) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members`;
  console.log('[MS] GET ALL start', { env, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  console.log('[MS] GET ALL response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) throw new Error(`MS get members ${r.status}: ${txt}`);
  let data;
  try {
    data = JSON.parse(txt || '{}');
    data = data.data || data; // unwrap
  } catch (e) {
    console.error('[MS] GET ALL parse error', e.message, txt.substring(0,300));
    throw e;
  }
  const arr = Array.isArray(data) ? data : [];
  console.log('[MS] GET ALL parsed', { count: arr.length });
  return arr;
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
function buildFlags(programs, active = true) {
  const set = new Set((programs || []).map(s => String(s).toLowerCase()));
  const out = { teamowner: active ? '1' : '0' };
  for (const f of FIELD_IDS) out[f] = active && set.has(f) ? '1' : '0';
  return out;
}

/* --- Handler --- */
module.exports = async (req, res) => {
  console.log('[MS] Handler start', { method: req.method, url: req.url });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-signature, svix-timestamp');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  // Raw body (needed for Svix)
  let raw;
  try {
    raw = await readRawBody(req);
    console.log('[MS] Raw body received', { length: raw.length, preview: raw.toString().substring(0,200) });
  } catch (e) {
    console.error('[MS] readRawBody error', e.message);
    return res.status(400).send('Invalid body');
  }
  const payloadStr = raw.toString();

  // Headers
  const headers = req.headers;
  const svix_signature = headers['svix-signature'];
  const svix_timestamp = headers['svix-timestamp'];
  const svix_id = headers['svix-id'];
  console.log('[MS] Svix headers', { svix_id: svix_id ? svix_id.substring(0,20) + '...' : 'MISSING', svix_timestamp, sigPresent: !!svix_signature });

  // --- Detect env by verifying Svix signature with LIVE first, then TEST ---
  let env = 'live';
  let msWebhookSecret = process.env.MS_WEBHOOK_SECRET_LIVE;
  let event;
  const headersObj = {
    'svix-id': svix_id,
    'svix-timestamp': svix_timestamp,
    'svix-signature': svix_signature
  };
  try {
    if (!msWebhookSecret) throw new Error('Missing LIVE secret');
    event = new Webhook(msWebhookSecret).verify(Buffer.from(payloadStr, 'utf-8'), headersObj);
    console.log('[MS] Signature verified with LIVE secret');
  } catch (eLive) {
    console.warn('[MS] LIVE verify failed, trying TEST:', eLive.message);
    env = 'test';
    msWebhookSecret = process.env.MS_WEBHOOK_SECRET_TEST;
    try {
      if (!msWebhookSecret) throw new Error('Missing TEST secret');
      event = new Webhook(msWebhookSecret).verify(Buffer.from(payloadStr, 'utf-8'), headersObj);
      console.log('[MS] Signature verified with TEST secret');
    } catch (eTest) {
      console.error('[MS] Svix verify failed for both LIVE and TEST', { eLive: eLive.message, eTest: eTest.message });
      return res.status(400).send('Webhook signature error');
    }
  }

  // Parse final payload
  const fullPayload = JSON.parse(payloadStr);
  console.log('[MS] Full payload parsed', { event: fullPayload.event, timestamp: fullPayload.timestamp, fullPayloadId: fullPayload.id });

  const type = fullPayload.event;
  const payloadData = fullPayload.payload || {};

  // Idempotence key
  const evtKey = `ms-processed:${env}:${svix_id}`;
  const already = await kvGet(evtKey);
  if (already) {
    console.log('[MS] Already processed, skip', { evtKey });
    return res.status(200).send();
  }

  try {
    let newMemberId, ownerId, teamId, updatedMemberId;

    if (type === 'team.member.added' || type === 'team.member.removed') {
      ({ 
        memberId: newMemberId, 
        ownerId, 
        teamId 
      } = payloadData || {});
    } else if (type === 'member.updated') {
      updatedMemberId = (payloadData || {}).id;
    }

    console.log('=== MS WEBHOOK START ===', { env, event: type, newMemberId, ownerId, teamId, updatedMemberId });

    if (type === 'team.member.added') {
      if (!ownerId || !newMemberId) {
        console.log('[MS] Missing IDs on team.member.added', { ownerId, newMemberId });
        await kvSetEx(evtKey, 1, 3600);
        return res.status(200).send();
      }
      // Read owner to copy his flags + club + teamid
      const owner = await msGetMember(env, ownerId);
      const cf = owner.customFields || {};
      const programs = FIELD_IDS.filter(id => String(cf[id]) === '1');
      const flags = buildFlags(programs, true);
      if (cf.club) flags.club = String(cf.club);
      if (teamId) flags.teamid = String(teamId);
      console.log('[MS] PATCH new member with owner flags', { newMemberId, ownerId, teamId, flagsPreview: Object.keys(flags) });
      await msPatchMember(env, newMemberId, flags);
    } else if (type === 'team.member.removed') {
      if (!newMemberId) {
        console.log('[MS] Missing memberId on team.member.removed');
        await kvSetEx(evtKey, 1, 3600);
        return res.status(200).send();
      }
      const flags = buildFlags([], false);
      flags.club = ''; flags.teamid = '';
      console.log('[MS] Deactivate removed member', { newMemberId });
      await msPatchMember(env, newMemberId, flags);
    } else if (type === 'member.updated') {
      // (Optionnel selon tes réglages d’événements — laissé identique à ta base)
      if (!updatedMemberId) {
        console.log('[MS] Missing updatedMemberId in member.updated');
        await kvSetEx(evtKey, 1, 3600);
        return res.status(200).send();
      }
      const updated = await msGetMember(env, updatedMemberId);
      const cf = updated.customFields || {};
      if (String(cf.teamowner) === '1' && cf.teamid && cf.club) {
        // propage club au reste de la team
        const all = await msGetAllMembers(env);
        const targets = all.filter(m => String(m?.customFields?.teamid || '') === String(cf.teamid) && m.id !== updatedMemberId);
        console.log('[MS] Propagate club to team members', { teamid: cf.teamid, count: targets.length });
        for (const m of targets) {
          await msPatchMember(env, m.id, { club: String(cf.club) });
        }
      } else {
        console.log('[MS] Skip member.updated (not owner or no club/teamid)', { teamowner: cf.teamowner, hasClub: !!cf.club, hasTeamid: !!cf.teamid });
      }
    } else {
      console.log('[MS] Skip unrelated event', type);
    }

    await kvSetEx(evtKey, 1, 30 * 24 * 3600);
    console.log('=== MS WEBHOOK END (SUCCESS) ===');
    return res.status(200).send();
  } catch (err) {
    console.error('=== MS WEBHOOK ERROR full ===', { message: err.message, stack: err.stack });
    await kvSetEx(evtKey, 1, 3600);
    return res.status(500).send('Handler error');
  }
};
