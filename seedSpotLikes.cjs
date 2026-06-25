/**
 * seedSpotLikes.cjs — seed heart/like counts across the curated spot set.
 *
 * Hearts live in `likes` (target_type='spot', target_id=spot.id). The new
 * curated spots start with zero likes, so they show an empty heart. This gives
 * every one a believable count, reusing the same seed-voter pool the report
 * cards use.
 *
 * SAFETY:
 *   - Likes are owned by the fixed seed-voter accounts. Re-running deletes ONLY
 *     those seed likes (for spots) and regenerates — real angler likes are never
 *     touched.
 *   - Only spots owned by system_seed_bonetide are seeded.
 *   - Orphaned spot-likes (pointing at deleted spots) are swept up.
 *
 * Run (Railway Console, Bonetide.api service):
 *     node seedSpotLikes.cjs
 */
const { Pool } = require('pg');

const SEED_OWNER_DEVICE = 'system_seed_bonetide';
const VOTER_PREFIX = 'seed_voter_';
const NUM_VOTERS = 15;          // same pool as the report cards (max 14 hearts/spot)
const CHUNK = 1000;             // rows per insert batch (3 cols, well under param cap)

const randInt = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// Believable heart count — mostly mid, some popular, a few quiet. Always >= 1.
function heartCount() {
  const r = Math.random();
  if (r < 0.55) return randInt(2, 7);    // typical
  if (r < 0.82) return randInt(8, 11);   // popular
  if (r < 0.95) return randInt(1, 3);    // quieter
  return randInt(12, 14);                // hotspots
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
      `SELECT s.id
         FROM spots s
         JOIN users u ON u.id = s.user_id
        WHERE u.device_id = $1`,
      [SEED_OWNER_DEVICE]
    );
    console.log(`Curated spots to heart: ${spots.length}`);
    if (spots.length === 0) {
      console.log('No curated spots found — run seedSpotsNational.cjs first.');
      return;
    }

    // 3. Clear prior seed likes (idempotent) + orphaned spot-likes.
    const cleared = await pool.query(
      `DELETE FROM likes WHERE target_type='spot' AND user_id = ANY($1::int[])`,
      [voterIds]
    );
    const orphans = await pool.query(
      `DELETE FROM likes WHERE target_type='spot' AND target_id NOT IN (SELECT id FROM spots)`
    );
    console.log(`Cleared ${cleared.rowCount} prior seed likes, ${orphans.rowCount} orphaned rows.`);

    // 4. Build like rows: each spot gets a random subset of voters.
    const rows = [];
    for (const spot of spots) {
      const n = Math.min(heartCount(), voterIds.length);
      const likers = shuffle(voterIds).slice(0, n);
      for (const uid of likers) rows.push([uid, spot.id]);
    }

    // 5. Insert in chunks.
    let inserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const tuples = [];
      const params = [];
      slice.forEach((r, k) => {
        const b = k * 2;
        tuples.push(`($${b+1},'spot',$${b+2},NOW())`);
        params.push(r[0], r[1]);
      });
      const res = await pool.query(
        `INSERT INTO likes (user_id, target_type, target_id, created_at)
         VALUES ${tuples.join(',')}
         ON CONFLICT (user_id, target_type, target_id) DO NOTHING`,
        params
      );
      inserted += res.rowCount;
    }

    // 6. Report.
    const avg = (rows.length / spots.length).toFixed(1);
    console.log(`\nDone. ${inserted} hearts across ${spots.length} spots (avg ${avg}/spot).`);
    const sample = spots[Math.floor(Math.random() * spots.length)];
    const { rows: [agg] } = await pool.query(
      `SELECT COUNT(*)::int AS hearts FROM likes WHERE target_type='spot' AND target_id=$1`,
      [sample.id]
    );
    console.log(`Sample spot #${sample.id}: ${agg.hearts} hearts.`);
  } catch (err) {
    console.error('\nSpot-likes seed FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
