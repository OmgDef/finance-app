CREATE TABLE IF NOT EXISTS balance_adjustments (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  account_id CHAR(36) CHARACTER SET ascii NOT NULL,
  account_version INT UNSIGNED NOT NULL,
  financial_date DATE NOT NULL,
  created_at BIGINT NOT NULL,
  covered_through DATE NOT NULL,
  balance_before_minor DECIMAL(65,0) NOT NULL,
  actual_balance_minor BIGINT NOT NULL,
  delta_minor BIGINT NOT NULL,
  explanation VARCHAR(500) NOT NULL,
  actor_role ENUM('user','admin') NOT NULL,
  UNIQUE KEY balance_adjustments_by_account_version (account_id, account_version),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  CONSTRAINT adjustment_matches_actual CHECK (actual_balance_minor = balance_before_minor + delta_minor),
  CONSTRAINT adjustment_covers_date CHECK (covered_through >= financial_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
ALTER TABLE accounts ADD COLUMN needs_reconciliation BOOLEAN NOT NULL DEFAULT FALSE;
