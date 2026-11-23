-- PpFeez schema v1 — copied verbatim from docs/SPEC.md section 3.

-- إعدادات عامة (مفتاح/قيمة)
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- المفاتيح: lock_enabled, lock_hash, backup_dir, backup_on_close, backup_keep,
--           theme (dark|light|system), default_commission_bps,
--           fee_estimate_bps, fee_estimate_fixed_minor, fee_estimate_enabled

CREATE TABLE mailboxes (
  id             INTEGER PRIMARY KEY,
  label          TEXT NOT NULL,                 -- "حساب PayPal الأول"
  email          TEXT NOT NULL UNIQUE,
  host           TEXT NOT NULL DEFAULT 'imap.gmail.com',
  port           INTEGER NOT NULL DEFAULT 993,
  folder         TEXT NOT NULL DEFAULT '[Gmail]/All Mail',
  uid_validity   INTEGER,
  last_uid       INTEGER NOT NULL DEFAULT 0,
  last_pulled_at TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL
);  -- كلمة المرور في Credential Manager بمفتاح "ppfeez:mailbox:{id}"

CREATE TABLE pull_runs (
  id                     INTEGER PRIMARY KEY,
  mailbox_id             INTEGER NOT NULL REFERENCES mailboxes(id),
  status                 TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
  total_count            INTEGER NOT NULL DEFAULT 0,   -- رسائل مطابقة للبحث
  fetched_count          INTEGER NOT NULL DEFAULT 0,
  new_transactions_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count        INTEGER NOT NULL DEFAULT 0,
  ignored_count          INTEGER NOT NULL DEFAULT 0,
  failed_count           INTEGER NOT NULL DEFAULT 0,
  error                  TEXT,
  started_at             TEXT NOT NULL,
  finished_at            TEXT
);

CREATE TABLE raw_emails (
  id            INTEGER PRIMARY KEY,
  mailbox_id    INTEGER NOT NULL REFERENCES mailboxes(id),
  imap_uid      INTEGER NOT NULL,
  message_id    TEXT NOT NULL UNIQUE,           -- ترويسة Message-ID
  from_addr     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  auth_results  TEXT,                           -- ترويسة Authentication-Results
  body_html     TEXT,
  body_text     TEXT,
  parse_status  TEXT NOT NULL CHECK (parse_status IN ('parsed','failed','ignored')),
  parse_reason  TEXT,   -- سبب الفشل/التجاهل: not_paypal_sender, dkim_fail, not_transactional, no_parser_matched, ...
  parser_name   TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_raw_emails_status ON raw_emails(parse_status, received_at);

CREATE TABLE customers (
  id                     INTEGER PRIMARY KEY,
  name                   TEXT NOT NULL UNIQUE,
  phone                  TEXT,
  default_commission_bps INTEGER NOT NULL DEFAULT 2500 CHECK (default_commission_bps BETWEEN 0 AND 10000),
  notes                  TEXT,
  is_active              INTEGER NOT NULL DEFAULT 1,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE paypal_transactions (
  id                     INTEGER PRIMARY KEY,
  mailbox_id             INTEGER REFERENCES mailboxes(id),
  raw_email_id           INTEGER REFERENCES raw_emails(id),
  source                 TEXT NOT NULL CHECK (source IN ('email','manual')),
  paypal_txn_id          TEXT NOT NULL UNIQUE,   -- للإدخال اليدوي بلا رقم: "MANUAL-{uuid}"
  related_txn_id         TEXT,                   -- للاسترداد/العكس: رقم المعاملة الأصلية
  type                   TEXT NOT NULL CHECK (type IN ('payment','refund','reversal')),
  payer_name             TEXT,
  payer_email            TEXT,
  payer_note             TEXT,                   -- الرسالة التي كتبها المرسل (تساعد في معرفة العميل)
  currency               TEXT NOT NULL CHECK (length(currency) = 3),
  gross_minor            INTEGER NOT NULL CHECK (gross_minor > 0),
  fee_minor              INTEGER CHECK (fee_minor IS NULL OR fee_minor >= 0),
  net_minor              INTEGER CHECK (net_minor IS NULL OR net_minor >= 0),
  fee_is_estimated       INTEGER NOT NULL DEFAULT 0,
  occurred_at            TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'unassigned'
                         CHECK (status IN ('unassigned','pending_approval','approved','excluded')),
  customer_id            INTEGER REFERENCES customers(id),
  commission_mode        TEXT CHECK (commission_mode IN ('percent','fixed')),
  commission_bps         INTEGER CHECK (commission_bps BETWEEN 0 AND 10000),
  commission_minor       INTEGER,
  customer_amount_minor  INTEGER,
  assigned_at            TEXT,
  approved_at            TEXT,
  note                   TEXT,                   -- ملاحظة المدير
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  CHECK (fee_minor IS NULL OR net_minor = gross_minor - fee_minor),
  CHECK (status IN ('unassigned','excluded') OR customer_id IS NOT NULL)
);
CREATE INDEX idx_txn_status   ON paypal_transactions(status, occurred_at);
CREATE INDEX idx_txn_customer ON paypal_transactions(customer_id, status);
CREATE INDEX idx_txn_related  ON paypal_transactions(related_txn_id);

CREATE TABLE ledger_entries (
  id                     INTEGER PRIMARY KEY,
  customer_id            INTEGER NOT NULL REFERENCES customers(id),
  currency               TEXT NOT NULL CHECK (length(currency) = 3),
  type                   TEXT NOT NULL CHECK (type IN ('credit','payout','adjustment','reversal')),
  amount_minor           INTEGER NOT NULL CHECK (amount_minor <> 0),  -- موجب = له، سالب = دُفع له/خُصم
  paypal_transaction_id  INTEGER REFERENCES paypal_transactions(id),
  reverses_entry_id      INTEGER UNIQUE REFERENCES ledger_entries(id), -- القيد لا يُعكس إلا مرة
  payout_method          TEXT,     -- cash | bank | usdt | paypal | other  (للدفعات فقط)
  reference              TEXT,     -- رقم الحوالة/الإيصال
  description            TEXT NOT NULL,
  entry_date             TEXT NOT NULL,   -- تاريخ القيد كما يراه العميل
  created_at             TEXT NOT NULL,
  CHECK (type <> 'credit' OR (amount_minor > 0 AND paypal_transaction_id IS NOT NULL)),
  CHECK (type <> 'payout' OR amount_minor < 0)
);
CREATE INDEX idx_ledger_customer ON ledger_entries(customer_id, currency, entry_date, id);

-- الدفتر إلحاقي فقط
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

-- سجل تدقيق لكل عملية تمسّ المال
CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY,
  action     TEXT NOT NULL,   -- txn.assign, txn.approve, txn.unapprove, txn.fee_set, ledger.payout, ...
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  details    TEXT NOT NULL,   -- JSON: القيم قبل/بعد
  created_at TEXT NOT NULL
);
