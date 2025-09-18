/**
 * /api/ms-webhook.js
 * Memberstack team events → copie customFields de l'owner vers team member
 * - Event: team.member.added (acception invitation) → copie SEULEMENT programs flags + teamowner='0'
 * - Event: team.member.removed → deactivate (flags à '0')
 * - Utilise msGetMember / msPatchMember (comme stripe-webhook)
 * - Svix signature pour sécurité (MS_WEBHOOK_SECRET_TEST pour test)
 * - KV optionnel pour idempotence
 *
 * ⚠️ Next.js: export const config = { api: { bodyParser: false } };
 */

const fetch = require('node-fetch');
const Svix = require('svix');  // npm i svix (si pas déjà)
const { kvGet, kvSet } = require('./kv.js');  // Pour idempotence

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];

/* --- Utils (copiés/alignés de stripe-webhook.js) --- */
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
  console.log('[MS] GET member', { env, memberId, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`MS get ${r.status}: ${txt}`);
  const data = JSON.parse(txt || '{}');
  console.log('[MS] Raw response for member:', data);  // Log temp pour debug customFields
  return data;  // { id, customFields: { ... }, ... }
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
  const out = { teamowner: active ? '1' : '0' };  // Aligné sur ton nom 'teamowner'
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
  const svix_id = headers['svix-id'];
  const svix_timestamp = headers['svix-timestamp'];
  const svix_signature = headers['svix-signature'];

  // Force env 'test' comme demandé
  const env = 'test';
  const msWebhookSecret = process.env.MS_WEBHOOK_SECRET_TEST;  // Utilise _TEST pour test
  if (!msWebhookSecret) {
    console.error('MS webhook secret missing for env=test: MS_WEBHOOK_SECRET_TEST');
    return res.status(500).send('MS_WEBHOOK_SECRET_TEST missing');
  }
  console.log('[MS] Using webhook secret for env=test (prefix:', msWebhookSecret.slice(0,6), ')');

  let event;
  try {
    const wh = new Svix(msWebhookSecret);
    const headerPayload = svix_id ? `${svix_id} > ${svix_timestamp}` : '';
    const body = Buffer.from(payloadStr);
    event = wh.verify(body, svix_signature, headerPayload ? Buffer.from(headerPayload) : undefined);
  } catch (e) {
    console.error('MS webhook signature error:', e.message);
    return res.status(400).send('Webhook signature error');
  }

  const fullPayload = JSON.parse(payloadStr);
  console.log('[MS] Full payload received:', fullPayload);
  const type = fullPayload.event;  // 'team.member.added'
  const { memberId: newMemberId, ownerId, teamId } = fullPayload.payload || {};
  console.log('=== MS WEBHOOK START ===', { event: type, timestamp: fullPayload.timestamp, memberId: newMemberId, ownerId, teamId, fullPayloadKeys: Object.keys(fullPayload.payload || {}) });

  const evtKey = `ms-processed:${env}:${fullPayload.id || Date.now()}`;  // Idempotence
  if (await kvGet(evtKey)) {
    console.log('[MS] Already processed, skip');
    return res.status(200).send();
  }

  try {
    if (type === 'team.member.added') {
      if (!newMemberId || !ownerId) {
        console.log('[MS] Missing memberId or ownerId -> skip');
        await kvSet(evtKey, 1, 3600);
        return res.status(200).send();
      }

      // Fetch owner
      let principal;
      try {
        principal = await msGetMember(env, ownerId);
      } catch (e) {
        console.error('[MS] Failed to fetch principal:', e.message);
        await kvSet(evtKey, 1, 3600);
        return res.status(200).send();
      }

      const customFields = principal.customFields || {};
      console.log('[MS] Principal fetched:', { customFields, full: principal.customFields });  // Focus sur fields

      // Check owner valide
      const teamOwnerFlag = customFields.teamowner === '1';  // Aligné sur ton nom
      const hasPrograms = FIELD_IDS.some(f => customFields[f] === '1');
      if (!teamOwnerFlag || !hasPrograms) {
        console.error('[MS] No principal or teamowner != "1" or no fields -> manual review', { ownerId, teamOwnerFlag, hasPrograms, customFields });
        await kvSet(evtKey, 1, 3600);
        return res.status(200).send();
      }

      // Copie SEULEMENT les programs flags de l'owner + force teamowner='0'
      const updates = { teamowner: '0' };
      for (const f of FIELD_IDS) {
        updates[f] = customFields[f] || '0';  // Copie valeur exacte de l'owner (string '1' ou '0')
      }
      await msPatchMember(env, newMemberId, updates);
      console.log(`[MS] Copied programs fields to team member=${newMemberId} from owner=${ownerId}, team=${teamId}`);

    } else if (type === 'team.member.removed') {
      console.log('[MS] Handling removal for', newMemberId);
      if (newMemberId) {
        await msPatchMember(env, newMemberId, buildFlags([], false));  // Tout à '0' (programs + teamowner)
        console.log(`[MS] Deactivated removed member=${newMemberId}, team=${teamId}`);
      } else {
        console.log('[MS] Skip removed: no memberId');
      }

    } else {
      console.log('[MS] Skip non-team event:', type);
    }

    await kvSet(evtKey, 1, 30 * 24 * 3600);  // Marque processed long-term
    console.log('=== MS WEBHOOK END (SUCCESS) ===');
    return res.status(200).send();

  } catch (err) {
    console.error('=== MS WEBHOOK ERROR ===', err.message);
    if (err.stack) console.error(err.stack);
    await kvSet(evtKey, 1, 3600);  // Marque même en error pour éviter spam
    console.log('=== MS WEBHOOK END (ERROR) ===');
    return res.status(500).send('Handler error');
  }
};

/*
export const config = {
  api: { bodyParser: false }
};
*/
