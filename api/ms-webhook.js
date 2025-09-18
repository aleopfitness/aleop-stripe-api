/**
 * /api/ms-webhook.js
 * Memberstack webhook → sur member.created (invite acceptée), copy customFields du principal (fetch live MS)
 * - List all members, filter planId + isPrincipal='1' pour principal
 * - Copy fields (sans isPrincipal) au new member
 * - Setup : MS dashboard > Webhooks > Add /api/ms-webhook, event member.created
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
async function msGetAllMembers(env){
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members`;
  console.log('[MS] GET all members', { env, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`MS list ${r.status}: ${txt}`);
  const d = JSON.parse(txt || '{}');
  return d.data || [];
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

/* --- Handler --- */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  let body;
  try {
    body = typeof req.body === 'object' ? req.body : JSON.parse(req.body || '{}');
  } catch(e) {
    console.error('MS body parse error:', e);
    return res.status(400).send('Invalid body');
  }

  const { event, timestamp, payload } = body;
  console.log('=== MS WEBHOOK START ===', { event, timestamp, newMemberId: payload?.id, planId: payload?.priceId || payload?.planId });

  if (event !== 'member.created') {
    console.log('[MS] Skip non-created event:', event);
    return res.status(200).send();
  }

  const ENV = 'test';  // Assume test ; tweak si MS passe livemode (payload.livemode ? 'live' : 'test')
  const newMemberId = payload.id;
  const newPlanId = payload.priceId || payload.planId;  // Assume priceId in payload (adjust si planId)

  if (!newMemberId || !newPlanId) {
    console.log('[MS] Missing id/planId -> skip');
    return res.status(200).send();
  }

  // Idempotence : Check si déjà synced (fetch new member fields, if syncedAt exists, skip)
  const newMember = await msGetAllMembers(ENV).then(members => members.find(m => m.id === newMemberId));
  if (newMember && newMember.customFields && newMember.customFields.syncedAt) {
    console.log('[MS] Already synced (syncedAt exists), skip');
    return res.status(200).send();
  }

  try {
    // Check si team plan (tes priceIds)
    if (!newPlanId.includes('-2-') && !newPlanId.includes('-3-') && !newPlanId.includes('-4-') && !newPlanId.includes('-5-') && !newPlanId.includes('-6-') && !newPlanId.includes('-7-') && !newPlanId.includes('-8-') && !newPlanId.includes('-9-')) {
      console.log('[MS] Not team plan -> skip sync');
      return res.status(200).send();
    }

    // List all members
    const allMembers = await msGetAllMembers(ENV);
    console.log('[MS] Fetched', allMembers.length, 'members');

    // Find team members for this plan
    const teamMembers = allMembers.filter(m => m.memberships && m.memberships.some(mem => mem.priceId === newPlanId));
    console.log('[MS] Team members for planId', newPlanId, ':', teamMembers.length);

    // Find principal : isPrincipal='1'
    const principal = teamMembers.find(m => m.customFields && m.customFields.isPrincipal === '1');
    console.log('[MS] Principal found:', principal ? principal.id : 'MISS');

    if (!principal || !principal.customFields) {
      console.error('[MS] No principal found or no fields -> manual review');
      return res.status(200).send();
    }

    // Copy fields sans isPrincipal
    const fieldsToCopy = { ...principal.customFields };
    delete fieldsToCopy.isPrincipal;
    fieldsToCopy.syncedAt = Date.now().toString();  // For idempotence
    console.log('[MS] Fields to copy:', fieldsToCopy);

    // Patch new member
    await msPatchMember(ENV, newMemberId, fieldsToCopy);

    console.log(`[SUCCESS] Synced fields to new member ${newMemberId} from principal ${principal.id}`);
    console.log('=== MS WEBHOOK END (SUCCESS) ===');
    return res.status(200).send();

  } catch(err) {
    console.error('=== MS WEBHOOK ERROR ===', err && err.message ? err.message : err);
    if (err && err.stack) console.error(err.stack);
    console.log('=== MS WEBHOOK END (ERROR) ===');
    return res.status(500).send('Handler error');
  }
};
