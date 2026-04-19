/**
 * scrape-meteli.js
 * Hakee tulevat Tampere-tapahtumat kolmesta lähteestä:
 *   1. meteli.net            – WordPress REST API (keikat/konsertit)
 *   2. tapahtumat.tampere.fi – Tampereen kaupungin virallinen tapahtumakalenteri
 *   3. tiketti.fi            – Lippupalvelu (keikat, urheilu, teatteri, festivaalit)
 *
 * Ajo:  node scripts/scrape-meteli.js
 * CI:   GitHub Actions joka maanantai
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'index.html');

// ── meteli.net ────────────────────────────────────────────────────────────
const METELI_BASE = 'https://www.meteli.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
const TAMPERE_ID = 299; // kaupunki-taxonomy ID meteli.net:ssä

// ── tapahtumat.tampere.fi ─────────────────────────────────────────────────
const TAMPERE_CAL_URL = 'https://tapahtumat.tampere.fi/api/search/internal-content-fetch';
const TAMPERE_CAL_PARAMS = 'lang=fi&country=FI&apiKey=634844c32f41a024ee51a234&out=JSON&sort=startDate&strictSort=true';
const TAMPERE_CAL_FRONTEND = 'https://tapahtumat.tampere.fi/fi-FI';

// ── tiketti.fi ────────────────────────────────────────────────────────────
// /tapahtumat/d/{any} palauttaa kaikki suomalaiset tapahtumat yhtenä JSON-objektina.
// Suodatamme Tampere-paikat city-kentän perusteella client-side.
const TIKETTI_DATA_URL = 'https://www.tiketti.fi/tapahtumat/d/all';
const TIKETTI_BASE = 'https://www.tiketti.fi';
// Tiketti-tagit → sovelluksen cat
// Tag-ryhmä 1: pääkategoriat
const TIKETTI_CAT = { '1':'keikka','2':'urheilu','3':'teatteri','43':'iso','57':'teatteri','66':'ruoka','84':'taide','110':'lapset' };
// Musiikki-alityyli → konsertti
const TIKETTI_KONSERT_STYLES = new Set(['41','65','67','68']); // Klassinen, Gospel, Kuoro, Big Band
// Festivaali-tagi → iso
const TIKETTI_FESTIVAL_TAG = '39';

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
  'hiedanranta':     { address: 'Tehdaskartanonkatu 46', lat: 61.5172, lng: 23.6847 },
  'vapriikki':       { address: 'Alaverstaanraitti 5',   lat: 61.5030, lng: 23.7602 },
  'tampere-talo':    { address: 'Yliopistonkatu 55',     lat: 61.5031, lng: 23.7812 },
  'sara hildén':     { address: 'Laiturikatu 13',        lat: 61.4925, lng: 23.8037 },
  'pyynikki':        { address: 'Näkötornintie 20',      lat: 61.4933, lng: 23.7340 },
  'finlayson':       { address: 'Kuninkaankatu 1',       lat: 61.5007, lng: 23.7648 },
  'koskipuisto':     { address: 'Hämeenkatu',            lat: 61.4965, lng: 23.7638 },
  'hatanpää':        { address: 'Hatanpäänpuisto',       lat: 61.4882, lng: 23.7688 },
};
const DEF_LOC = { address: 'Tampere', lat: 61.4981, lng: 23.7608 };

// ── Kategoria-mappaus (tapahtumat.tampere.fi → sovelluksen cat) ───────────
const CAT_MAP = {
  gig: 'keikka', music: 'keikka',
  consert: 'konsertti',
  movies: 'elokuva',
  festivals: 'iso', fairs: 'iso',
  'kids and family': 'lapset',
  'food and beverage': 'ruoka',
  theatre: 'teatteri', dance: 'teatteri', circus: 'teatteri',
  'sports and fitness': 'urheilu',
  exhibitions: 'taide', museums: 'taide', 'museums and galleries': 'taide',
  activities: 'taide', 'nature and well-being': 'taide',
};

function resolveCategory(globalCats = []) {
  for (const c of globalCats) {
    const mapped = CAT_MAP[c.toLowerCase()];
    if (mapped) return mapped;
  }
  return 'taide'; // oletus kaupunkikalenterin tapahtumille
}

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

function isoFmtRange(startIso, endIso) {
  if (!startIso) return '';
  const s = isoFmt(startIso);
  if (!endIso || startIso.slice(0, 10) === endIso.slice(0, 10)) return s;
  return `${s}–${isoFmt(endIso)}`;
}

async function apiFetch(url, opts = {}) {
  const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000), ...opts });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return { json: await r.json(), headers: r.headers };
}

// ── 1. meteli.net ─────────────────────────────────────────────────────────
async function fetchVenueNames(ids) {
  if (!ids.length) return {};
  const map = {};
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    try {
      const { json } = await apiFetch(
        `${METELI_BASE}/wp-json/wp/v2/paikka?include=${chunk.join(',')}&per_page=100&_fields=id,name`
      );
      for (const term of json) map[term.id] = term.name;
    } catch (e) { console.log('  Venue-haku virhe:', e.message); }
  }
  return map;
}

async function fetchMeteliEvents() {
  console.log('\n=== meteli.net ===');
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const after = yesterday.toISOString().slice(0, 10) + 'T00:00:00';
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + 49);
  const before = cutoff.toISOString().slice(0, 10) + 'T23:59:59';

  const allItems = [];
  let page = 1;
  while (true) {
    const url = `${METELI_BASE}/wp-json/wp/v2/tapahtuma?kaupunki=${TAMPERE_ID}&after=${after}&before=${before}&per_page=100&page=${page}&_fields=id,title,date,link,paikka,tyyppi`;
    console.log(`  Sivu ${page}...`);
    try {
      const { json: items, headers } = await apiFetch(url);
      if (!Array.isArray(items) || items.length === 0) break;
      allItems.push(...items);
      const totalPages = parseInt(headers.get('X-WP-TotalPages') || '1');
      console.log(`    ${items.length} kpl (sivu ${page}/${totalPages})`);
      if (page >= totalPages) break;
      page++;
    } catch (e) { console.log('  Haun virhe:', e.message); break; }
  }
  console.log(`  Yhteensä: ${allItems.length}`);
  return allItems;
}

function buildMeteliEvents(items, venueMap, today, cutoff) {
  // Tunnista bulk-import: jos yli 30 % tapahtumista jakaa saman päivän,
  // meteli.net:n date-kenttä on julkaisupäivä eikä tapahtumapäivä.
  // Tässä tapauksessa koko erä on hyödytön ja ohitetaan.
  const dateCounts = {};
  for (const item of items) {
    const d = (item.date || '').slice(0, 10);
    dateCounts[d] = (dateCounts[d] || 0) + 1;
  }
  const maxCount = Math.max(...Object.values(dateCounts));
  if (items.length > 0 && maxCount / items.length > 0.30) {
    const bulkDate = Object.keys(dateCounts).find(d => dateCounts[d] === maxCount);
    console.log(`  VAROITUS: bulk-import havaittu (${maxCount}/${items.length} tapahtumaa päivällä ${bulkDate})`);
    console.log('  meteli.net-data ohitetaan — date-kenttä ei ole tapahtumapäivä.');
    return [];
  }

  const seen = new Set();
  const events = [];
  let id = 10000;

  for (const item of items) {
    const name = decodeHtml(item.title?.rendered || '');
    if (!name) continue;
    const dateStr = (item.date || '').slice(0, 10);
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (d < today || d > cutoff) continue;

    const key = `${name.toLowerCase()}|${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

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
      url: item.link || `${METELI_BASE}/kaupunki/tampere`,
      desc: `${name}${cleanVenue ? ' @ ' + cleanVenue : ''}`,
      _source: 'meteli',
      _key: key,
    });
  }
  return events;
}

// ── 2. tapahtumat.tampere.fi ──────────────────────────────────────────────
async function fetchTampereCalEvents() {
  console.log('\n=== tapahtumat.tampere.fi ===');
  try {
    const { json } = await apiFetch(`${TAMPERE_CAL_URL}?${TAMPERE_CAL_PARAMS}`);
    const pages = json.pages || [];
    console.log(`  Haettu: ${pages.length} sivua`);
    return pages;
  } catch (e) {
    console.log('  Virhe:', e.message);
    return [];
  }
}

function buildTampereCalEvents(pages, today, cutoff) {
  const events = [];
  let id = 20000;

  for (const p of pages) {
    if (p.pageType !== 'event') continue;
    const name = (p.name || '').trim();
    if (!name) continue;

    const ev = p.event || {};
    const startIso = ev.start || p.defaultStartDate || '';
    const endIso   = ev.end   || p.defaultEndDate   || '';
    if (!startIso) continue;

    const startDate = startIso.slice(0, 10);
    const endDate   = endIso ? endIso.slice(0, 10) : startDate;

    const d = new Date(startDate);
    const dEnd = new Date(endDate);

    // Rajaus: tapahtuma ei saa olla päättynyt eikä liian kaukana tulevaisuudessa
    if (dEnd < today) continue;
    if (d > cutoff) continue;

    // Poistetaan vanhat pitkäkestoiset näyttelyt ym. jotka ovat alkaneet yli 14 pv sitten
    // (festivaalit ja viikonlopputapahtumat jotka ovat käynnissä näkyvät silti)
    const twoWeeksAgo = new Date(today);
    twoWeeksAgo.setDate(today.getDate() - 14);
    if (d < twoWeeksAgo) continue;

    // Sijainti
    const locs = p.locations || [];
    const locObj = locs[0] || {};
    const rawAddress = (locObj.alt?.fi?.address || locObj.address || '').trim();
    // Yritä löytää paikkanimi osoitteesta
    const venuePart = rawAddress.split(',')[0].trim();
    const coordsFromMap = venueCoords(venuePart);
    const lat = locObj.lat || coordsFromMap.lat;
    const lng = locObj.lng || coordsFromMap.lng;
    const address = rawAddress || coordsFromMap.address;
    const location = venuePart || 'Tampere';

    // Hinta
    let price = 'Maksuton';
    if (p.hasPrice && p.price) {
      const min = p.price.min ?? 0;
      const max = p.price.max ?? 0;
      if (min === 0 && max === 0) price = 'Maksuton';
      else if (min === max) price = `${min} €`;
      else price = `${min}–${max} €`;
    } else if (p.hasPrice) {
      price = 'Tarkista sivulta';
    }

    // Kategoria
    const cat = resolveCategory(p.globalContentCategories || []);

    // Päivämääräformaatti
    const dates = isoFmtRange(startDate, endDate);

    const url = `${TAMPERE_CAL_FRONTEND}/${p._id}`;
    const key = `${name.toLowerCase()}|${startDate}`;

    events.push({
      id: id++,
      name,
      sub: location,
      dates,
      startDate,
      endDate,
      month: parseInt(startDate.split('-')[1]),
      cat,
      location,
      address: address || 'Tampere',
      lat,
      lng,
      price,
      url,
      desc: p.descriptionShort ? `${name} — ${p.descriptionShort}`.slice(0, 200) : name,
      _source: 'tampere-cal',
      _key: key,
    });
  }
  return events;
}

// ── 3. tiketti.fi ─────────────────────────────────────────────────────────
async function fetchTikettiData() {
  console.log('\n=== tiketti.fi ===');
  try {
    const { json } = await apiFetch(TIKETTI_DATA_URL);
    const events = json.events || [];
    const locs = json.locations || {};
    const tags = json.tags || {};
    const keys = json.keys || [];
    console.log(`  Haettu: ${events.length} tapahtumaa yhteensä`);
    return { events, locs, tags, keys };
  } catch (e) {
    console.log('  Virhe:', e.message);
    return { events: [], locs: {}, tags: {}, keys: [] };
  }
}

function parseTikettiPrice(raw) {
  if (!raw) return 'Tarkista sivulta';
  return raw.replace(/&euro;/g, '€').replace(/&amp;/g, '&').replace(/alk\.\s*/i, 'alk. ').trim();
}

function tikettiCategory(eventTags) {
  const tagSet = new Set(eventTags.map(String));
  // Festivaali → iso
  if (tagSet.has(TIKETTI_FESTIVAL_TAG)) return 'iso';
  // Pääkategoria-järjestys: urheilu, lapset, ruoka, teatteri, viihde, musiikki
  for (const [id, cat] of Object.entries(TIKETTI_CAT)) {
    if (tagSet.has(id)) {
      // Musiikki: tarkista onko konsertti-alatyyli
      if (id === '1') {
        for (const s of TIKETTI_KONSERT_STYLES) {
          if (tagSet.has(s)) return 'konsertti';
        }
        return 'keikka';
      }
      return cat;
    }
  }
  return 'keikka';
}

function buildTikettiEvents({ events, locs, tags, keys }, today, cutoff) {
  const K = Object.fromEntries(keys.map((k, i) => [k, i]));

  // Tampere-paikkojen ID:t
  const tampereLocIds = new Set(
    Object.entries(locs)
      .filter(([, loc]) => typeof loc === 'object' && loc.city === 'Tampere')
      .map(([id]) => id)
  );

  const result = [];
  let id = 30000;
  const seen = new Set();

  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(today.getDate() - 14);

  // Tagit joita ei näytetä (lahjakortit, kausikortit)
  const SKIP_TAGS = new Set(['89', '90', '42']); // Lahjakortti, Kausikortti, Tuote

  for (const ev of events) {
    const locId = String(ev[K.locationID] || '');
    if (!tampereLocIds.has(locId)) continue;

    // Ohita lahjakortit ja kausikortit
    const evTags = (ev[K.tags] || []).map(String);
    if (evTags.some(t => SKIP_TAGS.has(t))) continue;

    const startDate = String(ev[K.start_date] || '').slice(0, 10);
    const endDate   = String(ev[K.end_date]   || startDate).slice(0, 10);
    if (!startDate) continue;

    const d    = new Date(startDate);
    const dEnd = new Date(endDate);
    if (dEnd < today) continue;
    if (d > cutoff) continue;
    // Ohita tapahtumat jotka ovat alkaneet yli 14 pv sitten
    if (d < twoWeeksAgo) continue;

    const name = decodeHtml(String(ev[K.name] || '').trim());
    if (!name) continue;

    const key = `${name.toLowerCase()}|${startDate}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const loc = locs[locId] || {};
    const venueName = loc.name || '';
    const { address, lat, lng } = venueCoords(venueName);

    const rawPrice = String(ev[K.priceinfo] || '');
    const price = parseTikettiPrice(rawPrice);

    const relUrl = String(ev[K.url] || '');
    const url = relUrl ? TIKETTI_BASE + relUrl : TIKETTI_BASE;

    const cat = tikettiCategory(ev[K.tags] || []);
    const dates = isoFmtRange(startDate, endDate);

    result.push({
      id: id++,
      name,
      sub: venueName || 'Tampere',
      dates,
      startDate,
      endDate,
      month: parseInt(startDate.split('-')[1]),
      cat,
      location: venueName || 'Tampere',
      address: address || 'Tampere',
      lat,
      lng,
      price,
      url,
      desc: name,
      _source: 'tiketti',
      _key: key,
    });
  }
  return result;
}

// ── Yhdistä ja deduploi ───────────────────────────────────────────────────
function mergeAndDedup(meteliEvents, tampereEvents, tikettiEvents) {
  // Prioriteetti: meteli.net > tiketti.fi > tapahtumat.tampere.fi
  // Deduplointi nimi+päivä-avaimella.
  const usedKeys = new Set();

  const out = [];
  for (const src of [meteliEvents, tikettiEvents, tampereEvents]) {
    for (const e of src) {
      if (!usedKeys.has(e._key)) {
        usedKeys.add(e._key);
        out.push(e);
      }
    }
  }

  // Poista sisäiset kentät
  for (const e of out) { delete e._source; delete e._key; }
  out.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return out;
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

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() + 49); cutoff.setHours(23, 59, 59, 999);

  // 1. meteli.net
  const meteliItems = await fetchMeteliEvents();
  let meteliEvents = [];
  if (meteliItems.length > 0) {
    const paikkaIds = [...new Set(meteliItems.flatMap(i => i.paikka || []))];
    console.log(`  Eri paikkoja: ${paikkaIds.length}`);
    const venueMap = await fetchVenueNames(paikkaIds);
    meteliEvents = buildMeteliEvents(meteliItems, venueMap, today, cutoff);
    console.log(`  Tulevat keikat: ${meteliEvents.length}`);
  }

  // 2. tapahtumat.tampere.fi
  const calPages = await fetchTampereCalEvents();
  const calEvents = buildTampereCalEvents(calPages, today, cutoff);
  console.log(`  Tulevat tapahtumat: ${calEvents.length}`);

  // 3. tiketti.fi
  const tikettiData = await fetchTikettiData();
  const tikettiEvents = buildTikettiEvents(tikettiData, today, cutoff);
  console.log(`  Tampere-tapahtumat: ${tikettiEvents.length}`);

  // Yhdistä
  const events = mergeAndDedup(meteliEvents, calEvents, tikettiEvents);
  console.log(`\nYhteensä (deduplikoitu): ${events.length} tapahtumaa`);

  if (events.length === 0) { console.log('Ei tapahtumia — index.html ennallaan.'); return; }

  // Näytä otanta
  events.slice(0, 25).forEach(e => console.log(`  ${e.startDate} [${e.cat}] ${e.name} @ ${e.location}`));
  if (events.length > 25) console.log(`  ... ja ${events.length - 25} muuta`);

  // Päivitä index.html
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const S = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const E = '/* ── AUTO-SCRAPED-END ── */';
  const si = html.indexOf(S), ei = html.indexOf(E);
  if (si === -1 || ei === -1) { console.error('Merkinnät puuttuu!'); process.exit(1); }

  const now = new Date().toISOString().slice(0, 10);
  const out = `${html.slice(0, si + S.length)}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa (meteli.net + tapahtumat.tampere.fi + tiketti.fi) */\n${eventsToJs(events)},\n  ${html.slice(ei)}`;
  fs.writeFileSync(INDEX_PATH, out);
  console.log('\n✓ index.html päivitetty');
}

main().catch(e => { console.error(e); process.exit(1); });
