const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');
const { sendManualReminder, runComplianceReminders, runTaskReminders, runInvoiceReminders } = require('../scheduler');

router.use(authMiddleware);

// ── GET /api/reminders ────────────────────────────────────────────
router.get('/', requireRole('admin', 'employee'), (req, res) => {
  const { type, status, limit = 50 } = req.query;
  let query = `
    SELECT r.*, c.name as client_name, t.title as task_title
    FROM reminders r
    LEFT JOIN clients c ON r.client_id = c.id
    LEFT JOIN tasks   t ON r.task_id   = t.id
    WHERE 1=1
  `;
  const params = [];
  if (type)   { query += ' AND r.type = ?';   params.push(type); }
  if (status) { query += ' AND r.status = ?'; params.push(status); }
  query += ' ORDER BY r.created_at DESC LIMIT ?';
  params.push(parseInt(limit));

  const reminders = db.prepare(query).all(...params);
  res.json({ success: true, reminders });
});

// ── POST /api/reminders/send ──────────────────────────────────────
// Manually send a reminder
router.post('/send', requireRole('admin', 'employee'), async (req, res) => {
  const { to, subject, body, type, client_id, task_id } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ success: false, message: 'to, subject and body are required.' });
  }

  const sent = await sendManualReminder({ to, subject, body, type: type || 'manual', client_id, task_id });

  res.json({
    success: sent,
    message: sent ? `Reminder sent to ${to}` : 'Failed to send reminder. Check email configuration.'
  });
});

// ── POST /api/reminders/send-client ──────────────────────────────
// Send reminder to a specific client with their task/compliance status
router.post('/send-client', requireRole('admin', 'employee'), async (req, res) => {
  const { client_id, message, type } = req.body;
  if (!client_id) return res.status(400).json({ success: false, message: 'client_id required.' });

  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(client_id);
  if (!client || !client.email) {
    return res.status(400).json({ success: false, message: 'Client not found or has no email.' });
  }

  // Get their pending compliance items
  const pending = db.prepare(`
    SELECT title, due_date FROM compliance_calendar
    WHERE client_id = ? AND status NOT IN ('filed','completed') AND due_date >= date('now')
    ORDER BY due_date ASC LIMIT 5
  `).all(client_id);

  const pendingHtml = pending.length
    ? `<ul>${pending.map(p => `<li style="padding:4px 0;"><strong>${p.title}</strong> — Due: <span style="color:#f97316;">${p.due_date}</span></li>`).join('')}</ul>`
    : '';

  const body = `${message || 'This is a reminder regarding your pending compliance tasks.'}${pendingHtml ? '<br/><strong>Pending Items:</strong>' + pendingHtml : ''}`;

  const sent = await sendManualReminder({
    to: client.email,
    subject: `Reminder from GS Advisory — ${client.name}`,
    body,
    type: type || 'client_reminder',
    client_id
  });

  res.json({ success: sent, message: sent ? `Reminder sent to ${client.email}` : 'Failed to send.' });
});

// ── POST /api/reminders/run-compliance ───────────────────────────
// Manually trigger compliance reminders (admin)
router.post('/run-compliance', requireRole('admin'), async (req, res) => {
  await runComplianceReminders();
  res.json({ success: true, message: 'Compliance reminders processed.' });
});

// ── POST /api/reminders/run-tasks ────────────────────────────────
router.post('/run-tasks', requireRole('admin'), async (req, res) => {
  await runTaskReminders();
  res.json({ success: true, message: 'Task reminders processed.' });
});

// ── POST /api/reminders/run-invoices ─────────────────────────────
router.post('/run-invoices', requireRole('admin'), async (req, res) => {
  await runInvoiceReminders();
  res.json({ success: true, message: 'Invoice reminders processed.' });
});

// ── GET /api/reminders/stats ──────────────────────────────────────
router.get('/stats', requireRole('admin', 'employee'), (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END) as sent,
      SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN type = 'compliance_urgent' THEN 1 ELSE 0 END) as compliance,
      SUM(CASE WHEN type = 'task_overdue'      THEN 1 ELSE 0 END) as tasks,
      SUM(CASE WHEN type = 'invoice_payment'   THEN 1 ELSE 0 END) as invoices,
      SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN 1 ELSE 0 END) as this_month
    FROM reminders
  `).get();
  res.json({ success: true, stats });
});

module.exports = router;
