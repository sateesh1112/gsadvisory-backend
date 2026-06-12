const express   = require('express');
const router    = express.Router();
const path      = require('path');
const fs        = require('fs');
const PDFDoc    = require('pdfkit');
const nodemailer= require('nodemailer');
const { db }    = require('../db/setup');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.use(authMiddleware);

// Invoice number generator
function generateInvoiceNumber() {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const count = db.prepare('SELECT COUNT(*) as c FROM invoices').get().c + 1;
  return `GS-${year}${month}-${String(count).padStart(4, '0')}`;
}

// ── GET /api/invoices ────────────────────────────────────────────
router.get('/', (req, res) => {
  let query = `
    SELECT i.*, c.name as client_name, c.email as client_email
    FROM invoices i
    LEFT JOIN clients c ON i.client_id = c.id
    WHERE i.status != 'cancelled'
  `;
  const params = [];

  if (req.user.role === 'client') {
    const client = db.prepare('SELECT id FROM clients WHERE user_id = ?').get(req.user.id);
    if (client) { query += ' AND i.client_id = ?'; params.push(client.id); }
    else return res.json({ success: true, invoices: [] });
  }

  const { status } = req.query;
  if (status) { query += ' AND i.status = ?'; params.push(status); }

  query += ' ORDER BY i.created_at DESC';
  const invoices = db.prepare(query).all(...params);
  res.json({ success: true, invoices });
});

// ── GET /api/invoices/stats ──────────────────────────────────────
router.get('/stats', requireRole('admin', 'employee'), (req, res) => {
  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'paid'    THEN total ELSE 0 END) as collected,
      SUM(CASE WHEN status = 'pending' THEN total ELSE 0 END) as outstanding,
      SUM(CASE WHEN status = 'overdue' THEN total ELSE 0 END) as overdue,
      COUNT(*) as total_invoices,
      COUNT(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN 1 END) as this_month_count,
      SUM(CASE WHEN strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now') THEN total ELSE 0 END) as this_month_total
    FROM invoices WHERE status != 'cancelled'
  `).get();
  res.json({ success: true, stats });
});

// ── POST /api/invoices ───────────────────────────────────────────
router.post('/', requireRole('admin', 'employee'), (req, res) => {
  const { client_id, items, tax_rate = 18, currency = 'INR', due_date, notes } = req.body;

  if (!client_id || !items || !items.length) {
    return res.status(400).json({ success: false, message: 'Client and at least one item are required.' });
  }

  const subtotal   = items.reduce((sum, item) => sum + (item.qty * item.rate), 0);
  const tax_amount = (subtotal * tax_rate) / 100;
  const total      = subtotal + tax_amount;
  const inv_number = generateInvoiceNumber();

  const result = db.prepare(`
    INSERT INTO invoices (invoice_number, client_id, created_by, items, subtotal, tax_rate, tax_amount, total, currency, due_date, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(inv_number, client_id, req.user.id, JSON.stringify(items), subtotal, tax_rate, tax_amount, total, currency, due_date || null, notes || null);

  res.status(201).json({
    success: true,
    message: 'Invoice created.',
    invoiceId: result.lastInsertRowid,
    invoiceNumber: inv_number,
    total
  });
});

// ── PUT /api/invoices/:id ────────────────────────────────────────
router.put('/:id', requireRole('admin', 'employee'), (req, res) => {
  const { status, paid_date, notes } = req.body;
  db.prepare(`
    UPDATE invoices SET
      status     = COALESCE(?, status),
      paid_date  = COALESCE(?, paid_date),
      notes      = COALESCE(?, notes),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, paid_date || null, notes, req.params.id);
  res.json({ success: true, message: 'Invoice updated.' });
});

// ── GET /api/invoices/:id/pdf ────────────────────────────────────
router.get('/:id/pdf', (req, res) => {
  const inv = db.prepare(`
    SELECT i.*, c.name as client_name, c.email as client_email,
           c.address as client_address, c.gstin as client_gstin
    FROM invoices i
    LEFT JOIN clients c ON i.client_id = c.id
    WHERE i.id = ?
  `).get(req.params.id);

  if (!inv) return res.status(404).json({ success: false, message: 'Invoice not found.' });

  const items = JSON.parse(inv.items);
  const doc   = new PDFDoc({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${inv.invoice_number}.pdf"`);
  doc.pipe(res);

  // ── HEADER ──
  doc.rect(0, 0, 595, 90).fill('#0d1b2a');
  doc.fontSize(24).font('Helvetica-Bold').fillColor('#c8a951').text('GS ADVISORY', 50, 28);
  doc.fontSize(9).font('Helvetica').fillColor('rgba(255,255,255,0.7)').text('Tax · Finance · Compliance · Advisory', 50, 56);
  doc.fontSize(9).fillColor('#c8a951').text('admin@gsadvisory.in  |  gsadvisory.in', 50, 70);

  // ── INVOICE TITLE ──
  doc.fillColor('#0d1b2a').fontSize(20).font('Helvetica-Bold').text('INVOICE', 400, 28, { align: 'right', width: 145 });
  doc.fontSize(10).font('Helvetica').fillColor('#64748b').text(`#${inv.invoice_number}`, 400, 54, { align: 'right', width: 145 });

  // ── BILL TO ──
  doc.moveDown(3);
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#94a3b8').text('BILL TO', 50, 115);
  doc.fontSize(13).font('Helvetica-Bold').fillColor('#0d1b2a').text(inv.client_name, 50, 130);
  if (inv.client_gstin) doc.fontSize(9).font('Helvetica').fillColor('#64748b').text(`GSTIN: ${inv.client_gstin}`, 50, 148);
  if (inv.client_address) doc.fontSize(9).fillColor('#64748b').text(inv.client_address, 50, 162);

  // ── DATES ──
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#94a3b8').text('DATE', 400, 115);
  doc.fontSize(10).font('Helvetica').fillColor('#0d1b2a').text(new Date(inv.created_at).toLocaleDateString('en-IN'), 400, 130);
  if (inv.due_date) {
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#94a3b8').text('DUE DATE', 400, 148);
    doc.fontSize(10).font('Helvetica').fillColor('#ef4444').text(new Date(inv.due_date).toLocaleDateString('en-IN'), 400, 163);
  }

  // ── DIVIDER ──
  doc.moveTo(50, 195).lineTo(545, 195).strokeColor('#c8a951').lineWidth(2).stroke();

  // ── TABLE HEADER ──
  doc.rect(50, 205, 495, 28).fill('#0d1b2a');
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#c8a951')
    .text('DESCRIPTION', 60, 214)
    .text('QTY', 320, 214, { width: 50, align: 'center' })
    .text('RATE', 380, 214, { width: 70, align: 'right' })
    .text('AMOUNT', 460, 214, { width: 80, align: 'right' });

  // ── TABLE ROWS ──
  let y = 245;
  items.forEach((item, i) => {
    if (i % 2 === 0) doc.rect(50, y - 8, 495, 24).fill('#f8f9fc');
    doc.fontSize(10).font('Helvetica').fillColor('#0d1b2a').text(item.description, 60, y, { width: 250 });
    doc.text(String(item.qty), 320, y, { width: 50, align: 'center' });
    doc.text(`₹${Number(item.rate).toLocaleString('en-IN')}`, 380, y, { width: 70, align: 'right' });
    doc.font('Helvetica-Bold').text(`₹${(item.qty * item.rate).toLocaleString('en-IN')}`, 460, y, { width: 80, align: 'right' });
    y += 28;
  });

  // ── TOTALS ──
  y += 10;
  doc.moveTo(350, y).lineTo(545, y).strokeColor('#e2e8f0').lineWidth(1).stroke();
  y += 12;
  doc.fontSize(10).font('Helvetica').fillColor('#64748b').text('Subtotal', 360, y).text(`₹${inv.subtotal.toLocaleString('en-IN')}`, 460, y, { width: 80, align: 'right' });
  y += 20;
  doc.text(`GST/Tax (${inv.tax_rate}%)`, 360, y).text(`₹${inv.tax_amount.toLocaleString('en-IN')}`, 460, y, { width: 80, align: 'right' });
  y += 10;
  doc.moveTo(350, y).lineTo(545, y).strokeColor('#c8a951').lineWidth(1.5).stroke();
  y += 12;
  doc.rect(350, y, 195, 32).fill('#0d1b2a');
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#c8a951').text('TOTAL', 360, y + 9);
  doc.fillColor('#fff').text(`₹${inv.total.toLocaleString('en-IN')}`, 460, y + 9, { width: 80, align: 'right' });

  // ── FOOTER ──
  doc.fontSize(8).font('Helvetica').fillColor('#94a3b8')
    .text('Be Wise, Take Our Advice — Thank you for your business.', 50, 750, { align: 'center', width: 495 });
  doc.moveTo(50, 760).lineTo(545, 760).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
  doc.fontSize(7).fillColor('#94a3b8').text('GS Advisory | admin@gsadvisory.in | gsadvisory.in', 50, 768, { align: 'center', width: 495 });

  doc.end();
});

// ── POST /api/invoices/:id/send ──────────────────────────────────
router.post('/:id/send', requireRole('admin', 'employee'), async (req, res) => {
  const inv = db.prepare(`
    SELECT i.*, c.name as client_name, c.email as client_email
    FROM invoices i LEFT JOIN clients c ON i.client_id = c.id WHERE i.id = ?
  `).get(req.params.id);

  if (!inv || !inv.client_email) {
    return res.status(400).json({ success: false, message: 'Invoice or client email not found.' });
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });

    await transporter.sendMail({
      from:    process.env.MAIL_FROM,
      to:      inv.client_email,
      subject: `Invoice ${inv.invoice_number} from GS Advisory — ₹${inv.total.toLocaleString('en-IN')}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
          <div style="background:#0d1b2a;padding:28px 32px;">
            <h2 style="color:#c8a951;margin:0;font-size:22px;">GS Advisory</h2>
            <p style="color:rgba(255,255,255,0.6);margin:6px 0 0;font-size:12px;font-style:italic;">Be Wise, Take Our Advice</p>
          </div>
          <div style="padding:32px;border:1px solid #e2e8f0;">
            <p style="color:#334155;font-size:15px;">Dear <strong>${inv.client_name}</strong>,</p>
            <p style="color:#64748b;">Please find your invoice <strong>${inv.invoice_number}</strong> for an amount of <strong>₹${inv.total.toLocaleString('en-IN')}</strong>.</p>
            ${inv.due_date ? `<p style="color:#ef4444;font-weight:bold;">Due Date: ${new Date(inv.due_date).toLocaleDateString('en-IN')}</p>` : ''}
            <p style="color:#64748b;">For queries, reply to this email or contact us at admin@gsadvisory.in</p>
            <p style="color:#64748b;margin-top:24px;">Warm regards,<br/><strong>GS Advisory Team</strong></p>
          </div>
        </div>
      `
    });

    db.prepare("UPDATE invoices SET status = 'pending', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ success: true, message: `Invoice sent to ${inv.client_email}` });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Failed to send email.', error: err.message });
  }
});

module.exports = router;
