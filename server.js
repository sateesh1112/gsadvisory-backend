require('dotenv').config();
// Security
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const bcrypt     = require('bcryptjs');
const { db, initDB } = require('./db/setup');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────────────────
// Security headers
app.use(helmet());

// Global rate limit: 100 requests per 15 min per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please slow down.' }
});
app.use('/api/', globalLimiter);

// Stricter limit on login: 10 attempts per 15 min
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { success: false, message: 'Too many login attempts. Try again later.' }
});
app.use('/api/auth/login', loginLimiter);
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://gsadvisory.in',
    'https://sateesh1112.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve uploaded files
const UPLOADS_DIR = process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));

// ── INIT DATABASE ─────────────────────────────────────────────────
initDB();

// ── SEED ADMIN ON FIRST RUN ───────────────────────────────────────
function seedAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(process.env.ADMIN_EMAIL || 'admin@gsadvisory.in');
  if (!existing) {
    const hashed = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'GSAdmin@2025', 12);
    db.prepare(`
      INSERT INTO users (name, email, password, role, designation)
      VALUES (?, ?, ?, 'admin', 'Administrator')
    `).run('GS Advisory Admin', process.env.ADMIN_EMAIL || 'admin@gsadvisory.in', hashed);
    console.log('✅ Admin account created:', process.env.ADMIN_EMAIL || 'admin@gsadvisory.in');
  }
}
seedAdmin();

// ── ROUTES ────────────────────────────────────────────────────────
app.use('/api/auth',      require('./routes/auth'));
app.use('/api/clients',   require('./routes/clients'));
app.use('/api/tasks',     require('./routes/tasks'));
app.use('/api/invoices',  require('./routes/invoices'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/contact',   require('./routes/contact'));

// ── HEALTH CHECK ──────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'GS Advisory API is running',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// ── DASHBOARD STATS (admin) ───────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      clients:    db.prepare("SELECT COUNT(*) as c FROM clients WHERE status = 'active'").get().c,
      tasks:      db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('completed','cancelled')").get().c,
      overdue:    db.prepare("SELECT COUNT(*) as c FROM tasks WHERE due_date < date('now') AND status NOT IN ('completed','cancelled')").get().c,
      invoices:   db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status = 'pending'").get().c,
      revenue:    db.prepare("SELECT COALESCE(SUM(total),0) as r FROM invoices WHERE status = 'paid' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')").get().r,
      inquiries:  db.prepare("SELECT COUNT(*) as c FROM inquiries WHERE status = 'new'").get().c,
    };
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── 404 HANDLER ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found.` });
});

// ── ERROR HANDLER ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({ success: false, message: err.message || 'Internal server error.' });
});

// ── START ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GS Advisory API running on port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health`);
  console.log(`🌍 ENV: ${process.env.NODE_ENV || 'development'}\n`);
});

module.exports = app;
