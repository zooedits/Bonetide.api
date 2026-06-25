// seedSpotPhotos.cjs
// ---------------------------------------------------------------------------
// Gives every spot that's missing a cover photo a RELEVANT fishing-area image.
//
// Why this exists: the new 599-spot seed was inserted without photo_url values,
// so those spots render blank where the cover image goes. The OLD photo pass
// searched by spot NAME, which returned landmark shots (e.g. the Ponce Inlet
// lighthouse) instead of the actual fishing area. This script searches Pexels by
// spot TYPE with water/structure terms, so a "pier" spot gets a pier-over-water
// photo, a "jetty" gets rocks-and-surf, etc. — never the landmark.
//
// Efficiency: it runs ONE Pexels search per type-query (not per spot), builds a
// pool of images for each type, then distributes that pool across all spots of
// that type so same-type spots don't all share one photo. ~24 API calls total.
//
// Idempotent: only fills spots where photo_url IS NULL/''. Safe to re-run; it
// skips spots that already have a cover. Run it again to fill any it missed.
//
// Cover image only — this does NOT touch the Photos tab (user-uploaded feed).
//
// RUN IN RAILWAY CONSOLE:
//   Dry run (reports what it WOULD do, writes nothing):
//       node seedSpotPhotos.cjs
//   Apply:
//       EXECUTE=1 node seedSpotPhotos.cjs
//
// Requires env (Railway already has DATABASE_URL):
//   PEXELS_API_KEY      — your Pexels API key
//   SEED_OWNER_DEVICE   — optional; defaults to 'system_seed_bonetide'
// ---------------------------------------------------------------------------

const { Pool } = require('pg');

const EXECUTE           = process.env.EXECUTE === '1';
const PEXELS_API_KEY    = process.env.PEXELS_API_KEY;
const SEED_OWNER_DEVICE = process.env.SEED_OWNER_DEVICE || 'system_seed_bonetide';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Fishing-AREA search terms per spot type. Water/structure focused so results
// show where you'd actually fish — never a landmark. We never search by name.
const TYPE_QUERIES = {
  pier:          ['fishing pier ocean', 'wooden fishing pier sea'],
  jetty:         ['rock jetty ocean waves', 'stone jetty sea'],
  beach:         ['sandy beach ocean surf', 'beach shoreline waves'],
  flat:          ['shallow saltwater flats', 'coastal marsh flats water'],
  inshore:       ['coastal estuary calm water', 'inshore marsh waterway'],
  nearshore:     ['ocean coastline water', 'nearshore sea boat'],
  bridge:        ['fishing bridge over water', 'causeway bridge bay'],
  creek:         ['tidal creek marsh', 'coastal creek water'],
  channel:       ['intracoastal waterway', 'coastal channel water'],
  offshore_reef: ['offshore blue ocean water', 'open ocean sea'],
  dock:          ['fishing dock water', 'wooden dock bay'],
  launch:        ['boat ramp launch water', 'boat launch river'],
};
const FALLBACK_QUERIES = ['saltwater fishing spot water', 'coastal shoreline water'];

async function pexelsSearch(query, perPage = 60) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
  try {
    const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (!res.ok) { console.warn(`    Pexels "${query}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    return (data.photos || [])
      .map(p => p.src && (p.src.landscape || p.src.large))
      .filter(Boolean);
  } catch (e) {
    console.warn(`    Pexels "${query}" -> ${e.message}`);
    return [];
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

(async () => {
  if (!PEXELS_API_KEY) {
    console.error('Missing PEXELS_API_KEY. Set it in Railway (Variables) and re-run.');
    process.exit(1);
  }

  // 1) Scope to the spots that are actually missing a cover photo. We prefer the
  //    seed owner, but fall back to all community spots with no cover — and since
  //    we only ever touch NULL/'' photo_url, the already-photographed 204 are
  //    naturally excluded either way.
  const { rows: owners } = await pool.query(
    `SELECT id FROM users WHERE device_id = $1`, [SEED_OWNER_DEVICE]
  );

  let where, params, scopeLabel;
  if (owners.length) {
    where = `user_id = $1 AND (photo_url IS NULL OR photo_url = '')`;
    params = [owners[0].id];
    scopeLabel = `seed owner "${SEED_OWNER_DEVICE}" (user_id=${owners[0].id})`;
  } else {
    where = `is_private = false AND (photo_url IS NULL OR photo_url = '')`;
    params = [];
    scopeLabel = `all community spots — seed owner "${SEED_OWNER_DEVICE}" not found`;
    console.warn(`! ${scopeLabel}`);
  }

  const { rows: spots } = await pool.query(
    `SELECT id, name, type FROM spots WHERE ${where} ORDER BY type, id`, params
  );

  const byType = {};
  for (const s of spots) {
    const t = s.type || 'unknown';
    (byType[t] = byType[t] || []).push(s);
  }

  console.log(`Scope: ${scopeLabel}`);
  console.log(`Spots missing a cover photo: ${spots.length}`);
  for (const [t, arr] of Object.entries(byType)) console.log(`  ${t}: ${arr.length}`);

  if (!spots.length) { console.log('Nothing to do.'); await pool.end(); return; }

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing written. Re-run with EXECUTE=1 to apply.');
    await pool.end();
    return;
  }

  // 2) Build an image pool per type (few API calls), then 3) distribute it.
  let updated = 0;
  const emptyTypes = [];

  for (const [type, arr] of Object.entries(byType)) {
    const queries = TYPE_QUERIES[type] || FALLBACK_QUERIES;
    let imgs = [];
    for (const q of queries) imgs.push(...await pexelsSearch(q));
    imgs = shuffle([...new Set(imgs)]); // de-dup + vary

    if (!imgs.length) {
      console.warn(`  [${type}] no images for ${JSON.stringify(queries)} — skipped ${arr.length} spots`);
      emptyTypes.push(type);
      continue;
    }

    for (let i = 0; i < arr.length; i++) {
      const url = imgs[i % imgs.length]; // round-robin so same-type spots differ
      await pool.query(`UPDATE spots SET photo_url = $1 WHERE id = $2`, [url, arr[i].id]);
      updated++;
    }
    console.log(`  [${type}] set ${arr.length} spots from a pool of ${imgs.length} images`);
  }

  console.log(`\nDone. Updated ${updated} spots.`);
  if (emptyTypes.length) console.log(`Types with no images found (still blank): ${emptyTypes.join(', ')}`);
  await pool.end();
})().catch(e => { console.error('seedSpotPhotos failed:', e); process.exit(1); });
