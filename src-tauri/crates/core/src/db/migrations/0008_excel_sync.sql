-- SPEC 6.8.3: automatic sync of the customer's Excel statement. One tracking row per line of the
-- file (its hidden key), pending until written; existing rows (added by hand in 0.5.0) are
-- exported, with the keys 0.5.0 wrote. Existing links get automatic sync.
CREATE TABLE customer_excel_lines (
  customer_id  INTEGER NOT NULL,
  file_path    TEXT NOT NULL,
  line_key     TEXT NOT NULL,
  item_kind    TEXT NOT NULL CHECK (item_kind IN ('txn','ledger','payout','reversal')),
  item_id      INTEGER NOT NULL,
  source_id    INTEGER,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'exported' CHECK (status IN ('pending','exported')),
  added_at     TEXT NOT NULL,
  exported_at  TEXT,
  last_error   TEXT,
  data         TEXT,
  PRIMARY KEY (customer_id, file_path, line_key)
);

INSERT INTO customer_excel_lines
  (customer_id, file_path, line_key, item_kind, item_id, source_id, currency, status, added_at, exported_at)
SELECT i.customer_id, i.file_path,
  CASE i.item_kind
    WHEN 'txn' THEN COALESCE('T:' || (SELECT t.paypal_txn_id FROM paypal_transactions t WHERE t.id = i.item_id),
                             'T:?' || i.item_id)
    WHEN 'payout' THEN 'P:' || i.item_id
    ELSE (CASE
            WHEN e.type = 'payout' THEN 'U:'
            WHEN e.type = 'reversal' AND e.reverses_entry_id IN (SELECT id FROM ledger_entries WHERE type = 'payout') THEN 'X:'
            WHEN e.type = 'reversal' AND e.reverses_entry_id IS NULL AND e.amount_minor < 0
                 AND e.paypal_transaction_id IS NOT NULL THEN 'R:'
            ELSE 'L:'
          END) || i.item_id
  END,
  i.item_kind, i.item_id,
  CASE WHEN i.item_kind = 'txn' THEN
    (SELECT c.id FROM ledger_entries c WHERE c.paypal_transaction_id = i.item_id AND c.type = 'credit'
       AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reverses_entry_id = c.id)
     ORDER BY c.id DESC LIMIT 1)
  END,
  i.currency, 'exported', i.added_at, i.added_at
FROM customer_excel_items i
LEFT JOIN ledger_entries e ON i.item_kind = 'ledger' AND e.id = i.item_id;

DROP TABLE customer_excel_items;
ALTER TABLE customer_excel_lines RENAME TO customer_excel_items;

ALTER TABLE customer_excel ADD COLUMN auto_sync INTEGER NOT NULL DEFAULT 1;
-- Set when an event queued a line; the background writer picks these customers up.
ALTER TABLE customer_excel ADD COLUMN dirty INTEGER NOT NULL DEFAULT 0;
