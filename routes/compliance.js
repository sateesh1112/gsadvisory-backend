const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// ── GET /api/compliance ───────────────────────────────────────────
router.get('/', (req, res) => {
  const { month, year, status, type, client_id } = req.query;
  let query = `
    SELECT cc.*, c.name as client_name, t.title as task_title, u.name as created_by_name
    FROM compliance_calendar cc
    LEFT JOIN clients c ON cc.client_id = c.id
    LEFT JOIN tasks   t ON cc.task_id   = t.id
    LEFT JOIN users   u ON cc.created_by = u.id
    WHERE 1=1
  `;
  const params = [];

  if (month && year) {
    query += ` AND strftime('%m', cc.due_date) = ? AND strftime('%Y', cc.due_date) = ?`;
    params.push(String(month).padStart(2,'0'), String(year));
  }
  if (status)    { query += ' AND cc.status = ?';    params.push(status); }
  if (type)      { query += ' AND cc.type = ?';      params.push(type); }
  if (client_id) { query += ' AND cc.client_id = ?'; params.push(client_id); }

  query += ' ORDER BY cc.due_date ASC';
  const entries = db.prepare(query).all(...params);
  res.json({ success: true, entries });
});

// ── GET /api/compliance/upcoming ─────────────────────────────────
router.get('/upcoming', (req, res) => {
  const days = req.query.days || 30;
  const entries = db.prepare(`
    SELECT cc.*, c.name as client_name
    FROM compliance_calendar cc
    LEFT JOIN clients c ON cc.client_id = c.id
    WHERE cc.due_date BETWEEN date('now') AND date('now', '+' || ? || ' days')
      AND cc.status NOT IN ('filed','completed')
    ORDER BY cc.due_date ASC
  `).all(days);
  res.json({ success: true, entries });
});

// ── GET /api/compliance/overdue ───────────────────────────────────
router.get('/overdue', (req, res) => {
  const entries = db.prepare(`
    SELECT cc.*, c.name as client_name
    FROM compliance_calendar cc
    LEFT JOIN clients c ON cc.client_id = c.id
    WHERE cc.due_date < date('now') AND cc.status NOT IN ('filed','completed')
    ORDER BY cc.due_date ASC
  `).all();
  res.json({ success: true, entries });
});

// ── GET /api/compliance/stats ─────────────────────────────────────
router.get('/stats', (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'upcoming' THEN 1 ELSE 0 END) as upcoming,
      SUM(CASE WHEN status = 'filed' OR status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN due_date < date('now') AND status NOT IN ('filed','completed') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN due_date BETWEEN date('now') AND date('now','+7 days') AND status NOT IN ('filed','completed') THEN 1 ELSE 0 END) as due_this_week,
      SUM(CASE WHEN due_date BETWEEN date('now') AND date('now','+30 days') AND status NOT IN ('filed','completed') THEN 1 ELSE 0 END) as due_this_month
    FROM compliance_calendar
  `).get();
  res.json({ success: true, stats });
});

// ── POST /api/compliance ──────────────────────────────────────────
router.post('/', requireRole('admin', 'employee'), (req, res) => {
  const { title, type, due_date, period, applicable_to, client_id, notes } = req.body;

  if (!title || !type || !due_date) {
    return res.status(400).json({ success: false, message: 'Title, type and due_date are required.' });
  }

  // If applicable_to is 'all' and no specific client, create entries for all active clients
  if (applicable_to === 'all' && !client_id) {
    const clients = db.prepare("SELECT id FROM clients WHERE status = 'active'").all();
    const stmt = db.prepare(`
      INSERT INTO compliance_calendar (title, type, due_date, period, applicable_to, client_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    clients.forEach(c => stmt.run(title, type, due_date, period||null, 'client', c.id, notes||null, req.user.id));
    return res.status(201).json({ success: true, message: `Compliance entry created for ${clients.length} clients.`, count: clients.length });
  }

  const result = db.prepare(`
    INSERT INTO compliance_calendar (title, type, due_date, period, applicable_to, client_id, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, type, due_date, period||null, applicable_to||'all', client_id||null, notes||null, req.user.id);

  res.status(201).json({ success: true, message: 'Compliance entry created.', entryId: result.lastInsertRowid });
});

// ── POST /api/compliance/bulk ─────────────────────────────────────
// Bulk create standard monthly compliance entries
router.post('/bulk', requireRole('admin'), (req, res) => {
  const { month, year } = req.body; // e.g. month: 7, year: 2025

  if (!month || !year) return res.status(400).json({ success: false, message: 'Month and year required.' });

  const m = String(month).padStart(2, '0');
  const y = String(year);

  // Standard compliance schedule
  const schedule = [
    { title: 'GSTR-1 (Monthly)',     type: 'GST',         due_date: `${y}-${m}-07` },
    { title: 'TDS Challan Deposit',  type: 'TDS',         due_date: `${y}-${m}-07` },
    { title: 'GSTR-3B (Monthly)',    type: 'GST',         due_date: `${y}-${m}-15` },
    { title: 'Advance Tax',          type: 'Income Tax',  due_date: `${y}-${m}-15` },
    { title: 'TDS Return (26Q)',     type: 'TDS',         due_date: `${y}-${m}-31` },
    { title: 'ITR Filing',           type: 'Income Tax',  due_date: `${y}-${m}-31` },
    { title: 'Provident Fund (PF)',  type: 'Payroll',     due_date: `${y}-${m}-15` },
    { title: 'ESIC Contribution',    type: 'Payroll',     due_date: `${y}-${m}-15` },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO compliance_calendar (title, type, due_date, period, applicable_to, created_by)
    VALUES (?, ?, ?, ?, 'all', ?)
  `);
  const period = `${y}-${m}`;
  schedule.forEach(s => stmt.run(s.title, s.type, s.due_date, period, req.user.id));

  res.status(201).json({
    success: true,
    message: `${schedule.length} compliance entries created for ${month}/${year}.`,
    entries: schedule
  });
});

// ── PUT /api/compliance/:id ───────────────────────────────────────
router.put('/:id', requireRole('admin', 'employee'), (req, res) => {
  const { status, filed_date, notes, task_id } = req.body;
  db.prepare(`
    UPDATE compliance_calendar SET
      status     = COALESCE(?, status),
      filed_date = COALESCE(?, filed_date),
      notes      = COALESCE(?, notes),
      task_id    = COALESCE(?, task_id)
    WHERE id = ?
  `).run(status, filed_date||null, notes, task_id||null, req.params.id);
  res.json({ success: true, message: 'Compliance entry updated.' });
});

// ── DELETE /api/compliance/:id ────────────────────────────────────
router.delete('/:id', requireRole('admin'), (req, res) => {
  db.prepare('DELETE FROM compliance_calendar WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Entry deleted.' });
});

module.exports = router;
