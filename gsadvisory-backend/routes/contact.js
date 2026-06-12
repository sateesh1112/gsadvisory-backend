const express    = require('express');
const router     = express.Router();
const nodemailer = require('nodemailer');
const rateLimit  = require('express-rate-limit');
const { db }     = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

// Rate limit: max 5 submissions per IP per hour
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many submissions. Please try again after an hour.' }
});

// ── POST /api/contact ────────────────────────────────────────────
router.post('/', contactLimiter, async (req, res) => {
  const { name, email, phone, company, service, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ success: false, message: 'Name, email and message are required.' });
  }

  // Save to DB
  const result = db.prepare(`
    INSERT INTO inquiries (name, email, phone, company, service, message)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name, email, phone || null, company || null, service || null, message);

  // Send email notification
  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });

    // Email to GS Advisory
    await transporter.sendMail({
      from:    process.env.MAIL_FROM,
      to:      process.env.MAIL_USER,
      subject: `New Inquiry from ${name} — GS Advisory Website`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;">
          <div style="background:#0d1b2a;padding:24px 32px;">
            <h2 style="color:#c8a951;margin:0;">New Website Inquiry</h2>
            <p style="color:rgba(255,255,255,0.5);margin:4px 0 0;font-size:12px;">gsadvisory.in contact form</p>
          </div>
          <div style="padding:28px 32px;border:1px solid #e2e8f0;">
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 0;color:#94a3b8;font-size:13px;width:120px;">Name</td><td style="padding:8px 0;color:#0d1b2a;font-weight:600;">${name}</td></tr>
              <tr><td style="padding:8px 0;color:#94a3b8;font-size:13px;">Email</td><td style="padding:8px 0;"><a href="mailto:${email}" style="color:#0f7b6c;">${email}</a></td></tr>
              ${phone ? `<tr><td style="padding:8px 0;color:#94a3b8;font-size:13px;">Phone</td><td style="padding:8px 0;color:#0d1b2a;">${phone}</td></tr>` : ''}
              ${company ? `<tr><td style="padding:8px 0;color:#94a3b8;font-size:13px;">Company</td><td style="padding:8px 0;color:#0d1b2a;">${company}</td></tr>` : ''}
              ${service ? `<tr><td style="padding:8px 0;color:#94a3b8;font-size:13px;">Service</td><td style="padding:8px 0;color:#0d1b2a;">${service}</td></tr>` : ''}
            </table>
            <div style="margin-top:16px;padding:16px;background:#f8f9fc;border-left:4px solid #c8a951;border-radius:4px;">
              <p style="color:#334155;margin:0;font-size:14px;line-height:1.6;">${message}</p>
            </div>
            <p style="margin-top:20px;color:#94a3b8;font-size:12px;">Inquiry ID: #${result.lastInsertRowid} — ${new Date().toLocaleString('en-IN')}</p>
          </div>
        </div>
      `
    });

    // Auto-reply to sender
    await transporter.sendMail({
      from:    process.env.MAIL_FROM,
      to:      email,
      subject: `Thank you for contacting GS Advisory — We'll respond within 24 hours`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;">
          <div style="background:#0d1b2a;padding:24px 32px;">
            <h2 style="color:#c8a951;margin:0;">GS Advisory</h2>
            <p style="color:rgba(255,255,255,0.5);margin:4px 0 0;font-size:12px;font-style:italic;">Be Wise, Take Our Advice</p>
          </div>
          <div style="padding:28px 32px;border:1px solid #e2e8f0;">
            <p style="color:#334155;font-size:15px;">Dear <strong>${name}</strong>,</p>
            <p style="color:#64748b;line-height:1.7;">Thank you for reaching out to GS Advisory. We have received your inquiry and our team will get back to you within <strong>24 business hours</strong>.</p>
            <p style="color:#64748b;line-height:1.7;">For urgent matters, you can reach us directly:</p>
            <p style="color:#0d1b2a;font-weight:600;">📞 +971 52 725 1804 (UAE) &nbsp;|&nbsp; +91 99857 52173 (India)</p>
            <p style="color:#0d1b2a;font-weight:600;">✉️ admin@gsadvisory.in</p>
            <p style="color:#64748b;margin-top:24px;">Warm regards,<br/><strong style="color:#0d1b2a;">GS Advisory Team</strong></p>
          </div>
          <div style="background:#f8f9fc;padding:16px 32px;text-align:center;">
            <p style="color:#94a3b8;font-size:12px;margin:0;">© 2025 GS Advisory | gsadvisory.in</p>
          </div>
        </div>
      `
    });

  } catch (emailErr) {
    console.error('Email error:', emailErr.message);
    // Still return success — inquiry saved in DB even if email fails
  }

  res.status(201).json({
    success: true,
    message: 'Your inquiry has been received. We will contact you within 24 hours.'
  });
});

// ── GET /api/contact (admin only — view all inquiries) ───────────
router.get('/', authMiddleware, requireRole('admin', 'employee'), (req, res) => {
  const inquiries = db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all();
  res.json({ success: true, inquiries });
});

// ── PUT /api/contact/:id (mark status) ──────────────────────────
router.put('/:id', authMiddleware, requireRole('admin', 'employee'), (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE inquiries SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true, message: 'Inquiry updated.' });
});

module.exports = router;
