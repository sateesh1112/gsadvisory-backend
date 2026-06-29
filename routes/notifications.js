/**
 * GS Advisory — Admin Push Notifications
 * GET  /api/notifications     — public: get active notifications
 * POST /api/notifications     — admin: push new notification
 * DELETE /api/notifications/:id — admin: remove
 */
const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, body TEXT, link TEXT, category TEXT DEFAULT 'Announcement',
    urgency TEXT DEFAULT 'Medium', is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
}

// Public
router.get('/', (req, res) => {
  try {
    ensureTable();
    const items = db.prepare("SELECT * FROM admin_notifications WHERE is_active=1 ORDER BY created_at DESC LIMIT 20").all();
    res.json({ success: true, items });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.use(authMiddleware);

router.post('/', requireRole('admin'), (req, res) => {
  const { title, body, link, category, urgency } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'Title required.' });
  try {
    ensureTable();
    const r = db.prepare(`INSERT INTO admin_notifications (title,body,link,category,urgency) VALUES (?,?,?,?,?)`)
      .run(title, body||null, link||null, category||'Announcement', urgency||'Medium');
    res.json({ success: true, message: 'Notification pushed.', id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  ensureTable();
  db.prepare("UPDATE admin_notifications SET is_active=0 WHERE id=?").run(req.params.id);
  res.json({ success: true, message: 'Notification removed.' });
});

module.exports = router;
