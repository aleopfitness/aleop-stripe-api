/**
 * /api/ms-webhook.js
 * Memberstack team events → copie customFields de l'owner vers team member
 * - Event: team.member.added → copie SEULEMENT programs flags + teamowner='0'
 * - Event: team.member.removed → deactivate
 * - Svix signature vérifiée proprement
 * - Env forcé 'test'
 */

const fetch = require('node-fetch');
const { Webhook } = require('svix');  // Correct import (Webhook constructor)
const { kvGet, kvSet } = require('./kv.js');

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
  console.log('[MS] PATCH', { env, memberId, keyPrefix: String(key).slice(0,6), fields: customFields });
  const r = await fetch(url, {
    method: 'PATCH',
    headers: msHeaders(key),
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  if (!r.ok) {
    console.error('[MS] PATCH ERROR', r.status, txt.substring(0,300));
    throw new Error(`MS update ${r.status}: ${txt}`);
  }
  console.log('[MS] PATCH OK', { status: r.status });
}
async function msGetMember(env, memberId) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] GET member (potential bandit owner)', { env, memberId, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`MS get ${r.status}: ${txt}`);
  const data = JSON.parse(txt || '{}');
  console.log('[MS] Raw response for owner:', data.customFields || 'no fields');
  return data;
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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-signature, svix-timestamp');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let raw;
  try { raw = await readRawBody(req); } catch (e) { return res.status(400).send('Invalid body'); }

  const payloadStr = raw.toString();
  const headers = req.headers;
  const svix_signature = headers['svix-signature'];
  const svix_timestamp = headers['svix-timestamp'];

  const env = 'test';  // Forcé
  const msWebhookSecret = process.env.MS_WEBHOOK_SECRET_TEST;
  if (!msWebhookSecret) {
    console.error('MS webhook secret missing: MS_WEBHOOK_SECRET_TEST');
    return res.status(500).send('MS_WEBHOOK_SECRET_TEST missing');
  }
  console.log('[MS] Using secret for env=test (prefix:', msWebhookSecret.slice(0,6), ')');

  let event;
  try {
    const wh = new Webhook(msWebhookSecret);  // Correct constructor
    const payload = Buffer.from(payloadStr, 'utf-8');
    const headerPayload = svix_timestamp ? [svix_timestamp, svix_signature] : [svix_signature];
    event = wh.verify(payload, headerPayload);  // Vérif avec headers/timestamp
    console.log('[MS] Signature verified OK');
  } catch (e) {
    console.error('MS webhook signature error:', e.message);
    return res.status(400).send('Webhook signature error');
  }

  const fullPayload = JSON.parse(payloadStr);
  console.log('[MS] Full payload received:', fullPayload);
  const type = fullPayload.event;
  const { memberId: newMemberId, ownerId, teamId } = fullPayload.payload || {};  // newMemberId = masale, ownerId = bandit
  console.log('=== MS WEBHOOK START ===', { event: type, timestamp: fullPayload.timestamp, newMemberId, ownerId, teamId });

  const evtKey = `ms-processed:${env}:${fullPayload.id || Date.now()}`;
  if (await kvGet(evtKey)) {
    console.log('[MS] Already processed, skip');
    return res.status(200).send();
  }

  try {
    if (type === 'team.member.added') {
      if (!newMemberId || !ownerId) {
        console.log('[MS] Missing IDs -> skip');
        await kvSet(evtKey, 1, 3600);
        return res.status(200).send();
      }

      let principal;
      try {
        principal = await msGetMember(env, ownerId);
      } catch (e) {
        console.error('[MS] Failed fetch owner (bandit?):', e.message);
        await kvSet(evtKey, 1, 3600);
        return res.status(200).send();
      }

      const customFields = principal.customFields || {};
      console.log('[MS] Owner fields (bandit):', customFields);

      const teamOwnerFlag = customFields.teamowner === '1';
      const hasPrograms = FIELD_IDS.some(f => customFields[f] === '1');
      if (!teamOwnerFlag || !hasPrograms) {
        console.error('[MS] Owner invalid:', { ownerId, teamOwnerFlag, hasPrograms, customFields });
        await kvSet(evtKey, 1, 3600);
        return res.status(200).send();
      }

      // Copie programs + teamowner='0' pour masale
      const updates = { teamowner: '0' };
      for (const f of FIELD_IDS) {
        updates[f] = customFields[f] || '0';
      }
      await msPatchMember(env, newMemberId, updates);
      console.log(`[MS] Copied programs to masale?=${newMemberId} from bandit?=${ownerId}`);

    } else if (type === 'team.member.removed') {
      if (newMemberId) {
        await msPatchMember(env, newMemberId, buildFlags([], false));
        console.log(`[MS] Deactivated removed=${newMemberId}`);
      }

    } else {
      console.log('[MS] Skip event:', type);
    }

    await kvSet(evtKey, 1, 30 * 24 * 3600);
    console.log('=== MS WEBHOOK END (SUCCESS) ===');
    return res.status(200).send();

  } catch (err) {
    console.error('=== MS WEBHOOK ERROR ===', err.message);
    await kvSet(evtKey, 1, 3600);
    return res.status(500).send('Handler error');
  }
};

/*
export const config = {
  api: { bodyParser: false }
};
*/
