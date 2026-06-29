/**
 * GS Advisory — Updates / Regulatory Feed Route
 * GET  /api/updates          — list updates (with filters)
 * GET  /api/updates/stats    — counts by category
 * POST /api/updates/fetch    — admin: manually trigger RSS fetch
 * PUT  /api/updates/:id/read — mark as read
 */

const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { fetchAllFeeds } = require('../services/feedFetcher');

router.use(authMiddleware);

// ── GET /api/updates ─────────────────────────────────────────────
router.get('/', (req, res) => {
  const { category, source, search, limit = 50, offset = 0 } = req.query;

  let where = ['1=1'];
  let params = [];

  if (category && category !== 'all') {
    where.push('category = ?');
    params.push(category);
  }
  if (source && source !== 'all') {
    where.push('source = ?');
    params.push(source);
  }
  if (search) {
    where.push('(title LIKE ? OR summary LIKE ?)');
    params.push('%'+search+'%', '%'+search+'%');
  }

  const total  = db.prepare(`SELECT COUNT(*) as c FROM regulatory_updates WHERE ${where.join(' AND ')}`).get(...params).c;
  const items  = db.prepare(`
    SELECT * FROM regulatory_updates
    WHERE ${where.join(' AND ')}
    ORDER BY pub_date DESC
    LIMIT ? OFFSET ?
  `).all(...params, parseInt(limit), parseInt(offset));

  res.json({ success: true, total, items });
});

// ── GET /api/updates/stats ───────────────────────────────────────
router.get('/stats', (req, res) => {
  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count
    FROM regulatory_updates
    WHERE pub_date >= date('now','-30 days')
    GROUP BY category
  `).all();

  const bySource = db.prepare(`
    SELECT source, COUNT(*) as count
    FROM regulatory_updates
    WHERE pub_date >= date('now','-30 days')
    GROUP BY source
  `).all();

  const total   = db.prepare("SELECT COUNT(*) as c FROM regulatory_updates").get().c;
  const thisWeek= db.prepare("SELECT COUNT(*) as c FROM regulatory_updates WHERE pub_date >= date('now','-7 days')").get().c;
  const today   = db.prepare("SELECT COUNT(*) as c FROM regulatory_updates WHERE pub_date >= date('now')").get().c;

  res.json({ success: true, byCategory, bySource, total, thisWeek, today });
});

// ── POST /api/updates/fetch (admin only) ─────────────────────────
router.post('/fetch', requireRole('admin'), async (req, res) => {
  try {
    const result = await fetchAllFeeds();
    res.json({ success: true, message: `Fetched ${result.added} new updates, ${result.skipped} duplicates skipped.`, ...result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/updates/:id/read ────────────────────────────────────
router.put('/:id/read', (req, res) => {
  db.prepare('UPDATE regulatory_updates SET is_read = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});


// ── POST /api/updates/push (admin only) ─────────────────────────
// Manually push a custom regulatory update into the feed
router.post('/push', requireRole('admin'), (req, res) => {
  const { title, summary, link, source, category, urgency, pub_date } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'Title required.' });

  const crypto = require('crypto');
  const hash   = crypto.createHash('sha256')
    .update((title + (pub_date || '') + (source || '')).trim())
    .digest('hex');

  // Check duplicate
  const exists = db.prepare('SELECT id FROM regulatory_updates WHERE content_hash = ?').get(hash);
  if (exists) return res.json({ success: true, message: 'Already exists.', id: exists.id });

  const r = db.prepare(`
    INSERT INTO regulatory_updates
      (title, summary, plain_summary, link, source, category, tag, urgency, pub_date, content_hash, feed_name, is_read)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    title,
    summary || null,
    summary ? summary.substring(0, 100) : null,
    link || null,
    source || 'GS Advisory',
    category || 'Announcement',
    'admin-push',
    urgency || 'Medium',
    pub_date || new Date().toISOString().split('T')[0],
    hash,
    'Admin Push'
  );

  res.json({ success: true, message: 'Update pushed to feed.', id: r.lastInsertRowid });
});

module.exports = router;
