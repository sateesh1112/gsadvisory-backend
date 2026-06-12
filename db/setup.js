const Database = require('better-sqlite3');
const path = require('path');

// Use /data on Render (persistent disk), fallback to local for development
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/data' : path.join(__dirname, '..');
const DB_PATH  = path.join(DATA_DIR, 'gsadvisory.db');
const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDB() {
  db.exec(`
    -- USERS TABLE (employees + clients)
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT    NOT NULL,
      email       TEXT    NOT NULL UNIQUE,
      password    TEXT    NOT NULL,
      role        TEXT    NOT NULL CHECK(role IN ('admin','employee','client')),
      phone       TEXT,
      designation TEXT,
      is_active   INTEGER DEFAULT 1,
      created_at  TEXT    DEFAULT (datetime('now')),
      updated_at  TEXT    DEFAULT (datetime('now'))
    );

    -- CLIENTS TABLE
    CREATE TABLE IF NOT EXISTS clients (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      name         TEXT    NOT NULL,
      email        TEXT,
      phone        TEXT,
      entity_type  TEXT,
      pan          TEXT,
      gstin        TEXT,
      address      TEXT,
      city         TEXT,
      country      TEXT    DEFAULT 'India',
      services     TEXT,
      status       TEXT    DEFAULT 'active',
      assigned_to  INTEGER REFERENCES users(id),
      user_id      INTEGER REFERENCES users(id),
      created_at   TEXT    DEFAULT (datetime('now')),
      updated_at   TEXT    DEFAULT (datetime('now'))
    );

    -- TASKS TABLE
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      description  TEXT,
      client_id    INTEGER REFERENCES clients(id),
      assigned_to  INTEGER REFERENCES users(id),
      created_by   INTEGER REFERENCES users(id),
      category     TEXT,
      priority     TEXT    DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      status       TEXT    DEFAULT 'pending' CHECK(status IN ('pending','in_progress','in_review','completed','cancelled')),
      due_date     TEXT,
      completed_at TEXT,
      notes        TEXT,
      created_at   TEXT    DEFAULT (datetime('now')),
      updated_at   TEXT    DEFAULT (datetime('now'))
    );

    -- INVOICES TABLE
    CREATE TABLE IF NOT EXISTS invoices (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT    NOT NULL UNIQUE,
      client_id      INTEGER REFERENCES clients(id),
      created_by     INTEGER REFERENCES users(id),
      items          TEXT    NOT NULL,
      subtotal       REAL    NOT NULL,
      tax_rate       REAL    DEFAULT 18,
      tax_amount     REAL    NOT NULL,
      total          REAL    NOT NULL,
      currency       TEXT    DEFAULT 'INR',
      status         TEXT    DEFAULT 'pending' CHECK(status IN ('draft','pending','paid','overdue','cancelled')),
      due_date       TEXT,
      paid_date      TEXT,
      notes          TEXT,
      pdf_path       TEXT,
      created_at     TEXT    DEFAULT (datetime('now')),
      updated_at     TEXT    DEFAULT (datetime('now'))
    );

    -- DOCUMENTS TABLE
    CREATE TABLE IF NOT EXISTS documents (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id),
      uploaded_by INTEGER REFERENCES users(id),
      name        TEXT    NOT NULL,
      original_name TEXT  NOT NULL,
      file_path   TEXT    NOT NULL,
      file_size   INTEGER,
      mime_type   TEXT,
      category    TEXT,
      description TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );

    -- CONTACT INQUIRIES TABLE
    CREATE TABLE IF NOT EXISTS inquiries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL,
      email      TEXT    NOT NULL,
      phone      TEXT,
      company    TEXT,
      service    TEXT,
      message    TEXT    NOT NULL,
      status     TEXT    DEFAULT 'new' CHECK(status IN ('new','read','replied','closed')),
      created_at TEXT    DEFAULT (datetime('now'))
    );

    -- COMPLIANCE TABLE
    CREATE TABLE IF NOT EXISTS compliance (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER REFERENCES clients(id),
      task_id     INTEGER REFERENCES tasks(id),
      type        TEXT    NOT NULL,
      period      TEXT,
      due_date    TEXT    NOT NULL,
      filed_date  TEXT,
      status      TEXT    DEFAULT 'upcoming',
      notes       TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
  `);

  console.log('✅ Database tables initialized');
}

module.exports = { db, initDB };
