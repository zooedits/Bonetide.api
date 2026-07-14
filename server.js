// HomeScreen.js — Bone Tide Co.

import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, Animated, Dimensions, Image, ActivityIndicator,
  Modal, TextInput, KeyboardAvoidingView, Platform, FlatList, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { WebView } from 'react-native-webview';
import * as Location from 'expo-location';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Svg, { Circle, Path, Text as SvgText, Defs, LinearGradient, Stop, Line } from 'react-native-svg';

import LottieView from 'lottie-react-native';
import useAppStore from './useAppStore';
import FeaturedAnglers from './FeaturedAnglers';
import { fetchTidePredictions, fetchConditions, fetchNearestStation, fetchCatches, fetchMarine, deleteCatch, claimDailyLogin } from './btcApi';
import { splashAt } from './TapSplash';
import RingEarnedPopup from './RingEarnedPopup';
import { useRingStore, hydrateRingStore } from './useRingStore';
import { catchThumb } from './catchImage';
import Avatar from './Avatar';
import { computeGoodBite, scoreColor } from './goodBiteEngine';
import { COLORS, RADIUS, SPACING } from './theme';

const { width: SW } = Dimensions.get('window');
const BTC_API = 'https://bonetideapi-production.up.railway.app';

// Module-level avatar cache — survives re-renders, pre-populated by App.js
// before HomeScreen ever mounts. This is the only reliable way to avoid the
// "J" flash since AsyncStorage is async and useState(null) always loses the race.
let _cachedAvatarUrl = null;
export function primeAvatarCache(url) { _cachedAvatarUrl = url; }
const CHART_W = SW - 32;
const CHART_H = 160;
const PAD = 18;

// Nominatim's "state_code" field isn't reliably populated, so we map its
// full state name to a USPS 2-letter code ourselves for "City, ST" display.
const US_STATE_ABBR = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA',
  Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA',
  Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD',
  Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO',
  Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH',
  Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY',
  'District of Columbia': 'DC', 'Puerto Rico': 'PR',
};
function abbreviateState(stateName) {
  if (!stateName) return null;
  return US_STATE_ABBR[stateName] || stateName;
}

// GPS-derived state → store (persisted), so per-state regulations reflect where
// the angler actually is. Only accepts a clean 2-letter USPS code, and only
// writes on an actual change (avoids clobbering the store on every refresh).
// Note: current location wins over a manual pick once GPS resolves — correct for
// regs, since you're bound by the rules where you're fishing, not your home.
function maybeSetHomeState(code) {
  const c = (code || '').toUpperCase();
  if (c.length !== 2) return;
  try {
    if (c !== useAppStore.getState().stateCode) useAppStore.getState().setStateCode(c);
  } catch {}
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nominatim's reverse lookup only returns a place whose polygon *contains*
// the point — rural/unincorporated GPS points often land outside every
// city/town boundary even when a well-known town is right next door
// (OSM admin boundaries don't always match colloquial usage). This finds
// the nearest *named* city/town/village within `radiusM` by actual
// distance instead, via the free Overpass API, so a spot just outside
// Statesboro's official limits still reads as "Statesboro, GA" rather
// than falling back to the county.
async function findNearestPlace(lat, lon, radiusM = 40000) {
  // overpass-api.de is a free, shared public instance that can be slow or
  // unreliable with zero warning. kumi.systems mirrors the same data — try
  // it second if the primary fails or comes back empty.
  const query = `[out:json][timeout:6];(node(around:${radiusM},${lat},${lon})[place~"^(city|town|village)$"];);out;`;
  const mirrors = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];

  for (const mirror of mirrors) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain', 'User-Agent': 'BoneTideCo/1.0' },
        body: query,
        signal: AbortSignal.timeout(7000),
      });
      if (!res.ok) {
        console.warn(`[location] Overpass ${mirror} returned HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const places = (data?.elements ?? []).filter(p => p.tags?.name);
      console.log(`[location] Overpass ${mirror} found ${places.length} named place(s)`);
      if (!places.length) continue;

      let nearestName = null;
      let nearestDist = Infinity;
      for (const p of places) {
        const d = haversineMeters(lat, lon, p.lat, p.lon);
        if (d < nearestDist) {
          nearestDist = d;
          nearestName = p.tags.name;
        }
      }
      return nearestName;
    } catch (err) {
      console.warn(`[location] Overpass ${mirror} failed:`, err.message);
    }
  }
  return null;
}

// Races a promise against a plain setTimeout instead of relying solely on
// AbortSignal.timeout() actually being wired through to the underlying
// native network request — on some RN/Expo setups that wiring is missing,
// so the abort signal gets created but never actually cancels anything,
// and the request just hangs until the native layer's own default timeout
// (often ~60s) gives up. This always resolves — never rejects — falling
// back to `fallback` if the real promise doesn't win the race in time, so
// callers never need their own try/catch just to handle a timeout.
function withTimeout(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      ()    => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

// Turns GPS coordinates into a human-readable "City, ST" label. This can
// involve up to three network calls (two Nominatim lookups, then Overpass
// as a last resort) and has nothing to do with tide/weather data, so it's
// deliberately a standalone function that load() fires without awaiting —
// it must never be allowed to block the rest of the screen from loading.
async function resolveLocationName(gpsLat, gpsLon) {
  try {
    const fetchAddress = async (zoom) => {
      const rgRes = await withTimeout(
        fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${gpsLat}&lon=${gpsLon}&format=json&zoom=${zoom}&addressdetails=1`,
          { headers: { 'User-Agent': 'BoneTideCo/1.0' } }
        ),
        5000,
        null
      );
      if (!rgRes) { console.warn(`[location] Nominatim zoom=${zoom} timed out or failed to fetch`); return {}; }
      if (!rgRes.ok) { console.warn(`[location] Nominatim zoom=${zoom} returned HTTP ${rgRes.status}`); return {}; }
      return (await rgRes.json()).address ?? {};
    };
    const placeFromAddress = (addr) =>
      addr.city || addr.town || addr.village || addr.hamlet || addr.suburb
      || addr.municipality || addr.city_district || addr.borough || addr.neighbourhood || null;

    // zoom=14 is precise but may land in unincorporated county land;
    // fall back to zoom=10 (city/town level) if no settlement name found
    let address = await fetchAddress(14);
    let placeName = placeFromAddress(address);
    console.log('[location] Nominatim zoom=14:', placeName ?? '(no place in address)', address);
    if (!placeName) {
      address = await fetchAddress(10);
      placeName = placeFromAddress(address);
      console.log('[location] Nominatim zoom=10:', placeName ?? '(no place in address)', address);
    }
    // Nominatim only ever returns a place whose polygon *contains* the
    // point — rural/unincorporated GPS points often fall outside every
    // city/town boundary even when a well-known town is right next door.
    // Find the nearest *named* settlement by actual distance instead.
    if (!placeName) {
      // Covers two sequential Overpass mirror attempts (~7s each) plus
      // network overhead, rather than cutting off before the second
      // mirror gets a fair shot.
      placeName = await withTimeout(findNearestPlace(gpsLat, gpsLon), 16000, null);
      console.log('[location] Overpass nearest place:', placeName ?? '(none found)');
    }

    const stCode = address ? abbreviateState(address.state) : null;
    maybeSetHomeState(stCode); // reuse the reverse-geocode we already did for regs
    if (placeName) {
      return stCode ? `${placeName}, ${stCode}` : placeName;
    }
    // Coordinates live in their own label right under this one (see
    // header render below), so there's no need to repeat them here.
    return stCode || 'Nearby waters';
  } catch {
    return 'Location unavailable';
  }
}

function todayLabel() {
  return new Date().toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// Map the server's solunar window to a short display label. '—' while loading.
function solunarLabel(window) {
  switch (window) {
    case 'major_peak': return 'Major';
    case 'major_near': return 'Near major';
    case 'minor_peak': return 'Minor';
    case 'minor_near': return 'Near minor';
    case 'between':    return 'Off-peak';
    default:           return '—';
  }
}

// Small subline under the Solunar tile: time the current window ends, or when
// the next one peaks.
function solunarSub(sol) {
  if (!sol || !sol.next) return undefined;
  const t = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sol.window === 'major_peak' || sol.window === 'minor_peak') return `til ${t(sol.next.end)}`;
  return `next ${t(sol.next.at)}`;
}

function fmt12(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function fmtHourOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric' });
}

function fmtDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  if (offsetDays === 0) return 'Today';
  if (offsetDays === 1) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function getNowFraction() {
  const n = new Date();
  return (n.getHours() * 3600 + n.getMinutes() * 60 + n.getSeconds()) / 86400;
}

function getPredictionsForDay(allPredictions, offsetDays) {
  if (!Array.isArray(allPredictions)) return [];
  const base = new Date();
  base.setDate(base.getDate() + offsetDays);
  const start = new Date(base); start.setHours(0, 0, 0, 0);
  const end   = new Date(base); end.setDate(end.getDate() + 1); end.setHours(0, 0, 0, 0);
  return allPredictions.filter(p => {
    const t = new Date(p.t);
    return t >= start && t < end;
  });
}

function buildChartData(predictions) {
  if (!predictions || predictions.length < 2) {
    return { linePath: '', fillPath: '', peaks: [], pts: [] };
  }
  const heights = predictions.map(p => parseFloat(p.v) || 0);
  const minH = Math.min(...heights);
  const maxH = Math.max(...heights);
  const range = maxH - minH || 1;

  const pts = predictions.map((p, i) => ({
    x: PAD + (i / (predictions.length - 1)) * (CHART_W - PAD * 2),
    y: CHART_H - PAD - ((parseFloat(p.v) - minH) / range) * (CHART_H - PAD * 2 - 10),
    v: parseFloat(p.v),
    t: p.t,
  }));

  let linePath = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const cpx = ((pts[i - 1].x + pts[i].x) / 2).toFixed(1);
    linePath += ` C ${cpx} ${pts[i - 1].y.toFixed(1)} ${cpx} ${pts[i].y.toFixed(1)} ${pts[i].x.toFixed(1)} ${pts[i].y.toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  const fillPath = `${linePath} L ${last.x.toFixed(1)} ${CHART_H} L ${pts[0].x.toFixed(1)} ${CHART_H} Z`;

  const peaks = pts.filter((p, i) => {
    if (i === 0 || i === pts.length - 1) return false;
    return (p.v > pts[i - 1].v && p.v > pts[i + 1].v)
        || (p.v < pts[i - 1].v && p.v < pts[i + 1].v);
  });

  return { linePath, fillPath, peaks, pts, midH: (minH + maxH) / 2 };
}


// ─────────────────────────────────────────────────────────────────────────────
// Wave Animation — 3-layer animated wave below radar with ship riding front wave
// ─────────────────────────────────────────────────────────────────────────────

function WaveAnimation() {
  const W = SW;    // one tile = full screen width
  const H = 56;    // strip height — taller so bottom layer is fully visible
  const SEGS = 80; // more points = smoother curve

  // ─── Seamless loop trick ─────────────────────────────────────────────────
  // cycles MUST be a whole number so wave value at x=0 === x=W (no seam).
  // We draw TWO tiles (SVG width = 2W), animate translateX 0 → -W, loop.
  // ────────────────────────────────────────────────────────────────────────

  const buildTilePath = React.useCallback((tileW, amp, cycles, phaseOffset) => {
    const step = tileW / SEGS;
    const pts = [];
    for (let i = 0; i <= SEGS; i++) {
      const x = i * step;
      const y = (H * 0.45) - amp * Math.sin((i / SEGS) * 2 * Math.PI * cycles + phaseOffset);
      pts.push([x, y]);
    }
    let d = `M ${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      const cpx = ((x0 + x1) / 2).toFixed(2);
      d += ` C ${cpx} ${y0.toFixed(2)} ${cpx} ${y1.toFixed(2)} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
    d += ` L ${tileW} ${H} L 0 ${H} Z`;
    return d;
  }, [H]);

  const buildDoublePath = React.useCallback((amp, cycles, phaseOffset) => ({
    tile1: buildTilePath(W, amp, cycles, phaseOffset),
    tile2: buildTilePath(W, amp, cycles, phaseOffset),
  }), [buildTilePath, W]);

  // Scroll offsets — one per layer (slower speeds)
  const offsetBack  = React.useRef(new Animated.Value(0)).current;
  const offsetMid   = React.useRef(new Animated.Value(0)).current;
  const offsetFront = React.useRef(new Animated.Value(0)).current;



  React.useEffect(() => {
    // Scroll animations — nice and slow
    const makeScroll = (val, duration) =>
      Animated.loop(
        Animated.timing(val, {
          toValue: -W,
          duration,
          useNativeDriver: true,
          easing: (t) => t,
        })
      );

    const a1 = makeScroll(offsetBack,  18000);
    const a2 = makeScroll(offsetMid,   13000);
    const a3 = makeScroll(offsetFront,  8500);

    a1.start(); a2.start(); a3.start();
    return () => {
      a1.stop(); a2.stop(); a3.stop();
    };
  }, []);

  const renderLayer = (animVal, amp, cycles, phaseOffset, color, opacity) => {
    const { tile1, tile2 } = buildDoublePath(amp, cycles, phaseOffset);
    return (
      <Animated.View
        style={{
          position: 'absolute',
          top: 0, left: 0,
          width: W * 2,
          height: H,
          transform: [{ translateX: animVal }],
        }}
      >
        <Svg width={W * 2} height={H}>
          <Path d={tile1} fill={color} opacity={opacity} />
          <Path d={tile2} fill={color} opacity={opacity} x={W} />
        </Svg>
      </Animated.View>
    );
  };

  return (
    <View style={{ width: '100%', height: H, overflow: 'hidden' }}>
      {/* Back — slowest, deepest, darkest */}
      {renderLayer(offsetBack,  10, 2, 0.0,  '#152d45', 0.75)}
      {/* Mid — medium speed, slightly overlaps back */}
      {renderLayer(offsetMid,    8, 2, 1.05, '#1E4D6B', 0.80)}
      {/* Front — fastest, brightest, ship rides this one */}
      {renderLayer(offsetFront,  5, 3, 2.09, '#2E6E96', 0.90)}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────


// ─── Station Search Modal ─────────────────────────────────────────────────────

async function searchNoaaStations(query) {
  try {
    const [geoRes, stRes] = await Promise.all([
      fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=3&countrycodes=us`,
        { headers: { 'User-Agent': 'BoneTideCo/1.0' }, signal: AbortSignal.timeout(5000) }
      ),
      fetch(
        'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=waterlevels&units=english',
        { signal: AbortSignal.timeout(5000) }
      ),
    ]);
    const geoData = await geoRes.json();
    const stData  = await stRes.json();
    if (!stData.stations?.length) return [];
    const results = [];
    for (const geo of (geoData ?? []).slice(0, 3)) {
      const gLat = parseFloat(geo.lat), gLon = parseFloat(geo.lon);
      let nearest = null, minKm = Infinity;
      for (const st of stData.stations) {
        const dLat = (st.lat - gLat) * Math.PI / 180;
        const dLon = (st.lng - gLon) * Math.PI / 180;
        const a = Math.sin(dLat/2)**2 + Math.cos(gLat*Math.PI/180)*Math.cos(st.lat*Math.PI/180)*Math.sin(dLon/2)**2;
        const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        if (km < minKm) { minKm = km; nearest = st; }
      }
      if (nearest && !results.find(r => r.id === nearest.id)) {
        const place = geo.display_name.split(',').slice(0, 2).join(',').trim();
        // Show the place the user searched for as the name, NOAA station as subtitle
        results.push({
          id: nearest.id,
          name: place,                    // what user searched — "Tybee Island, GA"
          stationName: nearest.name,      // actual NOAA station — "Fort Pulaski"
          sub: nearest.name,
          distMi: Math.round(minKm * 0.621),
          lat: nearest.lat,
          lon: nearest.lng,
        });
      }
    }
    const q = query.toLowerCase();
    stData.stations
      .filter(st => (st.name.toLowerCase().includes(q) || st.id.includes(q)) && !results.find(r => r.id === st.id))
      .slice(0, 4)
      .forEach(st => results.push({ id: st.id, name: st.name, lat: st.lat, lon: st.lng }));
    return results.slice(0, 8);
  } catch { return []; }
}

function StationSearchModal({ visible, onClose, onSelect, favorites, onToggleFavorite }) {
  const [query,   setQuery]   = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => { if (!visible) { setQuery(''); setResults([]); } }, [visible]);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      const res = await searchNoaaStations(query.trim());
      setResults(res);
      setLoading(false);
    }, 400);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const isFav = (id) => favorites.some(f => f.id === id);

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: COLORS.bgDeep }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={ssm.header}>
          <TouchableOpacity onPress={onClose}><Text style={ssm.cancel}>Cancel</Text></TouchableOpacity>
          <Text style={ssm.title}>Tide Station</Text>
          <View style={{ width: 60 }} />
        </View>
        <View style={ssm.inputRow}>
          <Text style={{ fontSize: 14, marginRight: 6 }}>🔍</Text>
          <TextInput
            style={ssm.input}
            placeholder="Tybee Island, Daytona, St. Simons…"
            placeholderTextColor={COLORS.textGhost}
            value={query}
            onChangeText={setQuery}
            autoFocus
            autoCapitalize="words"
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} style={{ padding: 6 }}>
              <Text style={{ fontSize: 12, color: COLORS.textGhost }}>✕</Text>
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity style={ssm.gpsRow} onPress={() => onSelect(null)}>
          <Text style={{ fontSize: 18 }}>📍</Text>
          <View style={{ flex: 1 }}>
            <Text style={ssm.gpsLabel}>Use my GPS location</Text>
            <Text style={ssm.gpsSub}>Auto-detect nearest NOAA station</Text>
          </View>
          <Text style={{ color: COLORS.rust, fontSize: 16 }}>→</Text>
        </TouchableOpacity>
        {favorites.length > 0 && !query.trim() && (
          <>
            <Text style={ssm.sectionLabel}>⭐  Saved Stations</Text>
            {favorites.map(fav => (
              <TouchableOpacity key={fav.id} style={ssm.resultRow} onPress={() => onSelect(fav)}>
                <View style={{ flex: 1 }}>
                  <Text style={ssm.resultName}>{fav.name}</Text>
                  <Text style={ssm.resultSub}>#{fav.id}</Text>
                </View>
                <TouchableOpacity onPress={() => onToggleFavorite(fav)} style={{ padding: SPACING.sm }}>
                  <Text style={{ fontSize: 18 }}>⭐</Text>
                </TouchableOpacity>
              </TouchableOpacity>
            ))}
          </>
        )}
        {loading && <ActivityIndicator color={COLORS.rust} style={{ marginTop: 24 }} />}
        {!loading && query.trim().length > 0 && results.length === 0 && (
          <Text style={ssm.empty}>No stations found — try a nearby city or waterway</Text>
        )}
        {!loading && results.length > 0 && (
          <>
            <Text style={ssm.sectionLabel}>Nearest NOAA Stations</Text>
            <FlatList
              data={results}
              keyExtractor={r => r.id}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => (
                <TouchableOpacity style={ssm.resultRow} onPress={() => onSelect(item)}>
                  <View style={{ flex: 1 }}>
                    <Text style={ssm.resultName}>{item.name}</Text>
                    <Text style={ssm.resultSub}>{item.stationName ? `Tide station: ${item.stationName}` : `#${item.id}`}{item.distMi ? ` · ${item.distMi} mi away` : ''}</Text>
                  </View>
                  <TouchableOpacity onPress={() => onToggleFavorite(item)} style={{ padding: SPACING.sm }}>
                    <Text style={{ fontSize: 18 }}>{isFav(item.id) ? '⭐' : '☆'}</Text>
                  </TouchableOpacity>
                </TouchableOpacity>
              )}
            />
          </>
        )}
      </KeyboardAvoidingView>
    </Modal>
  );
}

const ssm = StyleSheet.create({
  header:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: SPACING.md, borderBottomWidth: 0.5, borderColor: COLORS.border },
  cancel:      { fontSize: 14, color: COLORS.textMuted },
  title:       { fontSize: 16, color: COLORS.boneWhite, fontWeight: '700' },
  inputRow:    { flexDirection: 'row', alignItems: 'center', margin: SPACING.md, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.md, borderWidth: 0.5, borderColor: COLORS.border, paddingHorizontal: SPACING.sm },
  input:       { flex: 1, color: COLORS.boneWhite, fontSize: 14, paddingVertical: 10 },
  gpsRow:      { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: 12, borderBottomWidth: 0.5, borderColor: COLORS.border, backgroundColor: COLORS.navyDark + '55' },
  gpsLabel:    { fontSize: 14, color: COLORS.boneWhite, fontWeight: '600' },
  gpsSub:      { fontSize: 10, color: COLORS.textGhost, marginTop: 1 },
  sectionLabel:{ fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, paddingHorizontal: SPACING.md, paddingTop: SPACING.md, paddingBottom: 4 },
  resultRow:   { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.md, paddingVertical: 12, borderBottomWidth: 0.5, borderColor: COLORS.borderFaint },
  resultName:  { fontSize: 14, color: COLORS.boneWhite, fontWeight: '500' },
  resultSub:   { fontSize: 10, color: COLORS.textDim, marginTop: 2 },
  empty:       { color: COLORS.textMuted, textAlign: 'center', padding: SPACING.xl, fontSize: 13 },
});






// ─────────────────────────────────────────────────────────────────────────────
// Radar HTML — MapLibre + RainViewer animated NEXRAD radar
// RainViewer API fetched from React Native, frames injected into WebView
// ─────────────────────────────────────────────────────────────────────────────

function getRadarHtml(lat, lon) {
  return `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link href="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css" rel="stylesheet">
<script src="https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/lottie-web/5.12.2/lottie.min.js"></script>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html,body,#map { width:100%; height:100%; overflow:hidden; }
.maplibregl-ctrl-attrib,.maplibregl-ctrl-logo,.maplibregl-ctrl-group { display:none !important; }
</style>
</head>
<body>
<div id="map"></div>
<script>
window.onerror = function(){ return true; };

var map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/bright',
  center: [${lon}, ${lat}],
  zoom: 6,
  minZoom: 3,
  attributionControl: false
});

var radarFrames = [], currentIdx = 0, playing = false, animTimer = null;
var lottieFlagLoaded = false;

map.on('load', function() {
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({type:'mapReady'}));
});

var RADAR_COORDS = [[-98,48],[-62,48],[-62,24],[-98,24]];

function loadFrames(frames) {
  if (!frames || !frames.length) return;
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  radarFrames = frames; playing = false;
  var loaded = 0;
  frames.forEach(function(f) {
    var img = new Image();
    img.onload = img.onerror = function() {
      loaded++;
      if (loaded === frames.length) { showFrame(0); playing = true; startAnim(); }
    };
    img.src = f.tileUrl;
  });
  setTimeout(function() { if (!playing) { showFrame(0); playing = true; startAnim(); } }, 6000);
}

function showFrame(idx) {
  if (!radarFrames[idx]) return;
  var url = radarFrames[idx].tileUrl;
  try {
    if (map.getSource('radar-src')) {
      map.getSource('radar-src').updateImage({ url: url });
    } else {
      map.addSource('radar-src', { type: 'image', url: url, coordinates: RADAR_COORDS });
      map.addLayer({ id: 'radar-lyr', type: 'raster', source: 'radar-src', paint: { 'raster-opacity': 0.85 } });
    }
  } catch(e) {}
  currentIdx = idx;
  var f = radarFrames[idx];
  window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
    type: 'radarTime', time: f.time, idx: idx, total: radarFrames.length, isForecast: !!f.isForecast
  }));
}

function startAnim() {
  if (animTimer) clearInterval(animTimer);
  animTimer = setInterval(function() {
    if (!playing || !radarFrames.length) return;
    var next = (currentIdx + 1) % radarFrames.length;
    showFrame(next);
    if (next === radarFrames.length - 1) { playing = false; setTimeout(function() { playing = true; }, 1500); }
  }, 900);
}

function addUserMarker(animData) {
  var wrapper = document.createElement('div');
  wrapper.style.cssText = 'width:44px;height:44px;';
  if (animData && window.lottie) {
    window.lottie.loadAnimation({ container: wrapper, renderer: 'svg', loop: true, autoplay: true, animationData: animData });
  } else {
    wrapper.textContent = '📍';
  }
  new maplibregl.Marker({ element: wrapper, anchor: 'bottom' }).setLngLat([${lon}, ${lat}]).addTo(map);
}

function handleMsg(e) {
  try {
    var msg = JSON.parse(e.data);
    if (msg.type === 'loadFrames')  { loadFrames(msg.frames); }
    if (msg.type === 'scrubRadar')  { playing = false; showFrame(msg.idx); }
    if (msg.type === 'playRadar')   { playing = msg.playing; if (playing) startAnim(); }
    if (msg.type === 'initFlag' && !lottieFlagLoaded) { lottieFlagLoaded = true; addUserMarker(msg.animData); }
  } catch(err) {}
}
document.addEventListener('message', handleMsg);
window.addEventListener('message', handleMsg);
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// RadarCard — fetches RainViewer from RN (no CORS issues), injects into WebView
// ─────────────────────────────────────────────────────────────────────────────

function RadarCard({ lat, lon }) {
  const webViewRef = useRef(null);
  const [radarTime,       setRadarTime]       = useState(null);
  const [radarIdx,        setRadarIdx]        = useState(0);
  const [radarTotal,      setRadarTotal]      = useState(0);
  const [radarIsForecast, setRadarIsForecast] = useState(false);
  const [radarPlaying,    setRadarPlaying]    = useState(false);
  const [radarLoaded,     setRadarLoaded]     = useState(false);
  const [zoomWarning,     setZoomWarning]     = useState(false);

  const sendToWebView = (obj) => {
    const json = JSON.stringify(obj).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    webViewRef.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message',{data:'${json}'}));true;`
    );
  };

  const fetchAndInjectRadar = () => {
    const frames = [];
    const now = new Date();
    const roundedMs = Math.floor(now.getTime() / (5 * 60 * 1000)) * (5 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    for (let i = 11; i >= 0; i--) {
      const d = new Date(roundedMs - i * 5 * 60 * 1000);
      const isoTime = d.toISOString().replace('.000Z', 'Z');
      const tileUrl = `https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=nexrad-n0q-wmst&STYLES=&FORMAT=image/png&TRANSPARENT=TRUE&TIME=${encodeURIComponent(isoTime)}&SRS=EPSG:3857&WIDTH=1800&HEIGHT=1506&BBOX=-10909310.1,2753408.1,-6901808.4,6106854.8`;
      frames.push({ time: Math.floor(d.getTime() / 1000), tileUrl, isForecast: false });
    }
    sendToWebView({ type: 'loadFrames', frames });
  };

  const handleMessage = (e) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg.type === 'mapReady') {
        // Map is loaded — fetch radar from RN and inject frames
        fetchAndInjectRadar();
        // Inject location pin animation after CDN loads
        setTimeout(() => {
          const animData = require('./assets/animations/radarlocationpin.json');
          sendToWebView({ type: 'initFlag', animData });
        }, 2000);
      }
      if (msg.type === 'radarTime') {
        setRadarTime(msg.time);
        setRadarIdx(msg.idx);
        setRadarTotal(msg.total);
        setRadarIsForecast(!!msg.isForecast);
        setRadarPlaying(true);
        setRadarLoaded(true);
      }
    } catch {}
  };

  const handleScrub = (idx) => {
    setRadarIdx(idx);
    setRadarPlaying(false);
    sendToWebView({ type: 'scrubRadar', idx });
  };

  const handleScrubEnd = () => {
    setRadarPlaying(true);
    sendToWebView({ type: 'playRadar', playing: true });
  };

  const handleTogglePlay = () => {
    const next = !radarPlaying;
    setRadarPlaying(next);
    sendToWebView({ type: 'playRadar', playing: next });
  };

  const fmtTime = (ts) => ts
    ? new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '—';

  const isLive = radarIdx === radarTotal - 1 && !radarIsForecast;
  const html   = React.useMemo(() => getRadarHtml(lat ?? 31.12, lon ?? -81.46), [lat, lon]);

  return (
    <View style={rc.card}>
      {/* Header */}
      <View style={rc.header}>
        <View style={rc.nexradBadge}>
          <View style={rc.nexradDot} />
          <Text style={rc.nexradText}>NEXRAD</Text>
          <Text style={rc.radarTitle}>Quick Radar</Text>
        </View>
        {radarTime != null && (
          <View style={[rc.timeBadge, radarIsForecast && rc.timeBadgeForecast]}>
            <Text style={[rc.timeBadgeText, radarIsForecast && rc.timeBadgeTextForecast]}>
              {radarIsForecast ? `FCST · ${fmtTime(radarTime)}` : `${fmtTime(radarTime)}${isLive ? ' · LIVE' : ''}`}
            </Text>
          </View>
        )}
      </View>

      {/* Map WebView */}
      <WebView
        ref={webViewRef}
        style={rc.map}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled
        originWhitelist={['*']}
        scrollEnabled={false}
        bounces={false}
        onMessage={handleMessage}
      />

      {/* Cloud animation overlay — covers full map while loading */}
      {!radarLoaded && (
        <View style={rc.radarLoader} pointerEvents="none">
          <LottieView
            source={require('./assets/animations/cloudanimation.json')}
            autoPlay
            loop
            style={{ width: 180, height: 180 }}
            resizeMode="contain"
          />
          <Text style={rc.radarLoaderText}>Loading radar...</Text>
        </View>
      )}

      {/* Scrubber */}
      {radarTotal > 0 && (
        <RadarScrubberBar
          total={radarTotal}
          currentIdx={radarIdx}
          playing={radarPlaying}
          onScrub={handleScrub}
          onScrubEnd={handleScrubEnd}
          onTogglePlay={handleTogglePlay}
        />
      )}
    </View>
  );
}

// Inline scrubber with play/pause button and breathing room around the track
function RadarScrubberBar({ total, currentIdx, playing, onScrub, onScrubEnd, onTogglePlay }) {
  const pct = total > 1 ? currentIdx / (total - 1) : 0;
  // trackWidth matches the flex:1 container minus its horizontal padding
  const trackWidth = SW - 48 - 24 - 28 - 10; // screen - card margins - scrubWrap padding - playBtn - gap
  const shipLeft   = Math.max(0, Math.round(pct * trackWidth) - 26);

  const isScrubbing = React.useRef(false);

  return (
    <View style={rc.scrubWrap}>

      {/* Play/pause */}
      <TouchableOpacity style={rc.playBtn} onPress={onTogglePlay}>
        <Text style={rc.playBtnText}>{playing ? '⏸' : '▶'}</Text>
      </TouchableOpacity>

      {/* Wave + ship track — overflow visible so ship doesn't clip at edges */}
      <View
        style={rc.scrubTouchTarget}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={(e) => {
          isScrubbing.current = true;
          const x = e.nativeEvent.locationX;
          const p = Math.max(0, Math.min(1, x / trackWidth));
          onScrub(Math.round(p * (total - 1)));
        }}
        onResponderMove={(e) => {
          if (!isScrubbing.current) return;
          const x = e.nativeEvent.locationX;
          const p = Math.max(0, Math.min(1, x / trackWidth));
          onScrub(Math.round(p * (total - 1)));
        }}
        onResponderRelease={() => { isScrubbing.current = false; onScrubEnd && onScrubEnd(); }}
        onResponderTerminate={() => { isScrubbing.current = false; onScrubEnd && onScrubEnd(); }}
      >
        {/* Wave background */}
        <LottieView
          source={require('./assets/animations/BottomWave.json')}
          autoPlay
          loop
          style={rc.waveAnim}
          resizeMode="cover"
        />

        {/* Ship — positioned directly from pct, no animation */}
        <View style={[rc.shipAnimWrap, { left: shipLeft }]}>
          <LottieView
            source={require('./assets/animations/scrubbership.json')}
            autoPlay
            loop
            style={{ width: 52, height: 52 }}
            resizeMode="contain"
          />
        </View>
      </View>
    </View>
  );
}

const rc = StyleSheet.create({
  card:              { marginHorizontal: SPACING.sm, marginTop: SPACING.xs, marginBottom: SPACING.xs, borderRadius: RADIUS.lg, overflow: 'hidden', borderWidth: 0.5, borderColor: COLORS.border, backgroundColor: COLORS.navyDark },
  header:            { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.sm, paddingVertical: 8, gap: 8, backgroundColor: COLORS.bgDark },
  nexradBadge:       { flexDirection: 'row', alignItems: 'center', gap: 5, flex: 1 },
  nexradDot:         { width: 6, height: 6, borderRadius: 3, backgroundColor: COLORS.green },
  nexradText:        { color: COLORS.green, fontSize: 9, fontWeight: '700', letterSpacing: 1.2 },
  radarTitle:        { fontSize: 13, color: COLORS.boneWhite, fontFamily: 'BoneTideCo', letterSpacing: 0.4 },
  zoomBanner:        { backgroundColor: 'rgba(195,82,51,0.15)', borderBottomWidth: 0.5, borderColor: 'rgba(195,82,51,0.4)', paddingHorizontal: SPACING.sm, paddingVertical: 6 },
  zoomBannerText:    { fontSize: 11, color: '#E87A5D', textAlign: 'center' },
  timeBadge:         { backgroundColor: 'rgba(90,159,224,0.15)', borderWidth: 0.5, borderColor: 'rgba(90,159,224,0.4)', borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3 },
  timeBadgeForecast: { backgroundColor: 'rgba(195,82,51,0.15)', borderColor: 'rgba(195,82,51,0.4)' },
  timeBadgeText:     { color: '#5a9fe0', fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace' },
  timeBadgeTextForecast: { color: '#E87A5D' },
  playBtn:           { backgroundColor: 'rgba(195,82,51,0.2)', borderWidth: 0.5, borderColor: COLORS.rust, borderRadius: 5, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' },
  playBtnText:       { color: COLORS.rust, fontSize: 12 },
  map:               { width: '100%', height: 340 },
  radarLoader:       { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(10,17,40,0.6)' },
  radarLoaderText:   { color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 4, letterSpacing: 0.5 },
  scrubWrap:         { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, backgroundColor: COLORS.bgDark },
  scrubTouchTarget:  { flex: 1, height: 52, justifyContent: 'center', position: 'relative', borderRadius: RADIUS.sm },
  waveAnim:          { position: 'absolute', left: 0, right: 0, bottom: 0, height: 52, opacity: 0.55, borderRadius: RADIUS.sm, overflow: 'hidden' },
  shipAnimWrap:      { position: 'absolute', bottom: 0, width: 52, height: 52 },
});

// ─────────────────────────────────────────────────────────────────────────────

export default function HomeScreen() {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation();

  const homeStationId        = useAppStore(s => s.homeStationId);
  const homeStationName      = useAppStore(s => s.homeStationName);
  const jwtToken             = useAppStore(s => s.jwtToken);
  const user                 = useAppStore(s => s.user);
  const anglerName           = useAppStore(s => s.anglerName);
  const homeFirstName = ((user?.name || anglerName || '').trim().split(/\s+/)[0]) || 'Captain';
  const HOME_GREETINGS = [
    `Welcome back, ${homeFirstName}`,
    `Tight lines, ${homeFirstName}`,
    `The tide's calling, ${homeFirstName}`,
    `Let's get 'em, ${homeFirstName}`,
    `Fish on, ${homeFirstName}`,
    `Back at it, ${homeFirstName}`,
    `Ready to reel, ${homeFirstName}?`,
    `Good to see you, ${homeFirstName}`,
    `Reds are waiting, ${homeFirstName}`,
    `Salt in the air, ${homeFirstName}`,
    `Bend a rod today, ${homeFirstName}`,
    `The bite's on, ${homeFirstName}`,
    `Chase the tide, ${homeFirstName}`,
    `Screaming drags, ${homeFirstName}`,
    `Let's find fish, ${homeFirstName}`,
    `Wind's right, ${homeFirstName}`,
    `Go get 'em, ${homeFirstName}`,
    `Time to fish, ${homeFirstName}`,
    `Ahoy, ${homeFirstName}`,
    `Water's calling, ${homeFirstName}`,
    `Feelin' fishy, ${homeFirstName}?`,
    `Make it count, ${homeFirstName}`,
    `Send it, ${homeFirstName}`,
    `Big ones today, ${homeFirstName}`,
    `Rise and grind, ${homeFirstName}`,
    `Hook 'em, ${homeFirstName}`,
    `Fair winds, ${homeFirstName}`,
    `Trophy day, ${homeFirstName}?`,
    `Get on the water, ${homeFirstName}`,
    `Let 'em run, ${homeFirstName}`,
    `Catch of the day, ${homeFirstName}`,
    `On the hunt, ${homeFirstName}`,
    `Slack tide soon, ${homeFirstName}`,
    `Line's ready, ${homeFirstName}`,
  ];
  const homeGreeting = HOME_GREETINGS[
    (new Date().getDate() + new Date().getHours()) % HOME_GREETINGS.length
  ];
  // Daily login: claim once per mount for signed-in users. The server is
  // idempotent per day (alreadyClaimed), so re-mounts are harmless. Streak
  // rings and the welcome ring arrive here and pop the celebration.
  useEffect(() => {
    if (!user?.id && !user?.email) return;
    let alive = true;
    claimDailyLogin()
      .then((r) => {
        if (!alive) return;
        // True server balance on every app open - the bar can never sit stale
        // at 0 while the database says otherwise.
        if (typeof r?.pointsBalance === 'number') useAppStore.getState().setPointsBalance(r.pointsBalance);
        if (Array.isArray(r?.ringsEarned) && r.ringsEarned.length) {
          setEarnedRings(r.ringsEarned);
        }
      })
      .catch(() => {}); // guests / offline / auth hiccups: silent, never blocks Home
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Hydrate the shared ring store from the server once the user is known.
  useEffect(() => {
    if (user?.id || user?.email) hydrateRingStore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Sync cachedAvatar whenever Zustand user updates
  useEffect(() => {
    if (user?.avatar) setCachedAvatar(user.avatar);
  }, [user?.avatar]);
  const addPoints            = useAppStore(s => s.addPoints);
  const regionKey            = useAppStore(s => s.regionKey);
  const targetSpecies        = useAppStore(s => s.targetSpecies);
  const conditions           = useAppStore(s => s.conditions);
  const [userLat,           setUserLat]           = useState(null);
  const [userLon,           setUserLon]           = useState(null);
  const [showStationSearch, setShowStationSearch] = useState(false);
  const [infoModal, setInfoModal] = useState(null); // { title, body } or null
  const [stationFavorites,  setStationFavorites]  = useState([]);
  const [activeStation,     setActiveStation]     = useState(null);
  const [gpsLocationName,   setGpsLocationName]   = useState(null); // human-readable GPS location

  // Load persisted station prefs on mount
  useEffect(() => {
    async function loadStationPrefs() {
      try {
        const [favRaw, lastRaw] = await Promise.all([
          AsyncStorage.getItem('btc_station_favorites'),
          AsyncStorage.getItem('btc_last_station'),
        ]);
        if (favRaw) setStationFavorites(JSON.parse(favRaw));
        if (lastRaw) setActiveStation(JSON.parse(lastRaw));
      } catch {}
    }
    loadStationPrefs();
  }, []);
  const setConditions        = useAppStore(s => s.setConditions);
  const goodBiteScore        = useAppStore(s => s.goodBiteScore);
  const goodBiteLabel        = useAppStore(s => s.goodBiteLabel);
  const setGoodBite          = useAppStore(s => s.setGoodBite);
  const currentTideHeight    = useAppStore(s => s.currentTideHeight);
  const currentTideDirection = useAppStore(s => s.currentTideDirection);
  const setTidePredictions   = useAppStore(s => s.setTidePredictions);
  const setCurrentTide       = useAppStore(s => s.setCurrentTide);
  const tidePredictions      = useAppStore(s => s.tidePredictions);

  const [loading,       setLoading]       = useState(true);
  const [cachedAvatar,  setCachedAvatar]  = useState(() => _cachedAvatarUrl);
  // Exact NOAA high/low events (true minute + H/L type) from the server's
  // hilo fetch — drives the High/Low cards instead of hourly-sample peaks.
  const [tideExtremes, setTideExtremes] = useState([]);
  // Rings earned from the daily login claim — fed to the popup.
  const [earnedRings, setEarnedRings] = useState([]);
  // My equipped ring + club rope, from the shared store: any equip anywhere
  // in the app updates this avatar (and every other own-avatar) instantly.
  const myRing = useRingStore(st => st.equippedRing);
  const myBadge = useRingStore(st => st.clubBadge);
  const [refreshing,    setRefreshing]    = useState(false);
  const [waveMounted,   setWaveMounted]   = useState(false);
  const [marineData,    setMarineData]    = useState(null);
  const [recentCatches, setRecentCatches] = useState([]);
  const [error,         setError]         = useState(null);
  const [biteBreakdown, setBiteBreakdown] = useState(null);
  const [activeDay,     setActiveDay]     = useState(0);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const waterFade = useRef(new Animated.Value(1)).current;
  const [showLoader, setShowLoader] = useState(true);
  const loadStartTime = useRef(Date.now());

  // Pull-to-refresh wave: track overscroll so the wave fades/slides in as the
  // user pulls down, then holds + loops while the refresh loads.
  const scrollY = useRef(new Animated.Value(0)).current;
  const onScroll = useRef(
    Animated.event(
      [{ nativeEvent: { contentOffset: { y: scrollY } } }],
      {
        useNativeDriver: true,
        listener: (e) => {
          const show = e.nativeEvent.contentOffset.y < -6;
          setWaveMounted(prev => (prev === show ? prev : show));
        },
      }
    )
  ).current;
  const waveOpacity = scrollY.interpolate({ inputRange: [-70, -15, 0], outputRange: [1, 0.15, 0], extrapolate: 'clamp' });
  const waveShift   = scrollY.interpolate({ inputRange: [-90, 0], outputRange: [10, -8], extrapolate: 'clamp' });

  async function load(silent, overrideStation) {
    if (!silent) setLoading(true);
    setError(null);
    try {
      // Always get GPS for conditions, marine, and catch logging
      let gpsLat = 31.1234, gpsLon = -81.4567;
      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          // Cap the GPS fix — getCurrentPositionAsync has no timeout of its
          // own and can hang for many seconds on a cold start or indoors,
          // freezing the entire load behind it. If the fresh fix is slow, fall
          // back to the last known position (instant) so the screen keeps moving.
          let pos = await withTimeout(
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            6000,
            null
          );
          if (!pos) pos = await Location.getLastKnownPositionAsync().catch(() => null);
          if (pos) {
            gpsLat = pos.coords.latitude;
            gpsLon = pos.coords.longitude;
            setUserLat(gpsLat);
            setUserLon(gpsLon);
            useAppStore.getState().setUserLocation(gpsLat, gpsLon);
            // Resolve the city name in the background — this is a display
            // label only, not data the rest of the screen depends on, so it
            // must never hold up tide/conditions/marine loading. The header
            // updates on its own whenever this resolves, whether that's
            // instant or takes a few seconds.
            resolveLocationName(gpsLat, gpsLon).then(setGpsLocationName);
          } else {
            setGpsLocationName('Finding location…');
          }
        } else {
          // Permission denied — make this explicit and actionable instead
          // of silently leaving the location blank.
          setGpsLocationName('Enable location for local data');
        }
      } catch (gpsErr) {
        console.warn('[HomeScreen] GPS fetch failed, using fallback coords:', gpsErr.message);
        setGpsLocationName('Location unavailable');
      }

      // Tide station — use favorite/selected station or find nearest to GPS.
      // No hardcoded default: if we can't resolve a real station (no saved
      // preference, no GPS-derived nearest station), we leave stationId null
      // and skip the tides fetch entirely rather than silently defaulting to
      // one specific station's data for every user.
      let stationId = homeStationId || null;
      const station = overrideStation !== undefined ? overrideStation : activeStation;
      if (station) {
        stationId = station.id;
      } else if (!stationId) {
        try {
          // Capped the same way as the geocoding calls above — a slow or
          // hung nearest-station lookup shouldn't be able to hold up the
          // rest of the screen either.
          const nearest = await withTimeout(fetchNearestStation(gpsLat, gpsLon), 5000, null);
          if (nearest?.id) stationId = nearest.id;
        } catch {}
      }

      // Conditions and marine always use real GPS — not station coords.
      // Each call is capped with withTimeout, which ALWAYS resolves (to its
      // fallback on error/timeout). That matters: before this, a single 500 or
      // hang on the tide route would reject the whole Promise.all and throw out
      // the conditions + marine results too — which is exactly the "tide chart
      // is blank AND we lost a bunch of other data" symptom.
      const t0 = Date.now();
      const [tideData, cond, marine] = await Promise.all([
        stationId
          ? withTimeout(fetchTidePredictions(stationId, 7), 12000, { available: false, reason: 'timeout', predictions: [] })
          : Promise.resolve({ available: false, reason: 'no_station_selected', predictions: [] }),
        withTimeout(fetchConditions(gpsLat, gpsLon), 12000, null),
        withTimeout(fetchMarine(gpsLat, gpsLon), 12000, null),
      ]);

      // Diagnostic (dev only): how long the batch took + the exact shape each
      // endpoint returned. This tells us which call is slow and whether the
      // server rewrite changed the response shape (e.g. predictions missing or
      // renamed → blank tide curve). Read it in your Metro / Expo logs.
      if (__DEV__) {
        const preds = Array.isArray(tideData?.predictions)
          ? tideData.predictions.length
          : `(${typeof tideData?.predictions})`;
        console.log(`[BTC] home load ${Date.now() - t0}ms`, {
          station:       stationId,
          tideKeys:      tideData ? Object.keys(tideData) : null,
          tideAvailable: tideData?.available,
          tidePreds:     preds,
          conditions:    cond ? Object.keys(cond) : 'null/failed',
          marine:        marine ? Object.keys(marine) : 'null/failed',
        });
      }

      if (tideData.available === false) {
        // No usable tide data — clear predictions so the UI shows its
        // empty/prompt state instead of stale or misleading numbers.
        setTidePredictions([]);
        setTideExtremes([]);
        setCurrentTide(null, null);
        if (tideData.reason === 'station_unsupported') {
          console.warn(`[HomeScreen] Station ${tideData.stationId} has no live predictions support.`);
        }
      } else {
        setTidePredictions(tideData.predictions ?? []);
        setTideExtremes(Array.isArray(tideData.extremes) ? tideData.extremes : []);
        setCurrentTide(tideData.currentHeight, tideData.currentDirection);
      }
      setConditions(cond);
      setMarineData(marine);
      if (cond) {
        const result = computeGoodBite({
          tidePhase:         tideData.currentPhase    ?? 'slack_low',
          tideRangeFt:       tideData.dailyRange      ?? 6,
          waterHeightCat:    'optimal',
          baroTrend:         cond.pressure?.trend     ?? 'stable',
          baroAbsCat:        'normal',
          windSpeedCategory: cond.wind?.speedCategory ?? 'light',
          windDirection:     cond.wind?.direction     ?? 'SE',
          solunarWindow:     cond.solunar?.window     ?? 'between',
          moonPhase:         cond.solunar?.moonPhase  ?? 'other',
          lightWindow:       cond.solunar?.lightWindow ?? 'other',
        }, regionKey || 'southeast', (targetSpecies && targetSpecies[0]) || 'redfish');
        setGoodBite(result.score, result.label);
        setBiteBreakdown(result.breakdown);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setRefreshing(false);
      // Hold until the water animation has fully risen (~2202ms play time), then
      // mount HomeScreen underneath and fade the whole loader overlay (image +
      // water) away — the water dissolves straight into Home, no image reappearing.
      const elapsed = Date.now() - loadStartTime.current;
      const remaining = Math.max(0, 2200 - elapsed);
      setTimeout(() => {
        // Home mounts behind the loader and is already visible.
        setLoading(false);
        fadeAnim.setValue(1);
        Animated.timing(waterFade, { toValue: 0, duration: 600, useNativeDriver: true }).start(() => {
          setShowLoader(false); // unmount the loader overlay once fully faded
        });
      }, remaining);
    }
  }

  // Pre-load avatar from persisted user so it shows instantly on mount
  useEffect(() => {
    AsyncStorage.getItem('btc_user').then(raw => {
      if (!raw) return;
      try {
        const saved = JSON.parse(raw);
        if (saved?.avatar) setCachedAvatar(saved.avatar);
      } catch {}
    });
  }, []);

  useEffect(() => { load(false); }, []);

  // Claim birthday-month points bonus, if applicable (no-op for guests or
  // if already claimed this year — server handles idempotency)
  useEffect(() => {
    if (!jwtToken) return;
    (async () => {
      try {
        const res = await fetch(`${BTC_API}/api/auth/birthday-bonus/claim`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${jwtToken}` },
        });
        const data = await res.json();
        if (data.awarded) {
          addPoints(data.points);
          Alert.alert('🎂 Happy Birthday Month!', `Bone Tide Co. dropped ${data.points} pts in your account. Tight lines!`);
        }
      } catch {}
    })();
  }, [jwtToken]);

  // Pull the latest few catches for the Home strip. Extracted so it can run on
  // mount, on pull-to-refresh, AND whenever Home regains focus — that last one
  // is what makes a catch you just logged on another screen show up here without
  // a manual reload.
  const refreshRecentCatches = useCallback(async () => {
    try {
      const data = await fetchCatches({ page: 1, limit: 3 });
      const list = data.catches ?? [];
      if (__DEV__ && list[0]) {
        console.log('[BTC] recent catch sample →', {
          keys: Object.keys(list[0]),
          imageUrl: list[0].imageUrl,
          image_url: list[0].image_url,
          photo_url: list[0].photo_url,
        });
      }
      setRecentCatches(list);
    } catch {}
  }, []);

  // Refetch every time the Home tab comes back into focus (e.g. returning from
  // logging a catch). Runs on first focus too, so it covers the initial load.
  useFocusEffect(
    useCallback(() => { refreshRecentCatches(); }, [refreshRecentCatches])
  );

  const handleDeleteRecent = useCallback((c) => {
    Alert.alert(
      'Delete catch?',
      c.isPublic
        ? 'This permanently removes it from your logbook and the community feed.'
        : 'This permanently removes it from your logbook.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete', style: 'destructive',
          onPress: async () => {
            setRecentCatches(prev => prev.filter(x => x.id !== c.id)); // optimistic
            try { await deleteCatch(c.id); }
            catch { refreshRecentCatches(); } // restore from server on failure
          },
        },
      ]
    );
  }, [refreshRecentCatches]);

  const handleStationSelect = async (station) => {
    setShowStationSearch(false);
    setActiveStation(station);
    // Persist last used station (null = GPS mode)
    try {
      if (station) await AsyncStorage.setItem('btc_last_station', JSON.stringify(station));
      else await AsyncStorage.removeItem('btc_last_station');
    } catch {}
    load(false, station);
  };

  const handleToggleFavorite = async (station) => {
    setStationFavorites(prev => {
      const exists = prev.some(f => f.id === station.id);
      const next = exists ? prev.filter(f => f.id !== station.id) : [...prev, station];
      AsyncStorage.setItem('btc_station_favorites', JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const biteColor = scoreColor(goodBiteScore ?? 0);
  const dayPreds  = getPredictionsForDay(tidePredictions, activeDay);
  // Real high/low events for the selected day. When present they power the
  // H/L cards at the true minute (6:25 AM, not the nearest hourly sample).
  const dayExtremes = getPredictionsForDay(tideExtremes, activeDay);
  const { linePath, fillPath, peaks, midH } = buildChartData(dayPreds);
  const nowX = activeDay === 0 ? PAD + getNowFraction() * (CHART_W - PAD * 2) : null;
  const tideDisplay = currentTideHeight != null ? Number(currentTideHeight).toFixed(1) : '—';

  if (error) {
    return (
      <View style={[s.center, { paddingTop: insets.top }]}>
        <Text style={s.errorText}>⚠️  {error}</Text>
        <TouchableOpacity style={s.retryBtn} onPress={() => load(false)}>
          <Text style={s.retryBtnText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // Loader overlay — the branded image with water rising over it. Shown opaque
  // while loading, then fades away (opacity: waterFade) to reveal HomeScreen
  // underneath. Kept in a stable tree position so the water Lottie never
  // remounts/restarts during the fade.
  const LoaderOverlay = showLoader ? (
    <Animated.View
      pointerEvents={loading ? 'auto' : 'none'}
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
        zIndex: 50, opacity: waterFade,
        alignItems: 'center', justifyContent: 'center',
        paddingTop: insets.top, backgroundColor: COLORS.bgDeep,
      }}
    >
      <Image
        source={require('./assets/images/LoadingScreenImage.png')}
        style={{ width: SW * 1.6, height: SW * 1.6, resizeMode: 'contain', marginBottom: 16 }}
      />
      <View style={s.loadingDots}>
        {[0.3, 0.6, 0.9].map((op, i) => (
          <View key={i} style={[s.loadingDot, { opacity: op }]} />
        ))}
      </View>
      <Text style={s.loadingLabel}>Loading tides & conditions…</Text>
      {/* Water rises on top and covers everything */}
      <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', zIndex: 10 }}>
        <LottieView
          source={require('./assets/animations/waterrising2faster.json')}
          autoPlay
          loop={false}
          style={{ width: SW * 1.8, height: '100%', alignSelf: 'center' }}
          resizeMode="cover"
        />
      </View>
    </Animated.View>
  ) : null;

  // While data is still loading, Home data isn't ready — render only the loader
  // (Home is gated below so we never touch null conditions). The loader stays in
  // a stable tree slot across the loading→ready transition so the water Lottie
  // doesn't restart mid-handoff.
  return (
    <View style={{ flex: 1 }}>
      {!loading && (
        <Animated.View style={{ flex: 1, opacity: fadeAnim }}>
          <Animated.ScrollView
        style={[s.container, { paddingTop: insets.top }]}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={
          <RefreshControl refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); load(true); refreshRecentCatches(); }}
            tintColor="transparent" colors={['transparent']} progressBackgroundColor="transparent" />
        }
      >
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity
            onPress={() => navigation.navigate('MyProfile')}
            onLongPress={() => navigation.navigate('RingPicker', {
              avatarUri: user?.avatar ?? cachedAvatar,
              name: user?.name,
              isClub: !!user?.isClub,
              badge: user?.clubBadge,
            })}
            activeOpacity={0.8}
          >
            <Avatar
              uri={user?.avatar ?? cachedAvatar}
              name={user?.name}
              isClub={!!user?.isClub}
              badge={myBadge ?? user?.clubBadge}
              ringId={myRing ?? user?.equippedRing ?? user?.equipped_ring ?? null}
              size={96}
              guest={!user}
              guestImage={require('./assets/images/guest_avatar.png')}
            />
          </TouchableOpacity>
          <View style={{ flex: 1, marginLeft: SPACING.md }}>
            <Text style={s.brandTag}>{homeGreeting}</Text>
            {gpsLocationName ? (
              <Text style={s.stationName} numberOfLines={1} ellipsizeMode="tail">{gpsLocationName}</Text>
            ) : null}
            {userLat != null && userLon != null && (
              <Text style={s.coordsLabel}>{userLat.toFixed(4)}, {userLon.toFixed(4)}</Text>
            )}
          </View>
          <TouchableOpacity
            onPress={async (e) => { await splashAt(e); navigation.navigate('Settings'); }}
            activeOpacity={0.7}
            style={s.settingsBtn}
            accessibilityLabel="Settings"
          >
            <LottieView source={require('./assets/animations/settings_animated_icon.json')} autoPlay loop style={s.settingsBtnImg} />
            <Text style={s.settingsDateLabel}>{todayLabel()}</Text>
          </TouchableOpacity>
        </View>

        {/* NOAA station used for tide/water data — independent of the GPS
            city shown above. Tap to change which station's data is used. */}
        <TouchableOpacity onPress={() => setShowStationSearch(true)} activeOpacity={0.7} style={s.stationSourceRow}>
          <Text style={s.stationSourceLabel}>
            Tide data: {activeStation?.name ?? homeStationName ?? '—'}
          </Text>
          <View style={s.changeBtn}><Text style={s.changeBtnText}>Change</Text></View>
        </TouchableOpacity>

        {/* Stat row */}
        <View style={s.statRow}>
          {[
            { label: 'Tide',      val: tideDisplay,                                                                              unit: 'ft',   sub: currentTideDirection ?? '—',                                                    color: COLORS.green },
            { label: 'Good Bite', val: String(goodBiteScore ?? '—'),                                                             unit: '/100', sub: goodBiteLabel ?? '—',                                                           color: biteColor },
            { label: 'Wind',      val: conditions?.wind ? `${conditions.wind.direction ?? ''} ${conditions.wind.speedKts ?? ''}` : '—', unit: 'kt', sub: conditions?.wind?.gustKts ? `G${conditions.wind.gustKts}` : '' },
            { label: 'Baro',      val: conditions?.pressure?.inHg != null ? Number(conditions.pressure.inHg).toFixed(2) : '—',   unit: '',     sub: conditions?.pressure?.trend ? conditions.pressure.trend.replace('_',' ') : '', color: COLORS.green },
          ].map((sc, i) => (
            <View key={i} style={s.statCard}>
              <Text style={s.statLabel}>{sc.label}</Text>
              <Text style={[s.statValue, sc.color ? { color: sc.color } : null]}>
                {sc.val}<Text style={s.statUnit}>{sc.unit ? ` ${sc.unit}` : ''}</Text>
              </Text>
              {sc.sub ? <Text style={s.statSub}>{sc.sub}</Text> : null}
            </View>
          ))}
        </View>

        {/* Good Bite card */}
        <View style={[s.biteCard, { borderColor: biteColor + '55' }]}>
          <Svg width={72} height={72} style={{ flexShrink: 0 }}>
            <Circle cx="36" cy="36" r="28" fill="none" stroke={COLORS.border} strokeWidth="5" />
            <Circle cx="36" cy="36" r="28" fill="none" stroke={biteColor} strokeWidth="5"
              strokeDasharray={`${Math.round(Math.min(1, (goodBiteScore ?? 0) / 100) * 175.9)} 175.9`}
              strokeLinecap="round" transform="rotate(-90 36 36)" />
            <SvgText x="36" y="41" fontSize="16" fill={biteColor} textAnchor="middle" fontWeight="700">
              {goodBiteScore ?? '—'}
            </SvgText>
          </Svg>
          <View style={{ flex: 1 }}>
            <Text style={{ marginBottom: 2 }}>
              <Text style={s.cardSectionTitle}>Good Bite Score </Text>
              <Text style={[s.biteLabel, { color: biteColor }]}>— {goodBiteLabel ?? '—'}</Text>
            </Text>
            {biteBreakdown != null && (
              <View style={{ gap: 5, marginTop: 6 }}>
                {[
                  { label: 'Tide',    pts: biteBreakdown.tide?.pts,    max: 35, color: COLORS.blue },
                  { label: 'Baro',    pts: biteBreakdown.baro?.pts,    max: 20, color: COLORS.green },
                  { label: 'Wind',    pts: biteBreakdown.wind?.pts,    max: 20, color: COLORS.rust },
                  { label: 'Solunar', pts: biteBreakdown.solunar?.pts, max: 25, color: COLORS.purple },
                ].map(b => (
                  <View key={b.label} style={s.biteRow}>
                    <Text style={s.biteRowLabel}>{b.label}</Text>
                    <View style={s.biteTrack}>
                      <View style={[s.biteFill, { width: `${Math.round(((b.pts ?? 0) / b.max) * 100)}%`, backgroundColor: b.color }]} />
                    </View>
                    <Text style={[s.biteRowPts, { color: b.color }]}>{b.pts ?? 0}/{b.max}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
        </View>

        {/* Tide chart */}
        <View style={s.chartCard}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}
            style={{ borderBottomWidth: 0.5, borderColor: COLORS.border }}
            contentContainerStyle={{ paddingHorizontal: SPACING.sm, paddingVertical: SPACING.xs, gap: SPACING.xs, flexDirection: 'row' }}>
            {[0,1,2,3,4,5,6].map(d => (
              <TouchableOpacity key={d} style={[s.dayTab, activeDay === d && s.dayTabActive]} onPress={() => setActiveDay(d)}>
                <Text style={[s.dayTabText, activeDay === d && s.dayTabTextActive]}>{fmtDate(d)}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', padding: SPACING.sm, paddingBottom: 4, gap: 4 }}>
            <Text style={s.cardSectionTitle}>Tide Curve</Text>
            <Text style={s.tideCurveDesc}>
              {'— ' + (() => {
                if (!homeStationId && !activeStation) return 'Enable location or pick a spot to see tide data.';
                if (!currentTideDirection || currentTideHeight == null) return 'Loading tide data…';
                const ht = Number(currentTideHeight);
                const dir = currentTideDirection.toLowerCase();
                if (dir.includes('rising') || dir.includes('incoming') || dir.includes('flood')) {
                  if (ht >= 4.5) return 'Tide is near high — expect slower current.';
                  if (ht >= 2.5) return 'Tide is rising — current picking up.';
                  return 'Tide is coming in — low and rising.';
                } else if (dir.includes('falling') || dir.includes('outgoing') || dir.includes('ebb')) {
                  if (ht >= 4.5) return 'Tide just turned — starting to fall.';
                  if (ht >= 2.5) return 'Tide is falling — good moving water.';
                  return 'Tide is going out — near low.';
                }
                return `Currently ${currentTideDirection.toLowerCase()} at ${Number(currentTideHeight).toFixed(1)} ft.`;
              })()}
            </Text>
          </View>
          <Svg width={CHART_W} height={CHART_H}>
            <Defs>
              <LinearGradient id="tideFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={COLORS.blueDeep} stopOpacity="0.7" />
                <Stop offset="1" stopColor={COLORS.blueDeep} stopOpacity="0.05" />
              </LinearGradient>
            </Defs>
            {fillPath ? <Path d={fillPath} fill="url(#tideFill)" /> : null}
            {linePath ? <Path d={linePath} fill="none" stroke={COLORS.blue} strokeWidth="2" strokeLinecap="round" /> : null}
            {nowX != null ? <Line x1={nowX} y1={0} x2={nowX} y2={CHART_H} stroke={COLORS.boneWhite} strokeWidth="1" strokeOpacity="0.35" strokeDasharray="3 4" /> : null}
            {peaks.map((p, i) => {
              const isHigh = p.v > midH;
              const c = isHigh ? COLORS.green : COLORS.rust;
              return (
                <React.Fragment key={i}>
                  <Circle cx={p.x} cy={p.y} r={4} fill={COLORS.bgDeep} stroke={c} strokeWidth="1.5" />
                  <SvgText x={p.x} y={isHigh ? p.y - 10 : p.y + 16} fontSize={9} fill={c} textAnchor="middle" fontWeight="700">{p.v.toFixed(1)} ft</SvgText>
                  <SvgText x={p.x} y={isHigh ? p.y - 20 : p.y + 26} fontSize={7.5} fill={COLORS.textGhost} textAnchor="middle">{fmt12(p.t)}</SvgText>
                </React.Fragment>
              );
            })}
          </Svg>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: PAD, paddingVertical: 4 }}>
            {['12a','3a','6a','9a','12p','3p','6p','9p','12a'].map((t, i) => (
              <Text key={i} style={{ fontSize: 8, color: COLORS.textGhost }}>{t}</Text>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: SPACING.xs, padding: SPACING.sm, paddingTop: 4 }}>
            {(dayExtremes.length ? dayExtremes : peaks).slice(0, 4).map((p, i) => {
              const isHigh = p.type ? p.type === 'H' : p.v > midH;
              return (
                <View key={i} style={s.hlCard}>
                  <Text style={s.hlType}>{isHigh ? '↑ High' : '↓ Low'}</Text>
                  <Text style={[s.hlFt, { color: isHigh ? COLORS.green : COLORS.rust }]}>{Number(p.v).toFixed(1)} ft</Text>
                  <Text style={s.hlTime}>{fmt12(p.t)}</Text>
                </View>
              );
            })}
          </View>
        </View>

        {/* Radar */}
        <RadarCard lat={userLat} lon={userLon} />

        {/* Hourly forecast — next 24 hours starting from now */}
        {conditions?.hourly?.length > 0 && (
          <View style={s.card}>
            <Text style={s.cardSectionTitle}>24-Hour Forecast</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: SPACING.sm, paddingVertical: SPACING.sm, gap: SPACING.sm }}>
              {conditions.hourly.map((h, i) => (
                <View key={h.time ?? i} style={s.hourCard}>
                  <Text style={s.hourTime}>{i === 0 ? 'Now' : fmtHourOnly(h.time)}</Text>
                  <Text style={s.hourTemp}>{h.tempF}°</Text>
                  <Text style={s.hourWind}>{h.windDirection} {h.windKts}kt</Text>
                  {h.precipChance != null && h.precipChance > 0 && (
                    <Text style={s.hourPrecip}>💧 {h.precipChance}%</Text>
                  )}
                </View>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Moon strip */}
        <View style={s.moonStrip}>
          {[
            { icon: null, emoji: conditions?.solunar?.moonPhaseEmoji ?? '🌙', label: 'Moon',    value: `${conditions?.solunar?.moonPct ?? '—'}%`, sub: conditions?.solunar?.moonPhaseName,
              info: { title: 'Moon Phase', body: 'Shows how much of the moon is illuminated right now. New (0%) and full (100%) moons cause the strongest "spring tides" — bigger water movement that often means better fishing. Quarter moons (50%) cause weaker "neap tides."' } },
            { icon: require('./assets/images/solunar_icon.png'), label: 'Solunar', value: solunarLabel(conditions?.solunar?.window), sub: solunarSub(conditions?.solunar),
              info: { title: 'Solunar Activity', body: 'Based on a theory that fish feed most actively when the moon is directly overhead or directly underfoot relative to your location — these are called "major" periods (about 1.5–2 hrs, prime feeding windows). Shorter "minor" periods happen near moonrise and moonset. "Near major" means a strong feeding window is approaching soon.' } },
            { icon: require('./assets/images/sunrise_icon.png'), label: 'Sunrise', value: conditions?.sunrise ?? '—' },
            { icon: require('./assets/images/sunset_icon.png'),  label: 'Sunset',  value: conditions?.sunset  ?? '—' },
          ].map((m, i) => (
            <React.Fragment key={m.label}>
              {i > 0 && <View style={{ width: 0.5, backgroundColor: COLORS.border, marginVertical: SPACING.sm }} />}
              <View style={s.moonItem}>
                {m.info && (
                  <TouchableOpacity
                    style={s.moonInfoBtn}
                    onPress={() => setInfoModal(m.info)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={s.moonInfoBtnText}>ⓘ</Text>
                  </TouchableOpacity>
                )}
                {m.icon
                  ? <Image source={m.icon} style={s.moonIcon} resizeMode="contain" />
                  : <Text style={s.moonEmoji}>{m.emoji}</Text>
                }
                <Text style={s.moonLabel}>{m.label}</Text>
                <Text style={s.moonValue}>{m.value}</Text>
                {m.sub ? <Text style={s.moonSub} numberOfLines={1}>{m.sub}</Text> : null}
              </View>
            </React.Fragment>
          ))}
        </View>

        {/* Info modal — explains moon/solunar/sunrise/sunset tiles */}
        <Modal visible={!!infoModal} transparent animationType="fade" onRequestClose={() => setInfoModal(null)}>
          <TouchableOpacity style={s.infoOverlay} activeOpacity={1} onPress={() => setInfoModal(null)}>
            <View style={s.infoCard}>
              <Text style={s.infoTitle}>{infoModal?.title}</Text>
              <Text style={s.infoBody}>{infoModal?.body}</Text>
              <TouchableOpacity style={s.infoCloseBtn} onPress={() => setInfoModal(null)}>
                <Text style={s.infoCloseBtnText}>Got it</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>

        {/* Marine conditions — Open-Meteo + NOAA */}
        {(conditions != null || marineData != null) && (
          <View style={s.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: SPACING.sm, paddingBottom: 4 }}>
              <Text style={s.sectionTitle}>Marine Conditions</Text>
              <Text style={{ fontSize: 8, color: COLORS.textGhost }}>Open-Meteo · NOAA</Text>
            </View>

            {/* Big stat tiles */}
            <View style={{ flexDirection: 'row', gap: SPACING.xs, paddingHorizontal: SPACING.sm, paddingBottom: SPACING.sm }}>
              {/* Water temp */}
              <View style={s.marineTile}>
                <Image source={require('./assets/images/watertemp_icon.png')} style={s.marineTileIconImg} resizeMode="contain" />
                <Text style={s.marineTileValue}>{marineData?.waterTempF != null ? `${marineData.waterTempF}°F` : conditions?.waterTemp != null ? `${conditions.waterTemp}°F` : '—'}</Text>
                <Text style={s.marineTileLabel}>Water Temp</Text>
              </View>
              {/* Waves */}
              <View style={s.marineTile}>
                <Image source={require('./assets/images/waveheight_icon.png')} style={s.marineTileIconImg} resizeMode="contain" />
                <Text style={s.marineTileValue}>{marineData?.waveHeightFt != null ? `${marineData.waveHeightFt} ft` : conditions?.waveHeight != null ? `${Number(conditions.waveHeight).toFixed(1)} ft` : '—'}</Text>
                <Text style={s.marineTileLabel}>Wave Height</Text>
              </View>
              {/* Currents */}
              <View style={s.marineTile}>
                <Image source={require('./assets/images/currents_icon.png')} style={s.marineTileIconImg} resizeMode="contain" />
                <Text style={s.marineTileValue}>{marineData?.currentSpeedKts != null ? `${marineData.currentSpeedKts} kt` : '—'}</Text>
                <Text style={s.marineTileLabel}>{marineData?.currentLabel ? `Current · ${marineData.currentLabel}` : 'Current'}</Text>
              </View>
              {/* Visibility */}
              <View style={s.marineTile}>
                <Image source={require('./assets/images/visibility_icon.png')} style={s.marineTileIconImg} resizeMode="contain" />
                <Text style={s.marineTileValue}>{marineData?.visibilityMi != null ? `${marineData.visibilityMi} mi` : conditions?.visibility != null ? `${conditions.visibility} mi` : '—'}</Text>
                <Text style={s.marineTileLabel}>Visibility</Text>
              </View>
            </View>

            {/* Detail rows */}
            {[
              { label: 'Wave period',     value: marineData?.wavePeriodSec != null ? `${marineData.wavePeriodSec}s · from ${marineData.waveDirCard ?? '—'}` : '—' },
              { label: 'Swell',           value: marineData?.swellHeightFt != null ? `${marineData.swellHeightFt} ft · ${marineData.swellPeriodSec ?? '—'}s · ${marineData.swellDirCard ?? '—'}` : '—' },
              // Open-Meteo gives a compass bearing offshore; inshore/inland it has no
              // current model at all and the tide-derived fallback knows flood/ebb but
              // not a heading. Show whichever we actually have instead of a dash.
              { label: 'Current dir',     value: marineData?.currentDirection != null
                                                   ? `${marineData.currentDirectionCard ?? '—'} (${marineData.currentDirection}°)`
                                                   : (marineData?.currentDirectionText ?? marineData?.currentLabel ?? '—') },
              { label: 'Wind',            value: marineData?.windSpeedKts != null ? `${marineData.windSpeedKts} kt ${marineData.windDirCard ?? ''}` : conditions?.wind?.speedKts != null ? `${conditions.wind.speedKts} kt ${conditions.wind.direction ?? ''}` : '—' },
              { label: 'Barometer',       value: conditions?.pressure?.inHg != null ? `${Number(conditions.pressure.inHg).toFixed(2)} inHg` : '—' },
              { label: 'Sunrise / Sunset',value: conditions?.sunrise && conditions?.sunset ? `${conditions.sunrise} / ${conditions.sunset}` : '—' },
            ].map((r, i, arr) => (
              <View key={r.label} style={[s.marineRow, i === arr.length - 1 && { borderBottomWidth: 0 }]}>
                <Text style={s.marineLabel}>{r.label}</Text>
                <Text style={s.marineValue}>{r.value}</Text>
              </View>
            ))}
          </View>
        )}



        <StationSearchModal
          visible={showStationSearch}
          onClose={() => setShowStationSearch(false)}
          onSelect={handleStationSelect}
          favorites={stationFavorites}
          onToggleFavorite={handleToggleFavorite}
        />

        {/* ── Quick Links ── */}
        <View style={s.quickLinks}>
          {[
            { img: require('./assets/icons/icon_quickcharts.png'),   tab: 'Charts'  },
            { img: require('./assets/icons/icon_quickguide.png'),    tab: 'Fish'    },
            { img: require('./assets/icons/icon_quickgear.png'),     tab: 'Gear'    },
            { img: require('./assets/icons/icon_quicklogbook.png'),  tab: 'Logbook' },
          ].map(link => (
            <TouchableOpacity
              key={link.tab}
              style={s.quickLinkBtn}
              onPress={async (e) => { await splashAt(e); navigation.navigate(link.tab); }}
              activeOpacity={0.85}
            >
              <Image source={link.img} style={s.quickLinkImg} />
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Tide Kings teaser banner ── */}
        <TouchableOpacity
          style={s.tideKingsBanner}
          onPress={async (e) => { await splashAt(e); navigation.navigate('Ranked'); }}
          activeOpacity={0.9}
        >
          <Image
            source={require('./assets/images/tide_king_icon.png')}
            style={s.tideKingsImg}
            resizeMode="cover"
          />
        </TouchableOpacity>

        {/* ── Community Feed banner ── */}
        <TouchableOpacity
          style={s.feedBanner}
          onPress={async (e) => { await splashAt(e); navigation.navigate('Feed'); }}
          activeOpacity={0.9}
        >
          <Image
            source={require('./assets/icons/icon_communityfeed.png')}
            style={s.feedBannerImg}
            resizeMode="cover"
          />
        </TouchableOpacity>

        {/* ── Recent Catches Slideshow ── */}
        {/* ── Featured Anglers ── */}
        <FeaturedAnglers navigation={navigation} />

        {/* API footer */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: SPACING.md, paddingTop: SPACING.sm }}>
          {['NOAA CO-OPS', 'Open-Meteo', 'NEXRAD'].map((t, i) => (
            <View key={i} style={s.apiBadge}>
              <Text style={s.apiBadgeText}>{t} · free</Text>
            </View>
          ))}
        </View>
      </Animated.ScrollView>

      {/* New ring earned celebration (daily login streak rings land here) */}
      <RingEarnedPopup rings={earnedRings} onDone={() => setEarnedRings([])} />

      {/* Pull-to-refresh wave — fades/slides in as you pull down, then holds
          and loops while the refresh loads (native spinner is hidden). */}
      {(waveMounted || refreshing) && (
        <Animated.View
          pointerEvents="none"
          style={[s.refreshWave, { top: insets.top + 2, opacity: waveOpacity, transform: [{ translateY: waveShift }] }]}
        >
          <LottieView
            source={require('./assets/animations/ocean.json')}
            autoPlay loop
            resizeMode="contain"
            style={s.refreshWaveInner}
          />
        </Animated.View>
      )}
        </Animated.View>
      )}

      {/* Loader overlay — always last in the tree so the water Lottie keeps a
          stable mount and never restarts during the fade-out into Home. */}
      {LoaderOverlay}
    </View>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: COLORS.bgDeep },
  center:       { flex: 1, backgroundColor: COLORS.bgDeep, alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  loadingLoc:   { fontSize: 13, color: COLORS.textMuted, marginBottom: SPACING.xl },
  loadingDots:  { flexDirection: 'row', gap: 8, marginBottom: SPACING.lg },
  loadingDot:   { width: 7, height: 7, borderRadius: 4, backgroundColor: COLORS.rust },
  loadingLabel: { fontSize: 12, color: COLORS.textDim },
  errorText:    { fontSize: 14, color: COLORS.danger, textAlign: 'center', marginBottom: SPACING.lg },
  retryBtn:     { backgroundColor: COLORS.rust, paddingHorizontal: 24, paddingVertical: 10, borderRadius: RADIUS.md },
  retryBtnText: { color: COLORS.bgDeep, fontSize: 14, fontWeight: '700' },
  changeBtn:     { backgroundColor: COLORS.rust + '22', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 0.5, borderColor: COLORS.rust + '66' },
  changeBtnText: { fontSize: 10, color: COLORS.rust, fontWeight: '600' },
  header:       { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: COLORS.bgDark, padding: SPACING.md, borderBottomWidth: 0.5, borderColor: COLORS.border },
  brandTag:     { fontSize: 17, color: COLORS.rust, fontWeight: '800', letterSpacing: -0.2, marginBottom: 2 },
  stationName:  { fontSize: 18, color: COLORS.boneWhite, fontWeight: '700', lineHeight: 22 },
  coordsLabel:  { fontSize: 10, color: COLORS.textGhost, marginTop: 2 },
  stationSourceRow:   { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: SPACING.md, paddingBottom: SPACING.sm, paddingTop: 2 },
  stationSourceLabel: { fontSize: 12, color: COLORS.textDim },
  ringsPill: { alignSelf: 'flex-start', backgroundColor: '#C9A24B1E', borderWidth: 1, borderColor: '#C9A24B88', borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5, marginTop: 6 },
  ringsPillTxt: { color: '#C9A24B', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 },

  settingsBtn:  { width: 64, minHeight: 64, alignItems: 'center', justifyContent: 'center' },
  settingsBtnIcon: { fontSize: 36, color: COLORS.textDim },
  settingsBtnImg: { width: 60, height: 60 },
  refreshWave:      { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 20 },
  refreshWaveInner: { width: 88, height: 52 },
  settingsDateLabel: { fontSize: 9, color: COLORS.textDim, marginTop: 1 },
  headerAvatar:            { width: 44, height: 44, borderRadius: 22, backgroundColor: COLORS.bgDeep },
  headerAvatarPlaceholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 0.5, borderColor: COLORS.border },
  headerAvatarInitial:     { fontSize: 18, color: COLORS.rust, fontWeight: '700' },
  statRow:      { flexDirection: 'row', paddingHorizontal: SPACING.sm, paddingTop: SPACING.sm, gap: SPACING.xs },
  statCard:     { flex: 1, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.md, padding: SPACING.sm, borderWidth: 0.5, borderColor: COLORS.border },
  statLabel:    { fontSize: 8, color: COLORS.textGhost, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 2 },
  statValue:    { fontSize: 15, color: COLORS.boneWhite, fontWeight: '700', lineHeight: 18 },
  statUnit:     { fontSize: 9, color: COLORS.textMuted },
  statSub:      { fontSize: 8, color: COLORS.textDim, marginTop: 1 },
  biteCard:     { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md, margin: SPACING.sm, marginTop: SPACING.xs, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.lg, padding: SPACING.md, borderWidth: 0.5 },
  biteLabel:    { fontSize: 15, fontWeight: '700', marginBottom: 2 },
  biteRow:      { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  biteRowLabel: { fontSize: 9, color: COLORS.textDim, width: 44 },
  biteTrack:    { flex: 1, height: 4, backgroundColor: COLORS.border, borderRadius: 2, overflow: 'hidden' },
  biteFill:     { height: 4, borderRadius: 2 },
  biteRowPts:   { fontSize: 9, fontWeight: '600', width: 28, textAlign: 'right' },
  chartCard:    { margin: SPACING.sm, marginTop: SPACING.xs, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.lg, borderWidth: 0.5, borderColor: COLORS.border, overflow: 'hidden' },
  chartTitle:   { fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.6 },
  cardSectionTitle: { fontFamily: 'BoneTideCo', fontSize: 15, color: COLORS.boneWhite, paddingHorizontal: SPACING.sm, paddingTop: 4 },
  tideCurveDesc: { fontSize: 11, color: COLORS.textMuted, fontStyle: 'italic', flexShrink: 1 },
  dayTab:       { paddingHorizontal: 11, paddingVertical: 5, borderRadius: RADIUS.pill, borderWidth: 0.5, borderColor: COLORS.border },
  dayTabActive: { backgroundColor: COLORS.rust, borderColor: COLORS.rust },
  dayTabText:   { fontSize: 10, color: COLORS.textMuted },
  dayTabTextActive: { color: COLORS.bgDeep, fontWeight: '700' },
  hourCard:    { alignItems: 'center', gap: 3, backgroundColor: COLORS.bgDark, borderRadius: RADIUS.md, paddingVertical: SPACING.sm, paddingHorizontal: SPACING.sm, minWidth: 64 },
  hourTime:    { fontSize: 11, color: COLORS.textMuted, fontWeight: '600' },
  hourTemp:    { fontSize: 16, color: COLORS.boneWhite, fontWeight: '700' },
  hourWind:    { fontSize: 10, color: COLORS.textDim },
  hourPrecip:  { fontSize: 10, color: '#5aa8d6' },
  hlCard:       { flex: 1, backgroundColor: COLORS.bgDeep, borderRadius: RADIUS.md, padding: SPACING.sm, borderWidth: 0.5, borderColor: COLORS.border, alignItems: 'center' },
  hlType:       { fontSize: 8, color: COLORS.textGhost, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  hlFt:         { fontSize: 16, fontWeight: '700', lineHeight: 19 },
  hlTime:       { fontSize: 10, color: COLORS.textMuted, marginTop: 2 },
  moonStrip:    { flexDirection: 'row', margin: SPACING.sm, marginTop: SPACING.xs, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.lg, borderWidth: 0.5, borderColor: COLORS.border, overflow: 'hidden' },
  moonItem:     { flex: 1, alignItems: 'center', paddingVertical: SPACING.sm, paddingHorizontal: 2, position: 'relative' },
  moonIcon:     { width: 38, height: 38, marginBottom: 3 },
  moonEmoji:    { fontSize: 32, marginBottom: 3, lineHeight: 38 },
  moonLabel:    { fontSize: 8, color: COLORS.textGhost, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 2 },
  moonValue:    { fontSize: 10, color: COLORS.boneWhite, fontWeight: '700', textAlign: 'center' },
  moonSub:      { fontSize: 7, color: 'rgba(245, 239, 224, 0.65)', textAlign: 'center', marginTop: 1 },
  moonInfoBtn:      { position: 'absolute', top: 4, right: 4, width: 16, height: 16, alignItems: 'center', justifyContent: 'center', zIndex: 1 },
  moonInfoBtnText:  { fontSize: 11, color: COLORS.textGhost },
  infoOverlay:      { flex: 1, backgroundColor: 'rgba(10,17,40,0.7)', alignItems: 'center', justifyContent: 'center', padding: SPACING.xl },
  infoCard:         { backgroundColor: COLORS.navyDark, borderRadius: RADIUS.lg, borderWidth: 0.5, borderColor: COLORS.border, padding: SPACING.lg, maxWidth: 360, width: '100%' },
  infoTitle:        { fontSize: 16, color: COLORS.boneWhite, fontWeight: '700', marginBottom: SPACING.sm },
  infoBody:         { fontSize: 13, color: COLORS.textSecondary, lineHeight: 19 },
  infoCloseBtn:     { marginTop: SPACING.lg, backgroundColor: COLORS.rust, borderRadius: RADIUS.md, paddingVertical: 10, alignItems: 'center' },
  infoCloseBtnText: { fontSize: 14, color: COLORS.bgDeep, fontWeight: '700' },
  card:         { margin: SPACING.sm, marginTop: SPACING.xs, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.lg, borderWidth: 0.5, borderColor: COLORS.border, overflow: 'hidden' },
  sectionTitle: { fontSize: 10, color: COLORS.textMuted, textTransform: 'uppercase', letterSpacing: 0.7 },
  marineRow:    { flexDirection: 'row', alignItems: 'center', paddingHorizontal: SPACING.sm, paddingVertical: 7, borderBottomWidth: 0.5, borderColor: COLORS.borderFaint },
  marineLabel:  { flex: 1, fontSize: 10, color: COLORS.textDim },
  marineValue:  { fontSize: 11, color: COLORS.boneWhite, fontWeight: '600' },
  marineTile:   { flex: 1, backgroundColor: COLORS.bgDark, borderRadius: RADIUS.md, padding: SPACING.xs, alignItems: 'center', gap: 2 },
  marineTileIcon:  { fontSize: 16 },
  marineTileIconImg: { width: 40, height: 40, marginBottom: 2 },
  marineTileValue: { fontSize: 13, color: COLORS.boneWhite, fontWeight: '700' },
  marineTileLabel: { fontSize: 8, color: COLORS.textGhost, textAlign: 'center' },
  apiBadge:     { backgroundColor: COLORS.bgDark, borderRadius: 4, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 0.5, borderColor: COLORS.border },
  apiBadgeText: { fontSize: 9, color: COLORS.textGhost, fontFamily: 'Courier' },

  quickLinks:      { paddingHorizontal: SPACING.sm, gap: SPACING.xs, marginBottom: SPACING.sm },
  quickLinkBtn:    { width: '100%', borderRadius: RADIUS.lg, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  quickLinkImg:    { width: '100%', height: undefined, aspectRatio: 543 / 146, resizeMode: 'cover', borderRadius: RADIUS.lg },
  tideKingsBanner: { marginHorizontal: SPACING.sm, marginBottom: SPACING.sm, borderRadius: RADIUS.lg, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  tideKingsImg:    { width: '100%', height: undefined, aspectRatio: 543 / 146, borderRadius: RADIUS.lg },
  feedBtn:         { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginHorizontal: SPACING.sm, marginBottom: SPACING.sm, paddingHorizontal: SPACING.md, paddingVertical: SPACING.md, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.lg, borderWidth: 0.5, borderColor: COLORS.border },
  feedBtnIcon:     { fontSize: 26 },
  feedBtnTitle:    { color: COLORS.boneWhite, fontSize: 16, fontWeight: '800' },
  feedBtnSub:      { color: COLORS.textGhost, fontSize: 12, marginTop: 1 },
  feedBtnArrow:    { color: COLORS.rust, fontSize: 24, fontWeight: '800' },
  feedBanner:      { marginHorizontal: SPACING.sm, marginBottom: SPACING.sm, borderRadius: RADIUS.lg, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 6, shadowOffset: { width: 0, height: 3 } },
  feedBannerImg:   { width: '100%', height: undefined, aspectRatio: 543 / 146, borderRadius: RADIUS.lg },
  quickLinkLabel:  { fontSize: 9, color: COLORS.textSecondary, fontWeight: '600', textAlign: 'center' },

  // Recent catches
  recentCard:      { marginHorizontal: SPACING.sm, marginBottom: SPACING.sm, backgroundColor: COLORS.navyDark, borderRadius: RADIUS.lg, borderWidth: 0.5, borderColor: COLORS.border, overflow: 'hidden' },
  recentHeader:    { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: SPACING.sm, paddingBottom: 6 },
  recentTitle:     { fontSize: 13, color: COLORS.boneWhite, fontFamily: 'BoneTideCo', letterSpacing: 0.5 },
  recentViewAll:   { fontSize: 11, color: COLORS.rust },
  // Slideshow
  recentSlide:         { width: 120, height: 140, borderRadius: RADIUS.md, overflow: 'hidden', backgroundColor: COLORS.bgDark },
  recentSlideImg:      { width: '100%', height: '100%', position: 'absolute' },
  recentSlidePlaceholder: { width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.bgDark },
  recentSlideOverlay:  { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(10,17,40,0.72)', padding: 7 },
  recentSlideTrash:    { position: 'absolute', top: 5, right: 5, width: 26, height: 26, borderRadius: 13,
                         backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
  recentSlideTrashText:{ fontSize: 13 },
  recentSlideSpecies:  { fontSize: 11, color: '#fff', fontWeight: '700' },
  recentSlideLen:      { fontSize: 10, color: 'rgba(255,255,255,0.8)' },
  recentSlideRelDot:   { width: 6, height: 6, borderRadius: 3 },
  // Legacy list styles (kept for reference)
  recentRow:       { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingHorizontal: SPACING.sm, paddingVertical: 10 },
  recentRowBorder: { borderBottomWidth: 0.5, borderColor: COLORS.borderFaint },
  recentDot:       { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.rust },
  recentSpecies:   { fontSize: 13, color: COLORS.boneWhite, fontWeight: '600' },
  recentMeta:      { fontSize: 10, color: COLORS.textGhost, marginTop: 1 },
  recentReleased:  { fontSize: 10, fontWeight: '700' },
  recentTime:      { fontSize: 9, color: COLORS.textGhost, marginTop: 2 },
});
