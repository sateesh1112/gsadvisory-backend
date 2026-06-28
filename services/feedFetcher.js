/**
 * GS Advisory — Feed Fetcher Service
 * Fetches RSS/XML feeds with multiple fallback strategies:
 * 1. Direct fetch (works for open feeds)
 * 2. RSS2JSON API proxy (bypasses 403 blocks)
 * 3. AllOrigins proxy
 */

const fetch   = require('node-fetch');
const xml2js  = require('xml2js');
const crypto  = require('crypto');
const { db }  = require('../db/setup');

// ── RSS2JSON proxy (free, no key needed, bypasses govt blocks) ────
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';
const ALLORIGINS = 'https://api.allorigins.win/raw?url=';

// ── FEED SOURCES ─────────────────────────────────────────────────
const FEEDS = [
  {
    id: 'it-notifications',
    name: 'Income Tax Notifications',
    url: 'https://www.incometaxindia.gov.in/notification-rss-feed/-/asset_publisher/bxhj/rss',
    source: 'Income Tax',
    category: 'Notification',
  },
  {
    id: 'it-circulars',
    name: 'Income Tax Circulars',
    url: 'https://www.incometaxindia.gov.in/circular-rss-feed/-/asset_publisher/bxhj/rss',
    source: 'Income Tax',
    category: 'Circular',
  },
  {
    id: 'it-press',
    name: 'Income Tax Press Releases',
    url: 'https://www.incometaxindia.gov.in/press-release-rss-feed/-/asset_publisher/bxhj/rss',
    source: 'Income Tax',
    category: 'Press Release',
  },
  {
    id: 'cbic-gst',
    name: 'CBIC GST Notifications',
    url: 'https://cbic-gst.gov.in/rss/circularrss.xml',
    source: 'GST / CBIC',
    category: 'Circular',
  },
  {
    id: 'sebi-circulars',
    name: 'SEBI Circulars',
    url: 'https://www.sebi.gov.in/sebirss.xml',
    source: 'SEBI',
    category: 'Circular',
  },
  {
    id: 'mca-news',
    name: 'MCA Press Releases',
    url: 'https://www.mca.gov.in/MCA21/dca/download/PressRelease_RSS.xml',
    source: 'MCA',
    category: 'Press Release',
  },
  {
    id: 'icai-news',
    name: 'ICAI Announcements',
    url: 'https://resource.cdn.icai.org/rss/news.xml',
    source: 'ICAI',
    category: 'Announcement',
  },
  // Additional open feeds that work without proxy
  {
    id: 'pib-finance',
    name: 'PIB Finance Ministry',
    url: 'https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3',
    source: 'PIB',
    category: 'Press Release',
  },
];

// ── AI CLASSIFICATION (Claude Haiku) ─────────────────────────────
async function classifyUpdate(title, summary) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 120,
          messages: [{
            role: 'user',
            content: `Classify this Indian regulatory update. Respond ONLY as JSON with no preamble:
{"tag":"<ONE OF: GST|Income Tax|TDS|ROC/MCA|SEBI|ICAI|Customs|Labour Law|Banking|UAE Tax|General>","urgency":"<High|Medium|Low>","plain_summary":"<max 15 words plain English>"}

Title: ${title.substring(0, 200)}
Summary: ${(summary||'').substring(0, 300)}`
          }]
        })
      });
      const data = await resp.json();
      const text = (data.content?.[0]?.text || '{}').replace(/```json|```/g,'').trim();
      return JSON.parse(text);
    } catch(e) {
      // fall through to keyword
    }
  }

  // Keyword fallback
  const t = (title + ' ' + (summary||'')).toLowerCase();
  let tag = 'General', urgency = 'Medium';
  if (/gst|igst|sgst|cgst|gstr|gstin/.test(t))               tag = 'GST';
  else if (/income.?tax|itr|cbdt|form.?16|26as|ais/.test(t)) tag = 'Income Tax';
  else if (/\btds\b|\btcs\b|tax deduct/.test(t))              tag = 'TDS';
  else if (/mca|roc|\bcompan|llp|incorpo/.test(t))            tag = 'ROC/MCA';
  else if (/sebi|securit|mutual fund/.test(t))                tag = 'SEBI';
  else if (/icai|chartered account/.test(t))                  tag = 'ICAI';
  else if (/custom|excise|import|export|dgft/.test(t))        tag = 'Customs';
  else if (/pf|esic|epfo|labour|wage|gratuity/.test(t))       tag = 'Labour Law';
  else if (/rbi|bank|nbfc|credit/.test(t))                    tag = 'Banking';
  else if (/vat|uae|fta|emirates/.test(t))                    tag = 'UAE Tax';

  if (/urgent|penalty|last.?date|due.?date|deadline|extended|extension/.test(t)) urgency = 'High';
  else if (/amendment|clarif|circular|notif/.test(t))         urgency = 'Medium';
  else                                                         urgency = 'Low';

  return { tag, urgency, plain_summary: '' };
}

// ── FETCH ONE FEED — with proxy fallback ─────────────────────────
async function fetchRaw(url) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
  };

  // Strategy 1: Direct
  try {
    const r = await fetch(url, { headers, timeout: 12000 });
    if (r.ok) {
      const text = await r.text();
      if (text.includes('<rss') || text.includes('<feed') || text.includes('<?xml')) return { text, via: 'direct' };
    }
  } catch(e) {}

  // Strategy 2: RSS2JSON API (free tier, no key, great for govt sites)
  try {
    const r = await fetch(RSS2JSON + encodeURIComponent(url), { timeout: 15000 });
    if (r.ok) {
      const j = await r.json();
      if (j.status === 'ok' && j.items?.length) return { json: j, via: 'rss2json' };
    }
  } catch(e) {}

  // Strategy 3: AllOrigins proxy
  try {
    const r = await fetch(ALLORIGINS + encodeURIComponent(url), { timeout: 15000 });
    if (r.ok) {
      const text = await r.text();
      if (text.includes('<rss') || text.includes('<feed')) return { text, via: 'allorigins' };
    }
  } catch(e) {}

  throw new Error('All fetch strategies failed');
}

// ── PARSE RSS XML ─────────────────────────────────────────────────
function parseRSS(xmlString) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlString, { explicitArray: false, trim: true }, (err, result) => {
      if (err) return reject(err);
      try {
        const ch = result?.rss?.channel || result?.feed;
        const raw = ch?.item || ch?.entry || [];
        const items = Array.isArray(raw) ? raw : [raw];
        resolve(items.filter(Boolean).map(i => ({
          title:   strip(i.title?._ || i.title || ''),
          link:    i.link?.href || i.link || i.guid?._ || i.guid || '',
          summary: strip(i.description || i.summary?._ || i.summary || i.content?._ || ''),
          pubDate: i.pubDate || i.published || i.updated || new Date().toISOString(),
          guid:    i.guid?._ || i.guid || i.id || i.link || i.title || '',
        })));
      } catch(e) { reject(e); }
    });
  });
}

// ── PARSE RSS2JSON RESPONSE ───────────────────────────────────────
function parseRSS2JSON(json) {
  return (json.items || []).map(i => ({
    title:   strip(i.title || ''),
    link:    i.link || i.guid || '',
    summary: strip(i.description || i.content || ''),
    pubDate: i.pubDate || new Date().toISOString(),
    guid:    i.guid || i.link || i.title || '',
  }));
}

function strip(html) {
  return (html||'').replace(/<[^>]+>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ').trim();
}

function hash(item) {
  return crypto.createHash('sha256').update((item.guid||item.link||item.title||'').trim()).digest('hex');
}

function parseDate(str) {
  try {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
  } catch(e) {}
  return new Date().toISOString().split('T')[0];
}

// ── FETCH + PROCESS ONE FEED ──────────────────────────────────────
async function fetchFeed(feed) {
  let added = 0, skipped = 0;

  try {
    const raw = await fetchRaw(feed.url);
    let items = [];

    if (raw.json) {
      items = parseRSS2JSON(raw.json);
    } else {
      items = await parseRSS(raw.text);
    }

    console.log(`📰 [${feed.name}] via ${raw.via}: ${items.length} items`);

    for (const item of items) {
      if (!item.title) continue;
      const h = hash(item);
      const exists = db.prepare('SELECT id FROM regulatory_updates WHERE content_hash = ?').get(h);
      if (exists) { skipped++; continue; }

      const classified = await classifyUpdate(item.title, item.summary);

      db.prepare(`
        INSERT INTO regulatory_updates
          (title, summary, plain_summary, link, source, category, tag, urgency, pub_date, content_hash, feed_name, is_read)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        item.title.substring(0, 500),
        (item.summary||'').substring(0, 1000),
        classified.plain_summary || '',
        item.link || '',
        feed.source,
        classified.tag || feed.category,
        feed.id,
        classified.urgency || 'Medium',
        parseDate(item.pubDate),
        h,
        feed.name,
      );
      added++;
    }

    console.log(`✅ [${feed.name}] added=${added} skipped=${skipped}`);
  } catch(e) {
    console.error(`❌ [${feed.name}] ${e.message}`);
  }

  return { added, skipped };
}

// ── FETCH ALL FEEDS ───────────────────────────────────────────────
async function fetchAllFeeds() {
  let totalAdded = 0, totalSkipped = 0;

  for (const feed of FEEDS) {
    const r = await fetchFeed(feed);
    totalAdded   += r.added;
    totalSkipped += r.skipped;
  }

  try {
    db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('last_feed_fetch', ?)").run(new Date().toISOString());
  } catch(e) {}

  return { added: totalAdded, skipped: totalSkipped };
}

module.exports = { fetchAllFeeds, FEEDS };
