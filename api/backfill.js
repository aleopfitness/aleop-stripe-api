// Backfill Memberstack customFields : teamid, teamowner, club (inspired member-updated.js, list members + group by club pour simuler teams)
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

    const API = 'https://admin.memberstack.com';
    const HDR = { 'X-API-KEY': KEY, 'Content-Type': 'application/json' };
    const DRY = true; // Hardcoded true pour dry-run initial
    const CF = { teamId: 'teamid', teamOwner: 'teamowner', club: 'club' }; // Hardcoded

    // List all members (comme dans ton code working, with pagination)
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

    // Group by club (proxy pour team, since no /teams; assume club unique per team)
    const groups = {};
    for (const m of members) {
      const cf = m.customFields || {};
      const club = cf[CF.club] || '';
      if (!groups[club]) groups[club] = { owners: [], members: [] };
      if (String(cf[CF.teamOwner] || '') === '1') groups[club].owners.push(m);
      else groups[club].members.push(m);
    }

    for (const club in groups) {
      const g = groups[club];
      if (g.owners.length === 0) continue; // Skip si no owner
      const owner = g.owners[0]; // Assume 1 owner per group
      const ownerId = owner.id;
      const ownerCF = owner.customFields || {};
      const teamId = ownerCF[CF.teamId] || `tm_${ownerId.substring(0,8)}`; // Génère si missing (short owner ID)

      // Update owner
      const ownerPatch = {};
      if (String(ownerCF[CF.teamId] || '') !== teamId) ownerPatch[CF.teamId] = teamId;
      if (String(ownerCF[CF.teamOwner] || '') !== '1') ownerPatch[CF.teamOwner] = '1';
      if (club && String(ownerCF[CF.club] || '') !== club) ownerPatch[CF.club] = club;
      if (Object.keys(ownerPatch).length) {
        await patchMember(ownerId, ownerPatch);
        changed++;
      }

      // Update members (apply to same club group)
      for (const mem of g.members) {
        const memId = mem.id;
        const cf = mem.customFields || {};
        const patch = {};
        if (String(cf[CF.teamId] || '') !== teamId) patch[CF.teamId] = teamId;
        if (String(cf[CF.teamOwner] || '') !== '0') patch[CF.teamOwner] = '0';
        if (club && String(cf[CF.club] || '') !== club) patch[CF.club] = club;

        if (Object.keys(patch).length) {
          await patchMember(memId, patch);
          changed++;
        }
      }

      console.log(`✅ Group/club ${club} traité (owner=${ownerId}, teamId=${teamId}, members=${g.members.length})`);
    }

    const message = `${DRY ? 'Dry-run' : 'Done'} (ENV=${ENV}) — ${changed} mise(s) à jour.`;
    console.log(message);
    res.status(200).send(message);
  } catch (e) {
    console.error('Backfill error:', e);
    res.status(500).send('Error: ' + e.message);
  }
};
