// Backfill Memberstack customFields : teamid, teamowner, club (lookup team from member fiche via planId, generate similar format if missing)
const fetch = require('node-fetch');

function msApiKey(env) {
  return env === 'live'
    ? process.env.MEMBERSTACK_API_KEY_LIVE
    : process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}

module.exports = async (req, res) => {
  try {
    const ENV = 'test'; // Hardcoded test
    const KEY = msApiKey(ENV);
    if (!KEY) throw new Error(`Missing Memberstack API key for env=${ENV}`);

    console.log('Using API key prefix: ' + KEY.slice(0,8)); // Debug

    const API = 'https://admin.memberstack.com'; // Base for member fiche
    const HDR = { 'X-API-KEY': KEY, 'Content-Type': 'application/json' };
    const DRY = true; // Hardcoded true for dry-run
    const CF = { teamId: 'teamid', teamOwner: 'teamowner', club: 'club' }; // Hardcoded

    // Generate similar format teamId (24 lower alphanum chars)
    function generateTeamId() {
      const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
      let id = '';
      for (let i = 0; i < 24; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
      }
      return id;
    }

    // List all members (fiche)
    async function listMembers() {
      const out = [];
      let after;
      do {
        const url = `${API}/members?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        console.log('Fetching members URL: ' + url); // Debug
        const r = await fetch(url, { headers: HDR });
        const txt = await r.text();
        if (!r.ok) throw new Error(`List members ${r.status}: ${txt}`);
        const json = JSON.parse(txt || '{}');
        const data = json.data || json;
        const items = Array.isArray(data) ? data : (data.items || []);
        out.push(...items);
        after = json.endCursor || json.nextCursor || null;
      } while (after);
      return out;
    }

    async function patchMember(memberId, customFields) {
      if (DRY) {
        console.log('🔎 DRY update', memberId, customFields);
        return;
      }
      const r = await fetch(`${API}/members/${memberId}`, {
        method: 'PATCH',
        headers: HDR,
        body: JSON.stringify({ customFields })
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Patch member ${r.status}: ${txt}`);
    }

    console.log(`Start backfill (ENV=${ENV}, DRY_RUN=${DRY}) …`);
    const members = await listMembers();
    console.log(`Members trouvés: ${members.length}`);

    let changed = 0;

    // Group by planId (proxy for team, from member fiche, since plans are team plans)
    const groups = {};
    for (const m of members) {
      const planId = m.planIds ? m.planIds[0] : ''; // First planId from fiche as team proxy
      if (planId) {
        if (!groups[planId]) groups[planId] = { owners: [], members: [] };
        const cf = m.customFields || {};
        if (String(cf[CF.teamOwner] || '') === '1') groups[planId].owners.push(m);
        else groups[planId].members.push(m);
      } else {
        console.log(`⏭️ Member ${m.id} sans planId in fiche → skip`);
      }
    }

    for (const planId in groups) {
      const g = groups[planId];
      if (g.owners.length === 0) {
        console.log(`⏭️ Plan/team proxy ${planId} sans owner → skip`);
        continue;
      }
      const owner = g.owners[0]; // Assume 1 owner per plan/team
      const ownerId = owner.id;
      const ownerCF = owner.customFields || {};
      const teamId = ownerCF[CF.teamId] || generateTeamId(); // Lookup from owner fiche, generate similar if missing

      // Update owner
      const ownerPatch = {};
      if (String(ownerCF[CF.teamId] || '') !== teamId) ownerPatch[CF.teamId] = teamId;
      if (String(ownerCF[CF.teamOwner] || '') !== '1') ownerPatch[CF.teamOwner] = '1';
      if (Object.keys(ownerPatch).length) {
        await patchMember(ownerId, ownerPatch);
        changed++;
      }

      const ownerClub = ownerCF[CF.club] || '';

      // Update members
      for (const mem of g.members) {
        const memId = mem.id;
        const cf = mem.customFields || {};
        const patch = {};
        if (String(cf[CF.teamId] || '') !== teamId) patch[CF.teamId] = teamId;
        if (String(cf[CF.teamOwner] || '') !== '0') patch[CF.teamOwner] = '0';
        if (ownerClub && String(cf[CF.club] || '') !== ownerClub) patch[CF.club] = ownerClub;

        if (Object.keys(patch).length) {
          await patchMember(memId, patch);
          changed++;
        }
      }

      console.log(`✅ Plan/team proxy ${planId} traité (teamId=${teamId}, owner=${ownerId}, members=${g.members.length})`);
    }

    const message = `${DRY ? 'Dry-run' : 'Done'} (ENV=${ENV}) — ${changed} mise(s) à jour.`;
    console.log(message);
    res.status(200).send(message);
  } catch (e) {
    console.error('Backfill error:', e);
    res.status(500).send('Error: ' + e.message);
  }
};
