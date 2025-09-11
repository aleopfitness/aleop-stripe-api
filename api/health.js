// /api/health.js
module.exports = async (_req, res) => {
  res.setHeader('Cache-Control','no-store');
  res.status(200).json({ ok:true, ts: Date.now() });
};
