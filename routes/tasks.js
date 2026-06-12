const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', (req, res) => {
  let query = `
    SELECT t.*, c.name as client_name, u.name as assignee_name, ab.name as assigned_by_name
    FROM tasks t
    LEFT JOIN clients c  ON t.client_id   = c.id
    LEFT JOIN users   u  ON t.assigned_to  = u.id
    LEFT JOIN users   ab ON t.assigned_by  = ab.id
    WHERE t.status != 'cancelled'
  `;
  const params = [];
  if (req.user.role === 'employee') { query += ' AND t.assigned_to = ?'; params.push(req.user.id); }
  if (req.user.role === 'client') {
    const client = db.prepare('SELECT id FROM clients WHERE user_id = ?').get(req.user.id);
    if (client) { query += ' AND t.client_id = ?'; params.push(client.id); }
    else return res.json({ success: true, tasks: [] });
  }
  const { status, category, priority, assigned_to, client_id, overdue } = req.query;
  if (status)      { query += ' AND t.status = ?';      params.push(status); }
  if (category)    { query += ' AND t.category = ?';    params.push(category); }
  if (priority)    { query += ' AND t.priority = ?';    params.push(priority); }
  if (assigned_to) { query += ' AND t.assigned_to = ?'; params.push(assigned_to); }
  if (client_id)   { query += ' AND t.client_id = ?';   params.push(client_id); }
  if (overdue === 'true') { query += " AND t.due_date < date('now') AND t.status NOT IN ('completed','cancelled')"; }
  query += ' ORDER BY t.priority DESC, t.due_date ASC';
  res.json({ success: true, tasks: db.prepare(query).all(...params) });
});

router.get('/stats', requireRole('admin', 'employee'), (req, res) => {
  let where = ''; const params = [];
  if (req.user.role === 'employee') { where = 'WHERE assigned_to = ?'; params.push(req.user.id); }
  const stats = db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) as in_progress,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN due_date < date('now') AND status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) as overdue,
      SUM(CASE WHEN due_date BETWEEN date('now') AND date('now','+7 days') AND status NOT IN ('completed','cancelled') THEN 1 ELSE 0 END) as due_this_week
    FROM tasks ${where}
  `).get(...params);
  res.json({ success: true, stats });
});

router.get('/:id', (req, res) => {
  const task = db.prepare(`
    SELECT t.*, c.name as client_name, u.name as assignee_name
    FROM tasks t LEFT JOIN clients c ON t.client_id=c.id LEFT JOIN users u ON t.assigned_to=u.id WHERE t.id=?
  `).get(req.params.id);
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
  const history  = db.prepare('SELECT th.*, u.name as user_name FROM task_history th LEFT JOIN users u ON th.user_id=u.id WHERE th.task_id=? ORDER BY th.created_at DESC').all(req.params.id);
  const comments = db.prepare('SELECT tc.*, u.name as user_name FROM task_comments tc LEFT JOIN users u ON tc.user_id=u.id WHERE tc.task_id=? ORDER BY tc.created_at ASC').all(req.params.id);
  const documents = db.prepare('SELECT * FROM documents WHERE task_id = ?').all(req.params.id);
  res.json({ success: true, task, history, comments, documents });
});

router.post('/', requireRole('admin', 'employee'), (req, res) => {
  const { title, description, client_id, assigned_to, category, priority, due_date, reminder_date, notes, is_recurring, recurrence } = req.body;
  if (!title) return res.status(400).json({ success: false, message: 'Task title is required.' });
  const result = db.prepare(`
    INSERT INTO tasks (title,description,client_id,assigned_to,assigned_by,created_by,category,priority,due_date,reminder_date,notes,is_recurring,recurrence)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(title, description||null, client_id||null, assigned_to||null, req.user.id, req.user.id, category||null, priority||'medium', due_date||null, reminder_date||null, notes||null, is_recurring?1:0, recurrence||null);
  db.prepare('INSERT INTO task_history (task_id,user_id,action,new_value) VALUES (?,?,?,?)').run(result.lastInsertRowid, req.user.id, 'created', title);
  const complianceTypes = ['GST','TDS','Income Tax','ROC','UAE VAT','Audit'];
  if (category && complianceTypes.some(t => category.includes(t)) && due_date) {
    db.prepare('INSERT INTO compliance_calendar (title,type,due_date,client_id,task_id,created_by) VALUES (?,?,?,?,?,?)').run(title, category, due_date, client_id||null, result.lastInsertRowid, req.user.id);
  }
  res.status(201).json({ success: true, message: 'Task created.', taskId: result.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: 'Task not found.' });
  const { title, description, assigned_to, category, priority, status, due_date, reminder_date, notes } = req.body;
  db.prepare(`UPDATE tasks SET title=COALESCE(?,title), description=COALESCE(?,description), assigned_to=COALESCE(?,assigned_to), category=COALESCE(?,category), priority=COALESCE(?,priority), status=COALESCE(?,status), due_date=COALESCE(?,due_date), reminder_date=COALESCE(?,reminder_date), notes=COALESCE(?,notes), completed_at=CASE WHEN ?='completed' THEN datetime('now') ELSE completed_at END, updated_at=datetime('now') WHERE id=?`)
    .run(title, description, assigned_to, category, priority, status, due_date, reminder_date, notes, status, req.params.id);
  if (status && status !== existing.status) db.prepare('INSERT INTO task_history (task_id,user_id,action,old_value,new_value) VALUES (?,?,?,?,?)').run(req.params.id, req.user.id, 'status_changed', existing.status, status);
  if (assigned_to && assigned_to != existing.assigned_to) db.prepare('INSERT INTO task_history (task_id,user_id,action,old_value,new_value) VALUES (?,?,?,?,?)').run(req.params.id, req.user.id, 'reassigned', String(existing.assigned_to), String(assigned_to));
  res.json({ success: true, message: 'Task updated.' });
});

router.post('/:id/transfer', requireRole('admin','employee'), (req, res) => {
  const { to_user_id, reason } = req.body;
  if (!to_user_id) return res.status(400).json({ success: false, message: 'to_user_id required.' });
  const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(req.params.id);
  if (!task) return res.status(404).json({ success: false, message: 'Task not found.' });
  db.prepare('UPDATE tasks SET assigned_to=?, assigned_by=?, updated_at=datetime("now") WHERE id=?').run(to_user_id, req.user.id, req.params.id);
  db.prepare('INSERT INTO task_history (task_id,user_id,action,old_value,new_value,comment) VALUES (?,?,?,?,?,?)').run(req.params.id, req.user.id, 'transferred', String(task.assigned_to), String(to_user_id), reason||null);
  res.json({ success: true, message: 'Task transferred.' });
});

router.post('/:id/comments', (req, res) => {
  const { comment } = req.body;
  if (!comment) return res.status(400).json({ success: false, message: 'Comment required.' });
  db.prepare('INSERT INTO task_comments (task_id,user_id,comment) VALUES (?,?,?)').run(req.params.id, req.user.id, comment);
  db.prepare('INSERT INTO task_history (task_id,user_id,action,new_value) VALUES (?,?,?,?)').run(req.params.id, req.user.id, 'commented', comment.substring(0,100));
  res.status(201).json({ success: true, message: 'Comment added.' });
});

router.get('/:id/history', (req, res) => {
  const history = db.prepare('SELECT th.*, u.name as user_name FROM task_history th LEFT JOIN users u ON th.user_id=u.id WHERE th.task_id=? ORDER BY th.created_at DESC').all(req.params.id);
  res.json({ success: true, history });
});

router.delete('/:id', requireRole('admin'), (req, res) => {
  db.prepare("UPDATE tasks SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(req.params.id);
  db.prepare('INSERT INTO task_history (task_id,user_id,action) VALUES (?,?,?)').run(req.params.id, req.user.id, 'cancelled');
  res.json({ success: true, message: 'Task cancelled.' });
});

module.exports = router;
