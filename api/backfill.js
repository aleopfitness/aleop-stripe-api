// pages/backfill.js
// Visite /backfill pour lancer un backfill minimal depuis l'API Teams Memberstack
// Remplit uniquement: teamid, teamowner, club
// Sécurisé par BACKFILL_TOKEN (via ?token=...)
// Paramètres: ?env=test|live (def: test), ?dry=1|0 (def: 1), ?filter=tm_1,tm_2, ?conc=6

export async function getServerSideProps(ctx) {
  const t0 = Date.now();
  const q = ctx.query || {};
  const headerAuth = ctx.req.headers.authorization || "";
  const token = (q.token?.toString() || "").trim() || headerAuth.replace(/^Bearer\s+/i, "");
  if (!process.env.BACKFILL_TOKEN || token !== process.env.BACKFILL_TOKEN) {
    return { notFound: true }; // 404 si pas autorisé
  }

  const envFlag = (q.env?.toString() || "test").toLowerCase();
  const KEY =
    envFlag === "live" || envFlag === "prod" || envFlag === "production"
      ? process.env.MEMBERSTACK_API_KEY_LIVE
      : (process.env.MEMBERSTACK_API_KEY_TEST || process.env.MEMBERSTACK_API_KEY);
  if (!KEY) {
    return { props: { error: `Missing Memberstack API key for env=${envFlag}` } };
  }

  const dry = (q.dry?.toString() ?? "1") !== "0";            // dry-run par défaut
  const conc = Math.max(1, Math.min(10, Number(q.conc || "6")));
  const filter = new Set((q.filter?.toString() || "").split(",").map(s => s.trim()).filter(Boolean));

  // Noms des custom fields (override possible via env)
  const CF_TEAMID    = process.env.CF_TEAMID    || "teamid";
  const CF_TEAMOWNER = process.env.CF_TEAMOWNER || "teamowner";
  const CF_CLUB      = process.env.CF_CLUB      || "club";

  const API = "https://admin.memberstack.com";
  const hdr = { "X-API-KEY": KEY, "Content-Type": "application/json" };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function msFetch(path, init = {}, tries = 3, backoff = 400) {
    for (let i = 0; i < tries; i++) {
      const r = await fetch(`${API}${path}`, { ...init, headers: { ...hdr, ...(init.headers || {}) } });
      const txt = await r.text();
      let json = null; try { json = txt ? JSON.parse(txt) : null; } catch {}
      if (r.ok) return json;
      if (i === tries - 1) throw new Error(`${init.method || "GET"} ${path} -> ${r.status} ${txt}`);
      await sleep(backoff * (i + 1));
    }
  }

  async function listTeams() {
    const out = [];
    let after;
    do {
      const p = new URLSearchParams({ limit: "100" });
      if (after) p.set("after", after);
      const json = await msFetch(`/teams?${p.toString()}`);
      const data = Array.isArray(json?.data) ? json.data : (json?.items || []);
      out.push(...data);
      after = json?.endCursor || json?.nextCursor || undefined;
    } while (after);
    return out;
  }

  async function getMember(id) {
    const json = await msFetch(`/members/${id}`);
    return json?.data || json;
  }

  async function patchMember(id, customFields) {
    if (dry) return true; // simulation
    await msFetch(`/members/${id}`, { method: "PATCH", body: JSON.stringify({ customFields }) }, 3, 600);
    return true;
  }

  function pickMembersArray(team) {
    const raw = Array.isArray(team?.members) ? team.members : (team?.teamMembers || []);
    return (raw || [])
      .map(m => ({ id: m?.id || m?.memberId || m?.member?.id || m?.userId }))
      .filter(x => !!x?.id);
  }

  function limiter(max = 6) {
    let running = 0; const queue = [];
    const next = () => { running--; queue.shift()?.(); };
    return async (fn) => new Promise((resolve, reject) => {
      const run = () => { running++; fn().then(v => { next(); resolve(v); }).catch(e => { next(); reject(e); }); };
      if (running < max) run(); else queue.push(run);
    });
  }

  const stats = {
    env: envFlag, dryRun: dry, conc,
    teamsTotal: 0, teamsProcessed: 0, skippedNoOwner: 0,
    ownerUpdated: 0, membersUpdated: 0,
    examples: []
  };

  try {
    const teams = await listTeams();
    stats.teamsTotal = teams.length;
    const runLimited = limiter(conc);

    for (const team of teams) {
      const teamId = team?.id || team?.teamId;
      if (!teamId) continue;
      if (filter.size && !filter.has(teamId)) continue;

      const ownerId = team?.ownerId || team?.owner?.id;
      if (!ownerId) { stats.skippedNoOwner++; continue; }

      // Owner
      let owner;
      try { owner = await getMember(ownerId); }
      catch (e) { console.error("Owner fetch err", teamId, ownerId, e.message); continue; }

      const ocf = owner.customFields || {};
      const ownerClub = ocf[CF_CLUB] ? String(ocf[CF_CLUB]) : "";

      const ownerPatch = {};
      if (String(ocf[CF_TEAMID] || "") !== String(teamId)) ownerPatch[CF_TEAMID] = String(teamId);
      if (String(ocf[CF_TEAMOWNER] || "") !== "1")        ownerPatch[CF_TEAMOWNER] = "1";
      if (Object.keys(ownerPatch).length) {
        await patchMember(owner.id, ownerPatch);
        stats.ownerUpdated++;
        if (stats.examples.length < 5) stats.examples.push({ memberId: owner.id, patch: ownerPatch });
      }

      // Members
      const members = pickMembersArray(team);
      await Promise.all(members.map(m => runLimited(async () => {
        if (!m.id || m.id === owner.id) return;
        let mem; try { mem = await getMember(m.id); } catch (e) { console.error("Member fetch err", m.id, e.message); return; }
        const cf = mem.customFields || {};
        const patch = {};
        if (String(cf[CF_TEAMID] || "") !== String(teamId)) patch[CF_TEAMID] = String(teamId);
        if (String(cf[CF_TEAMOWNER] || "") !== "0")        patch[CF_TEAMOWNER] = "0";
        if (ownerClub && String(cf[CF_CLUB] || "") !== ownerClub) patch[CF_CLUB] = ownerClub;

        if (Object.keys(patch).length) {
          await patchMember(mem.id, patch);
          stats.membersUpdated++;
          if (stats.examples.length < 5) stats.examples.push({ memberId: mem.id, patch });
        }
      })));

      stats.teamsProcessed++;
    }

    stats.durationMs = Date.now() - t0;
    return { props: { stats } };
  } catch (e) {
    return { props: { error: e?.message || "error", durationMs: Date.now() - t0 } };
  }
}

export default function BackfillPage({ stats, error, durationMs }) {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Memberstack Backfill</h1>
      {error ? (
        <>
          <p style={{ color: "crimson" }}><b>Erreur :</b> {error}</p>
          {durationMs ? <p>Durée: {durationMs} ms</p> : null}
        </>
      ) : (
        <>
          <p><b>Env:</b> {stats?.env} • <b>Dry-run:</b> {String(stats?.dryRun)} • <b>Conc:</b> {stats?.conc}</p>
          <p><b>Teams:</b> {stats?.teamsProcessed}/{stats?.teamsTotal} • <b>Owners maj:</b> {stats?.ownerUpdated} • <b>Membres maj:</b> {stats?.membersUpdated} • <b>Skipped no owner:</b> {stats?.skippedNoOwner}</p>
          <pre style={{ background: "#111", color: "#0f0", padding: 16, borderRadius: 8, overflowX: "auto" }}>
{JSON.stringify(stats, null, 2)}
          </pre>
        </>
      )}
    </main>
  );
}
