/**
 * GS Advisory — Feed Fetcher Service
 * Fetches RSS/XML from Income Tax, GST, MCA, ICAI, SEBI portals
 * Parses, deduplicates, AI-classifies and stores in SQLite
 */

const fetch   = require('node-fetch');
const xml2js  = require('xml2js');
const crypto  = require('crypto');
const db      = require('../db/setup');

// ── FEED SOURCES ────────────────────────────────────────────────
const FEEDS = [
  // Income Tax India
  {
    id:       'it-notifications',
    name:     'Income Tax Notifications',
    url:      'https://www.incometaxindia.gov.in/notification-rss-feed/-/asset_publisher/bxhj/rss',
    source:   'Income Tax',
    category: 'Notification',
    tag:      'it-india',
  },
  {
    id:       'it-circulars',
    name:     'Income Tax Circulars',
    url:      'https://www.incometaxindia.gov.in/circular-rss-feed/-/asset_publisher/bxhj/rss',
    source:   'Income Tax',
    category: 'Circular',
    tag:      'it-india',
  },
  {
    id:       'it-press',
    name:     'Income Tax Press Releases',
    url:      'https://www.incometaxindia.gov.in/press-release-rss-feed/-/asset_publisher/bxhj/rss',
    source:   'Income Tax',
    category: 'Press Release',
    tag:      'it-india',
  },
  // GST Council (using CBIC RSS)
  {
    id:       'cbic-circulars',
    name:     'CBIC Circulars & Notifications',
    url:      'https://cbic-gst.gov.in/rss/circularrss.xml',
    source:   'GST / CBIC',
    category: 'Circular',
    tag:      'gst',
  },
  // MCA / Company Law
  {
    id:       'mca-news',
    name:     'MCA Press Releases',
    url:      'https://www.mca.gov.in/MCA21/dca/download/PressRelease_RSS.xml',
    source:   'MCA',
    category: 'Press Release',
    tag:      'mca',
  },
  // SEBI
  {
    id:       'sebi-news',
    name:     'SEBI Circulars',
    url:      'https://www.sebi.gov.in/sebirss.xml',
    source:   'SEBI',
    category: 'Circular',
    tag:      'sebi',
  },
  // ICAI
  {
    id:       'icai-news',
    name:     'ICAI Announcements',
    url:      'https://www.icai.org/rss.html',
    source:   'ICAI',
    category: 'Announcement',
    tag:      'icai',
  },
];

// ── AI CLASSIFICATION ──────────────────────────────────────────
// Uses Claude API if ANTHROPIC_API_KEY is set, else falls back to keyword rules
async function classifyUpdate(title, summary) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  if (ANTHROPIC_KEY) {
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':      'application/json',
          'x-api-key':         ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{
            role:    'user',
            content: `Classify this Indian regulatory update into ONE of these tags: [GST, Income Tax, TDS, ROC/MCA, SEBI, ICAI, Customs/Excise, Labour Law, Banking, UAE Tax, General].
Also assign urgency: [High, Medium, Low].
Also write a 1-sentence plain-English summary (max 20 words).

Title: ${title}
Summary: ${summary || ''}

Respond ONLY as JSON: {"tag":"...", "urgency":"...", "plain_summary":"..."}`
          }]
        })
      });
      const data = await resp.json();
      const text = data.content?.[0]?.text || '{}';
      const clean = text.replace(/```json|```/g,'').trim();
      return JSON.parse(clean);
    } catch(e) {
      console.error('AI classify error:', e.message);
    }
  }

  // ── KEYWORD FALLBACK ─────────────────────────────────────────
  const combined = (title + ' ' + (summary||'')).toLowerCase();
  let tag = 'General', urgency = 'Medium';

  if (/gst|igst|sgst|cgst|gstr|gstin/.test(combined))      tag = 'GST';
  else if (/income tax|itr|tds|tcs|pan|form 16|26as/.test(combined)) tag = 'Income Tax';
  else if (/tds|tcs|tax deduct/.test(combined))             tag = 'TDS';
  else if (/mca|roc|company|llp|incorporation/.test(combined)) tag = 'ROC/MCA';
  else if (/sebi|securities|mutual fund|market/.test(combined)) tag = 'SEBI';
  else if (/icai|chartered accountant|ca exam/.test(combined)) tag = 'ICAI';
  else if (/customs|excise|import|export/.test(combined))   tag = 'Customs/Excise';
  else if (/pf|esic|epfo|labour|wage/.test(combined))       tag = 'Labour Law';
  else if (/rbi|bank|nbfc|credit/.test(combined))           tag = 'Banking';
  else if (/vat|uae|fta|emirates/.test(combined))           tag = 'UAE Tax';

  if (/urgent|immediate|penalty|deadline|last date|due date/.test(combined)) urgency = 'High';
  else if (/amendment|clarification|extension/.test(combined)) urgency = 'Medium';
  else urgency = 'Low';

  return { tag, urgency, plain_summary: '' };
}

// ── RSS PARSER ─────────────────────────────────────────────────
function parseRSS(xmlString) {
  return new Promise((resolve, reject) => {
    xml2js.parseString(xmlString, { explicitArray: false, trim: true }, (err, result) => {
      if (err) return reject(err);
      try {
        const channel = result?.rss?.channel || result?.feed;
        const rawItems = channel?.item || channel?.entry || [];
        const items = Array.isArray(rawItems) ? rawItems : [rawItems];
        resolve(items.map(item => ({
          title:   item.title?._   || item.title   || '',
          link:    item.link?.href || item.link    || item.guid?._ || item.guid || '',
          summary: item.description || item.summary?._ || item.summary || item.content?._ || '',
          pubDate: item.pubDate || item.published || item.updated || new Date().toISOString(),
          guid:    item.guid?._ || item.guid || item.id || item.link || '',
        })));
      } catch(e) { reject(e); }
    });
  });
}

// ── HASH FOR DEDUP ─────────────────────────────────────────────
function hashItem(item) {
  return crypto.createHash('sha256')
    .update((item.guid || item.link || item.title).trim())
    .digest('hex');
}

// ── FETCH ONE FEED ─────────────────────────────────────────────
async function fetchFeed(feedConfig) {
  const { url, source, category, tag: defaultTag, name } = feedConfig;
  let added = 0, skipped = 0, errors = 0;

  try {
    const resp = await fetch(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; GSAdvisoryBot/1.0; +https://gsadvisory.in)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      }
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const xml  = await resp.text();
    const items = await parseRSS(xml);

    for (const item of items) {
      if (!item.title) continue;
      const hash = hashItem(item);

      // Duplicate check
      const exists = db.prepare('SELECT id FROM regulatory_updates WHERE content_hash = ?').get(hash);
      if (exists) { skipped++; continue; }

      // Strip HTML from summary
      const cleanSummary = (item.summary||'').replace(/<[^>]+>/g,'').replace(/&[a-z]+;/gi,'').trim();

      // AI classify
      const classified = await classifyUpdate(item.title, cleanSummary);

      // Parse date
      let pubDate = item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
      if (pubDate === 'Invalid Date') pubDate = new Date().toISOString().split('T')[0];

      db.prepare(`
        INSERT INTO regulatory_updates
          (title, summary, plain_summary, link, source, category, tag, urgency, pub_date, content_hash, feed_name, is_read)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        item.title.trim(),
        cleanSummary.substring(0, 1000),
        classified.plain_summary || '',
        item.link || '',
        source,
        classified.tag || category,
        defaultTag,
        classified.urgency || 'Medium',
        pubDate,
        hash,
        name,
      );
      added++;
    }

    console.log(`✅ [${name}] added=${added} skipped=${skipped}`);
  } catch(e) {
    console.error(`❌ [${name}] ${e.message}`);
    errors++;
  }

  return { added, skipped, errors };
}

// ── FETCH ALL FEEDS ────────────────────────────────────────────
async function fetchAllFeeds() {
  let totalAdded = 0, totalSkipped = 0, totalErrors = 0;

  for (const feed of FEEDS) {
    const result = await fetchFeed(feed);
    totalAdded   += result.added;
    totalSkipped += result.skipped;
    totalErrors  += result.errors;
  }

  // Update last_fetch timestamp
  db.prepare("INSERT OR REPLACE INTO system_settings (key, value) VALUES ('last_feed_fetch', ?)").run(new Date().toISOString());

  return { added: totalAdded, skipped: totalSkipped, errors: totalErrors };
}

module.exports = { fetchAllFeeds, FEEDS };
