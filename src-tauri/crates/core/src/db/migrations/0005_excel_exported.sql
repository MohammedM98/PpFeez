-- SPEC 6.8.1: PayPal ids already written to each main Excel file. A row the owner deletes from
-- the file is not added again; a new file path starts a new list.
CREATE TABLE excel_exported (
  file_path      TEXT NOT NULL,
  paypal_txn_id  TEXT NOT NULL,
  exported_at    TEXT NOT NULL,
  PRIMARY KEY (file_path, paypal_txn_id)
);
