/**
 * /api/ms-webhook.js
 * Memberstack team events → copie customFields de l'owner vers team member
 * - Event: team.member.added → copie SEULEMENT programs flags + teamowner='0'
 * - Event: team.member.removed → deactivate
 * - Svix signature vérifiée proprement (direct verify, sans createMessage)
 * - Env forcé 'test'
 * - Logs détaillés pour debug
 * - Fix: evtKey sur svix_id pour idempotence robuste
 * - Fix: kvSetEx au lieu de kvSet (match export kv.js)
 */

const fetch = require('node-fetch');
const { Webhook } = require('svix');
const { kvGet, kvSetEx } = require('./kv.js');  // Fix: kvSetEx importé
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
  } catch (e) {
    console.error('[MS] GET parse error', e.message, txt.substring(0,300));
    throw e;
  }
  const fields = data.customFields || {};
  console.log('[MS] GET parsed fields', { memberId, fieldsPreview: Object.keys(fields), fields: fields });
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
  console.log('[MS] Handler start', { method: req.method, url: req.url });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, svix-signature, svix-timestamp');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let raw;
  try { 
    raw = await readRawBody(req); 
    console.log('[MS] Raw body received', { length: raw.length, preview: raw.toString().substring(0,200) });
  } catch (e) { 
    console.error('[MS] readRawBody error', e.message);
    return res.status(400).send('Invalid body'); 
  }

  const payloadStr = raw.toString();
  const headers = req.headers;
  console.log('[MS] All headers received', { headers: Object.keys(headers).map(k => ({ k, v: String(headers[k]).substring(0,50) + '...' })) });
  const svix_signature = headers['svix-signature'];
  const svix_timestamp = headers['svix-timestamp'];
  const svix_id = headers['svix-id'];
  console.log('[MS] Svix headers', { svix_id: svix_id ? svix_id.substring(0,20) + '...' : 'MISSING', svix_timestamp, svix_signature: svix_signature ? svix_signature.substring(0,50) + '...' : 'MISSING' });

  const env = 'test';  // Forcé
  const msWebhookSecret = process.env.MS_WEBHOOK_SECRET_TEST;
  if (!msWebhookSecret) {
    console.error('[MS] Secret missing', { env });
    return res.status(500).send('MS_WEBHOOK_SECRET_TEST missing');
  }
  console.log('[MS] Using secret for env=test (prefix:', msWebhookSecret.slice(0,6), ')');

  let event;
  try {
    const wh = new Webhook(msWebhookSecret);
    const payload = Buffer.from(payloadStr, 'utf-8');
    const headersObj = {
      'svix-id': svix_id,
      'svix-timestamp': svix_timestamp,
      'svix-signature': svix_signature
    };
    console.log('[MS] Svix headers obj', headersObj);
    event = wh.verify(payload, headersObj);
    console.log('[MS] Signature verified OK', { eventType: event.type });
  } catch (e) {
    console.error('[MS] Svix verify error full', { message: e.message, stack: e.stack, headers: { svix_id, svix_timestamp, svix_signature: svix_signature ? 'PRESENT' : 'MISSING' } });
    return res.status(400).send('Webhook signature error');
  }

  const fullPayload = JSON.parse(payloadStr);
  console.log('[MS] Full payload parsed', { event: fullPayload.event, payloadKeys: Object.keys(fullPayload.payload || {}), timestamp: fullPayload.timestamp, fullPayloadId: fullPayload.id });
  const type = fullPayload.event;
  const { memberId: newMemberId, ownerId, teamId } = fullPayload.payload || {};
  console.log('=== MS WEBHOOK START ===', { event: type, newMemberId, ownerId, teamId });

  const evtKey = `ms-processed:${env}:${svix_id}`;
  const processed = await kvGet(evtKey);
  if (processed) {
    console.log('[MS] Already processed (KV value:', processed, '), skip');
    return res.status(200).send();
  }

  try {
    if (type === 'team.member.added') {
      if (!newMemberId || !ownerId) {
        console.log('[MS] Missing IDs', { newMemberId, ownerId });
        await kvSetEx(evtKey, 1, 3600);  // Fix: kvSetEx
        return res.status(200).send();
      }

      let principal;
      try {
        principal = await msGetMember(env, ownerId);
      } catch (e) {
        console.error('[MS] msGetMember error', { ownerId, eMessage: e.message });
        await kvSetEx(evtKey, 1, 3600);  // Fix: kvSetEx
        return res.status(200).send();
      }

      const customFields = principal.customFields || {};
      console.log('[MS] Owner fields detailed', { ownerId, teamowner: customFields.teamowner, programs: FIELD_IDS.map(f => ({ f, value: customFields[f] })) });

      const teamOwnerFlag = customFields.teamowner === '1';
      const hasPrograms = FIELD_IDS.some(f => customFields[f] === '1');
      if (!teamOwnerFlag || !hasPrograms) {
        console.error('[MS] Owner invalid', { ownerId, teamOwnerFlag, hasPrograms, customFieldsKeys: Object.keys(customFields) });
        console.log('[MS] Skipping copy - set teamowner=\'1\' + program flag on owner for test');
        await kvSetEx(evtKey, 1, 3600);  // Fix: kvSetEx
        return res.status(200).send();
      }

      // Copie programs + teamowner='0'
      const updates = { teamowner: '0' };
      for (const f of FIELD_IDS) {
        updates[f] = customFields[f] || '0';
      }
      console.log('[MS] Updates built', updates);
      await msPatchMember(env, newMemberId, updates);
      console.log(`[MS] Copied to new member=${newMemberId} from owner=${ownerId}`);

    } else if (type === 'team.member.removed') {
      console.log('[MS] Removed event', { newMemberId });
      if (newMemberId) {
        await msPatchMember(env, newMemberId, buildFlags([], false));
        console.log(`[MS] Deactivated ${newMemberId}`);
      }

    } else {
      console.log('[MS] Skip event', type);
    }

    await kvSetEx(evtKey, 1, 30 * 24 * 3600);  // Fix: kvSetEx
    console.log('=== MS WEBHOOK END (SUCCESS) ===');
    return res.status(200).send();

  } catch (err) {
    console.error('=== MS WEBHOOK ERROR full ===', { message: err.message, stack: err.stack });
    await kvSetEx(evtKey, 1, 3600);  // Fix: kvSetEx
    return res.status(500).send('Handler error');
  }
};
