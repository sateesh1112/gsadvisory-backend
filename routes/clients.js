const express = require('express');
const router  = express.Router();
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

// All routes require authentication
router.use(authMiddleware);

// ── GET /api/clients ─────────────────────────────────────────────
router.get('/', (req, res) => {
  let query = `
    SELECT c.*, u.name as assigned_name
    FROM clients c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.status != 'deleted'
  `;
  const params = [];

  // Clients can only see their own record
  if (req.user.role === 'client') {
    query += ' AND c.user_id = ?';
    params.push(req.user.id);
  }

  query += ' ORDER BY c.created_at DESC';
  const clients = db.prepare(query).all(...params);
  res.json({ success: true, clients });
});

// ── GET /api/clients/:id ─────────────────────────────────────────
router.get('/:id', (req, res) => {
  const client = db.prepare(`
    SELECT c.*, u.name as assigned_name
    FROM clients c
    LEFT JOIN users u ON c.assigned_to = u.id
    WHERE c.id = ?
  `).get(req.params.id);

  if (!client) return res.status(404).json({ success: false, message: 'Client not found.' });
  res.json({ success: true, client });
});

// ── POST /api/clients ────────────────────────────────────────────
router.post('/', requireRole('admin', 'employee'), (req, res) => {
  const { name, email, phone, entity_type, pan, gstin, address, city, country, services, assigned_to } = req.body;

  if (!name) return res.status(400).json({ success: false, message: 'Client name is required.' });

  // Create user account for client if email provided
  let userId = null;
  if (email) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    if (!existing) {
      const bcrypt = require('bcryptjs');
      const tempPass = bcrypt.hashSync('Client@123', 12);
      const userResult = db.prepare(`
        INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, 'client')
      `).run(name, email.toLowerCase(), tempPass);
      userId = userResult.lastInsertRowid;
    } else {
      userId = existing.id;
    }
  }

  const result = db.prepare(`
    INSERT INTO clients (name, email, phone, entity_type, pan, gstin, address, city, country, services, assigned_to, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(name, email || null, phone || null, entity_type || null, pan || null, gstin || null,
         address || null, city || null, country || 'India',
         JSON.stringify(services || []), assigned_to || null, userId);

  res.status(201).json({ success: true, message: 'Client added successfully.', clientId: result.lastInsertRowid });
});

// ── PUT /api/clients/:id ─────────────────────────────────────────
router.put('/:id', requireRole('admin', 'employee'), (req, res) => {
  const { name, email, phone, entity_type, pan, gstin, address, city, country, services, assigned_to, status } = req.body;

  db.prepare(`
    UPDATE clients SET
      name = COALESCE(?, name),
      email = COALESCE(?, email),
      phone = COALESCE(?, phone),
      entity_type = COALESCE(?, entity_type),
      pan = COALESCE(?, pan),
      gstin = COALESCE(?, gstin),
      address = COALESCE(?, address),
      city = COALESCE(?, city),
      country = COALESCE(?, country),
      services = COALESCE(?, services),
      assigned_to = COALESCE(?, assigned_to),
      status = COALESCE(?, status),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(name, email, phone, entity_type, pan, gstin, address, city, country,
         services ? JSON.stringify(services) : null, assigned_to, status, req.params.id);

  res.json({ success: true, message: 'Client updated.' });
});

// ── DELETE /api/clients/:id ──────────────────────────────────────
router.delete('/:id', requireRole('admin'), (req, res) => {
  db.prepare("UPDATE clients SET status = 'deleted', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ success: true, message: 'Client removed.' });
});

// ── GET /api/clients/:id/tasks ───────────────────────────────────
router.get('/:id/tasks', (req, res) => {
  const tasks = db.prepare(`
    SELECT t.*, u.name as assignee_name
    FROM tasks t
    LEFT JOIN users u ON t.assigned_to = u.id
    WHERE t.client_id = ?
    ORDER BY t.due_date ASC
  `).all(req.params.id);
  res.json({ success: true, tasks });
});

module.exports = router;
