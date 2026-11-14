CREATE TABLE IF NOT EXISTS account_cards (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  account_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(255) NOT NULL,
  appearance CHAR(7) CHARACTER SET ascii NOT NULL,
  last_four CHAR(4) CHARACTER SET ascii,
  FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
