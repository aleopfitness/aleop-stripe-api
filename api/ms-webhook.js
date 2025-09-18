// /api/ms-webhook.js
const fetch = require('node-fetch');
const Svix = require('svix');  // npm i svix si pas installé

/* --- Utils (copie de stripe-webhook.js) --- */
function msApiKey(env) {
  return env === 'live' ? process.env.MEMBERSTACK_API_KEY_LIVE : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
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
  return data;  // { id, customFields, ... }
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

const FIELD_IDS = ['athletyx','booty','upper','flow','fight','cycle','force','cardio','mobility'];
function buildFlags(programs, active = true) {
  const set = new Set((programs || []).map(s => String(s).toLowerCase()));
  const out = { team_owner: active ? '1' : '0' };  // Ajoute team_owner
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

  const payload = raw.toString();
  const headers = req.headers;
  const svix_id = headers['svix-id'];
  const svix_timestamp = headers['svix-timestamp'];
  const svix_signature = headers['svix-signature'];

  let event;
  try {
    if (!process.env.MS_WEBHOOK_SECRET) throw new Error('MS_WEBHOOK_SECRET missing');
    const wh = new Svix(process.env.MS_WEBHOOK_SECRET);
    const headerPayload = svix_id ? `${svix_id} > ${svix_timestamp}` : '';
    const body = Buffer.from(payload);
    event = wh.verify(body, svix_signature, headerPayload ? Buffer.from(headerPayload) : undefined);
  } catch (e) {
    console.error('MS webhook signature error:', e.message);
    return res.status(400).send('Webhook signature error');
  }

  const fullPayload = JSON.parse(payload);
  console.log('[MS] Full payload received:', fullPayload);
  const type = fullPayload.event;  // 'team.member.added' etc.
  const env = 'test';  // Ou détecte de fullPayload si possible
  const { memberId: newMemberId, ownerId, teamId } = fullPayload.payload || {};
  console.log('=== MS WEBHOOK START ===', { event: type, timestamp: fullPayload.timestamp, memberId: newMemberId, ownerId, teamId, fullPayloadKeys: Object.keys(fullPayload.payload || {}) });

  try {
    if (type === 'team.member.added') {
      if (!newMemberId || !ownerId) {
        console.log('[MS] Missing memberId or ownerId -> skip');
        return res.status(200).send();
      }

      // Fetch owner (principal)
      let principal;
      try {
        principal = await msGetMember(env, ownerId);
      } catch (e) {
        console.error('[MS] Failed to fetch principal:', e.message);
        return res.status(200).send();  // ACK même si fail
      }

      const customFields = principal.customFields || {};
      console.log('[MS] Principal fetched:', { customFields, full: principal });  // Log full pour debug

      // Check si owner valide (a team_owner: '1' et programs)
      const teamOwnerFlag = customFields.team_owner === '1';
      const hasPrograms = Object.keys(customFields).some(f => FIELD_IDS.includes(f) && customFields[f] === '1');
      if (!teamOwnerFlag || !hasPrograms) {
        console.error('[MS] No principal or teamowner != "1" or no fields -> manual review', { ownerId, teamOwnerFlag, hasPrograms });
        return res.status(200).send();  // Skip mais log pour review
      }

      // Copie les programs flags (garde team_owner='0' pour new member)
      const updates = { ...customFields };
      delete updates.team_owner;  // Enlève pour new member
      updates.team_owner = '0';  // Ou juste set à 0 si pas présent

      await msPatchMember(env, newMemberId, updates);
      console.log(`[MS] Copied fields to team member=${newMemberId} from owner=${ownerId}, team=${teamId}`);

    } else if (type === 'team.member.removed') {
      // Optionnel : Deactivate (set flags à 0)
      if (newMemberId) {
        await msPatchMember(env, newMemberId, buildFlags([], false));  // Tout à 0
        console.log(`[MS] Deactivated removed member=${newMemberId}, team=${teamId}`);
      } else {
        console.log('[MS] Skip removed: no memberId');
      }

    } else {
      console.log('[MS] Skip non-team event:', type);
    }

    return res.status(200).send();

  } catch (err) {
    console.error('MS webhook handler error:', err.message);
    if (err.stack) console.error(err.stack);
    return res.status(500).send('Handler error');
  }
};

/*
export const config = { api: { bodyParser: false } };  // Si Next.js
*/
