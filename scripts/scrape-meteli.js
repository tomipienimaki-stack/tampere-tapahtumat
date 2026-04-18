/**
 * scrape-meteli.js
 * Hakee tulevat keikat meteli.net/kaupunki/tampere -sivulta.
 *
 * Strategia 1: RSS-syöte (nopea, ei selainta)
 * Strategia 2: Puppeteer (headless browser, jos RSS ei toimi)
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
const METELI_URL  = 'https://www.meteli.net/kaupunki/tampere';
const METELI_RSS  = 'https://www.meteli.net/kaupunki/tampere/feed/';

// ── Tunnetut keikapaikat ──────────────────────────────────────────────────
const VENUES = {
  'klubi':           { address: 'Hämeenkatu 28',          lat: 61.4978, lng: 23.7625 },
  'telakka':         { address: 'Tullikamarin aukio 3',   lat: 61.5018, lng: 23.7698 },
  'pakkahuone':      { address: 'Itsenäisyydenkatu 8',    lat: 61.5024, lng: 23.7695 },
  'olympia':         { address: 'Hämeenkatu 26',          lat: 61.4975, lng: 23.7618 },
  'uusi apteekki':   { address: 'Rautatienkatu 8',        lat: 61.4982, lng: 23.7651 },
  'varjobaari':      { address: 'Hämeenpuisto 23',        lat: 61.4985, lng: 23.7558 },
  'vastavirta':      { address: 'Sammonkatu 67',          lat: 61.5008, lng: 23.7628 },
  'nokia areena':    { address: 'Kansikatu 3',            lat: 61.5044, lng: 23.7760 },
  'tampere areena':  { address: 'Kansikatu 3',            lat: 61.5044, lng: 23.7760 },
  'tampere-talo':    { address: 'Yliopistonkatu 55',      lat: 61.5031, lng: 23.7812 },
  'tullikamari':     { address: 'Tullikamarin aukio 2',   lat: 61.5020, lng: 23.7690 },
  'g livelab':       { address: 'Tohlopinkatu 29',        lat: 61.5088, lng: 23.7840 },
  'plevna':          { address: 'Itsenäisyydenkatu 2',    lat: 61.5030, lng: 23.7680 },
  'bar olympia':     { address: 'Hämeenkatu 26',          lat: 61.4975, lng: 23.7618 },
  'yo-talo':         { address: 'Kalevantie 2',           lat: 61.5003, lng: 23.7736 },
  'tavara-asema':    { address: 'Kuninkaankatu 16',       lat: 61.4980, lng: 23.7600 },
  'asemamestari':    { address: 'Rautatienkatu 24',       lat: 61.4990, lng: 23.7650 },
  'ttt-klubi':       { address: 'Hämeenpuisto 28',        lat: 61.4990, lng: 23.7570 },
  'pispala':         { address: 'Pispala',                lat: 61.5100, lng: 23.7250 },
};
const DEFAULT_LOC = { address: 'Tampere', lat: 61.4981, lng: 23.7608 };

function venueInfo(raw) {
  if (!raw) return DEFAULT_LOC;
  const key = raw.toLowerCase().trim();
  for (const [k, v] of Object.entries(VENUES)) {
    if (key.includes(k)) return { ...v, location: raw };
  }
  return { ...DEFAULT_LOC, location: raw };
}

function parseISODate(raw) {
  // RSS pubDate: "Sat, 18 Apr 2026 00:00:00 +0000"
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function parseFiDate(raw) {
  // Finnish format: "LA 18.04." tai "18.4.2026"
  if (!raw) return null;
  const cleaned = raw.replace(/^(ma|ti|ke|to|pe|la|su)\s*/i, '').trim();
  const m = cleaned.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (!m) return null;
  const day   = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year  = m[3] || new Date().getFullYear().toString();
  return `${year}-${month}-${day}`;
}

function fmtDates(dateStr, timeStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-');
  return `${parseInt(d)}.${parseInt(mo)}.${y}${timeStr ? ' klo ' + timeStr : ''}`;
}

// ── Strategia 1: RSS ──────────────────────────────────────────────────────
async function scrapeRSS() {
  console.log('Kokeillaan RSS-syötettä:', METELI_RSS);
  const res = await fetch(METELI_RSS, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TampereTapahtumat/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();

  // Parsitaan RSS XML yksinkertaisella regexillä (ei tarvita cheerio)
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  console.log(`RSS: ${items.length} artikkelia`);

  const results = [];
  for (const item of items) {
    const title   = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                 || item.match(/<title>(.*?)<\/title>/)?.[1] || '';
    const link    = item.match(/<link>(.*?)<\/link>/)?.[1]
                 || item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] || '';
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
    const desc    = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1]
                 || item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';

    if (!title.trim()) continue;

    // Venue ja hinta ovat usein descriptionissa tai titlessa
    // Esim: "Haloo Helsinki! @ Nokia-areena, Tampere – alk. 59,90 €"
    const venueMatch = title.match(/@\s*([^–—]+?)(?:\s*[–—]|$)/) ||
                       desc.match(/(?:venue|paikka|venue):\s*([^\n<]+)/i);
    const priceMatch = desc.match(/alk[.\s]+(\d[\d,–\-\s]+€?)/i) ||
                       title.match(/alk[.\s]+(\d[\d,–\-\s]+€?)/i);

    const venueRaw = venueMatch?.[1]?.trim() || '';
    const price    = priceMatch ? 'alk. ' + priceMatch[1].trim() : 'Tarkista sivulta';

    // Päivämäärä pubDate:sta tai descriptionista
    let dateStr = parseISODate(pubDate);
    if (!dateStr) {
      const fiDate = desc.match(/\d{1,2}\.\d{1,2}\.(?:\d{4})?/)?.[0];
      dateStr = parseFiDate(fiDate || '');
    }

    const cleanTitle = title.replace(/@.*$/, '').trim() || title.trim();
    results.push({ name: cleanTitle, venue: venueRaw, dateRaw: pubDate, timeRaw: '', price, url: link, dateStr });
  }

  return results;
}

// ── Strategia 2: Puppeteer ────────────────────────────────────────────────
async function scrapePuppeteer() {
  console.log('Käynnistetään Puppeteer (bundled Chromium)...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let rawEvents = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');
    page.on('console', msg => { if (msg.text().startsWith('DBG:')) console.log('[b]', msg.text()); });

    console.log(`Avataan: ${METELI_URL}`);
    await page.goto(METELI_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    // Yritä hyväksyä Gravito-consent
    try {
      await page.waitForSelector('#gravitoCMPRoot', { timeout: 6000 });
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]'));
        const btn = btns.find(b => /hyväksy|accept|salli/i.test(b.textContent));
        if (btn) { btn.click(); return btn.textContent.trim(); }
        // Fallback: klikkaa #gravitoCMPRoot ensimmäinen nappi
        document.querySelector('#gravitoCMPRoot button')?.click();
      });
      await new Promise(r => setTimeout(r, 2000));
      console.log('Consent-nappi klikattu, odotetaan renderöintiä...');
      await page.waitForSelector('article', { timeout: 10000 });
    } catch {
      console.log('Consent ei ilmestynyt tai articles jo näkyvillä');
    }

    const artCount = await page.evaluate(() => document.querySelectorAll('article').length);
    console.log(`article-elementtejä: ${artCount}`);

    const SKIP = /^(löydä liput|osta liput|buy tickets|lisää tietoa)$/i;
    const DAY  = /^(MA|TI|KE|TO|PE|LA|SU)$/i;
    const DATE = /^\d{1,2}\.\d{1,2}\.?$/;
    const TIME = /^\d{2}:\d{2}$/;

    rawEvents = await page.evaluate((skipRe, dayRe, dateRe, timeRe) => {
      const SKIP = new RegExp(skipRe, 'i');
      const DAY  = new RegExp(dayRe,  'i');
      const DATE = new RegExp(dateRe);
      const TIME = new RegExp(timeRe);
      const results = [];

      const arts = document.querySelectorAll('article');
      console.log('DBG: article-määrä=' + arts.length);

      arts.forEach(art => {
        const lines = (art.innerText || '').split('\n').map(l => l.trim()).filter(l => l && !SKIP.test(l));
        const dateIdx = lines.findIndex(l => DATE.test(l));
        if (dateIdx === -1) return;
        const dayIdx  = lines.findIndex(l => DAY.test(l));
        const after   = Math.max(dayIdx, dateIdx) + 1;
        const name    = lines[after];
        if (!name || name.length < 2) return;
        const dateRaw = [dayIdx >= 0 ? lines[dayIdx] : '', lines[dateIdx]].filter(Boolean).join(' ');
        const vp = lines[after + 1] || '';
        let venue = '', price = '';
        if (vp.includes(' - alk. ')) {
          const p = vp.split(' - alk. ');
          venue = p[0].split(',')[0].trim();
          price = 'alk. ' + p[1].trim();
        } else { venue = vp.split(',')[0].trim(); }
        results.push({ name, venue, dateRaw, timeRaw: lines.find(l => TIME.test(l)) || '', price, url: art.querySelector('a[href]')?.href || '' });
      });
      return results;
    },
      SKIP.source, DAY.source, DATE.source, TIME.source
    );

    console.log(`Puppeteer: löydettiin ${rawEvents.length} raakatapahtumaa`);
  } finally {
    await browser.close();
  }
  return rawEvents;
}

// ── Suodatus ja muotoilu ──────────────────────────────────────────────────
function filterAndFormat(rawEvents, parseDate) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() + 42);
  const seen = new Set();
  const events = [];
  let id = 10000;

  for (const r of rawEvents) {
    const dateStr = parseDate(r.dateRaw || r.dateStr || '');
    if (!dateStr) continue;
    const d = new Date(dateStr);
    if (d < today || d > cutoff) continue;
    const key = `${r.name}|${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { address, lat, lng, location } = venueInfo(r.venue);
    events.push({
      id: id++, name: r.name, sub: r.venue || 'Tampere',
      dates: fmtDates(dateStr, r.timeRaw), startDate: dateStr, endDate: dateStr,
      month: parseInt(dateStr.split('-')[1]), cat: 'keikka',
      location: location || r.venue || 'Tampere', address, lat, lng,
      price: r.price || 'Tarkista sivulta', url: r.url || METELI_URL,
      desc: `${r.name}${r.venue ? ' @ ' + r.venue : ''}`,
    });
  }
  return events;
}

// ── index.html päivitys ───────────────────────────────────────────────────
function eventsToJs(events) {
  return events.map(e => {
    const f = [
      `id:${e.id}`, `name:${JSON.stringify(e.name)}`, `sub:${JSON.stringify(e.sub)}`,
      `dates:${JSON.stringify(e.dates)}`, `startDate:${JSON.stringify(e.startDate)}`,
      `endDate:${JSON.stringify(e.endDate)}`, `month:${e.month}`,
      `cat:${JSON.stringify(e.cat)}`, `location:${JSON.stringify(e.location)}`,
      `address:${JSON.stringify(e.address)}`, `lat:${e.lat}`, `lng:${e.lng}`,
      `price:${JSON.stringify(e.price)}`, `url:${JSON.stringify(e.url)}`, `desc:${JSON.stringify(e.desc)}`,
    ];
    return `  {${f.join(',')}}`;
  }).join(',\n');
}

async function main() {
  let events = [];

  // 1. Kokeile RSS
  try {
    const rssItems = await scrapeRSS();
    events = filterAndFormat(rssItems, r => parseISODate(r) || parseFiDate(r));
    console.log(`RSS-strategia: ${events.length} tulevaa tapahtumaa`);
  } catch (err) {
    console.log('RSS epäonnistui:', err.message, '— siirrytään Puppeteeriin');
  }

  // 2. Jos RSS antoi vähän tai ei mitään, käytä Puppeteeria
  if (events.length < 3) {
    try {
      const puppeteerItems = await scrapePuppeteer();
      const puppeteerEvents = filterAndFormat(puppeteerItems, r => parseFiDate(r));
      console.log(`Puppeteer-strategia: ${puppeteerEvents.length} tulevaa tapahtumaa`);
      if (puppeteerEvents.length > events.length) events = puppeteerEvents;
    } catch (err) {
      console.log('Puppeteer epäonnistui:', err.message);
    }
  }

  if (events.length === 0) {
    console.log('Ei tapahtumia kummastakaan lähteestä — index.html pysyy ennallaan.');
    return;
  }

  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const START = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const END   = '/* ── AUTO-SCRAPED-END ── */';
  const si = html.indexOf(START), ei = html.indexOf(END);
  if (si === -1 || ei === -1) { console.error('Merkintöjä ei löydy!'); process.exit(1); }

  const now = new Date().toISOString().slice(0, 10);
  const updated = `${html.slice(0, si + START.length)}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa */\n${eventsToJs(events)},\n  ${html.slice(ei)}`;
  fs.writeFileSync(INDEX_PATH, updated, 'utf8');
  console.log(`✓ index.html päivitetty — ${events.length} tapahtumaa`);
}

main().catch(err => { console.error(err); process.exit(1); });
