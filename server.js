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

// Attach the account's DB flags (admin / club / etc.) onto the client `user`
// object so the app is correct the INSTANT you log in — previously these were
// missing from the login response, so the Admin tab (and Club perks) only
// appeared after the next cold-start profile refresh.
async function attachAccountFlags(user, dbUserId) {
  try {
    const { rows } = await pool.query(
      `SELECT is_admin, is_club, club_badge, public_profile FROM users WHERE id=$1`, [dbUserId]
    );
    const f = rows[0] || {};
    user.isAdmin = !!f.is_admin;
    user.isClub = !!f.is_club;
    user.clubBadge = f.club_badge ?? null;
    user.publicProfile = !!f.public_profile;
  } catch { /* non-fatal — client will still refresh on next cold start */ }
  return user;
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
  // Only merge a TRUE guest — an account with NO login of any kind. An account
  // already authenticated with a DIFFERENT provider must never be treated as a
  // mergeable guest, or signing in with a second method would cannibalize a real
  // account (that's how the admin account got lost).
  const { rows: deviceUsers } = await pool.query(
    `SELECT id, points_balance FROM users
      WHERE device_id=$1 AND google_id IS NULL AND apple_id IS NULL AND auth_id IS NULL`,
    [deviceId]
  );
  if (!deviceUsers.length) return;
  const deviceUser = deviceUsers[0];
  if (deviceUser.id === targetUser.id) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE catches SET user_id=$1 WHERE user_id=$2', [targetUser.id, deviceUser.id]);
    await client.query('UPDATE points_transactions SET user_id=$1 WHERE user_id=$2', [targetUser.id, deviceUser.id]);
    await client.query('UPDATE spots SET user_id=$1 WHERE user_id=$2', [targetUser.id, deviceUser.id]);
    await client.query('UPDATE comments SET user_id=$1 WHERE user_id=$2', [targetUser.id, deviceUser.id]);
    await client.query('DELETE FROM likes WHERE user_id=$1', [deviceUser.id]); // guest likes dropped (avoid unique clash)
    await client.query('UPDATE users SET points_balance=points_balance+$1 WHERE id=$2', [deviceUser.points_balance, targetUser.id]);
    // Delete the guest row FIRST so its device_id is released, THEN move the
    // device onto the target. Doing it the other way makes two rows briefly hold
    // the same device_id and UNIQUE(device_id) throws (the dup-account crash).
    await client.query('DELETE FROM users WHERE id=$1', [deviceUser.id]);
    await client.query('UPDATE users SET device_id=NULL WHERE device_id=$1 AND id<>$2', [deviceId, targetUser.id]);
    await client.query('UPDATE users SET device_id=$1 WHERE id=$2', [deviceId, targetUser.id]);
    await client.query('COMMIT');
    console.log(`[auth] Merged guest ${deviceUser.id} into user ${targetUser.id}`);
  } catch (mergeErr) {
    await client.query('ROLLBACK');
    console.error('[auth] Merge failed (non-fatal):', mergeErr.message);
  } finally {
    client.release();
  }
}

// Resolve the canonical user for a login, LINKING by verified email so the same
// person is one account no matter which method they use (Google / Apple / email
// OTP). Order of resolution:
//   1. Already linked via this provider  → use it (refresh email/avatar).
//   2. An account exists with this verified email → link this provider onto it
//      (collapses what would otherwise be a duplicate account).
//   3. Nobody matches → create a fresh account.
// Only ever called with verified emails (Google/Apple verify; OTP proves the
// code). Never link on an unverified email — that would allow account takeover.
async function resolveVerifiedUser({ email, providerColumn, providerId, avatar = null, phone = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Already linked via this provider?
    let { rows } = await client.query(
      `SELECT id, points_balance, name, email FROM users WHERE ${providerColumn}=$1 LIMIT 1`,
      [providerId]
    );
    if (rows.length) {
      await client.query(
        `UPDATE users SET email=COALESCE($2, email), avatar=COALESCE($3, avatar) WHERE id=$1`,
        [rows[0].id, email, avatar]
      );
      await client.query('COMMIT');
      return rows[0];
    }

    // 2. Existing account with the same verified email → link this provider on.
    if (email) {
      ({ rows } = await client.query(
        `SELECT id, points_balance, name, email FROM users WHERE LOWER(email)=LOWER($1) ORDER BY id ASC LIMIT 1`,
        [email]
      ));
      if (rows.length) {
        await client.query(
          `UPDATE users SET ${providerColumn}=$2, avatar=COALESCE($3, avatar) WHERE id=$1`,
          [rows[0].id, providerId, avatar]
        );
        await client.query('COMMIT');
        console.log(`[auth] Linked ${providerColumn} onto existing account ${rows[0].id} via email`);
        return rows[0];
      }
    }

    // 3. Brand-new account.
    const { rows: created } = await client.query(
      `INSERT INTO users (${providerColumn}, email, phone, avatar, points_balance, created_at)
       VALUES ($1, $2, $3, $4, 0, NOW()) RETURNING id, points_balance, name, email`,
      [providerId, email ?? null, phone ?? null, avatar ?? null]
    );
    await client.query('COMMIT');
    return created[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
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

    // Link by verified email so Google + email-OTP with the same address are one
    // account. Never writes `name` — the app always prompts for a display name.
    const googleUser = await resolveVerifiedUser({
      email: user.email, providerColumn: 'google_id', providerId: user.id, avatar: user.avatar,
    });

    await mergeDeviceUser(deviceId, googleUser, 'google_id');

    user.name = googleUser.name ?? '';
    await attachAccountFlags(user, googleUser.id);
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

    // Link by verified email when Apple provides one (first sign-in, or if the
    // user didn't hide it). If Apple withholds the email, this falls back to
    // apple_id-only identity — the known Apple limitation.
    const appleUser = await resolveVerifiedUser({
      email, providerColumn: 'apple_id', providerId: user.id,
    });

    await mergeDeviceUser(deviceId, appleUser, 'apple_id');

    user.name = appleUser.name ?? '';
    await attachAccountFlags(user, appleUser.id);
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

    // Resolve/link by verified email (email OTP) so it collapses with a Google/
    // Apple account on the same address. Phone OTP has no email to link on, so it
    // stays its own identity keyed by auth_id.
    const userRow = await resolveVerifiedUser({
      email: email ? contact.trim() : null,
      providerColumn: 'auth_id',
      providerId: key,
      phone: email ? null : contact.trim(),
    });

    const user = {
      id: key,
      email: email ?? null,
      name: userRow.name ?? '',
      avatar: null,
      provider: 'otp',
    };

    await mergeDeviceUser(deviceId, userRow, 'auth_id');

    await attachAccountFlags(user, userRow.id);
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

// Register this device's Expo push token against the logged-in user. Stores the
// is_admin flag alongside so admin-only sends are a simple WHERE.
app.post('/api/push/register', requireAuth, async (req, res) => {
  try {
    const { token, platform } = req.body ?? {};
    if (!token || typeof token !== 'string' || token.indexOf('ExponentPushToken') !== 0) {
      return res.status(400).json({ error: 'valid Expo push token required' });
    }
    const column = PROVIDER_COLUMN[req.user.provider] ?? 'google_id';
    const { rows } = await pool.query(`SELECT id, is_admin FROM users WHERE ${column}=$1 LIMIT 1`, [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await pool.query(
      `INSERT INTO push_tokens (token, user_id, platform, is_admin, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (token) DO UPDATE SET user_id=$2, platform=$3, is_admin=$4, updated_at=NOW()`,
      [token, rows[0].id, platform || null, !!rows[0].is_admin]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Drop a token (e.g. on logout).
app.post('/api/push/unregister', requireAuth, async (req, res) => {
  try {
    const { token } = req.body ?? {};
    if (token) await pool.query(`DELETE FROM push_tokens WHERE token=$1`, [token]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
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

// ─────────────────────────────────────────────────────────────────────────────
// Season-scoped milestone awarding
// Mirrors pointsEngine.js getSeasonInfo(): CALENDAR QUARTERS, key `${year}-Q${q}`.
// Milestone keys are `${base}_${seasonKey}` so completions reset every quarter.
// Bonus points are awarded ON TOP of the daily cap. This whole path is guarded —
// a failure here must NEVER break the catch request.
// ─────────────────────────────────────────────────────────────────────────────
function getSeasonInfo(date = new Date()) {
  const year    = date.getFullYear();
  const quarter = Math.floor(date.getMonth() / 3) + 1;
  return {
    year,
    quarter,
    key:   `${year}-Q${quarter}`,
    start: new Date(year, (quarter - 1) * 3, 1),
    end:   new Date(year, quarter * 3, 1),
  };
}

// ── New-species bonus ────────────────────────────────────────────────────────
// The app promises: "Catch something you haven't logged before and you bank a
// species bonus." This awards it — once per species, per season, photo required.
// Recorded in the milestones table under key `species_<name>_<season>` so it's
// idempotent and resets with the season like everything else. Awarded ON TOP of
// the daily cap. Fully guarded: a failure here must never break a catch.
const NEW_SPECIES_BONUS = 25;

// The new-species bonus (and milestone awarding generally) relies on a duplicate
// insert FAILING to stay idempotent — otherwise a double-tap could pay twice.
// The table predates these migrations, so make sure that constraint really exists.
pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS milestones_user_key_uniq ON milestones (user_id, key)`)
  .catch(e => console.error('[init] milestones unique index:', e.message));

async function awardNewSpeciesBonus(userId, species, hasPhoto) {
  if (!hasPhoto || !species) return null;
  try {
    const season = getSeasonInfo();
    const safe = String(species).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const key = `species_${safe}_${season.key}`;
    // Insert first: the PK/unique constraint makes this the race-safe check.
    try {
      await pool.query(`INSERT INTO milestones (user_id, key) VALUES ($1,$2)`, [userId, key]);
    } catch {
      return null; // already earned this season (or table rejected it) — no double pay
    }
    await pool.query(`UPDATE users SET points_balance=points_balance+$1 WHERE id=$2`, [NEW_SPECIES_BONUS, userId]);
    await pool.query(
      `INSERT INTO points_transactions(user_id,delta,reason,reference_id,created_at) VALUES($1,$2,'new_species',$3,NOW())`,
      [userId, NEW_SPECIES_BONUS, key]
    );
    return { key, label: `New species: ${String(species).replace(/_/g, ' ')}`, points: NEW_SPECIES_BONUS };
  } catch (e) {
    console.error('[milestone] awardNewSpeciesBonus (non-fatal):', e.message);
    return null;
  }
}

// base key -> { label, points }. Must stay in sync with pointsEngine MILESTONE_DEFS.
const MILESTONE_DEFS = {
  // Getting started
  first_catch:      { label: 'First catch of the season',  points: 50 },
  species_sampler:  { label: 'Species sampler',            points: 50 },
  inshore_slam:     { label: 'Inshore slam',               points: 150 },

  // Volume ladder — the grind, for people who just fish a lot.
  catches_10:       { label: 'Ten on the board',           points: 75 },
  catches_25:       { label: 'Quarter century',            points: 150 },
  catches_50:       { label: 'Fifty fish',                 points: 300 },
  catches_100:      { label: 'Century club',               points: 600 },

  // Variety ladder — rewards curiosity, the "try a new bait/spot" angler.
  species_5:        { label: 'Five species',               points: 100 },
  species_10:       { label: 'Ten species',                points: 250 },
  species_15:       { label: 'Fifteen species',            points: 500 },

  // Skill / effort
  slam_plus:        { label: 'Slam plus',                  points: 250 },
  release_25:       { label: 'Conservationist',            points: 150 },
  early_bird:       { label: 'Early bird',                 points: 75 },
  night_owl:        { label: 'Night shift',                points: 75 },
  explorer_3:       { label: 'Explorer',                   points: 125 },
  streak_7:         { label: 'Seven-day streak',           points: 200 },
};

// Check + award any newly-earned milestones after a catch. Only counts catches
// that have a photo (image_url), matching the "with a live photo" requirement.
// Returns [{ key, label, points }] for anything just earned (for the app to celebrate).
async function awardMilestones(userId, currentSpecies, currentHasPhoto) {
  const earned = [];
  try {
    const season = getSeasonInfo();
    const keyFor = (base) => `${base}_${season.key}`;
    const allKeys = Object.keys(MILESTONE_DEFS).map(keyFor);

    // Which of this season's milestones does the user already have?
    const { rows: haveRows } = await pool.query(
      `SELECT key FROM milestones WHERE user_id=$1 AND key = ANY($2)`,
      [userId, allKeys]
    );
    const have = new Set(haveRows.map(r => r.key));

    const toAward = []; // base keys satisfied and not yet awarded

    // first_catch — first photo catch of the season (absent key + this catch has a photo)
    if (!have.has(keyFor('first_catch')) && currentHasPhoto) {
      toAward.push('first_catch');
    }

    // species_sampler — 3+ distinct species (with photos) this season
    if (!have.has(keyFor('species_sampler'))) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT species)::int AS n FROM catches
         WHERE user_id=$1 AND image_url IS NOT NULL
           AND caught_at >= $2 AND caught_at < $3`,
        [userId, season.start, season.end]
      );
      if ((rows[0]?.n ?? 0) >= 3) toAward.push('species_sampler');
    }

    // inshore_slam — redfish AND speckled trout (with photos) the same calendar day
    if (!have.has(keyFor('inshore_slam'))) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT species)::int AS n FROM catches
         WHERE user_id=$1 AND image_url IS NOT NULL
           AND DATE(caught_at)=CURRENT_DATE AND species = ANY($2)`,
        [userId, ['redfish', 'speckled_trout']]
      );
      if ((rows[0]?.n ?? 0) >= 2) toAward.push('inshore_slam');
    }

    // ── Season-scoped tallies, fetched once and reused by the ladders below ──
    const needVolume  = ['catches_10','catches_25','catches_50','catches_100'].some(k => !have.has(keyFor(k)));
    const needVariety = ['species_5','species_10','species_15'].some(k => !have.has(keyFor(k)));
    if (needVolume || needVariety) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS catches, COUNT(DISTINCT species)::int AS species
           FROM catches
          WHERE user_id=$1 AND image_url IS NOT NULL
            AND caught_at >= $2 AND caught_at < $3`,
        [userId, season.start, season.end]
      );
      const nCatches = rows[0]?.catches ?? 0;
      const nSpecies = rows[0]?.species ?? 0;

      // Volume ladder — every tier the count clears, so a big first session can
      // legitimately unlock several at once.
      for (const [base, need] of [['catches_10',10],['catches_25',25],['catches_50',50],['catches_100',100]]) {
        if (!have.has(keyFor(base)) && nCatches >= need) toAward.push(base);
      }
      // Variety ladder
      for (const [base, need] of [['species_5',5],['species_10',10],['species_15',15]]) {
        if (!have.has(keyFor(base)) && nSpecies >= need) toAward.push(base);
      }
    }

    // slam_plus — redfish + speckled trout + flounder, same calendar day
    if (!have.has(keyFor('slam_plus'))) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT species)::int AS n FROM catches
          WHERE user_id=$1 AND image_url IS NOT NULL
            AND DATE(caught_at)=CURRENT_DATE AND species = ANY($2)`,
        [userId, ['redfish', 'speckled_trout', 'flounder']]
      );
      if ((rows[0]?.n ?? 0) >= 3) toAward.push('slam_plus');
    }

    // release_25 — 25 released fish this season. Rewards conservation.
    if (!have.has(keyFor('release_25'))) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM catches
          WHERE user_id=$1 AND released=true AND image_url IS NOT NULL
            AND caught_at >= $2 AND caught_at < $3`,
        [userId, season.start, season.end]
      );
      if ((rows[0]?.n ?? 0) >= 25) toAward.push('release_25');
    }

    // early_bird / night_owl — a catch logged before 6am / after 9pm local-ish.
    // Uses the catch timestamp's hour; good enough for a fun badge.
    for (const [base, sql] of [
      ['early_bird', `EXTRACT(HOUR FROM caught_at) < 6`],
      ['night_owl',  `EXTRACT(HOUR FROM caught_at) >= 21`],
    ]) {
      if (have.has(keyFor(base))) continue;
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM catches
          WHERE user_id=$1 AND image_url IS NOT NULL
            AND caught_at >= $2 AND caught_at < $3 AND ${sql}`,
        [userId, season.start, season.end]
      );
      if ((rows[0]?.n ?? 0) >= 1) toAward.push(base);
    }

    // explorer_3 — catches logged at 3+ distinct spots (rounded coords) this season.
    if (!have.has(keyFor('explorer_3'))) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT (ROUND(lat::numeric,2) || ',' || ROUND(lon::numeric,2)))::int AS n
           FROM catches
          WHERE user_id=$1 AND image_url IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL
            AND caught_at >= $2 AND caught_at < $3`,
        [userId, season.start, season.end]
      );
      if ((rows[0]?.n ?? 0) >= 3) toAward.push('explorer_3');
    }

    // streak_7 — logged a catch on 7 consecutive calendar days (ending today).
    if (!have.has(keyFor('streak_7'))) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT DATE(caught_at))::int AS n FROM catches
          WHERE user_id=$1 AND image_url IS NOT NULL
            AND caught_at >= CURRENT_DATE - INTERVAL '6 days'`,
        [userId]
      );
      if ((rows[0]?.n ?? 0) >= 7) toAward.push('streak_7');
    }

    for (const base of toAward) {
      const key = keyFor(base);
      const def = MILESTONE_DEFS[base];
      // Insert only columns we've confirmed exist (user_id, key). If your table
      // needs more columns, this logs and skips — catches stay safe either way.
      try {
        await pool.query(`INSERT INTO milestones (user_id, key) VALUES ($1,$2)`, [userId, key]);
      } catch (e) {
        console.error(`[milestone] insert failed for ${key} (check milestones table schema):`, e.message);
        continue; // don't award points if we couldn't record the milestone
      }
      // Bonus points ON TOP of the daily cap.
      await pool.query(`UPDATE users SET points_balance=points_balance+$1 WHERE id=$2`, [def.points, userId]);
      await pool.query(
        `INSERT INTO points_transactions(user_id,delta,reason,reference_id,created_at) VALUES($1,$2,'milestone',$3,NOW())`,
        [userId, def.points, key]
      );
      earned.push({ key, label: def.label, points: def.points });
    }
  } catch (e) {
    console.error('[milestone] awardMilestones error (non-fatal):', e.message);
  }
  return earned;
}

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
    // Shadowbanned users' posts are created hidden — visible to them, nobody else.
    if (await isShadowbanned(user.id)) await pool.query(`UPDATE catches SET hidden=true WHERE id=$1`, [newCatch.id]).catch(() => {});
    if (ptsAwarded > 0) {
      await pool.query(`UPDATE users SET points_balance=points_balance+$1 WHERE id=$2`, [ptsAwarded, user.id]);
      await pool.query(`INSERT INTO points_transactions(user_id,delta,reason,reference_id,created_at) VALUES($1,$2,'catch',$3,NOW())`, [user.id, ptsAwarded, newCatch.id.toString()]);
    }

    // Season milestones — bonus points on top of the daily cap. Fully guarded.
    const milestonesJustEarned = await awardMilestones(user.id, species, !!imageUrl);
    // First time logging this species this season → the bonus the app promises.
    const speciesBonus = await awardNewSpeciesBonus(user.id, species, !!imageUrl);
    if (speciesBonus) milestonesJustEarned.push(speciesBonus);

    res.json({ catch: formatCatch(newCatch), ptsAwarded, dailyTotal: todayPts+ptsAwarded, dailyCap, boostActive, pointsRejectReason: scanRejectReason, milestonesJustEarned });
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

// ── Community feed: public catches + public spots, merged & sorted, with angler
// attribution, like/comment counts, optional distance filter, cursor pagination.
// No auth required (guest-readable), matching the other community reads.
function _haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8, d = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * d / 2) ** 2 +
            Math.cos(lat1 * d) * Math.cos(lat2 * d) * Math.sin((lon2 - lon1) * d / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.get('/api/feed', async (req, res) => {
  try {
    const { lat, lon, radius = 100, limit = 25, type = 'all', before = null } = req.query;
    const lim = Math.min(parseInt(limit) || 25, 50);
    const haveGeo = lat != null && lon != null && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon));
    const items = [];

    if (type === 'all' || type === 'catches') {
      const { rows } = await pool.query(
        `SELECT c.id, c.species, c.length_in, c.released, c.image_url, c.lat, c.lon, c.caught_at AS created_at,
                u.id AS angler_id, u.name AS angler_name, u.avatar, u.is_club, u.club_badge, u.public_profile, u.anonymize_shared,
                (SELECT COUNT(*) FROM likes    WHERE target_type='catch' AND target_id=c.id) AS like_count,
                (SELECT COUNT(*) FROM comments WHERE target_type='catch' AND target_id=c.id) AS comment_count
         FROM catches c JOIN users u ON u.id=c.user_id
         WHERE u.share_with_community=true AND c.is_public=true AND c.hidden IS NOT TRUE
         ${before ? 'AND c.caught_at < $1' : ''}
         ORDER BY c.caught_at DESC LIMIT ${lim + 1}`,
        before ? [before] : []
      );
      for (const r of rows) {
        let la = r.lat, lo = r.lon;
        if (la != null && lo != null) { const j = jitterCoords(la, lo, r.id); la = j.lat; lo = j.lon; }
        const anon = r.anonymize_shared;
        items.push({
          type: 'catch', id: r.id, imageUrl: r.image_url ?? null,
          species: r.species, lengthIn: r.length_in, released: r.released,
          lat: la, lon: lo, createdAt: r.created_at,
          likeCount: Number(r.like_count) || 0, commentCount: Number(r.comment_count) || 0,
          angler: {
            userId: r.angler_id,
            name: anon ? null : (r.angler_name ?? null),
            avatar: anon ? null : (r.avatar ?? null),
            isClub: !!r.is_club, badge: r.club_badge ?? null,
            publicProfile: !!r.public_profile && !anon,
          },
        });
      }
    }

    if (type === 'all' || type === 'spots') {
      const { rows } = await pool.query(
        `SELECT s.id, s.name, s.type AS spot_type, s.note, s.lat, s.lon, s.photo_url, s.created_at,
                u.id AS angler_id, u.name AS angler_name, u.avatar, u.is_club, u.club_badge, u.public_profile,
                (SELECT COUNT(*) FROM likes    WHERE target_type='spot' AND target_id=s.id) AS like_count,
                (SELECT COUNT(*) FROM comments WHERE target_type='spot' AND target_id=s.id) AS comment_count
         FROM spots s JOIN users u ON u.id=s.user_id
         WHERE s.is_private=false AND s.hidden IS NOT TRUE
         ${before ? 'AND s.created_at < $1' : ''}
         ORDER BY s.created_at DESC LIMIT ${lim + 1}`,
        before ? [before] : []
      );
      for (const r of rows) {
        items.push({
          type: 'spot', id: r.id, imageUrl: r.photo_url ?? null,
          name: r.name, spotType: r.spot_type, note: r.note,
          lat: r.lat, lon: r.lon, createdAt: r.created_at,
          likeCount: Number(r.like_count) || 0, commentCount: Number(r.comment_count) || 0,
          angler: {
            userId: r.angler_id, name: r.angler_name ?? null, avatar: r.avatar ?? null,
            isClub: !!r.is_club, badge: r.club_badge ?? null, publicProfile: !!r.public_profile,
          },
        });
      }
    }

    if (haveGeo) {
      const uLat = parseFloat(lat), uLon = parseFloat(lon), rad = parseFloat(radius) || 100;
      for (const it of items) {
        it.distanceMi = (it.lat != null && it.lon != null) ? _haversineMi(uLat, uLon, it.lat, it.lon) : null;
      }
      let within = items.filter(it => it.distanceMi != null && it.distanceMi <= rad);
      if (within.length === 0) within = items; // nationwide fallback so it's never empty
      within.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return res.json({ items: within.slice(0, lim) });
    }

    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ items: items.slice(0, lim) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    if (await isShadowbanned(user.id)) await pool.query(`UPDATE spots SET hidden=true WHERE id=$1`, [newSpot.id]).catch(() => {});
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
    const viewer = await getUserFromRequest(req).catch(() => null);
    // Get photos with like counts per photo (hidden photos show only to their uploader)
    const { rows } = await pool.query(
      `SELECT sp.id, sp.photo_url, sp.created_at, sp.user_id,
              u.name AS user_name, u.avatar AS user_avatar, u.anonymize_shared,
              u.is_club AS author_is_club, u.club_badge AS author_badge,
              u.public_profile AS author_public_profile,
              COUNT(l.id)::int AS like_count
       FROM spot_photos sp
       JOIN users u ON u.id = sp.user_id
       LEFT JOIN likes l ON l.target_type='spot_photo' AND l.target_id=sp.id
       WHERE sp.spot_id = $1 AND (sp.hidden IS NOT TRUE OR sp.user_id = $2)
       GROUP BY sp.id, u.name, u.avatar, u.anonymize_shared, u.is_club, u.club_badge, u.public_profile
       ORDER BY sp.created_at DESC`,
      [spotId, viewer?.id ?? -1]
    );
    // Check if requesting user has liked each photo
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
    if (await isShadowbanned(userId)) await pool.query(`UPDATE spot_photos SET hidden=true WHERE id=$1`, [photo.id]).catch(() => {});
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

// ── Fishing regulations (server-hosted, human-verified) ──────────────────────
// Numbers are ONLY ever entered/approved by a human. Each row carries a
// verified_date + review_by; once past review_by the app stops trusting it and
// falls back to the official link-out (auto-downgrade) — so the app can never
// confidently show a stale number.
pool.query(`
  CREATE TABLE IF NOT EXISTS regulations (
    id            SERIAL PRIMARY KEY,
    state_code    TEXT NOT NULL,
    species       TEXT NOT NULL,
    region        TEXT NOT NULL DEFAULT '',  -- '' = statewide; some states manage by zone
    min_size_in   NUMERIC,                   -- min total length, inches (null = none)
    max_size_in   NUMERIC,                   -- slot max, inches (null = no max)
    bag_limit     INTEGER,                   -- daily creel per angler (null = unspecified)
    season        TEXT,                      -- e.g. 'All year' or 'May 1 - Feb 28'
    gamefish      BOOLEAN DEFAULT false,
    catch_release BOOLEAN DEFAULT false,     -- true = release only, no harvest
    notes         TEXT,
    source_url    TEXT,
    verified_date DATE,
    review_by     DATE,
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(state_code, species, region)
  )
`).catch(e => console.error('[init] regulations:', e.message));

// "What to add next" — species+state anglers log that we have no data for yet,
// ranked by demand. This is how coverage grows without guessing.
pool.query(`
  CREATE TABLE IF NOT EXISTS reg_gaps (
    id          SERIAL PRIMARY KEY,
    state_code  TEXT NOT NULL,
    species     TEXT NOT NULL,
    hits        INTEGER DEFAULT 1,
    last_seen   TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(state_code, species)
  )
`).catch(e => console.error('[init] reg_gaps:', e.message));

// Some species are intentionally link-out only: the state manages them under a
// group/complex (e.g. NC's Snapper/Grouper Complex) and publishes no size/bag,
// so there's nothing to store and nothing to fix. Dismissing keeps them out of
// the Gaps list forever while anglers still get the official-source link.
pool.query(`ALTER TABLE reg_gaps ADD COLUMN IF NOT EXISTS dismissed BOOLEAN DEFAULT false`)
  .catch(e => console.error('[init] reg_gaps.dismissed:', e.message));

// ── Zone-managed species ─────────────────────────────────────────────────────
// Some states set different limits by region/zone (FL manages redfish across 9
// regions, and the Indian River Lagoon is catch-and-release only; NY's striped
// bass differs in the Hudson; NJ's fluke differs on Delaware Bay; several states
// use different minimums for shore vs. vessel anglers).
//
// A single statewide number is WRONG for some anglers in these cases, and a
// confidently wrong limit is worse than no limit. So when the bot detects a
// zone-managed species it records it here and NEVER publishes a statewide row.
// /api/regs then tells the angler the fish is zone-managed and links to the
// official source instead of showing a number.
//
// Per-zone limits live in regulations.region (already in the schema) — populating
// that with verified zone boundaries is the follow-on step, not this one.
pool.query(`
  CREATE TABLE IF NOT EXISTS reg_zone_flags (
    state_code TEXT NOT NULL,
    species    TEXT NOT NULL,
    zone_note  TEXT,
    source_url TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (state_code, species)
  )
`).catch(e => console.error('[init] reg_zone_flags:', e.message));

// zones: the per-zone limits table, verbatim from the source, but ONLY stored when
// all 3 reads agree on it. When they don't, zones stays null and the angler sees
// the note + official link rather than numbers we aren't sure of.
pool.query(`
  ALTER TABLE reg_zone_flags ADD COLUMN IF NOT EXISTS zones      JSONB;
  ALTER TABLE reg_zone_flags ADD COLUMN IF NOT EXISTS verified_on DATE;
`).catch(e => console.error('[init] reg_zone_flags zones:', e.message));

// ── Phase 3: scrub-bot tables ────────────────────────────────────────────────
// Proposed changes the daily bot drafts from official sources. NOTHING here is
// live — an admin approves (writes to `regulations`) or rejects each one.
pool.query(`
  CREATE TABLE IF NOT EXISTS reg_proposals (
    id            SERIAL PRIMARY KEY,
    state_code    TEXT NOT NULL,
    species       TEXT NOT NULL,
    region        TEXT NOT NULL DEFAULT '',
    proposed      JSONB NOT NULL,          -- {minSizeIn,maxSizeIn,bagLimit,season,gamefish,catchRelease,notes}
    current       JSONB,                   -- snapshot of the live row at draft time (for the diff)
    source_url    TEXT,
    source_excerpt TEXT,                   -- the text the bot read it from (for you to verify)
    status        TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ
  )
`).catch(e => console.error('[init] reg_proposals:', e.message));

// Tracks the last content hash per state so the bot only works when a page
// actually changed (most days = no change = no cost).
pool.query(`
  CREATE TABLE IF NOT EXISTS reg_source_checks (
    state_code   TEXT PRIMARY KEY,
    last_hash    TEXT,
    last_checked TIMESTAMPTZ,
    last_status  TEXT
  )
`).catch(e => console.error('[init] reg_source_checks:', e.message));

// ── Phase 4: auto-publish + self-verification migration ──────────────────────
// CREATE TABLE IF NOT EXISTS above won't touch tables that already exist, so the
// new columns are added explicitly. All idempotent — safe to run every boot.
//   regulations.pending_review     : row was auto-published but not yet confirmed
//   regulations.auto_published_at  : when it went live (drives the 21-day expiry)
//   reg_proposals.auto_published   : this draft was pushed live (confirm/deny), not held
//   reg_proposals.confidence       : 'high' (3 reads agree) | 'conflict' (they don't)
//   reg_proposals.hold_reason      : why a draft was held (big_change | new_species | conflict …)
//   reg_proposals.reads            : the 3 raw reads for this species, stored only on conflict
//   reg_source_checks.fail_count   : consecutive fetch/extract failures (surfaces the alert banner)
pool.query(`
  ALTER TABLE regulations     ADD COLUMN IF NOT EXISTS pending_review    BOOLEAN DEFAULT false;
  ALTER TABLE regulations     ADD COLUMN IF NOT EXISTS auto_published_at TIMESTAMPTZ;
  ALTER TABLE reg_proposals   ADD COLUMN IF NOT EXISTS auto_published    BOOLEAN DEFAULT false;
  ALTER TABLE reg_proposals   ADD COLUMN IF NOT EXISTS confidence        TEXT;
  ALTER TABLE reg_proposals   ADD COLUMN IF NOT EXISTS hold_reason       TEXT;
  ALTER TABLE reg_proposals   ADD COLUMN IF NOT EXISTS reads             JSONB;
  ALTER TABLE regulations     ADD COLUMN IF NOT EXISTS discrepancy_at    TIMESTAMPTZ;
  ALTER TABLE regulations     ADD COLUMN IF NOT EXISTS discrepancy_url   TEXT;
  ALTER TABLE reg_source_checks ADD COLUMN IF NOT EXISTS fail_count      INTEGER DEFAULT 0;
  ALTER TABLE reg_source_checks ADD COLUMN IF NOT EXISTS species_found   INTEGER;
`).catch(e => console.error('[init] regs auto-publish migration:', e.message));

// ── Phase 5: seasonal rules ──────────────────────────────────────────────────
// Some states set different limits by DATE within the year (e.g. DE summer
// flounder: Jan 1 - May 31 = 16", Jun 1 - Dec 31 = 17.5"). A single number per
// species can't hold that, and forcing it made the bot read "two sizes" as "no
// limit". `rules` is an ordered list of dated windows, each with its own limits:
//   [{ window: "Jan 1 - May 31", minSizeIn, maxSizeIn, bagLimit, catchRelease, notes }]
// When rules is set, the flat columns stay null and clients pick today's window.
// Flat (year-round) regs keep using the flat columns with rules = NULL, so the
// existing 20 states are untouched.
pool.query(`
  ALTER TABLE regulations ADD COLUMN IF NOT EXISTS rules JSONB;
`).catch(e => console.error('[init] regulations.rules:', e.message));

// ── Push notification device tokens ──────────────────────────────────────────
pool.query(`
  CREATE TABLE IF NOT EXISTS push_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER,
    platform   TEXT,
    is_admin   BOOLEAN DEFAULT false,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[init] push_tokens:', e.message));

// Official state sources for the "Check my state's regulations" link-out.
// Add a state here when you turn it on. Unlisted states get a safe search fallback.
const STATE_REG_SOURCES = {
  // Southeast
  GA: { name: 'Georgia DNR — Coastal Resources',          url: 'https://coastalgadnr.org/limits' },
  // FWC's /recreational/ landing page is a hub — it links to species but lists no
  // limits. The numbers live on per-species pages, so FL scrapes those and merges.
  // `url` stays the human-facing hub for the "check regulations" link.
  FL: {
    name: 'Florida FWC — Saltwater Recreational',
    url: 'https://myfwc.com/fishing/saltwater/recreational/',
    scrape: [
      'https://myfwc.com/fishing/saltwater/recreational/red-drum/',
      'https://myfwc.com/fishing/saltwater/recreational/spotted-seatrout/',
      'https://myfwc.com/fishing/saltwater/recreational/snook/',
      'https://myfwc.com/fishing/saltwater/recreational/flounder/',
      'https://myfwc.com/fishing/saltwater/recreational/sheepshead/',
      'https://myfwc.com/fishing/saltwater/recreational/black-drum/',
      'https://myfwc.com/fishing/saltwater/recreational/pompano/',
      'https://myfwc.com/fishing/saltwater/recreational/tripletail/',
      'https://myfwc.com/fishing/saltwater/recreational/cobia/',
      'https://myfwc.com/fishing/saltwater/recreational/tarpon/',
      'https://myfwc.com/fishing/saltwater/recreational/mackerel/',
      'https://myfwc.com/fishing/saltwater/recreational/snapper/',
      'https://myfwc.com/fishing/saltwater/recreational/grouper/',
    ],
  },
  SC: { name: 'SC DNR — Saltwater Finfish Limits',        url: 'https://www.eregulations.com/southcarolina/fishing/finfish-size-catch-limits' },
  NC: { name: 'NC Marine Fisheries — Recreational Limits', url: 'https://www.deq.nc.gov/about/divisions/marine-fisheries/rules-proclamations-and-size-and-bag-limits/recreational-size-and-bag-limits' },
  // Gulf
  AL: { name: 'Alabama DCNR — Saltwater Limits',          url: 'https://www.outdooralabama.com/fishing/saltwater-recreational-size-creel-limits' },
  MS: { name: 'Mississippi DMR — Recreational Limits',    url: 'https://dmr.ms.gov/recreational-catch-limits/' },
  LA: { name: 'Louisiana LDWF — Saltwater Finfish',       url: 'https://www.wlf.louisiana.gov/page/recreational-saltwater-finfish' },
  // TPWD's landing page is JS-rendered (a plain fetch sees no limits), but each
  // per-species sub-page is static. So TX scrapes the sub-pages and merges them;
  // `url` stays the human-facing index for the "check regulations" link.
  TX: {
    name: 'Texas Parks & Wildlife — Saltwater Limits',
    url: 'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits',
    scrape: [
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/drum-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/seatrout-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/snapper-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/mackerel-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/flounder-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/sheepshead-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/snook-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/tarpon-bag-length-limits',
      'https://tpwd.texas.gov/regulations/outdoor-annual/fishing/saltwater-fishing/bag-length-limits/grouper-bag-length-limits',
    ],
  },
  // Mid-Atlantic
  VA: { name: 'Virginia VMRC — Saltwater Rec Limits',     url: 'https://webapps.mrc.virginia.gov/public/reports/swrecfishingrules.php' },
  MD: { name: 'Maryland DNR — Atlantic Limits',           url: 'https://www.eregulations.com/maryland/fishing/atlantic-seasons-sizes-limits' },
  DE: { name: 'Delaware DNREC — Tidal Size & Creel',      url: 'https://www.eregulations.com/delaware/fishing/tidal-seasons-size-creel-limits' },
  NJ: { name: 'NJ Fish & Wildlife — Size & Possession',   url: 'https://www.eregulations.com/newjersey/fishing/saltwater/state-size-possession-limits' },
  NY: { name: 'NY DEC — Recreational Saltwater',          url: 'https://dec.ny.gov/things-to-do/saltwater-fishing/recreational-fishing-regulations' },
  // Northeast
  CT: { name: 'CT DEEP — Marine Fishing Limits',          url: 'https://www.eregulations.com/connecticut/fishing/marine-fishing-regulations' },
  RI: { name: 'RI DEM — Saltwater Limits',                url: 'https://www.eregulations.com/rhodeisland/saltwater/recreational-saltwater-fishing-regulations' },
  MA: { name: 'MA DMF — Recreational Saltwater',          url: 'https://www.eregulations.com/massachusetts/fishing/saltwater/recreational-saltwater-fishing-regulations' },
  NH: { name: 'NH Fish & Game — Saltwater Limits',        url: 'https://www.eregulations.com/newhampshire/fishing/saltwater-fishing' },
  ME: { name: 'Maine DMR — Recreational Limits',          url: 'https://www.maine.gov/dmr/fisheries/recreational/regulations' },
  // Pacific
  CA: { name: 'California CDFW — Ocean Sport Fishing',    url: 'https://www.eregulations.com/california/fishing/species-regulations' },
  OR: { name: 'Oregon ODFW — Sport Fishing',              url: 'https://www.eregulations.com/oregon/fishing/marine-zone' },
  // WA / AK / HI are intentionally NOT bot sources. Their regs are managed by
  // area/zone (Puget Sound vs coast; AK's per-region emergency orders; HI's
  // island rules) and live behind portals with no single static limits table —
  // the bot found zero species on all three. Rather than burn 3 AI reads per
  // change-day on pages that yield nothing (and risk publishing a statewide
  // number that's wrong for the angler's zone), these link out to the official
  // source via stateRegs.js and show "no limits saved yet" in the carousel.
  // Re-add here if a clean per-species page is found.
};
function stateSource(stateCode) {
  const sc = (stateCode || '').toUpperCase();
  return STATE_REG_SOURCES[sc] || {
    name: `${sc || 'Your state'} fishing regulations`,
    url: `https://www.google.com/search?q=${encodeURIComponent((sc ? sc + ' ' : '') + 'saltwater fishing size and bag limits official')}`,
  };
}

// GET /api/regs?state=GA&species=redfish[&region=]
// Verified numbers if we have a current row; else flags link-out (and logs the
// gap). Stale rows (past review_by) auto-downgrade to link-out. Always fails safe.
app.get('/api/regs', async (req, res) => {
  const state = (req.query.state || '').toUpperCase();
  try {
    const species = (req.query.species || '').toLowerCase();
    const region  = req.query.region || '';
    const source  = stateSource(state);
    if (!state || !species) return res.json({ hasData: false, reason: 'missing_params', source });

    // Zone-managed? Then there IS no single statewide answer. Say so plainly
    // rather than showing nothing (or, worse, a number that's wrong in some
    // zones). Checked before the row lookup so a stale statewide row can't win.
    const zoneFlag = (await pool.query(
      `SELECT zone_note, source_url, zones, verified_on FROM reg_zone_flags WHERE state_code=$1 AND species=$2 LIMIT 1`,
      [state, species]
    ).catch(() => ({ rows: [] }))).rows[0];
    if (zoneFlag && !region) {
      return res.json({
        hasData: false,
        reason: 'zone_varies',
        zoneNote: zoneFlag.zone_note || 'Limits differ by region or zone in this state.',
        // Verbatim per-zone limits, only present when the 3 reads agreed.
        zones: Array.isArray(zoneFlag.zones) ? zoneFlag.zones : null,
        zonesVerifiedOn: zoneFlag.verified_on || null,
        source: { name: source.name, url: zoneFlag.source_url || source.url },
      });
    }

    const { rows } = await pool.query(
      `SELECT * FROM regulations
       WHERE state_code=$1 AND species=$2 AND region IN ($3, '')
       ORDER BY (region = $3) DESC, verified_date DESC NULLS LAST
       LIMIT 1`,
      [state, species, region]
    );

    if (!rows.length) {
      await pool.query(
        `INSERT INTO reg_gaps (state_code, species) VALUES ($1,$2)
         ON CONFLICT (state_code, species) DO UPDATE SET hits = reg_gaps.hits + 1, last_seen = NOW()`,
        [state, species]
      ).catch(() => {});
      return res.json({ hasData: false, reason: 'no_data', source });
    }

    const r = rows[0];
    if (r.review_by && new Date(r.review_by) < new Date()) {
      return res.json({ hasData: false, reason: 'stale', staleSince: r.review_by, source: { name: source.name, url: r.source_url || source.url } });
    }

    res.json({
      hasData: true,
      reg: {
        state, species, region: r.region || null,
        minSizeIn: r.min_size_in != null ? Number(r.min_size_in) : null,
        maxSizeIn: r.max_size_in != null ? Number(r.max_size_in) : null,
        bagLimit: r.bag_limit ?? null,
        season: r.season ?? null,
        gamefish: !!r.gamefish,
        catchRelease: !!r.catch_release,
        notes: r.notes ?? null,
        // Seasonal windows, when the state sets limits by date. Each entry:
        // { window, minSizeIn, maxSizeIn, bagLimit, catchRelease, notes }.
        // Clients pick the window covering today and show the rest as context.
        rules: Array.isArray(r.rules) && r.rules.length ? r.rules : null,
        verifiedDate: r.verified_date,
        // Auto-published-but-unconfirmed: the gate should show a "pending review"
        // tag and lean on the disclaimer. Human-confirmed rows have this false.
        pendingReview: !!r.pending_review,
        autoPublishedAt: r.auto_published_at || null,
        // Bot saw the source change to something it couldn't confirm; we're
        // showing the last-known value and warning the angler to verify.
        discrepancy: !!r.discrepancy_at,
        discrepancyUrl: r.discrepancy_url || null,
      },
      source: { name: source.name, url: r.source_url || source.url },
    });
  } catch (err) {
    console.error('Regs error:', err);
    res.json({ hasData: false, reason: 'error', source: stateSource(state) }); // fail safe → link-out
  }
});

// Which states currently have (non-stale) data for a species — powers the state
// carousel's dots so an angler can see at a glance where regs exist. One cheap
// query; mirrors the stale rule in /api/regs so a downgraded row doesn't count.
app.get('/api/regs/coverage', async (req, res) => {
  try {
    const species = (req.query.species || '').toLowerCase();
    if (!species) return res.json({ coverage: [] });
    const { rows } = await pool.query(
      `SELECT state_code, bool_or(COALESCE(pending_review, false)) AS pending
         FROM regulations
        WHERE species=$1 AND region='' AND (review_by IS NULL OR review_by >= CURRENT_DATE)
        GROUP BY state_code`,
      [species]
    );
    res.json({ coverage: rows.map(r => ({ state: r.state_code, pending: !!r.pending })) });
  } catch (err) {
    console.error('Regs coverage error:', err);
    res.json({ coverage: [] }); // fail safe → dots just stay neutral
  }
});

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
    if (await isShadowbanned(user.id)) await pool.query(`UPDATE comments SET hidden=true WHERE id=$1`, [newComment.id]).catch(() => {});
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
       WHERE c.target_type=$1 AND c.target_id=$2 AND (c.hidden IS NOT TRUE OR c.user_id = $3)
       GROUP BY c.id, u.name, u.avatar, u.anonymize_shared, u.is_club, u.club_badge
       ORDER BY c.created_at ASC`,
      [targetType, tId, viewer?.id ?? -1]
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
  let predictions, extremes;
  if (cached && (Date.now() - cached.fetchedAt) < 6 * 3600 * 1000) {
    predictions = cached.predictions;
    extremes = cached.extremes || [];
  } else {
    try {
      const today = new Date();
      const end   = new Date(today);
      end.setDate(end.getDate() + parseInt(days));
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

      // NOAA times are requested in GMT and converted to real ISO instants
      // (with the Z) here, ONCE. The old version asked for station-local time
      // (lst_ldt) and then parsed those strings on this server - which runs on
      // UTC - so every timestamp silently shifted by the station's UTC offset
      // (4h on the east coast) before the phone converted it AGAIN. That's the
      // "high tide at 3am instead of 6:25am" bug. GMT in, explicit Z out, and
      // the phone's local conversion is the only conversion that ever happens.
      const noaaUtcToIso = (t) => new Date(String(t).replace(' ', 'T') + 'Z').toISOString();

      // Not all NOAA stations support every datum, and some stations are
      // "subordinate" stations that aren't supported by the live predictions
      // datagetter API at all, even though NOAA's website displays
      // predictions for them via a different computation path. Try datums
      // in order of preference; if none work, this station genuinely has no
      // live predictions available.
      const datums = ['MLLW', 'MSL', 'STND'];
      let noaaData = null;
      let chosenDatum = null;
      let lastErr = null;

      for (const datum of datums) {
        const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${fmt(today)}&end_date=${fmt(end)}&station=${station}&product=predictions&datum=${datum}&time_zone=gmt&interval=h&units=english&application=bonetideco&format=json`;
        const response = await fetch(url);
        const data = await response.json();
        if (data.predictions) { noaaData = data; chosenDatum = datum; break; }
        lastErr = data.error?.message ?? 'NOAA returned no predictions';
      }

      if (!noaaData) {
        // Station has no usable predictions under any datum. Return a clean
        // "unavailable" response (not a 500) so the app can prompt the user
        // to pick a different station instead of showing a hard error.
        console.warn(`Tides unavailable for station ${station}: ${lastErr}`);
        return res.json({ available: false, reason: 'station_unsupported', stationId: station, predictions: [] });
      }
      predictions = noaaData.predictions.map(p => ({ t: noaaUtcToIso(p.t), v: parseFloat(p.v) }));

      // Exact high/low EVENTS (interval=hilo): the true extremes at their real
      // minute (6:25 AM), with H/L type. The hourly curve above can only snap
      // extremes to whole hours, which is up to ~30 min wrong - fine for the
      // curve shape, not for the "HIGH 6:25 AM" cards anglers plan around.
      extremes = [];
      try {
        const hiloUrl = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?begin_date=${fmt(today)}&end_date=${fmt(end)}&station=${station}&product=predictions&datum=${chosenDatum}&time_zone=gmt&interval=hilo&units=english&application=bonetideco&format=json`;
        const hiloRes = await fetch(hiloUrl);
        const hiloData = await hiloRes.json();
        if (Array.isArray(hiloData.predictions)) {
          extremes = hiloData.predictions.map(p => ({
            t: noaaUtcToIso(p.t),
            v: parseFloat(p.v),
            type: String(p.type).toUpperCase() === 'H' ? 'H' : 'L',
          }));
        }
      } catch (e) {
        console.warn(`Tide hilo unavailable for station ${station}: ${e.message}`);
      }

      tidePredictionsCache.set(station, { predictions, extremes, fetchedAt: Date.now() });
    } catch (err) {
      console.error('Tides error:', err);
      // Network/unexpected error — still return a clean shape rather than a
      // hard 500, so the app can show a "try again" state instead of crashing.
      return res.json({ available: false, reason: 'fetch_error', error: err.message, predictions: [] });
    }
  }
  // Timestamps are now real ISO instants, so "where are we on the curve" is
  // plain epoch math - immune to whatever timezone this server runs in. (The
  // old string comparison used the server's local clock against NOAA's
  // station-local strings; on Railway's UTC clock that read the curve ~4h off.)
  const nowMs = Date.now();
  let beforePt = null, afterPt = null;
  for (let i = 0; i < predictions.length - 1; i++) {
    if (Date.parse(predictions[i].t) <= nowMs && Date.parse(predictions[i+1].t) > nowMs) { beforePt = predictions[i]; afterPt = predictions[i+1]; break; }
  }
  let currentHeight, currentDirection, currentPhase;
  if (beforePt && afterPt) {
    const t0 = Date.parse(beforePt.t);
    const t1 = Date.parse(afterPt.t);
    const frac = (nowMs - t0) / (t1 - t0);
    currentHeight = beforePt.v + frac * (afterPt.v - beforePt.v);
    const rising = afterPt.v > beforePt.v;
    currentDirection = rising ? 'Incoming' : 'Outgoing';
    currentPhase = Math.abs(afterPt.v - beforePt.v) < 0.3 ? (rising ? 'slack_high' : 'slack_low') : (rising ? 'incoming_fast' : 'outgoing_fast');
  } else {
    const closest = predictions.reduce((best, p) => Math.abs(Date.parse(p.t) - nowMs) < Math.abs(Date.parse(best.t) - nowMs) ? p : best, predictions[0]);
    currentHeight = closest?.v ?? null; currentDirection = 'Incoming'; currentPhase = 'incoming_fast';
  }
  // Daily range over the next 24h from now (the old "server-local calendar
  // day" filter straddled the wrong hours on a UTC server).
  const dayVals = predictions.filter(p => { const t = Date.parse(p.t); return t >= nowMs && t <= nowMs + 24 * 3600 * 1000; }).map(p => p.v);
  const dailyRange = dayVals.length ? Math.max(...dayVals) - Math.min(...dayVals) : 6;
  res.json({
    stationId: station,
    predictions,
    // Exact high/low events, [{ t: ISO, v, type: 'H'|'L' }], at the true
    // minute. Use these for HIGH/LOW cards and curve labels instead of
    // hunting for the biggest hourly sample.
    extremes,
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

    // Hourly: 24 hours starting from "now" — Open-Meteo's hourly.time array
    // covers several days, so find the first entry at/after current.time
    // (both in the same timezone-adjusted reference, since both come from
    // the same request) rather than assuming index 0 is the current hour.
    const hourlyTimes = forecast.hourly?.time ?? [];
    const nowIdx = Math.max(0, hourlyTimes.findIndex(t => t >= cur?.time));
    const hourly = [];
    for (let i = nowIdx; i < Math.min(nowIdx + 24, hourlyTimes.length); i++) {
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

// ── Solunar engine ──────────────────────────────────────────────────────────
// Real lunar-position based solunar periods. Majors occur at lunar transit
// (moon directly overhead / underfoot); minors at moonrise / moonset. Positions
// use Schlyter's low-precision lunar theory + the main perturbation terms
// (accurate to a few minutes — plenty for a fishing app). No external libs.
const _D2R = Math.PI / 180;
const _sind = d => Math.sin(d * _D2R);
const _cosd = d => Math.cos(d * _D2R);
const _asind = x => Math.asin(x) / _D2R;
const _atan2d = (y, x) => Math.atan2(y, x) / _D2R;
const _rev = d => ((d % 360) + 360) % 360;

// Days since the J2000-ish epoch Schlyter uses (2000-01-01 00:00 UT minus offset).
function _dayNumber(date) {
  const Y = date.getUTCFullYear(), M = date.getUTCMonth() + 1, D = date.getUTCDate();
  const UT = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  let d = 367 * Y - Math.floor(7 * (Y + Math.floor((M + 9) / 12)) / 4)
        + Math.floor(275 * M / 9) + D - 730530;
  return d + UT / 24;
}

// Geocentric equatorial coords of the Moon (RA/Dec in degrees) + sun mean long.
function _moonEquatorial(date) {
  const d = _dayNumber(date);
  // Moon orbital elements
  const N = _rev(125.1228 - 0.0529538083 * d);   // ascending node
  const i = 5.1454;                              // inclination
  const w = _rev(318.0634 + 0.1643573223 * d);   // arg. of perigee
  const a = 60.2666;                             // mean distance (Earth radii)
  const e = 0.054900;                            // eccentricity
  const M = _rev(115.3654 + 13.0649929509 * d);  // mean anomaly

  // Eccentric anomaly (Newton iteration)
  let E = M + (180 / Math.PI) * e * _sind(M) * (1 + e * _cosd(M));
  for (let k = 0; k < 6; k++) {
    E = E - (E - (180 / Math.PI) * e * _sind(E) - M) / (1 - e * _cosd(E));
  }
  const x = a * (_cosd(E) - e);
  const y = a * Math.sqrt(1 - e * e) * _sind(E);
  const r = Math.sqrt(x * x + y * y);
  const v = _rev(_atan2d(y, x));
  const vw = v + w;

  // Position in the ecliptic
  let xeclip = r * (_cosd(N) * _cosd(vw) - _sind(N) * _sind(vw) * _cosd(i));
  let yeclip = r * (_sind(N) * _cosd(vw) + _cosd(N) * _sind(vw) * _cosd(i));
  let zeclip = r * _sind(vw) * _sind(i);
  let lonecl = _rev(_atan2d(yeclip, xeclip));
  let latecl = _atan2d(zeclip, Math.sqrt(xeclip * xeclip + yeclip * yeclip));

  // Perturbation arguments (need sun + moon mean elements)
  const Ws = 282.9404 + 4.70935e-5 * d;
  const Ms = _rev(356.0470 + 0.9856002585 * d);
  const Ls = _rev(Ws + Ms);
  const Lm = _rev(N + w + M);
  const Dm = _rev(Lm - Ls);
  const F  = _rev(Lm - N);

  // Main perturbations in ecliptic longitude (degrees)
  lonecl += -1.274 * _sind(M - 2 * Dm)          // Evection
          +  0.658 * _sind(2 * Dm)              // Variation
          -  0.186 * _sind(Ms)                  // Yearly equation
          -  0.059 * _sind(2 * M - 2 * Dm)
          -  0.057 * _sind(M - 2 * Dm + Ms)
          +  0.053 * _sind(M + 2 * Dm)
          +  0.046 * _sind(2 * Dm - Ms)
          +  0.041 * _sind(M - Ms)
          -  0.035 * _sind(Dm)                  // Parallactic equation
          -  0.031 * _sind(M + Ms)
          -  0.015 * _sind(2 * F - 2 * Dm)
          +  0.011 * _sind(M - 4 * Dm);
  // Main perturbations in latitude (degrees)
  latecl += -0.173 * _sind(F - 2 * Dm)
          -  0.055 * _sind(M - F - 2 * Dm)
          -  0.046 * _sind(M + F - 2 * Dm)
          +  0.033 * _sind(F + 2 * Dm)
          +  0.017 * _sind(2 * M + F);

  // Ecliptic → equatorial
  const ecl = 23.4393 - 3.563e-7 * d;
  const xe = _cosd(lonecl) * _cosd(latecl);
  const ye = _sind(lonecl) * _cosd(latecl);
  const ze = _sind(latecl);
  const xq = xe;
  const yq = ye * _cosd(ecl) - ze * _sind(ecl);
  const zq = ye * _sind(ecl) + ze * _cosd(ecl);
  const ra  = _rev(_atan2d(yq, xq));
  const dec = _atan2d(zq, Math.sqrt(xq * xq + yq * yq));
  return { ra, dec, Ls };
}

// Moon altitude (degrees) above the horizon at a given time & location.
function _moonAltitude(date, lat, lon) {
  const { ra, dec, Ls } = _moonEquatorial(date);
  const UT = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const GMST0 = _rev(Ls + 180) / 15;            // hours
  const LST = GMST0 + UT + lon / 15;            // local sidereal time (hours)
  const HA = _rev(LST * 15 - ra);               // hour angle (degrees)
  return _asind(_sind(lat) * _sind(dec) + _cosd(lat) * _cosd(dec) * _cosd(HA));
}

// Linear interpolation for the moment altitude crosses a target level.
function _crossTime(t1, a1, t2, a2, target) {
  const f = (target - a1) / (a2 - a1);
  return t1 + f * (t2 - t1);
}

function computeSolunar(lat, lon) {
  const now = new Date();
  const moon = computeMoonPhase(now);

  // Sample altitude from 12h before to 24h after now, every 10 minutes.
  const stepMs = 10 * 60 * 1000;
  const startMs = now.getTime() - 12 * 3600 * 1000;
  const samples = Math.round(36 * 3600 * 1000 / stepMs);
  const HORIZON = -0.83; // moon center at rise/set (refraction + semidiameter)

  const events = []; // { type:'major'|'minor', peak:ms }
  let pT = null, pA = null, ppA = null;
  for (let k = 0; k <= samples; k++) {
    const t = startMs + k * stepMs;
    const alt = _moonAltitude(new Date(t), lat, lon);
    if (pA != null) {
      // Rise / set → minors
      if (pA < HORIZON && alt >= HORIZON) events.push({ type: 'minor', peak: _crossTime(pT, pA, t, alt, HORIZON) });
      if (pA >= HORIZON && alt < HORIZON) events.push({ type: 'minor', peak: _crossTime(pT, pA, t, alt, HORIZON) });
    }
    if (ppA != null) {
      // Altitude local max = upper transit (overhead), local min = lower transit
      // (underfoot). Both are majors.
      if (pA > ppA && pA >= alt) events.push({ type: 'major', peak: pT });
      if (pA < ppA && pA <= alt) events.push({ type: 'major', peak: pT });
    }
    ppA = pA; pA = alt; pT = t;
  }

  // Build windows: majors ±1h (2h total), minors ±0.5h (1h total).
  const periods = events.map(e => ({
    type: e.type,
    peak: Math.round(e.peak),
    start: Math.round(e.peak - (e.type === 'major' ? 60 : 30) * 60 * 1000),
    end:   Math.round(e.peak + (e.type === 'major' ? 60 : 30) * 60 * 1000),
  })).sort((p, q) => p.start - q.start);

  // Current state relative to now.
  const nowMs = now.getTime();
  let window = 'between';
  const inMajor = periods.some(p => p.type === 'major' && nowMs >= p.start && nowMs <= p.end);
  const inMinor = periods.some(p => p.type === 'minor' && nowMs >= p.start && nowMs <= p.end);
  if (inMajor) window = 'major_peak';
  else if (inMinor) window = 'minor_peak';
  else {
    // "Near" = a peak begins within the next 60 minutes.
    const soon = periods
      .filter(p => p.start > nowMs && p.start - nowMs <= 60 * 60 * 1000)
      .sort((a, b) => a.start - b.start)[0];
    if (soon) window = soon.type === 'major' ? 'major_near' : 'minor_near';
  }

  // Next upcoming period (for a "next window" hint on the client).
  const next = periods.find(p => p.end >= nowMs) || null;

  // Positions across the user's local day for an optional day-bar (xPct 0–1).
  const localHour = ms => (((new Date(ms).getUTCHours() + new Date(ms).getUTCMinutes() / 60) + lon / 15) % 24 + 24) % 24;
  const majorWindows = periods
    .filter(p => p.type === 'major')
    .map(p => ({ label: 'MAJ', xPct: +(localHour(p.peak) / 24).toFixed(4) }));

  const hourOfDay = now.getUTCHours() + lon / 15;
  return {
    window,                                    // major_peak | major_near | minor_peak | minor_near | between
    isMajor: window.startsWith('major'),
    periods,                                   // [{ type, start, end, peak }] epoch ms
    next: next ? { type: next.type, at: next.peak, start: next.start, end: next.end } : null,
    moonPhase: moon.phaseName.toLowerCase().includes('full') ? 'full' : moon.phaseName.toLowerCase().includes('new') ? 'new' : 'other',
    moonPhaseName: moon.phaseName,
    moonPhaseEmoji: moon.emoji,
    moonPct: moon.illumPct,
    lightWindow: ((hourOfDay % 24) + 24) % 24 < 7.5 ? 'dawn' : ((hourOfDay % 24) + 24) % 24 > 19.5 ? 'dusk' : 'other',
    majorWindows,
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
  // Amount-based redemption: the app sends `bones` (how many to spend).
  // Legacy app versions send `pointsCost` for a specific product — still honored.
  const { deviceId, shopifyProductId, productTitle, pointsCost, bones } = req.body;
  const requested = bones ?? pointsCost;
  if (!deviceId || !requested) return res.status(400).json({ error: 'deviceId and bones amount required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [user] } = await client.query('SELECT id, points_balance FROM users WHERE device_id=$1 FOR UPDATE', [deviceId]);
    if (!user) throw new Error('User not found');

    // Snap to clean 500-bone ($4) steps.
    const safePoints = Math.floor(requested / 500) * 500;
    const MIN_POINTS = 500;    // $4.00
    const MAX_POINTS = 12500;  // $100.00 cap per code
    if (safePoints < MIN_POINTS) throw new Error('Minimum redemption is 500 bones ($4.00).');
    if (safePoints > MAX_POINTS) throw new Error('Maximum redemption is 12,500 bones ($100.00) per code.');

    // Available = balance minus bones already tied up in un-confirmed holds.
    // (Holds only deduct from the balance when an order is confirmed, so we must
    // subtract pending holds here or a user could mint multiple codes off the
    // same balance.)
    const { rows: [{ pending }] } = await client.query(
      `SELECT COALESCE(SUM(points_held),0)::int AS pending
         FROM points_holds
        WHERE user_id=$1 AND status='pending' AND expires_at > NOW()`,
      [user.id]
    );
    const available = user.points_balance - pending;
    if (available < safePoints) {
      throw new Error(`Insufficient bones. You have ${available.toLocaleString()} available${pending ? ` (${pending.toLocaleString()} held in pending codes)` : ''}, need ${safePoints.toLocaleString()}.`);
    }

    const dollarValue = (safePoints / 125).toFixed(2);
    const codeStr = `BTC-${deviceId.slice(-6).toUpperCase()}-${Date.now()}`;
    const title = productTitle || `$${dollarValue} off`;
    const priceRule = await shopifyAdminPost('/price_rules.json', { price_rule: { title: codeStr, target_type: 'line_item', target_selection: 'all', allocation_method: 'across', value_type: 'fixed_amount', value: `-${dollarValue}`, customer_selection: 'all', usage_limit: 1, once_per_customer: true, starts_at: new Date().toISOString(), ends_at: new Date(Date.now() + 48*3600*1000).toISOString() } });
    const discountCode = await shopifyAdminPost(`/price_rules/${priceRule.price_rule.id}/discount_codes.json`, { discount_code: { code: codeStr } });
    await client.query(`INSERT INTO points_holds (user_id,points_held,shopify_product_id,product_title,discount_code,discount_code_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,'pending',NOW()+INTERVAL '48 hours')`, [user.id, safePoints, shopifyProductId ?? null, title, discountCode.discount_code.code, discountCode.discount_code.id.toString()]);
    await client.query('COMMIT');
    res.json({ discountCode: discountCode.discount_code.code, pointsDeducted: safePoints, dollarValue: parseFloat(dollarValue), newBalance: available - safePoints, expiresIn: '48 hours', message: 'Apply this code at checkout on bonetideco.com. Bones are deducted when your order is confirmed.' });
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

// ── Admin moderation: shadowban (limited posting window) + silent content hide ──
pool.query(`ALTER TABLE users    ADD COLUMN IF NOT EXISTS shadowbanned_until TIMESTAMPTZ`).catch(e => console.error('[init] shadowbanned_until:', e.message));
pool.query(`ALTER TABLE catches  ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false`).catch(e => console.error('[init] catches.hidden:', e.message));
pool.query(`ALTER TABLE spots    ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false`).catch(e => console.error('[init] spots.hidden:', e.message));
pool.query(`ALTER TABLE comments ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false`).catch(e => console.error('[init] comments.hidden:', e.message));
pool.query(`ALTER TABLE spot_photos ADD COLUMN IF NOT EXISTS hidden BOOLEAN DEFAULT false`).catch(e => console.error('[init] spot_photos.hidden:', e.message));

// True if the user is currently inside a shadowban window. Their new posts are
// created hidden — visible to them (so they don't notice), invisible to everyone.
async function isShadowbanned(userId) {
  try {
    const { rows } = await pool.query(`SELECT shadowbanned_until FROM users WHERE id=$1`, [userId]);
    return !!(rows[0] && rows[0].shadowbanned_until && new Date(rows[0].shadowbanned_until) > new Date());
  } catch { return false; }
}

// Bone Tide Club (RevenueCat) columns. The extension added these via a one-off
// psql command; declaring them here too makes the schema reproducible and is a
// no-op if they already exist.
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS rc_user_id      TEXT`).catch(e => console.error('[init] rc_user_id:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_club         BOOLEAN DEFAULT false`).catch(e => console.error('[init] is_club:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS club_expires_at TIMESTAMPTZ`).catch(e => console.error('[init] club_expires_at:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS club_badge      TEXT`).catch(e => console.error('[init] club_badge:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS public_profile  BOOLEAN DEFAULT false`).catch(e => console.error('[init] public_profile:', e.message));
pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo         BOOLEAN DEFAULT false`).catch(e => console.error('[init] is_demo:', e.message));
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

// Audit log of admin ACTIONS (who cleared/removed/resolved/banned what) — for
// accountability once more than one person has admin.
pool.query(`
  CREATE TABLE IF NOT EXISTS admin_actions (
    id          SERIAL PRIMARY KEY,
    admin_id    INTEGER,
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    detail      TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )
`).catch(e => console.error('[init] admin_actions:', e.message));

async function logAdminAction(adminId, action, targetType, targetId, detail = null) {
  try {
    await pool.query(
      `INSERT INTO admin_actions (admin_id, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5)`,
      [adminId ?? null, action, targetType ?? null, targetId != null ? String(targetId) : null, detail]
    );
  } catch (e) { console.error('[admin log]', e.message); }
}

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
// ─────────────────────────────────────────────────────────────────────────────
// DEV DEMO DATA — REMOVE BEFORE PUBLIC LAUNCH.
// Admin-only. Seeds a few fake anglers (tagged users.is_demo=true) with public
// profiles, catches, cross-comments and likes so profiles + feed can be tested.
// KILLSWITCH: DELETE /api/admin/demo/seed removes EVERY demo row in one call
// (all tagged via is_demo). To strip completely: delete this block, the
// is_demo column line, and the Settings "Developer" card.
// ─────────────────────────────────────────────────────────────────────────────
const DEMO_ANGLERS = [
  { name: 'Marlin Mike',  avatar: 'https://i.pravatar.cc/300?img=12', isClub: true,  badge: 'anchor' },
  { name: 'Reel Rosa',    avatar: 'https://i.pravatar.cc/300?img=45', isClub: true,  badge: 'wheel'  },
  { name: 'Captain Dave', avatar: 'https://i.pravatar.cc/300?img=68', isClub: false, badge: null     },
];
const DEMO_SPECIES  = ['Redfish','Snook','Speckled Trout','Tarpon','Flounder','Sheepshead','Black Drum','Mangrove Snapper','Jack Crevalle','Spanish Mackerel'];
const DEMO_COMMENTS = ['What a slob!','Nice one 🔥','Where were they biting?','Solid catch','That’s a stud','Gorgeous fish','Beautiful markings','Great day on the water'];
const DEMO_SPOTS = [
  { name: 'Sandbar Point',     type: 'flat',   note: 'Low incoming tide stacks bait on the edges here.' },
  { name: 'North Jetty Rocks', type: 'jetty',  note: 'Structure loaded with sheepshead in the cooler months.' },
  { name: 'Old Trestle',       type: 'bridge', note: 'Work the shadow line at night — snook sit right on it.' },
  { name: 'Cut Inlet',         type: 'inlets', note: 'Falling tide funnels everything through the cut.' },
  { name: 'Grass Flat South',  type: 'flat',   note: 'Wade early and sight-cast tailing reds on the flood.' },
];
const DEMO_SPOT_COMMENTS = ['Fished here last week — solid.','Adding this to my list 🙏','Great spot at dawn','Nailed a few here','Underrated honestly','Tide really matters here'];

async function teardownDemoData() {
  const { rows } = await pool.query(`SELECT id FROM users WHERE is_demo = true`);
  const ids = rows.map(r => r.id);
  if (!ids.length) return 0;
  const { rows: catchRows } = await pool.query(`SELECT id FROM catches WHERE user_id = ANY($1)`, [ids]);
  const catchIds = catchRows.map(r => r.id);
  if (catchIds.length) {
    await pool.query(`DELETE FROM comments WHERE target_type='catch' AND target_id = ANY($1)`, [catchIds]);
    await pool.query(`DELETE FROM likes    WHERE target_type='catch' AND target_id = ANY($1)`, [catchIds]);
  }
  // Demo spots + their photos, comments, and likes (incl. any engagement a real
  // user may have added to a demo spot/photo, to avoid orphaned rows).
  const { rows: spotRows } = await pool.query(`SELECT id FROM spots WHERE user_id = ANY($1)`, [ids]);
  const spotIds = spotRows.map(r => r.id);
  if (spotIds.length) {
    const { rows: photoRows } = await pool.query(`SELECT id FROM spot_photos WHERE spot_id = ANY($1)`, [spotIds]);
    const photoIds = photoRows.map(r => r.id);
    if (photoIds.length) {
      await pool.query(`DELETE FROM likes WHERE target_type='spot_photo' AND target_id = ANY($1)`, [photoIds]);
    }
    await pool.query(`DELETE FROM spot_photos WHERE spot_id = ANY($1)`, [spotIds]);
    await pool.query(`DELETE FROM comments WHERE target_type='spot' AND target_id = ANY($1)`, [spotIds]);
    await pool.query(`DELETE FROM likes    WHERE target_type='spot' AND target_id = ANY($1)`, [spotIds]);
    await pool.query(`DELETE FROM spots    WHERE id = ANY($1)`, [spotIds]);
  }
  await pool.query(`DELETE FROM comments WHERE user_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM likes    WHERE user_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM catches  WHERE user_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM users    WHERE id = ANY($1)`, [ids]);
  return ids.length;
}

// ── Regulations admin: seed/update a verified row + view the demand gap list ──
// Used to hand-seed GA/FL now, and later by the approval dashboard + bot.
app.post('/api/admin/regs', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const state = (b.state || b.stateCode || '').toUpperCase();
    const species = (b.species || '').toLowerCase();
    if (!state || !species) return res.status(400).json({ error: 'state and species required' });
    const region = b.region || '';
    await pool.query(
      `INSERT INTO regulations
         (state_code, species, region, min_size_in, max_size_in, bag_limit, season,
          gamefish, catch_release, notes, source_url, verified_date, review_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW())
       ON CONFLICT (state_code, species, region) DO UPDATE SET
         min_size_in=$4, max_size_in=$5, bag_limit=$6, season=$7, gamefish=$8,
         catch_release=$9, notes=$10, source_url=$11, verified_date=$12, review_by=$13, updated_at=NOW()`,
      [state, species, region,
       b.minSizeIn ?? null, b.maxSizeIn ?? null, b.bagLimit ?? null, b.season ?? null,
       !!b.gamefish, !!b.catchRelease, b.notes ?? null, b.sourceUrl ?? null,
       b.verifiedDate ?? null, b.reviewBy ?? null]
    );
    // Clear the gap now that we have data for it.
    await pool.query(`DELETE FROM reg_gaps WHERE state_code=$1 AND species=$2`, [state, species]).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/regs/gaps', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT state_code, species, hits, last_seen FROM reg_gaps
        WHERE dismissed IS NOT TRUE
        ORDER BY hits DESC, last_seen DESC LIMIT 300`
    );
    res.json({ gaps: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mark a gap as link-out only (dismissed=true) so it stops nagging, or restore it.
app.post('/api/admin/regs/gaps/dismiss', requireAdmin, async (req, res) => {
  try {
    const state = String(req.body?.state || '').toUpperCase();
    const species = String(req.body?.species || '').toLowerCase();
    const dismissed = req.body?.dismissed !== false;
    if (!state || !species) return res.status(400).json({ error: 'state and species required' });
    await pool.query(
      `INSERT INTO reg_gaps (state_code, species, dismissed) VALUES ($1,$2,$3)
       ON CONFLICT (state_code, species) DO UPDATE SET dismissed=$3`,
      [state, species, dismissed]
    );
    await logAdminAction(req.adminUser.id, dismissed ? 'gap_linkout_only' : 'gap_restore', 'reg', `${state}/${species}`).catch(() => {});
    res.json({ ok: true, dismissed });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4: risk-tiered, self-verifying regulations bot.
// Fetches each turned-on state's official page and hashes it. ONLY when the page
// changed does it call the model — and on a change day it extracts 3× and
// compares, so a single bad read can't slip through. What happens next depends
// on the change:
//   • no real change            → skip (no queue noise)
//   • 3 agree + routine change   → AUTO-PUBLISH live (tagged "pending review")
//                                  AND queue a confirm; deny reverts the value
//   • big/suspicious change      → HOLD for approval, nothing goes live
//   • the 3 reads disagree       → HOLD for approval, conflicting reads saved
// "Big" = a size/bag limit moves >40%, a value crosses to/from no-limit or
// prohibited, a season flips open↔closed, or it's a brand-new (never-verified)
// species. Auto-published rows carry review_by = +21d, so an unconfirmed reg
// auto-downgrades to the official link-out via the existing /api/regs stale path.
// Cost stays low: the model only fires on change-days, 3× only then.
// Runs once a day (dependency-free scheduler) + a manual /run trigger.
// ─────────────────────────────────────────────────────────────────────────────
const BOT_SPECIES = [
  // Southeast + Gulf
  'redfish', 'speckled_trout', 'flounder', 'sheepshead', 'black_drum',
  'snook', 'tripletail', 'pompano', 'spanish_mackerel', 'king_mackerel',
  'cobia', 'tarpon', 'gag_grouper', 'red_snapper', 'mangrove_snapper',
  // Mid-Atlantic + Northeast
  'striped_bass', 'black_sea_bass', 'tautog', 'bluefish', 'scup',
  'summer_flounder', 'weakfish',
  // Pacific + Alaska
  'lingcod', 'rockfish', 'california_halibut', 'pacific_halibut',
  'white_seabass', 'chinook_salmon', 'coho_salmon', 'cabezon', 'kelp_bass',
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}

async function extractRegsWithClaude(stateName, pageText) {
  const prompt =
`You are extracting RECREATIONAL saltwater fishing regulations from an official ${stateName} agency page.
Return ONLY a JSON array (no prose, no markdown). For each of these species that appears with a size or bag limit, add:
{"species": <one key below>, "minSizeIn": number|null, "maxSizeIn": number|null, "bagLimit": number|null, "season": string|null, "catchRelease": boolean, "gamefish": boolean, "notes": string|null, "sourceText": string|null, "zoneVaries": boolean, "zoneNote": string|null}
Species keys: ${BOT_SPECIES.join(', ')}.
Rules: sizes in inches (total length). Omit species not on the page. Do NOT guess. Return [] if nothing found.
zoneVaries: set TRUE if this state's limits for this species differ by region/zone/area/waterbody, or differ for shore vs. vessel anglers, or any part of the state is catch-and-release only. This is critical — a statewide number would be WRONG for some anglers. When zoneVaries is true, leave minSizeIn/maxSizeIn/bagLimit null and set zoneNote to a short plain description (e.g. "9 regions; Indian River Lagoon is catch-and-release only").
zones: when zoneVaries is true, ALSO return the per-zone table exactly as the page states it:
"zones": [{"name": string, "minSizeIn": number|null, "maxSizeIn": number|null, "bagLimit": number|null, "season": string|null, "catchRelease": boolean, "notes": string|null}]
Use the page's own zone names. Include every zone listed. If a zone is catch-and-release only, set catchRelease true and leave bagLimit null. Do NOT infer a zone that isn't printed, and do NOT merge zones. If the page names zones but doesn't give their numbers, return "zones": [].
Only give top-level numbers when they apply to the ENTIRE state for every angler.
seasonalRules: if this species' size or bag limits CHANGE BY DATE RANGE within the year (e.g. "January 1 - May 31: 16 inches; June 1 - December 31: 17.5 inches"), do NOT put a number in the top-level fields and NEVER report the limit as null/removed because of it. Instead return every dated rule:
"seasonalRules": [{"window": string with the dates exactly as the page gives them (e.g. "Jan 1 - May 31"), "minSizeIn": number|null, "maxSizeIn": number|null, "bagLimit": number|null, "catchRelease": boolean, "notes": string|null}]
Include every window printed on the page. If a value (e.g. the bag limit) is the same across all windows, repeat it inside each rule. Top-level minSizeIn/maxSizeIn/bagLimit are ONLY for a single value that applies the entire year. A limit is null ONLY if the page positively says there is no limit - a page listing different values for different dates always means seasonalRules, never null.
sourceText: copy the EXACT words from the page that state this species' limits — verbatim, no paraphrasing, no added words. Keep it short (the sentence or row for this species). If you can't point to explicit text, set it to null.

PAGE TEXT:
${pageText.slice(0, 60000)}`;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] }),
  });
  const data = await resp.json();
  const text = (data?.content || []).map(b => b.text || '').join('').trim();
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a === -1 || b === -1) return [];
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return []; }
}

// ── Risk-tiering + self-verification helpers ─────────────────────────────────
const regNum = (v) => (v == null || v === '' ? null : Number(v));

// Canonical signature of a seasonal-rules list. Order-insensitive; any change
// to a window's dates or enforceable values changes the signature. Works on
// both shapes (proposed camelCase and a stored row's rules, which are saved in
// the same camelCase shape).
function rulesSig(rules) {
  if (!Array.isArray(rules) || !rules.length) return '__NONE__';
  return JSON.stringify(
    rules.map(r => ({
      w: String(r.window || '').trim().toLowerCase().replace(/\s+/g, ' '),
      a: regNum(r.minSizeIn), b: regNum(r.maxSizeIn), c: regNum(r.bagLimit),
      r: !!r.catchRelease,
    })).sort((x, y) => x.w.localeCompare(y.w))
  );
}

// A "real change" ignores only free-text notes (noisy); every enforceable field
// counts. If this is true against the live row, we skip — no queue noise.
function regEqual(cur, p) {
  if (!cur) return false;
  return regNum(cur.min_size_in) === regNum(p.minSizeIn)
      && regNum(cur.max_size_in) === regNum(p.maxSizeIn)
      && regNum(cur.bag_limit)   === regNum(p.bagLimit)
      && (cur.season || null)    === (p.season || null)
      && !!cur.catch_release     === !!p.catchRelease
      && !!cur.gamefish          === !!p.gamefish
      && rulesSig(cur.rules)     === rulesSig(p.rules);
}

// Best-effort read of whether a free-text season means "closed / no harvest".
// Only used to detect an open↔closed FLIP; if both sides read the same we don't
// touch it. Conservative — unknown/blank counts as "not closed".
function seasonClosed(s) {
  if (!s) return false;
  return /\b(closed|closure|prohibit|no\s*harvest|no\s*take|harvest\s*prohibited|catch[-\s]*and[-\s]*release|release\s*only)\b/i.test(String(s));
}

// The "big change = hold" gate. Returns {verdict:'auto'|'hold', reason, detail}.
// Hold if: brand-new (never human-verified) species; a size/bag limit moves
// >40%; a value crosses to/from "no limit" (null↔value) or "prohibited"
// (bag↔0, or release-only flips); or a season flips open↔closed.
function classifyChange(cur, p) {
  if (!cur) return { verdict: 'hold', reason: 'new_species', detail: 'first-ever value for this species — needs a human check' };

  // Structure changes: flat ↔ seasonal, or the seasonal windows themselves
  // changing. Always held — these reshape what anglers see and the windows
  // need eyeballing against the source. NEVER auto-published.
  const curSeasonal = Array.isArray(cur.rules) && cur.rules.length > 0;
  const pSeasonal   = Array.isArray(p.rules) && p.rules.length > 0;
  if (!curSeasonal && pSeasonal) {
    return { verdict: 'hold', reason: 'went_seasonal', detail: 'the state now lists different limits by date — review each seasonal window against the source' };
  }
  if (curSeasonal && !pSeasonal) {
    return { verdict: 'hold', reason: 'went_flat', detail: 'the state replaced seasonal windows with a single year-round value — confirm the windows are really gone' };
  }
  if (curSeasonal && pSeasonal && rulesSig(cur.rules) !== rulesSig(p.rules)) {
    return { verdict: 'hold', reason: 'seasonal_change', detail: 'the seasonal windows or their limits changed — verify each window at the source' };
  }

  const reasons = [];
  const checks = [
    ['min_size_in', 'minSizeIn', 'min size'],
    ['max_size_in', 'maxSizeIn', 'max size'],
    ['bag_limit',   'bagLimit',  'daily limit'],
  ];
  for (const [ck, pk, label] of checks) {
    const o = regNum(cur[ck]);
    const n = regNum(p[pk]);
    if ((o == null) !== (n == null)) { reasons.push(`${label} ${o == null ? 'set (was no limit)' : 'removed (now no limit)'}`); continue; }
    if (o != null && n != null) {
      if ((o === 0) !== (n === 0)) { reasons.push(`${label} ${n === 0 ? '→ 0 (prohibited)' : 'off 0'}`); continue; }
      if (o > 0) { const pct = Math.abs(n - o) / o; if (pct > 0.40) reasons.push(`${label} ${o}→${n} (${Math.round(pct * 100)}%)`); }
    }
  }
  if (!!cur.catch_release !== !!p.catchRelease) reasons.push(p.catchRelease ? 'now release-only (no harvest)' : 'harvest now allowed');
  if (seasonClosed(cur.season) !== seasonClosed(p.season)) reasons.push(seasonClosed(p.season) ? 'season now closed' : 'season now open');
  if (reasons.length) return { verdict: 'hold', reason: 'big_change', detail: reasons.join('; ') };
  return { verdict: 'auto', reason: 'routine' };
}

// Canonical signature of one species' read, for comparing the 3 reads.
function readSig(e) {
  if (!e) return '__ABSENT__';
  return JSON.stringify({
    a: regNum(e.minSizeIn), b: regNum(e.maxSizeIn), c: regNum(e.bagLimit),
    d: (e.season || '').trim().toLowerCase().replace(/\s+/g, ' '),
    g: !!e.gamefish, r: !!e.catchRelease,
    s: rulesSig(e.seasonalRules),
  });
}

// Given the 3 whole-page reads, pull this species out of each and decide whether
// they agree. onPage = it showed up in at least one read. agree = it showed up
// in all three with identical enforceable values.
function speciesConsensus(reads, species) {
  const perRead = reads.map(arr =>
    (Array.isArray(arr) ? arr : []).find(e => String(e.species || '').toLowerCase().trim() === species) || null
  );
  const onPage = perRead.some(Boolean);
  // "Real data" = an enforceable value, not just the name appearing. A bare
  // mention (all nulls, or "varies by region") shouldn't become a proposal —
  // that's what produced blank conflict cards.
  const hasData = perRead.some((e) => e && (
    regNum(e.minSizeIn) != null || regNum(e.maxSizeIn) != null || regNum(e.bagLimit) != null ||
    e.catchRelease === true || (e.season != null && String(e.season).trim() !== '') ||
    (Array.isArray(e.seasonalRules) && e.seasonalRules.length > 0)
  ));
  const sigs = perRead.map(readSig);
  const agree = onPage && new Set(sigs).size === 1 && sigs[0] !== '__ABSENT__';
  return { onPage, hasData, agree, value: agree ? perRead.find(Boolean) : null, perRead };
}

// State sites print the official/common name, not our internal key — so search
// for the names anglers and agencies actually use. First alias that hits the
// page wins, and we hand back the matched term so the "verify" jump-link can
// highlight it too. Conservative on ambiguous single words (e.g. no bare "gag"
// or "ling") to avoid landing on the wrong section.
const SPECIES_ALIASES = {
  redfish:          ['red drum', 'redfish'],
  speckled_trout:   ['spotted seatrout', 'spotted sea trout', 'speckled trout', 'seatrout', 'sea trout'],
  flounder:         ['southern flounder', 'gulf flounder', 'summer flounder', 'flounder'],
  sheepshead:       ['sheepshead'],
  black_drum:       ['black drum'],
  snook:            ['common snook', 'snook'],
  tripletail:       ['tripletail', 'triple tail'],
  pompano:          ['florida pompano', 'pompano'],
  spanish_mackerel: ['spanish mackerel'],
  king_mackerel:    ['king mackerel'],
  cobia:            ['cobia'],
  tarpon:           ['tarpon'],
  gag_grouper:      ['gag grouper'],
  red_snapper:      ['red snapper'],
  mangrove_snapper: ['mangrove snapper', 'gray snapper', 'grey snapper'],

  // Mid-Atlantic + Northeast.
  // NOTE: Atlantic states often call STRIPED BASS "rockfish" (esp. MD/VA), while
  // our 'rockfish' key is the PACIFIC species. So striped_bass does NOT claim the
  // bare word "rockfish", and pacific 'rockfish' only matches Pacific-specific
  // names — otherwise a Maryland page would map striped bass onto a Pacific fish.
  striped_bass:     ['striped bass', 'striper'],
  black_sea_bass:   ['black sea bass'],
  tautog:           ['tautog', 'blackfish'],
  bluefish:         ['bluefish'],
  scup:             ['scup', 'porgy'],
  summer_flounder:  ['summer flounder', 'fluke'],
  weakfish:         ['weakfish', 'squeteague'],

  // Pacific + Alaska
  lingcod:            ['lingcod'],
  rockfish:           ['rockfish complex', 'pacific rockfish', 'rock cod', 'groundfish rockfish'],
  california_halibut: ['california halibut'],
  pacific_halibut:    ['pacific halibut'],
  white_seabass:      ['white seabass', 'white sea bass'],
  chinook_salmon:     ['chinook salmon', 'king salmon', 'chinook'],
  coho_salmon:        ['coho salmon', 'silver salmon', 'coho'],
  cabezon:            ['cabezon'],
  kelp_bass:          ['kelp bass', 'calico bass'],
};

// Canonical signature of a whole zone table, so the 3 reads can be compared.
// Zone order doesn't matter; names are normalized. Any difference in a zone's
// enforceable values makes the reads disagree.
function zonesSig(zones) {
  if (!Array.isArray(zones) || !zones.length) return '__NONE__';
  return JSON.stringify(
    zones
      .map((z) => ({
        n: String(z.name || '').trim().toLowerCase().replace(/\s+/g, ' '),
        a: regNum(z.minSizeIn), b: regNum(z.maxSizeIn), c: regNum(z.bagLimit),
        s: (z.season || '').trim().toLowerCase().replace(/\s+/g, ' '),
        r: !!z.catchRelease,
      }))
      .sort((x, y) => x.n.localeCompare(y.n))
  );
}

// Zones are only trusted when every read that saw this species produced the same
// table. Otherwise we keep the note and drop the numbers.
function zonesConsensus(perRead) {
  const present = perRead.filter(Boolean);
  if (!present.length) return null;
  const sigs = present.map((e) => zonesSig(e.zones));
  if (new Set(sigs).size !== 1 || sigs[0] === '__NONE__') return null;
  const zones = present[0].zones;
  // Sanity: a zone with no name is unusable; a zone with neither numbers nor a
  // release flag tells the angler nothing. Drop the table rather than show junk.
  const usable = zones.every((z) => String(z.name || '').trim() &&
    (regNum(z.minSizeIn) != null || regNum(z.maxSizeIn) != null || regNum(z.bagLimit) != null || z.catchRelease === true));
  return usable ? zones : null;
}

function excerptFor(pageText, species) {
  const lower = pageText.toLowerCase();
  const aliases = SPECIES_ALIASES[species] || [species.replace(/_/g, ' ')];
  let at = -1;
  let term = aliases[0];
  for (const a of aliases) {
    const i = lower.indexOf(a);
    if (i !== -1) { at = i; term = a; break; }
  }
  if (at === -1) {
    // The species name isn't on the page at all. Don't hand back the page's
    // opening boilerplate — it reads like the site said that about this fish.
    return { excerpt: `(“${aliases[0]}” doesn’t appear on this page — it may be managed under a group/complex, or listed under another name.)`, term: aliases[0], matched: false };
  }
  // End the clip where the NEXT tracked species starts, so it's this fish's
  // section and not a fixed blob that bleeds into the next one. Small lead in
  // front catches values printed just before the name (table-row layouts).
  const LEAD = 40, MAX = 500;
  const from = Math.max(0, at - LEAD);
  let end = Math.min(pageText.length, at + MAX);
  const after = at + term.length;
  for (const sp of BOT_SPECIES) {
    if (sp === species) continue;
    const others = SPECIES_ALIASES[sp] || [sp.replace(/_/g, ' ')];
    for (const a of others) {
      const j = lower.indexOf(a, after);
      if (j !== -1 && j < end) end = j;
    }
  }
  const clip = pageText.slice(from, end).trim();
  const excerpt = (from > 0 ? '…' : '') + clip + (end < pageText.length ? '…' : '');
  return { excerpt, term, matched: true };
}

// Only trust the model's verbatim quote if it actually appears on the page
// (whitespace/case-insensitive). Guards against a paraphrased or invented quote
// being shown as "what the site says".
function verifiedQuote(sourceText, pageText) {
  if (!sourceText || typeof sourceText !== 'string') return null;
  const q = sourceText.trim();
  if (q.length < 8) return null;
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
  return norm(pageText).includes(norm(q)) ? q : null;
}

// Fetch a source's page(s) and return the merged, stripped text + its hash.
// A source can list several pages (a state that splits limits by species family);
// we fetch them all, tolerate individual failures, and merge.
async function fetchSourceText(src) {
  const urls = Array.isArray(src.scrape) && src.scrape.length ? src.scrape : [src.url];
  const results = await Promise.allSettled(
    urls.map((u) => fetch(u, { headers: { 'user-agent': 'BoneTideRegsBot/1.0' } }).then((r) => r.text()))
  );
  const htmls = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  if (!htmls.length) throw new Error('all sources failed to fetch');
  const pageText = htmls.map(stripHtml).join('\n\n----\n\n');
  return { pageText, hash: crypto.createHash('sha256').update(pageText).digest('hex') };
}

// A source's fingerprint is tied to the URL it came from. When a source URL is
// corrected, its old hash would make the bot think "no change" and skip it — so
// stale rows for retired/changed sources are cleared here on boot. Bump the
// version string to force a clean re-scan of the listed states.
const REG_SOURCE_RESET = 'v3-2026-07-fl-de-nj-ma';
pool.query(
  `DELETE FROM reg_source_checks WHERE state_code = ANY($1::text[])`,
  [['FL', 'DE', 'NJ', 'MA', 'WA', 'AK', 'HI']]
).then(() => console.log('[init] cleared stale reg source fingerprints (' + REG_SOURCE_RESET + ')'))
 .catch(e => console.error('[init] reg source reset:', e.message));

async function runRegsBotForState(stateCode, force = false, onlySpecies = null) {
  const src = STATE_REG_SOURCES[stateCode];
  if (!src) return { state: stateCode, skipped: 'no source' };
  try {
    const { pageText, hash } = await fetchSourceText(src);

    if (!pageText || pageText.length < 200) return { state: stateCode, changed: true, note: 'page empty/JS-rendered — skipped' };

    if (!onlySpecies) {
      const prev = (await pool.query(`SELECT last_hash FROM reg_source_checks WHERE state_code=$1`, [stateCode])).rows[0];
      const changed = !prev || prev.last_hash !== hash;
      // A successful fetch clears the failure counter (changed OR unchanged).
      await pool.query(
        `INSERT INTO reg_source_checks (state_code, last_hash, last_checked, last_status, fail_count)
         VALUES ($1,$2,NOW(),$3,0)
         ON CONFLICT (state_code) DO UPDATE SET last_hash=$2, last_checked=NOW(), last_status=$3, fail_count=0`,
        [stateCode, hash, changed ? 'changed' : 'unchanged']
      );
      // force = re-scan even if the page hasn't changed (e.g. to apply a bot fix
      // to sources whose fingerprint is already on file).
      if (!changed && !force) return { state: stateCode, changed: false };
    }

    // Change day → extract 3× and compare. This is the only place the model fires.
    const reads = [];
    for (let i = 0; i < 3; i++) reads.push(await extractRegsWithClaude(src.name, pageText));

    let autoPublished = 0, held = 0, conflicts = 0, skipped = 0, foundCount = 0, cleared = 0, zoned = 0;

    for (const species of (onlySpecies ? [onlySpecies] : BOT_SPECIES)) {
      const { onPage, hasData, agree, value, perRead } = speciesConsensus(reads, species);

      // ── ZONE GUARD ───────────────────────────────────────────────────────
      // If any read says this species is managed by zone/region (or shore-vs-
      // vessel), a single statewide row would be wrong for some anglers. Record
      // the flag, make sure no stale statewide row keeps serving, and move on —
      // never publish, never queue. The angler gets "zone-managed, verify here".
      const zoneRead = perRead.find((e) => e && e.zoneVaries);
      if (zoneRead) {
        // Zones only stored when all reads that saw this species agree on the
        // whole table; otherwise null → angler gets the note + link, no numbers.
        const zones = zonesConsensus(perRead);
        await pool.query(
          `INSERT INTO reg_zone_flags (state_code, species, zone_note, source_url, zones, verified_on, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,NOW())
           ON CONFLICT (state_code, species) DO UPDATE SET
             zone_note=$3, source_url=$4, zones=$5, verified_on=$6, updated_at=NOW()`,
          [stateCode, species, zoneRead.zoneNote || 'Limits differ by region or zone.', src.url,
           zones ? JSON.stringify(zones) : null, zones ? new Date() : null]
        ).catch(() => {});
        // Retire any statewide row/draft we may have published before we knew.
        await pool.query(
          `DELETE FROM regulations WHERE state_code=$1 AND species=$2 AND region=''`,
          [stateCode, species]
        ).catch(() => {});
        await pool.query(
          `DELETE FROM reg_proposals WHERE state_code=$1 AND species=$2 AND status='pending'`,
          [stateCode, species]
        ).catch(() => {});
        zoned++;
        continue;
      }
      // Species is NOT zone-managed (any more) — clear a stale flag.
      await pool.query(`DELETE FROM reg_zone_flags WHERE state_code=$1 AND species=$2`, [stateCode, species]).catch(() => {});

      // Not on the page, or on it with no enforceable numbers (e.g. NC lists
      // mangrove snapper under "Snapper/Grouper Complex" with no limits). Don't
      // just skip: clear any stale HELD draft we created for it in an earlier
      // scan, or it sits in the review queue forever with nothing to approve.
      // Auto-published drafts are left alone — deleting one would orphan a live row.
      if (!onPage || !hasData) {
        const del = await pool.query(
          `DELETE FROM reg_proposals
            WHERE state_code=$1 AND species=$2 AND status='pending' AND auto_published IS NOT TRUE`,
          [stateCode, species]
        ).catch(() => ({ rowCount: 0 }));
        if (del.rowCount) cleared += del.rowCount;
        continue;
      }
      foundCount++;

      const cur = (await pool.query(
        `SELECT min_size_in, max_size_in, bag_limit, season, gamefish, catch_release, notes, rules,
                verified_date, review_by, source_url
         FROM regulations WHERE state_code=$1 AND species=$2 AND region='' LIMIT 1`,
        [stateCode, species]
      )).rows[0] || null;
      // Prefer the model's verbatim quote (verified to be on the page); fall
      // back to the proximity clip if it can't be confirmed.
      const { excerpt: clipExcerpt, term } = excerptFor(pageText, species);
      const chosenRead = agree ? value : (perRead.find(Boolean) || null);
      const excerpt = (chosenRead && verifiedQuote(chosenRead.sourceText, pageText)) || clipExcerpt;
      const verifyUrl = src.url + '#:~:text=' + encodeURIComponent(term);

      // ── The 3 reads disagree → HOLD, and stash all three so you can eyeball them.
      if (!agree) {
        const best = perRead.find(Boolean) || {};
        const proposed = {
          minSizeIn: best.minSizeIn ?? null, maxSizeIn: best.maxSizeIn ?? null, bagLimit: best.bagLimit ?? null,
          season: best.season ?? null, gamefish: !!best.gamefish, catchRelease: !!best.catchRelease, notes: best.notes ?? null,
          rules: (Array.isArray(best.seasonalRules) && best.seasonalRules.length) ? best.seasonalRules : null,
        };
        await pool.query(`DELETE FROM reg_proposals WHERE state_code=$1 AND species=$2 AND status='pending'`, [stateCode, species]);
        await pool.query(
          `INSERT INTO reg_proposals
             (state_code, species, region, proposed, current, source_url, source_excerpt, status, auto_published, confidence, hold_reason, reads)
           VALUES ($1,$2,'',$3,$4,$5,$6,'pending',false,'conflict','conflict',$7)`,
          [stateCode, species, JSON.stringify(proposed), cur ? JSON.stringify(cur) : null, verifyUrl, excerpt, JSON.stringify(perRead)]
        );
        // We're keeping the last-known value live but the source looks different —
        // flag the live row so the angler-facing screens warn "verify at source".
        if (cur) await pool.query(`UPDATE regulations SET discrepancy_at=NOW(), discrepancy_url=$3 WHERE state_code=$1 AND species=$2 AND region=''`, [stateCode, species, verifyUrl]).catch(() => {});
        conflicts++; held++;
        continue;
      }

      // ── 3 agree. Build the proposed row from the consensus read.
      const proposed = {
        minSizeIn: value.minSizeIn ?? null, maxSizeIn: value.maxSizeIn ?? null, bagLimit: value.bagLimit ?? null,
        season: value.season ?? null, gamefish: !!value.gamefish, catchRelease: !!value.catchRelease, notes: value.notes ?? null,
        rules: (Array.isArray(value.seasonalRules) && value.seasonalRules.length) ? value.seasonalRules : null,
      };
      if (regEqual(cur, proposed)) { skipped++; continue; } // no real change → no noise

      const verdict = classifyChange(cur, proposed);
      await pool.query(`DELETE FROM reg_proposals WHERE state_code=$1 AND species=$2 AND status='pending'`, [stateCode, species]);

      if (verdict.verdict === 'auto') {
        // Routine change → go live now, tagged pending, on a 21-day confirm clock.
        // proposal.current holds the pre-change snapshot so "deny" can revert.
        await pool.query(
          `INSERT INTO regulations
             (state_code, species, region, min_size_in, max_size_in, bag_limit, season, gamefish, catch_release, notes,
              source_url, verified_date, review_by, pending_review, auto_published_at, updated_at)
           VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_DATE,(CURRENT_DATE + INTERVAL '21 days'),true,NOW(),NOW())
           ON CONFLICT (state_code, species, region) DO UPDATE SET
             min_size_in=$3, max_size_in=$4, bag_limit=$5, season=$6, gamefish=$7, catch_release=$8, notes=$9,
             source_url=$10, verified_date=CURRENT_DATE, review_by=(CURRENT_DATE + INTERVAL '21 days'),
             pending_review=true, auto_published_at=NOW(), discrepancy_at=NULL, discrepancy_url=NULL, updated_at=NOW()`,
          [stateCode, species, proposed.minSizeIn, proposed.maxSizeIn, proposed.bagLimit, proposed.season,
           proposed.gamefish, proposed.catchRelease, proposed.notes, verifyUrl]
        );
        await pool.query(
          `INSERT INTO reg_proposals
             (state_code, species, region, proposed, current, source_url, source_excerpt, status, auto_published, confidence, hold_reason, reads)
           VALUES ($1,$2,'',$3,$4,$5,$6,'pending',true,'high',null,null)`,
          [stateCode, species, JSON.stringify(proposed), cur ? JSON.stringify(cur) : null, verifyUrl, excerpt]
        );
        await pool.query(`DELETE FROM reg_gaps WHERE state_code=$1 AND species=$2`, [stateCode, species]).catch(() => {});
        autoPublished++;
      } else {
        // Big/suspicious, structure change, or brand-new → HOLD. Nothing goes live.
        const holdReason = verdict.reason === 'new_species'
          ? 'new_species'
          : `${verdict.reason}: ${verdict.detail || ''}`;
        await pool.query(
          `INSERT INTO reg_proposals
             (state_code, species, region, proposed, current, source_url, source_excerpt, status, auto_published, confidence, hold_reason, reads)
           VALUES ($1,$2,'',$3,$4,$5,$6,'pending',false,'high',$7,null)`,
          [stateCode, species, JSON.stringify(proposed), cur ? JSON.stringify(cur) : null, verifyUrl, excerpt, holdReason]
        );
        // Existing live value stays, but flag it so anglers are warned to verify.
        if (cur) await pool.query(`UPDATE regulations SET discrepancy_at=NOW(), discrepancy_url=$3 WHERE state_code=$1 AND species=$2 AND region=''`, [stateCode, species, verifyUrl]).catch(() => {});
        held++;
      }
    }

    if (!onlySpecies) {
      // Coverage-collapse guard: if a source we're actively serving data for
      // suddenly yields NO species (page still loads, but the limits moved or
      // vanished — the signature of a site overhaul), don't pass silently. We
      // never touched the live rows on an empty read, so nothing's corrupted —
      // this just raises the alarm so the URL can be fixed before data goes stale.
      const liveCount = Number((await pool.query(
        `SELECT COUNT(*) AS c FROM regulations
          WHERE state_code=$1 AND region='' AND (review_by IS NULL OR review_by >= CURRENT_DATE)`,
        [stateCode]
      )).rows[0].c);
      // Only alarm if this source USED to yield species and now yields none. A
      // state whose page legitimately contains none of our tracked fish (or a
      // brand-new source) must not trip the redesign alarm.
      const prevFound = Number((await pool.query(`SELECT COALESCE(species_found, -1) AS f FROM reg_source_checks WHERE state_code=$1`, [stateCode])).rows[0]?.f ?? -1);
      const dataMissing = foundCount === 0 && liveCount >= 3 && prevFound > 0;
      await pool.query(
        `UPDATE reg_source_checks SET species_found=$2, last_status=$3 WHERE state_code=$1`,
        [stateCode, foundCount, dataMissing ? 'data_missing' : 'scanned']
      );
      if (dataMissing) {
        // Source looks redesigned — flag every live reg for this state so anglers
        // are warned to verify while we sort out the new source.
        await pool.query(
          `UPDATE regulations SET discrepancy_at=NOW(), discrepancy_url=$2
            WHERE state_code=$1 AND region='' AND (review_by IS NULL OR review_by >= CURRENT_DATE)`,
          [stateCode, src.url]
        ).catch(() => {});
        console.warn(`[regsbot] ${stateCode}: page changed but 0/${liveCount} species found — possible site overhaul`);
      }
      return { state: stateCode, changed: true, autoPublished, held, conflicts, skipped, cleared, zoned, foundCount, dataMissing };
    }

    // Single-species re-scan result (no source-health side effects).
    return { state: stateCode, species: onlySpecies, autoPublished, held, conflicts, skipped, cleared, zoned, found: foundCount > 0 };
  } catch (err) {
    console.error(`[regsbot] ${stateCode}${onlySpecies ? '/' + onlySpecies : ''}:`, err.message);
    if (!onlySpecies) {
      await pool.query(
        `UPDATE reg_source_checks SET last_status='error', last_checked=NOW(), fail_count=COALESCE(fail_count,0)+1 WHERE state_code=$1`,
        [stateCode]
      ).catch(() => {});
    }
    return { state: stateCode, error: err.message };
  }
}

// ── Push send helpers (Expo Push API) ───────────────────────────────────────
// Server → device via Expo's HTTP push service. Batches of 100, and prunes any
// token Expo reports as dead so the table doesn't rot.
async function sendPush(messages) {
  const list = (messages || []).filter((m) => m && m.to);
  if (!list.length) return;
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(chunk),
      });
      const json = await res.json().catch(() => null);
      const receipts = json && Array.isArray(json.data) ? json.data : [];
      receipts.forEach((r, idx) => {
        if (r && r.status === 'error' && r.details && r.details.error === 'DeviceNotRegistered') {
          const dead = chunk[idx] && chunk[idx].to;
          if (dead) pool.query(`DELETE FROM push_tokens WHERE token=$1`, [dead]).catch(() => {});
        }
      });
    } catch (e) { console.error('[push] send error:', e.message); }
  }
}

async function notifyAdmins(title, body, data = {}) {
  try {
    const { rows } = await pool.query(`SELECT token FROM push_tokens WHERE is_admin = true`);
    if (!rows.length) return;
    await sendPush(rows.map((r) => ({ to: r.token, title, body, data, sound: 'default', priority: 'high' })));
  } catch (e) { console.error('[push] notifyAdmins:', e.message); }
}

async function runRegsBot(force = false) {
  const out = [];
  for (const st of Object.keys(STATE_REG_SOURCES)) out.push(await runRegsBotForState(st, force));
  console.log('[regsbot] run complete' + (force ? ' (forced)' : '') + ':', JSON.stringify(out));

  // Tell admins if anything needs eyes — nothing noteworthy = no notification.
  const t = out.reduce((a, s) => ({
    held:     a.held     + (s.held || 0),
    auto:     a.auto     + (s.autoPublished || 0),
    redesign: a.redesign + (s.dataMissing ? 1 : 0),
    errors:   a.errors   + (s.error ? 1 : 0),
  }), { held: 0, auto: 0, redesign: 0, errors: 0 });
  const bits = [];
  if (t.redesign) bits.push(`${t.redesign} source${t.redesign > 1 ? 's' : ''} may be redesigned`);
  if (t.held)     bits.push(`${t.held} held for review`);
  if (t.auto)     bits.push(`${t.auto} auto-published`);
  if (t.errors)   bits.push(`${t.errors} unreadable`);
  if (bits.length) {
    await notifyAdmins(
      t.redesign ? '⚠ Regs need attention' : '🎣 Regs updated',
      bits.join(' · '),
      { type: 'regs_run', screen: 'RegsAdmin' }
    );
  }
  return out;
}

// Dependency-free scheduler: check hourly, run once per day around 8am server time.
let _lastBotRunDay = null;
setInterval(() => {
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  if (now.getHours() === 8 && _lastBotRunDay !== day) {
    _lastBotRunDay = day;
    runRegsBot().catch(e => console.error('[regsbot] scheduled run failed:', e.message));
  }
}, 60 * 60 * 1000);

app.get('/api/admin/regs/proposals', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM reg_proposals WHERE status='pending' ORDER BY created_at DESC LIMIT 200`);
    res.json({ proposals: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve = "this is good, make it human-verified." Handles BOTH cases:
//   • an auto-published-pending row → CONFIRM it (clears the pending tag, resets
//     the trust clock to 90 days). Any edits in req.body override the values.
//   • a held draft → PUBLISH it live for the first time.
// Either way the row ends up pending_review=false on the 90-day human clock.
app.post('/api/admin/regs/proposals/:id/approve', requireAdmin, async (req, res) => {
  try {
    const p = (await pool.query(`SELECT * FROM reg_proposals WHERE id=$1`, [req.params.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'not found' });
    const o = { ...p.proposed, ...(req.body || {}) }; // admin edits on approve override the draft
    const src = STATE_REG_SOURCES[p.state_code];
    await pool.query(
      `INSERT INTO regulations
         (state_code, species, region, min_size_in, max_size_in, bag_limit, season, gamefish, catch_release, notes, rules,
          source_url, verified_date, review_by, pending_review, auto_published_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE,(CURRENT_DATE + INTERVAL '90 days'),false,NULL,NOW())
       ON CONFLICT (state_code, species, region) DO UPDATE SET
         min_size_in=$4, max_size_in=$5, bag_limit=$6, season=$7, gamefish=$8, catch_release=$9,
         notes=$10, rules=$11, source_url=$12, verified_date=CURRENT_DATE, review_by=(CURRENT_DATE + INTERVAL '90 days'),
         pending_review=false, auto_published_at=NULL, discrepancy_at=NULL, discrepancy_url=NULL, updated_at=NOW()`,
      [p.state_code, p.species, p.region, o.minSizeIn ?? null, o.maxSizeIn ?? null, o.bagLimit ?? null,
       o.season ?? null, !!o.gamefish, !!o.catchRelease, o.notes ?? null,
       (Array.isArray(o.rules) && o.rules.length) ? JSON.stringify(o.rules) : null,
       p.source_url || src?.url || null]
    );
    await pool.query(`UPDATE reg_proposals SET status='approved', resolved_at=NOW() WHERE id=$1`, [p.id]);
    await pool.query(`DELETE FROM reg_gaps WHERE state_code=$1 AND species=$2`, [p.state_code, p.species]).catch(() => {});
    await logAdminAction(req.adminUser.id, p.auto_published ? 'confirm_reg' : 'approve_reg', 'reg_proposal', p.id, `${p.state_code}/${p.species}`).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reject = "no." For a held draft, that's all it is (nothing was ever live). For
// an auto-published-pending row this is a DENY → revert: restore the live row to
// the pre-change snapshot we saved in proposal.current (or delete it if there was
// no prior row), and clear the pending tag.
app.post('/api/admin/regs/proposals/:id/reject', requireAdmin, async (req, res) => {
  try {
    const p = (await pool.query(`SELECT * FROM reg_proposals WHERE id=$1`, [req.params.id])).rows[0];
    if (!p) return res.status(404).json({ error: 'not found' });
    if (p.auto_published) {
      const c = p.current;
      if (c) {
        await pool.query(
          `UPDATE regulations SET
             min_size_in=$1, max_size_in=$2, bag_limit=$3, season=$4, gamefish=$5, catch_release=$6, notes=$7, rules=$8,
             source_url=$9, verified_date=$10, review_by=$11, pending_review=false, auto_published_at=NULL, updated_at=NOW()
           WHERE state_code=$12 AND species=$13 AND region=$14`,
          [c.min_size_in ?? null, c.max_size_in ?? null, c.bag_limit ?? null, c.season ?? null,
           !!c.gamefish, !!c.catch_release, c.notes ?? null,
           (Array.isArray(c.rules) && c.rules.length) ? JSON.stringify(c.rules) : null,
           c.source_url ?? null, c.verified_date ?? null, c.review_by ?? null, p.state_code, p.species, p.region || '']
        );
      } else {
        // No prior row existed → auto-publish created it → revert = remove it.
        await pool.query(`DELETE FROM regulations WHERE state_code=$1 AND species=$2 AND region=$3`, [p.state_code, p.species, p.region || '']);
      }
    }
    await pool.query(`UPDATE reg_proposals SET status='rejected', resolved_at=NOW() WHERE id=$1`, [p.id]);
    // Human reviewed and the standing value holds → clear any angler-facing warning.
    await pool.query(`UPDATE regulations SET discrepancy_at=NULL, discrepancy_url=NULL WHERE state_code=$1 AND species=$2 AND region=$3`, [p.state_code, p.species, p.region || '']).catch(() => {});
    await logAdminAction(req.adminUser.id, p.auto_published ? 'deny_reg_revert' : 'reject_reg', 'reg_proposal', p.id, `${p.state_code}/${p.species}`).catch(() => {});
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Per-source health for the admin banner: last check + consecutive failure count.
app.get('/api/admin/regs/status', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT state_code, last_checked, last_status, COALESCE(fail_count,0) AS fail_count, species_found
       FROM reg_source_checks ORDER BY state_code`
    );
    res.json({ sources: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/regs/run', requireAdmin, async (req, res) => {
  try { res.json({ ran: await runRegsBot(!!(req.body && req.body.force)) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Re-scan a single species for one state on demand — re-fetches the source,
// re-reads 3×, and rebuilds just that species' proposal. Doesn't touch the
// source's fingerprint or health, so it's a safe targeted retry.
app.post('/api/admin/regs/rescan-species', requireAdmin, async (req, res) => {
  try {
    const state = String((req.body && req.body.state) || '').toUpperCase();
    const species = String((req.body && req.body.species) || '').toLowerCase();
    if (!state || !species) return res.status(400).json({ error: 'state and species required' });
    if (!STATE_REG_SOURCES[state]) return res.status(400).json({ error: 'no source configured for ' + state });
    const result = await runRegsBotForState(state, true, species);
    await logAdminAction(req.adminUser.id, 'rescan_species', 'reg', `${state}/${species}`).catch(() => {});
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/demo/seed', requireAdmin, async (req, res) => {
  try {
    await teardownDemoData(); // reset first so re-seeding is idempotent

    const created = [];
    for (let i = 0; i < DEMO_ANGLERS.length; i++) {
      const a = DEMO_ANGLERS[i];
      const { rows: [u] } = await pool.query(
        `INSERT INTO users (device_id, email, name, avatar, is_demo, public_profile, share_with_community, anonymize_shared, is_club, club_badge, points_balance, created_at)
         VALUES ($1,$2,$3,$4,true,true,true,false,$5,$6,$7,NOW())
         RETURNING id, name`,
        [`demo-device-${i}`, `demo${i}@bonetide.test`, a.name, a.avatar, a.isClub, a.badge, 500 + i * 150]
      );
      created.push({ id: u.id, name: u.name });
    }

    const allCatches = [];
    for (let ui = 0; ui < created.length; ui++) {
      const uid = created[ui].id;
      for (let c = 0; c < 5; c++) {
        const species  = DEMO_SPECIES[(ui * 5 + c) % DEMO_SPECIES.length];
        const daysAgo  = (c * 9) + ui * 3 + 1;
        const caughtAt = new Date(Date.now() - daysAgo * 86400000);
        const len      = 14 + ((ui * 7 + c * 3) % 26);
        const lat      = 29.02 + Math.sin(ui + c) * 0.05;
        const lon      = -80.92 + Math.cos(ui + c) * 0.05;
        const img      = `https://picsum.photos/seed/btc-${uid}-${c}/800/600`;
        const { rows: [nc] } = await pool.query(
          `INSERT INTO catches (user_id, species, length_in, released, lat, lon, pts_awarded, image_url, is_public, caught_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9) RETURNING id`,
          [uid, species, len, c % 2 === 0, lat, lon, 25, img, caughtAt]
        );
        allCatches.push({ id: nc.id, owner: uid });
      }
    }

    // Each catch gets a comment (and sometimes a like) from a different demo angler.
    for (let ci = 0; ci < allCatches.length; ci++) {
      const cat = allCatches[ci];
      const ownerIdx = created.findIndex(x => x.id === cat.owner);
      const commenter = created[(ownerIdx + 1) % created.length];
      if (commenter.id === cat.owner) continue;
      await pool.query(
        `INSERT INTO comments (user_id, target_type, target_id, body, created_at) VALUES ($1,'catch',$2,$3,NOW())`,
        [commenter.id, cat.id, DEMO_COMMENTS[ci % DEMO_COMMENTS.length]]
      );
      if (ci % 2 === 0) {
        await pool.query(
          `INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES ($1,'catch',$2,NOW())
           ON CONFLICT (user_id,target_type,target_id) DO NOTHING`,
          [commenter.id, cat.id]
        );
      }
    }

    // Community spots (is_private=false) with extra photos.
    const allSpots = [];
    for (let ui = 0; ui < created.length; ui++) {
      const uid = created[ui].id;
      const nSpots = ui === created.length - 1 ? 1 : 2; // 2 + 2 + 1 = 5 spots
      for (let sIdx = 0; sIdx < nSpots; sIdx++) {
        const d   = DEMO_SPOTS[(ui * 2 + sIdx) % DEMO_SPOTS.length];
        const lat = 29.05 + Math.sin(ui * 2 + sIdx) * 0.06;
        const lon = -80.95 + Math.cos(ui * 2 + sIdx) * 0.06;
        const { rows: [ns] } = await pool.query(
          `INSERT INTO spots (user_id,name,type,note,lat,lon,photo_url,is_private,created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false,NOW()) RETURNING id`,
          [uid, d.name, d.type, d.note, lat, lon, `https://picsum.photos/seed/btc-spot-${uid}-${sIdx}/800/600`]
        );
        allSpots.push({ id: ns.id, owner: uid });
        // 1–2 extra photos per spot
        for (let p = 0; p <= (sIdx % 2); p++) {
          await pool.query(
            `INSERT INTO spot_photos (spot_id, user_id, photo_url, created_at) VALUES ($1,$2,$3,NOW())`,
            [ns.id, uid, `https://picsum.photos/seed/btc-spotphoto-${ns.id}-${p}/800/600`]
          );
        }
      }
    }

    // A comment + like on each spot from a different demo angler.
    for (let si = 0; si < allSpots.length; si++) {
      const sp = allSpots[si];
      const ownerIdx = created.findIndex(x => x.id === sp.owner);
      const commenter = created[(ownerIdx + 1) % created.length];
      if (commenter.id === sp.owner) continue;
      await pool.query(
        `INSERT INTO comments (user_id, target_type, target_id, body, created_at) VALUES ($1,'spot',$2,$3,NOW())`,
        [commenter.id, sp.id, DEMO_SPOT_COMMENTS[si % DEMO_SPOT_COMMENTS.length]]
      );
      await pool.query(
        `INSERT INTO likes (user_id, target_type, target_id, created_at) VALUES ($1,'spot',$2,NOW())
         ON CONFLICT (user_id,target_type,target_id) DO NOTHING`,
        [commenter.id, sp.id]
      );
    }

    res.json({ ok: true, anglers: created, catches: allCatches.length, spots: allSpots.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/demo/seed', requireAdmin, async (req, res) => {
  try {
    const removed = await teardownDemoData();
    res.json({ ok: true, removedUsers: removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/demo/anglers', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT id, name FROM users WHERE is_demo = true ORDER BY id`);
    res.json({ anglers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ─────────────────────── END DEV DEMO DATA ──────────────────────────────────

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
  try { await pool.query(`DELETE FROM catches WHERE id=$1`, [req.params.id]); await logAdminAction(req.adminUser.id, 'delete_catch', 'catch', req.params.id); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/spots/:id', requireAdmin, async (req, res) => {
  try { await pool.query(`DELETE FROM spots WHERE id=$1`, [req.params.id]); await logAdminAction(req.adminUser.id, 'delete_spot', 'spot', req.params.id); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/comments/:id', requireAdmin, async (req, res) => {
  try { await pool.query(`DELETE FROM comments WHERE id=$1`, [req.params.id]); await logAdminAction(req.adminUser.id, 'delete_comment', 'comment', req.params.id); res.json({ deleted: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete('/api/admin/photos/:id', requireAdmin, async (req, res) => {
  try { await pool.query(`DELETE FROM spot_photos WHERE id=$1`, [req.params.id]); await logAdminAction(req.adminUser.id, 'delete_photo', 'photo', req.params.id); res.json({ deleted: true }); }
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
    await logAdminAction(req.adminUser.id, 'resolve_appeal', 'appeal', req.params.id, decision);
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
    await logAdminAction(req.adminUser.id, banned ? 'ban_user' : 'unban_user', 'user', req.params.id);
    res.json({ user: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Shadowban: limit a user's posting for N days. While active, everything they
// post is created hidden (they see it; nobody else does). days=0 clears it.
app.post('/api/admin/users/:id/shadowban', requireAdmin, async (req, res) => {
  try {
    const days = Math.max(0, parseInt(req.body?.days ?? 0) || 0);
    const until = days > 0 ? new Date(Date.now() + days * 86400000) : null;
    const { rows } = await pool.query(
      `UPDATE users SET shadowbanned_until=$1 WHERE id=$2 RETURNING id, shadowbanned_until`,
      [until, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    await logAdminAction(req.adminUser.id, days > 0 ? 'shadowban_user' : 'unshadowban_user', 'user', req.params.id, days > 0 ? `${days}d` : null);
    res.json({ user: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Silent hide/unhide a single item. Hidden content drops out of the community
// feed and public comment lists but still shows in the author's own logbook /
// profile — so a removal doesn't tip them off. type: catch | spot | comment.
const HIDE_TABLE = { catch: 'catches', spot: 'spots', comment: 'comments', spot_photo: 'spot_photos' };
app.post('/api/admin/content/:type/:id/hide', requireAdmin, async (req, res) => {
  try {
    const table = HIDE_TABLE[req.params.type];
    if (!table) return res.status(400).json({ error: 'type must be catch, spot, or comment' });
    const hidden = req.body?.hidden !== false; // default true; { hidden:false } to restore
    const { rows } = await pool.query(`UPDATE ${table} SET hidden=$1 WHERE id=$2 RETURNING id`, [hidden, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    await logAdminAction(req.adminUser.id, hidden ? 'hide_content' : 'unhide_content', req.params.type, req.params.id);
    res.json({ ok: true, hidden });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin action audit log — who cleared/removed/resolved/banned what ─────────
app.get('/api/admin/actions', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at,
              a.admin_id, u.name AS admin_name
       FROM admin_actions a LEFT JOIN users u ON u.id=a.admin_id
       ORDER BY a.created_at DESC LIMIT 200`
    );
    res.json({ actions: rows });
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
