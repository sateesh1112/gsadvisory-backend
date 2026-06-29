/**
 * GS Advisory — Careers Route
 * GET  /api/careers          — public: list active jobs
 * POST /api/careers          — admin: create job posting
 * PUT  /api/careers/:id      — admin: edit job
 * DELETE /api/careers/:id    — admin: remove job
 */
const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

// Public — no auth needed
router.get('/', (req, res) => {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS job_postings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, department TEXT, location TEXT,
      type TEXT DEFAULT 'Full Time', description TEXT,
      requirements TEXT, is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    const jobs = db.prepare("SELECT * FROM job_postings WHERE is_active=1 ORDER BY created_at DESC").all();
    res.json({ success: true, jobs });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Admin only below
router.use(authMiddleware);

router.post('/', requireRole('admin'), (req, res) => {
  const { title, department, location, type, description, requirements } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'Title required.' });
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS job_postings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL, department TEXT, location TEXT,
      type TEXT DEFAULT 'Full Time', description TEXT,
      requirements TEXT, is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`);
    const r = db.prepare(`INSERT INTO job_postings (title,department,location,type,description,requirements) VALUES (?,?,?,?,?,?)`)
      .run(title, department||null, location||null, type||'Full Time', description||null, requirements||null);
    res.json({ success: true, message: 'Job posted.', id: r.lastInsertRowid });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/:id', requireRole('admin'), (req, res) => {
  const { title, department, location, type, description, requirements, is_active } = req.body;
  db.prepare(`UPDATE job_postings SET title=COALESCE(?,title), department=COALESCE(?,department),
    location=COALESCE(?,location), type=COALESCE(?,type), description=COALESCE(?,description),
    requirements=COALESCE(?,requirements), is_active=COALESCE(?,is_active),
    updated_at=datetime('now') WHERE id=?`)
    .run(title,department,location,type,description,requirements,is_active,req.params.id);
  res.json({ success: true, message: 'Job updated.' });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  db.prepare("UPDATE job_postings SET is_active=0 WHERE id=?").run(req.params.id);
  res.json({ success: true, message: 'Job removed.' });
});

module.exports = router;
