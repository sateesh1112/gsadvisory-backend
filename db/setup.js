const Database = require('better-sqlite3');
const path     = require('path');

const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, '..');
const DB_PATH  = path.join(DATA_DIR, 'gsadvisory.db');
const db       = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  // ── MIGRATIONS: add columns safely if they don't exist ──────────
  try {
    db.exec(`ALTER TABLE users ADD COLUMN department TEXT`);
  } catch(e) { /* column already exists — ignore */ }
  try {
    db.exec(`ALTER TABLE users ADD COLUMN qualification TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE users ADD COLUMN address TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN services TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN notes TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE clients ADD COLUMN assigned_to INTEGER`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE compliance_calendar ADD COLUMN applicable_to TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE compliance_calendar ADD COLUMN filed_date TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN reminder_date TEXT`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN is_recurring INTEGER DEFAULT 0`);
  } catch(e) {}
  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN recurrence TEXT`);
  } catch(e) {}

  db.exec(`
    -- USERS
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      email       TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      role        TEXT    NOT NULL CHECK(role IN ('admin','employee','client')),
      phone       TEXT,
      designation TEXT,
      department  TEXT,
      is_active   INTEGER DEFAULT 1,
      last_login  TEXT,
      created_at  TEXT    DEFAULT (datetime('now')),
      updated_at  TEXT    DEFAULT (datetime('now'))
    );

    -- CLIENTS
    CREATE TABLE IF NOT EXISTS clients (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      email        TEXT,
      phone        TEXT,
      entity_type  TEXT,
      pan          TEXT,
      gstin        TEXT,
      tan          TEXT,
      address      TEXT,
      city         TEXT,
      state        TEXT,
      country      TEXT    DEFAULT 'India',
      services     TEXT    DEFAULT '[]',
      status       TEXT    DEFAULT 'active',
      assigned_to  INTEGER REFERENCES users(id),
      user_id      INTEGER REFERENCES users(id),
      notes        TEXT,
      created_at   TEXT    DEFAULT (datetime('now')),
      updated_at   TEXT    DEFAULT (datetime('now'))
    );

    -- TASKS
    CREATE TABLE IF NOT EXISTS tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      description   TEXT,
      client_id     INTEGER REFERENCES clients(id),
      assigned_to   INTEGER REFERENCES users(id),
      assigned_by   INTEGER REFERENCES users(id),
      created_by    INTEGER REFERENCES users(id),
      category      TEXT,
      priority      TEXT    DEFAULT 'medium',
      status        TEXT    DEFAULT 'pending',
      due_date      TEXT,
      reminder_date TEXT,
      completed_at  TEXT,
      notes         TEXT,
      is_recurring  INTEGER DEFAULT 0,
      recurrence    TEXT,
      parent_task_id INTEGER REFERENCES tasks(id),
      created_at    TEXT    DEFAULT (datetime('now')),
      updated_at    TEXT    DEFAULT (datetime('now'))
    );

    -- TASK HISTORY (audit trail)
    CREATE TABLE IF NOT EXISTS task_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER REFERENCES tasks(id),
      user_id    INTEGER REFERENCES users(id),
      action     TEXT    NOT NULL,
      old_value  TEXT,
      new_value  TEXT,
      comment    TEXT,
      created_at TEXT    DEFAULT (datetime('now'))
    );

    -- TASK COMMENTS
    CREATE TABLE IF NOT EXISTS task_comments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER REFERENCES tasks(id),
      user_id    INTEGER REFERENCES users(id),
      comment    TEXT    NOT NULL,
      created_at TEXT    DEFAULT (datetime('now'))
    );

    -- COMPLIANCE CALENDAR
    CREATE TABLE IF NOT EXISTS compliance_calendar (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      type         TEXT    NOT NULL,
      due_date     TEXT    NOT NULL,
      period       TEXT,
      applicable_to TEXT   DEFAULT 'all',
      client_id    INTEGER REFERENCES clients(id),
      task_id      INTEGER REFERENCES tasks(id),
      status       TEXT    DEFAULT 'upcoming',
      reminder_sent INTEGER DEFAULT 0,
      notes        TEXT,
      created_by   INTEGER REFERENCES users(id),
      created_at   TEXT    DEFAULT (datetime('now'))
    );

    -- INVOICES
    CREATE TABLE IF NOT EXISTS invoices (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT    NOT NULL UNIQUE,
      client_id      INTEGER REFERENCES clients(id),
      created_by     INTEGER REFERENCES users(id),
      items          TEXT    NOT NULL DEFAULT '[]',
      subtotal       REAL    DEFAULT 0,
      tax_rate       REAL    DEFAULT 18,
      tax_amount     REAL    DEFAULT 0,
      total          REAL    DEFAULT 0,
      currency       TEXT    DEFAULT 'INR',
      status         TEXT    DEFAULT 'draft',
      due_date       TEXT,
      paid_date      TEXT,
      notes          TEXT,
      pdf_path       TEXT,
      created_at     TEXT    DEFAULT (datetime('now')),
      updated_at     TEXT    DEFAULT (datetime('now'))
    );

    -- DOCUMENTS
    CREATE TABLE IF NOT EXISTS documents (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id     INTEGER REFERENCES clients(id),
      task_id       INTEGER REFERENCES tasks(id),
      uploaded_by   INTEGER REFERENCES users(id),
      name          TEXT    NOT NULL,
      original_name TEXT    NOT NULL,
      file_path     TEXT    NOT NULL,
      file_size     INTEGER,
      mime_type     TEXT,
      category      TEXT    DEFAULT 'general',
      description   TEXT,
      is_shared     INTEGER DEFAULT 0,
      created_at    TEXT    DEFAULT (datetime('now'))
    );

    -- CONTACT INQUIRIES
    CREATE TABLE IF NOT EXISTS inquiries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      email      TEXT    NOT NULL,
      phone      TEXT,
      company    TEXT,
      service    TEXT,
      message    TEXT    NOT NULL,
      status     TEXT    DEFAULT 'new',
      created_at TEXT    DEFAULT (datetime('now'))
    );

    -- REMINDERS LOG
    CREATE TABLE IF NOT EXISTS reminders (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      type         TEXT    NOT NULL,
      recipient_id INTEGER REFERENCES users(id),
      client_id    INTEGER REFERENCES clients(id),
      task_id      INTEGER REFERENCES tasks(id),
      subject      TEXT    NOT NULL,
      message      TEXT,
      sent_to      TEXT,
      status       TEXT    DEFAULT 'pending',
      scheduled_at TEXT,
      sent_at      TEXT,
      created_at   TEXT    DEFAULT (datetime('now'))
    );

    -- BILLABLE HOURS
    CREATE TABLE IF NOT EXISTS billable_hours (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER REFERENCES tasks(id),
      client_id   INTEGER REFERENCES clients(id),
      user_id     INTEGER REFERENCES users(id),
      hours       REAL    NOT NULL,
      rate        REAL    DEFAULT 0,
      description TEXT,
      date        TEXT    DEFAULT (date('now')),
      is_billed   INTEGER DEFAULT 0,
      invoice_id  INTEGER REFERENCES invoices(id),
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  
    -- REGULATORY UPDATES (RSS feeds)
    CREATE TABLE IF NOT EXISTS regulatory_updates (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      title         TEXT    NOT NULL,
      summary       TEXT,
      plain_summary TEXT,
      link          TEXT,
      source        TEXT    NOT NULL,
      category      TEXT,
      tag           TEXT,
      urgency       TEXT    DEFAULT 'Medium',
      pub_date      TEXT,
      content_hash  TEXT    UNIQUE NOT NULL,
      feed_name     TEXT,
      is_read       INTEGER DEFAULT 0,
      created_at    TEXT    DEFAULT (datetime('now'))
    );

    -- SYSTEM SETTINGS
    CREATE TABLE IF NOT EXISTS system_settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
`);
  console.log('✅ Database initialized');
}

module.exports = { db, initDB };
