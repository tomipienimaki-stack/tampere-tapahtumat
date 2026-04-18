/**
 * scrape-meteli.js
 * Hakee tulevat Tampere-keikat meteli.net:n WordPress REST API:sta.
 *
 * Endpoint: /wp-json/wp/v2/tapahtuma?kaupunki=299 (Tampere)
 * Päivämäärä: 'date'-kenttä on tapahtumapäivä (ei julkaisupäivä)
 *
 * Ajo:  node scripts/scrape-meteli.js
 * CI:   GitHub Actions joka maanantai
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const BASE = 'https://www.meteli.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// Tampere kaupunki-taxonomy ID meteli.net:ssä
const TAMPERE_ID = 299;

// ── Tunnetut keikapaikat ──────────────────────────────────────────────────
const VENUE_COORDS = {
  'klubi':           { address: 'Hämeenkatu 28',         lat: 61.4978, lng: 23.7625 },
  'telakka':         { address: 'Tullikamarin aukio 3',  lat: 61.5018, lng: 23.7698 },
  'pakkahuone':      { address: 'Itsenäisyydenkatu 8',   lat: 61.5024, lng: 23.7695 },
  'olympia':         { address: 'Hämeenkatu 26',         lat: 61.4975, lng: 23.7618 },
  'uusi apteekki':   { address: 'Rautatienkatu 8',       lat: 61.4982, lng: 23.7651 },
  'varjobaari':      { address: 'Hämeenpuisto 23',       lat: 61.4985, lng: 23.7558 },
  'vastavirta':      { address: 'Sammonkatu 67',         lat: 61.5008, lng: 23.7628 },
  'nokia areena':    { address: 'Kansikatu 3',           lat: 61.5044, lng: 23.7760 },
  'tampere areena':  { address: 'Kansikatu 3',           lat: 61.5044, lng: 23.7760 },
  'tampere-talo':    { address: 'Yliopistonkatu 55',     lat: 61.5031, lng: 23.7812 },
  'tullikamari':     { address: 'Tullikamarin aukio 2',  lat: 61.5020, lng: 23.7690 },
  'g livelab':       { address: 'Tohlopinkatu 29',       lat: 61.5088, lng: 23.7840 },
  'plevna':          { address: 'Itsenäisyydenkatu 2',   lat: 61.5030, lng: 23.7680 },
  'tavara-asema':    { address: 'Kuninkaankatu 16',      lat: 61.4980, lng: 23.7600 },
  'asemamestari':    { address: 'Rautatienkatu 24',      lat: 61.4990, lng: 23.7650 },
  'ttt-klubi':       { address: 'Hämeenpuisto 28',       lat: 61.4990, lng: 23.7570 },
  'bar kotelo':      { address: 'Hämeenpuisto 23',       lat: 61.4985, lng: 23.7558 },
  'yo-talo':         { address: 'Kalevantie 2',          lat: 61.5003, lng: 23.7736 },
  'ratina':          { address: 'Ratinanniemi',          lat: 61.4940, lng: 23.7720 },
};
const DEF_LOC = { address: 'Tampere', lat: 61.4981, lng: 23.7608 };

function venueCoords(name) {
  if (!name) return DEF_LOC;
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(VENUE_COORDS)) {
    if (key.includes(k)) return { ...v };
  }
  return DEF_LOC;
}

function decodeHtml(s) {
  return (s || '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#8217;/g, "'").replace(/&#8211;/g, '–')
    .replace(/&#8220;/g, '"').replace(/&#8221;/g, '"')
    .replace(/<[^>]+>/g, '').trim();
}

function isoFmt(iso) {
  if (!iso) return '';
  const [y, mo, d] = iso.slice(0, 10).split('-');
  return `${parseInt(d)}.${parseInt(mo)}.${y}`;
}

async function apiFetch(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return { json: await r.json(), headers: r.headers };
}

// ── Hae venue-nimet paikka-taxonomy ID:istä ───────────────────────────────
async function fetchVenueNames(ids) {
  if (!ids.length) return {};
  const map = {};
  // Hae korkeintaan 100 kerrallaan
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const { json } = await apiFetch(
        `${BASE}/wp-json/wp/v2/paikka?include=${chunk.join(',')}&per_page=100&_fields=id,name`
      );
      for (const term of json) map[term.id] = term.name;
    } catch (e) { console.log('Venue-haku virhe:', e.message); }
  }
  return map;
}

// ── Hae Tampere-tapahtumat ────────────────────────────────────────────────
async function fetchEvents() {
  // Haetaan eilen alkaen jotta tämän päivän tapahtumat mukaan
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const after = yesterday.toISOString().slice(0, 10) + 'T00:00:00';

  // Cutoff: 7 viikkoa eteenpäin
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 49);
  const before = cutoff.toISOString().slice(0, 10) + 'T23:59:59';

  const allItems = [];
  let page = 1;

  while (true) {
    const url = `${BASE}/wp-json/wp/v2/tapahtuma?kaupunki=${TAMPERE_ID}&after=${after}&before=${before}&per_page=100&page=${page}&_fields=id,title,date,link,paikka,tyyppi`;
    console.log(`Sivu ${page}...`);
    try {
      const { json: items, headers } = await apiFetch(url);
      if (!Array.isArray(items) || items.length === 0) break;
      allItems.push(...items);
      const totalPages = parseInt(headers.get('X-WP-TotalPages') || '1');
      console.log(`  ${items.length} kpl (sivu ${page}/${totalPages})`);
      if (page >= totalPages) break;
      page++;
    } catch (e) {
      console.log('Haun virhe:', e.message);
      break;
    }
  }

  console.log(`Tampere-tapahtumat yhteensä: ${allItems.length}`);
  return allItems;
}

// ── Muodosta lopulliset event-objektit ────────────────────────────────────
function buildEvents(items, venueMap) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const seen = new Set();
  const events = [];
  let id = 10000;

  for (const item of items) {
    const name = decodeHtml(item.title?.rendered || '');
    if (!name) continue;

    const dateStr = (item.date || '').slice(0, 10);
    if (!dateStr) continue;

    const d = new Date(dateStr);
    if (d < today) continue; // poistetaan menneet

    const key = `${name}|${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Venue
    const paikkaIds = item.paikka || [];
    const venueName = paikkaIds.length ? (venueMap[paikkaIds[0]] || '') : '';
    const cleanVenue = decodeHtml(venueName);
    const { address, lat, lng } = venueCoords(cleanVenue);

    events.push({
      id: id++,
      name,
      sub: cleanVenue || 'Tampere',
      dates: isoFmt(dateStr),
      startDate: dateStr,
      endDate: dateStr,
      month: parseInt(dateStr.split('-')[1]),
      cat: 'keikka',
      location: cleanVenue || 'Tampere',
      address,
      lat,
      lng,
      price: 'Tarkista sivulta',
      url: item.link || `${BASE}/kaupunki/tampere`,
      desc: `${name}${cleanVenue ? ' @ ' + cleanVenue : ''}`,
    });
  }

  // Järjestä päivämäärän mukaan
  events.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return events;
}

// ── Kirjoita index.html ───────────────────────────────────────────────────
function eventsToJs(events) {
  return events.map(e => {
    const f = [
      `id:${e.id}`, `name:${JSON.stringify(e.name)}`, `sub:${JSON.stringify(e.sub)}`,
      `dates:${JSON.stringify(e.dates)}`, `startDate:${JSON.stringify(e.startDate)}`,
      `endDate:${JSON.stringify(e.endDate)}`, `month:${e.month}`,
      `cat:${JSON.stringify(e.cat)}`, `location:${JSON.stringify(e.location)}`,
      `address:${JSON.stringify(e.address)}`, `lat:${e.lat}`, `lng:${e.lng}`,
      `price:${JSON.stringify(e.price)}`, `url:${JSON.stringify(e.url)}`,
      `desc:${JSON.stringify(e.desc)}`,
    ];
    return `  {${f.join(',')}}`;
  }).join(',\n');
}

async function main() {
  const items = await fetchEvents();
  if (items.length === 0) { console.log('Ei tapahtumia.'); return; }

  // Kerää uniikit paikka-IDs ja hae nimet
  const paikkaIds = [...new Set(items.flatMap(i => i.paikka || []))];
  console.log(`Eri paikkoja: ${paikkaIds.length}`);
  const venueMap = await fetchVenueNames(paikkaIds);

  const events = buildEvents(items, venueMap);
  console.log(`\nTulevat tapahtumat: ${events.length}`);
  events.slice(0, 20).forEach(e => console.log(`  ${e.startDate} ${e.name} @ ${e.location}`));

  if (events.length === 0) { console.log('Ei tapahtumia — index.html ennallaan.'); return; }

  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const S = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const E = '/* ── AUTO-SCRAPED-END ── */';
  const si = html.indexOf(S), ei = html.indexOf(E);
  if (si === -1 || ei === -1) { console.error('Merkinnät puuttuu!'); process.exit(1); }

  const now = new Date().toISOString().slice(0, 10);
  const out = `${html.slice(0, si + S.length)}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa (meteli.net) */\n${eventsToJs(events)},\n  ${html.slice(ei)}`;
  fs.writeFileSync(INDEX_PATH, out);
  console.log('✓ index.html päivitetty');
}

main().catch(e => { console.error(e); process.exit(1); });
