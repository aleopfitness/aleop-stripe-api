// /api/ms-webhook.js
// Vérifie la signature Svix des webhooks Memberstack et applique les droits
// (custom fields) après achat d’un paid plan Team (1..9 licences).

const { Webhook } = require('svix');
const fetch = require('node-fetch'); // Node 18/20 a fetch global, mais on garde pour compat.

//
// ---------- KV helpers (Upstash / Vercel KV) ----------
//
function kvBase() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
}
function kvToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
}
function kvHeaders() {
  const t = kvToken();
  if (!t) throw new Error('KV token missing');
  return { Authorization: `Bearer ${t}` };
}
async function kvJson(res) {
  if (!res.ok) throw new Error(`KV ${res.status}: ${await res.text()}`);
  return res.json();
}
async function kvGet(key) {
  const url = `${kvBase()}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: kvHeaders() });
  const data = await kvJson(res);
  return data?.result ? JSON.parse(data.result) : null;
}
async function kvSetEx(key, value, ttlSec) {
  const url = `${kvBase()}/setex/${encodeURIComponent(key)}/${ttlSec}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...kvHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ value: JSON.stringify(value) })
  });
  await kvJson(res);
}

//
// ---------- Memberstack Admin API ----------
//
async function msUpdateFields(memberId, updates) {
  const r = await fetch(`https://admin.memberstack.com/members/${memberId}`, {
    method: 'PATCH',
    headers: {
      'X-API-KEY': process.env.MEMBERSTACK_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ customFields: updates })
  });
  if (!r.ok) throw new Error(`Memberstack update ${r.status}: ${await r.text()}`);
}

//
// ---------- Map: planId Memberstack -> seats (TES IDs) ----------
//
const PLAN_TO_SEATS = {
  'pln_aleop-1-license-7x1ng0yup': 1,
  'pln_aleop-2-licenses-671nh0yv8': 2,
  'pln_aleop-3-licenses-6hfd0a8b': 3,
  'pln_aleop-4-licenses-kf1lq0vb7': 4,
  'pln_aleop-5-licenses-00fb0aa9': 5,
  'pln_aleop-6-licenses-t9hp0fjy': 6,
  'pln_aleop-7-licenses-38hq0fvb': 7,
  'pln_aleop-8-licenses-1zhs0fw1': 8,
  'pln_aleop-9-licenses-iefe0a7f': 9
};

// (Les price IDs ne sont pas nécessaires côté webhook, on lit le planId renvoyé par Memberstack)

//
// ---------- Util ----------
//
function get(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

module.exports = async (req, res) => {
  // Lire le body brut (obligatoire pour vérifier la signature Svix)
  let payload = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { payload += c; });
  await new Promise((resolve) => req.on('end', resolve));

  const svixId = req.headers['svix-id'];
  const svixTs = req.headers['svix-timestamp'];
  const svixSig = req.headers['svix-signature'];

  if (!svixId || !svixTs || !svixSig) {
    return res.status(400).send('Missing Svix headers');
  }
  if (!process.env.MS_WEBHOOK_SECRET) {
    console.error('MS_WEBHOOK_SECRET missing');
    return res.status(500).send('Server misconfigured');
  }

  // Vérifier la signature
  let evt;
  try {
    const wh = new Webhook(process.env.MS_WEBHOOK_SECRET);
    evt = wh.verify(payload, {
      'svix-id': svixId,
      'svix-timestamp': svixTs,
      'svix-signature': svixSig
    });
  } catch (e) {
    console.error('Invalid Svix signature:', e.message);
    return res.status(400).send('Invalid signature');
  }

  const type = evt?.type || evt?.event;
  const data = evt?.data || evt?.payload || {};

  // On gère l’ajout d’un paid plan (succès checkout Memberstack)
  if (type === 'member.plan.added') {
    try {
      const memberId =
        get(data, 'member.id') ||
        get(data, 'id') ||
        get(data, 'memberId');

      const planId =
        get(data, 'plan.id') ||
        get(data, 'planId') ||
        get(data, 'newPlan.id');

      if (!memberId || !planId) {
        console.log('Webhook missing memberId or planId', { memberId, planId });
        return res.send();
      }

      const seatsFromPlan = PLAN_TO_SEATS[planId];
      if (!seatsFromPlan) {
        console.log('Plan not in PLAN_TO_SEATS map:', planId);
        return res.send();
      }

      // Récupérer le dernier intent (programmes + seats) pour ce membre
      const pointer = await kvGet(`latest-intent:${memberId}`);
      if (!pointer?.intentId) {
        console.log('No pending intent for member', memberId, '-> applying base access only');
        await msUpdateFields(memberId, {
          active: "1",
          team_owner: "1",
          seats_total: String(seatsFromPlan),
          seats_used: "0"
        });
        return res.send();
      }

      const intent = await kvGet(`intent:${pointer.intentId}`);
      if (!intent) {
        console.log('Intent missing', pointer);
        return res.send();
      }
      if (intent.status === 'applied') {
        console.log('Intent already applied', intent.intentId);
        return res.send();
      }

      // Construire les updates
      const updates = {
        active: "1",
        team_owner: "1",
        seats_total: String(seatsFromPlan),
        seats_used: "0"
      };
      (intent.programs || []).forEach((p) => {
        const key = String(p || '').toLowerCase().trim();
        if (key) updates[key] = "1"; // 'athletyx','upper-shape','booty-shape','power-flow'
      });

      // PATCH Memberstack
      await msUpdateFields(memberId, updates);

      // Marquer l’intent comme appliqué (TTL 7j pour audit/idempotence)
      await kvSetEx(
        `intent:${intent.intentId}`,
        { ...intent, status: 'applied', appliedAt: Date.now() },
        7 * 24 * 60 * 60
      );

      console.log(`Applied purchase for ${memberId} -> seats=${seatsFromPlan}, programs=${(intent.programs||[]).join(',')}`);
      return res.send(); // 200
    } catch (err) {
      console.error('ms-webhook error:', err.message);
      return res.status(500).send('Webhook handler error');
    }
  }

  // On ignore les autres events pour l’instant
  return res.send();
};
