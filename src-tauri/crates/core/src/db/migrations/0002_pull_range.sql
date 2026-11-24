-- SPEC §5.5: every pull records the range the owner chose.
-- range_from / range_to are local calendar dates (YYYY-MM-DD), set for last_days and between.
ALTER TABLE pull_runs ADD COLUMN range_kind TEXT NOT NULL DEFAULT 'new'
  CHECK (range_kind IN ('new','last_days','between','all'));
ALTER TABLE pull_runs ADD COLUMN range_from TEXT;
ALTER TABLE pull_runs ADD COLUMN range_to TEXT;
