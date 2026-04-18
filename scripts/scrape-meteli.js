/**
 * scrape-meteli.js
 * Hakee tulevat keikat meteli.net/kaupunki/tampere -sivulta Puppeteerilla
 * (sivu renderöi tapahtumat JavaScriptillä, joten fetch ei riitä).
 *
 * Ajo:  node scripts/scrape-meteli.js
 * CI:   GitHub Actions ajaa tämän viikoittain
 */

import puppeteer from 'puppeteer-core';
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

const DEFAULT_LOC = { address: 'Tampere', lat: 61.4981, lng: 23.7608 };

// ── Apufunktiot ───────────────────────────────────────────────────────────

function venueInfo(raw) {
  if (!raw) return DEFAULT_LOC;
  const key = raw.toLowerCase().trim();
  for (const [k, v] of Object.entries(VENUES)) {
    if (key.includes(k)) return { ...v, location: raw };
  }
  return { ...DEFAULT_LOC, location: raw };
}

function parseDate(raw) {
  if (!raw) return null;
  // Poista viikonpäivä ("pe ", "la ", "su " jne.)
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
  const time = timeStr ? ` klo ${timeStr}` : '';
  return `${parseInt(d)}.${parseInt(mo)}.${y}${time}`;
}

// ── Päälogiikka ───────────────────────────────────────────────────────────

async function scrape() {
  console.log('Käynnistetään Puppeteer...');

  // Käytetään järjestelmän Chromea (GitHub Actions -runnerilla on google-chrome-stable)
  const executablePath =
    process.env.CHROME_PATH ||
    '/usr/bin/google-chrome-stable';

  console.log(`Chrome: ${executablePath}`);

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  let rawEvents = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36');

    console.log(`Avataan: ${METELI_URL}`);
    await page.goto(METELI_URL, { waitUntil: 'networkidle2', timeout: 30000 });

    // Odotetaan että tapahtumat latautuvat
    try {
      await page.waitForSelector('article, .event, .gig-item, .event-item, h2.entry-title', {
        timeout: 10000,
      });
    } catch {
      console.log('Selektori ei löytynyt ajoissa — jatketaan silti');
    }

    // Haetaan tapahtumadata suoraan sivun DOM:sta
    rawEvents = await page.evaluate(() => {
      const results = [];

      // ── Strategia 1: article-elementit (WordPress-standardi) ──
      document.querySelectorAll('article').forEach(art => {
        const titleEl = art.querySelector('h1,h2,h3,.entry-title,.event-title,.gig-title,a');
        const name = titleEl?.textContent?.trim();
        if (!name || name.length < 2) return;

        // Päivämäärä: etsitään kaikista teksteistä
        const allText = art.innerText || '';
        const dateMatch = allText.match(/(?:ma|ti|ke|to|pe|la|su)?\s*\d{1,2}\.\d{1,2}\.(?:\d{4})?/i);
        const timeMatch = allText.match(/(?:klo\s*)?(\d{2}:\d{2})/);

        // Paikka: etsitään tyypillisistä elementeistä
        const venueEl = art.querySelector('.venue,.event-venue,.location,.place,.club-name,.event-location');
        const venue = venueEl?.textContent?.trim() || '';

        // Hinta
        const priceEl = art.querySelector('.price,.event-price,.ticket-price');
        const price = priceEl?.textContent?.trim() || '';

        // URL
        const linkEl = art.querySelector('a[href]');
        const url = linkEl?.href || '';

        results.push({
          name,
          venue,
          dateRaw: dateMatch?.[0] || '',
          timeRaw: timeMatch?.[1] || '',
          price,
          url,
        });
      });

      if (results.length > 0) return results;

      // ── Strategia 2: lista-itemit ──
      const listSelectors = [
        '.event-list-item', '.gig-list-item', '.event-row',
        '.event_item', '.concert-item', '.listing-item',
        'li.event', 'li.gig', '.events-list li',
      ];

      for (const sel of listSelectors) {
        document.querySelectorAll(sel).forEach(item => {
          const name = item.querySelector('h2,h3,.title,a')?.textContent?.trim();
          if (!name) return;
          const allText = item.innerText || '';
          const dateMatch = allText.match(/(?:ma|ti|ke|to|pe|la|su)?\s*\d{1,2}\.\d{1,2}\.(?:\d{4})?/i);
          const timeMatch = allText.match(/(\d{2}:\d{2})/);
          results.push({
            name,
            venue: item.querySelector('.venue,.location')?.textContent?.trim() || '',
            dateRaw: dateMatch?.[0] || '',
            timeRaw: timeMatch?.[1] || '',
            price: item.querySelector('.price')?.textContent?.trim() || '',
            url: item.querySelector('a')?.href || '',
          });
        });
        if (results.length > 0) break;
      }

      // ── Strategia 3: kaikki linkit joissa on päivämäärä lähellä ──
      if (results.length === 0) {
        document.querySelectorAll('a[href]').forEach(a => {
          const text = a.textContent?.trim();
          if (!text || text.length < 2) return;
          const parent = a.closest('div,li,tr,section') || a.parentElement;
          const allText = parent?.innerText || a.innerText || '';
          if (!/\d{1,2}\.\d{1,2}\./.test(allText)) return;
          const dateMatch = allText.match(/(?:ma|ti|ke|to|pe|la|su)?\s*\d{1,2}\.\d{1,2}\.(?:\d{4})?/i);
          const timeMatch = allText.match(/(\d{2}:\d{2})/);
          if (dateMatch) {
            results.push({
              name: text,
              venue: '',
              dateRaw: dateMatch[0],
              timeRaw: timeMatch?.[1] || '',
              price: '',
              url: a.href || '',
            });
          }
        });
      }

      return results;
    });

    console.log(`DOM:sta löydettiin ${rawEvents.length} raakatapahtumaa`);

    // Jos ei mitään, tulostetaan sivun teksti debuggausta varten
    if (rawEvents.length === 0) {
      const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 3000));
      console.log('Sivun teksti (debug):\n', bodyText);
    }

  } finally {
    await browser.close();
  }

  // ── Suodatus ja muotoilu ──────────────────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + 42); // 6 viikkoa eteenpäin

  const seen = new Set();
  const events = [];
  let idCounter = 10000;

  for (const r of rawEvents) {
    const dateStr = parseDate(r.dateRaw);
    if (!dateStr) continue;

    const eventDate = new Date(dateStr);
    if (eventDate < today || eventDate > cutoff) continue;

    // Duplikaattisuodatus
    const key = `${r.name}|${dateStr}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const { address, lat, lng, location } = venueInfo(r.venue);

    events.push({
      id: idCounter++,
      name: r.name,
      sub: r.venue || 'Tampere',
      dates: fmtDates(dateStr, r.timeRaw),
      startDate: dateStr,
      endDate: dateStr,
      month: parseInt(dateStr.split('-')[1]),
      cat: 'keikka',
      location: location || r.venue || 'Tampere',
      address,
      lat,
      lng,
      price: r.price || 'Tarkista sivulta',
      url: r.url || METELI_URL,
      desc: `${r.name}${r.venue ? ' @ ' + r.venue : ''}`,
    });
  }

  console.log(`Suodatuksen jälkeen: ${events.length} tapahtumaa (tulevat 6 viikkoa)`);
  return events;
}

// ── index.html päivitys ───────────────────────────────────────────────────

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
    console.log('Ei uusia tapahtumia — index.html pysyy ennallaan.');
    return;
  }

  let html = fs.readFileSync(INDEX_PATH, 'utf8');

  const startMarker = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const endMarker   = '/* ── AUTO-SCRAPED-END ── */';
  const startIdx = html.indexOf(startMarker);
  const endIdx   = html.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1) {
    console.error('AUTO-SCRAPED -merkintöjä ei löydy index.html:stä!');
    process.exit(1);
  }

  const now    = new Date().toISOString().slice(0, 10);
  const before = html.slice(0, startIdx + startMarker.length);
  const after  = html.slice(endIdx);

  const updated = `${before}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa meteli.net:stä */\n${eventsToJs(events)},\n  ${after}`;

  fs.writeFileSync(INDEX_PATH, updated, 'utf8');
  console.log(`✓ index.html päivitetty — ${events.length} tapahtumaa`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
