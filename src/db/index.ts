import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Db = Database.Database;

// Each entry runs once, in order. Never edit a shipped migration; append a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE claims (
    item_id TEXT PRIMARY KEY,
    claim_number TEXT NOT NULL UNIQUE,
    seq INTEGER NOT NULL UNIQUE,
    claimant_name TEXT NOT NULL DEFAULT '',
    first_name TEXT NOT NULL DEFAULT '',
    email TEXT,
    phone TEXT,
    sms_opt_in INTEGER NOT NULL DEFAULT 0,
    -- Claimant texted STOP; HighLevel blocks SMS until they text START.
    sms_opted_out INTEGER NOT NULL DEFAULT 0,
    status_key TEXT,
    status_label TEXT,
    amount_claimed REAL,
    settlement_amount REAL,
    highlevel_contact_id TEXT,
    token_version INTEGER NOT NULL DEFAULT 1,
    token_hash TEXT NOT NULL UNIQUE,
    settlement_sent_at TEXT,
    settlement_document_id TEXT,
    settlement_reference_id TEXT,
    -- Amount on the document actually sent, so a signature on a superseded amount is caught.
    settlement_amount_sent REAL,
    settlement_signed_at TEXT,
    payment_details_received_at TEXT,
    received_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX claims_email ON claims(lower(email));
  CREATE INDEX claims_contact ON claims(highlevel_contact_id);
  CREATE INDEX claims_settlement_doc ON claims(settlement_document_id);

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES claims(item_id),
    direction TEXT NOT NULL,
    channel TEXT NOT NULL,
    body TEXT NOT NULL,
    monday_update_id TEXT UNIQUE,
    highlevel_message_id TEXT UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_item ON messages(item_id, id);

  CREATE TABLE files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES claims(item_id),
    source TEXT NOT NULL,
    column_id TEXT,
    monday_asset_id TEXT UNIQUE,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    storage_key TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX files_item ON files(item_id, id);

  -- A browser that has proven it can read the claim's email, by one-time code.
  CREATE TABLE devices (
    device_hash TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES claims(item_id),
    token_version INTEGER NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (device_hash, item_id)
  );

  CREATE TABLE login_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES claims(item_id),
    -- Ties the code to the browser that requested it.
    device_hash TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX login_codes_item ON login_codes(item_id, created_at);

  CREATE TABLE templates (
    key TEXT PRIMARY KEY,
    email_subject TEXT NOT NULL,
    email_body TEXT NOT NULL,
    sms TEXT NOT NULL,
    portal_text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    updated_by TEXT
  );

  -- Webhook deliveries already processed, for idempotency.
  CREATE TABLE processed_events (
    event_key TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    dedupe_key TEXT UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | dead
    attempts INTEGER NOT NULL DEFAULT 0,
    run_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(status, run_at);

  CREATE TABLE claim_number_seq (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last INTEGER NOT NULL
  );
  INSERT INTO claim_number_seq (id, last) VALUES (1, 0);
  `,
  `
  -- Rate-limit bookkeeping for unauthenticated portal actions ("find my claim").
  -- subject_hash is an HMAC of the subject (an email address), never the value itself.
  CREATE TABLE auth_rate_events (
    kind TEXT NOT NULL,
    subject_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX auth_rate_events_lookup ON auth_rate_events(kind, subject_hash, created_at);
  CREATE INDEX login_codes_device ON login_codes(item_id, device_hash, id);
  `,
];

export function openDb(dataDir: string): Db {
  const path = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'hdc.sqlite');
  if (dataDir !== ':memory:') mkdirSync(dataDir, { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
  for (; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.prepare('UPDATE schema_version SET version = ?').run(version + 1);
    })();
  }
}

export const nowIso = (): string => new Date().toISOString();
