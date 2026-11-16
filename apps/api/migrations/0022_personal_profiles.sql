CREATE TABLE IF NOT EXISTS personal_profiles (
  user_id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  version INT UNSIGNED NOT NULL,
  key_version INT UNSIGNED NOT NULL,
  identity_summary BLOB NOT NULL,
  personal_fields BLOB NOT NULL,
  avatar_version INT UNSIGNED,
  avatar_jpeg MEDIUMBLOB,
  CHECK ((avatar_version IS NULL) = (avatar_jpeg IS NULL)),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
