/**
 * seedReportCards.cjs — seed angler report cards across the curated spot set.
 *
 * Report cards live in `spot_polls`, keyed by spot_id. The new curated spots
 * (owned by device_id='system_seed_bonetide') are fresh rows, so they start
 * with no ratings. This populates believable report cards for every one of
 * them, and clears orphaned poll rows left behind by previously-deleted spots.
 *
 * SAFETY:
 *   - Votes are owned by a fixed pool of "seed voter" accounts. Re-running
 *     deletes ONLY those seed votes and regenerates — real angler ratings are
 *     never touched.
 *   - Only spots owned by system_seed_bonetide are seeded.
 *
 * Run (Railway Console, Bonetide.api service):
 *     node seedReportCards.cjs
 */
const { Pool } = require('pg');

const SEED_OWNER_DEVICE = 'system_seed_bonetide';
const VOTER_PREFIX = 'seed_voter_';
const NUM_VOTERS = 15;          // size of the synthetic voter pool
const MIN_VOTES = 3;            // min votes per spot
const MAX_VOTES = 14;           // max votes per spot (<= NUM_VOTERS)
const CHUNK = 800;              // rows per insert batch (8 cols, well under param cap)

// ── helpers ──────────────────────────────────────────────────────────────────
const clamp15 = (x) => Math.max(1, Math.min(5, x));
const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
function gauss(mean, sd) {                       // Box–Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const vote = (base) => clamp15(Math.round(gauss(base, 0.7)));
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// has_cost leaning by spot type
function costProfile(type) {
  if (type === 'pier') return { yes: 0.78, sometimes: 0.14, no: 0.08 };
  if (type === 'bridge') return { yes: 0.45, sometimes: 0.30, no: 0.25 };
  if (type === 'dock' || type === 'launch') return { yes: 0.20, sometimes: 0.45, no: 0.35 };
  return { yes: 0.06, sometimes: 0.14, no: 0.80 }; // beach/jetty/inshore/creek/channel/flat
}
function pickCost(p) {
  const r = Math.random();
  if (r < p.yes) return 'yes';
  if (r < p.yes + p.sometimes) return 'sometimes';
  return 'no';
}

(async () => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }, // matches server.js
  });
  try {
    // 1. Ensure the seed-voter accounts exist; collect their ids.
    const voterIds = [];
    for (let i = 1; i <= NUM_VOTERS; i++) {
      const dev = VOTER_PREFIX + String(i).padStart(2, '0');
      await pool.query(
        `INSERT INTO users (device_id, name, points_balance, created_at)
         SELECT $1, 'Bone Tide Angler', 0, NOW()
         WHERE NOT EXISTS (SELECT 1 FROM users WHERE device_id = $1)`,
        [dev]
      );
      const { rows: [u] } = await pool.query('SELECT id FROM users WHERE device_id = $1', [dev]);
      voterIds.push(u.id);
    }
    console.log(`Seed-voter pool ready: ${voterIds.length} accounts.`);

    // 2. Pull the curated spots.
    const { rows: spots } = await pool.query(
      `SELECT s.id, s.type
         FROM spots s
         JOIN users u ON u.id = s.user_id
        WHERE u.device_id = $1`,
      [SEED_OWNER_DEVICE]
    );
    console.log(`Curated spots to rate: ${spots.length}`);
    if (spots.length === 0) {
      console.log('No curated spots found — run seedSpotsNational.cjs first.');
      return;
    }

    // 3. Clear prior seed votes (idempotent) + orphaned poll rows.
    const cleared = await pool.query('DELETE FROM spot_polls WHERE user_id = ANY($1::int[])', [voterIds]);
    const orphans = await pool.query('DELETE FROM spot_polls WHERE spot_id NOT IN (SELECT id FROM spots)');
    console.log(`Cleared ${cleared.rowCount} prior seed votes, ${orphans.rowCount} orphaned rows.`);

    // 4. Build all poll rows.
    const rows = [];
    for (const spot of spots) {
      const baseOverall = 3.2 + Math.random() * 1.4;  // 3.2–4.6
      const baseFish    = 2.8 + Math.random() * 1.8;  // 2.8–4.6
      const baseCrowd   = 2.8 + Math.random() * 1.7;  // 2.8–4.5
      const baseClean   = 3.3 + Math.random() * 1.4;  // 3.3–4.7
      const baseAccess  = 3.3 + Math.random() * 1.4;  // 3.3–4.7
      const cp = costProfile(spot.type);

      const nVotes = randInt(MIN_VOTES, MAX_VOTES);
      const voters = shuffle(voterIds).slice(0, nVotes);
      for (const uid of voters) {
        rows.push([
          spot.id, uid,
          vote(baseOverall), vote(baseFish), vote(baseCrowd), vote(baseClean), vote(baseAccess),
          pickCost(cp),
        ]);
      }
    }

    // 5. Insert in chunks.
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const tuples = [];
      const params = [];
      slice.forEach((r, k) => {
        const b = k * 8;
        tuples.push(`($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8})`);
        params.push(...r);
      });
      const res = await pool.query(
        `INSERT INTO spot_polls
           (spot_id, user_id, rating_overall, rating_fish, rating_crowd, rating_clean, rating_access, has_cost)
         VALUES ${tuples.join(',')}
         ON CONFLICT (spot_id, user_id) DO NOTHING`,
        params
      );
      inserted += res.rowCount;
    }

    // 6. Report.
    const avg = (rows.length / spots.length).toFixed(1);
    console.log(`\nDone. ${inserted} votes across ${spots.length} spots (avg ${avg}/spot).`);
    const sample = spots[Math.floor(Math.random() * spots.length)];
    const { rows: [agg] } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              ROUND(AVG(rating_overall)::numeric,1) AS overall,
              ROUND(AVG(rating_fish)::numeric,1)    AS fish
         FROM spot_polls WHERE spot_id = $1`,
      [sample.id]
    );
    console.log(`Sample spot #${sample.id}: ${agg.total} ratings, overall ${agg.overall}, fish ${agg.fish}.`);
  } catch (err) {
    console.error('\nReport-card seed FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
