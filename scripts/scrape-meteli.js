/**
 * scrape-meteli.js
 * Hakee tulevat keikat meteli.net:stä.
 *
 * Strategia 1: WordPress REST API  (/wp-json/wp/v2/...)
 * Strategia 2: RSS-syöte            (/kaupunki/tampere/feed/)
 * Strategia 3: Puppeteer            (headless browser)
 *
 * Ajo:  node scripts/scrape-meteli.js
 * CI:   GitHub Actions ajaa tämän viikoittain
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const BASE = 'https://www.meteli.net';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept': 'application/json, text/html, */*',
  'Accept-Language': 'fi-FI,fi;q=0.9',
};

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
const DEFAULT_LOC = { address: 'Tampere', lat: 61.4981, lng: 23.7608 };

function venueInfo(raw) {
  if (!raw) return DEFAULT_LOC;
  const key = raw.toLowerCase();
  for (const [k, v] of Object.entries(VENUES)) {
    if (key.includes(k)) return { ...v, location: raw };
  }
  return { ...DEFAULT_LOC, location: raw };
}

function isoToFmt(iso, time) {
  if (!iso) return '';
  const [y, mo, d] = iso.split('-');
  return `${parseInt(d)}.${parseInt(mo)}.${y}${time ? ' klo ' + time : ''}`;
}

function filterEvents(items) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + 42);
  const seen = new Set();
  const events = [];
  let id = 10000;

  for (const r of items) {
    if (!r.dateStr) continue;
    const d = new Date(r.dateStr);
    if (d < today || d > cutoff) continue;
    const key = `${r.name}|${r.dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { address, lat, lng, location } = venueInfo(r.venue || '');
    events.push({
      id: id++, name: r.name, sub: r.venue || 'Tampere',
      dates: isoToFmt(r.dateStr, r.time),
      startDate: r.dateStr, endDate: r.dateStr,
      month: parseInt(r.dateStr.split('-')[1]), cat: 'keikka',
      location: location || r.venue || 'Tampere', address, lat, lng,
      price: r.price || 'Tarkista sivulta', url: r.url || BASE + '/kaupunki/tampere',
      desc: `${r.name}${r.venue ? ' @ ' + r.venue : ''}`,
    });
  }
  return events;
}

// ── Strategia 1: WordPress REST API ──────────────────────────────────────
async function tryWpApi() {
  // Ensin selvitetään mitä post-typejä on tarjolla
  const rootUrl = `${BASE}/wp-json/`;
  console.log('WP REST API:', rootUrl);
  const rootRes = await fetch(rootUrl, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!rootRes.ok) throw new Error(`WP JSON root HTTP ${rootRes.status}`);
  const root = await rootRes.json();

  const namespaces = root.namespaces || [];
  console.log('Namespacet:', namespaces.join(', '));

  // Kokeile eri post-tyyppejä
  const tryTypes = ['posts', 'events', 'gig', 'concert', 'event', 'keikka'];
  let allItems = [];

  for (const type of tryTypes) {
    const url = `${BASE}/wp-json/wp/v2/${type}?per_page=100&_fields=id,title,date,link,meta,excerpt,content,categories,tags`;
    try {
      const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const items = await r.json();
      if (!Array.isArray(items) || items.length === 0) continue;
      console.log(`wp/v2/${type}: ${items.length} kohdetta`);

      // Suodata Tampere-kohteet
      const tampere = items.filter(item => {
        const text = JSON.stringify(item).toLowerCase();
        return text.includes('tampere') || text.includes('nokia areena') || text.includes('klubi');
      });
      console.log(`  → ${tampere.length} Tampere-kohdetta`);

      for (const item of tampere) {
        const title = item.title?.rendered || item.title?.raw || '';
        const name  = title.replace(/<[^>]+>/g, '').trim();
        const dateStr = (item.date || '').slice(0, 10);
        const url2    = item.link || '';
        const content = (item.excerpt?.rendered || item.content?.rendered || '')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        const venueM  = content.match(/(?:Nokia.areena|Klubi|Telakka|Pakkahuone|Olympia|Tavara.asema|[A-ZÄÖÅ][a-zäöå]+-?(?:klubi|areena|talo|baari))/i);
        const priceM  = content.match(/alk[.\s]+(\d[\d,–\-\s]+€?)/i);

        allItems.push({
          name, dateStr, venue: venueM?.[0] || '',
          price: priceM ? 'alk. ' + priceM[1].trim() : '',
          url: url2,
        });
      }
      if (allItems.length > 0) break;
    } catch { continue; }
  }
  return allItems;
}

// ── Strategia 2: RSS ──────────────────────────────────────────────────────
async function tryRSS() {
  const urls = [
    `${BASE}/kaupunki/tampere/feed/`,
    `${BASE}/feed/?city=tampere`,
    `${BASE}/?feed=rss2&city=tampere`,
  ];
  for (const rssUrl of urls) {
    console.log('RSS:', rssUrl);
    try {
      const r = await fetch(rssUrl, { headers: { ...HEADERS, Accept: 'application/rss+xml, text/xml' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) { console.log('  HTTP', r.status); continue; }
      const xml = await r.text();
      const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
      console.log(`  ${items.length} artikkelia`);
      if (items.length === 0) continue;

      const results = [];
      for (const item of items) {
        const title   = (item.match(/<title><!\[CDATA\[(.*?)\]\]>/)?.[1] || item.match(/<title>(.*?)<\/title>/)?.[1] || '').trim();
        const link    = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
        const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        if (!title) continue;
        const dateStr = new Date(pubDate).toISOString().slice(0, 10);
        if (dateStr === 'NaN-aN-aN') continue;
        results.push({ name: title, dateStr, venue: '', price: '', url: link });
      }
      if (results.length > 0) return results;
    } catch (e) { console.log('  Virhe:', e.message); }
  }
  return [];
}

// ── Strategia 3: Puppeteer ────────────────────────────────────────────────
async function tryPuppeteer() {
  console.log('Puppeteer (bundled Chromium)...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  let results = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent(HEADERS['User-Agent']);
    // Aseta evästeet etukäteen
    await page.setCookie({ name: 'gravitoConsent', value: '1', domain: 'www.meteli.net' });
    await page.setCookie({ name: 'gravito-consent', value: 'accepted', domain: 'www.meteli.net' });

    console.log('Avataan:', BASE + '/kaupunki/tampere');
    await page.goto(BASE + '/kaupunki/tampere', { waitUntil: 'networkidle2', timeout: 40000 });

    const artCount = await page.evaluate(() => document.querySelectorAll('article').length);
    console.log('article-elementtejä:', artCount);

    if (artCount === 0) {
      const debug = await page.evaluate(() => document.body.innerText.slice(0, 300));
      console.log('Body:', debug);
      return [];
    }

    const SKIP = /^(löydä liput|osta liput|buy tickets)$/i;
    const DAY  = /^(MA|TI|KE|TO|PE|LA|SU)$/i;
    const DATE = /^\d{1,2}\.\d{1,2}\.?$/;

    results = await page.evaluate((s, dy, dt) => {
      const SKIP = new RegExp(s, 'i'), DAY = new RegExp(dy, 'i'), DATE = new RegExp(dt);
      return Array.from(document.querySelectorAll('article')).flatMap(art => {
        const lines = (art.innerText||'').split('\n').map(l=>l.trim()).filter(l=>l&&!SKIP.test(l));
        const dateIdx = lines.findIndex(l=>DATE.test(l));
        if (dateIdx===-1) return [];
        const dayIdx = lines.findIndex(l=>DAY.test(l));
        const after = Math.max(dayIdx,dateIdx)+1;
        const name = lines[after]; if(!name||name.length<2) return [];
        const dayStr = dayIdx>=0?lines[dayIdx]:'';
        const vp = lines[after+1]||'';
        let venue='',price='';
        if (vp.includes(' - alk. ')) { const p=vp.split(' - alk. '); venue=p[0].split(',')[0].trim(); price='alk. '+p[1].trim(); }
        else { venue=vp.split(',')[0].trim(); }
        return [{ name, venue, dateRaw: [dayStr,lines[dateIdx]].filter(Boolean).join(' '), price, url: art.querySelector('a[href]')?.href||'' }];
      });
    }, SKIP.source, DAY.source, DATE.source);

    // Muunna fi-päivämäärä ISO-muotoon
    const year = new Date().getFullYear();
    results = results.map(r => {
      const m = r.dateRaw.match(/(\d{1,2})\.(\d{1,2})\./);
      const dateStr = m ? `${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}` : '';
      return { ...r, dateStr };
    });
    console.log('Puppeteer: löydettiin', results.length, 'tapahtumaa');
  } finally { await browser.close(); }
  return results;
}

// ── Kirjoita index.html ───────────────────────────────────────────────────
function eventsToJs(events) {
  return events.map(e => {
    const f = [
      `id:${e.id}`,`name:${JSON.stringify(e.name)}`,`sub:${JSON.stringify(e.sub)}`,
      `dates:${JSON.stringify(e.dates)}`,`startDate:${JSON.stringify(e.startDate)}`,
      `endDate:${JSON.stringify(e.endDate)}`,`month:${e.month}`,`cat:${JSON.stringify(e.cat)}`,
      `location:${JSON.stringify(e.location)}`,`address:${JSON.stringify(e.address)}`,
      `lat:${e.lat}`,`lng:${e.lng}`,`price:${JSON.stringify(e.price)}`,
      `url:${JSON.stringify(e.url)}`,`desc:${JSON.stringify(e.desc)}`,
    ];
    return `  {${f.join(',')}}`;
  }).join(',\n');
}

async function main() {
  let raw = [];
  let source = '';

  // 1. WP REST API
  try {
    raw = await tryWpApi();
    if (raw.length > 0) source = 'wp-api';
  } catch (e) { console.log('WP API epäonnistui:', e.message); }

  // 2. RSS
  if (raw.length < 3) {
    try {
      const rss = await tryRSS();
      if (rss.length > raw.length) { raw = rss; source = 'rss'; }
    } catch (e) { console.log('RSS epäonnistui:', e.message); }
  }

  // 3. Puppeteer
  if (raw.length < 3) {
    try {
      const pp = await tryPuppeteer();
      if (pp.length > raw.length) { raw = pp; source = 'puppeteer'; }
    } catch (e) { console.log('Puppeteer epäonnistui:', e.message); }
  }

  const events = filterEvents(raw);
  console.log(`\nLähde: ${source || 'ei mitään'} → ${events.length} tulevaa tapahtumaa`);

  if (events.length === 0) {
    console.log('Ei tapahtumia — index.html pysyy ennallaan.');
    return;
  }

  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const S = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const E = '/* ── AUTO-SCRAPED-END ── */';
  const si = html.indexOf(S), ei = html.indexOf(E);
  if (si===-1||ei===-1) { console.error('Merkinnät puuttuu!'); process.exit(1); }

  const now = new Date().toISOString().slice(0,10);
  const out = `${html.slice(0,si+S.length)}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa (${source}) */\n${eventsToJs(events)},\n  ${html.slice(ei)}`;
  fs.writeFileSync(INDEX_PATH, out);
  console.log(`✓ index.html päivitetty`);
}

main().catch(e => { console.error(e); process.exit(1); });
