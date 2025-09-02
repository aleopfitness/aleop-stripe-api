// /api/health.js
module.exports = async (req, res) => {
  const envs = ['MEMBERSTACK_API_KEY','MS_WEBHOOK_SECRET','KV_REST_API_URL','KV_REST_API_TOKEN','FRONT_URL'];
  res.status(200).json({
    ok: true,
    env: Object.fromEntries(envs.map(k => [k, !!process.env[k]])),
    now: Date.now()
  });
};
