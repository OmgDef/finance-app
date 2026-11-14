CREATE TABLE IF NOT EXISTS schedule_rules (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  account_id CHAR(36) CHARACTER SET ascii NOT NULL,
  kind ENUM('expense','income') NOT NULL,
  frequency ENUM('once','weekly','monthly') NOT NULL,
  first_date DATE NOT NULL,
  created_at BIGINT NOT NULL,
  starts_at BIGINT,
  ends_before_date DATE,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS schedule_rule_versions (
  rule_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL,
  accepted_at BIGINT NOT NULL,
  effective_at BIGINT NOT NULL,
  amount_minor BIGINT,
  category_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  sets_comment BOOLEAN NOT NULL DEFAULT FALSE,
  comment VARCHAR(500),
  sets_end_date BOOLEAN NOT NULL DEFAULT FALSE,
  end_date DATE,
  state ENUM('active','paused','ended'),
  PRIMARY KEY (rule_id, version),
  FOREIGN KEY (rule_id) REFERENCES schedule_rules(id),
  FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT schedule_version_positive CHECK (version >= 1),
  CONSTRAINT schedule_effective_after_acceptance CHECK (effective_at >= accepted_at),
  CONSTRAINT schedule_amount_positive CHECK (amount_minor > 0),
  CONSTRAINT schedule_initial_parameters CHECK (version <> 1 OR (amount_minor IS NOT NULL AND category_id IS NOT NULL)),
  CONSTRAINT schedule_comment_patch CHECK (sets_comment OR comment IS NULL),
  CONSTRAINT schedule_end_date_patch CHECK (sets_end_date OR end_date IS NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
