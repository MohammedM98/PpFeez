-- SPEC §3, §4.7: ledger entries stay immutable (UPDATE always fails); DELETE is allowed only
-- inside the controlled delete flow, which inserts a token row in the same SQL transaction and
-- removes it before committing.
CREATE TABLE _ledger_delete_token (x INTEGER);
DROP TRIGGER ledger_no_delete;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries
WHEN NOT EXISTS (SELECT 1 FROM _ledger_delete_token)
BEGIN SELECT RAISE(ABORT, 'ledger entries are deleted only through the delete flow'); END;
