// addFlaglerPier.cjs
// ---------------------------------------------------------------------------
// Restores the Flagler Beach Pier spot (swept in the seed cleanup) under the
// seed owner, as a community pier spot.
//
// Real-world note: the historic 1928 pier was closed after Hurricane Ian (2022)
// and is being rebuilt as a taller concrete structure, reopening ~late 2026.
// The note below says so, so the app doesn't send anglers to a closed site.
// Edit FLAGLER below if you want different wording / coordinates.
//
// Idempotent: if a Flagler pier spot already exists near these coordinates it
// reports and does nothing (no duplicates). Safe to re-run.
//
// Cover photo: inserted with photo_url = NULL on purpose. After running this,
// re-run `EXECUTE=1 node seedSpotPhotos.cjs` — it only fills NULLs, so it'll
// give just this one spot a pier cover.
//
// RUN IN RAILWAY CONSOLE:
//   Dry run (reports, writes nothing):   node addFlaglerPier.cjs
//   Apply:                               EXECUTE=1 node addFlaglerPier.cjs
//
// Env: DATABASE_URL (Railway has it). SEED_OWNER_DEVICE optional (defaults
//      to 'system_seed_bonetide').
// ---------------------------------------------------------------------------

const { Pool } = require('pg');

const EXECUTE           = process.env.EXECUTE === '1';
const SEED_OWNER_DEVICE = process.env.SEED_OWNER_DEVICE || 'system_seed_bonetide';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Foot-of-pier GPS is 29.4798, -81.1266; nudged ~400 ft east so the pin sits
// out over the water on the pier rather than on the sand.
const FLAGLER = {
  name: 'Flagler Beach Pier',
  type: 'pier',
  lat: 29.4798,
  lon: -81.1253,
  note: 'Historic Atlantic Ocean fishing pier (built 1928), reaching 806 ft into the surf. ' +
        '⚠️ Closed for reconstruction after Hurricane Ian — a new, taller concrete pier is ' +
        'slated to reopen in late 2026. Common catches: whiting, pompano, redfish, black drum, ' +
        'sheepshead, flounder, Spanish mackerel, bluefish, jack crevalle, sharks; tarpon and ' +
        'king mackerel in season.',
  is_private: false,
};

(async () => {
  // 1) Resolve the seed owner.
  const { rows: owners } = await pool.query(
    `SELECT id FROM users WHERE device_id = $1`, [SEED_OWNER_DEVICE]
  );
  if (!owners.length) {
    console.error(`Seed owner "${SEED_OWNER_DEVICE}" not found. Set SEED_OWNER_DEVICE and re-run.`);
    await pool.end();
    process.exit(1);
  }
  const ownerId = owners[0].id;

  // 2) Dedup guard — look for an existing Flagler pier near these coordinates
  //    (~0.01° ≈ 0.7 mi box), regardless of owner.
  const { rows: existing } = await pool.query(
    `SELECT id, name, user_id, lat, lon FROM spots
      WHERE name ILIKE '%flagler%'
        AND ABS(lat - $1) < 0.01 AND ABS(lon - $2) < 0.01`,
    [FLAGLER.lat, FLAGLER.lon]
  );

  console.log(`Seed owner "${SEED_OWNER_DEVICE}" = user_id ${ownerId}`);
  if (existing.length) {
    console.log(`Already present — not inserting. Found ${existing.length}:`);
    for (const e of existing) console.log(`  id=${e.id} "${e.name}" (user_id=${e.user_id})`);
    await pool.end();
    return;
  }

  console.log('Will insert:');
  console.log(`  ${FLAGLER.name} [${FLAGLER.type}] @ ${FLAGLER.lat}, ${FLAGLER.lon}`);
  console.log(`  note: ${FLAGLER.note}`);

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing written. Re-run with EXECUTE=1 to insert.');
    await pool.end();
    return;
  }

  const { rows: [row] } = await pool.query(
    `INSERT INTO spots (user_id, name, type, note, lat, lon, photo_url, is_private, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, NOW())
     RETURNING id`,
    [ownerId, FLAGLER.name, FLAGLER.type, FLAGLER.note, FLAGLER.lat, FLAGLER.lon, FLAGLER.is_private]
  );

  console.log(`\nInserted "${FLAGLER.name}" as spot id ${row.id}.`);
  console.log('Next: run  EXECUTE=1 node seedSpotPhotos.cjs  to give it a pier cover photo.');
  await pool.end();
})().catch(e => { console.error('addFlaglerPier failed:', e); process.exit(1); });
