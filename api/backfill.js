// Backfill Memberstack customFields depuis l'API Teams : teamid, teamowner, club
const fetch = require('node-fetch');
const pLimit = require('p-limit');

module.exports = async (req, res) => {
  try {
    const API = 'https://admin.memberstack.com';
    const KEY = process.env.MEMBERSTACK_API_KEY;
    if (!KEY) throw new Error('Missing MEMBERSTACK_API_KEY');

    const HDR = { 'X-API-KEY': KEY, 'Content-Type': 'application/json' };
    const DRY = process.env.DRY_RUN === '1';
    const CF = {
      teamId: process.env.CF_TEAMID || 'teamid',
      teamOwner: process.env.CF_TEAMOWNER || 'teamowner',
      club: process.env.CF_CLUB || 'club',
    };
    const FILTER = new Set((process.env.FILTER_TEAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
    const limit = pLimit(6);

    async function listTeams() {
      const out = [];
      let after;
      do {
        const url = `${API}/teams?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        const r = await fetch(url, { headers: HDR });
        const txt = await r.text();
        if (!r.ok) throw new Error(`List teams ${r.status}: ${txt}`);
        const json = JSON.parse(txt || '{}');
        const data = json.data || json;
        const items = Array.isArray(data) ? data : (data.items || []);
        out.push(...items);
        after = json.endCursor || json.nextCursor || null;
      } while (after);
      return out;
    }

    async function getMember(memberId) {
      const r = await fetch(`${API}/members/${memberId}`, { headers: HDR });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Get member ${r.status}: ${txt}`);
      const json = JSON.parse(txt || '{}');
      return json.data || json;
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

    console.log('Start backfill (DRY_RUN=', DRY, ') …');
    const teams = await listTeams();
    console.log(`Teams trouvées: ${teams.length}`);

    let changed = 0;

    await Promise.all(teams.map(team => limit(async () => {
      const teamId = team.id || team.teamId;
      if (!teamId) return;

      if (FILTER.size && !FILTER.has(teamId)) return;

      const ownerId = team.ownerId || team.owner?.id;
      const members = pickMembersArray(team);

      if (!ownerId) {
        console.log(`⏭️  Team ${teamId} sans owner → skip`);
        return;
      }

      let owner;
      try { owner = await getMember(ownerId); }
      catch (e) { console.error('Owner fetch err', teamId, ownerId, e.message); return; }

      const ownerCF = owner.customFields || {};
      const ownerClub = ownerCF[CF.club] ? String(ownerCF[CF.club]) : '';

      const ownerPatch = {};
      if (String(ownerCF[CF.teamId] || '') !== String(teamId)) ownerPatch[CF.teamId] = String(teamId);
      if (String(ownerCF[CF.teamOwner] || '') !== '1') ownerPatch[CF.teamOwner] = '1';
      if (Object.keys(ownerPatch).length) {
        await patchMember(ownerId, ownerPatch);
        changed++;
      }

      for (const m of members) {
        if (!m.id || m.id === ownerId) continue;
        let mem; 
        try { mem = await getMember(m.id); } 
        catch (e) { console.error('Member fetch err', m.id, e.message); continue; }
        const cf = mem.customFields || {};
        const patch = {};
        if (String(cf[CF.teamId] || '') !== String(teamId)) patch[CF.teamId] = String(teamId);
        if (String(cf[CF.teamOwner] || '') !== '0') patch[CF.teamOwner] = '0';
        if (ownerClub && String(cf[CF.club] || '') !== ownerClub) patch[CF.club] = ownerClub;

        if (Object.keys(patch).length) {
          await patchMember(m.id, patch);
          changed++;
        }
      }

      console.log(`✅ Team ${teamId} traitée (owner=${ownerId})`);
    })));

    const message = `${DRY ? 'Dry-run' : 'Done'} — ${changed} mise(s) à jour.`;
    console.log(message);
    res.status(200).send(message);
  } catch (e) {
    console.error('Backfill error:', e);
    res.status(500).send('Error: ' + e.message);
  }
};
