CREATE TABLE IF NOT EXISTS user_time_zone_versions (
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  effective_at BIGINT NOT NULL,
  time_zone VARCHAR(64) CHARACTER SET ascii NOT NULL,
  PRIMARY KEY (user_id, effective_at),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS accounts (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(255) NOT NULL,
  currency ENUM('USD','EUR','RUB') NOT NULL,
  start_date DATE NOT NULL,
  opening_balance_minor BIGINT NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS categories (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  kind ENUM('expense','income') NOT NULL,
  name_en VARCHAR(128) NOT NULL,
  name_ru VARCHAR(128) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
INSERT INTO categories (id, kind, name_en, name_ru)
  VALUES ('groceries', 'expense', 'Groceries', 'Продукты')
  ON DUPLICATE KEY UPDATE id = categories.id;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS transactions (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  kind ENUM('expense','income','transfer') NOT NULL,
  current_version INT UNSIGNED NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS transaction_versions (
  transaction_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL,
  status ENUM('posted','void') NOT NULL,
  financial_date DATE NOT NULL,
  category_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin,
  comment VARCHAR(500),
  created_at BIGINT NOT NULL,
  PRIMARY KEY (transaction_id, version),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS movements (
  transaction_id CHAR(36) CHARACTER SET ascii NOT NULL,
  transaction_version INT UNSIGNED NOT NULL,
  account_id CHAR(36) CHARACTER SET ascii NOT NULL,
  amount_minor BIGINT NOT NULL,
  PRIMARY KEY (transaction_id, transaction_version, account_id),
  KEY movements_by_account (account_id),
  FOREIGN KEY (transaction_id, transaction_version) REFERENCES transaction_versions(transaction_id, version),
  FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS idempotency_keys (
  actor_role ENUM('user','admin') NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  command VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_key VARCHAR(75) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result JSON,
  PRIMARY KEY (actor_role, actor_id, command, command_key)
) ENGINE=InnoDB;
