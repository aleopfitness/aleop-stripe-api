// Backfill Memberstack customFields : teamid, teamowner, club (V2 API, try teams, fallback members group by plan)
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

    const API = 'https://api.memberstack.com/v1'; // V2 base
    const HDR = { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' };
    const DRY = true; // Hardcoded true pour dry-run initial
    const CF = { teamId: 'teamid', teamOwner: 'teamowner', club: 'club' }; // Hardcoded

    // Try to list teams (if available)
    async function listTeams() {
      const out = [];
      let after;
      do {
        const url = `${API}/teams?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        console.log('Fetching teams URL: ' + url); // Debug
        const r = await fetch(url, { headers: HDR });
        const txt = await r.text();
        if (!r.ok) {
          console.error(`List teams ${r.status}: ${txt}`);
          return null; // Fallback if 404
        }
        const json = JSON.parse(txt || '{}');
        const data = json.data || json;
        const items = Array.isArray(data) ? data : (data.items || []);
        out.push(...items);
        after = json.endCursor || json.nextCursor || null;
      } while (after);
      return out;
    }

    // List all members (fallback if no teams)
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

    function pickMembersArray(teamObj) {
      let arr = teamObj.members || teamObj.teamMembers || [];
      if (!Array.isArray(arr)) arr = [];
      return arr.map(m => ({
        id: m.id || m.memberId || m.member?.id || m.userId || null
      })).filter(x => !!x.id);
    }

    console.log(`Start backfill (ENV=${ENV}, DRY_RUN=${DRY}) …`);

    let teams = await listTeams();
    if (!teams) {
      console.log('Fallback to list members and group by plan/club');
      const members = await listMembers();
      teams = [];
      const groups = {};
      for (const m of members) {
        const cf = m.customFields || {};
        const planId = m.planId || ''; // Assume planId as proxy for team, since all plans are team plans
        if (planId) {
          if (!groups[planId]) groups[planId] = { id: planId, ownerId: null, members: [] };
          if (String(cf[CF.teamOwner] || '') === '1') groups[planId].ownerId = m.id;
          groups[planId].members.push({ id: m.id });
        }
      }
      for (const planId in groups) {
        teams.push(groups[planId]);
      }
    }
    console.log(`Teams/groups trouvés: ${teams.length}`);

    let changed = 0;

    for (const team of teams) {
      const teamId = team.id || team.teamId;
      if (!teamId) continue;

      const ownerId = team.ownerId || team.owner?.id;
      if (!ownerId) {
        console.log(`⏭️ Team ${teamId} sans owner → skip`);
        continue;
      }

      const members = pickMembersArray(team);

      // Get owner data
      const owner = await listMembers().find(m => m.id === ownerId); // Simple find, since no get single in fallback
      const ownerCF = owner.customFields || {};
      const ownerClub = ownerCF[CF.club] || '';

      // Update owner
      const ownerPatch = {};
      if (String(ownerCF[CF.teamId] || '') !== teamId) ownerPatch[CF.teamId] = teamId;
      if (String(ownerCF[CF.teamOwner] || '') !== '1') ownerPatch[CF.teamOwner] = '1';
      if (Object.keys(ownerPatch).length) {
        await patchMember(ownerId, ownerPatch);
        changed++;
      }

      // Update members
      for (const m of members) {
        if (!m.id || m.id === ownerId) continue;
        const mem = await listMembers().find(m2 => m2.id === m.id);
        const cf = mem.customFields || {};
        const patch = {};
        if (String(cf[CF.teamId] || '') !== teamId) patch[CF.teamId] = teamId;
        if (String(cf[CF.teamOwner] || '') !== '0') patch[CF.teamOwner] = '0';
        if (ownerClub && String(cf[CF.club] || '') !== ownerClub) patch[CF.club] = ownerClub;

        if (Object.keys(patch).length) {
          await patchMember(m.id, patch);
          changed++;
        }
      }

      console.log(`✅ Team ${teamId} traitée (owner=${ownerId})`);
    }

    const message = `${DRY ? 'Dry-run' : 'Done'} (ENV=${ENV}) — ${changed} mise(s) à jour.`;
    console.log(message);
    res.status(200).send(message);
  } catch (e) {
    console.error('Backfill error:', e);
    res.status(500).send('Error: ' + e.message);
  }
};
