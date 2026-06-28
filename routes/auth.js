const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { db }  = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

// ── POST /api/auth/login ─────────────────────────────────────────
router.post('/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email.toLowerCase().trim());

  if (!user) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  const validPassword = bcrypt.compareSync(password, user.password);
  if (!validPassword) {
    return res.status(401).json({ success: false, message: 'Invalid email or password.' });
  }

  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    process.env.JWT_SECRET,
    { expiresIn: '8h' }
  );

  res.json({
    success: true,
    message: 'Login successful',
    token,
    user: {
      id:          user.id,
      name:        user.name,
      email:       user.email,
      role:        user.role,
      phone:       user.phone,
      designation: user.designation
    }
  });
});

// ── POST /api/auth/register (admin only) ────────────────────────
router.post('/register', authMiddleware, requireRole('admin'), (req, res) => {
  const { name, email, password, role, phone, designation } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ success: false, message: 'Name, email, password and role are required.' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ success: false, message: 'Email already registered.' });
  }

  const hashedPassword = bcrypt.hashSync(password, 12);

  const result = db.prepare(`
    INSERT INTO users (name, email, password, role, phone, designation)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, email.toLowerCase().trim(), hashedPassword, role, phone || null, designation || null);

  res.status(201).json({
    success: true,
    message: `${role} account created successfully.`,
    userId: result.lastInsertRowid
  });
});

// ── GET /api/auth/me ─────────────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, phone, designation, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });
  res.json({ success: true, user });
});

// ── PUT /api/auth/change-password ────────────────────────────────
router.put('/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(currentPassword, user.password)) {
    return res.status(400).json({ success: false, message: 'Current password is incorrect.' });
  }

  const hashed = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password = ?, updated_at = datetime("now") WHERE id = ?').run(hashed, req.user.id);

  res.json({ success: true, message: 'Password changed successfully.' });
});

// ── GET /api/auth/users (admin only) ────────────────────────────
router.get('/users', authMiddleware, requireRole('admin'), (req, res) => {
  const users = db.prepare('SELECT id, name, email, role, phone, designation, is_active, created_at FROM users ORDER BY created_at DESC').all();
  res.json({ success: true, users });
});

// ── DELETE /api/auth/users/:id (admin only) ──────────────────────
router.delete('/users/:id', authMiddleware, requireRole('admin'), (req, res) => {
  db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'User deactivated.' });
});


// ── POST /api/auth/reset-password (admin only) ───────────────────
router.post('/reset-password', authMiddleware, requireRole('admin'), (req, res) => {
  const { user_id, new_password } = req.body;

  if (!user_id || !new_password) {
    return res.status(400).json({ success: false, message: 'user_id and new_password are required.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  }

  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(user_id);
  if (!user) return res.status(404).json({ success: false, message: 'User not found.' });

  const hashed = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password = ?, updated_at = datetime("now") WHERE id = ?').run(hashed, user_id);

  res.json({ success: true, message: `Password reset for ${user.name} (${user.email}).` });
});

module.exports = router;
