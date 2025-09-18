/**
 * /api/ms-webhook.js
 * Memberstack team events → copie customFields de l'owner vers team member
 * - Event: team.member.added → copie SEULEMENT programs flags + teamowner='0' + club (nommé par owner)
 * - Event: team.member.removed → deactivate
 * - Event: member.updated → si owner et club changé, remplace club sur tous les coaches associés (team members)
 * - Svix signature vérifiée proprement (direct verify, sans createMessage)
 * - Env forcé 'test'
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
    data = data.data || data; // Unwrap {data: {customFields: ...}} pour single member
  } catch (e) {
    console.error('[MS] GET parse error', e.message, txt.substring(0,300));
    throw e;
  }
  const fields = data.customFields || {};
  console.log('[MS] GET parsed fields', { memberId, fieldsPreview: Object.keys(fields), fields: fields });
  return data;
}
async function msGetTeamsForMember(env, memberId) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/members/${memberId}/teams`;
  console.log('[MS] GET teams for member start', { env, memberId, keyPrefix: String(key).slice(0,6) });
  const r = await fetch(url, { headers: msHeaders(key) });
  const txt = await r.text();
  console.log('[MS] GET teams response raw', { status: r.status, txtLength: txt.length, txtPreview: txt.substring(0,200) });
  if (!r.ok) throw new Error(`MS get teams ${r.status}: ${txt}`);
  let data;
  try {
    data = JSON.parse(txt || '[]');
    data = data.data || data; // Unwrap si array wrapped
  } catch (e) {
    console.error('[MS] GET teams parse error', e.message, txt.substring(0,300));
    throw e;
  }
  const teamIds = data.map(t => t.id || t.teamId).filter(Boolean);
  console.log('[MS] GET teams parsed', { memberId, teamCount: teamIds.length, teamIds });
  return teamIds[0]; // Assume 1 team ; fallback first
}
async function msListTeamMembers(env, teamId) {
  const key = msApiKey(env);
  if (!key) throw new Error(`Missing Memberstack API key for env=${env}`);
  const url = `https://admin.memberstack.com/teams/${teamId}/members`;
  console.log('[MS] List team members start', { env
