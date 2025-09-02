// /api/intent.js
// Enregistre une intention d’achat "pending" en KV (TTL 2h).
// POST { memberId: string, programs: string[], seats: 1..9 } -> { ok: true, intentId }

const crypto = require('crypto');

// Adapte cette whitelist si tu ajoutes/renommes des programmes
const ALLOWED_PROGRAMS = new Set(['athletyx', 'upper-shape', 'booty-shape', 'power-flow']);

// --------- Helpers Upstash KV (REST) ---------
function getKvBaseUrl() {
  return (
    process.env.KV_REST_API_URL || // Vercel KV
    process.env.UPSTASH_REDIS_REST_URL // Upstash direct (fallback)
  );
}
function getKvToken() {
  return (
    process.env.KV_REST_API_TOKEN || // Vercel KV
    process.env.UPSTASH_REDIS_REST_TOKEN // Upstash direct (fallback)
  );
}
function kvHeaders() {
  const token = getKvToken();
  if (!token) throw new Error('KV token missing (KV_REST_API_TOKEN / UPSTASH_REDIS_REST_TOKEN)');
  return { Authorization: `Bearer ${token}` };
}
async function kvJson(res) {
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  return res.json();
}
async function kvSet(key, value, ttlSeconds) {
  const base = getKvBaseUrl();
  if (!base) throw new Error('KV base URL missing (KV_REST_API_URL / UPSTASH_REDIS_REST_URL)');
  const serialized = JSON.stringify(value);

  if (Number.isFinite(ttlSeconds) && ttlSeconds > 0) {
    // SETEX key ttl value
    const url = `${base}/setex/${encodeURIComponent(key)}/${ttlSeconds}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...kvHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value: serialized })
    });
    await kvJson(res);
  } else {
    const url = `${base}/set/${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...kvHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ value: serialized })
    });
    await kvJson(res);
  }
}

// --------- CORS (appel depuis Webflow) ---------
function setCors(res) {
  const origin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end('Method Not Allowed');

  try {
    const { memberId, programs, seats } = req.body || {};

    // --- validations ---
    if (!memberId || !Array.isArray(programs) || programs.length === 0) {
      return res.status(400).json({ error: 'Missing memberId or programs' });
    }
    const seatsInt = parseInt(seats, 10);
    if (!Number.isFinite(seatsInt) || seatsInt < 1 || seatsInt > 9) {
      return res.status(400).json({ error: 'Invalid seats (must be 1..9)' });
    }

    // Nettoyage + whitelist des programmes
    const cleanPrograms = [...new Set(programs.map(p => String(p || '').toLowerCase().trim()))]
      .filter(p => ALLOWED_PROGRAMS.has(p));
    if (cleanPrograms.length === 0) {
      return res.status(400).json({ error: 'No valid programs' });
    }

    // Construire l'intention
    const intentId = crypto.randomUUID();
    const now = Date.now();
    const intent = {
      intentId,
      status: 'pending',     // sera passé à "applied" par le webhook Memberstack
      memberId,
      programs: cleanPrograms,
      seats: seatsInt,
      createdAt: now
    };

    // Stockage KV avec TTL 2h
    const TTL = 2 * 60 * 60; // 2h en secondes
    await kvSet(`intent:${intentId}`, intent, TTL);
    await kvSet(`latest-intent:${memberId}`, { intentId, createdAt: now }, TTL);

    return res.json({ ok: true, intentId });
  } catch (e) {
    console.error('intent error:', e);
    return res.status(500).json({ error: e.message });
  }
};
