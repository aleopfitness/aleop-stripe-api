// NO-OP DRAIN — TEMPORAIRE
module.exports = async (req, res) => {
  try {
    console.log("[NOOP] /ms-webhook", {
      method: req.method,
      svixId: req.headers["svix-id"] || null,
      event: req.headers["svix-msg-type"] || null,
      ts: new Date().toISOString(),
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: true });
  }
};
