require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const bcrypt    = require('bcryptjs');
const { db, initDB } = require('./db/setup');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── TRUST PROXY (required for Render/load balancers) ─────────────
app.set('trust proxy', 1);

// ── SECURITY ──────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'https://gsadvisory.in',
    'https://sateesh1112.github.io',
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  credentials: true
}));

const globalLimiter = rateLimit({ windowMs: 15*60*1000, max: 200, message: { success:false, message:'Too many requests.' } });
const loginLimiter  = rateLimit({ windowMs: 15*60*1000, max: 10,  message: { success:false, message:'Too many login attempts.' } });
app.use('/api/', globalLimiter);
app.use('/api/auth/login', loginLimiter);

// ── BODY PARSER ───────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── STATIC FILES ──────────────────────────────────────────────────
const UPLOADS_DIR = process.env.NODE_ENV === 'production' ? '/data/uploads' : path.join(__dirname, 'uploads');
app.use('/uploads', express.static(UPLOADS_DIR));

// ── INIT DB ───────────────────────────────────────────────────────
initDB();

// ── SEED ADMIN ────────────────────────────────────────────────────
function seedAdmin() {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@gsadvisory.in';
  const existing   = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    const hashed = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'GSAdmin@2025', 12);
    db.prepare("INSERT INTO users (name,email,password,role,designation) VALUES (?,?,?,'admin','Administrator')")
      .run('GS Advisory Admin', adminEmail, hashed);
    console.log('✅ Admin created:', adminEmail);
  }
}
seedAdmin();

// ── ROUTES ────────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/clients',    require('./routes/clients'));
app.use('/api/tasks',      require('./routes/tasks'));
app.use('/api/team',       require('./routes/team'));
app.use('/api/compliance', require('./routes/compliance'));
app.use('/api/invoices',   require('./routes/invoices'));
app.use('/api/documents',  require('./routes/documents'));
app.use('/api/contact',    require('./routes/contact'));
app.use('/api/updates',        require('./routes/updates'));
app.use('/api/careers',        require('./routes/careers'));
app.use('/api/notifications',  require('./routes/notifications'));
app.use('/api/reminders',  require('./routes/reminders'));
app.use('/api/reports',    require('./routes/reports'));

// ── HEALTH ────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ success:true, status:'GS Advisory API running', version:'2.0.0', timestamp: new Date().toISOString() });
});

// ── QUICK STATS ───────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    res.json({ success: true, stats: {
      clients:            db.prepare("SELECT COUNT(*) as c FROM clients WHERE status='active'").get().c,
      tasks:              db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('completed','cancelled')").get().c,
      overdue:            db.prepare("SELECT COUNT(*) as c FROM tasks WHERE due_date<date('now') AND status NOT IN ('completed','cancelled')").get().c,
      invoices:           db.prepare("SELECT COUNT(*) as c FROM invoices WHERE status='pending'").get().c,
      revenue:            db.prepare("SELECT COALESCE(SUM(total),0) as r FROM invoices WHERE status='paid' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get().r,
      inquiries:          db.prepare("SELECT COUNT(*) as c FROM inquiries WHERE status='new'").get().c,
      compliance_overdue: db.prepare("SELECT COUNT(*) as c FROM compliance_calendar WHERE due_date<date('now') AND status NOT IN ('filed','completed')").get().c,
      team:               db.prepare("SELECT COUNT(*) as c FROM users WHERE role IN ('admin','employee') AND is_active=1").get().c
    }});
  } catch(err) {
    res.status(500).json({ success:false, message: err.message });
  }
});

// ── 404 / ERROR ───────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ success:false, message:`${req.method} ${req.path} not found.` }));
app.use((err, req, res, next) => { console.error(err.message); res.status(500).json({ success:false, message: err.message }); });

// ── START SERVER ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 GS Advisory API v2.0 — port ${PORT}`);
  console.log(`📍 Health: http://localhost:${PORT}/api/health\n`);

  // Start automated reminder scheduler
  if (process.env.NODE_ENV === 'production') {
    const { startScheduler } = require('./scheduler');
    startScheduler();
  }
});

module.exports = app;
