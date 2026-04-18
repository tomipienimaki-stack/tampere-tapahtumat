/**
 * scrape-meteli.js
 * Hakee tulevat keikat meteli.net:n WordPress REST API:sta.
 * Endpoint: /wp-json/wp/v2/tapahtuma (custom post type)
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

// ── Keikapaikat ───────────────────────────────────────────────────────────
const VENUES = {
  'klubi':          { address: 'Hämeenkatu 28',         lat: 61.4978, lng: 23.7625 },
  'telakka':        { address: 'Tullikamarin aukio 3',  lat: 61.5018, lng: 23.7698 },
  'pakkahuone':     { address: 'Itsenäisyydenkatu 8',   lat: 61.5024, lng: 23.7695 },
  'olympia':        { address: 'Hämeenkatu 26',         lat: 61.4975, lng: 23.7618 },
  'uusi apteekki':  { address: 'Rautatienkatu 8',       lat: 61.4982, lng: 23.7651 },
  'varjobaari':     { address: 'Hämeenpuisto 23',       lat: 61.4985, lng: 23.7558 },
  'vastavirta':     { address: 'Sammonkatu 67',         lat: 61.5008, lng: 23.7628 },
  'nokia areena':   { address: 'Kansikatu 3',           lat: 61.5044, lng: 23.7760 },
  'tampere areena': { address: 'Kansikatu 3',           lat: 61.5044, lng: 23.7760 },
  'tampere-talo':   { address: 'Yliopistonkatu 55',     lat: 61.5031, lng: 23.7812 },
  'tullikamari':    { address: 'Tullikamarin aukio 2',  lat: 61.5020, lng: 23.7690 },
  'g livelab':      { address: 'Tohlopinkatu 29',       lat: 61.5088, lng: 23.7840 },
  'plevna':         { address: 'Itsenäisyydenkatu 2',   lat: 61.5030, lng: 23.7680 },
  'tavara-asema':   { address: 'Kuninkaankatu 16',      lat: 61.4980, lng: 23.7600 },
  'asemamestari':   { address: 'Rautatienkatu 24',      lat: 61.4990, lng: 23.7650 },
  'ttt-klubi':      { address: 'Hämeenpuisto 28',       lat: 61.4990, lng: 23.7570 },
};
const DEF = { address: 'Tampere', lat: 61.4981, lng: 23.7608 };

function venueInfo(raw) {
  if (!raw) return DEF;
  const key = raw.toLowerCase();
  for (const [k, v] of Object.entries(VENUES)) {
    if (key.includes(k)) return { ...v, location: raw };
  }
  return { ...DEF, location: raw };
}

// Dekoodaa HTML-entiteetit tekstissä
function decodeHtml(str) {
  return (str || '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '').trim();
}

function isoFmt(iso, time) {
  if (!iso || iso.startsWith('NaN')) return '';
  const [y, mo, d] = iso.split('-');
  return `${parseInt(d)}.${parseInt(mo)}.${y}${time ? ' klo ' + time : ''}`;
}

// ── Haku WP REST API:sta ──────────────────────────────────────────────────
async function fetchTapahtumat() {
  const allItems = [];
  let page = 1;

  while (true) {
    const url = `${BASE}/wp-json/wp/v2/tapahtuma?per_page=100&page=${page}&_fields=id,title,date,link,excerpt,content,meta`;
    console.log(`Sivu ${page}: ${url}`);
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.log(`HTTP ${res.status} — lopetetaan`); break; }
    const items = await res.json();
    if (!Array.isArray(items) || items.length === 0) break;
    allItems.push(...items);
    const total = parseInt(res.headers.get('X-WP-TotalPages') || '1');
    console.log(`  ${items.length} kpl, sivu ${page}/${total}`);
    if (page >= total) break;
    page++;
  }

  console.log(`Yhteensä: ${allItems.length} tapahtumaa`);
  return allItems;
}

// ── Parsinta ja suodatus ──────────────────────────────────────────────────
function processItems(items) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + 42);
  const seen = new Set();
  const events = [];
  let id = 10000;

  for (const item of items) {
    const name = decodeHtml(item.title?.rendered || '');
    if (!name) continue;

    // Päivämäärä: WP date-kenttä on ISO (esim. "2026-04-18T00:00:00")
    const dateStr = (item.date || '').slice(0, 10);
    if (!dateStr || dateStr === 'NaN-aN-aN') continue;

    const d = new Date(dateStr);
    if (d < today || d > cutoff) continue;

    const key = `${name}|${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Yritä löytää paikka excerpt/content kentistä
    const rawContent = decodeHtml(item.excerpt?.rendered || item.content?.rendered || '');
    const venueM = rawContent.match(
      /\b(Nokia.?areena|Tampere.?areena|Klubi|Telakka|Pakkahuone|Olympia|Uusi apteekki|Varjobaari|Vastavirta|G livelab|Plevna|Tavara.?asema|Asemamestari|TTT.?klubi|Tullikamari)\b/i
    );
    const venue = venueM?.[0] || '';

    // Hinta
    const priceM = rawContent.match(/(?:alk\.|lippu|liput|tickets?)[\s:]+(\d[\d,–\-\s]+€?)/i)
                || rawContent.match(/(\d+[,.]?\d*)\s*€/);
    const price = priceM ? 'alk. ' + priceM[1].trim() + ' €' : 'Tarkista sivulta';

    // Meta-kentät (jos löytyy)
    const meta = item.meta || {};
    const metaVenue = meta.venue || meta.location || meta.place || '';
    const finalVenue = metaVenue || venue;

    const { address, lat, lng, location } = venueInfo(finalVenue);

    events.push({
      id: id++,
      name,
      sub: finalVenue || 'Tampere',
      dates: isoFmt(dateStr, ''),
      startDate: dateStr,
      endDate: dateStr,
      month: parseInt(dateStr.split('-')[1]),
      cat: 'keikka',
      location: location || finalVenue || 'Tampere',
      address,
      lat,
      lng,
      price,
      url: item.link || `${BASE}/kaupunki/tampere`,
      desc: `${name}${finalVenue ? ' @ ' + finalVenue : ''}`,
    });
  }

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
  // Etsitään myös Tampere-suodatukseen muita kaupunkeja mukaan
  const items = await fetchTapahtumat();

  // Suodata Tampere-kohteet
  const tampere = items.filter(item => {
    const text = JSON.stringify(item).toLowerCase();
    return text.includes('tampere') || text.includes('nokia areena');
  });
  console.log(`Tampere-kohteet: ${tampere.length} / ${items.length}`);

  // Debug: tulosta ensimmäinen event täydellisenä
  if (tampere.length > 0) {
    const first = tampere[0];
    console.log('Esimerkki event:', JSON.stringify({
      id: first.id,
      title: first.title?.rendered,
      date: first.date,
      link: first.link,
      excerpt: first.excerpt?.rendered?.slice(0, 200),
      meta: first.meta,
    }, null, 2));
  }

  const events = processItems(tampere);
  console.log(`\nTulevat tapahtumat (42 pv): ${events.length}`);
  events.forEach(e => console.log(`  ${e.startDate} ${e.name} @ ${e.sub}`));

  if (events.length === 0) {
    console.log('Ei tapahtumia — index.html ennallaan.');
    return;
  }

  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const S = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const E = '/* ── AUTO-SCRAPED-END ── */';
  const si = html.indexOf(S), ei = html.indexOf(E);
  if (si === -1 || ei === -1) { console.error('Merkinnät puuttuu!'); process.exit(1); }

  const now = new Date().toISOString().slice(0, 10);
  const out = `${html.slice(0, si + S.length)}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa (meteli.net WP API) */\n${eventsToJs(events)},\n  ${html.slice(ei)}`;
  fs.writeFileSync(INDEX_PATH, out);
  console.log('✓ index.html päivitetty');
}

main().catch(e => { console.error(e); process.exit(1); });
