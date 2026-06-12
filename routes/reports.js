const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware, requireRole('admin', 'employee'));

// ── GET /api/reports/dashboard ────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const clients   = db.prepare("SELECT COUNT(*) as c FROM clients WHERE status='active'").get().c;
  const tasks     = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status NOT IN ('completed','cancelled')").get().c;
  const overdue   = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE due_date < date('now') AND status NOT IN ('completed','cancelled')").get().c;
  const completed = db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status='completed' AND strftime('%Y-%m',completed_at)=strftime('%Y-%m','now')").get().c;
  const revenue   = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM invoices WHERE status='paid' AND strftime('%Y-%m',created_at)=strftime('%Y-%m','now')").get().r;
  const outstanding = db.prepare("SELECT COALESCE(SUM(total),0) as r FROM invoices WHERE status IN ('pending','overdue')").get().r;
  const newInquiries = db.prepare("SELECT COUNT(*) as c FROM inquiries WHERE status='new'").get().c;
  const teamCount = db.prepare("SELECT COUNT(*) as c FROM users WHERE role IN ('admin','employee') AND is_active=1").get().c;
  const complianceOverdue = db.prepare("SELECT COUNT(*) as c FROM compliance_calendar WHERE due_date < date('now') AND status NOT IN ('filed','completed')").get().c;

  res.json({ success: true, stats: { clients, tasks, overdue, completed, revenue, outstanding, newInquiries, teamCount, complianceOverdue }});
});

// ── GET /api/reports/revenue ──────────────────────────────────────
router.get('/revenue', (req, res) => {
  const { year = new Date().getFullYear() } = req.query;

  const monthly = db.prepare(`
    SELECT strftime('%m', created_at) as month,
      SUM(CASE WHEN status='paid'    THEN total ELSE 0 END) as collected,
      SUM(CASE WHEN status='pending' THEN total ELSE 0 END) as pending,
      COUNT(*) as invoice_count
    FROM invoices
    WHERE strftime('%Y', created_at) = ? AND status != 'cancelled'
    GROUP BY month ORDER BY month ASC
  `).all(String(year));

  const byService = db.prepare(`
    SELECT json_each.value as item_desc,
      SUM(inv.total) as total
    FROM invoices inv, json_each(inv.items)
    WHERE inv.status = 'paid'
    GROUP BY item_desc
    LIMIT 10
  `).all();

  const totals = db.prepare(`
    SELECT
      SUM(CASE WHEN status='paid' THEN total ELSE 0 END) as total_collected,
      SUM(CASE WHEN status IN ('pending','overdue') THEN total ELSE 0 END) as total_outstanding,
      COUNT(DISTINCT client_id) as billed_clients
    FROM invoices WHERE status != 'cancelled' AND strftime('%Y', created_at) = ?
  `).get(String(year));

  res.json({ success: true, monthly, totals });
});

// ── GET /api/reports/tasks ────────────────────────────────────────
router.get('/tasks', (req, res) => {
  const { from, to } = req.query;
  let where = "WHERE t.status != 'cancelled'";
  const params = [];
  if (from && to) { where += ' AND t.created_at BETWEEN ? AND ?'; params.push(from, to); }

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) as count FROM tasks ${where} GROUP BY status
  `).all(...params);

  const byCategory = db.prepare(`
    SELECT category, COUNT(*) as count,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed
    FROM tasks t ${where} AND category IS NOT NULL GROUP BY category ORDER BY count DESC
  `).all(...params);

  const byEmployee = db.prepare(`
    SELECT u.name, u.designation,
      COUNT(t.id) as total,
      SUM(CASE WHEN t.status='completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN t.due_date < date('now') AND t.status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) as overdue
    FROM users u
    LEFT JOIN tasks t ON t.assigned_to = u.id ${where.replace('WHERE', 'AND')}
    WHERE u.role IN ('admin','employee') AND u.is_active = 1
    GROUP BY u.id ORDER BY total DESC
  `).all(...params);

  res.json({ success: true, byStatus, byCategory, byEmployee });
});

// ── GET /api/reports/compliance ───────────────────────────────────
router.get('/compliance', (req, res) => {
  const { month, year } = req.query;
  let where = 'WHERE 1=1'; const params = [];
  if (month && year) { where += " AND strftime('%m',due_date)=? AND strftime('%Y',due_date)=?"; params.push(String(month).padStart(2,'0'), String(year)); }

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('filed','completed') THEN 1 ELSE 0 END) as filed,
      SUM(CASE WHEN due_date < date('now') AND status NOT IN ('filed','completed') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN status='upcoming' THEN 1 ELSE 0 END) as pending
    FROM compliance_calendar ${where}
  `).get(...params);

  const byType = db.prepare(`
    SELECT type, COUNT(*) as total,
      SUM(CASE WHEN status IN ('filed','completed') THEN 1 ELSE 0 END) as filed
    FROM compliance_calendar ${where} GROUP BY type ORDER BY total DESC
  `).all(...params);

  const rate = summary.total > 0 ? Math.round((summary.filed / summary.total) * 100) : 0;

  res.json({ success: true, summary: { ...summary, compliance_rate: rate }, byType });
});

// ── GET /api/reports/clients ──────────────────────────────────────
router.get('/clients', (req, res) => {
  const topClients = db.prepare(`
    SELECT c.name, c.entity_type,
      COUNT(DISTINCT t.id) as tasks,
      COALESCE(SUM(i.total) FILTER (WHERE i.status='paid'), 0) as revenue,
      COUNT(DISTINCT i.id) as invoices
    FROM clients c
    LEFT JOIN tasks    t ON t.client_id = c.id
    LEFT JOIN invoices i ON i.client_id = c.id
    WHERE c.status = 'active'
    GROUP BY c.id ORDER BY revenue DESC LIMIT 10
  `).all();

  const byType = db.prepare(`
    SELECT entity_type, COUNT(*) as count FROM clients WHERE status='active' AND entity_type IS NOT NULL GROUP BY entity_type
  `).all();

  res.json({ success: true, topClients, byType });
});

// ── GET /api/reports/productivity ────────────────────────────────
router.get('/productivity', (req, res) => {
  const productivity = db.prepare(`
    SELECT u.name, u.designation,
      COUNT(t.id) FILTER (WHERE t.status='completed' AND t.completed_at >= date('now','-30 days')) as completed_30d,
      COUNT(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')) as active,
      COUNT(t.id) FILTER (WHERE t.due_date < date('now') AND t.status NOT IN ('completed','cancelled')) as overdue,
      COUNT(t.id) FILTER (WHERE t.status='completed' AND t.completed_at <= t.due_date) as on_time,
      COUNT(t.id) FILTER (WHERE t.status='completed') as total_completed
    FROM users u
    LEFT JOIN tasks t ON t.assigned_to = u.id
    WHERE u.role IN ('admin','employee') AND u.is_active = 1
    GROUP BY u.id ORDER BY completed_30d DESC
  `).all();

  productivity.forEach(p => {
    p.on_time_rate = p.total_completed > 0 ? Math.round((p.on_time / p.total_completed) * 100) : 0;
  });

  res.json({ success: true, productivity });
});

module.exports = router;
