const cron       = require('node-cron');
const nodemailer = require('nodemailer');
const { db }     = require('../db/setup');

// ── EMAIL TRANSPORTER ─────────────────────────────────────────────
function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
  });
}

// ── SEND EMAIL HELPER ─────────────────────────────────────────────
async function sendReminderEmail(to, subject, html) {
  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: process.env.MAIL_FROM || 'GS Advisory <admin@gsadvisory.in>',
      to, subject, html
    });
    return true;
  } catch (err) {
    console.error('Email error:', err.message);
    return false;
  }
}

// ── EMAIL TEMPLATE ────────────────────────────────────────────────
function emailTemplate(title, body, ctaText, ctaColor = '#0d1b2a') {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;">
      <div style="background:#0d1b2a;padding:24px 32px;">
        <h2 style="color:#c8a951;margin:0;font-size:20px;">GS Advisory</h2>
        <p style="color:rgba(255,255,255,0.5);margin:4px 0 0;font-size:11px;font-style:italic;">Be Wise, Take Our Advice</p>
      </div>
      <div style="padding:28px 32px;border:1px solid #e2e8f0;border-top:none;">
        <h3 style="color:#0d1b2a;margin:0 0 16px;">${title}</h3>
        ${body}
        <div style="margin-top:24px;padding-top:20px;border-top:1px solid #e2e8f0;font-size:12px;color:#94a3b8;">
          <p>GS Advisory | admin@gsadvisory.in | gsadvisory.in</p>
          <p>+971 52 725 1804 (UAE) | +91 99857 52173 (India)</p>
        </div>
      </div>
    </div>
  `;
}

// ── LOG REMINDER ──────────────────────────────────────────────────
function logReminder(type, subject, sentTo, status, clientId = null, taskId = null) {
  db.prepare(`
    INSERT INTO reminders (type, subject, sent_to, status, sent_at, client_id, task_id)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
  `).run(type, subject, sentTo, status, clientId, taskId);
}

// ══════════════════════════════════════════════════════════════════
// CRON JOB 1: Daily compliance reminders — runs every day at 8AM
// ══════════════════════════════════════════════════════════════════
async function runComplianceReminders() {
  console.log('⏰ Running compliance reminders...');

  // Get compliance due in next 3 days
  const urgent = db.prepare(`
    SELECT cc.*, c.name as client_name, c.email as client_email,
           u.email as assignee_email, u.name as assignee_name
    FROM compliance_calendar cc
    LEFT JOIN clients c ON cc.client_id = c.id
    LEFT JOIN users   u ON c.assigned_to = u.id
    WHERE cc.due_date BETWEEN date('now') AND date('now','+3 days')
      AND cc.status NOT IN ('filed','completed')
      AND cc.reminder_sent < 1
  `).all();

  // Get compliance due in next 7 days
  const upcoming = db.prepare(`
    SELECT cc.*, c.name as client_name, c.email as client_email,
           u.email as assignee_email, u.name as assignee_name
    FROM compliance_calendar cc
    LEFT JOIN clients c ON cc.client_id = c.id
    LEFT JOIN users   u ON c.assigned_to = u.id
    WHERE cc.due_date BETWEEN date('now','+4 days') AND date('now','+7 days')
      AND cc.status NOT IN ('filed','completed')
      AND cc.reminder_sent < 1
  `).all();

  // Send urgent reminders to assigned employees
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@gsadvisory.in';

  if (urgent.length > 0) {
    const urgentList = urgent.map(e =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#0d1b2a;">${e.title}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#64748b;">${e.client_name || 'General'}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#ef4444;font-weight:700;">${e.due_date}</td>
      </tr>`
    ).join('');

    const html = emailTemplate(
      '🚨 Urgent: Compliance Due in 3 Days',
      `<p style="color:#64748b;">The following compliance tasks are due within 3 days and require immediate attention:</p>
       <table style="width:100%;border-collapse:collapse;margin:16px 0;">
         <thead><tr>
           <th style="padding:8px;background:#f8f9fc;text-align:left;font-size:12px;color:#94a3b8;letter-spacing:1px;">TASK</th>
           <th style="padding:8px;background:#f8f9fc;text-align:left;font-size:12px;color:#94a3b8;">CLIENT</th>
           <th style="padding:8px;background:#f8f9fc;text-align:left;font-size:12px;color:#94a3b8;">DUE DATE</th>
         </tr></thead>
         <tbody>${urgentList}</tbody>
       </table>`
    );

    const sent = await sendReminderEmail(adminEmail, `🚨 ${urgent.length} Compliance Tasks Due in 3 Days`, html);
    if (sent) {
      urgent.forEach(e => {
        db.prepare('UPDATE compliance_calendar SET reminder_sent = 1 WHERE id = ?').run(e.id);
        logReminder('compliance_urgent', `Urgent: ${e.title}`, adminEmail, 'sent', e.client_id, null);
      });
      console.log(`✅ Sent urgent reminder: ${urgent.length} items`);
    }
  }

  // Send 7-day advance reminders
  if (upcoming.length > 0 && upcoming.length !== urgent.length) {
    const upcomingList = upcoming.map(e =>
      `<li style="padding:6px 0;border-bottom:1px solid #f1f5f9;"><strong>${e.title}</strong> — ${e.client_name || 'General'} — Due: <span style="color:#f97316;">${e.due_date}</span></li>`
    ).join('');

    const html = emailTemplate(
      '📅 Compliance Due Next Week',
      `<p style="color:#64748b;">Upcoming compliance tasks for next week — plan ahead:</p>
       <ul style="padding:0;list-style:none;margin:16px 0;">${upcomingList}</ul>`
    );

    const sent = await sendReminderEmail(adminEmail, `📅 ${upcoming.length} Compliance Tasks Due Next Week`, html);
    if (sent) {
      upcoming.forEach(e => {
        db.prepare('UPDATE compliance_calendar SET reminder_sent = 1 WHERE id = ?').run(e.id);
        logReminder('compliance_upcoming', `Upcoming: ${e.title}`, adminEmail, 'sent', e.client_id, null);
      });
      console.log(`✅ Sent upcoming reminder: ${upcoming.length} items`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// CRON JOB 2: Task due date reminders — runs every day at 9AM
// ══════════════════════════════════════════════════════════════════
async function runTaskReminders() {
  console.log('⏰ Running task reminders...');

  // Overdue tasks
  const overdue = db.prepare(`
    SELECT t.*, c.name as client_name, u.email as assignee_email, u.name as assignee_name
    FROM tasks t
    LEFT JOIN clients c ON t.client_id   = c.id
    LEFT JOIN users   u ON t.assigned_to = u.id
    WHERE t.due_date < date('now')
      AND t.status NOT IN ('completed','cancelled')
      AND u.email IS NOT NULL
  `).all();

  // Group by assignee and send one email per person
  const byAssignee = {};
  overdue.forEach(t => {
    if (!byAssignee[t.assignee_email]) byAssignee[t.assignee_email] = { name: t.assignee_name, tasks: [] };
    byAssignee[t.assignee_email].tasks.push(t);
  });

  for (const [email, data] of Object.entries(byAssignee)) {
    const taskList = data.tasks.map(t =>
      `<tr>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;font-weight:600;color:#0d1b2a;">${t.title}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#64748b;">${t.client_name || '—'}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;color:#ef4444;font-weight:700;">${t.due_date}</td>
        <td style="padding:8px;border-bottom:1px solid #f1f5f9;"><span style="padding:2px 8px;background:rgba(249,115,22,0.1);color:#f97316;border-radius:100px;font-size:11px;">${t.priority}</span></td>
      </tr>`
    ).join('');

    const html = emailTemplate(
      `⚠️ You have ${data.tasks.length} overdue task(s)`,
      `<p style="color:#64748b;">Dear <strong>${data.name}</strong>, the following tasks are overdue and need your immediate attention:</p>
       <table style="width:100%;border-collapse:collapse;margin:16px 0;">
         <thead><tr>
           <th style="padding:8px;background:#f8f9fc;text-align:left;font-size:11px;color:#94a3b8;letter-spacing:1px;">TASK</th>
           <th style="padding:8px;background:#f8f9fc;text-align:left;font-size:11px;color:#94a3b8;">CLIENT</th>
           <th style="padding:8px;background:#f8f9fc;text-align:left;font-size:11px;color:#94a3b8;">DUE DATE</th>
           <th style="padding:8px;background:#f8f9fc;text-align:left;font-size:11px;color:#94a3b8;">PRIORITY</th>
         </tr></thead>
         <tbody>${taskList}</tbody>
       </table>
       <p style="color:#64748b;">Please update the task status on the portal as soon as possible.</p>`
    );

    const sent = await sendReminderEmail(email, `⚠️ ${data.tasks.length} Overdue Task(s) — GS Advisory`, html);
    if (sent) {
      data.tasks.forEach(t => logReminder('task_overdue', `Overdue: ${t.title}`, email, 'sent', t.client_id, t.id));
      console.log(`✅ Overdue reminder sent to ${email}: ${data.tasks.length} tasks`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// CRON JOB 3: Invoice payment reminders — runs every Monday at 10AM
// ══════════════════════════════════════════════════════════════════
async function runInvoiceReminders() {
  console.log('⏰ Running invoice reminders...');

  const overdue = db.prepare(`
    SELECT i.*, c.name as client_name, c.email as client_email
    FROM invoices i
    LEFT JOIN clients c ON i.client_id = c.id
    WHERE i.status IN ('pending','overdue')
      AND i.due_date < date('now')
      AND c.email IS NOT NULL
  `).all();

  // Update status to overdue
  db.prepare("UPDATE invoices SET status = 'overdue' WHERE status = 'pending' AND due_date < date('now')").run();

  for (const inv of overdue) {
    const daysOverdue = Math.floor((new Date() - new Date(inv.due_date)) / (1000 * 60 * 60 * 24));

    const html = emailTemplate(
      `Payment Reminder — Invoice ${inv.invoice_number}`,
      `<p style="color:#64748b;">Dear <strong>${inv.client_name}</strong>,</p>
       <p style="color:#64748b;">This is a gentle reminder that the following invoice is overdue:</p>
       <div style="background:#f8f9fc;border-left:4px solid #ef4444;padding:16px 20px;border-radius:4px;margin:16px 0;">
         <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
           <span style="color:#94a3b8;font-size:13px;">Invoice Number</span>
           <strong style="color:#0d1b2a;">${inv.invoice_number}</strong>
         </div>
         <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
           <span style="color:#94a3b8;font-size:13px;">Amount Due</span>
           <strong style="color:#0d1b2a;font-size:18px;">₹${inv.total.toLocaleString('en-IN')}</strong>
         </div>
         <div style="display:flex;justify-content:space-between;">
           <span style="color:#94a3b8;font-size:13px;">Overdue By</span>
           <strong style="color:#ef4444;">${daysOverdue} days</strong>
         </div>
       </div>
       <p style="color:#64748b;">Please arrange payment at the earliest or contact us if you have any queries.</p>`,
      'Pay Now'
    );

    const sent = await sendReminderEmail(inv.client_email, `Payment Reminder: Invoice ${inv.invoice_number} — ₹${inv.total.toLocaleString('en-IN')} Overdue`, html);
    if (sent) {
      logReminder('invoice_payment', `Invoice ${inv.invoice_number} payment due`, inv.client_email, 'sent', inv.client_id, null);
      console.log(`✅ Invoice reminder sent to ${inv.client_email}: ${inv.invoice_number}`);
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// MANUAL REMINDER TRIGGER — API callable
// ══════════════════════════════════════════════════════════════════
async function sendManualReminder({ to, subject, body, type, client_id, task_id }) {
  const html = emailTemplate(subject, `<p style="color:#64748b;line-height:1.7;">${body}</p>`);
  const sent = await sendReminderEmail(to, subject, html);
  logReminder(type || 'manual', subject, to, sent ? 'sent' : 'failed', client_id || null, task_id || null);
  return sent;
}

// ══════════════════════════════════════════════════════════════════
// SCHEDULE ALL CRON JOBS
// ══════════════════════════════════════════════════════════════════
function startScheduler() {
  // Daily at 8:00 AM — compliance reminders
  cron.schedule('0 8 * * *', runComplianceReminders, { timezone: 'Asia/Dubai' });

  // Daily at 9:00 AM — task overdue reminders
  cron.schedule('0 9 * * *', runTaskReminders, { timezone: 'Asia/Dubai' });

  // Every Monday at 10:00 AM — invoice payment reminders
  cron.schedule('0 10 * * 1', runInvoiceReminders, { timezone: 'Asia/Dubai' });

  console.log('✅ Automated reminder scheduler started (Dubai timezone)');
  console.log('   📅 Compliance reminders: Daily 8:00 AM');
  console.log('   ✅ Task reminders:        Daily 9:00 AM');
  console.log('   💰 Invoice reminders:     Every Monday 10:00 AM');
}

module.exports = {
  startScheduler,
  sendManualReminder,
  runComplianceReminders,
  runTaskReminders,
  runInvoiceReminders
};
