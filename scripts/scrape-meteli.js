/**
 * scrape-meteli.js
 * Hakee tulevat keikat meteli.net/kaupunki/tampere -sivulta
 * ja päivittää index.html:n AUTO-SCRAPED-osioon.
 *
 * Ajo:  node scripts/scrape-meteli.js
 * CI:   GitHub Actions ajaa tämän viikoittain
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const METELI_URL = 'https://www.meteli.net/kaupunki/tampere';

// ── Tunnetut tamperelaiset keikapaikat koordinaatteineen ──────────────────
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
  'pispala':         { address: 'Pispala',                lat: 61.5100, lng: 23.7250 },
};

// Oletuskoordinaatit jos paikkaa ei tunneta
const DEFAULT_LOC = { address: 'Tampere', lat: 61.4981, lng: 23.7608 };

// ── Apufunktiot ──────────────────────────────────────────────────────────

function venueInfo(raw) {
  if (!raw) return DEFAULT_LOC;
  const key = raw.toLowerCase().trim();
  for (const [k, v] of Object.entries(VENUES)) {
    if (key.includes(k)) return { ...v, location: raw };
  }
  return { ...DEFAULT_LOC, location: raw };
}

/**
 * Muuntaa meteli.net-päivämäärän (esim. "pe 18.4.2026") ISO-muotoon "2026-04-18"
 */
function parseDate(raw) {
  if (!raw) return null;
  // Poista viikonpäivä ("pe ", "la ", "su " jne.)
  const cleaned = raw.replace(/^(ma|ti|ke|to|pe|la|su)\s+/i, '').trim();
  // Etsitään "18.4.2026" tai "18.4." (ilman vuotta)
  const m = cleaned.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})?/);
  if (!m) return null;
  const day   = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year  = m[3] || new Date().getFullYear().toString();
  return `${year}-${month}-${day}`;
}

/**
 * Muodostaa ihmisluettavan päivämäärä+aika-merkkijonon
 */
function fmtDates(dateStr, timeStr) {
  if (!dateStr) return '';
  const [y, mo, d] = dateStr.split('-');
  const time = timeStr ? ` klo ${timeStr}` : '';
  return `${parseInt(d)}.${parseInt(mo)}.${y}${time}`;
}

// ── Päälogiikka ──────────────────────────────────────────────────────────

async function scrape() {
  console.log(`Haetaan: ${METELI_URL}`);
  let html;
  try {
    const res = await fetch(METELI_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TampereTapahtumat/1.0)' },
      timeout: 15000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    console.error('Haku epäonnistui:', err.message);
    process.exit(1);
  }

  const $ = cheerio.load(html);
  const events = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Haetaan "tulevat 6 viikkoa" — ei lisätä jo menneitä
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + 42);

  // ── Yritetään useita eri selektoreita (meteli.net saattaa muuttua) ──
  // Primaariselektori: tyypillinen tapahtumalista
  const candidates = [
    '.event-item',
    '.gig',
    '.concert',
    'article.event',
    '.event_row',
    'tr.event',
    '.eventlist-item',
    '.list-item',
  ];

  let rows = $();
  for (const sel of candidates) {
    rows = $(sel);
    if (rows.length > 0) {
      console.log(`Löydettiin ${rows.length} tapahtumaa selektorilla: ${sel}`);
      break;
    }
  }

  // Jos ei löydy tunnettuja selektoreita, yritetään taulukon rivejä
  if (rows.length === 0) {
    rows = $('table tr').filter((_, el) => {
      const text = $(el).text();
      return text.includes('klo') || /\d+\.\d+\.\d{4}/.test(text);
    });
    console.log(`Fallback: taulukon rivit, ${rows.length} kpl`);
  }

  if (rows.length === 0) {
    console.error('Ei löydetty yhtään tapahtumaa. Tarkista meteli.net:n HTML-rakenne.');
    // Tulostetaan sivun alku debuggausta varten
    console.log('HTML-alku:', html.slice(0, 2000));
    process.exit(1);
  }

  let idCounter = 10000; // Scrapatut eventit alkavat 10000:sta

  rows.each((_, el) => {
    const row = $(el);

    // ── Nimi ──
    const name = (
      row.find('.event-name, .gig-name, .name, h2, h3, .title, a.event-link').first().text() ||
      row.find('td').eq(1).text() ||
      row.find('a').first().text()
    ).trim();

    if (!name || name.length < 2) return;

    // ── Paikka ──
    const venueRaw = (
      row.find('.venue, .event-venue, .location, .place').first().text() ||
      row.find('td').eq(2).text()
    ).trim();

    // ── Päivämäärä ──
    const dateRaw = (
      row.find('.date, .event-date, time').first().text() ||
      row.find('td').eq(0).text()
    ).trim();

    const dateStr = parseDate(dateRaw);
    if (!dateStr) return; // skipataan jos ei saada päivämäärää

    // Suodatetaan menneet ja liian kaukaiset
    const eventDate = new Date(dateStr);
    if (eventDate < today || eventDate > cutoff) return;

    // ── Aika ──
    const timeRaw = (
      row.find('.time, .event-time').first().text() ||
      dateRaw.match(/\d{2}:\d{2}/)?.[0] ||
      ''
    ).trim();

    // ── Hinta ──
    const priceRaw = (
      row.find('.price, .event-price, .ticket-price').first().text() ||
      row.find('td').eq(3).text()
    ).trim();
    const price = priceRaw.match(/[\d,]+\s*[€e]/i)?.[0]?.trim() || 'Tarkista sivulta';

    // ── URL ──
    const href = row.find('a').first().attr('href') || '';
    const url = href.startsWith('http') ? href : `https://www.meteli.net${href}`;

    // ── Kategoria ──
    const cat = 'keikka'; // meteli.net on keikat

    // ── Paikan koordinaatit ──
    const { address, lat, lng, location } = venueInfo(venueRaw);

    events.push({
      id: idCounter++,
      name,
      sub: venueRaw || 'Tampere',
      dates: fmtDates(dateStr, timeRaw),
      startDate: dateStr,
      endDate: dateStr,
      month: parseInt(dateStr.split('-')[1]),
      cat,
      location: location || venueRaw || 'Tampere',
      address,
      lat,
      lng,
      price,
      url,
      desc: `${name} @ ${venueRaw || 'Tampere'}`,
      _scraped: true,
    });
  });

  console.log(`Parsittu ${events.length} tulevaa tapahtumaa`);
  return events;
}

function eventsToJs(events) {
  return events.map(e => {
    const fields = [
      `id:${e.id}`,
      `name:${JSON.stringify(e.name)}`,
      `sub:${JSON.stringify(e.sub)}`,
      `dates:${JSON.stringify(e.dates)}`,
      `startDate:${JSON.stringify(e.startDate)}`,
      `endDate:${JSON.stringify(e.endDate)}`,
      `month:${e.month}`,
      `cat:${JSON.stringify(e.cat)}`,
      `location:${JSON.stringify(e.location)}`,
      `address:${JSON.stringify(e.address)}`,
      `lat:${e.lat}`,
      `lng:${e.lng}`,
      `price:${JSON.stringify(e.price)}`,
      `url:${JSON.stringify(e.url)}`,
      `desc:${JSON.stringify(e.desc)}`,
    ];
    return `  {${fields.join(',')}}`;
  }).join(',\n');
}

async function main() {
  const events = await scrape();

  if (events.length === 0) {
    console.log('Ei uusia tapahtumia lisättäväksi.');
    return;
  }

  // Luetaan index.html
  let html = fs.readFileSync(INDEX_PATH, 'utf8');

  // Korvataan AUTO-SCRAPED-osio
  const startMarker = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const endMarker   = '/* ── AUTO-SCRAPED-END ── */';
  const startIdx = html.indexOf(startMarker);
  const endIdx   = html.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error('AUTO-SCRAPED -merkintöjä ei löydy index.html:stä!');
    process.exit(1);
  }

  const before = html.slice(0, startIdx + startMarker.length);
  const after  = html.slice(endIdx);
  const now    = new Date().toISOString().slice(0, 10);

  const newBlock = `${before}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa meteli.net/kaupunki/tampere */\n${eventsToJs(events)},\n  ${after}`;

  fs.writeFileSync(INDEX_PATH, newBlock, 'utf8');
  console.log(`index.html päivitetty — ${events.length} tapahtumaa lisätty`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
