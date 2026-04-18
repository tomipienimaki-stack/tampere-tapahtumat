/**
 * scrape-meteli.js
 * Hakee tulevat keikat meteli.net:stä.
 *
 * Strategia 1: FacetWP API  (WordPress AJAX event-haku)
 * Strategia 2: WP REST API  (/wp-json/wp/v2/...)
 * Strategia 3: Puppeteer    (viimeinen vaihtoehto)
 *
 * Ajo:  node scripts/scrape-meteli.js
 * CI:   GitHub Actions joka maanantai
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const BASE = 'https://www.meteli.net';
const CITY_URL = `${BASE}/kaupunki/tampere`;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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

function isoFmt(iso, time) {
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
      dates: isoFmt(r.dateStr, r.time || ''),
      startDate: r.dateStr, endDate: r.dateStr,
      month: parseInt(r.dateStr.split('-')[1]), cat: 'keikka',
      location: location || r.venue || 'Tampere', address, lat, lng,
      price: r.price || 'Tarkista sivulta',
      url: r.url || CITY_URL,
      desc: `${r.name}${r.venue ? ' @ ' + r.venue : ''}`,
    });
  }
  return events;
}

// ── Strategia 1: FacetWP AJAX API ────────────────────────────────────────
async function tryFacetWP() {
  // Ensin haetaan raw HTML jotta saadaan FWP-asetukset (template-nimi, nonce)
  console.log('Haetaan FWP-asetukset raw HTML:stä...');
  const htmlRes = await fetch(CITY_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html' },
    signal: AbortSignal.timeout(15000),
  });
  if (!htmlRes.ok) throw new Error(`HTML HTTP ${htmlRes.status}`);
  const html = await htmlRes.text();

  // Etsi FWP-asetukset: var FWP_JSON = {...} tai facetwp_vars = {...}
  const fwpMatch = html.match(/var\s+FWP_JSON\s*=\s*(\{[\s\S]*?\})(?:\s*;|\s*<)/);
  const varsMatch = html.match(/var\s+facetwp_vars\s*=\s*(\{[\s\S]*?\})(?:\s*;|\s*<)/);

  let nonce = '', template = '', ajaxUrl = `${BASE}/wp-admin/admin-ajax.php`;

  if (fwpMatch) {
    try {
      const fwp = JSON.parse(fwpMatch[1]);
      nonce    = fwp.nonce || fwp.settings?.nonce || '';
      template = fwp.template || fwp.settings?.template || '';
      ajaxUrl  = fwp.ajax_url || ajaxUrl;
      console.log('FWP_JSON löydettiin:', { nonce: nonce.slice(0,8)+'…', template, ajaxUrl });
    } catch { console.log('FWP_JSON parse-virhe'); }
  } else if (varsMatch) {
    try {
      const vars = JSON.parse(varsMatch[1]);
      nonce    = vars.nonce || '';
      ajaxUrl  = vars.ajax_url || ajaxUrl;
      console.log('facetwp_vars löydettiin:', { nonce: nonce.slice(0,8)+'…', ajaxUrl });
    } catch {}
  } else {
    // Etsi nonce muualta
    const nonceM = html.match(/"nonce"\s*:\s*"([a-f0-9]{10})"/);
    nonce = nonceM?.[1] || '';
    console.log('Ei FWP JSON:ia — nonce:', nonce || '(ei löydy)');
  }

  // Etsi template-nimi
  if (!template) {
    const tmplM = html.match(/["']template["']\s*:\s*["']([^"']+)["']/);
    template = tmplM?.[1] || 'default';
  }

  // Tulosta FacetWP-skriptien URLit debuggausta varten
  const fwpScripts = [...html.matchAll(/src=["']([^"']*facetwp[^"']*)["']/gi)].map(m => m[1]);
  console.log('FacetWP-skriptit:', fwpScripts.join(', ') || '(ei löydy)');

  // Kokeile FacetWP-pyyntöä useilla template-nimillä
  const templates = [template, 'default', 'city', 'tampere', 'events', 'gigs', 'listings'].filter(Boolean);
  const uniqueTemplates = [...new Set(templates)];

  for (const tmpl of uniqueTemplates) {
    const payload = new URLSearchParams({
      action: 'facetwp_refresh',
      data: JSON.stringify({
        facets: {},
        template: tmpl,
        query: {},
        http_params: {
          uri: 'kaupunki/tampere',
          url_vars: {},
          get_vars: {},
        },
        soft_refresh: 1,
        is_bfcache: 0,
        first_load: 1,
        extras: { uri: 'kaupunki/tampere' },
      }),
      ...(nonce ? { nonce } : {}),
    });

    try {
      const apiRes = await fetch(ajaxUrl, {
        method: 'POST',
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': CITY_URL,
          'Origin': BASE,
        },
        body: payload.toString(),
        signal: AbortSignal.timeout(15000),
      });

      if (!apiRes.ok) { console.log(`FWP template="${tmpl}" → HTTP ${apiRes.status}`); continue; }
      const txt = await apiRes.text();
      console.log(`FWP template="${tmpl}" → ${txt.slice(0, 200)}`);

      try {
        const json = JSON.parse(txt);
        const htmlContent = json.template || json.results || json.html || '';
        if (htmlContent && htmlContent.includes('article')) {
          console.log('FacetWP palautti HTML:iä — parsitaan...');
          return parseHtmlArticles(htmlContent);
        }
      } catch { console.log('  Ei JSON-vastausta'); }
    } catch (e) { console.log(`FWP template="${tmpl}" virhe:`, e.message); }
  }
  return [];
}

function parseHtmlArticles(html) {
  const SKIP = /^(löydä liput|osta liput|buy tickets)$/i;
  const DAY  = /^(MA|TI|KE|TO|PE|LA|SU)$/i;
  const DATE = /^\d{1,2}\.\d{1,2}\.?$/;
  const year = new Date().getFullYear();

  // Yksinkertainen regex-pohjainen article-parsinta
  const articles = [...html.matchAll(/<article[^>]*>([\s\S]*?)<\/article>/gi)].map(m => m[1]);
  console.log(`parseHtmlArticles: ${articles.length} artikkelia`);

  return articles.flatMap(art => {
    // Poista HTML-tagit, jätä teksti
    const text = art.replace(/<[^>]+>/g, '\n').replace(/&[a-z]+;/gi, ' ');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l && !SKIP.test(l));
    const dateIdx = lines.findIndex(l => DATE.test(l));
    if (dateIdx === -1) return [];
    const dayIdx = lines.findIndex(l => DAY.test(l));
    const after = Math.max(dayIdx, dateIdx) + 1;
    const name = lines[after];
    if (!name || name.length < 2) return [];
    const m = lines[dateIdx].match(/(\d{1,2})\.(\d{1,2})\./);
    if (!m) return [];
    const dateStr = `${year}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    const vp = lines[after + 1] || '';
    let venue = '', price = '';
    if (vp.includes(' - alk. ')) {
      const p = vp.split(' - alk. ');
      venue = p[0].split(',')[0].trim();
      price = 'alk. ' + p[1].trim();
    } else { venue = vp.split(',')[0].trim(); }
    const urlM = art.match(/href=["']([^"']+)["']/);
    return [{ name, venue, dateStr, price, url: urlM?.[1] || '' }];
  });
}

// ── Strategia 2: WP REST — kaikki post-tyypit ─────────────────────────────
async function tryWpApi() {
  console.log('\nWP REST API...');
  // Hae lista kaikista post-tyypeistä
  const typesRes = await fetch(`${BASE}/wp-json/wp/v2/types`, {
    headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
  });
  if (typesRes.ok) {
    const types = await typesRes.json();
    console.log('Post-tyypit:', Object.keys(types).join(', '));
    // Kokeile kutakin tyyppiä
    for (const [type, info] of Object.entries(types)) {
      if (['wp_block','wp_navigation','wp_template','wp_template_part','wp_global_styles','wp_font_family','wp_font_face'].includes(type)) continue;
      const endpoint = info.rest_base || type;
      try {
        const r = await fetch(`${BASE}/wp-json/wp/v2/${endpoint}?per_page=100`, {
          headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) continue;
        const items = await r.json();
        if (!Array.isArray(items) || items.length === 0) continue;
        const tampere = items.filter(i => JSON.stringify(i).toLowerCase().includes('tampere'));
        console.log(`wp/v2/${endpoint}: ${items.length} kpl (${tampere.length} Tampere)`);
        if (tampere.length > 0) {
          return tampere.map(item => ({
            name: (item.title?.rendered || '').replace(/<[^>]+>/g, '').trim(),
            dateStr: (item.date || '').slice(0, 10),
            venue: '',
            price: '',
            url: item.link || '',
          })).filter(i => i.name);
        }
      } catch { continue; }
    }
  }
  return [];
}

// ── Strategia 3: Puppeteer ────────────────────────────────────────────────
async function tryPuppeteer() {
  console.log('\nPuppeteer (bundled Chromium)...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  let results = [];
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    // Intercept network: log kaikki API-kutsut
    const apiLog = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url(), rt = req.resourceType();
      if (rt === 'xhr' || rt === 'fetch') apiLog.push(url);
      req.continue();
    });
    page.on('response', async res => {
      const url = res.url();
      if ((url.includes('admin-ajax') || url.includes('facetwp') || url.includes('wp-json')) && res.headers()['content-type']?.includes('json')) {
        try {
          const txt = await res.text();
          console.log(`[XHR] ${url.slice(0,80)} → ${txt.slice(0,200)}`);
        } catch {}
      }
    });

    await page.goto(CITY_URL, { waitUntil: 'networkidle2', timeout: 40000 });
    console.log('XHR-kutsut:', apiLog.slice(0,10).join('\n'));

    const artCount = await page.evaluate(() => document.querySelectorAll('article').length);
    console.log('article-elementtejä:', artCount);
    if (artCount === 0) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 400));
      console.log('Body:', bodyText);
      return [];
    }

    const SKIP = /^(löydä liput|osta liput|buy tickets)$/i;
    const DAY  = /^(MA|TI|KE|TO|PE|LA|SU)$/i;
    const DATE = /^\d{1,2}\.\d{1,2}\.?$/;
    const year = new Date().getFullYear();

    results = await page.evaluate((s,dy,dt,yr) => {
      const SKIP=new RegExp(s,'i'),DAY=new RegExp(dy,'i'),DATE=new RegExp(dt);
      return Array.from(document.querySelectorAll('article')).flatMap(art=>{
        const lines=(art.innerText||'').split('\n').map(l=>l.trim()).filter(l=>l&&!SKIP.test(l));
        const di=lines.findIndex(l=>DATE.test(l)); if(di===-1)return[];
        const dyi=lines.findIndex(l=>DAY.test(l));
        const af=Math.max(dyi,di)+1;
        const name=lines[af]; if(!name||name.length<2)return[];
        const m=lines[di].match(/(\d{1,2})\.(\d{1,2})\./); if(!m)return[];
        const dateStr=`${yr}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
        const vp=lines[af+1]||'';
        let venue='',price='';
        if(vp.includes(' - alk. ')){const p=vp.split(' - alk. ');venue=p[0].split(',')[0].trim();price='alk. '+p[1].trim();}
        else{venue=vp.split(',')[0].trim();}
        return [{name,venue,dateStr,price,url:art.querySelector('a[href]')?.href||''}];
      });
    }, SKIP.source,DAY.source,DATE.source,year);

    console.log('Puppeteer:', results.length, 'tapahtumaa');
  } finally { await browser.close(); }
  return results;
}

// ── Kirjoita index.html ───────────────────────────────────────────────────
function eventsToJs(events) {
  return events.map(e=>{
    const f=[
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
  let raw = [], source = '';

  // 1. FacetWP
  try { raw = await tryFacetWP(); source = 'facetwp'; } catch(e){ console.log('FacetWP virhe:',e.message); }

  // 2. WP REST
  if (raw.length < 3) {
    try { const r = await tryWpApi(); if(r.length>raw.length){raw=r;source='wp-api';} } catch(e){console.log('WP API virhe:',e.message);}
  }

  // 3. Puppeteer
  if (raw.length < 3) {
    try { const r = await tryPuppeteer(); if(r.length>raw.length){raw=r;source='puppeteer';} } catch(e){console.log('Puppeteer virhe:',e.message);}
  }

  const events = filterEvents(raw);
  console.log(`\n→ Lähde: ${source||'ei mitään'}, ${events.length} tulevaa tapahtumaa`);

  if (events.length === 0) { console.log('Ei tapahtumia — index.html ennallaan.'); return; }

  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const S = '/* ── AUTO-SCRAPED-START – älä muokkaa tätä osiota käsin ── */';
  const E = '/* ── AUTO-SCRAPED-END ── */';
  const si=html.indexOf(S), ei=html.indexOf(E);
  if(si===-1||ei===-1){console.error('Merkinnät puuttuu!');process.exit(1);}
  const now=new Date().toISOString().slice(0,10);
  const out=`${html.slice(0,si+S.length)}\n  /* Päivitetty: ${now} — ${events.length} tapahtumaa (${source}) */\n${eventsToJs(events)},\n  ${html.slice(ei)}`;
  fs.writeFileSync(INDEX_PATH,out);
  console.log('✓ index.html päivitetty');
}

main().catch(e=>{console.error(e);process.exit(1);});
