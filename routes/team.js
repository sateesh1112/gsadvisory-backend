const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// ── GET /api/team ─────────────────────────────────────────────────
// List all team members with workload stats
router.get('/', requireRole('admin', 'employee'), (req, res) => {
  const members = db.prepare(`
    SELECT
      u.id, u.name, u.email, u.phone, u.designation, u.department,
      u.role, u.is_active, u.last_login, u.created_at,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')) as active_tasks,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed') as completed_tasks,
      COUNT(DISTINCT t.id) FILTER (WHERE t.due_date < date('now') AND t.status NOT IN ('completed','cancelled')) as overdue_tasks,
      COUNT(DISTINCT c.id) as assigned_clients
    FROM users u
    LEFT JOIN tasks   t ON t.assigned_to = u.id
    LEFT JOIN clients c ON c.assigned_to = u.id
    WHERE u.role IN ('admin','employee') AND u.is_active = 1
    GROUP BY u.id
    ORDER BY u.name ASC
  `).all();
  res.json({ success: true, members });
});

// ── GET /api/team/:id ─────────────────────────────────────────────
router.get('/:id', requireRole('admin', 'employee'), (req, res) => {
  const member = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, u.designation, u.department, u.role, u.created_at,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')) as active_tasks,
      COUNT(DISTINCT t.id) FILTER (WHERE t.status = 'completed') as completed_tasks
    FROM users u
    LEFT JOIN tasks t ON t.assigned_to = u.id
    WHERE u.id = ?
    GROUP BY u.id
  `).get(req.params.id);

  if (!member) return res.status(404).json({ success: false, message: 'Member not found.' });

  const tasks = db.prepare(`
    SELECT t.*, c.name as client_name
    FROM tasks t LEFT JOIN clients c ON t.client_id = c.id
    WHERE t.assigned_to = ? AND t.status NOT IN ('completed','cancelled')
    ORDER BY t.due_date ASC
  `).all(req.params.id);

  res.json({ success: true, member, tasks });
});

// ── POST /api/team ────────────────────────────────────────────────
// Add new team member (admin only)
router.post('/', requireRole('admin'), (req, res) => {
  const { name, email, password, designation, department, phone } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ success: false, message: 'Name, email and password are required.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) return res.status(409).json({ success: false, message: 'Email already registered.' });

  const hashed = bcrypt.hashSync(password, 12);
  const result = db.prepare(`
    INSERT INTO users (name, email, password, role, designation, department, phone)
    VALUES (?, ?, ?, 'employee', ?, ?, ?)
  `).run(name, email.toLowerCase().trim(), hashed, designation || null, department || null, phone || null);

  res.status(201).json({
    success: true,
    message: `Team member ${name} added successfully.`,
    memberId: result.lastInsertRowid
  });
});

// ── PUT /api/team/:id ─────────────────────────────────────────────
router.put('/:id', requireRole('admin'), (req, res) => {
  const { name, phone, designation, department, is_active } = req.body;
  db.prepare(`
    UPDATE users SET
      name        = COALESCE(?, name),
      phone       = COALESCE(?, phone),
      designation = COALESCE(?, designation),
      department  = COALESCE(?, department),
      is_active   = COALESCE(?, is_active),
      updated_at  = datetime('now')
    WHERE id = ?
  `).run(name, phone, designation, department, is_active, req.params.id);
  res.json({ success: true, message: 'Member updated.' });
});

// ── DELETE /api/team/:id ──────────────────────────────────────────
router.delete('/:id', requireRole('admin'), (req, res) => {
  if (parseInt(req.params.id) === req.user.id) {
    return res.status(400).json({ success: false, message: 'You cannot deactivate yourself.' });
  }
  db.prepare('UPDATE users SET is_active = 0, updated_at = datetime("now") WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Team member deactivated.' });
});

// ── GET /api/team/workload/summary ────────────────────────────────
router.get('/workload/summary', requireRole('admin', 'employee'), (req, res) => {
  const workload = db.prepare(`
    SELECT
      u.id, u.name, u.designation,
      COUNT(t.id) FILTER (WHERE t.status NOT IN ('completed','cancelled')) as active,
      COUNT(t.id) FILTER (WHERE t.priority = 'urgent' AND t.status NOT IN ('completed','cancelled')) as urgent,
      COUNT(t.id) FILTER (WHERE t.due_date < date('now') AND t.status NOT IN ('completed','cancelled')) as overdue
    FROM users u
    LEFT JOIN tasks t ON t.assigned_to = u.id
    WHERE u.role IN ('admin','employee') AND u.is_active = 1
    GROUP BY u.id
    ORDER BY active DESC
  `).all();
  res.json({ success: true, workload });
});

// ── POST /api/team/reassign ───────────────────────────────────────
// Transfer tasks from one employee to another
router.post('/reassign', requireRole('admin'), (req, res) => {
  const { from_user_id, to_user_id, task_ids } = req.body;

  if (!from_user_id || !to_user_id) {
    return res.status(400).json({ success: false, message: 'from_user_id and to_user_id are required.' });
  }

  let count = 0;
  if (task_ids && task_ids.length) {
    // Reassign specific tasks
    const stmt = db.prepare('UPDATE tasks SET assigned_to = ?, updated_at = datetime("now") WHERE id = ?');
    task_ids.forEach(id => { stmt.run(to_user_id, id); count++; });
  } else {
    // Reassign all pending tasks
    const result = db.prepare(`
      UPDATE tasks SET assigned_to = ?, updated_at = datetime('now')
      WHERE assigned_to = ? AND status NOT IN ('completed','cancelled')
    `).run(to_user_id, from_user_id);
    count = result.changes;
  }

  // Log in task history
  const logStmt = db.prepare(`
    INSERT INTO task_history (task_id, user_id, action, old_value, new_value, comment)
    VALUES (?, ?, 'reassigned', ?, ?, 'Bulk reassignment by admin')
  `);
  if (task_ids) {
    task_ids.forEach(id => logStmt.run(id, req.user.id, String(from_user_id), String(to_user_id)));
  }

  res.json({ success: true, message: `${count} tasks reassigned successfully.`, count });
});

module.exports = router;
