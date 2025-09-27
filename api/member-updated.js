// NO-OP DRAIN — TEMPORAIRE
module.exports = async (req, res) => {
  try {
    // petit log pour vérifier le drainage
    console.log("[NOOP] /member-updated", {
      method: req.method,
      svixId: req.headers["svix-id"] || null,
      ts: new Date().toISOString(),
    });
    // IMPORTANT: toujours 2xx pour arrêter les replays
    return res.status(200).json({ ok: true });
  } catch (e) {
    // même en cas d'erreur locale, renvoyer 200
    return res.status(200).json({ ok: true });
  }
};
