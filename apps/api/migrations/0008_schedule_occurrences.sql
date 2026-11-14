ALTER TABLE schedule_rules ADD COLUMN processed_through DATE;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS schedule_occurrences (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  rule_id CHAR(36) CHARACTER SET ascii NOT NULL,
  scheduled_date DATE NOT NULL,
  due_at BIGINT NOT NULL,
  rule_version INT UNSIGNED NOT NULL,
  amount_minor BIGINT NOT NULL,
  category_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  comment VARCHAR(500),
  status ENUM('posted','skipped') NOT NULL,
  recorded_at BIGINT NOT NULL,
  reason VARCHAR(500),
  adjustment_id CHAR(36) CHARACTER SET ascii,
  transaction_id CHAR(36) CHARACTER SET ascii,
  UNIQUE KEY schedule_occurrence_date (rule_id, scheduled_date),
  FOREIGN KEY (rule_id, rule_version) REFERENCES schedule_rule_versions(rule_id, version),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  FOREIGN KEY (adjustment_id) REFERENCES balance_adjustments(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  CONSTRAINT schedule_occurrence_amount CHECK (amount_minor > 0),
  CONSTRAINT schedule_occurrence_outcome CHECK (
    (status = 'posted' AND transaction_id IS NOT NULL AND adjustment_id IS NULL AND reason IS NULL)
    OR (status = 'skipped' AND transaction_id IS NULL AND reason IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
