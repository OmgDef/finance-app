CREATE TABLE IF NOT EXISTS schedule_worker_state (
  id TINYINT PRIMARY KEY CHECK (id = 1),
  last_rule_id CHAR(36) CHARACTER SET ascii,
  scan_oldest_due_at BIGINT,
  last_success_at BIGINT NOT NULL
) ENGINE=InnoDB;
