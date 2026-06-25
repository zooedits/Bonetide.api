// seedSpotPhotos.cjs  (v2 — quality-filtered)
// ---------------------------------------------------------------------------
// Gives spots a RELEVANT, scene-setting fishing-area cover photo from Pexels.
//
// v2 fixes the "crappy photo" problem: stock search returns a lot of aerial
// straight-down shots and macro/abstract close-ups (wave foam, sand texture)
// that don't show the actual fishing area. This version RANKS and FILTERS the
// Pexels results using each photo's alt-text and aspect ratio:
//   - hard-rejects aerial / drone / overhead / close-up / macro / texture /
//     abstract / pattern / foam / droplet / underwater shots
//   - rejects square-ish or ultra-panoramic frames (usually aerials/banners)
//   - prefers normal landscape framing and alt-text that names the area
//     (pier, jetty, beach, ocean, coast, dock, marsh, fishing, ...)
//
// Cover image only — never touches the Photos tab (user uploads).
//
// MODES:
//   Fill blanks only (default, idempotent):
//       node seedSpotPhotos.cjs                 (dry run)
//       EXECUTE=1 node seedSpotPhotos.cjs       (apply)
//   RE-SEED everything (replace the bad photos already set):
//       RESEED=1 node seedSpotPhotos.cjs            (dry run — shows scope)
//       RESEED=1 EXECUTE=1 node seedSpotPhotos.cjs  (overwrite ALL seed spots)
//
// Env: DATABASE_URL (Railway has it), PEXELS_API_KEY, SEED_OWNER_DEVICE (opt).
// ---------------------------------------------------------------------------

const { Pool } = require('pg');

const EXECUTE           = process.env.EXECUTE === '1';
const RESEED            = process.env.RESEED === '1'; // overwrite existing covers too
const PEXELS_API_KEY    = process.env.PEXELS_API_KEY;
const SEED_OWNER_DEVICE = process.env.SEED_OWNER_DEVICE || 'system_seed_bonetide';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Scene-oriented search terms per type (we let the filter below do the quality work).
const TYPE_QUERIES = {
  pier:          ['fishing pier ocean', 'wooden pier over sea', 'long fishing pier coast'],
  jetty:         ['rock jetty sea', 'jetty breakwater ocean', 'stone jetty coast'],
  beach:         ['surf fishing beach', 'sandy beach shoreline', 'beach coast waves'],
  flat:          ['coastal salt marsh', 'shallow tidal flats', 'marsh wetland water'],
  inshore:       ['coastal estuary water', 'inshore lagoon', 'mangrove waterway'],
  nearshore:     ['ocean coastline', 'sea shore boat', 'coastal water view'],
  bridge:        ['fishing bridge over water', 'causeway over bay', 'bridge coastal water'],
  creek:         ['tidal creek marsh', 'coastal creek water', 'salt marsh creek'],
  channel:       ['intracoastal waterway', 'coastal boat channel', 'waterway marsh'],
  offshore_reef: ['open ocean horizon', 'offshore blue water', 'ocean sea surface'],
  dock:          ['fishing dock water', 'wooden boat dock harbor', 'dock bay marina'],
  launch:        ['boat ramp water', 'boat launch river', 'boat ramp lake'],
};
const FALLBACK_QUERIES = ['coastal shoreline water', 'saltwater fishing area'];

// Words in a photo's alt-text that mean "not a usable fishing-area scene".
const REJECT = /(aerial|drone|overhead|top[- ]?view|bird'?s?[- ]?eye|close[- ]?up|macro|texture|pattern|abstract|minimal|foam|bubble|droplet|ripple|underwater|sunset silhouette|blur)/i;

// Words that suggest a good scene; type-specific ones score highest.
const SCENE_WORDS = ['pier','jetty','beach','ocean','sea','coast','shore','dock','harbor','marina','fishing','bay','inlet','marsh','estuary','lagoon','river','lake','bridge','waterway','boat'];
const TYPE_WORDS = {
  pier: ['pier'], jetty: ['jetty','breakwater','rocks'], beach: ['beach','sand','surf','shore'],
  flat: ['marsh','flat','wetland','estuary'], inshore: ['estuary','lagoon','mangrove','marsh','inshore'],
  nearshore: ['coast','shore','sea','ocean'], bridge: ['bridge','causeway'],
  creek: ['creek','marsh','stream'], channel: ['channel','waterway','intracoastal'],
  offshore_reef: ['ocean','sea','reef','horizon'], dock: ['dock','harbor','marina'],
  launch: ['ramp','launch','boat'],
};

function scorePhoto(p, type) {
  const alt = (p.alt || '').toLowerCase();
  if (REJECT.test(alt)) return -1;
  const ratio = p.width / p.height;
  if (ratio < 1.2 || ratio > 2.2) return -1;            // skip square-ish (aerial) / ultra-pano
  let score = (ratio >= 1.4 && ratio <= 1.85) ? 1 : 0;  // classic landscape framing
  for (const w of SCENE_WORDS)            if (alt.includes(w)) score += 1;
  for (const w of (TYPE_WORDS[type] || [])) if (alt.includes(w)) score += 3;
  return score;
}

async function pexelsSearch(query, perPage = 80) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&orientation=landscape`;
  try {
    const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
    if (!res.ok) { console.warn(`    Pexels "${query}" -> HTTP ${res.status}`); return []; }
    const data = await res.json();
    return data.photos || [];
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
    console.error('Missing PEXELS_API_KEY. Set it inline or in Railway Variables and re-run.');
    process.exit(1);
  }

  const { rows: owners } = await pool.query(
    `SELECT id FROM users WHERE device_id = $1`, [SEED_OWNER_DEVICE]
  );

  let where, params, scopeLabel;
  const photoCond = RESEED ? 'TRUE' : `(photo_url IS NULL OR photo_url = '')`;
  if (owners.length) {
    where = `user_id = $1 AND ${photoCond}`;
    params = [owners[0].id];
    scopeLabel = `seed owner "${SEED_OWNER_DEVICE}" (user_id=${owners[0].id})`;
  } else {
    where = `is_private = false AND ${photoCond}`;
    params = [];
    scopeLabel = `all community spots — seed owner "${SEED_OWNER_DEVICE}" not found`;
    console.warn(`! ${scopeLabel}`);
  }

  const { rows: spots } = await pool.query(
    `SELECT id, name, type FROM spots WHERE ${where} ORDER BY type, id`, params
  );

  const byType = {};
  for (const s of spots) { const t = s.type || 'unknown'; (byType[t] = byType[t] || []).push(s); }

  console.log(`Mode: ${RESEED ? 'RE-SEED (overwrite existing covers)' : 'fill blanks only'}`);
  console.log(`Scope: ${scopeLabel}`);
  console.log(`Spots to photograph: ${spots.length}`);
  for (const [t, arr] of Object.entries(byType)) console.log(`  ${t}: ${arr.length}`);
  if (!spots.length) { console.log('Nothing to do.'); await pool.end(); return; }

  if (!EXECUTE) {
    console.log('\nDRY RUN — nothing written. Add EXECUTE=1 to apply.');
    await pool.end();
    return;
  }

  let updated = 0;
  const emptyTypes = [];

  for (const [type, arr] of Object.entries(byType)) {
    const queries = TYPE_QUERIES[type] || FALLBACK_QUERIES;
    const raw = [];
    for (const q of queries) raw.push(...await pexelsSearch(q));

    // Filter + rank, then de-dup by URL.
    const seen = new Set();
    const ranked = raw
      .map(p => ({ url: p.src && (p.src.landscape || p.src.large), score: scorePhoto(p, type) }))
      .filter(x => x.url && x.score >= 0 && !seen.has(x.url) && seen.add(x.url))
      .sort((a, b) => b.score - a.score);

    // Keep the strongest pool; shuffle within it for variety.
    const pool_imgs = shuffle(ranked.slice(0, Math.max(40, arr.length))).map(x => x.url);

    if (!pool_imgs.length) {
      console.warn(`  [${type}] no images passed the quality filter — skipped ${arr.length} spots`);
      emptyTypes.push(type);
      continue;
    }

    for (let i = 0; i < arr.length; i++) {
      await pool.query(`UPDATE spots SET photo_url = $1 WHERE id = $2`, [pool_imgs[i % pool_imgs.length], arr[i].id]);
      updated++;
    }
    console.log(`  [${type}] set ${arr.length} spots from a filtered pool of ${pool_imgs.length} (kept ${ranked.length}/${raw.length} candidates)`);
  }

  console.log(`\nDone. Updated ${updated} spots.`);
  if (emptyTypes.length) console.log(`Types still blank (filter too strict / no results): ${emptyTypes.join(', ')}`);
  await pool.end();
})().catch(e => { console.error('seedSpotPhotos failed:', e); process.exit(1); });
