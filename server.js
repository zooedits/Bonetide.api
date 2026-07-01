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
  // `id` is the provider-specific identifier (google sub, apple sub, or
  // email/phone for OTP users). `provider` tells getUserFromRequest which
  // column to look the user up by.
  return jwt.sign({ id: user.id, email: user.email, provider: user.provider }, JWT_SECRET, { expiresIn: '365d' });
}

const PROVIDER_COLUMN = {
  google: 'google_id',
  apple:  'apple_id',
  otp:    'auth_id', // email or phone, normalized
};

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
      const column = PROVIDER_COLUMN[decoded.provider] ?? 'google_id';
      const { rows } = await pool.query(
        `SELECT id, points_balance FROM users WHERE ${column}=$1 LIMIT 1`,
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
// Math-based timestamps, proxied through Railway so iOS WebView can load them
// ─────────────────────────────────────────────────────────────────────────────
const radarCache = { data: null, fetchedAt: 0 };

app.get('/api/radar', async (req, res) => {
  if (radarCache.data && (Date.now() - radarCache.fetchedAt) < 5 * 60 * 1000) {
    return res.json(radarCache.data);
  }
  const frames = [];
  const now = new Date();
  const roundedMs = Math.floor(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  for (let i = 11; i >= 0; i--) {
    const d = new Date(roundedMs - i * 5 * 60 * 1000);
    const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    frames.push({
      time: Math.floor(d.getTime() / 1000),
      isoTime: d.toISOString(),
      tileUrl: `https://bonetideapi-production.up.railway.app/api/radar-tile?t=${ts}_{z}_{x}_{y}`,
      isForecast: false,
    });
  }
  radarCache.data = { frames };
  radarCache.fetchedAt = Date.now();
  res.json({ frames });
});

// GET /api/radar-tile?t=TS_Z_X_Y — proxy IEM tiles, single param avoids Railway & issues
app.get('/api/radar-tile', async (req, res) => {
  const t = req.query.t;
  if (!t) return res.status(400).end();
  const [ts, z, x, y] = t.split('_');
  if (!ts || !z || !x || !y) return res.status(400).end();
  const iemUrl = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-${ts}/${z}/${x}/${y}.png`;
  try {
    const r = await fetch(iemUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BoneTideCo/1.0)' },
    });
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.arrayBuffer();
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(buf));
  } catch {
    res.status(504).end();
  }
});

// Merge a guest/device-id account's catches and points into a newly
// authenticated account (Google, Apple, or email/phone OTP). Generic across
// providers — `idColumn` is the provider-specific column (google_id, apple_id,
// auth_id) so we don't accidentally re-merge an account into itself.
//
// Requires DB migration for Apple + Email/Phone OTP support:
//   ALTER TABLE users ADD COLUMN apple_id text UNIQUE;
//   ALTER TABLE users ADD COLUMN auth_id  text UNIQUE; -- normalized email/phone for OTP users
//   ALTER TABLE users ADD COLUMN phone    text;
async function mergeDeviceUser(deviceId, targetUser, idColumn) {
  if (!deviceId) return;
  const { rows: deviceUsers } = await pool.query(
    `SELECT id, points_balance FROM users WHERE device_id=$1 AND ${idColumn} IS NULL`, [deviceId]
  );
  if (!deviceUsers.length) return;
  const deviceUser = deviceUsers[0];
  if (deviceUser.id === targetUser.id) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE catches SET user_id=$1 WHERE user_id=$2', [targetUser.id, deviceUser.id]);
    await client.query('UPDATE points_transactions SET user_id=$1 WHERE user_id=$2', [targetUser.id, deviceUser.id]);
    await client.query('UPDATE users SET points_balance=points_balance+$1 WHERE id=$2', [deviceUser.points_balance, targetUser.id]);
    await client.query('UPDATE users SET device_id=$1 WHERE id=$2', [deviceId, targetUser.id]);
    await client.query('DELETE FROM users WHERE id=$1', [deviceUser.id]);
    await client.query('COMMIT');
    console.log(`[auth] Merged device user ${deviceUser.id} into user ${targetUser.id}`);
  } catch (mergeErr) {
    await client.query('ROLLBACK');
    console.error('[auth] Merge failed (non-fatal):', mergeErr.message);
  } finally {
    client.release();
  }
}

app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken, deviceId } = req.body ?? {};
    if (!idToken) return res.status(400).json({ error: 'idToken required' });
    const ticket  = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload.email_verified) return res.status(403).json({ error: 'Google account email not verified' });
    const user = { id: payload.sub, email: payload.email, name: '', avatar: payload.picture ?? null, provider: 'google' };

    // Upsert Google user — never write `name` here; the app prompts every
    // user for a display name regardless of auth provider.
    await pool.query(
      `INSERT INTO users (google_id, email, avatar, points_balance, created_at)
       VALUES ($1, $2, $3, 0, NOW())
       ON CONFLICT (google_id) DO UPDATE SET email=EXCLUDED.email, avatar=EXCLUDED.avatar`,
      [user.id, user.email, user.avatar]
    );

    // Get the Google user's DB row
    const { rows: [googleUser] } = await pool.query(
      'SELECT id, points_balance, name FROM users WHERE google_id=$1', [user.id]
    );

    await mergeDeviceUser(deviceId, googleUser, 'google_id');

    user.name = googleUser.name ?? '';
    return res.json({ token: issueJwt(user), user, needsName: !user.name });
  } catch (err) {
    console.error('[auth] Google verification failed:', err.message);
    return res.status(401).json({ error: 'Google token verification failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Apple Sign In
//
// Verifies the identityToken against Apple's published JWKS
// (https://appleid.apple.com/auth/keys). `fullName` is only included by Apple
// on the user's FIRST sign-in ever — we capture it then since it won't be sent
// again on subsequent logins.
// ─────────────────────────────────────────────────────────────────────────────

let appleJwksCache = null;
let appleJwksFetchedAt = 0;

async function getApplePublicKey(kid) {
  if (!appleJwksCache || Date.now() - appleJwksFetchedAt > 24 * 3600 * 1000) {
    const res = await fetch('https://appleid.apple.com/auth/keys', { signal: AbortSignal.timeout(5000) });
    const data = await res.json();
    appleJwksCache = data.keys ?? [];
    appleJwksFetchedAt = Date.now();
  }
  const key = appleJwksCache.find(k => k.kid === kid);
  if (!key) throw new Error('Apple signing key not found');
  return crypto.createPublicKey({ key, format: 'jwk' });
}

async function verifyAppleIdentityToken(identityToken) {
  const [headerB64] = identityToken.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
  const publicKey = await getApplePublicKey(header.kid);
  const decoded = jwt.verify(identityToken, publicKey, {
    algorithms: ['RS256'],
    audience: process.env.APPLE_CLIENT_ID || 'com.bonetideco.app',
    issuer: 'https://appleid.apple.com',
  });
  return decoded; // { sub, email, email_verified, ... }
}

app.post('/api/auth/apple', async (req, res) => {
  try {
    const { identityToken, email: clientEmail, deviceId } = req.body ?? {};
    if (!identityToken) return res.status(400).json({ error: 'identityToken required' });

    const payload = await verifyAppleIdentityToken(identityToken);
    const email = payload.email ?? clientEmail ?? null;

    const user = { id: payload.sub, email, name: '', avatar: null, provider: 'apple' };

    // Upsert Apple user — never write `name` here; the app prompts every
    // user for a display name regardless of auth provider.
    await pool.query(
      `INSERT INTO users (apple_id, email, points_balance, created_at)
       VALUES ($1, $2, 0, NOW())
       ON CONFLICT (apple_id) DO UPDATE SET email=COALESCE(EXCLUDED.email, users.email)`,
      [user.id, user.email]
    );

    const { rows: [appleUser] } = await pool.query(
      'SELECT id, points_balance, name FROM users WHERE apple_id=$1', [user.id]
    );

    await mergeDeviceUser(deviceId, appleUser, 'apple_id');

    user.name = appleUser.name ?? '';
    return res.json({ token: issueJwt(user), user, needsName: !user.name });
  } catch (err) {
    console.error('[auth] Apple verification failed:', err.message);
    return res.status(401).json({ error: 'Apple token verification failed' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Email / Phone OTP
//
// NOTE: No email/SMS provider is currently configured. Codes are logged to the
// server console as a stopgap so this is testable end-to-end during
// development. Before shipping, wire a real provider:
//   - Email: Resend, Postmark, or SendGrid
//   - SMS:   Twilio
// and replace the `console.log(...)` lines below with the actual send calls.
// ─────────────────────────────────────────────────────────────────────────────

const otpCodes = new Map(); // key: normalized email/phone -> { code, expiresAt }

function normalizeContact(value) {
  return value.trim().toLowerCase();
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ─────────────────────────────────────────────────────────────────────────────
// Email via Resend. Sends for real when RESEND_API_KEY is set AND the sender
// domain (bonetideco.com) is verified in the Resend dashboard. If the key is
// missing or a send fails, callers fall back to logging so nothing is ever
// silently lost (and OTP login still works during setup).
//   Required env vars on Railway:
//     RESEND_API_KEY   — from resend.com/api-keys
//     EMAIL_FROM       — e.g. "Bone Tide Co. <support@bonetideco.com>"
//                        (defaults below; domain must be verified in Resend)
//     SUPPORT_EMAIL    — where appeals/alerts go (defaults to support@…)
// ─────────────────────────────────────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM     = process.env.EMAIL_FROM    || 'Bone Tide Co. <support@bonetideco.com>';
const SUPPORT_EMAIL  = process.env.SUPPORT_EMAIL || 'support@bonetideco.com';

async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.log(`[email:dev] (no RESEND_API_KEY) to=${to} subject="${subject}"`);
    return { sent: false, dev: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: EMAIL_FROM, to, subject, html, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error('[email] Resend error:', data?.message ?? res.status);
      return { sent: false, error: data?.message ?? `HTTP ${res.status}` };
    }
    return { sent: true, id: data.id };
  } catch (err) {
    console.error('[email] send failed:', err.message);
    return { sent: false, error: err.message };
  }
}

app.post('/api/auth/otp/send', async (req, res) => {
  try {
    const { email, phone } = req.body ?? {};
    const contact = email ?? phone;
    if (!contact) return res.status(400).json({ error: 'email or phone required' });

    const key = normalizeContact(contact);
    const code = generateOtpCode();
    otpCodes.set(key, { code, expiresAt: Date.now() + 10 * 60 * 1000 });

    if (email) {
      const r = await sendEmail({
        to: email,
        subject: 'Your Bone Tide Co. sign-in code',
        text: `Your Bone Tide Co. sign-in code is ${code}. It expires in 10 minutes.`,
        html: `<p>Your Bone Tide Co. sign-in code is <strong style="font-size:22px;letter-spacing:2px">${code}</strong>.</p><p style="color:#666">It expires in 10 minutes.</p>`,
      });
      // If the provider isn't ready (no key / domain not verified yet), log the
      // code so login still works during setup.
      if (!r.sent) console.log(`[otp] Email not sent (${r.error ?? 'dev mode'}) — code for ${email}: ${code}`);
    } else {
      // TODO: send via Twilio
      console.log(`[otp] SMS code for ${phone}: ${code}`);
    }

    res.json({ sent: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/otp/verify', async (req, res) => {
  try {
    const { email, phone, code, deviceId } = req.body ?? {};
    const contact = email ?? phone;
    if (!contact || !code) return res.status(400).json({ error: 'email/phone and code required' });

    const key = normalizeContact(contact);
    const entry = otpCodes.get(key);
    if (!entry || entry.code !== code.trim()) {
      return res.status(401).json({ error: 'Invalid code' });
    }
    if (Date.now() > entry.expiresAt) {
      otpCodes.delete(key);
      return res.status(401).json({ error: 'Code expired, please request a new one' });
    }
    otpCodes.delete(key); // single-use

    // Look up existing user by auth_id (normalized email/phone)
    const { rows: existingRows } = await pool.query(
      'SELECT id, points_balance, name FROM users WHERE auth_id=$1', [key]
    );

    let userRow;
    if (existingRows.length) {
      userRow = existingRows[0];
    } else {
      const insertCols = email ? `auth_id, email` : `auth_id, phone`;
      const { rows: [created] } = await pool.query(
        `INSERT INTO users (${insertCols}, points_balance, created_at)
         VALUES ($1, $2, 0, NOW()) RETURNING id, points_balance, name`,
        [key, contact.trim()]
      );
      userRow = created;
    }

    const user = {
      id: key,
      email: email ?? null,
      name: userRow.name ?? '',
      avatar: null,
      provider: 'otp',
    };

    await mergeDeviceUser(deviceId, userRow, 'auth_id');

    return res.json({ token: issueJwt(user), user, needsName: !user.name });
  } catch (err) {
    console.error('[auth] OTP verify failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Returns the current user's profile (name, avatar, email) for the
// authenticated provider. Used by Settings to show current values.
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    let { rows } = await pool.query(
      `SELECT u.name, u.avatar, u.email, u.points_balance, u.birthday_month, u.birthday_boost_at, u.is_admin, u.is_club, u.club_badge, u.public_profile,
              COALESCE((
                SELECT SUM(pt.delta) FROM points_transactions pt
                WHERE pt.user_id = u.id AND pt.reason = 'catch'
                  AND u.birthday_boost_at IS NOT NULL
                  AND pt.created_at >= u.birthday_boost_at
                  AND pt.created_at < u.birthday_boost_at + INTERVAL '24 hours'
              ), 0) AS birthday_boost_earned
         FROM users u WHERE u.${column}=$1`, [req.user.id]
    );
    // Fall back to email match for merged/Apple accounts where provider column is null
    if (!rows.length && req.user.email) {
      ({ rows } = await pool.query(
        `SELECT u.name, u.avatar, u.email, u.points_balance, u.birthday_month, u.birthday_boost_at, u.is_admin, u.is_club, u.club_badge, u.public_profile,
                COALESCE((
                  SELECT SUM(pt.delta) FROM points_transactions pt
                  WHERE pt.user_id = u.id AND pt.reason = 'catch'
                    AND u.birthday_boost_at IS NOT NULL
                    AND pt.created_at >= u.birthday_boost_at
                    AND pt.created_at < u.birthday_boost_at + INTERVAL '24 hours'
                ), 0) AS birthday_boost_earned
           FROM users u WHERE u.email=$1`, [req.user.email]
      ));
    }
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set/update the member's Club badge (which rope shows around their avatar).
// Cosmetic only — it's gated on Club membership at render time, so requireAuth
// is sufficient. Keep CLUB_BADGE_IDS in sync with CLUB_BADGES in Avatar.js.
const CLUB_BADGE_IDS = ['anchor', 'crest', 'wheel', 'shark', 'compass', 'lighthouse'];
app.put('/api/auth/club-badge', requireAuth, async (req, res) => {
  try {
    const { badge } = req.body ?? {};
    if (!CLUB_BADGE_IDS.includes(badge)) {
      return res.status(400).json({ error: 'invalid badge' });
    }
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    let { rows } = await pool.query(
      `UPDATE users SET club_badge=$1 WHERE ${column}=$2 RETURNING club_badge`,
      [badge, req.user.id]
    );
    if (!rows.length && req.user.email) {
      ({ rows } = await pool.query(
        `UPDATE users SET club_badge=$1 WHERE email=$2 RETURNING club_badge`,
        [badge, req.user.email]
      ));
    }
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ clubBadge: rows[0].club_badge });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Opt in/out of a public angler profile (default OFF). When false, GET
// /api/anglers/:id returns 404 for this user. Distinct from share_with_community
// (feed attribution) — a browsable profile is a separate, explicit consent.
app.put('/api/auth/public-profile', requireAuth, async (req, res) => {
  try {
    const enabled = !!(req.body?.enabled);
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    let { rows } = await pool.query(
      `UPDATE users SET public_profile=$1 WHERE ${column}=$2 RETURNING public_profile`,
      [enabled, req.user.id]
    );
    if (!rows.length && req.user.email) {
      ({ rows } = await pool.query(
        `UPDATE users SET public_profile=$1 WHERE email=$2 RETURNING public_profile`,
        [enabled, req.user.email]
      ));
    }
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ publicProfile: rows[0].public_profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set/update the user's birthday month (1-12, or null to clear). Month-only —
// no day/year collected — used solely to award a birthday-month points bonus.
//
// Requires DB migration:
//   ALTER TABLE users ADD COLUMN birthday_month smallint;
//   ALTER TABLE users ADD COLUMN birthday_bonus_year smallint;
app.put('/api/auth/birthday-month', requireAuth, async (req, res) => {
  try {
    const { birthdayMonth } = req.body ?? {};
    const month = birthdayMonth === null ? null : parseInt(birthdayMonth);
    if (month !== null && (isNaN(month) || month < 1 || month > 12)) {
      return res.status(400).json({ error: 'birthdayMonth must be 1-12 or null' });
    }
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows } = await pool.query(
      `UPDATE users SET birthday_month=$1 WHERE ${column}=$2 RETURNING birthday_month`,
      [month, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ birthdayMonth: rows[0].birthday_month });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Birthday "Double Points" day — the user activates a single 24-hour boost
// window during their birthday month. For 24h from the tap, catches pay 2× and
// the daily cap is lifted to BOOST_DAILY_CAP. One activation per birthday year.
//
// Requires DB migration:
//   ALTER TABLE users ADD COLUMN birthday_boost_at timestamptz;
app.post('/api/auth/birthday-boost/activate', requireAuth, async (req, res) => {
  try {
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows } = await pool.query(
      `SELECT birthday_month,
              EXTRACT(MONTH FROM CURRENT_DATE)::int AS cur_month,
              (birthday_boost_at IS NOT NULL
                AND birthday_boost_at > NOW() - INTERVAL '300 days') AS used_recently,
              birthday_boost_at
         FROM users WHERE ${column}=$1`, [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];

    if (!u.birthday_month) {
      return res.status(400).json({ code: 'NO_BIRTHDAY', error: 'Set your birthday month first.' });
    }
    if (u.birthday_month !== u.cur_month) {
      return res.status(400).json({ code: 'NOT_BIRTHDAY_MONTH', error: 'Double Points day can only be used during your birthday month.' });
    }
    if (u.used_recently) {
      return res.status(409).json({ code: 'ALREADY_USED', error: 'You’ve already used your Double Points day — it unlocks again about a year after your last one.', activatedAt: u.birthday_boost_at });
    }

    const { rows: [updated] } = await pool.query(
      `UPDATE users SET birthday_boost_at = NOW() WHERE ${column}=$1 RETURNING birthday_boost_at`,
      [req.user.id]
    );
    res.json({ activated: true, activatedAt: updated.birthday_boost_at, dailyCap: BOOST_DAILY_CAP });
  } catch (err) {
    console.error('Birthday boost activate error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Retired flat birthday bonus — kept as a harmless no-op so older clients that
// still POST here don't error. (Replaced by the activatable Double Points day.)
app.post('/api/auth/birthday-bonus/claim', requireAuth, async (req, res) => {
  res.json({ awarded: false });
});

// Set/update the user's display name. Used by the universal "What should we
// call you?" prompt shown after first login regardless of auth provider.
app.put('/api/auth/name', requireAuth, async (req, res) => {
  try {
    const { name } = req.body ?? {};
    if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows } = await pool.query(
      `UPDATE users SET name=$1 WHERE ${column}=$2 RETURNING id, name`,
      [name.trim().slice(0, 40), req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ name: rows[0].name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile avatar
//
// NOTE: this assumes a Cloudinary (or similar) image-upload helper already
// exists in this file for catch photos (`/api/upload-image`). If so, replace
// `uploadAvatarToCloudinary` below with that shared helper so both endpoints
// use the same Cloudinary config/credentials — this is a thin standalone
// implementation in case that helper isn't visible in this version of the file.
// ─────────────────────────────────────────────────────────────────────────────

async function uploadImageToCloudinary(base64, { folder, transformation }) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) throw new Error('Cloudinary not configured');

  // Signed upload: sign the param set (everything except file/api_key/signature
  // itself) with the API secret, per Cloudinary's signature algorithm —
  // alphabetically sorted "key=value" pairs joined with '&', SHA1 hashed with
  // the secret appended.
  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = { folder, timestamp };
  const signatureBase = Object.keys(paramsToSign)
    .sort()
    .map(k => `${k}=${paramsToSign[k]}`)
    .join('&');
  const signature = crypto.createHash('sha1').update(signatureBase + apiSecret).digest('hex');

  const form = new URLSearchParams();
  form.append('file', `data:image/jpeg;base64,${base64}`);
  form.append('api_key', apiKey);
  form.append('timestamp', String(timestamp));
  form.append('signature', signature);
  form.append('folder', folder);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await res.json();
  if (!data.secure_url) throw new Error(data.error?.message ?? 'Image upload failed');
  // When no transformation is requested, return the plain secure_url so callers
  // (e.g. the catch-photo flow) can apply their own delivery transform via a
  // single /upload/ replace without chaining onto a baked-in transform.
  return transformation
    ? data.secure_url.replace('/upload/', `/upload/${transformation}/`)
    : data.secure_url;
}

async function uploadAvatarToCloudinary(base64) {
  // Square crop centered on face, capped at 400px, webp output.
  return uploadImageToCloudinary(base64, {
    folder: 'avatars',
    transformation: 'c_fill,g_face,w_400,h_400,f_webp,q_auto:good',
  });
}

// Spot reference photos are landscape/water shots, not faces — wider aspect,
// no face-detection gravity, a bit more resolution since these are meant to
// be looked at as a real reference rather than a small avatar thumbnail.
async function uploadSpotPhotoToCloudinary(base64) {
  return uploadImageToCloudinary(base64, {
    folder: 'spots',
    transformation: 'c_limit,w_1200,f_webp,q_auto:good',
  });
}

// Catch photos: store the original (capped) without baking a transform into the
// URL, so the app's thumbUrl() can apply its own square crop via a single
// /upload/ replace. Returns a plain Cloudinary secure_url containing /upload/.
async function uploadCatchPhotoToCloudinary(base64) {
  return uploadImageToCloudinary(base64, { folder: 'catches', transformation: null });
}

// Upload/replace the user's profile picture. Works for any auth provider.
app.put('/api/auth/avatar', requireAuth, async (req, res) => {
  try {
    const { imageBase64 } = req.body ?? {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });

    const url = await uploadAvatarToCloudinary(imageBase64);

    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    // Try provider column first; fall back to matching by DB id via sub-select
    let rows;
    ({ rows } = await pool.query(
      `UPDATE users SET avatar=$1 WHERE ${column}=$2 RETURNING id, avatar`,
      [url, req.user.id]
    ));
    if (!rows.length) {
      // Provider column may be null (e.g. Apple user merged from device account)
      // Fall back to looking up by email or the numeric DB id stored in JWT sub
      ({ rows } = await pool.query(
        `UPDATE users SET avatar=$1 WHERE email=$2 RETURNING id, avatar`,
        [url, req.user.email]
      ));
    }
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ avatar: rows[0].avatar });
  } catch (err) {
    console.error('[avatar] Upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Remove the user's profile picture (revert to default placeholder)
app.delete('/api/auth/avatar', requireAuth, async (req, res) => {
  try {
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    await pool.query(`UPDATE users SET avatar=NULL WHERE ${column}=$1`, [req.user.id]);
    res.json({ avatar: null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const REGION_SPECIES = {
  southeast: [
    // Inshore staples
    'Redfish (Red Drum)', 'Speckled Trout (Spotted Seatrout)', 'Southern Flounder', 'Sheepshead',
    'Black Drum', 'Florida Pompano', 'Snook', 'Tarpon', 'Ladyfish', 'Jack Crevalle',
    'Tripletail', 'Whiting (Southern Kingfish)', 'Pigfish (Grunt)', 'Pinfish', 'Mullet',
    'Palometa', 'Lookdown', 'Needlefish', 'Bonnethead Shark', 'Atlantic Sharpnose Shark',
    'Atlantic Stingray', 'Cownose Ray', 'Hardhead Catfish', 'Gafftopsail Catfish',
    'Oyster Toadfish', 'Northern Puffer (Blowfish)',
    // Nearshore / reef
    'Cobia', 'Spanish Mackerel', 'King Mackerel', 'Greater Amberjack', 'Lesser Amberjack',
    'Almaco Jack', 'Horse-Eye Jack', 'Banded Rudderfish', 'African Pompano',
    'Goliath Grouper', 'Gag Grouper', 'Black Grouper', 'Red Grouper', 'Scamp Grouper',
    'Warsaw Grouper', 'Snowy Grouper', 'Yellowfin Grouper',
    'Red Snapper', 'Vermilion Snapper', 'Mangrove Snapper (Gray Snapper)', 'Lane Snapper',
    'Mutton Snapper', 'Yellowtail Snapper', 'Cubera Snapper', 'Schoolmaster Snapper', 'Dog Snapper',
    'Hogfish', 'Gray Triggerfish', 'Atlantic Spadefish', 'White Grunt', 'Bluestriped Grunt',
    'Ballyhoo (Halfbeak)', 'Atlantic Bumper',
    // Sharks
    'Bull Shark', 'Blacktip Shark', 'Spinner Shark', 'Sandbar Shark', 'Nurse Shark',
    'Lemon Shark', 'Tiger Shark', 'Great Hammerhead', 'Bonnethead Shark',
    // Offshore pelagic
    'Mahi-Mahi (Dolphinfish)', 'Wahoo', 'Yellowfin Tuna', 'Blackfin Tuna', 'Little Tunny (False Albacore)',
    'Atlantic Bonito', 'Sailfish', 'Blue Marlin', 'White Marlin',
  ],
  gulf: [
    // Inshore
    'Redfish (Red Drum)', 'Speckled Trout (Spotted Seatrout)', 'Southern Flounder', 'Sheepshead',
    'Black Drum', 'Florida Pompano', 'Snook', 'Tarpon', 'Ladyfish', 'Jack Crevalle',
    'Tripletail', 'Whiting', 'Pigfish', 'Pinfish', 'Mullet', 'Hardhead Catfish', 'Gafftopsail Catfish',
    'Bonnethead Shark', 'Atlantic Stingray', 'Cownose Ray', 'Atlantic Sharpnose Shark', 'Northern Puffer',
    // Nearshore / reef
    'Cobia', 'Spanish Mackerel', 'King Mackerel', 'Greater Amberjack',
    'Goliath Grouper', 'Gag Grouper', 'Red Grouper', 'Black Grouper', 'Scamp Grouper',
    'Red Snapper', 'Vermilion Snapper', 'Mangrove Snapper', 'Lane Snapper',
    'Mutton Snapper', 'Yellowtail Snapper', 'Cubera Snapper',
    'Hogfish', 'Gray Triggerfish', 'Atlantic Spadefish', 'White Grunt',
    'African Pompano', 'Permit', 'Palometa',
    // Sharks
    'Bull Shark', 'Blacktip Shark', 'Tiger Shark', 'Nurse Shark', 'Lemon Shark',
    'Hammerhead Shark', 'Sandbar Shark',
    // Offshore
    'Mahi-Mahi', 'Wahoo', 'Yellowfin Tuna', 'Blackfin Tuna', 'Little Tunny',
    'Sailfish', 'Blue Marlin', 'Swordfish',
  ],
  midatlantic: [
    // Inshore
    'Striped Bass (Rockfish)', 'Summer Flounder (Fluke)', 'Weakfish (Gray Trout)',
    'Bluefish', 'Black Sea Bass', 'Tautog (Blackfish)', 'Scup (Porgy)',
    'Red Drum (Channel Bass)', 'Spotted Seatrout', 'Sheepshead',
    'Atlantic Croaker', 'Spot', 'White Perch', 'Porgy',
    'Atlantic Menhaden (Bunker)', 'Pigfish', 'Needlefish', 'Lookdown',
    'Atlantic Stingray', 'Cownose Ray', 'Sandbar Shark', 'Atlantic Sharpnose Shark',
    'Northern Puffer (Blowfish)',
    // Nearshore / reef
    'Cobia', 'Spanish Mackerel', 'King Mackerel', 'Greater Amberjack',
    'Black Sea Bass', 'Tautog', 'Cunner', 'Hogfish',
    'Spadefish', 'Gray Triggerfish', 'Sheepshead',
    // Sharks
    'Sandbar Shark', 'Bull Shark', 'Blacktip Shark', 'Spinner Shark',
    'Tiger Shark', 'Mako Shark', 'Thresher Shark', 'Blue Shark',
    // Pelagic
    'Bluefin Tuna', 'Yellowfin Tuna', 'Bigeye Tuna', 'Albacore Tuna',
    'False Albacore (Little Tunny)', 'Atlantic Bonito', 'Mahi-Mahi',
    'Wahoo', 'Sailfish', 'White Marlin', 'Blue Marlin', 'Swordfish', 'Skipjack Tuna',
  ],
  northeast: [
    // Inshore
    'Striped Bass', 'Summer Flounder (Fluke)', 'Winter Flounder', 'Weakfish',
    'Bluefish', 'Black Sea Bass', 'Tautog (Blackfish)', 'Scup (Porgy)',
    'Atlantic Cod', 'Haddock', 'Pollock', 'Cunner',
    'Atlantic Croaker', 'Spot', 'White Perch', 'Atlantic Menhaden (Bunker)',
    'Atlantic Halibut', 'Cusk', 'Atlantic Mackerel',
    // Sharks
    'Blue Shark', 'Mako Shark', 'Thresher Shark', 'Sandbar Shark', 'Spiny Dogfish',
    'Tiger Shark',
    // Pelagic
    'Bluefin Tuna', 'Yellowfin Tuna', 'Bigeye Tuna', 'Albacore Tuna',
    'False Albacore (Little Tunny)', 'Atlantic Bonito', 'Skipjack Tuna',
    'Mahi-Mahi', 'Wahoo', 'Swordfish', 'Blue Marlin', 'White Marlin',
  ],
  westcoast: [
    // Inshore / surf
    'Pacific Halibut', 'California Halibut', 'Lingcod', 'Cabezon',
    'White Seabass', 'Yellowtail (California)', 'Kelp Bass (Calico Bass)',
    'Chinook Salmon (King Salmon)', 'Coho Salmon (Silver Salmon)',
    'Pacific Bonito', 'White Croaker', 'Surfperch',
    'Sturgeon', 'Leopard Shark', 'Pacific Sierra (Sierra Mackerel)',
    // Rockfish (very common, many species)
    'Black Rockfish', 'Vermilion Rockfish', 'Canary Rockfish', 'Blue Rockfish',
    'Olive Rockfish', 'Copper Rockfish', 'Quillback Rockfish', 'China Rockfish',
    'Bocaccio Rockfish', 'Widow Rockfish', 'Yelloweye Rockfish',
    // Sharks
    'Leopard Shark', 'Blue Shark', 'Mako Shark', 'Thresher Shark', 'Soupfin Shark',
    // Offshore / pelagic
    'Albacore Tuna', 'Yellowfin Tuna', 'Bluefin Tuna', 'Skipjack Tuna', 'Bigeye Tuna',
    'Mahi-Mahi', 'Wahoo', 'Striped Marlin', 'Swordfish', 'Blue Marlin',
  ],
  hawaii: [
    'Giant Trevally (Ulua)', 'Bonefish (O\'io)', 'Mahi-Mahi (Dorado)',
    'Yellowfin Tuna (Ahi)', 'Bigeye Tuna (Ahi)', 'Skipjack Tuna (Aku)',
    'Wahoo (Ono)', 'Blue Marlin (A\'u)', 'Striped Marlin', 'Sailfish',
    'Opakapaka (Pink Snapper)', 'Onaga (Long-Tailed Red Snapper)', 'Uku (Green Jobfish)',
    'Hapu\'upu\'u (Hawaiian Grouper)', 'Papio (Young Trevally)', 'Barracuda (Kaku)',
    'Threadfin (Moi)', 'Mullet (Ama\'ama)',
    'Humuhumunukunukuapuaa (Reef Triggerfish)', 'Blacktip Reef Shark',
    'Whitetip Reef Shark', 'Galapagos Shark', 'Tiger Shark',
    'Hawaiian Amberjack (Kahala)',
  ],
};

app.post('/api/identify', async (req, res) => {
  const { deviceId, image, region = 'southeast' } = req.body;
  if (!image) return res.status(400).json({ error: 'image (base64) required' });
  const speciesList = REGION_SPECIES[region] ?? REGION_SPECIES.southeast;
  const prompt = `You are an expert marine biologist and fish identification specialist for Bone Tide Co., a saltwater fishing app serving ${region} anglers.

Identify the fish species in this photo. The angler is fishing in the ${region} region.

PRIMARY SPECIES TO LOOK FOR in this region:
${speciesList.join(', ')}

IDENTIFICATION GUIDANCE:
- Look carefully at body shape, coloration, fin placement, mouth shape, and any distinctive markings
- Goliath Grouper: massive size (can exceed 500 lbs), very broad flat head, small eyes set high, brown/yellowish-brown with dark irregular blotches and small black spots. Juveniles have mottled brown/yellow pattern. Do NOT confuse with other grouper species.
- Gag Grouper vs Black Grouper: Gag has worm-like markings and white margin on tail; Black Grouper has rectangular blotches with brass spots
- Redfish/Red Drum: bronze/copper color, one or more black tail spots, slightly underslung mouth
- Speckled Trout: elongated silver body with distinct black spots on back and dorsal fin, two large canine teeth visible
- Flounder/Fluke: flat body, both eyes on same side, mottled brown camouflage pattern
- Grouper (general): stocky body, large mouth, rounded tail, often with spots or blotches
- Snapper (general): pointed snout, forked tail, often red/pink/silver coloration, visible teeth
- Cobia: long dark brown torpedo shape, distinctive white stripe on sides, broad flat head, small first dorsal fin
- Tarpon: very large silver scales, upturned mouth, deeply forked tail, bony plate on chin
- Snook: distinctive black lateral line running full length of body, protruding lower jaw
- Sheepshead: black and white vertical stripes, human-like teeth visible even in photos
- Jack Crevalle/Trevally: deep-bodied silver fish, black spot on gill cover, yellow fins
- Pompano: small mouth, no visible teeth, deeply forked tail, golden/silver coloration
- Tripletail: distinctive three-lobed tail appearance from soft dorsal, anal, and caudal fins

SCREEN/PHOTO DETECTION: Also assess whether this is a PHOTO OF A SCREEN, PRINTED PHOTO, OR DIGITAL IMAGE rather than a real-life fish photo. Look for: screen glare/reflections, moiré patterns, monitor bezels, glass/print texture, pixel grid patterns, unnatural color banding, or a flat 2D appearance inconsistent with a hand-held catch photo.

Respond ONLY with a valid JSON object, no markdown, no explanation:
{"commonName":"string","latinName":"string","confidence":0.0,"inRegion":true,"habitat":"inshore","catchRelease":false,"notes":"string","isPhotoOfScreen":false,"screenCheckConfidence":0.0}

If you cannot identify the fish with reasonable confidence, return confidence below 0.5.
If multiple species are plausible, pick the most likely one for the region and note the alternatives in the notes field.`;
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

    // Issue a short-lived signed scan token tied to this identify result.
    // /api/catches must present this token to award points; it expires and
    // can only be used once, and encodes the screen-check outcome so the
    // points logic can't be bypassed by a client that omits the flag.
    const scanToken = jwt.sign(
      {
        purpose:           'scan',
        isPhotoOfScreen:   !!result.isPhotoOfScreen,
        commonName:        result.commonName ?? null,
        confidence:        result.confidence ?? 0,
      },
      JWT_SECRET,
      { expiresIn: '5m' }
    );
    result.scanToken = scanToken;

    res.json(result);
  } catch (err) {
    console.error('Identify error:', err);
    res.status(500).json({ error: 'Fish identification failed. Please try again.' });
  }
});

const DAILY_CAP = 1200, PTS_PER_CATCH = 10;
const BOOST_DAILY_CAP = 2000; // raised cap on the user's activated birthday boost day
const usedScanTokens = new Set(); // in-memory single-use tracking (resets on deploy/restart)

// ─────────────────────────────────────────────────────────────────────────────
// Catch photo upload — the app's uploadCatchPhoto() posts { imageBase64 } here
// and expects { url } back. Without this route the upload 404s, the app
// swallows the error, and every catch is saved with image_url=null (🐟 tiles).
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/upload-image', async (req, res) => {
  try {
    const { imageBase64 } = req.body ?? {};
    if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
    const url = await uploadCatchPhotoToCloudinary(imageBase64);
    res.json({ url });
  } catch (err) {
    console.error('[upload-image] failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/catches', async (req, res) => {
  const { species, lengthIn, released, bait, note, lat, lon, tideHeightFt, tideDirection, windKts, windDirection, baroInHg, moonPct, goodBiteScore, sessionToken, imageUrl, isPublic } = req.body;
  if (!species) return res.status(400).json({ error: 'species required' });
  try {
    const user = await getUserFromRequest(req);
    const banChk = await pool.query(`SELECT is_banned FROM users WHERE id=$1`, [user.id]);
    if (banChk.rows[0]?.is_banned) return res.status(403).json({ error: 'Your account is suspended.' });
    const today = new Date().toISOString().slice(0, 10);
    const { rows: todayRows } = await pool.query(`SELECT COALESCE(SUM(pts_awarded), 0) AS total FROM catches WHERE user_id=$1 AND DATE(caught_at)=$2`, [user.id, today]);
    const todayPts = parseInt(todayRows[0].total);

    // Birthday Double Points day: if today is the user's activated boost day,
    // lift the daily cap and pay 2× per catch.
    const { rows: [boostRow] } = await pool.query(
      `SELECT (birthday_boost_at IS NOT NULL AND NOW() < birthday_boost_at + INTERVAL '24 hours') AS active FROM users WHERE id=$1`, [user.id]
    );
    const boostActive = !!boostRow?.active;
    const dailyCap = boostActive ? BOOST_DAILY_CAP : DAILY_CAP;
    const perCatch = boostActive ? PTS_PER_CATCH * 2 : PTS_PER_CATCH;
    const ptsLeft = Math.max(0, dailyCap - todayPts);

    // Verify the scan token issued by /api/identify. Points are only awarded
    // if the token is valid, unexpired, unused, the species matches what was
    // identified, and the screen-check did not flag this as a photo of a
    // photo/screen.
    let scanInfo = null;
    let scanRejectReason = null;
    if (sessionToken) {
      try {
        const decoded = jwt.verify(sessionToken, JWT_SECRET);
        if (decoded.purpose !== 'scan') {
          scanRejectReason = 'invalid token purpose';
        } else if (usedScanTokens.has(sessionToken)) {
          scanRejectReason = 'token already used';
        } else if (decoded.isPhotoOfScreen) {
          scanRejectReason = 'photo of screen/photo detected';
        } else if (decoded.commonName && species && decoded.commonName.toLowerCase() !== species.toLowerCase()) {
          scanRejectReason = 'species mismatch';
        } else {
          scanInfo = decoded;
          usedScanTokens.add(sessionToken);
        }
      } catch {
        scanRejectReason = 'invalid or expired token';
      }
    } else {
      scanRejectReason = 'no scan token provided';
    }

    if (scanRejectReason) console.log(`Catch logged without points (user ${user.id}): ${scanRejectReason}`);

    const ptsAwarded = scanInfo && ptsLeft > 0 ? Math.min(perCatch, ptsLeft) : 0;
    const { rows: [newCatch] } = await pool.query(
      `INSERT INTO catches (user_id,species,length_in,released,bait,note,lat,lon,tide_height_ft,tide_direction,wind_kts,wind_direction,baro_in_hg,moon_pct,good_bite_score,pts_awarded,image_url,is_public,caught_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW()) RETURNING *`,
      [user.id,species,lengthIn,released??true,bait,note,lat,lon,tideHeightFt,tideDirection,windKts,windDirection,baroInHg,moonPct,goodBiteScore,ptsAwarded,imageUrl??null,isPublic??false]
    );
    if (ptsAwarded > 0) {
      await pool.query(`UPDATE users SET points_balance=points_balance+$1 WHERE id=$2`, [ptsAwarded, user.id]);
      await pool.query(`INSERT INTO points_transactions(user_id,delta,reason,reference_id,created_at) VALUES($1,$2,'catch',$3,NOW())`, [user.id, ptsAwarded, newCatch.id.toString()]);
    }
    res.json({ catch: formatCatch(newCatch), ptsAwarded, dailyTotal: todayPts+ptsAwarded, dailyCap, boostActive, pointsRejectReason: scanRejectReason });
  } catch (err) {
    console.error('Log catch error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/catches', async (req, res) => {
  const { page=1, limit=20, community } = req.query;
  try {
    const offset = (parseInt(page)-1)*parseInt(limit);

    if (community === 'true') {
      // Community feed: catches from users who opted in to share_with_community.
      // Exact lat/lon is jittered (~0.3-0.8 mile randomized offset, deterministic
      // per-catch so it doesn't jump around on refresh) so exact spots aren't
      // exposed. Angler name is included only if that user has NOT enabled
      // anonymize_shared.
      const { rows } = await pool.query(
        `SELECT c.*, u.name AS user_name, u.anonymize_shared
         FROM catches c
         JOIN users u ON u.id = c.user_id
         WHERE u.share_with_community = true AND c.is_public = true
         ORDER BY c.caught_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const catches = rows.map(row => {
        const formatted = formatCatch(row);
        if (formatted.lat != null && formatted.lon != null) {
          const jittered = jitterCoords(formatted.lat, formatted.lon, row.id);
          formatted.lat = jittered.lat;
          formatted.lon = jittered.lon;
        }
        formatted.anglerName = row.anonymize_shared ? null : (row.user_name ?? null);
        return formatted;
      });
      return res.json({ catches, page: parseInt(page) });
    }

    // Default: the requesting user's own catches (exact coords, no jitter)
    const user = await getUserFromRequest(req);
    const { rows } = await pool.query(`SELECT * FROM catches WHERE user_id=$1 ORDER BY caught_at DESC LIMIT $2 OFFSET $3`, [user.id, limit, offset]);
    res.json({ catches: rows.map(formatCatch), page: parseInt(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete one of the requesting user's own catches. Ownership is enforced by the
// user_id match, so a user can only ever delete their own. Likes/comments left
// on the catch in the community feed are cleaned up best-effort.
app.delete('/api/catches/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { rows } = await pool.query(
      `DELETE FROM catches WHERE id=$1 AND user_id=$2 RETURNING id`,
      [req.params.id, user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catch not found' });
    pool.query(`DELETE FROM likes    WHERE target_type='catch' AND target_id=$1`, [req.params.id]).catch(() => {});
    pool.query(`DELETE FROM comments WHERE target_type='catch' AND target_id=$1`, [req.params.id]).catch(() => {});
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Toggle a catch's community visibility. Setting is_public=false quietly drops
// it from the community feed (which filters on is_public=true) — no error, the
// post simply stops appearing. Re-enabling re-shares it.
app.patch('/api/catches/:id/privacy', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const isPublic = req.body?.isPublic === true;
    const { rows } = await pool.query(
      `UPDATE catches SET is_public=$1 WHERE id=$2 AND user_id=$3 RETURNING id, is_public`,
      [isPublic, req.params.id, user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catch not found' });
    res.json({ id: rows[0].id, isPublic: rows[0].is_public });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Points appeals — angler disputes a 0-point catch. Saved to the appeals queue
// for admin review, and (best-effort) emails support so it's not missed.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/appeals', async (req, res) => {
  const { catchId, reason, message } = req.body ?? {};
  try {
    const user = await getUserFromRequest(req);
    const { rows: [appeal] } = await pool.query(
      `INSERT INTO appeals (user_id, catch_id, reason, message)
       VALUES ($1,$2,$3,$4) RETURNING id, status, created_at`,
      [user.id, catchId ?? null, reason ?? null, (message ?? '').slice(0, 1000)]
    );
    // Best-effort notify — won't block the response or fail the appeal.
    sendEmail({
      to: SUPPORT_EMAIL,
      subject: `New points appeal · user ${user.id}`,
      text: `User ${user.id} is appealing a declined catch.\n`
          + `Catch ID: ${catchId ?? 'n/a'}\nDecline reason: ${reason ?? 'n/a'}\n`
          + `Their message: ${message || '(none)'}\n\nReview it in the admin panel.`,
    }).catch(() => {});
    res.json({ appeal });
  } catch (err) {
    console.error('Appeal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Deterministic small jitter based on catch id so a given catch's pin doesn't
// move between refreshes, but exact coordinates are never exposed publicly.
function jitterCoords(lat, lon, seed) {
  const hash = crypto.createHash('md5').update(String(seed)).digest();
  // Two pseudo-random values in [-1, 1] from the hash bytes
  const r1 = (hash[0] / 255) * 2 - 1;
  const r2 = (hash[1] / 255) * 2 - 1;
  // ~0.3-0.8 miles ≈ 0.0044-0.0116 degrees latitude
  const offsetLat = r1 * 0.011;
  const offsetLon = r2 * 0.011;
  return {
    lat: Math.round((lat + offsetLat) * 1e6) / 1e6,
    lon: Math.round((lon + offsetLon) * 1e6) / 1e6,
  };
}

function formatCatch(row) {
  return { id: row.id, species: row.species, lengthIn: row.length_in, released: row.released, bait: row.bait, note: row.note, lat: row.lat, lon: row.lon, tideHeightFt: row.tide_height_ft, tideDirection: row.tide_direction, windKts: row.wind_kts, windDirection: row.wind_direction, baroInHg: row.baro_in_hg, moonPct: row.moon_pct, goodBiteScore: row.good_bite_score, ptsAwarded: row.pts_awarded, imageUrl: row.image_url ?? null, isPublic: row.is_public ?? false, caughtAt: row.caught_at };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public angler profile — opt-in only (public_profile=true). Guest-readable like
// the other community reads. Returns identity + shared catches with exact coords
// omitted (so activity patterns can't be mined). 404 when not opted in.
app.get('/api/anglers/:id', async (req, res) => {
  try {
    const { rows: [u] } = await pool.query(
      `SELECT id, name, avatar, is_club, club_badge, public_profile FROM users WHERE id=$1`,
      [req.params.id]
    );
    if (!u || !u.public_profile) return res.status(404).json({ error: 'Profile not available' });

    const { rows: catchRows } = await pool.query(
      `SELECT * FROM catches WHERE user_id=$1 AND is_public=true ORDER BY caught_at DESC LIMIT 60`,
      [u.id]
    );
    const catches = catchRows.map(r => {
      const f = formatCatch(r);
      f.lat = null; f.lon = null; // never expose location on a profile
      return f;
    });
    const { rows: [agg] } = await pool.query(
      `SELECT COUNT(*)::int AS count, MIN(caught_at) AS since
       FROM catches WHERE user_id=$1 AND is_public=true`,
      [u.id]
    );

    res.json({
      angler: {
        id: u.id,
        name: u.name ?? null,
        avatar: u.avatar ?? null,
        isClub: !!u.is_club,
        clubBadge: u.club_badge ?? null,
        publicCatchCount: agg?.count ?? 0,
        since: agg?.since ?? null,
      },
      catches,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Report a user or a piece of content. Writes to moderation_log for admin review.
app.post('/api/report', requireAuth, async (req, res) => {
  try {
    const { targetType, targetId, reason } = req.body ?? {};
    if (!targetType || targetId == null) {
      return res.status(400).json({ error: 'targetType and targetId are required' });
    }
    await pool.query(
      `INSERT INTO moderation_log (user_id, surface, category, content)
       VALUES ($1, $2, $3, $4)`,
      [req.user.id, `report:${targetType}`, 'user_report',
       JSON.stringify({ targetType, targetId, reason: reason ?? null, reporterId: req.user.id })]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Spots — personal + community fishing spots
//
// Requires DB migration:
//   CREATE TABLE IF NOT EXISTS spots (
//     id          SERIAL PRIMARY KEY,
//     user_id     INTEGER NOT NULL REFERENCES users(id),
//     name        TEXT NOT NULL,
//     type        TEXT,
//     note        TEXT,
//     lat         DOUBLE PRECISION NOT NULL,
//     lon         DOUBLE PRECISION NOT NULL,
//     photo_url   TEXT,
//     is_private  BOOLEAN DEFAULT true,
//     created_at  TIMESTAMPTZ DEFAULT NOW()
//   );
//
// Design notes (flagging these since they're judgment calls, not given):
//   - Privacy is set per-spot at creation (matching the client's existing
//     toggle), not a user-level setting the way share_with_community works
//     for catches. Private spots never reach this table or this endpoint at
//     all — they stay device-local, exactly as they do today.
//   - Spot coordinates are NOT jittered, unlike community catches. Fuzzing
//     the location would defeat the point of sharing a fishing spot — if
//     that's wrong, jitterCoords() above is right there to reuse.
//   - Like catches, creation accepts a deviceId fallback so guests can
//     create spots, and the community read requires no auth so guests can
//     browse it too.
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/spots', async (req, res) => {
  const { name, type, note, lat, lon, isPrivate, photoBase64 } = req.body;
  if (!name || lat == null || lon == null) return res.status(400).json({ error: 'name, lat, lon required' });

  // Content filter on shareable text (spot name + note) before writing.
  const spotBlocked = blockedCategory(name) || blockedCategory(note ?? '');
  if (spotBlocked) {
    logModeration(req, 'spot', spotBlocked, `${name} ${note ?? ''}`);
    return res.status(422).json({
      error: "That spot's name or note contains language that isn't allowed on Bone Tide Co. Please keep it respectful.",
      blocked: true,
      category: spotBlocked,
    });
  }
  try {
    const user = await getUserFromRequest(req);
    const banChk = await pool.query(`SELECT is_banned FROM users WHERE id=$1`, [user.id]);
    if (banChk.rows[0]?.is_banned) return res.status(403).json({ error: 'Your account is suspended.' });
    let photoUrl = null;
    if (photoBase64) {
      try { photoUrl = await uploadSpotPhotoToCloudinary(photoBase64); }
      catch (err) { console.error('[spots] Photo upload failed:', err.message); }
    }
    const { rows: [newSpot] } = await pool.query(
      `INSERT INTO spots (user_id,name,type,note,lat,lon,photo_url,is_private,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW()) RETURNING *`,
      [user.id, name, type ?? null, note ?? null, lat, lon, photoUrl, isPrivate ?? true]
    );
    res.json({ spot: formatSpot(newSpot) });
  } catch (err) {
    console.error('Create spot error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/spots', async (req, res) => {
  const { page = 1, limit = 50, community } = req.query;
  try {
    const offset = (parseInt(page) - 1) * parseInt(limit);

    if (community === 'true') {
      // Community feed: only spots explicitly marked shared. No auth
      // required, matching the community catches feed, so guests can
      // browse it too.
      const { rows } = await pool.query(
        `SELECT s.*, u.name AS user_name, u.anonymize_shared
         FROM spots s
         JOIN users u ON u.id = s.user_id
         WHERE s.is_private = false
         ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const spots = rows.map(row => {
        const formatted = formatSpot(row);
        formatted.anglerName = row.anonymize_shared ? null : (row.user_name ?? null);
        return formatted;
      });
      return res.json({ spots, page: parseInt(page) });
    }

    // Default: the requesting user's own shared spots. Private spots never
    // reach this table, so this only ever returns what that user chose to
    // share — useful for managing/deleting shared spots across devices.
    const user = await getUserFromRequest(req);
    const { rows } = await pool.query(`SELECT * FROM spots WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`, [user.id, limit, offset]);
    res.json({ spots: rows.map(formatSpot), page: parseInt(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single spot by ID (used for deep-link from photo library)
app.get('/api/spots/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, type, note, lat, lon, photo_url AS "photoUri", is_private, created_at
       FROM spots WHERE id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Spot not found' });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/spots/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { rows } = await pool.query(`DELETE FROM spots WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Spot not found' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Spot Photos — community photo gallery per spot
//
// Requires DB migration:
//   CREATE TABLE IF NOT EXISTS spot_photos (
//     id         SERIAL PRIMARY KEY,
//     spot_id    INTEGER NOT NULL REFERENCES spots(id) ON DELETE CASCADE,
//     user_id    INTEGER NOT NULL REFERENCES users(id),
//     photo_url  TEXT NOT NULL,
//     created_at TIMESTAMPTZ DEFAULT NOW()
//   );
//   CREATE INDEX IF NOT EXISTS idx_spot_photos_spot ON spot_photos(spot_id);
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/spots/:id/photos', async (req, res) => {
  try {
    const spotId = parseInt(req.params.id);
    // Get photos with like counts per photo
    const { rows } = await pool.query(
      `SELECT sp.id, sp.photo_url, sp.created_at, sp.user_id,
              u.name AS user_name, u.avatar AS user_avatar, u.anonymize_shared,
              u.is_club AS author_is_club, u.club_badge AS author_badge,
              u.public_profile AS author_public_profile,
              COUNT(l.id)::int AS like_count
       FROM spot_photos sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN likes l ON l.target_type='spot_photo' AND l.target_id=sp.id
       WHERE sp.spot_id = $1
       GROUP BY sp.id, u.name, u.avatar, u.anonymize_shared, u.is_club, u.club_badge, u.public_profile
       ORDER BY sp.created_at DESC`,
      [spotId]
    );
    // Check if requesting user has liked each photo
    const viewer = await getUserFromRequest(req).catch(() => null);
    let likedSet = new Set();
    if (viewer && rows.length) {
      const photoIds = rows.map(r => r.id);
      const { rows: liked } = await pool.query(
        `SELECT target_id FROM likes WHERE user_id=$1 AND target_type='spot_photo' AND target_id=ANY($2)`,
        [viewer.id, photoIds]
      );
      likedSet = new Set(liked.map(r => r.target_id));
    }
    res.json({
      photos: rows.map(r => ({
        id: r.id,
        photoUrl: r.photo_url,
        authorName: r.user_name ?? null,
        authorAvatar: r.user_avatar ?? null,
        authorIsClub: !!r.author_is_club,
        authorBadge: r.author_badge ?? null,
        authorPublicProfile: !!r.author_public_profile,
        authorId: r.user_id,
        createdAt: r.created_at,
        likeCount: r.like_count ?? 0,
        likedByMe: likedSet.has(r.id),
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/spots/:id/photos', requireAuth, async (req, res) => {
  const { imageBase64 } = req.body ?? {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  try {
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: userRows } = await pool.query(
      `SELECT id, name FROM users WHERE ${column}=$1`, [req.user.id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    const me = userRows[0];

    // Photos are always attributed — a display name is required so the upload
    // shows who caught it. (There is no anonymous option for photos.)
    if (!me.name || !me.name.trim()) {
      return res.status(403).json({ code: 'NAME_REQUIRED', error: 'Add a display name before sharing photos.' });
    }
    const userId = me.id;

    const photoUrl = await uploadSpotPhotoToCloudinary(imageBase64);
    const { rows: [photo] } = await pool.query(
      `INSERT INTO spot_photos (spot_id, user_id, photo_url, created_at)
       VALUES ($1, $2, $3, NOW()) RETURNING id, photo_url, created_at`,
      [req.params.id, userId, photoUrl]
    );
    res.json({ photo: { id: photo.id, photoUrl: photo.photo_url, createdAt: photo.created_at } });
  } catch (err) {
    console.error('[spot photos] Upload failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});




// ── Spot polls ───────────────────────────────────────────────────────────────

// Submit a poll response for a spot (one per user per spot)
app.post('/api/spots/:id/poll', async (req, res) => {
  const { ratingOverall, ratingFish, ratingCrowd, ratingClean, ratingAccess, hasCost } = req.body ?? {};
  const spotId = parseInt(req.params.id);
  if (!spotId) return res.status(400).json({ error: 'invalid spot id' });
  try {
    const user = await getUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'auth required' });
    await pool.query(
      `INSERT INTO spot_polls
         (spot_id, user_id, rating_overall, rating_fish, rating_crowd, rating_clean, rating_access, has_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (spot_id, user_id) DO UPDATE SET
         rating_overall=$3, rating_fish=$4, rating_crowd=$5,
         rating_clean=$6, rating_access=$7, has_cost=$8, created_at=NOW()`,
      [spotId, user.id, ratingOverall??null, ratingFish??null, ratingCrowd??null,
       ratingClean??null, ratingAccess??null, hasCost??null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[poll] submit error:', err.message);
    res.status(500).json({ error: 'Failed to save poll' });
  }
});

// Get aggregated poll results for a spot
app.get('/api/spots/:id/poll', async (req, res) => {
  const spotId = parseInt(req.params.id);
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)::int                             AS total,
         ROUND(AVG(rating_overall)::numeric, 1)   AS overall,
         ROUND(AVG(rating_fish)::numeric, 1)       AS fish,
         ROUND(AVG(rating_crowd)::numeric, 1)      AS crowd,
         ROUND(AVG(rating_clean)::numeric, 1)      AS clean,
         ROUND(AVG(rating_access)::numeric, 1)     AS access,
         COUNT(*) FILTER (WHERE has_cost='yes')::int      AS cost_yes,
         COUNT(*) FILTER (WHERE has_cost='no')::int       AS cost_no,
         COUNT(*) FILTER (WHERE has_cost='sometimes')::int AS cost_sometimes
       FROM spot_polls WHERE spot_id=$1`,
      [spotId]
    );
    res.json({ poll: rows[0] ?? null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch poll' });
  }
});

// photoUri (not photo_url) on purpose — matches the field name the client
// already uses for locally-stored spot photos, so SpotDetailSheet renders
// a community spot's photo with zero extra mapping logic.
function formatSpot(row) {
  return { id: row.id, name: row.name, type: row.type, note: row.note, lat: row.lat, lon: row.lon, photoUri: row.photo_url, isPrivate: row.is_private, createdAt: row.created_at };
}

// ─────────────────────────────────────────────────────────────────────────────
// Likes + Comments — community spots & catches
//
// Requires DB migration:
//   CREATE TABLE IF NOT EXISTS likes (
//     id          SERIAL PRIMARY KEY,
//     user_id     INTEGER NOT NULL REFERENCES users(id),
//     target_type TEXT NOT NULL,              -- 'spot' | 'catch'
//     target_id   INTEGER NOT NULL,
//     created_at  TIMESTAMPTZ DEFAULT NOW(),
//     UNIQUE(user_id, target_type, target_id)
//   );
//   CREATE INDEX IF NOT EXISTS idx_likes_target ON likes(target_type, target_id);
//
//   CREATE TABLE IF NOT EXISTS comments (
//     id                SERIAL PRIMARY KEY,
//     user_id           INTEGER NOT NULL REFERENCES users(id),
//     target_type       TEXT NOT NULL,         -- 'spot' | 'catch'
//     target_id         INTEGER NOT NULL,
//     parent_comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
//     body              TEXT NOT NULL,
//     created_at        TIMESTAMPTZ DEFAULT NOW()
//   );
//   CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(target_type, target_id);
//
// Design notes:
//   - target_type/target_id is a simple polymorphic pair rather than two
//     separate tables (likes_spots/likes_catches) — keeps the route surface
//     small (one set of endpoints for both spots and catches) at the cost of
//     no DB-level foreign key into spots/catches directly. Acceptable here
//     since both tables use plain SERIAL ids with no overlap risk in
//     practice, and the route validates target_type against an allowlist.
//   - Guests (deviceId only, no JWT) CAN like/comment, same as they can
//     create spots and share catches — consistent with the rest of the API.
//   - Commenter display name respects THAT commenter's own anonymize_shared
//     flag (same mechanism already used for spot/catch authorship), not the
//     flag of whoever owns the spot/catch being commented on.
//   - Comments use parent_comment_id for one level of threading (replies to
//     a top-level comment). Replies-to-replies are allowed at the DB level
//     but the client only needs to render one level deep for now.
//   - Deleting a comment deletes its replies too (ON DELETE CASCADE) rather
//     than leaving orphaned replies under a "[deleted]" placeholder.
// ─────────────────────────────────────────────────────────────────────────────

const LIKEABLE_TARGET_TYPES = new Set(['spot', 'catch', 'spot_photo', 'comment']);

function assertValidTarget(targetType, targetId) {
  if (!LIKEABLE_TARGET_TYPES.has(targetType)) throw new Error('targetType must be "spot" or "catch"');
  if (targetId == null || isNaN(parseInt(targetId))) throw new Error('targetId required');
}

// Toggle like — liking again un-likes. Returns the new state + total count.
app.post('/api/likes', async (req, res) => {
  const { targetType, targetId } = req.body ?? {};
  try {
    assertValidTarget(targetType, targetId);
    const user = await getUserFromRequest(req);
    const tId = parseInt(targetId);

    const { rows: existing } = await pool.query(
      `SELECT id FROM likes WHERE user_id=$1 AND target_type=$2 AND target_id=$3`,
      [user.id, targetType, tId]
    );

    let likedByMe;
    if (existing.length) {
      await pool.query(`DELETE FROM likes WHERE id=$1`, [existing[0].id]);
      likedByMe = false;
    } else {
      await pool.query(
        `INSERT INTO likes (user_id,target_type,target_id,created_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (user_id,target_type,target_id) DO NOTHING`,
        [user.id, targetType, tId]
      );
      likedByMe = true;
    }

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM likes WHERE target_type=$1 AND target_id=$2`,
      [targetType, tId]
    );
    res.json({ likedByMe, count: countRows[0].count });
  } catch (err) {
    res.status(err.message.includes('required') || err.message.includes('must be') ? 400 : 500).json({ error: err.message });
  }
});

// Like state for a single target — count + whether the requesting
// user/device has liked it. No auth required to read the count; likedByMe
// is only meaningful if a deviceId/JWT is provided.
app.get('/api/likes/:targetType/:targetId', async (req, res) => {
  const { targetType, targetId } = req.params;
  try {
    assertValidTarget(targetType, targetId);
    const tId = parseInt(targetId);
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM likes WHERE target_type=$1 AND target_id=$2`,
      [targetType, tId]
    );
    let likedByMe = false;
    try {
      const user = await getUserFromRequest(req);
      const { rows } = await pool.query(
        `SELECT id FROM likes WHERE user_id=$1 AND target_type=$2 AND target_id=$3`,
        [user.id, targetType, tId]
      );
      likedByMe = rows.length > 0;
    } catch {
      // No deviceId/JWT provided — fine, just can't know likedByMe.
    }
    res.json({ count: countRows[0].count, likedByMe });
  } catch (err) {
    res.status(err.message.includes('must be') ? 400 : 500).json({ error: err.message });
  }
});

// Batch like-state lookup — avoids N requests when rendering a list of
// markers/cards. Body: { items: [{targetType,targetId}, ...] }
app.post('/api/likes/batch', async (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || !items.length) return res.json({ results: [] });
  try {
    let myUserId = null;
    try { myUserId = (await getUserFromRequest(req)).id; } catch {}

    const results = await Promise.all(items.map(async ({ targetType, targetId }) => {
      try {
        assertValidTarget(targetType, targetId);
        const tId = parseInt(targetId);
        const { rows: countRows } = await pool.query(
          `SELECT COUNT(*)::int AS count FROM likes WHERE target_type=$1 AND target_id=$2`,
          [targetType, tId]
        );
        let likedByMe = false;
        if (myUserId != null) {
          const { rows } = await pool.query(
            `SELECT id FROM likes WHERE user_id=$1 AND target_type=$2 AND target_id=$3`,
            [myUserId, targetType, tId]
          );
          likedByMe = rows.length > 0;
        }
        return { targetType, targetId: tId, count: countRows[0].count, likedByMe };
      } catch {
        return { targetType, targetId, count: 0, likedByMe: false };
      }
    }));
    res.json({ results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Content filter — blocks slurs, hate speech, and explicit content from
// comments. No human moderator required — server-side word list check before
// the row is ever written to the DB.
// ─────────────────────────────────────────────────────────────────────────────
const HATE_TERMS = [
  // Racial / ethnic slurs — matched aggressively (de-obfuscated, substring),
  // since these effectively never appear inside legitimate words.
  'nigger','nigga','chink','spic','wetback','kike','gook','raghead','towelhead',
  'beaner','jigaboo','porchmonkey','junglebunny','zipperhead',
  // Homophobic / transphobic slurs
  'faggot','dyke','tranny','shemale',
];

const PROFANITY_TERMS = [
  // Strong profanity — matched on WORD BOUNDARIES so normal words are safe
  // (e.g. "cock" won't flag woodcock/peacock/cockpit; "dick" won't flag
  // Dickson; "crack" stays fine). Light leet-normalization still catches
  // sh1t / a$$hole / b!tch.
  'fuck','motherfucker','shit','bitch','asshole','cunt','pussy','cock',
  'dick','whore','slut','fag',
];

const THREAT_TERMS = [
  'kill yourself','kys','go die','i will kill','i will hurt','i will find you',
];

// Strip to letters only + fold common leetspeak — used for the aggressive
// hate-term pass so spacing/punctuation/number swaps can't sneak a slur through.
function deobfuscate(text) {
  return text.toLowerCase()
    .replace(/[@4]/g, 'a').replace(/0/g, 'o').replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e').replace(/[$5]/g, 's').replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
}

// Lighter normalization that keeps word boundaries intact, for the
// word-boundary profanity pass.
function lightNormalize(text) {
  return text.toLowerCase()
    .replace(/[@4]/g, 'a').replace(/0/g, 'o').replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e').replace(/[$5]/g, 's').replace(/7/g, 't');
}

// Returns the category that tripped ('hate' | 'profanity' | 'threat') or null.
function blockedCategory(text) {
  if (!text) return null;
  const lower  = text.toLowerCase();
  const deob   = deobfuscate(text);
  const light  = lightNormalize(text);

  if (HATE_TERMS.some(t => deob.includes(t.replace(/[^a-z]/g, '')))) return 'hate';
  if (THREAT_TERMS.some(t => lower.includes(t))) return 'threat';
  if (PROFANITY_TERMS.some(t => new RegExp(`\\b${t}\\b`).test(light))) return 'profanity';
  return null;
}

function containsBlockedContent(text) {
  return blockedCategory(text) !== null;
}

// Add photo_url to comments if not already present (idempotent)
// ── Auto-create core tables if they don't exist (idempotent) ─────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS spot_photos (
    id         SERIAL PRIMARY KEY,
    spot_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    photo_url  TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[init] spot_photos:', e.message));

// Points-decline appeals queue. Anglers appeal a 0-point catch; admins review
// in the moderation panel. Email notification is best-effort (see sendEmail).
pool.query(`
  CREATE TABLE IF NOT EXISTS appeals (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    catch_id    INTEGER,
    reason      TEXT,
    message     TEXT,
    status      TEXT NOT NULL DEFAULT 'open',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  )
`).catch(e => console.error('[init] appeals:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS likes (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    target_type TEXT NOT NULL,
    target_id   INTEGER NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, target_type, target_id)
  )
`).catch(e => console.error('[init] likes:', e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS comments (
    id                SERIAL PRIMARY KEY,
    user_id           INTEGER NOT NULL,
    target_type       TEXT NOT NULL,
    target_id         INTEGER NOT NULL,
    parent_comment_id INTEGER REFERENCES comments(id) ON DELETE CASCADE,
    body              TEXT NOT NULL,
    photo_url         TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[init] comments:', e.message));

pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS photo_url TEXT`).catch(() => {});
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birthday_boost_at TIMESTAMPTZ`).catch(() => {});

// ── Spot polls table ──────────────────────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS spot_polls (
    id              SERIAL PRIMARY KEY,
    spot_id         INTEGER NOT NULL,
    user_id         INTEGER NOT NULL,
    device_id       TEXT,
    rating_overall  INTEGER CHECK (rating_overall BETWEEN 1 AND 5),
    rating_fish     INTEGER CHECK (rating_fish BETWEEN 1 AND 5),
    rating_crowd    INTEGER CHECK (rating_crowd BETWEEN 1 AND 5),
    rating_clean    INTEGER CHECK (rating_clean BETWEEN 1 AND 5),
    rating_access   INTEGER CHECK (rating_access BETWEEN 1 AND 5),
    has_cost        TEXT CHECK (has_cost IN ('yes','no','sometimes')),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(spot_id, user_id)
  )
`).catch(() => {});

app.post('/api/comments', async (req, res) => {
  const { targetType, targetId, body, parentCommentId, photoUrl } = req.body ?? {};
  if (!body || !body.trim()) return res.status(400).json({ error: 'body required' });

  // Content filter — reject before writing to DB
  const commentBlocked = blockedCategory(body);
  if (commentBlocked) {
    logModeration(req, 'comment', commentBlocked, body);
    return res.status(422).json({
      error: 'Your comment contains language that isn\'t allowed on Bone Tide Co. Please keep it respectful.',
      blocked: true,
      category: commentBlocked,
    });
  }

  try {
    assertValidTarget(targetType, targetId);
    const user = await getUserFromRequest(req);
    const banChk = await pool.query(`SELECT is_banned FROM users WHERE id=$1`, [user.id]);
    if (banChk.rows[0]?.is_banned) return res.status(403).json({ error: 'Your account is suspended.' });
    const tId = parseInt(targetId);
    const { rows: [newComment] } = await pool.query(
      `INSERT INTO comments (user_id,target_type,target_id,parent_comment_id,body,photo_url,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *`,
      [user.id, targetType, tId, parentCommentId ?? null, body.trim().slice(0, 1000), photoUrl ?? null]
    );
    const { rows: [userRow] } = await pool.query(
      `SELECT name, avatar, anonymize_shared, is_club, club_badge FROM users WHERE id=$1`, [user.id]
    );
    res.json({ comment: {
      ...formatComment(newComment, userRow),
      authorAvatar: userRow?.anonymize_shared ? null : (userRow?.avatar ?? null),
    } });
  } catch (err) {
    console.error('Create comment error:', err);
    res.status(err.message.includes('required') || err.message.includes('must be') ? 400 : 500).json({ error: err.message });
  }
});

// Returns comments for a target as a flat list with parentCommentId set —
// the client groups top-level vs. replies for threaded display.
// ── Comment photo upload ─────────────────────────────────────────────────────
function uploadCommentPhotoToCloudinary(base64) {
  return uploadImageToCloudinary(base64, {
    folder: 'comments',
    transformation: 'c_limit,w_1000,f_webp,q_auto:good',
  });
}

app.post('/api/comments/:id/photo', requireAuth, async (req, res) => {
  const { imageBase64 } = req.body ?? {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  try {
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: userRows } = await pool.query(
      `SELECT id FROM users WHERE ${column}=$1`, [req.user.id]
    );
    if (!userRows.length) return res.status(404).json({ error: 'User not found' });
    const userId = userRows[0].id;

    // Verify this comment belongs to this user
    const { rows: commentRows } = await pool.query(
      `SELECT id FROM comments WHERE id=$1 AND user_id=$2`, [req.params.id, userId]
    );
    if (!commentRows.length) return res.status(403).json({ error: 'Not your comment' });

    const photoUrl = await uploadCommentPhotoToCloudinary(imageBase64);
    await pool.query(`UPDATE comments SET photo_url=$1 WHERE id=$2`, [photoUrl, req.params.id]);
    res.json({ photoUrl });
  } catch (err) {
    console.error('Comment photo upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.get('/api/comments/:targetType/:targetId', async (req, res) => {
  const { targetType, targetId } = req.params;
  try {
    assertValidTarget(targetType, targetId);
    const tId = parseInt(targetId);
    const viewer = await getUserFromRequest(req).catch(() => null);
    const { rows } = await pool.query(
      `SELECT c.*, u.name AS user_name, u.avatar AS user_avatar, u.anonymize_shared,
              u.is_club, u.club_badge,
              COUNT(l.id)::int AS like_count
       FROM comments c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN likes l ON l.target_type='comment' AND l.target_id=c.id
       WHERE c.target_type=$1 AND c.target_id=$2
       GROUP BY c.id, u.name, u.avatar, u.anonymize_shared, u.is_club, u.club_badge
       ORDER BY c.created_at ASC`,
      [targetType, tId]
    );
    let likedSet = new Set();
    if (viewer && rows.length) {
      const cids = rows.map(r => r.id);
      const { rows: liked } = await pool.query(
        `SELECT target_id FROM likes WHERE user_id=$1 AND target_type='comment' AND target_id=ANY($2)`,
        [viewer.id, cids]
      );
      likedSet = new Set(liked.map(r => r.target_id));
    }
    res.json({ comments: rows.map(row => ({
      ...formatComment(row, row),
      likeCount: row.like_count ?? 0,
      likedByMe: likedSet.has(row.id),
      authorAvatar: row.anonymize_shared ? null : (row.user_avatar ?? null),
    })) });
  } catch (err) {
    res.status(err.message.includes('must be') ? 400 : 500).json({ error: err.message });
  }
});

app.delete('/api/comments/:id', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { rows } = await pool.query(
      `DELETE FROM comments WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Comment not found' });
    res.json({ deleted: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// `userRow` just needs { name, anonymize_shared } — accepts either the fresh
// lookup after POST, or the joined row from the GET list query.
function formatComment(row, userRow) {
  return {
    id: row.id,
    targetType: row.target_type,
    targetId: row.target_id,
    parentCommentId: row.parent_comment_id,
    body: row.body,
    authorName: userRow?.anonymize_shared ? null : (userRow?.name ?? userRow?.user_name ?? null),
    authorIsClub: userRow?.anonymize_shared ? false : !!userRow?.is_club,
    authorBadge: userRow?.anonymize_shared ? null : (userRow?.club_badge ?? null),
    createdAt: row.created_at,
    photoUrl: row.photo_url ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Privacy preferences — community catch sharing + anonymization
//
// Requires DB migration:
//   ALTER TABLE users ADD COLUMN share_with_community boolean DEFAULT false;
//   ALTER TABLE users ADD COLUMN anonymize_shared      boolean DEFAULT true;
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/privacy-prefs', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    const { rows } = await pool.query(
      `SELECT share_with_community, anonymize_shared FROM users WHERE id=$1`, [user.id]
    );
    const row = rows[0] ?? {};
    res.json({
      shareWithCommunity: row.share_with_community ?? false,
      anonymizeShared:    row.anonymize_shared ?? true,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/privacy-prefs', async (req, res) => {
  const { shareWithCommunity, anonymizeShared } = req.body;
  try {
    const user = await getUserFromRequest(req);
    const { rows } = await pool.query(
      `UPDATE users SET
         share_with_community = COALESCE($1, share_with_community),
         anonymize_shared      = COALESCE($2, anonymize_shared)
       WHERE id=$3
       RETURNING share_with_community, anonymize_shared`,
      [shareWithCommunity ?? null, anonymizeShared ?? null, user.id]
    );
    const row = rows[0] ?? {};
    res.json({
      shareWithCommunity: row.share_with_community ?? false,
      anonymizeShared:    row.anonymize_shared ?? true,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const tidePredictionsCache = new Map();

app.get('/api/tides', async (req, res) => {
  const { station, days = 7 } = req.query;

  // No station provided yet (e.g. fresh install, user hasn't enabled GPS or
  // picked a location) — return a clean "no data" shape rather than
  // defaulting to a specific station. Defaulting silently to one station
  // (e.g. St. Simons Sound) would show misleading tide data to every user
  // who hasn't actually chosen a location.
  if (!station) {
    return res.json({ available: false, reason: 'no_station_selected', predictions: [] });
  }

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

      // Not all NOAA stations support every datum, and some stations are
      // "subordinate" stations that aren't supported by the live predictions
      // datagetter API at all, even though NOAA's website displays
      // predictions for them via a different computation path. Try datums
      // in order of preference; if none work, this station genuinely has no
      // live predictions available.
      const datums = ['MLLW', 'MSL', 'STND'];
      let noaaData = null;
      let lastErr = null;

      for (const datum of datums) {
        const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${fmt(today)}&end_date=${fmt(end)}&station=${station}&product=predictions&datum=${datum}&time_zone=lst_ldt&interval=h&units=english&application=bonetideco&format=json`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.predictions) { noaaData = data; break; }
        lastErr = data.error?.message ?? 'NOAA returned no predictions';
      }

      if (!noaaData) {
        // Station has no usable predictions under any datum. Return a clean
        // "unavailable" response (not a 500) so the app can prompt the user
        // to pick a different station instead of showing a hard error.
        console.warn(`Tides unavailable for station ${station}: ${lastErr}`);
        return res.json({ available: false, reason: 'station_unsupported', stationId: station, predictions: [] });
      }
      predictions = noaaData.predictions.map(p => ({ t: p.t, v: parseFloat(p.v) }));
      tidePredictionsCache.set(station, { predictions, fetchedAt: Date.now() });
    } catch (err) {
      console.error('Tides error:', err);
      // Network/unexpected error — still return a clean shape rather than a
      // hard 500, so the app can show a "try again" state instead of crashing.
      return res.json({ available: false, reason: 'fetch_error', error: err.message, predictions: [] });
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
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,surface_pressure,uv_index&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,precipitation_probability&daily=sunrise,sunset&wind_speed_unit=kn&temperature_unit=fahrenheit&timezone=auto`),
    ]);
    const marine = await marineRes.json();
    const forecast = await forecastRes.json();
    const cur = forecast.current, mari = marine.current;
    const windKts = cur?.wind_speed_10m ?? 0;
    const windDir = degreesToCardinal(cur?.wind_direction_10m ?? 0);
    const pressHpa = cur?.surface_pressure ?? 1013;

    // Hourly: 10 hours starting from "now" — Open-Meteo's hourly.time array
    // covers several days, so find the first entry at/after current.time
    // (both in the same timezone-adjusted reference, since both come from
    // the same request) rather than assuming index 0 is the current hour.
    const hourlyTimes = forecast.hourly?.time ?? [];
    const nowIdx = Math.max(0, hourlyTimes.findIndex(t => t >= cur?.time));
    const hourly = [];
    for (let i = nowIdx; i < Math.min(nowIdx + 10, hourlyTimes.length); i++) {
      hourly.push({
        time:         forecast.hourly.time[i],
        tempF:        Math.round(forecast.hourly.temperature_2m?.[i] ?? cur?.temperature_2m ?? 80),
        windKts:      Math.round(forecast.hourly.wind_speed_10m?.[i] ?? 0),
        windDirection: degreesToCardinal(forecast.hourly.wind_direction_10m?.[i] ?? 0),
        precipChance: forecast.hourly.precipitation_probability?.[i] ?? null,
      });
    }

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
      hourly,
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
// ── NDBC buoy fallback helpers ──────────────────────────────────────────────
// Open-Meteo marine model has no coverage for inshore/estuary coords.
// Fall back to the nearest NOAA NDBC buoy for wave height/period/direction.
// Curated list of NDBC buoy stations with known coordinates covering US
// coastlines — used first since it's instant and reliable. If none of the
// nearby curated buoys have data, fall back to the full station table.
const NDBC_BUOYS = [
  // Southeast / South Atlantic
  { id: '41008', lat: 31.40, lon: -80.87 },  // Grays Reef, GA
  { id: '41004', lat: 32.50, lon: -79.10 },  // Edisto, SC
  { id: '41013', lat: 33.44, lon: -77.74 },  // Frying Pan Shoals, NC
  { id: '41009', lat: 28.51, lon: -80.18 },  // Canaveral, FL
  { id: '41010', lat: 28.91, lon: -78.47 },  // Canaveral East, FL
  { id: '41002', lat: 32.31, lon: -75.36 },  // South Hatteras
  { id: '41001', lat: 34.70, lon: -72.30 },  // East Hatteras
  { id: '41112', lat: 30.71, lon: -81.29 },  // Fernandina Beach, FL
  { id: '41117', lat: 32.66, lon: -78.99 },  // Georgetown, SC
  { id: 'FPSN7',  lat: 33.49, lon: -78.02 }, // Frying Pan Shoals CMAN
  // Gulf of Mexico
  { id: '42036', lat: 28.50, lon: -84.52 },  // West Tampa
  { id: '42039', lat: 28.79, lon: -86.01 },  // Pensacola
  { id: '42040', lat: 29.21, lon: -88.21 },  // Mobile
  { id: '42020', lat: 26.97, lon: -96.69 },  // Corpus Christi
  // Mid-Atlantic / Northeast
  { id: '44009', lat: 38.46, lon: -74.70 },  // Delaware Bay
  { id: '44025', lat: 40.25, lon: -73.16 },  // Long Island
  { id: '44013', lat: 42.35, lon: -70.65 },  // Boston
  { id: '44027', lat: 44.28, lon: -67.31 },  // Mount Desert Rock, ME
  // West Coast
  { id: '46026', lat: 37.76, lon: -122.83 }, // San Francisco
  { id: '46025', lat: 33.75, lon: -119.05 }, // Santa Monica Basin
  { id: '46029', lat: 46.14, lon: -124.51 }, // Columbia River
  { id: '46050', lat: 44.66, lon: -124.53 }, // Newport, OR
];

let ndbcStationCache = { stations: null, fetchedAt: 0 };

async function getNdbcStations() {
  if (ndbcStationCache.stations && (Date.now() - ndbcStationCache.fetchedAt) < 24 * 3600 * 1000) {
    return ndbcStationCache.stations;
  }
  const res = await fetch('https://www.ndbc.noaa.gov/data/stations/station_table.txt', {
    signal: AbortSignal.timeout(8000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BoneTideCo/1.0)' },
  });
  const text = await res.text();
  const stations = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const cols = line.split('|');
    if (cols.length < 7) continue;
    const id = cols[0]?.trim();
    const loc = cols[6] ?? '';
    let m = loc.match(/(\d+\.\d+)\s*N\s+(\d+\.\d+)\s*W/);
    let lat, lon;
    if (m) { lat = parseFloat(m[1]); lon = -parseFloat(m[2]); }
    else {
      m = loc.match(/(\d+\.\d+)\s*S\s+(\d+\.\d+)\s*W/);
      if (m) { lat = -parseFloat(m[1]); lon = -parseFloat(m[2]); }
    }
    if (!id || lat == null) continue;
    stations.push({ id, lat, lon });
  }
  ndbcStationCache = { stations, fetchedAt: Date.now() };
  return stations;
}

async function fetchBuoyWaveData(buoyId) {
  const res = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${buoyId}.txt`, {
    signal: AbortSignal.timeout(5000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BoneTideCo/1.0)' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length < 3) return null;
  const headers = lines[0].replace('#', '').trim().split(/\s+/);
  const row = lines[2].trim().split(/\s+/);
  const get = (name) => {
    const idx = headers.indexOf(name);
    if (idx === -1) return null;
    const v = parseFloat(row[idx]);
    return isNaN(v) || v >= 99 ? null : v;
  };
  const wvhtM = get('WVHT');
  if (wvhtM == null) return null;
  return {
    waveHeightFt: Math.round(wvhtM * 3.28084 * 10) / 10,
    wavePeriodSec: get('DPD') ?? get('APD'),
    waveDirection: get('MWD'),
    waterTempC: get('WTMP'),
  };
}

function sortByDistance(stations, lat, lon) {
  const userLat = parseFloat(lat), userLon = parseFloat(lon);
  return stations.map(st => {
    const dLat = (st.lat - userLat) * Math.PI / 180;
    const dLon = (st.lon - userLon) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(userLat*Math.PI/180)*Math.cos(st.lat*Math.PI/180)*Math.sin(dLon/2)**2;
    return { ...st, distKm: 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)) };
  }).sort((a, b) => a.distKm - b.distKm);
}

async function fetchBuoysInParallel(candidates) {
  const results = await Promise.allSettled(
    candidates.map(async (buoy) => {
      const wave = await fetchBuoyWaveData(buoy.id);
      if (!wave) throw new Error('no data');
      return { ...wave, distMi: Math.round(buoy.distKm * 0.621), buoyId: buoy.id, distKm: buoy.distKm };
    })
  );
  const valid = results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .sort((a, b) => a.distKm - b.distKm);
  return valid[0] ?? null;
}

async function getNearestBuoyMarine(lat, lon) {
  // Try curated buoy list first — fetch in parallel, pick closest with data
  const curated = sortByDistance(NDBC_BUOYS, lat, lon).slice(0, 10);
  const fromCurated = await fetchBuoysInParallel(curated);
  if (fromCurated) return fromCurated;

  // Fall back to full NDBC station table for more candidates
  try {
    const stations = await getNdbcStations();
    if (stations.length) {
      const nearby = sortByDistance(stations, lat, lon).slice(0, 12);
      return await fetchBuoysInParallel(nearby);
    }
  } catch {}
  return null;
}
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Tide-derived current estimate fallback
//
// Open-Meteo's ocean_current_velocity/direction has no coverage for inshore
// estuary coordinates (returns null for most of the GA/SC/etc coast). NDBC
// buoys don't report currents either. As a practical fallback, derive a rough
// current speed + direction from the rate of change of the nearest NOAA tide
// station's predicted water level: faster height change ≈ stronger current,
// rising tide ≈ incoming/flood current, falling tide ≈ outgoing/ebb current.
//
// This is an approximation (real current strength varies by inlet geometry),
// but gives anglers a directionally-useful "Incoming/Outgoing, ~X kts" reading
// instead of a blank dash.
// ─────────────────────────────────────────────────────────────────────────────

let tideStationListCache = null;

async function getTideStationList() {
  if (tideStationListCache) return tideStationListCache;
  const res = await fetch(
    'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions&units=english',
    { signal: AbortSignal.timeout(5000) }
  );
  const data = await res.json();
  tideStationListCache = (data.stations ?? []).map(s => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lng }));
  return tideStationListCache;
}

async function getTideDerivedCurrent(lat, lon) {
  const stations = await getTideStationList();
  if (!stations.length) return null;
  const nearest = sortByDistance(stations, lat, lon)[0];
  if (!nearest) return null;

  const now = new Date();
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
  const end = new Date(now); end.setDate(end.getDate() + 1);
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${fmt(now)}&end_date=${fmt(end)}&station=${nearest.id}&product=predictions&datum=MLLW&time_zone=lst_ldt&interval=h&units=english&application=bonetideco&format=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  if (!data.predictions?.length) return null;

  const predictions = data.predictions.map(p => ({ t: p.t, v: parseFloat(p.v) }));
  const pad = n => String(n).padStart(2, '0');
  const nowStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;

  let beforePt = null, afterPt = null;
  for (let i = 0; i < predictions.length - 1; i++) {
    if (predictions[i].t <= nowStr && predictions[i+1].t > nowStr) { beforePt = predictions[i]; afterPt = predictions[i+1]; break; }
  }
  if (!beforePt || !afterPt) return null;

  // Rate of height change per hour at current time (hourly interval data)
  const rateFtPerHr = afterPt.v - beforePt.v;
  const rising = rateFtPerHr > 0;

  // Rough mapping: ~6ft swing over ~6hrs (max rate ~1 ft/hr) historically
  // corresponds to inshore currents up to roughly 2-3 kts near inlets.
  // Scale linearly and cap at a sane max.
  const speedKts = Math.min(2.5, Math.round(Math.abs(rateFtPerHr) * 2 * 10) / 10);

  return {
    currentSpeedKts: speedKts,
    currentDirection: rising ? 'Incoming' : 'Outgoing',
    stationId: nearest.id,
    stationName: nearest.name,
    distKm: nearest.distKm,
  };
}

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
    let currentSpeedKts = round1(mc.ocean_current_velocity ?? null);
    let currentDirDeg   = round0(mc.ocean_current_direction ?? null);
    let currentSource   = 'open-meteo-marine';
    let currentLabel    = null; // "Incoming"/"Outgoing" from tide-derived fallback

    // ── Tide-derived current fallback ─────────────────────────────────────────
    // Open-Meteo marine model has no ocean current data for inshore/estuary
    // coords. Estimate from the nearest NOAA tide station's rate of change.
    if (currentSpeedKts == null) {
      try {
        const tideCurrent = await getTideDerivedCurrent(lat, lon);
        if (tideCurrent) {
          currentSpeedKts = tideCurrent.currentSpeedKts;
          currentLabel    = tideCurrent.currentDirection;
          currentSource   = `tide-derived-${tideCurrent.stationId}`;
        }
      } catch (tideErr) {
        console.warn('Tide-derived current fallback failed:', tideErr.message);
      }
    }

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

    // ── NDBC buoy fallback for waves/swell when Open-Meteo has no coverage ──
    let buoyData = null;
    if (round1(mc.wave_height ?? null) == null) {
      try { buoyData = await getNearestBuoyMarine(lat, lon); }
      catch (buoyErr) { console.warn('NDBC buoy fallback failed:', buoyErr.message); }
    }

    const waveHeightFt  = round1(mc.wave_height ?? null)  ?? buoyData?.waveHeightFt  ?? null;
    const wavePeriodSec = round1(mc.wave_period ?? null)  ?? buoyData?.wavePeriodSec ?? null;
    const waveDirection = round0(mc.wave_direction ?? null) ?? buoyData?.waveDirection ?? null;

    // If swell data is unavailable from Open-Meteo, use the buoy's overall
    // wave reading as a proxy for swell (buoys report combined sea state)
    const swellHeightFt  = round1(mc.swell_wave_height ?? null) ?? (buoyData ? buoyData.waveHeightFt : null);
    const swellPeriodSec = round1(mc.swell_wave_period ?? null) ?? (buoyData ? buoyData.wavePeriodSec : null);
    const swellDirection = round0(mc.swell_wave_direction ?? null) ?? (buoyData ? buoyData.waveDirection : null);

    // Use buoy water temp as a further fallback if NOAA tide station also failed
    if (waterTempF == null && buoyData?.waterTempC != null) {
      waterTempF = round1(buoyData.waterTempC * 9/5 + 32);
    }

    const data = {
      // Currents
      currentSpeedKts,
      currentDirection:     currentDirDeg,
      currentDirectionCard: currentDirDeg != null ? degreesToCardinal(currentDirDeg) : null,
      // "Incoming"/"Outgoing" label, populated when using the tide-derived
      // fallback (no compass direction available, only flood/ebb direction)
      currentLabel,

      // Waves
      waveHeightFt,
      wavePeriodSec,
      waveDirection,
      waveDirCard: waveDirection != null ? degreesToCardinal(waveDirection) : null,

      // Swell
      swellHeightFt,
      swellPeriodSec,
      swellDirection,
      swellDirCard: swellDirection != null ? degreesToCardinal(swellDirection) : null,

      // Water
      waterTempF,

      // Visibility — not in Open-Meteo marine; comes from /api/conditions
      visibilityMi: null,

      // Wind — comes from /api/conditions (Open-Meteo atmosphere)
      windSpeedKts: null,
      windDirCard:  null,

      fetchedAt: new Date().toISOString(),
      source: buoyData ? `open-meteo-marine+ndbc-${buoyData.buoyId}+${currentSource}` : currentSource,
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
function computeMoonPhase(date) {
  // Known new moon reference: Jan 6, 2000 18:14 UTC
  const knownNewMoon = new Date('2000-01-06T18:14:00Z').getTime();
  const synodicMonth = 29.530588853; // days
  const daysSince = (date.getTime() - knownNewMoon) / 86400000;
  let age = daysSince % synodicMonth;
  if (age < 0) age += synodicMonth;
  const fraction = age / synodicMonth; // 0 = new, 0.5 = full, 1 = new again
  const illumPct = Math.round((1 - Math.cos(2 * Math.PI * fraction)) / 2 * 100);

  let phaseName, emoji;
  if      (fraction < 0.03 || fraction > 0.97) { phaseName = 'New Moon';        emoji = '🌑'; }
  else if (fraction < 0.22)                    { phaseName = 'Waxing Crescent'; emoji = '🌒'; }
  else if (fraction < 0.28)                    { phaseName = 'First Quarter';   emoji = '🌓'; }
  else if (fraction < 0.47)                    { phaseName = 'Waxing Gibbous';  emoji = '🌔'; }
  else if (fraction < 0.53)                    { phaseName = 'Full Moon';       emoji = '🌕'; }
  else if (fraction < 0.72)                    { phaseName = 'Waning Gibbous';  emoji = '🌖'; }
  else if (fraction < 0.78)                    { phaseName = 'Last Quarter';    emoji = '🌗'; }
  else                                          { phaseName = 'Waning Crescent'; emoji = '🌘'; }

  return { illumPct, phaseName, emoji, fraction };
}

function computeSolunar(lat, lon) {
  const now = new Date();
  const hourOfDay = now.getHours() + now.getMinutes() / 60;
  const moon = computeMoonPhase(now);
  const majorHours = [6.5, 18.5];
  const nearMajor = majorHours.some(h => Math.abs(hourOfDay - h) < 1.5);
  const atMajor   = majorHours.some(h => Math.abs(hourOfDay - h) < 0.5);
  return {
    window: atMajor ? 'major_peak' : nearMajor ? 'major_near' : 'between',
    moonPhase: moon.phaseName.toLowerCase().includes('full') ? 'full' : moon.phaseName.toLowerCase().includes('new') ? 'new' : 'other',
    moonPhaseName: moon.phaseName,
    moonPhaseEmoji: moon.emoji,
    moonPct: moon.illumPct,
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

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN / MODERATION (Chunk B)
// Make yourself admin once with:  UPDATE users SET is_admin = true WHERE id = <your_id>;
// ═════════════════════════════════════════════════════════════════════════════

// Idempotent migrations
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin  BOOLEAN DEFAULT false`).catch(e => console.error('[init] is_admin:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false`).catch(e => console.error('[init] is_banned:', e.message));

// Bone Tide Club (RevenueCat) columns. The extension added these via a one-off
// psql command; declaring them here too makes the schema reproducible and is a
// no-op if they already exist.
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rc_user_id      TEXT`).catch(e => console.error('[init] rc_user_id:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_club         BOOLEAN DEFAULT false`).catch(e => console.error('[init] is_club:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS club_expires_at TIMESTAMPTZ`).catch(e => console.error('[init] club_expires_at:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS club_badge      TEXT`).catch(e => console.error('[init] club_badge:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile  BOOLEAN DEFAULT false`).catch(e => console.error('[init] public_profile:', e.message));
pool.query(`
  CREATE TABLE IF NOT EXISTS moderation_log (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER,
    surface    TEXT,
    category   TEXT,
    content    TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[init] moderation_log:', e.message));

// Admin guard — verifies JWT AND that the user has is_admin=true in the DB.
async function requireAdmin(req, res, next) {
  const header = req.headers['authorization'] ?? '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const column = PROVIDER_COLUMN[decoded.provider] ?? 'google_id';
    const { rows } = await pool.query(`SELECT id, is_admin FROM users WHERE ${column}=$1 LIMIT 1`, [decoded.id]);
    if (!rows.length || !rows[0].is_admin) return res.status(403).json({ error: 'Admin only' });
    req.adminUser = rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Records a blocked post into the flagged-word log. Best-effort, never throws.
async function logModeration(req, surface, category, text) {
  let userId = null;
  try { const u = await getUserFromRequest(req); userId = u.id; } catch {}
  pool.query(
    `INSERT INTO moderation_log (user_id, surface, category, content) VALUES ($1,$2,$3,$4)`,
    [userId, surface, category, (text ?? '').slice(0, 500)]
  ).catch(e => console.error('[modlog]', e.message));
}

// ── List community content ───────────────────────────────────────────────────
app.get('/api/admin/catches', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? 50), 200);
    const { rows } = await pool.query(
      `SELECT c.id, c.species, c.length_in, c.image_url, c.note, c.is_public, c.caught_at,
              u.id AS user_id, u.name AS user_name
       FROM catches c JOIN users u ON u.id=c.user_id
       WHERE c.is_public = true
       ORDER BY c.caught_at DESC LIMIT $1`, [limit]
    );
    res.json({ catches: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/spots', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? 50), 200);
    const { rows } = await pool.query(
      `SELECT s.id, s.name, s.type, s.note, s.photo_url, s.created_at,
              u.id AS user_id, u.name AS user_name
       FROM spots s JOIN users u ON u.id=s.user_id
       WHERE s.is_private = false
       ORDER BY s.created_at DESC LIMIT $1`, [limit]
    );
    res.json({ spots: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/comments', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? 100), 300);
    const { rows } = await pool.query(
      `SELECT cm.id, cm.body, cm.target_type, cm.target_id, cm.created_at,
              u.id AS user_id, u.name AS user_name
       FROM comments cm JOIN users u ON u.id=cm.user_id
       ORDER BY cm.created_at DESC LIMIT $1`, [limit]
    );
    res.json({ comments: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/photos', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit ?? 60), 200);
    const { rows } = await pool.query(
      `SELECT p.id, p.spot_id, p.photo_url, p.created_at,
              u.id AS user_id, u.name AS user_name
       FROM spot_photos p JOIN users u ON u.id=p.user_id
       ORDER BY p.created_at DESC LIMIT $1`, [limit]
    );
    res.json({ photos: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delete any community content ─────────────────────────────────────────────
app.delete('/api/admin/catches/:id', requireAdmin, async (req, res) => {
  try { await pool.query(`DELETE FROM catches WHERE id=$1`, [req.params.id]); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/spots/:id', requireAdmin, async (req, res) => {
  try { await pool.query(`DELETE FROM spots WHERE id=$1`, [req.params.id]); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/comments/:id', requireAdmin, async (req, res) => {
  try { await pool.query(`DELETE FROM comments WHERE id=$1`, [req.params.id]); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/photos/:id', requireAdmin, async (req, res) => {
  try { await pool.query(`DELETE FROM spot_photos WHERE id=$1`, [req.params.id]); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Appeals queue ─────────────────────────────────────────────────────────────
app.get('/api/admin/appeals', requireAdmin, async (req, res) => {
  try {
    const status = req.query.status ?? 'open';
    const { rows } = await pool.query(
      `SELECT a.id, a.user_id, a.catch_id, a.reason, a.message, a.status, a.created_at, a.resolved_at,
              u.name AS user_name,
              c.species, c.length_in, c.image_url
       FROM appeals a
       JOIN users u ON u.id=a.user_id
       LEFT JOIN catches c ON c.id=a.catch_id
       WHERE ($1='all' OR a.status=$1)
       ORDER BY a.created_at DESC LIMIT 200`, [status]
    );
    res.json({ appeals: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/appeals/:id/resolve', requireAdmin, async (req, res) => {
  const { decision } = req.body ?? {};   // 'granted' | 'denied'
  if (!['granted', 'denied'].includes(decision)) return res.status(400).json({ error: 'decision must be granted or denied' });
  try {
    const { rows: [appeal] } = await pool.query(
      `UPDATE appeals SET status=$1, resolved_at=NOW() WHERE id=$2 RETURNING *`, [decision, req.params.id]
    );
    if (!appeal) return res.status(404).json({ error: 'Appeal not found' });

    // Granting an appeal awards the standard per-catch points to the angler.
    let awarded = 0;
    if (decision === 'granted') {
      awarded = PTS_PER_CATCH;
      await pool.query(`UPDATE users SET points_balance=points_balance+$1 WHERE id=$2`, [awarded, appeal.user_id]);
      await pool.query(
        `INSERT INTO points_transactions(user_id,delta,reason,reference_id,created_at) VALUES($1,$2,'appeal',$3,NOW())`,
        [appeal.user_id, awarded, String(appeal.catch_id ?? appeal.id)]
      );
      if (appeal.catch_id) await pool.query(`UPDATE catches SET pts_awarded=$1 WHERE id=$2`, [awarded, appeal.catch_id]);
    }
    res.json({ resolved: true, decision, awarded });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Flagged-word log ──────────────────────────────────────────────────────────
app.get('/api/admin/flagged', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT m.id, m.surface, m.category, m.content, m.created_at,
              u.name AS user_name, u.id AS user_id
       FROM moderation_log m LEFT JOIN users u ON u.id=m.user_id
       ORDER BY m.created_at DESC LIMIT 200`
    );
    res.json({ flagged: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Ban / unban ───────────────────────────────────────────────────────────────
app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const banned = req.body?.banned !== false;  // default true; pass { banned: false } to unban
  try {
    const { rows } = await pool.query(
      `UPDATE users SET is_banned=$1 WHERE id=$2 RETURNING id, is_banned`, [banned, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, () => console.log(`Bone Tide Co. API running on port ${PORT}`));
// ── User Media Library ────────────────────────────────────────────────────────

// GET /api/me/photos/spots — all spot photos uploaded by this user
app.get('/api/me/photos/spots', requireAuth, async (req, res) => {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE ${col}=$1`, [req.user.id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const { rows } = await pool.query(`
      SELECT sp.id, sp.photo_url, sp.created_at, sp.spot_id,
             s.name AS spot_name,
             COUNT(l.id)::int AS likes
      FROM spot_photos sp
      JOIN spots s ON s.id = sp.spot_id
      LEFT JOIN likes l ON l.target_type = 'spot' AND l.target_id = sp.spot_id
      WHERE sp.user_id = $1
      GROUP BY sp.id, s.name
      ORDER BY sp.created_at DESC`, [u.id]);
    res.json({ photos: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/me/photos/spots/:id — delete a spot photo
app.delete('/api/me/photos/spots/:id', requireAuth, async (req, res) => {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE ${col}=$1`, [req.user.id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const { rows } = await pool.query(
      `DELETE FROM spot_photos WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, u.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Photo not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/me/photos/catches — all catch photos uploaded by this user
app.get('/api/me/photos/catches', requireAuth, async (req, res) => {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE ${col}=$1`, [req.user.id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const { rows } = await pool.query(`
      SELECT id, image_url AS photo_url, species, created_at AS caught_at, length_in
      FROM catches
      WHERE user_id=$1 AND image_url IS NOT NULL AND image_url != ''
      ORDER BY caught_at DESC`, [u.id]);
    res.json({ photos: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/me/photos/catches/:id — remove photo from a catch (not delete the catch)
app.delete('/api/me/photos/catches/:id', requireAuth, async (req, res) => {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE ${col}=$1`, [req.user.id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const { rows } = await pool.query(
      `UPDATE catches SET image_url=NULL WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, u.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Catch not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/me/photos/comments — all comment photos uploaded by this user
app.get('/api/me/photos/comments', requireAuth, async (req, res) => {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE ${col}=$1`, [req.user.id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const { rows } = await pool.query(`
      SELECT c.id, c.photo_url, c.body, c.created_at, c.target_type, c.target_id,
             CASE WHEN c.target_type='spot' THEN s.name ELSE NULL END AS spot_name
      FROM comments c
      LEFT JOIN spots s ON s.id = c.target_id AND c.target_type = 'spot'
      WHERE c.user_id=$1 AND c.photo_url IS NOT NULL AND c.photo_url != ''
      ORDER BY c.created_at DESC`, [u.id]);
    res.json({ photos: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/me/photos/comments/:id — remove photo from a comment
app.delete('/api/me/photos/comments/:id', requireAuth, async (req, res) => {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: [u] } = await pool.query(`SELECT id FROM users WHERE ${col}=$1`, [req.user.id]);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const { rows } = await pool.query(
      `UPDATE comments SET photo_url=NULL WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, u.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Comment not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ═════════════════════════════════════════════════════════════════════════════
// BONE TIDE CLUB — RevenueCat subscription webhook + status + gating
// ═════════════════════════════════════════════════════════════════════════════
//
// IDENTITY MATCHING (the important part):
// The app calls Purchases.logIn(appUserId) where appUserId is the user's
// provider id — google_id / apple_id / auth_id — which is exactly what's stored
// on the users row. So the webhook matches incoming app_user_id against those
// columns (and rc_user_id, which we back-fill on first match). No reliance on
// device_id, which is a different value and would never match.
//
// ACCESS = club_expires_at in the future. Modeling it on the expiry timestamp
// (rather than flipping a boolean on every event) makes cancellations correct:
// a user who cancels keeps Club until their paid period ends; EXPIRATION is what
// actually ends access. Billing grace periods are handled the same way.
//
// AUTH: RevenueCat sends the Authorization header you set in the dashboard
// (Project → Integrations → Webhooks). Set it to exactly RC_WEBHOOK_SECRET.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/revenuecat/webhook', async (req, res) => {
  const secret = process.env.RC_WEBHOOK_SECRET ?? '';
  let authHeader = req.headers['authorization'] ?? '';
  if (authHeader.startsWith('Bearer ')) authHeader = authHeader.slice(7);
  if (!secret || authHeader !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event       = req.body?.event ?? {};
  const type        = event.type ?? '';
  const appUserId   = event.app_user_id ?? event.original_app_user_id ?? null;
  const expiresAtMs = event.expiration_at_ms ?? null;

  if (!appUserId) return res.status(200).json({ received: true, skipped: 'no app_user_id' });

  const GRANT  = new Set(['INITIAL_PURCHASE','RENEWAL','UNCANCELLATION','PRODUCT_CHANGE','TRANSFER','NON_SUBSCRIPTION_PURCHASE']);
  const REVOKE = new Set(['EXPIRATION']);

  // Prefer the expiry timestamp as the source of truth; fall back to event type
  // when no expiry is present in the payload.
  let isClub;
  if (expiresAtMs != null) {
    isClub = Number(expiresAtMs) > Date.now();
  } else if (GRANT.has(type)) {
    isClub = true;
  } else if (REVOKE.has(type)) {
    isClub = false;
  } else {
    // CANCELLATION / BILLING_ISSUE with no expiry — leave state untouched;
    // the member keeps access until EXPIRATION fires.
    return res.status(200).json({ received: true, skipped: type });
  }

  const expiresAtIso = expiresAtMs != null ? new Date(Number(expiresAtMs)).toISOString() : null;

  try {
    const { rowCount } = await pool.query(
      `UPDATE users
          SET is_club = $1,
              club_expires_at = $2,
              rc_user_id = $3
        WHERE rc_user_id = $3
           OR google_id  = $3
           OR apple_id   = $3
           OR auth_id    = $3
           OR (email IS NOT NULL AND email = $3)`,
      [isClub, expiresAtIso, appUserId]
    );
    if (rowCount) {
      console.log(`[revenuecat] ${type}: set is_club=${isClub} for app_user_id=${appUserId}`);
    } else {
      console.warn(`[revenuecat] no user matched app_user_id=${appUserId} (type=${type})`);
    }
  } catch (err) {
    console.error('[revenuecat] webhook DB error:', err.message);
    // Still 200 so RevenueCat doesn't retry forever; the error is logged.
  }
  res.status(200).json({ received: true });
});

// Client check of their own Club status (the app mostly reads this from the
// RevenueCat SDK directly, but this is handy as a server-of-record fallback).
app.get('/api/me/club-status', requireAuth, async (req, res) => {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    let { rows } = await pool.query(
      `SELECT is_club, club_expires_at FROM users WHERE ${col}=$1 LIMIT 1`, [req.user.id]
    );
    if (!rows.length && req.user.email) {
      ({ rows } = await pool.query(
        `SELECT is_club, club_expires_at FROM users WHERE email=$1 LIMIT 1`, [req.user.email]
      ));
    }
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    const active = !!u.is_club && (!u.club_expires_at || new Date(u.club_expires_at) > new Date());
    res.json({ isClub: active, clubExpiresAt: u.club_expires_at ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authoritatively map this account to the RevenueCat app_user_id the client
// logged in with. Optional belt-and-suspenders: the webhook already matches on
// the provider-id columns, but calling this right after Purchases.logIn()
// guarantees rc_user_id is set even before the first purchase.
app.post('/api/me/link-revenuecat', requireAuth, async (req, res) => {
  const { rcUserId } = req.body ?? {};
  if (!rcUserId) return res.status(400).json({ error: 'rcUserId required' });
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rowCount } = await pool.query(
      `UPDATE users SET rc_user_id=$1 WHERE ${col}=$2`, [String(rcUserId), req.user.id]
    );
    if (!rowCount && req.user.email) {
      await pool.query(`UPDATE users SET rc_user_id=$1 WHERE email=$2`, [String(rcUserId), req.user.email]);
    }
    res.json({ linked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gate any route behind active Club membership. Chain AFTER requireAuth.
async function requireClub(req, res, next) {
  try {
    const col = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows: [u] } = await pool.query(
      `SELECT is_club, club_expires_at FROM users WHERE ${col}=$1 LIMIT 1`, [req.user.id]
    );
    const active = u?.is_club && (!u.club_expires_at || new Date(u.club_expires_at) > new Date());
    if (!active) return res.status(403).json({ error: 'Club membership required' });
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
