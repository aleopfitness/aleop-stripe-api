/**
 * /api/ms-webhook.js
 * Memberstack webhook → sur team.member.added (invite coach acceptée), copy customFields du principal (fetch live MS)
 * - payload.memberId = new coach, payload.ownerId = principal direct
 * - Fetch principal fields, copy to new (sans teamowner)
 * - Test mode : ?test=1&newMemberId=mem_...&ownerId=mem_... pour simuler
 * - Setup : MS dashboard > Webhooks > Add /api/ms-webhook, event team.member.added
 */

const fetch = require('node-fetch');

/* --- SECRETS --- */
function msApiKey(env){
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}
function msHeaders(key){
  return { 'X-API-KEY': key, 'Content-Type':'application/json' };
}

/* --- MS API --- */
async function msGetMember(env, memberId){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] GET member', { env, memberId, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok) {
    if (r.status === 404) return null;
    throw new Error(`MS GET ${r.status}: ${txt}`);
  }
  const d = JSON.parse(txt || '{}');
  return d || null;
}

async function msPatchMember(env, memberId, customFields){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}`;
  console.log('[MS] PATCH', { env, memberId, keyPrefix: String(key).slice(0,6), fields: Object.keys(customFields) });
  const r = await fetch(url, {
    method: 'PATCH',
    headers: msHeaders(key),
    body: JSON.stringify({ customFields })
  });
  const txt = await r.text();
  if (!r.ok){
    console.error('[MS] PATCH ERROR', r.status, txt.substring(0,300));
    throw new Error(`MS update ${r.status}: ${txt}`);
  }
  console.log('[MS] PATCH OK', { status: r.status });
}

/* --- Test Mode --- */
async function testSync(req) {
  const url = new URL(req.url, 'http://x');
  const newMemberId = url.searchParams.get('newMemberId');
  const ownerId = url.searchParams.get('ownerId');
  if (!newMemberId || !ownerId) return { ok: false, error: 'Missing ?newMemberId=mem_...&ownerId=mem_...' };
  console.log('[TEST] Simulating sync for newMemberId:', newMemberId, 'ownerId:', ownerId);
  const ENV = 'test';
  const principal = await msGetMember(ENV, ownerId);
  if (!principal || !principal.customFields) return { ok: false, error: 'Principal not found or no fields' };
  const fieldsToCopy = { ...principal.customFields };
  delete fieldsToCopy.teamowner;
  fieldsToCopy.syncedAt = Date.now().toString();
  console.log('[TEST] Fields to copy:', fieldsToCopy);
  // Simulate PATCH (no real, for test)
  return { ok: true, simulated: true, principalFields: principal.customFields, copyFields: fieldsToCopy };
}

/* --- Handler --- */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST' && req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  // Test mode
  if (req.method === 'GET' && req.url.includes('test=1')) {
    const result = await testSync(req);
    return res.status(result.ok ? 200 : 400).json(result);
  }

  let body;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
    console.log('[MS] Full payload received:', JSON.stringify(body, null, 2));  // Full log
  } catch(e) {
    console.error('MS body parse error:', e);
    return res.status(400).send('Invalid body');
  }

  const { event, timestamp, payload } = body;
  console.log('=== MS WEBHOOK START ===', { event, timestamp, memberId: payload?.memberId, ownerId: payload?.ownerId, teamId: payload?.teamId, fullPayloadKeys: Object.keys(payload || {}) });

  if (event !== 'team.member.added') {
    console.log('[MS] Skip non-team.added event:', event);
    return res.status(200).send();
  }

  const ENV = 'test';  // Default
  const newMemberId = payload.memberId;  // From schema
  const ownerId = payload.ownerId;  // Principal direct !
  const teamId = payload.teamId;  // Log
  console.log('[MS] Parsed newMemberId:', newMemberId, 'ownerId (principal):', ownerId, 'teamId:', teamId);

  if (!newMemberId || !ownerId) {
    console.log('[MS] Missing memberId or ownerId -> skip');
    return res.status(200).send();
  }

  try {
    // Fetch principal
    const principal = await msGetMember(ENV, ownerId);
    console.log('[MS] Principal fetched:', principal ? principal.id : 'MISS', 'customFields full:', principal?.customFields);  // Log full for debug

    if (!principal || !principal.customFields || principal.customFields.teamowner !== '1') {
      console.error('[MS] No principal or teamowner != "1" or no fields -> manual review');
      return res.status(200).send();
    }

    // Idempotence : Fetch new member, skip if syncedAt exists
    const newMember = await msGetMember(ENV, newMemberId);
    if (newMember && newMember.customFields && newMember.customFields.syncedAt) {
      console.log('[MS] Already synced (syncedAt exists), skip');
      return res.status(200).send();
    }

    // Copy fields sans teamowner
    const fieldsToCopy = { ...principal.customFields };
    delete fieldsToCopy.teamowner;
    fieldsToCopy.syncedAt = Date.now().toString();  // For idempotence
    console.log('[MS] Fields to copy:', fieldsToCopy);

    // Patch new member
    await msPatchMember(ENV, newMemberId, fieldsToCopy);

    console.log(`[SUCCESS] Synced fields to new member ${newMemberId} from principal ${ownerId}`);
    console.log('=== MS WEBHOOK END (SUCCESS) ===');
    return res.status(200).send();

  } catch(err) {
    console.error('=== MS WEBHOOK ERROR ===', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    console.log('=== MS WEBHOOK END (ERROR) ===');
    return res.status(500).send('Handler error');
  }
};
