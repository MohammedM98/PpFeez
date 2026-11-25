-- SPEC 4.9: standalone payouts (ledger entries of type 'payout' without a linked payout) are
-- numbered in the same per-customer, per-currency sequence as linked payouts ("دفعة N"). The
-- ledger is append-only, so the number lives here. Existing ones are numbered after the
-- customer's last linked payout, in ledger order.
CREATE TABLE standalone_payouts (
  entry_id     INTEGER PRIMARY KEY REFERENCES ledger_entries(id) ON DELETE CASCADE,
  customer_id  INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  payout_seq   INTEGER NOT NULL,
  UNIQUE (customer_id, currency, payout_seq)
);

INSERT INTO standalone_payouts (entry_id, customer_id, currency, payout_seq)
SELECT e.id, e.customer_id, e.currency,
       COALESCE((SELECT MAX(p.payout_seq) FROM payouts p
                  WHERE p.customer_id = e.customer_id AND p.currency = e.currency), 0)
       + ROW_NUMBER() OVER (PARTITION BY e.customer_id, e.currency ORDER BY e.entry_date, e.id)
FROM ledger_entries e
WHERE e.type = 'payout' AND e.payout_id IS NULL;
