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

  // Update last login timestamp
  db.prepare('UPDATE users SET last_login=datetime('now') WHERE id=?').run(user.id);
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
  db.prepare('UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?').run(hashed, req.user.id);

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
  db.prepare('UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?').run(hashed, user_id);

  res.json({ success: true, message: `Password reset for ${user.name} (${user.email}).` });
});


// ── POST /api/auth/change-password (self) ────────────────────────
router.post('/change-password', authMiddleware, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ success: false, message: 'Both fields required.' });
  if (new_password.length < 8)
    return res.status(400).json({ success: false, message: 'Min 8 characters.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !bcrypt.compareSync(current_password, user.password))
    return res.status(400).json({ success: false, message: 'Current password incorrect.' });

  const hashed = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password=?, temp_password_changed=1, updated_at=datetime('now') WHERE id=?').run(hashed, req.user.id);
  res.json({ success: true, message: 'Password changed successfully.' });
});

// ── GET /api/auth/users (admin) ──────────────────────────────────
router.get('/users', authMiddleware, requireRole('admin'), (req, res) => {
  try {
    const users = db.prepare('SELECT id,name,email,role,designation,department,phone,is_active,temp_password_changed,last_login,created_at FROM users').all();
    res.json({ success: true, users });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/auth/onboard-client ────────────────────────────────
// Admin triggers onboarding email with temp password to a client
router.post('/onboard-client', authMiddleware, requireRole('admin'), async (req, res) => {
  const { client_id, email, name } = req.body;
  if (!email || !name) return res.status(400).json({ success: false, message: 'Email and name required.' });

  const tempPass = 'GS@' + Math.random().toString(36).substring(2,8).toUpperCase();
  const hashed   = bcrypt.hashSync(tempPass, 12);

  try {
    // Create client portal account
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
    let userId;
    if (existing) {
      db.prepare('UPDATE users SET password=?, temp_password_changed=0, updated_at=datetime('now') WHERE id=?').run(hashed, existing.id);
      userId = existing.id;
    } else {
      const r = db.prepare('INSERT INTO users (name,email,password,role,temp_password_changed) VALUES (?,?,?,?,0)').run(name, email.toLowerCase(), hashed, 'client');
      userId = r.lastInsertRowid;
    }

    // Send email
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'GS Advisory <admin@gsadvisory.in>',
      to: email,
      subject: 'Welcome to GS Advisory — Your Client Portal Access',
      html: '<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;">' +
        '<div style="background:linear-gradient(135deg,#0d1b2a,#0f7b6c);padding:28px;text-align:center;">' +
          '<h1 style="color:#c8a951;font-size:22px;margin:0;">GS ADVISORY</h1>' +
          '<p style="color:rgba(255,255,255,0.7);margin:6px 0 0;font-size:13px;">Be Wise, Take Our Advice</p>' +
        '</div>' +
        '<div style="padding:32px;background:#fff;">' +
          '<h2 style="color:#0d1b2a;margin-bottom:8px;">Welcome, ' + name + '!</h2>' +
          '<p style="color:#334155;line-height:1.7;">Your GS Advisory client portal account has been created. Access your documents, invoices, and service status online.</p>' +
          '<div style="background:#f8faf9;border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin:20px 0;">' +
            '<div style="margin-bottom:10px;"><strong>Portal URL:</strong> <a href="https://gsadvisory.in">gsadvisory.in</a></div>' +
            '<div style="margin-bottom:10px;"><strong>Email:</strong> ' + email + '</div>' +
            '<div><strong>Temporary Password:</strong> <code style="background:#0d1b2a;color:#c8a951;padding:3px 10px;border-radius:4px;">' + tempPass + '</code></div>' +
          '</div>' +
          '<p style="color:#64748b;font-size:13px;"><strong>Please change your password</strong> after first login via Settings → Change Password.</p>' +
          '<a href="https://gsadvisory.in/gs_dashboard.html" style="display:inline-block;background:linear-gradient(135deg,#0d1b2a,#0f7b6c);color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;margin-top:10px;">Access Portal</a>' +
        '</div>' +
        '<div style="padding:16px;text-align:center;font-size:12px;color:#94a3b8;">GS Advisory | Dubai & Delhi | admin@gsadvisory.in</div>' +
      '</div>'
    });

    res.json({ success: true, message: 'Onboarding email sent to ' + email + ' with temporary password.', temp_password: tempPass });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
