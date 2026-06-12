const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// Multer storage config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.jpg', '.jpeg', '.png', '.zip'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) cb(null, true);
  else cb(new Error('File type not allowed.'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ── GET /api/documents ───────────────────────────────────────────
router.get('/', (req, res) => {
  let query = `
    SELECT d.*, c.name as client_name, u.name as uploaded_by_name
    FROM documents d
    LEFT JOIN clients c ON d.client_id = c.id
    LEFT JOIN users   u ON d.uploaded_by = u.id
  `;
  const params = [];

  if (req.user.role === 'client') {
    const client = db.prepare('SELECT id FROM clients WHERE user_id = ?').get(req.user.id);
    if (client) { query += ' WHERE d.client_id = ?'; params.push(client.id); }
    else return res.json({ success: true, documents: [] });
  }

  const { client_id, category } = req.query;
  const whereAdded = query.includes('WHERE');
  if (client_id) { query += (whereAdded ? ' AND' : ' WHERE') + ' d.client_id = ?'; params.push(client_id); }
  if (category)  { query += (params.length ? ' AND' : ' WHERE') + ' d.category = ?'; params.push(category); }

  query += ' ORDER BY d.created_at DESC';
  const documents = db.prepare(query).all(...params);
  res.json({ success: true, documents });
});

// ── POST /api/documents/upload ───────────────────────────────────
router.post('/upload', requireRole('admin', 'employee'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded.' });

  const { client_id, category, description, name } = req.body;

  const result = db.prepare(`
    INSERT INTO documents (client_id, uploaded_by, name, original_name, file_path, file_size, mime_type, category, description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    client_id || null,
    req.user.id,
    name || req.file.originalname,
    req.file.originalname,
    req.file.filename,
    req.file.size,
    req.file.mimetype,
    category || 'general',
    description || null
  );

  res.status(201).json({
    success: true,
    message: 'Document uploaded.',
    documentId: result.lastInsertRowid,
    filename: req.file.originalname
  });
});

// ── GET /api/documents/:id/download ─────────────────────────────
router.get('/:id/download', (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found.' });

  const filePath = path.join(__dirname, '..', 'uploads', doc.file_path);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, message: 'File not found on server.' });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${doc.original_name}"`);
  res.sendFile(filePath);
});

// ── DELETE /api/documents/:id ────────────────────────────────────
router.delete('/:id', requireRole('admin', 'employee'), (req, res) => {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: 'Document not found.' });

  const filePath = path.join(__dirname, '..', 'uploads', doc.file_path);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  db.prepare('DELETE FROM documents WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Document deleted.' });
});

module.exports = router;
