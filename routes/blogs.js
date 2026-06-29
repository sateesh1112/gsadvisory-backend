/**
 * GS Advisory — Blogs Route
 * GET  /api/blogs              — public: list published blogs
 * GET  /api/blogs/:id          — public: get single blog
 * POST /api/blogs              — admin/employee: create blog
 * PUT  /api/blogs/:id          — admin/employee (own): update
 * DELETE /api/blogs/:id        — admin: delete
 */
const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

function ensureTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS blogs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    slug        TEXT UNIQUE,
    excerpt     TEXT,
    content     TEXT NOT NULL,
    cover_image TEXT,
    category    TEXT DEFAULT 'General',
    tags        TEXT,
    author_id   INTEGER,
    author_name TEXT,
    status      TEXT DEFAULT 'draft',
    views       INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime(\'now\')),
    updated_at  TEXT DEFAULT (datetime(\'now\')),
    published_at TEXT
  )`);
}

function makeSlug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').substring(0,80) + '-' + Date.now();
}

// ── GET / (public) ────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    ensureTable();
    const { category, limit = 20, offset = 0, status = 'published' } = req.query;
    let where = ["status = ?"];
    let params = [status];
    if (category && category !== 'all') { where.push('category = ?'); params.push(category); }
    const total = db.prepare(`SELECT COUNT(*) as c FROM blogs WHERE ${where.join(' AND ')}`).get(...params).c;
    const blogs = db.prepare(`SELECT id,title,slug,excerpt,category,tags,author_name,status,views,created_at,published_at FROM blogs WHERE ${where.join(' AND ')} ORDER BY published_at DESC LIMIT ? OFFSET ?`).all(...params, parseInt(limit), parseInt(offset));
    res.json({ success: true, total, blogs });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /:id (public) ─────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    ensureTable();
    const blog = db.prepare('SELECT * FROM blogs WHERE id = ? OR slug = ?').get(req.params.id, req.params.id);
    if (!blog) return res.status(404).json({ success: false, message: 'Blog not found.' });
    // Increment views
    db.prepare('UPDATE blogs SET views = views + 1 WHERE id = ?').run(blog.id);
    res.json({ success: true, blog });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// Auth required below
router.use(authMiddleware);

// ── POST / ────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const { title, excerpt, content, category, tags, status, cover_image } = req.body;
  if (!title || !content) return res.status(400).json({ success: false, message: 'Title and content required.' });
  try {
    ensureTable();
    const slug = makeSlug(title);
    const pub  = status === 'published' ? new Date().toISOString() : null;
    const r = db.prepare(`INSERT INTO blogs (title,slug,excerpt,content,cover_image,category,tags,author_id,author_name,status,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(title, slug, excerpt||null, content, cover_image||null, category||'General', tags||null, req.user.id, req.user.name, status||'draft', pub);
    res.json({ success: true, message: 'Blog saved.', id: r.lastInsertRowid, slug });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PUT /:id ──────────────────────────────────────────────────────
router.put('/:id', (req, res) => {
  const { title, excerpt, content, category, tags, status, cover_image } = req.body;
  try {
    ensureTable();
    const existing = db.prepare('SELECT * FROM blogs WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ success: false, message: 'Not found.' });
    if (existing.author_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ success: false, message: 'Not your blog.' });
    const pub = status === 'published' && !existing.published_at ? new Date().toISOString() : existing.published_at;
    db.prepare(`UPDATE blogs SET title=COALESCE(?,title),excerpt=COALESCE(?,excerpt),content=COALESCE(?,content),cover_image=COALESCE(?,cover_image),category=COALESCE(?,category),tags=COALESCE(?,tags),status=COALESCE(?,status),published_at=?,updated_at=datetime(\'now\') WHERE id=?`)
      .run(title,excerpt,content,cover_image,category,tags,status,pub,req.params.id);
    res.json({ success: true, message: 'Blog updated.' });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── DELETE /:id ───────────────────────────────────────────────────
router.delete('/:id', requireRole('admin'), (req, res) => {
  ensureTable();
  db.prepare('DELETE FROM blogs WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Blog deleted.' });
});

module.exports = router;
