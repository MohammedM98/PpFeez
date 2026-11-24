-- SPEC 6.8.2: one Excel statement per customer, and what was added to it.
CREATE TABLE customer_excel (
  customer_id     INTEGER PRIMARY KEY REFERENCES customers(id),
  file_path       TEXT NOT NULL,
  updated_at      TEXT,
  add_by_default  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE customer_excel_items (
  customer_id  INTEGER NOT NULL,
  file_path    TEXT NOT NULL,
  item_kind    TEXT NOT NULL CHECK (item_kind IN ('txn','ledger','payout')),
  item_id      INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (customer_id, file_path, item_kind, item_id)
);
