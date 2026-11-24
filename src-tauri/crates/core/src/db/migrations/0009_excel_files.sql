-- SPEC 6.8.4: a customer keeps a list of statement files, one of them current (the target of
-- automatic sync; customer_excel.file_path mirrors it). Existing links become the current file.
-- Tracking stays keyed by (customer_id, file_path), unique per customer here.
CREATE TABLE customer_excel_files (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  file_path    TEXT NOT NULL,
  label        TEXT,
  is_current   INTEGER NOT NULL DEFAULT 0,
  start_mode   TEXT NOT NULL CHECK (start_mode IN ('carry_balance','all','from_date','from_seq')),
  start_value  TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT,
  UNIQUE (customer_id, file_path)
);

INSERT INTO customer_excel_files (customer_id, file_path, is_current, start_mode, created_at, updated_at)
SELECT customer_id, file_path, 1, 'all',
       COALESCE((SELECT MIN(added_at) FROM customer_excel_items i
                  WHERE i.customer_id = x.customer_id AND i.file_path = x.file_path), x.updated_at, '1970-01-01T00:00:00Z'),
       x.updated_at
FROM customer_excel x;
