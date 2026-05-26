// server.js — Bone Tide Co. Backend
// Deploy on Railway. Add these environment variables in Railway dashboard:
//   ANTHROPIC_API_KEY      — from console.anthropic.com
//   SHOPIFY_ADMIN_TOKEN    — from Shopify admin → Settings → Apps → private app
//   SHOPIFY_STORE_DOMAIN   — e.g. bonetideco.myshopify.com
//   SHOPIFY_WEBHOOK_SECRET — from Shopify admin → Settings → Notifications → Webhooks
//   DATABASE_URL           — auto-set by Railway Postgres plugin
//   JWT_SECRET             — any long random string, e.g. "btc-secret-2025-xk29z"

import express    from 'express';
import cors       from 'cors';
import crypto     from 'crypto';
import pg         from 'pg';
import fetch      from 'node-fetch';
import { OAuth2Client } from 'google-auth-library';
import jwt           from 'jsonwebtoken';

// ─────────────────────────────────────────────────────────────────────────────
// Google Auth setup
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET       = process.env.JWT_SECRET;
const googleClient     = new OAuth2Client(GOOGLE_CLIENT_ID);

function issueJwt(user) {
  return jwt.sign(
    { id: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '90d' }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

const app = express();
const { Pool } = pg;

// ─────────────────────────────────────────────────────────────────────────────
// Database
// ─────────────────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

// Shopify webhook needs raw body for HMAC — must come before express.json()
app.post('/webhooks/shopify/orders-paid',
  express.raw({ type: 'application/json' }),
  handleShopifyWebhook
);

app.use(cors());
app.use(express.json({ limit: '10mb' })); // 10mb for base64 images

// ─────────────────────────────────────────────────────────────────────────────
// Device auth helper
// Each device gets a unique ID (generated on first launch in the app).
// We create a user row on first seen, return the same user_id after that.
// ─────────────────────────────────────────────────────────────────────────────

async function getOrCreateUser(deviceId) {
  if (!deviceId) throw new Error('deviceId required');

  const existing = await pool.query(
    'SELECT id, points_balance FROM users WHERE device_id = $1',
    [deviceId]
  );
  if (existing.rows.length) return existing.rows[0];

  const created = await pool.query(
    `INSERT INTO users (device_id, points_balance, created_at)
     VALUES ($1, 0, NOW())
     RETURNING id, points_balance`,
    [deviceId]
  );
  return created.rows[0];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /health — Railway health check
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Bone Tide Co. API' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'Bone Tide Co. API' });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/google — Exchange Google ID token for a Bone Tide JWT
// Body: { idToken: string }
// Returns: { token, user: { id, email, name, avatar } }
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body ?? {};
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    const ticket  = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload.email_verified) {
      return res.status(403).json({ error: 'Google account email not verified' });
    }

    const user = {
      id:     payload.sub,
      email:  payload.email,
      name:   payload.name  ?? '',
      avatar: payload.picture ?? null,
    };

    // Upsert user in DB so they exist for catches/rewards lookups
    await pool.query(
      `INSERT INTO users (google_id, email, name, avatar, points_balance, created_at)
       VALUES ($1, $2, $3, $4, 0, NOW())
       ON CONFLICT (google_id) DO UPDATE
         SET email = EXCLUDED.email,
             name  = EXCLUDED.name,
             avatar = EXCLUDED.avatar`,
      [user.id, user.email, user.name, user.avatar]
    );

    const token = issueJwt(user);
    return res.json({ token, user });

  } catch (err) {
    console.error('[auth] Google verification failed:', err.message);
    return res.status(401).json({ error: 'Google token verification failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/identify — Claude Vision fish identifier
// Body: { deviceId, image: base64string, region: 'southeast' }
// ─────────────────────────────────────────────────────────────────────────────

const REGION_SPECIES = {
  southeast:   ['Redfish', 'Speckled Trout', 'Flounder', 'Sheepshead', 'Red Snapper', 'Cobia', 'King Mackerel'],
  gulf:        ['Redfish', 'Speckled Trout', 'Snook', 'Tarpon', 'Red Snapper', 'Cobia'],
  midatlantic: ['Striped Bass', 'Fluke', 'Weakfish', 'Bluefish'],
  northeast:   ['Striped Bass', 'Fluke', 'Bluefish', 'Black Sea Bass'],
  westcoast:   ['Pacific Halibut', 'Lingcod', 'Rockfish', 'Cabezon'],
};

const NEARSHORE_SPECIES = [
  'Red Snapper', 'Cobia', 'King Mackerel', 'Gag Grouper',
  'Pacific Halibut', 'Lingcod', 'Rockfish',
];

app.post('/api/identify', async (req, res) => {
  const { deviceId, image, region = 'southeast' } = req.body;

  if (!image) {
    return res.status(400).json({ error: 'image (base64) required' });
  }

  const speciesList = REGION_SPECIES[region] ?? REGION_SPECIES.southeast;

  const prompt = `You are a marine biologist assistant for Bone Tide Co., a fishing app serving ${region} anglers.

Identify the fish in this photo.
Primary species to look for: ${speciesList.join(', ')}.

Respond ONLY with a valid JSON object, no markdown, no explanation:
{
  "commonName": "string — common name of the fish",
  "latinName": "string — scientific name",
  "confidence": number between 0 and 1,
  "inRegion": boolean — is this species common in the ${region} region,
  "habitat": "inshore" or "nearshore",
  "catchRelease": boolean — is this typically catch and release only,
  "notes": "string — one sentence of useful fishing notes, max 20 words"
}

If you cannot identify the fish with reasonable confidence, return confidence below 0.5.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-opus-4-6',
        max_tokens: 300,
        messages: [{
          role:    'user',
          content: [
            {
              type:   'image',
              source: {
                type:       'base64',
                media_type: 'image/jpeg',
                data:       image,
              },
            },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    const raw    = data.content[0].text;
    const result = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // Add fallback iNaturalist image URL if we recognize the species
    // In production you can pre-build a species → iNaturalist ID map
    result.fallbackImageUrl = null;

    res.json(result);

  } catch (err) {
    console.error('Identify error:', err);
    res.status(500).json({ error: 'Fish identification failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/catches — log a catch, enforce daily cap, award points
// Body: { deviceId, species, lengthIn, released, bait, note,
//         lat, lon, tideHeightFt, tideDirection, windKts, windDirection,
//         baroInHg, moonPct, goodBiteScore, sessionToken }
// ─────────────────────────────────────────────────────────────────────────────

const DAILY_CAP     = 30;
const PTS_PER_CATCH = 10;

app.post('/api/catches', async (req, res) => {
  const {
    deviceId, species, lengthIn, released, bait, note,
    lat, lon, tideHeightFt, tideDirection,
    windKts, windDirection, baroInHg, moonPct,
    goodBiteScore, sessionToken,
  } = req.body;

  if (!deviceId || !species) {
    return res.status(400).json({ error: 'deviceId and species required' });
  }

  try {
    const user = await getOrCreateUser(deviceId);

    // Check daily points cap
    const today = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD'
    const { rows: todayRows } = await pool.query(
      `SELECT COALESCE(SUM(pts_awarded), 0) AS total
       FROM catches
       WHERE user_id = $1
         AND DATE(caught_at) = $2`,
      [user.id, today]
    );
    const todayPts   = parseInt(todayRows[0].total);
    const ptsLeft    = Math.max(0, DAILY_CAP - todayPts);

    // Award points only if photo session token present and cap not hit
    // sessionToken = proof the photo came from the in-app camera
    const ptsAwarded = sessionToken && ptsLeft > 0
      ? Math.min(PTS_PER_CATCH, ptsLeft)
      : 0;

    // Insert catch
    const { rows: [newCatch] } = await pool.query(
      `INSERT INTO catches
         (user_id, species, length_in, released, bait, note,
          lat, lon, tide_height_ft, tide_direction,
          wind_kts, wind_direction, baro_in_hg, moon_pct,
          good_bite_score, pts_awarded, caught_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
       RETURNING *`,
      [user.id, species, lengthIn, released ?? true, bait, note,
       lat, lon, tideHeightFt, tideDirection,
       windKts, windDirection, baroInHg, moonPct,
       goodBiteScore, ptsAwarded]
    );

    // Credit points to balance
    if (ptsAwarded > 0) {
      await pool.query(
        `UPDATE users SET points_balance = points_balance + $1 WHERE id = $2`,
        [ptsAwarded, user.id]
      );
      await pool.query(
        `INSERT INTO points_transactions (user_id, delta, reason, reference_id, created_at)
         VALUES ($1, $2, 'catch', $3, NOW())`,
        [user.id, ptsAwarded, newCatch.id.toString()]
      );
    }

    res.json({
      catch: {
        id:             newCatch.id,
        species:        newCatch.species,
        lengthIn:       newCatch.length_in,
        released:       newCatch.released,
        bait:           newCatch.bait,
        note:           newCatch.note,
        tideHeightFt:   newCatch.tide_height_ft,
        tideDirection:  newCatch.tide_direction,
        windKts:        newCatch.wind_kts,
        windDirection:  newCatch.wind_direction,
        baroInHg:       newCatch.baro_in_hg,
        moonPct:        newCatch.moon_pct,
        goodBiteScore:  newCatch.good_bite_score,
        ptsAwarded:     newCatch.pts_awarded,
        caughtAt:       newCatch.caught_at,
      },
      ptsAwarded,
      dailyTotal:  todayPts + ptsAwarded,
      dailyCap:    DAILY_CAP,
    });

  } catch (err) {
    console.error('Log catch error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/catches — fetch catch history for a device
// Query: ?deviceId=xxx&page=1&limit=20
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/catches', async (req, res) => {
  const { deviceId, page = 1, limit = 20 } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  try {
    const user = await getOrCreateUser(deviceId);
    const offset = (parseInt(page) - 1) * parseInt(limit);

    const { rows } = await pool.query(
      `SELECT * FROM catches
       WHERE user_id = $1
       ORDER BY caught_at DESC
       LIMIT $2 OFFSET $3`,
      [user.id, limit, offset]
    );

    res.json({ catches: rows.map(formatCatch), page: parseInt(page) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function formatCatch(row) {
  return {
    id:            row.id,
    species:       row.species,
    lengthIn:      row.length_in,
    released:      row.released,
    bait:          row.bait,
    note:          row.note,
    tideHeightFt:  row.tide_height_ft,
    tideDirection: row.tide_direction,
    windKts:       row.wind_kts,
    windDirection: row.wind_direction,
    baroInHg:      row.baro_in_hg,
    moonPct:       row.moon_pct,
    goodBiteScore: row.good_bite_score,
    ptsAwarded:    row.pts_awarded,
    caughtAt:      row.caught_at,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tides — proxy NOAA CO-OPS tide predictions (free, no key)
// Query: ?station=8677344&days=7
// ─────────────────────────────────────────────────────────────────────────────

const tideCache = new Map(); // station_days → { data, fetchedAt }

app.get('/api/tides', async (req, res) => {
  const { station = '8677344', days = 7 } = req.query;
  const cacheKey = `${station}_${days}`;
  const cached   = tideCache.get(cacheKey);

  // Cache for 6 hours
  if (cached && (Date.now() - cached.fetchedAt) < 6 * 3600 * 1000) {
    return res.json(cached.data);
  }

  try {
    const today    = new Date();
    const end      = new Date(today);
    end.setDate(end.getDate() + parseInt(days));

    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
    const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
      + `?begin_date=${fmt(today)}&end_date=${fmt(end)}`
      + `&station=${station}&product=predictions&datum=MLLW`
      + `&time_zone=lst_ldt&interval=h&units=english&application=bonetideco&format=json`;

    const response  = await fetch(url);
    const noaaData  = await response.json();

    if (!noaaData.predictions) {
      throw new Error(noaaData.error?.message ?? 'NOAA returned no predictions');
    }

    const predictions = noaaData.predictions.map(p => ({
      t: new Date(p.t).toISOString(),
      v: parseFloat(p.v),
    }));

    // Compute current height and phase
    const now = Date.now();
    const sorted = [...predictions].sort((a, b) =>
      Math.abs(new Date(a.t) - now) - Math.abs(new Date(b.t) - now)
    );
    const current       = sorted[0];
    const prev          = predictions[predictions.indexOf(current) - 1];
    const currentHeight = current?.v ?? null;
    const rising        = prev ? current.v > prev.v : true;
    const dailyVals     = predictions.filter(p => {
      const d = new Date(p.t);
      return d.toDateString() === today.toDateString();
    }).map(p => p.v);

    const data = {
      stationId:        station,
      predictions,
      currentHeight,
      currentDirection: rising ? 'Incoming' : 'Outgoing',
      currentPhase:     rising ? 'incoming_fast' : 'outgoing_fast',
      dailyRange:       dailyVals.length
        ? Math.max(...dailyVals) - Math.min(...dailyVals)
        : 6,
    };

    tideCache.set(cacheKey, { data, fetchedAt: Date.now() });
    res.json(data);

  } catch (err) {
    console.error('Tides error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/conditions — proxy Open-Meteo marine + forecast (free, no key)
// Query: ?lat=31.1234&lon=-81.4567
// ─────────────────────────────────────────────────────────────────────────────

const conditionsCache = new Map();

app.get('/api/conditions', async (req, res) => {
  const { lat = '31.1234', lon = '-81.4567' } = req.query;
  const cacheKey = `${lat}_${lon}`;
  const cached   = conditionsCache.get(cacheKey);

  // Cache for 30 minutes
  if (cached && (Date.now() - cached.fetchedAt) < 30 * 60 * 1000) {
    return res.json(cached.data);
  }

  try {
    const [marineRes, forecastRes] = await Promise.all([
      fetch(
        `https://marine-api.open-meteo.com/v1/marine`
        + `?latitude=${lat}&longitude=${lon}`
        + `&hourly=wave_height,wave_period,wave_direction,ocean_current_velocity`
        + `&current=wave_height,wave_period,wave_direction`
        + `&wind_speed_unit=kn&length_unit=imperial`
      ),
      fetch(
        `https://api.open-meteo.com/v1/forecast`
        + `?latitude=${lat}&longitude=${lon}`
        + `&current=temperature_2m,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index`
        + `&hourly=temperature_2m,wind_speed_10m,weather_code`
        + `&daily=sunrise,sunset`
        + `&wind_speed_unit=kn&temperature_unit=fahrenheit&timezone=auto`
      ),
    ]);

    const marine   = await marineRes.json();
    const forecast = await forecastRes.json();

    const cur  = forecast.current;
    const mari = marine.current;

    const windKts   = cur?.wind_speed_10m ?? 0;
    const windDir   = degreesToCardinal(cur?.wind_direction_10m ?? 0);
    const pressHpa  = cur?.surface_pressure ?? 1013;
    const pressInHg = (pressHpa * 0.02953).toFixed(2);

    const data = {
      wind: {
        speedKts:      Math.round(windKts),
        direction:     windDir,
        speedCategory: windCategory(windKts),
        gustKts:       Math.round(windKts * 1.3), // estimate
      },
      pressure: {
        inHg:  parseFloat(pressInHg),
        trend: 'stable', // would need historical comparison for real trend
      },
      waveHeight: mari?.wave_height      ?? 1.5,
      wavePeriod: mari?.wave_period      ?? 6,
      waveDir:    degreesToCardinal(mari?.wave_direction ?? 90) + ` ${mari?.wave_direction ?? 90}°`,
      waterTemp:  72, // Open-Meteo marine doesn't include water temp free tier
      visibility: 8,
      uvIndex:    cur?.uv_index ?? 5,
      airTempF:   Math.round(cur?.temperature_2m ?? 80),
      sunrise:    forecast.daily?.sunrise?.[0]
        ? new Date(forecast.daily.sunrise[0]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '6:30 AM',
      sunset: forecast.daily?.sunset?.[0]
        ? new Date(forecast.daily.sunset[0]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : '8:00 PM',
      solunar: computeSolunar(parseFloat(lat), parseFloat(lon)),
    };

    conditionsCache.set(cacheKey, { data, fetchedAt: Date.now() });
    res.json(data);

  } catch (err) {
    console.error('Conditions error:', err);
    res.status(500).json({ error: err.message });
  }
});

function degreesToCardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}

function windCategory(kts) {
  if (kts < 5)  return 'calm';
  if (kts < 15) return 'light';
  if (kts < 25) return 'moderate';
  if (kts < 35) return 'strong';
  return 'gale';
}

function computeSolunar(lat, lon) {
  // Simplified solunar calculation based on moon position
  // For production use the 'solunar' npm package
  const now        = new Date();
  const hourOfDay  = now.getHours() + now.getMinutes() / 60;
  const moonPct    = Math.round(50 + 50 * Math.sin((now.getDate() / 29.5) * Math.PI * 2));

  // Simple heuristic: major windows near moonrise/moonset
  const majorHours = [6.5, 18.5];
  const nearMajor  = majorHours.some(h => Math.abs(hourOfDay - h) < 1.5);
  const atMajor    = majorHours.some(h => Math.abs(hourOfDay - h) < 0.5);

  return {
    window:       atMajor ? 'major_peak' : nearMajor ? 'major_near' : 'between',
    moonPhase:    moonPct > 85 || moonPct < 15 ? (moonPct > 50 ? 'full' : 'new') : 'other',
    moonPct,
    lightWindow:  hourOfDay < 7.5 ? 'dawn' : hourOfDay > 19.5 ? 'dusk' : 'other',
    majorWindows: [
      { label: 'MAJ', xPct: 0.28 },
      { label: 'MAJ', xPct: 0.78 },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/rewards/profile — points balance and tier
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/rewards/profile', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });

  try {
    const user = await getOrCreateUser(deviceId);

    const today = new Date().toISOString().slice(0, 10);
    const { rows: todayRows } = await pool.query(
      `SELECT COALESCE(SUM(pts_awarded),0) AS total FROM catches
       WHERE user_id=$1 AND DATE(caught_at)=$2`,
      [user.id, today]
    );

    const { rows: milestoneRows } = await pool.query(
      `SELECT key FROM milestones WHERE user_id=$1`,
      [user.id]
    );

    res.json({
      pointsBalance:       user.points_balance,
      tier:                getTierKey(user.points_balance),
      dailyPtsEarned:      parseInt(todayRows[0].total),
      dailyPtsDate:        today,
      completedMilestones: milestoneRows.map(r => r.key),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getTierKey(pts) {
  if (pts >= 5000) return 'bone_tide_legend';
  if (pts >= 3000) return 'marsh_guide';
  if (pts >= 500)  return 'tide_angler';
  return 'cast_member';
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/redeem — generate Shopify discount code, hold points
// Body: { deviceId, shopifyProductId, productTitle, pointsCost }
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/redeem', async (req, res) => {
  const { deviceId, shopifyProductId, productTitle, pointsCost } = req.body;
  if (!deviceId || !pointsCost) {
    return res.status(400).json({ error: 'deviceId and pointsCost required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock user row to prevent race conditions
    const { rows: [user] } = await client.query(
      'SELECT id, points_balance FROM users WHERE device_id=$1 FOR UPDATE',
      [deviceId]
    );
    if (!user) throw new Error('User not found');
    if (user.points_balance < pointsCost) {
      throw new Error(`Insufficient points. Have ${user.points_balance}, need ${pointsCost}.`);
    }

    // Check for existing pending hold on this product
    const { rows: existing } = await client.query(
      `SELECT id FROM points_holds
       WHERE user_id=$1 AND shopify_product_id=$2
         AND status='pending' AND expires_at > NOW()`,
      [user.id, shopifyProductId]
    );
    if (existing.length) {
      throw new Error('You already have a pending redemption for this item.');
    }

    // Generate Shopify discount code via Admin API
    const codeStr  = `BTC-${deviceId.slice(-6).toUpperCase()}-${Date.now()}`;
    const priceRule = await shopifyAdminPost('/price_rules.json', {
      price_rule: {
        title:              codeStr,
        target_type:        'line_item',
        target_selection:   'entitled',
        allocation_method:  'across',
        value_type:         'percentage',
        value:              '-100.0',
        customer_selection: 'all',
        usage_limit:        1,
        once_per_customer:  true,
        starts_at:          new Date().toISOString(),
        ends_at:            new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        entitled_product_ids: [
          shopifyProductId.replace('gid://shopify/Product/', ''),
        ],
      },
    });

    const discountCode = await shopifyAdminPost(
      `/price_rules/${priceRule.price_rule.id}/discount_codes.json`,
      { discount_code: { code: codeStr } }
    );

    // Write hold — points NOT deducted yet
    await client.query(
      `INSERT INTO points_holds
         (user_id, points_held, shopify_product_id, product_title,
          discount_code, discount_code_id, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'pending', NOW() + INTERVAL '24 hours')`,
      [user.id, pointsCost, shopifyProductId, productTitle,
       discountCode.discount_code.code,
       discountCode.discount_code.id.toString()]
    );

    await client.query('COMMIT');

    res.json({
      discountCode: discountCode.discount_code.code,
      pointsHeld:   pointsCost,
      expiresIn:    '24 hours',
      message:      'Apply this code at checkout. Points deducted on order confirmation.',
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Redeem error:', err);
    res.status(err.message.includes('Insufficient') ? 402 : 500)
      .json({ error: err.message });
  } finally {
    client.release();
  }
});

async function shopifyAdminPost(path, body) {
  const url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01${path}`;
  const res  = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type':         'application/json',
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data.errors ?? data));
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /webhooks/shopify/orders-paid
// Shopify fires this when an order is paid — deduct held points
// ─────────────────────────────────────────────────────────────────────────────

async function handleShopifyWebhook(req, res) {
  // Verify HMAC signature
  const hmac   = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('base64');

  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac ?? ''))) {
    return res.status(401).end();
  }

  // Always ack immediately — Shopify retries on timeout
  res.status(200).end();

  const order = JSON.parse(req.body.toString());
  const codes = (order.discount_codes ?? [])
    .map(d => d.code.toUpperCase())
    .filter(c => c.startsWith('BTC-'));

  for (const code of codes) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: [hold] } = await client.query(
        `SELECT id, user_id, points_held FROM points_holds
         WHERE discount_code=$1 AND status='pending' FOR UPDATE`,
        [code]
      );
      if (!hold) { await client.query('ROLLBACK'); continue; }

      // Confirm hold
      await client.query(
        `UPDATE points_holds
         SET status='confirmed', confirmed_at=NOW(), shopify_order_id=$1
         WHERE id=$2`,
        [order.id.toString(), hold.id]
      );

      // Deduct from balance (guard against going negative)
      await client.query(
        `UPDATE users
         SET points_balance = GREATEST(0, points_balance - $1)
         WHERE id=$2`,
        [hold.points_held, hold.user_id]
      );

      // Audit log
      await client.query(
        `INSERT INTO points_transactions (user_id, delta, reason, reference_id, created_at)
         VALUES ($1, $2, 'redemption', $3, NOW())`,
        [hold.user_id, -hold.points_held, order.id.toString()]
      );

      await client.query('COMMIT');
      console.log(`Points confirmed: user=${hold.user_id} -${hold.points_held} order=${order.id}`);

    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Webhook deduction error:', code, err.message);
    } finally {
      client.release();
    }
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// GET /api/products — fetch Shopify products via Admin REST API
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/products', async (req, res) => {
  try {
    const url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/products.json?limit=50&status=active`;
    const response = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json();
    if (!data.products) throw new Error('No products returned from Shopify');

    const products = data.products.map(p => {
      const price    = parseFloat(p.variants?.[0]?.price ?? '0');
      const points   = Math.round((price * 125) / 500) * 500;
      const variants = p.variants.map(v => ({
        id:             v.id.toString(),
        title:          v.title,
        availableForSale: v.inventory_quantity > 0,
      }));
      const totalInventory = p.variants.reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0);

      return {
        id:       `gid://shopify/Product/${p.id}`,
        title:    p.title,
        handle:   p.handle,
        type:     p.product_type?.toLowerCase() ?? 'other',
        tags:     p.tags ? p.tags.split(', ') : [],
        price:    price.toFixed(2),
        points,
        variants,
        inStock:  totalInventory > 0,
        lowStock: totalInventory > 0 && totalInventory <= 5,
        image:    p.images?.[0]?.src ?? null,
      };
    });

    res.json({ products });
  } catch (err) {
    console.error('Products error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Start server
// ─────────────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bone Tide Co. API running on port ${PORT}`);
});
