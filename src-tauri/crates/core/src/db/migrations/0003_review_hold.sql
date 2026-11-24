-- SPEC §3, §5.3: transactions from the generic parser need the owner's review before approval;
-- eCheck payments wait for clearing; on-hold notices mark the existing transaction.
ALTER TABLE paypal_transactions ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE paypal_transactions ADD COLUMN review_reason TEXT;
ALTER TABLE paypal_transactions ADD COLUMN hold_status TEXT
  CHECK (hold_status IN ('pending_echeck','on_hold'));
CREATE INDEX idx_txn_review ON paypal_transactions(needs_review);
