// bonecastNotify.js — Bone Tide Co.
//
// Daily "your bite window today" push, built on top of the existing /api/bonecast
// endpoint (so all the tide/wind/pressure/solunar scoring stays in ONE place —
// this file never re-derives a forecast, it just reads the app's own).
//
// The ladder (decided with Jessie):
//   • Club members  → an AI-written (Claude Haiku) one-liner, on good-bite days.
//   • Free members  → a lighter TEMPLATED nudge (no AI cost), frequency-capped,
//                     so they feel the value and see what Club unlocks.
//
// Safety rails, because this fires to real phones and spends on the Claude API:
//   • OFF unless BONECAST_PUSH_ENABLED=true. Nothing schedules until you flip it.
//   • runBoneCastPush({ dryRun:true }) generates + returns copy WITHOUT sending,
//     so you can preview. Pair with ?limit=5 to preview a handful cheaply.
//   • A per-user UNIQUE(user_id, sent_on) row is the real "once per day" guard —
//     survives restarts and double-fires.
//   • Only reaches people with a push token (JOIN push_tokens) AND a known
//     location (their most recent catch's lat/lon — the server doesn't store a
//     home location, so a logged catch is our proxy for "their water").
//
// Tunables (env, all optional):
//   BONECAST_PUSH_ENABLED       'true' to arm the daily scheduler
//   BONECAST_MODEL              Claude model (default claude-haiku-4-5)
//   BONECAST_MIN_SCORE          good-day threshold on the slot score (default 60)
//   BONECAST_FREE_COOLDOWN_DAYS min days between free-user sends (default 3)
//   BONECAST_SEND_HOUR          UTC hour to fire the daily run (default 11 ≈ early AM US East)

import fetch from 'node-fetch';

const HAIKU_MODEL        = process.env.BONECAST_MODEL || 'claude-haiku-4-5';
const MIN_SCORE          = Number(process.env.BONECAST_MIN_SCORE || 60);
const FREE_COOLDOWN_DAYS = Number(process.env.BONECAST_FREE_COOLDOWN_DAYS || 3);
const SEND_HOUR_UTC      = Number(process.env.BONECAST_SEND_HOUR || 11);
const PORT               = process.env.PORT || 3000;
const SOUND              = 'reeldrag.wav';

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bonecast_push_log (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER,
      tier       TEXT,
      score      INTEGER,
      sent_on    DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, sent_on)
    )`).catch(e => console.error('[bonecast-push] table:', e.message));
}

// The single best-scoring fishable hour in a day, from computeGoodBite's `score`.
function pickBestSlot(day) {
  if (!day || !Array.isArray(day.slots) || !day.slots.length) return null;
  return day.slots.reduce((a, b) => (b.score > (a?.score ?? -1) ? b : a), null);
}

function fmtClock(localHour) {
  const hr = Math.floor(localHour);
  const m  = Math.round((localHour - hr) * 60);
  const ap = hr >= 12 ? 'PM' : 'AM';
  let hh = hr % 12; if (hh === 0) hh = 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

// Turn a scored slot into plain-English conditions for the prompt / template.
function conditionSummary(day, slot) {
  const clean = s => String(s ?? '').replace(/_/g, ' ');
  return {
    windowLabel: fmtClock(slot.localHour),
    label:       slot.label || 'Good',
    text: `${slot.label || 'Good'} bite window. Tide ${clean(slot.inputs?.tidePhase)}, `
        + `${slot.windKts}kt ${slot.windDir} wind, pressure ${clean(slot.inputs?.baroTrend)}, `
        + `${clean(slot.inputs?.lightWindow)} light, ${day.moonPhaseName || 'moon'}.`,
  };
}

async function writeAiLine(cond, anthropicKey) {
  const prompt =
    `You write ONE short push-notification line (max ~90 characters, no emojis, no quotes, no hashtags) `
  + `for a saltwater inshore fishing app called Bone Tide. Punchy, confident fishing-guide voice. `
  + `Tell the angler their best bite window today and the key reason, using ONLY the conditions given — `
  + `do not invent numbers.\n`
  + `Conditions: ${cond.text}\n`
  + `Best window: around ${cond.windowLabel}.\n`
  + `Output only the notification text.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 80, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error('anthropic ' + res.status);
  const j = await res.json();
  return (j?.content?.[0]?.text || '').trim().replace(/^["']+|["']+$/g, '').slice(0, 150);
}

/**
 * Run the job once. Returns a summary (and, in dry-run, sample copy).
 * @param {{pool:any, sendPush:Function, anthropicKey:string, dryRun?:boolean, limit?:number|null}} o
 */
export async function runBoneCastPush({ pool, sendPush, anthropicKey, dryRun = true, limit = null }) {
  await ensureTable(pool);

  // Location, in priority order: the angler's saved favorite spot, else their
  // most recent catch as a fallback. No favorite and no located catch → they're
  // simply not in this run (nothing to forecast against yet). fav_region /
  // fav_species / fav_station_id ride along so scoring matches what they'd see
  // in the app for that spot.
  const { rows: users } = await pool.query(`
    SELECT DISTINCT ON (u.id) u.id, u.name, COALESCE(u.is_club, false) AS is_club,
           COALESCE(u.fav_lat, c.lat)  AS lat,
           COALESCE(u.fav_lon, c.lon)  AS lon,
           u.fav_region     AS region,
           u.fav_species    AS species,
           u.fav_station_id AS station
      FROM users u
      JOIN push_tokens pt ON pt.user_id = u.id
      LEFT JOIN catches c  ON c.user_id = u.id AND c.lat IS NOT NULL AND c.lon IS NOT NULL
     WHERE COALESCE(u.is_deleted, false) = false
       AND COALESCE(u.is_banned,  false) = false
       AND (u.fav_lat IS NOT NULL OR c.lat IS NOT NULL)
     ORDER BY u.id, c.caught_at DESC`);

  const result = {
    dryRun, candidates: users.length, sent: 0,
    skippedAlreadySent: 0, skippedFreeCooldown: 0, skippedNoWindow: 0, errors: 0,
    samples: [],
  };
  const forecastByArea = new Map();
  let processed = 0;

  for (const u of users) {
    if (limit && processed >= limit) break;
    processed++;

    try {
      // Once per day, per user (hard guard, restart-proof).
      const { rows: dup } = await pool.query(
        `SELECT 1 FROM bonecast_push_log WHERE user_id = $1 AND sent_on = CURRENT_DATE`, [u.id]);
      if (dup.length) { result.skippedAlreadySent++; continue; }

      // Free users: throttle so it stays a treat, not spam.
      if (!u.is_club) {
        const { rows: recent } = await pool.query(
          `SELECT 1 FROM bonecast_push_log
             WHERE user_id = $1 AND sent_on > CURRENT_DATE - $2::int LIMIT 1`,
          [u.id, FREE_COOLDOWN_DAYS]);
        if (recent.length) { result.skippedFreeCooldown++; continue; }
      }

      // Forecast — reuse the app's own endpoint; cache per ~1km area so many
      // anglers on the same water share one call (matches its own 0.01° cache).
      const qs = new URLSearchParams({ lat: String(u.lat), lon: String(u.lon), days: '1' });
      if (u.region)  qs.set('region', u.region);
      if (u.species) qs.set('species', u.species);
      if (u.station) qs.set('station', u.station);
      const areaKey = qs.toString();   // region/species affect scoring, so key on them too
      let fc = forecastByArea.get(areaKey);
      if (!fc) {
        const r = await fetch(`http://localhost:${PORT}/api/bonecast?${areaKey}`);
        fc = r.ok ? await r.json() : { days: [] };
        forecastByArea.set(areaKey, fc);
      }

      const today = fc?.days?.[0];
      const best  = pickBestSlot(today);
      if (!best || best.score < MIN_SCORE) { result.skippedNoWindow++; continue; }

      const cond = conditionSummary(today, best);
      let title, body;
      if (u.is_club) {
        title = 'Your BoneCast';
        try { body = await writeAiLine(cond, anthropicKey); }
        catch (e) {
          // Claude hiccup shouldn't cost a Club member their alert — fall back
          // to a clean templated line built from the same conditions.
          body = `${cond.label} window ~${cond.windowLabel}. ${cond.text}`.slice(0, 150);
        }
      } else {
        title = 'Bite window today';
        body  = `Conditions are lining up near your spot — best window around ${cond.windowLabel}. `
              + `Open BoneCast for the read.`;
      }

      if (result.samples.length < 15) {
        result.samples.push({ user: u.name, tier: u.is_club ? 'club' : 'free', score: Math.round(best.score), title, body });
      }

      if (!dryRun) {
        const { rows: toks } = await pool.query(`SELECT token FROM push_tokens WHERE user_id = $1`, [u.id]);
        if (toks.length) {
          await sendPush(toks.map(t => ({
            to: t.token, title, body,
            data: { screen: 'Home', params: { openBoneCast: true } },
            sound: SOUND, priority: 'high',
          })));
        }
        await pool.query(
          `INSERT INTO bonecast_push_log (user_id, tier, score) VALUES ($1, $2, $3)
             ON CONFLICT (user_id, sent_on) DO NOTHING`,
          [u.id, u.is_club ? 'club' : 'free', Math.round(best.score)]);
      }
      result.sent++;
    } catch (e) {
      result.errors++;
      console.error('[bonecast-push] user', u.id, e.message);
    }
  }

  console.log('[bonecast-push]', dryRun ? 'DRY-RUN' : 'SENT',
    JSON.stringify({ candidates: result.candidates, sent: result.sent,
      noWindow: result.skippedNoWindow, alreadySent: result.skippedAlreadySent,
      freeCooldown: result.skippedFreeCooldown, errors: result.errors }));
  return result;
}

/**
 * Arm the daily run. Checks every 5 min and fires once when the UTC hour matches
 * BONECAST_SEND_HOUR; the per-user daily row is what actually prevents dupes.
 */
export function startBoneCastScheduler(deps) {
  let lastRunDate = null;
  const tick = async () => {
    const now  = new Date();
    const dstr = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === SEND_HOUR_UTC && lastRunDate !== dstr) {
      lastRunDate = dstr;
      try { await runBoneCastPush({ ...deps, dryRun: false }); }
      catch (e) { console.error('[bonecast-push] scheduled run:', e.message); }
    }
  };
  setInterval(tick, 5 * 60 * 1000);
  console.log(`[bonecast-push] scheduler armed — fires ~${SEND_HOUR_UTC}:00 UTC daily`);
}
