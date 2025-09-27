/**
 * /api/member-updated.js
 * Dédié à member.updated → propage club de teamowner à la team
 * - Résout ID via email si manquant
 * - Check teamowner='1' + club + teamid
 * - Propagé via list all members + filter by teamid (fix 404 on /teams/{id})
 * - Svix + KV idempotence
 * - Env détecté from memberId ('sb' = test, else live; fallback APP_ENV)
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
  // Detect env from payload memberId (fallback APP_ENV or 'test')
  const memberId = payload.payload?.id || payload.payload?.auth?.email || '';
  let env = process.env.APP_ENV || 'test';
  if (memberId) {
    env = memberId.includes('sb') ? 'test'
