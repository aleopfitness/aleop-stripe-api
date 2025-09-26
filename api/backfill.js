// pages/api/backfill.js
// API "ouvrir l’URL = ça lance" (JSON)
// Par défaut: ENV=TEST + DRY-RUN (aucune écriture)
// Modifie UNIQUEMENT: teamid, teamowner, club
// TEST: pas de token requis. LIVE: besoin de BACKFILL_TOKEN.

const API = "https://admin.memberstack.com";

function getKey(envFlag) {
  if (["live","prod","production"].includes(envFlag)) return process.env.MEMBERSTACK_API_KEY_LIVE;
  return process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY;
}

async function msFetch(path, key, init = {}, tries = 3, backoff = 400) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${API}${path}`, {
      ...init,
      headers: { "X-API-KEY": key, "Content-Type": "application/json", ...(init.headers||{}) },
    });
    const txt = await r.text();
    let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
    if (r.ok) return json;
    if (i === tries - 1) throw new Error(`${init.method||"GET"} ${path} -> ${r.status} ${txt}`);
    await new Promise(res => setTimeout(res, backoff * (i+1)));
  }
}

async function msGet(path, key) { return msFetch(path, key); }
async function msPatchMember(id, customFields, key) {
  return msFetch(`/members/${id}`, key, { method:"PATCH", body: JSON.stringify({ customFields }) }, 3, 600);
}

async function listTeams(key) {
  const out = []; let after;
  do {
    const p = new URLSearchParams({ limit: "100" }); if (after) p.set("after", after);
    const json = await msGet(`/teams?${p.toString()}`, key);
    const data = Array.isArray(json?.data) ? json.data : (json?.items || []);
    out.push(...data);
    after = json?.endCursor || json?.nextCursor || undefined;
  } while (after);
  return out;
}

function pickMembersArray(team) {
  const raw = Array.isArray(team?.members) ? team.members : (team?.teamMembers || []);
  return (raw || [])
    .map(m => ({ id: m?.id || m?.memberId || m?.member?.id || m?.userId }))
    .filter(x => !!x?.id);
}

async function getMember(id, key) {
  const json = await msGet(`/members/${id}`, key);
  return json?.data || json;
}

function limiter(max = 6) {
  let running = 0; const queue = [];
  const next = () => { running--; queue.shift()?.(); };
  return async fn => new Promise((resolve, reject) => {
    const run = () => { running++; fn().then(v=>{ next(); resolve(v); }).catch(e=>{ next(); reject(e); }); };
    if (running < max) run(); else queue.push(run);
  });
}

module.exports = async function handler(req, res) {
  const t0 = Date.now();
  try {
    const q = req.query || {};
    const envFlag = (q.env?.toString() || "test").toLowerCase();
    const isLive = ["live","prod","production"].includes(envFlag);
    const key = getKey(envFlag);
    if (!key) return res.status(500).json({ error: `Missing Memberstack API key for env=${envFlag}` });

    // Auth: TEST = pas de token. LIVE = token obligatoire.
    if (isLive) {
      const headerAuth = req.headers.authorization || "";
      const token = (q.token?.toString() || "").trim() || headerAuth.replace(/^Bearer\s+/i, "");
      if (!process.env.BACKFILL_TOKEN || token !== process.env.BACKFILL_TOKEN) {
        return res.status(401).json({ error: "Unauthorized (live)" });
      }
    }

    const dry  = (q.dry?.toString() ?? "1") !== "0";              // dry-run par défaut
    const conc = Math.max(1, Math.min(10, Number(q.conc || "6")));
    const filter = new Set((q.filter?.toString() || "").split(",").map(s=>s.trim()).filter(Boolean));

    const CF_TEAMID    = process.env.CF_TEAMID    || "teamid";
    const CF_TEAMOWNER = process.env.CF_TEAMOWNER || "teamowner";
    const CF_CLUB      = process.env.CF_CLUB      || "club";

    const stats = {
      env: envFlag, live: isLive, dryRun: dry, conc,
      teamsTotal: 0, teamsProcessed: 0, skippedNoOwner: 0,
      ownerPatched: 0, membersPatched: 0, examples: []
    };

    const teams = await listTeams(key);
    stats.teamsTotal = teams.length;
    const runLimited = limiter(conc);

    for (const team of teams) {
      const teamId = team?.id || team?.teamId; if (!teamId) continue;
      if (filter.size && !filter.has(teamId)) continue;

      const ownerId = team?.ownerId || team?.owner?.id;
      if (!ownerId) { stats.skippedNoOwner++; continue; }

      // Owner
      let owner; try { owner = await getMember(ownerId, key); }
      catch(e){ console.error("Owner fetch err", teamId, ownerId, e.message); continue; }

      const ocf = owner.customFields || {};
      const ownerClub = ocf[CF_CLUB] ? String(ocf[CF_CLUB]) : "";
      const ownerPatch = {};
      if (String(ocf[CF_TEAMID] || "") !== String(teamId)) ownerPatch[CF_TEAMID] = String(teamId);
      if (String(ocf[CF_TEAMOWNER] || "") !== "1")        ownerPatch[CF_TEAMOWNER] = "1";
      if (Object.keys(ownerPatch).length) {
        if (!dry) await msPatchMember(owner.id, ownerPatch, key);
        stats.ownerPatched++;
        if (stats.examples.length < 5) stats.examples.push({ memberId: owner.id, patch: ownerPatch });
      }

      // Members
      const members = pickMembersArray(team);
      await Promise.all(members.map(m => runLimited(async () => {
        if (!m.id || m.id === owner.id) return;
        let mem; try { mem = await getMember(m.id, key); }
        catch(e) { console.error("Member fetch err", m.id, e.message); return; }

        const cf = mem.customFields || {};
        const patch = {};
        if (String(cf[CF_TEAMID] || "") !== String(teamId)) patch[CF_TEAMID] = String(teamId);
        if (String(cf[CF_TEAMOWNER] || "") !== "0")        patch[CF_TEAMOWNER] = "0";
        if (ownerClub && String(cf[CF_CLUB] || "") !== ownerClub) patch[CF_CLUB] = ownerClub;

        if (Object.keys(patch).length) {
          if (!dry) await msPatchMember(mem.id, patch, key);
          stats.membersPatched++;
          if (stats.examples.length < 5) stats.examples.push({ memberId: mem.id, patch });
        }
      })));

      stats.teamsProcessed++;
    }

    stats.durationMs = Date.now() - t0;
    return res.status(200).json(stats);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "error" });
  }
};
