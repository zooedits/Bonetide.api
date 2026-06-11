// server.js — Bone Tide Co. Backend
import express    from 'express';
import cors       from 'cors';
import crypto     from 'crypto';
import pg         from 'pg';
import fetch      from 'node-fetch';
import { OAuth2Client } from 'google-auth-library';
import jwt           from 'jsonwebtoken';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET       = process.env.JWT_SECRET;
const googleClient     = new OAuth2Client(GOOGLE_CLIENT_ID);

function issueJwt(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '90d' });
}

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

const app = express();
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

app.post('/webhooks/shopify/orders-paid',
  express.raw({ type: 'application/json' }),
  handleShopifyWebhook
);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

async function getOrCreateUser(deviceId) {
  if (!deviceId) throw new Error('deviceId required');
  const existing = await pool.query(
    'SELECT id, points_balance FROM users WHERE device_id = $1', [deviceId]
  );
  if (existing.rows.length) return existing.rows[0];
  const created = await pool.query(
    `INSERT INTO users (device_id, points_balance, created_at)
     VALUES ($1, 0, NOW()) RETURNING id, points_balance`, [deviceId]
  );
  return created.rows[0];
}

// JWT first (logged-in), deviceId fallback (guest)
async function getUserFromRequest(req) {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const { rows } = await pool.query(
        'SELECT id, points_balance FROM users WHERE google_id=$1 LIMIT 1',
        [decoded.id]
      );
      if (rows.length) return rows[0];
    } catch {}
  }
  const deviceId = req.body?.deviceId || req.query?.deviceId;
  if (deviceId) return getOrCreateUser(deviceId);
  throw new Error('No auth token or deviceId');
}

app.get('/health', (req, res) => res.json({ status: 'ok', service: 'Bone Tide Co. API' }));

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/radar — Iowa State Mesonet NEXRAD animated frames
// Fetches real available timestamps from IEM — classic colors, unlimited zoom
// ─────────────────────────────────────────────────────────────────────────────
const radarCache = { data: null, fetchedAt: 0 };

app.get('/api/radar', async (req, res) => {
  if (radarCache.data && (Date.now() - radarCache.fetchedAt) < 2 * 60 * 1000) {
    return res.json(radarCache.data);
  }
  try {
    // Ask IEM for actual available N0Q composite scan times
    const r = await fetch(
      'https://mesonet.agron.iastate.edu/json/radar.py?operation=products&product=N0Q&radar=USCOMP&start=&fmt=json',
      { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'BoneTideCo/1.0' } }
    );
    const data = await r.json();
    const rawTimes = (data?.data || []).map(d => d.valid || d.time || d.ts).filter(Boolean);

    let frames = [];
    if (rawTimes.length) {
      frames = rawTimes.slice(-12).map(t => {
        const d = new Date(t);
        const pad = n => String(n).padStart(2, '0');
        const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
        return {
          time: Math.floor(d.getTime() / 1000),
          isoTime: d.toISOString(),
          tileUrl: `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-${ts}/{z}/{x}/{y}.png`,
          isForecast: false,
        };
      });
    }

    // Fallback: generate plausible timestamps with 3-min processing lag
    if (!frames.length) {
      const now = new Date();
      for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getTime() - (i * 5 + 3) * 60 * 1000);
        d.setUTCSeconds(0, 0);
        const pad = n => String(n).padStart(2, '0');
        const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
        frames.push({
          time: Math.floor(d.getTime() / 1000),
          isoTime: d.toISOString(),
          tileUrl: `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-${ts}/{z}/{x}/{y}.png`,
          isForecast: false,
        });
      }
    }

    radarCache.data = { frames };
    radarCache.fetchedAt = Date.now();
    res.json({ frames });
  } catch (err) {
    console.error('Radar error:', err.message);
    // Last resort: single live tile
    res.json({ frames: [{
      time: Math.floor(Date.now() / 1000),
      isoTime: new Date().toISOString(),
      tileUrl: 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png',
      isForecast: false,
    }]});
  }
});

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken, deviceId } = req.body ?? {};
    if (!idToken) return res.status(400).json({ error: 'idToken required' });
    const ticket  = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload.email_verified) return res.status(403).json({ error: 'Google account email not verified' });
    const user = { id: payload.sub, email: payload.email, name: payload.name ?? '', avatar: payload.picture ?? null };

    // Upsert Google user
    await pool.query(
      `INSERT INTO users (google_id, email, name, avatar, points_balance, created_at)
       VALUES ($1, $2, $3, $4, 0, NOW())
       ON CONFLICT (google_id) DO UPDATE SET email=EXCLUDED.email, name=EXCLUDED.name, avatar=EXCLUDED.avatar`,
      [user.id, user.email, user.name, user.avatar]
    );

    // Get the Google user's DB row
    const { rows: [googleUser] } = await pool.query(
      'SELECT id, points_balance FROM users WHERE google_id=$1', [user.id]
    );

    // ── Merge device user catches + points into Google account ──────────────
    // Only runs if deviceId sent and a device user exists (first login on this device)
    if (deviceId) {
      const { rows: deviceUsers } = await pool.query(
        'SELECT id, points_balance FROM users WHERE device_id=$1 AND google_id IS NULL', [deviceId]
      );
      if (deviceUsers.length) {
        const deviceUser = deviceUsers[0];
        if (deviceUser.id !== googleUser.id) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            // Move catches to Google account
            await client.query('UPDATE catches SET user_id=$1 WHERE user_id=$2', [googleUser.id, deviceUser.id]);
            // Move points transactions
            await client.query('UPDATE points_transactions SET user_id=$1 WHERE user_id=$2', [googleUser.id, deviceUser.id]);
            // Add device user's points balance to Google account
            await client.query('UPDATE users SET points_balance=points_balance+$1 WHERE id=$2', [deviceUser.points_balance, googleUser.id]);
            // Link device_id to Google account so future guest sessions also merge
            await client.query('UPDATE users SET device_id=$1 WHERE id=$2', [deviceId, googleUser.id]);
            // Remove old device user
            await client.query('DELETE FROM users WHERE id=$1', [deviceUser.id]);
            await client.query('COMMIT');
            console.log(`[auth] Merged device user ${deviceUser.id} into Google user ${googleUser.id}`);
          } catch (mergeErr) {
            await client.query('ROLLBACK');
            console.error('[auth] Merge failed (non-fatal):', mergeErr.message);
          } finally {
            client.release();
          }
        }
      }
    }

    return res.json({ token: issueJwt(user), user });
  } catch (err) {
    console.error('[auth] Google verification failed:', err.message);
    return res.status(401).json({ error: 'Google token verification failed' });
  }
});

const REGION_SPECIES = {
  southeast:   ['Redfish', 'Speckled Trout', 'Flounder', 'Sheepshead', 'Red Snapper', 'Cobia', 'King Mackerel'],
  gulf:        ['Redfish', 'Speckled Trout', 'Snook', 'Tarpon', 'Red Snapper', 'Cobia'],
  midatlantic: ['Striped Bass', 'Fluke', 'Weakfish', 'Bluefish'],
  northeast:   ['Striped Bass', 'Fluke', 'Bluefish', 'Black Sea Bass'],
  westcoast:   ['Pacific Halibut', 'Lingcod', 'Rockfish', 'Cabezon'],
};

app.post('/api/identify', async (req, res) => {
  const { deviceId, image, region = 'southeast' } = req.body;
  if (!image) return res.status(400).json({ error: 'image (base64) required' });
  const speciesList = REGION_SPECIES[region] ?? REGION_SPECIES.southeast;
  const prompt = `You are a marine biologist assistant for Bone Tide Co., a fishing app serving ${region} anglers.
Identify the fish in this photo. Primary species to look for: ${speciesList.join(', ')}.
Respond ONLY with a valid JSON object, no markdown, no explanation:
{"commonName":"string","latinName":"string","confidence":0.0,"inRegion":true,"habitat":"inshore","catchRelease":false,"notes":"string"}
If you cannot identify the fish with reasonable confidence, return confidence below 0.5.`;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 300, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } }, { type: 'text', text: prompt }] }] }),
    });
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const result = JSON.parse(data.content[0].text.replace(/```json|```/g, '').trim());
    result.fallbackImageUrl = null;
    res.json(result);
  } catch (err) {
    console.error('Identify error:', err);
    res.status(500).json({ error: 'Fish identification failed. Please try again.' });
  }
});

const DAILY_CAP = 30, PTS_PER_CATCH = 10;

app.post('/api/catches', async (req, res) => {
  const { species, lengthIn, released, bait, note, lat, lon, tideHeightFt, tideDirection, windKts, windDirection, baroInHg, moonPct, goodBiteScore, sessionToken, imageUrl, isPublic } = req.body;
  if (!species) return res.status(400).json({ error: 'species required' });
  try {
    const user = await getUserFromRequest(req);
    const today = new Date().toISOString().slice(0, 10);
    const { rows: todayRows } = await pool.query(`SELECT COALESCE(SUM(pts_awarded), 0) AS total FROM catches WHERE user_id=$1 AND DATE(caught_at)=$2`, [user.id, today]);
    const todayPts = parseInt(todayRows[0].total);
    const ptsLeft = Math.max(0, DAILY_CAP - todayPts);
    const ptsAwarded = sessionToken && ptsLeft > 0 ? Math.min(PTS_PER_CATCH, ptsLeft) : 0;
    const { rows: [newCatch] } = await pool.query(
      `INSERT INTO catches (user_id,species,length_in,released,bait,note,lat,lon,tide_height_ft,tide_direction,wind_kts,wind_direction,baro_in_hg,moon_pct,good_bite_score,pts_awarded,image_url,is_public,caught_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW()) RETURNING *`,
      [user.id,species,lengthIn,released??true,bait,note,lat,lon,tideHeightFt,tideDirection,windKts,windDirection,baroInHg,moonPct,goodBiteScore,ptsAwarded,imageUrl??null,isPublic??false]
    );
    if (ptsAwarded > 0) {
      await pool.query(`UPDATE users SET points_balance=points_balance+$1 WHERE id=$2`, [ptsAwarded, user.id]);
      await pool.query(`INSERT INTO points_transactions(user_id,delta,reason,reference_id,created_at) VALUES($1,$2,'catch',$3,NOW())`, [user.id, ptsAwarded, newCatch.id.toString()]);
    }
    res.json({ catch: formatCatch(newCatch), ptsAwarded, dailyTotal: todayPts+ptsAwarded, dailyCap: DAILY_CAP });
  } catch (err) {
    console.error('Log catch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catches', async (req, res) => {
  const { page=1, limit=20 } = req.query;
  try {
    const user = await getUserFromRequest(req);
    const offset = (parseInt(page)-1)*parseInt(limit);
    const { rows } = await pool.query(`SELECT * FROM catches WHERE user_id=$1 ORDER BY caught_at DESC LIMIT $2 OFFSET $3`, [user.id, limit, offset]);
    res.json({ catches: rows.map(formatCatch), page: parseInt(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function formatCatch(row) {
  return { id: row.id, species: row.species, lengthIn: row.length_in, released: row.released, bait: row.bait, note: row.note, lat: row.lat, lon: row.lon, tideHeightFt: row.tide_height_ft, tideDirection: row.tide_direction, windKts: row.wind_kts, windDirection: row.wind_direction, baroInHg: row.baro_in_hg, moonPct: row.moon_pct, goodBiteScore: row.good_bite_score, ptsAwarded: row.pts_awarded, imageUrl: row.image_url ?? null, isPublic: row.is_public ?? false, caughtAt: row.caught_at };
}

const tidePredictionsCache = new Map();

app.get('/api/tides', async (req, res) => {
  const { station = '8677344', days = 7 } = req.query;
  const cached = tidePredictionsCache.get(station);
  let predictions;
  if (cached && (Date.now() - cached.fetchedAt) < 6 * 3600 * 1000) {
    predictions = cached.predictions;
  } else {
    try {
      const today = new Date();
      const end   = new Date(today);
      end.setDate(end.getDate() + parseInt(days));
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${fmt(today)}&end_date=${fmt(end)}&station=${station}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=h&units=english&application=bonetideco&format=json`;
      const response = await fetch(url);
      const noaaData = await response.json();
      if (!noaaData.predictions) throw new Error(noaaData.error?.message ?? 'NOAA returned no predictions');
      predictions = noaaData.predictions.map(p => ({ t: p.t, v: parseFloat(p.v) }));
      tidePredictionsCache.set(station, { predictions, fetchedAt: Date.now() });
    } catch (err) {
      console.error('Tides error:', err);
      return res.status(500).json({ error: err.message });
    }
  }
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  let beforePt = null, afterPt = null;
  for (let i = 0; i < predictions.length - 1; i++) {
    if (predictions[i].t <= nowStr && predictions[i+1].t > nowStr) { beforePt = predictions[i]; afterPt = predictions[i+1]; break; }
  }
  let currentHeight, currentDirection, currentPhase;
  if (beforePt && afterPt) {
    const t0 = new Date(beforePt.t.replace(' ', 'T')).getTime();
    const t1 = new Date(afterPt.t.replace(' ', 'T')).getTime();
    const frac = (now.getTime() - t0) / (t1 - t0);
    currentHeight = beforePt.v + frac * (afterPt.v - beforePt.v);
    const rising = afterPt.v > beforePt.v;
    currentDirection = rising ? 'Incoming' : 'Outgoing';
    currentPhase = Math.abs(afterPt.v - beforePt.v) < 0.3 ? (rising ? 'slack_high' : 'slack_low') : (rising ? 'incoming_fast' : 'outgoing_fast');
  } else {
    const closest = predictions.reduce((best, p) => Math.abs(new Date(p.t.replace(' ', 'T')) - now) < Math.abs(new Date(best.t.replace(' ', 'T')) - now) ? p : best, predictions[0]);
    currentHeight = closest?.v ?? null; currentDirection = 'Incoming'; currentPhase = 'incoming_fast';
  }
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const todayVals = predictions.filter(p => p.t.startsWith(todayStr)).map(p => p.v);
  const dailyRange = todayVals.length ? Math.max(...todayVals) - Math.min(...todayVals) : 6;
  res.json({
    stationId: station,
    predictions: predictions.map(p => ({ t: new Date(p.t.replace(' ', 'T')).toISOString(), v: p.v })),
    currentHeight: Math.round(currentHeight * 100) / 100,
    currentDirection, currentPhase, dailyRange,
  });
});

const conditionsCache = new Map();

app.get('/api/conditions', async (req, res) => {
  const { lat = '31.1234', lon = '-81.4567' } = req.query;
  const cacheKey = `${lat}_${lon}`;
  const cached = conditionsCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < 30 * 60 * 1000) return res.json(cached.data);
  try {
    const [marineRes, forecastRes] = await Promise.all([
      fetch(`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_period,wave_direction&wind_speed_unit=kn&length_unit=imperial`),
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index&daily=sunrise,sunset&wind_speed_unit=kn&temperature_unit=fahrenheit&timezone=auto`),
    ]);
    const marine = await marineRes.json();
    const forecast = await forecastRes.json();
    const cur = forecast.current, mari = marine.current;
    const windKts = cur?.wind_speed_10m ?? 0;
    const windDir = degreesToCardinal(cur?.wind_direction_10m ?? 0);
    const pressHpa = cur?.surface_pressure ?? 1013;
    const data = {
      wind: { speedKts: Math.round(windKts), direction: windDir, directionDeg: cur?.wind_direction_10m ?? 0, speedCategory: windCategory(windKts), gustKts: Math.round(windKts * 1.3) },
      pressure: { inHg: parseFloat((pressHpa * 0.02953).toFixed(2)), trend: 'stable' },
      waveHeight: mari?.wave_height ?? null,
      wavePeriod: mari?.wave_period ?? null,
      waveDir: mari?.wave_direction != null ? degreesToCardinal(mari.wave_direction) + ` ${mari.wave_direction}°` : null,
      waterTemp: null,
      visibility: 8,
      uvIndex: cur?.uv_index ?? 5,
      airTempF: Math.round(cur?.temperature_2m ?? 80),
      sunrise: forecast.daily?.sunrise?.[0] ? new Date(forecast.daily.sunrise[0]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '6:30 AM',
      sunset:  forecast.daily?.sunset?.[0]  ? new Date(forecast.daily.sunset[0]).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '8:00 PM',
      solunar: computeSolunar(parseFloat(lat), parseFloat(lon)),
    };
    conditionsCache.set(cacheKey, { data, fetchedAt: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('Conditions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/marine — Open-Meteo Marine + NOAA water temp fallback
// 100% free, no API keys, no quota
// Sources:
//   • Open-Meteo Marine API — waves, swell, currents, sea surface temp
//   • NOAA CO-OPS — water temp fallback for inshore/estuary locations
//     where Open-Meteo marine model has no coverage
// ─────────────────────────────────────────────────────────────────────────────
const marineCache = new Map();

app.get('/api/marine', async (req, res) => {
  const { lat = '31.1234', lon = '-81.4567' } = req.query;
  const cacheKey = `${parseFloat(lat).toFixed(2)}_${parseFloat(lon).toFixed(2)}`;
  const cached = marineCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < 60 * 60 * 1000) return res.json(cached.data);

  try {
    // ── Open-Meteo Marine ─────────────────────────────────────────────────────
    // current= fields give us the latest snapshot (no hourly parsing needed)
    const marineUrl = [
      `https://marine-api.open-meteo.com/v1/marine`,
      `?latitude=${lat}&longitude=${lon}`,
      `&current=wave_height,wave_period,wave_direction`,
      `,swell_wave_height,swell_wave_period,swell_wave_direction`,
      `,ocean_current_velocity,ocean_current_direction`,
      `,sea_surface_temperature`,
      `&wind_speed_unit=kn&length_unit=imperial`,
    ].join('');

    const marineRes = await fetch(marineUrl, { signal: AbortSignal.timeout(8000) });
    const marineData = await marineRes.json();
    const mc = marineData.current ?? {};

    const round1 = v => v != null ? Math.round(v * 10) / 10 : null;
    const round0 = v => v != null ? Math.round(v) : null;

    // Ocean current velocity from Open-Meteo is already in knots
    const currentSpeedKts = round1(mc.ocean_current_velocity ?? null);
    const currentDirDeg   = round0(mc.ocean_current_direction ?? null);

    // Sea surface temp from Open-Meteo is in °C
    let waterTempF = mc.sea_surface_temperature != null
      ? round1(mc.sea_surface_temperature * 9/5 + 32)
      : null;

    // ── NOAA water temp fallback ──────────────────────────────────────────────
    // Open-Meteo marine model only covers open ocean — inshore/estuary coords
    // return null for sea_surface_temperature. Fall back to nearest NOAA station.
    if (waterTempF == null) {
      try {
        const noaaWaterUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
          + `?date=latest&station=nearest&product=water_temperature`
          + `&units=english&time_zone=lst_ldt&format=json`
          + `&lat=${lat}&lon=${lon}`;
        // NOAA doesn't support lat/lon lookup directly for water_temperature,
        // so we find the nearest station first then fetch its water temp
        const stRes = await fetch(
          'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels&units=english',
          { signal: AbortSignal.timeout(5000) }
        );
        const stData = await stRes.json();
        if (stData.stations?.length) {
          const userLat = parseFloat(lat), userLon = parseFloat(lon);
          const nearest = stData.stations.map(st => {
            const dLat = (st.lat - userLat) * Math.PI / 180;
            const dLon = (st.lng - userLon) * Math.PI / 180;
            const a = Math.sin(dLat/2)**2 + Math.cos(userLat*Math.PI/180)*Math.cos(st.lat*Math.PI/180)*Math.sin(dLon/2)**2;
            return { ...st, distKm: 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) };
          }).sort((a, b) => a.distKm - b.distKm)[0];

          if (nearest) {
            const wtUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter`
              + `?date=latest&station=${nearest.id}&product=water_temperature`
              + `&units=english&time_zone=lst_ldt&format=json`;
            const wtRes = await fetch(wtUrl, { signal: AbortSignal.timeout(5000) });
            const wtData = await wtRes.json();
            const tempF = parseFloat(wtData.data?.[0]?.v);
            if (!isNaN(tempF)) waterTempF = round1(tempF);
          }
        }
      } catch (noaaErr) {
        console.warn('NOAA water temp fallback failed:', noaaErr.message);
      }
    }

    const data = {
      // Currents
      currentSpeedKts,
      currentDirection:     currentDirDeg,
      currentDirectionCard: currentDirDeg != null ? degreesToCardinal(currentDirDeg) : null,

      // Waves
      waveHeightFt:  round1(mc.wave_height ?? null),
      wavePeriodSec: round1(mc.wave_period ?? null),
      waveDirection: round0(mc.wave_direction ?? null),
      waveDirCard:   mc.wave_direction != null ? degreesToCardinal(mc.wave_direction) : null,

      // Swell
      swellHeightFt:  round1(mc.swell_wave_height ?? null),
      swellPeriodSec: round1(mc.swell_wave_period ?? null),
      swellDirection: round0(mc.swell_wave_direction ?? null),
      swellDirCard:   mc.swell_wave_direction != null ? degreesToCardinal(mc.swell_wave_direction) : null,

      // Water
      waterTempF,

      // Visibility — not in Open-Meteo marine; comes from /api/conditions
      visibilityMi: null,

      // Wind — comes from /api/conditions (Open-Meteo atmosphere)
      windSpeedKts: null,
      windDirCard:  null,

      fetchedAt: new Date().toISOString(),
      source: 'open-meteo-marine',
    };

    marineCache.set(cacheKey, { data, fetchedAt: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('Marine error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function degreesToCardinal(deg) {
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(deg / 45) % 8];
}
function windCategory(kts) {
  if (kts < 5) return 'calm'; if (kts < 15) return 'light';
  if (kts < 25) return 'moderate'; if (kts < 35) return 'strong'; return 'gale';
}
function computeSolunar(lat, lon) {
  const now = new Date();
  const hourOfDay = now.getHours() + now.getMinutes() / 60;
  const moonPct = Math.round(50 + 50 * Math.sin((now.getDate() / 29.5) * Math.PI * 2));
  const majorHours = [6.5, 18.5];
  const nearMajor = majorHours.some(h => Math.abs(hourOfDay - h) < 1.5);
  const atMajor   = majorHours.some(h => Math.abs(hourOfDay - h) < 0.5);
  return {
    window: atMajor ? 'major_peak' : nearMajor ? 'major_near' : 'between',
    moonPhase: moonPct > 85 || moonPct < 15 ? (moonPct > 50 ? 'full' : 'new') : 'other',
    moonPct,
    lightWindow: hourOfDay < 7.5 ? 'dawn' : hourOfDay > 19.5 ? 'dusk' : 'other',
    majorWindows: [{ label: 'MAJ', xPct: 0.28 }, { label: 'MAJ', xPct: 0.78 }],
  };
}

app.get('/api/rewards/profile', async (req, res) => {
  const { deviceId } = req.query;
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const user = await getOrCreateUser(deviceId);
    const today = new Date().toISOString().slice(0, 10);
    const { rows: todayRows } = await pool.query(`SELECT COALESCE(SUM(pts_awarded),0) AS total FROM catches WHERE user_id=$1 AND DATE(caught_at)=$2`, [user.id, today]);
    const { rows: milestoneRows } = await pool.query(`SELECT key FROM milestones WHERE user_id=$1`, [user.id]);
    res.json({ pointsBalance: user.points_balance, tier: getTierKey(user.points_balance), dailyPtsEarned: parseInt(todayRows[0].total), dailyPtsDate: today, completedMilestones: milestoneRows.map(r => r.key) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function getTierKey(pts) {
  if (pts >= 5000) return 'bone_tide_legend'; if (pts >= 3000) return 'marsh_guide';
  if (pts >= 500) return 'tide_angler'; return 'cast_member';
}

app.post('/api/redeem', async (req, res) => {
  const { deviceId, shopifyProductId, productTitle, pointsCost } = req.body;
  if (!deviceId || !pointsCost) return res.status(400).json({ error: 'deviceId and pointsCost required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query('SELECT id, points_balance FROM users WHERE device_id=$1 FOR UPDATE', [deviceId]);
    if (!user) throw new Error('User not found');
    const { rows: existing } = await client.query(`SELECT id FROM points_holds WHERE user_id=$1 AND shopify_product_id=$2 AND status='pending' AND expires_at > NOW()`, [user.id, shopifyProductId]);
    if (existing.length) throw new Error('You already have a pending redemption for this item.');
    const safePoints = Math.floor(pointsCost / 500) * 500;
    if (safePoints < 500) throw new Error('Minimum redemption is 500 points ($4.00).');
    const dollarValue = (safePoints / 125).toFixed(2);
    if (user.points_balance < safePoints) throw new Error(`Insufficient points. You have ${user.points_balance.toLocaleString()} pts, need ${safePoints.toLocaleString()} pts.`);
    const codeStr = `BTC-${deviceId.slice(-6).toUpperCase()}-${Date.now()}`;
    const priceRule = await shopifyAdminPost('/price_rules.json', { price_rule: { title: codeStr, target_type: 'line_item', target_selection: 'all', allocation_method: 'across', value_type: 'fixed_amount', value: `-${dollarValue}`, customer_selection: 'all', usage_limit: 1, once_per_customer: true, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 48*3600*1000).toISOString() } });
    const discountCode = await shopifyAdminPost(`/price_rules/${priceRule.price_rule.id}/discount_codes.json`, { discount_code: { code: codeStr } });
    await client.query(`INSERT INTO points_holds (user_id,points_held,shopify_product_id,product_title,discount_code,discount_code_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW()+INTERVAL '48 hours')`, [user.id, safePoints, shopifyProductId, productTitle, discountCode.discount_code.code, discountCode.discount_code.id.toString()]);
    await client.query('COMMIT');
    res.json({ discountCode: discountCode.discount_code.code, pointsDeducted: safePoints, dollarValue: parseFloat(dollarValue), newBalance: user.points_balance, expiresIn: '48 hours', message: 'Apply this code at checkout on bonetideco.com. Points deducted when your order is confirmed.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Redeem error:', err);
    res.status(err.message.includes('Insufficient') ? 402 : 500).json({ error: err.message });
  } finally { client.release(); }
});

async function shopifyAdminPost(path, body) {
  const url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2025-01${path}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data.errors ?? data));
  return data;
}

async function handleShopifyWebhook(req, res) {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET).update(req.body).digest('base64');
  if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmac ?? ''))) return res.status(401).end();
  res.status(200).end();
  const order = JSON.parse(req.body.toString());
  const codes = (order.discount_codes ?? []).map(d => d.code.toUpperCase()).filter(c => c.startsWith('BTC-'));
  for (const code of codes) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [hold] } = await client.query(`SELECT id,user_id,points_held FROM points_holds WHERE discount_code=$1 AND status='pending' FOR UPDATE`, [code]);
      if (!hold) { await client.query('ROLLBACK'); continue; }
      await client.query(`UPDATE points_holds SET status='confirmed',confirmed_at=NOW(),shopify_order_id=$1 WHERE id=$2`, [order.id.toString(), hold.id]);
      await client.query(`UPDATE users SET points_balance=GREATEST(0,points_balance-$1) WHERE id=$2`, [hold.points_held, hold.user_id]);
      await client.query(`INSERT INTO points_transactions(user_id,delta,reason,reference_id,created_at) VALUES($1,$2,'redemption',$3,NOW())`, [hold.user_id, -hold.points_held, order.id.toString()]);
      await client.query('COMMIT');
    } catch (err) { await client.query('ROLLBACK'); console.error('Webhook error:', code, err.message); }
    finally { client.release(); }
  }
}

const currentsCache = new Map();

app.get('/api/currents', async (req, res) => {
  const { lat = '31.1234', lon = '-81.4567' } = req.query;
  const cacheKey = `${parseFloat(lat).toFixed(2)}_${parseFloat(lon).toFixed(2)}`;
  const cached = currentsCache.get(cacheKey);
  if (cached && (Date.now() - cached.fetchedAt) < 60*60*1000) return res.json(cached.data);
  try {
    const stRes = await fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions&units=english', { signal: AbortSignal.timeout(6000) });
    const stData = await stRes.json();
    if (!stData.stations?.length) throw new Error('No current stations returned');
    const userLat = parseFloat(lat), userLon = parseFloat(lon);
    const nearest = stData.stations.map(st => {
      const dLat = (st.lat-userLat)*Math.PI/180, dLon = (st.lng-userLon)*Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(userLat*Math.PI/180)*Math.cos(st.lat*Math.PI/180)*Math.sin(dLon/2)**2;
      return { ...st, distKm: 6371*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)) };
    }).sort((a,b) => a.distKm-b.distKm).slice(0,3);
    const dateStr = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const nowMs = Date.now();
    const stationsWithData = await Promise.all(nearest.map(async st => {
      try {
        const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${dateStr}&range=2&station=${st.id}&product=currents_predictions&time_zone=lst_ldt&interval=MAX_SLACK&units=english&application=bonetideco&format=json`;
        const predRes = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const predData = await predRes.json();
        const preds = predData.current_predictions?.cp ?? [];
        let closest = null, minDiff = Infinity;
        for (const p of preds) { const diff = Math.abs(new Date(p.Time).getTime()-nowMs); if (diff < minDiff) { minDiff = diff; closest = p; } }
        const velocityMajor = closest ? parseFloat(closest.Velocity_Major) : null;
        const speedKts = velocityMajor != null ? Math.abs(velocityMajor) : null;
        const isFlood = velocityMajor != null ? velocityMajor >= 0 : null;
        const floodDir = st.meanFloodDir != null ? parseFloat(st.meanFloodDir) : null;
        const direction = floodDir != null && isFlood != null ? (isFlood ? floodDir : (floodDir+180)%360) : null;
        return { id: st.id, name: st.name, lat: st.lat, lon: st.lng, distMi: Math.round(st.distKm*0.621), speedKts: speedKts != null ? Math.round(speedKts*10)/10 : null, direction, directionLabel: isFlood===null?'—':isFlood?'Flood':'Ebb', isFlood };
      } catch {
        return { id: st.id, name: st.name, lat: st.lat, lon: st.lng, distMi: Math.round(st.distKm*0.621), speedKts: null, direction: null, directionLabel: '—', isFlood: null };
      }
    }));
    const data = { stations: stationsWithData };
    currentsCache.set(cacheKey, { data, fetchedAt: Date.now() });
    res.json(data);
  } catch (err) {
    console.error('Currents error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const url = `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2026-04/products.json?limit=50&status=active`;
    const response = await fetch(url, { headers: { 'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN, 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (!data.products) throw new Error('No products returned from Shopify');
    const products = data.products.map(p => {
      const price = parseFloat(p.variants?.[0]?.price ?? '0');
      const points = Math.round((price*125)/500)*500;
      const variants = p.variants.map(v => ({ id: v.id.toString(), title: v.title, availableForSale: v.inventory_quantity > 0 }));
      const totalInventory = p.variants.reduce((sum,v) => sum+(v.inventory_quantity??0), 0);
      return { id: `gid://shopify/Product/${p.id}`, title: p.title, handle: p.handle, type: p.product_type?.toLowerCase??'other', tags: p.tags?p.tags.split(', '):[], price: price.toFixed(2), points, variants, inStock: totalInventory>0, lowStock: totalInventory>0&&totalInventory<=5 };
    });
    res.json({ products });
  } catch (err) { console.error('Products error:', err); res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bone Tide Co. API running on port ${PORT}`));
