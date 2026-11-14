CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  status ENUM('active','blocked','review') NOT NULL DEFAULT 'active',
  active_device_id CHAR(36) CHARACTER SET ascii
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS activation_codes (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  verifier CHAR(64) CHARACTER SET ascii NOT NULL,
  expires_at BIGINT NOT NULL,
  state ENUM('issued','used','revoked') NOT NULL DEFAULT 'issued',
  KEY activation_by_user (user_id, state, verifier),
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS devices (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  verifier CHAR(64) CHARACTER SET ascii NOT NULL UNIQUE,
  pin_hash VARCHAR(180) CHARACTER SET ascii NOT NULL,
  biometric_verifier CHAR(64) CHARACTER SET ascii,
  pin_failures TINYINT UNSIGNED NOT NULL DEFAULT 0,
  state ENUM('active','locked','revoked') NOT NULL DEFAULT 'active',
  FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sessions (
  verifier CHAR(64) CHARACTER SET ascii PRIMARY KEY,
  device_id CHAR(36) CHARACTER SET ascii NOT NULL,
  expires_at BIGINT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  KEY sessions_by_device (device_id, revoked),
  FOREIGN KEY (device_id) REFERENCES devices(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS admin_users (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  login VARCHAR(254) NOT NULL UNIQUE,
  password_hash VARCHAR(180) CHARACTER SET ascii NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  totp_cipher VARCHAR(256) CHARACTER SET ascii,
  last_totp_step BIGINT,
  recovery_verifier CHAR(64) CHARACTER SET ascii,
  recovery_expires_at BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS admin_steps (
  verifier CHAR(64) CHARACTER SET ascii PRIMARY KEY,
  admin_id CHAR(36) CHARACTER SET ascii NOT NULL,
  browser_verifier CHAR(64) CHARACTER SET ascii NOT NULL,
  kind ENUM('login','setup') NOT NULL,
  expires_at BIGINT NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
  pending_totp_cipher VARCHAR(256) CHARACTER SET ascii,
  spent BOOLEAN NOT NULL DEFAULT FALSE,
  KEY steps_by_admin (admin_id, spent),
  FOREIGN KEY (admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS admin_sessions (
  verifier CHAR(64) CHARACTER SET ascii PRIMARY KEY,
  admin_id CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  KEY admin_sessions_by_admin (admin_id, revoked),
  FOREIGN KEY (admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket CHAR(64) CHARACTER SET ascii PRIMARY KEY,
  expires_at BIGINT NOT NULL,
  attempts SMALLINT UNSIGNED NOT NULL,
  KEY rate_limits_by_expiry (expires_at)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS support_settings (
  id TINYINT PRIMARY KEY CHECK (id = 1),
  email VARCHAR(254),
  phone VARCHAR(32)
) ENGINE=InnoDB;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS faq_entries (
  id VARCHAR(64) CHARACTER SET ascii PRIMARY KEY,
  position INT NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  question_en VARCHAR(255) NOT NULL,
  answer_en TEXT NOT NULL,
  question_ru VARCHAR(255) NOT NULL,
  answer_ru TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_role ENUM('operator','admin','user') NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii,
  user_id CHAR(36) CHARACTER SET ascii,
  object_id CHAR(36) CHARACTER SET ascii,
  event VARCHAR(64) CHARACTER SET ascii NOT NULL,
  happened_at BIGINT NOT NULL,
  transition JSON
) ENGINE=InnoDB;
