-- Existing writers omit the revision. Updated writers replace the initial value on each failure.
ALTER TABLE schedule_date_failures
  ADD COLUMN revision CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
    DEFAULT '00000000-0000-0000-0000-000000000000';
