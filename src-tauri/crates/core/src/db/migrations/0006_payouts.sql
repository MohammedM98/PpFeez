-- SPEC 4.8: transfers numbered per customer and currency, payouts that cover transfers, matching.

ALTER TABLE paypal_transactions ADD COLUMN customer_seq INTEGER;
ALTER TABLE paypal_transactions ADD COLUMN matched INTEGER NOT NULL DEFAULT 0;

-- Last number given per customer and currency: numbers are never reused (unapprove leaves a gap).
CREATE TABLE customer_seq_counters (
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  currency     TEXT NOT NULL,
  last_seq     INTEGER NOT NULL,
  PRIMARY KEY (customer_id, currency)
);

CREATE TABLE payouts (
  id               INTEGER PRIMARY KEY,
  customer_id      INTEGER NOT NULL REFERENCES customers(id),
  currency         TEXT NOT NULL CHECK (length(currency) = 3),
  payout_seq       INTEGER NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('draft','sent','cancelled')),
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  due_minor        INTEGER NOT NULL,
  method           TEXT NOT NULL,
  platform         TEXT,
  network          TEXT,
  destination      TEXT,
  reference        TEXT,
  note             TEXT,
  difference_reason TEXT,
  range_label      TEXT NOT NULL,
  payout_date      TEXT NOT NULL,
  ledger_entry_id  INTEGER UNIQUE REFERENCES ledger_entries(id),
  cancel_reason    TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (customer_id, currency, payout_seq)
);

CREATE TABLE payout_items (
  payout_id   INTEGER NOT NULL REFERENCES payouts(id),
  item_kind   TEXT NOT NULL CHECK (item_kind IN ('txn','ledger')),
  item_id     INTEGER NOT NULL,
  PRIMARY KEY (item_kind, item_id, payout_id)
);
CREATE INDEX idx_payout_items_payout ON payout_items(payout_id);

-- Payout details on ledger entries (written once, at insert: entries stay immutable).
ALTER TABLE ledger_entries ADD COLUMN payout_platform TEXT;
ALTER TABLE ledger_entries ADD COLUMN payout_network TEXT;
ALTER TABLE ledger_entries ADD COLUMN payout_destination TEXT;
ALTER TABLE ledger_entries ADD COLUMN payout_id INTEGER REFERENCES payouts(id);

-- Last method/platform/network/destination used per customer (payout dialog defaults).
CREATE TABLE customer_payout_defaults (
  customer_id  INTEGER PRIMARY KEY REFERENCES customers(id),
  method       TEXT NOT NULL,
  platform     TEXT,
  network      TEXT,
  destination  TEXT
);

-- Number the transfers already approved, in approval order.
UPDATE paypal_transactions SET customer_seq = (
  SELECT COUNT(*) FROM paypal_transactions o
  WHERE o.status = 'approved' AND o.customer_id = paypal_transactions.customer_id
    AND o.currency = paypal_transactions.currency
    AND (o.approved_at < paypal_transactions.approved_at
         OR (o.approved_at = paypal_transactions.approved_at AND o.id <= paypal_transactions.id))
)
WHERE status = 'approved' AND customer_id IS NOT NULL;

INSERT INTO customer_seq_counters (customer_id, currency, last_seq)
SELECT customer_id, currency, MAX(customer_seq) FROM paypal_transactions
WHERE customer_seq IS NOT NULL GROUP BY customer_id, currency;
