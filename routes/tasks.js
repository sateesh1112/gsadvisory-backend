const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// ── GET /api/tasks ───────────────────────────────────────────────
router.get('/', (req, res) => {
  let query = `
    SELECT t.*,
      c.name as client_name,
      u.name as assignee_name
    FROM tasks t
    LEFT JOIN clients c ON t.client_id = c.id
    LEFT JOIN users   u ON t.assigned_to = u.id
    WHERE t.status != 'cancelled'
  `;
  const params = [];

  // Employees see only their tasks
  if (req.user.role === 'employee') {
    query += ' AND t.assigned_to = ?';
    params.push(req.user.id);
  }

  // Clients see only tasks for their client record
  if (req.user.role === 'client') {
    const client = db.prepare('SELECT id FROM clients WHERE user_id = ?').get(req.user.id);
    if (client) { query += ' AND t.client_id = ?'; params.push(client.id); }
    else return res.json({ success: true, tasks: [] });
  }

  const { status, category, priority } = req.query;
  if (status)   { query += ' AND t.status = ?';   params.push(status); }
  if (category) { query += ' AND t.category = ?'; params.push(category); }
  if (priority) { query += ' AND t.priority = ?'; params.push(priority); }

  query += ' ORDER BY t.due_date ASC, t.priority DESC';
  const tasks = db.prepare(query).all(...params);
  res.json({ success: true, tasks });
});

// ── GET /api/tasks/stats ─────────────────────────────────────────
router.get('/stats', requireRole('admin', 'employee'), (req, res) => {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending'     THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status = 'completed'   THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN due_date < date('now') AND status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN due_date BETWEEN date('now') AND date('now','+7 days') AND status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) as due_this_week
    FROM tasks
  `).get();
  res.json({ success: true, stats });
});

// ── GET /api/tasks/:id ───────────────────────────────────────────
router.get('/:id', (req, res) => {
  const task = db.prepare(`
    SELECT t.*, c.name as client_name, u.name as assignee_name
    FROM tasks t
    LEFT JOIN clients c ON t.client_id = c.id
    LEFT JOIN users   u ON t.assigned_to = u.id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
  res.json({ success: true, task });
});

// ── POST /api/tasks ──────────────────────────────────────────────
router.post('/', requireRole('admin', 'employee'), (req, res) => {
  const { title, description, client_id, assigned_to, category, priority, due_date, notes } = req.body;

  if (!title) return res.status(400).json({ success: false, message: 'Task title is required.' });

  const result = db.prepare(`
    INSERT INTO tasks (title, description, client_id, assigned_to, created_by, category, priority, due_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(title, description || null, client_id || null, assigned_to || null,
         req.user.id, category || null, priority || 'medium', due_date || null, notes || null);

  res.status(201).json({ success: true, message: 'Task created.', taskId: result.lastInsertRowid });
});

// ── PUT /api/tasks/:id ───────────────────────────────────────────
router.put('/:id', (req, res) => {
  const { title, description, assigned_to, category, priority, status, due_date, notes } = req.body;

  const completedAt = status === 'completed' ? "datetime('now')" : 'completed_at';

  db.prepare(`
    UPDATE tasks SET
      title       = COALESCE(?, title),
      description = COALESCE(?, description),
      assigned_to = COALESCE(?, assigned_to),
      category    = COALESCE(?, category),
      priority    = COALESCE(?, priority),
      status      = COALESCE(?, status),
      due_date    = COALESCE(?, due_date),
      notes       = COALESCE(?, notes),
      completed_at = CASE WHEN ? = 'completed' THEN datetime('now') ELSE completed_at END,
      updated_at  = datetime('now')
    WHERE id = ?
  `).run(title, description, assigned_to, category, priority, status, due_date, notes, status, req.params.id);

  res.json({ success: true, message: 'Task updated.' });
});

// ── DELETE /api/tasks/:id ────────────────────────────────────────
router.delete('/:id', requireRole('admin'), (req, res) => {
  db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ success: true, message: 'Task cancelled.' });
});

module.exports = router;
