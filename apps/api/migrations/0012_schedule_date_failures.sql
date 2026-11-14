CREATE TABLE IF NOT EXISTS schedule_date_failures (
  rule_id CHAR(36) CHARACTER SET ascii NOT NULL,
  scheduled_date DATE NOT NULL,
  attempts TINYINT UNSIGNED NOT NULL,
  error_code ENUM('TEMPORARY_FAILURE','SCHEDULE_DATA_INVALID') NOT NULL,
  recorded_at BIGINT NOT NULL,
  next_attempt_at BIGINT,
  PRIMARY KEY (rule_id, scheduled_date),
  FOREIGN KEY (rule_id) REFERENCES schedule_rules(id),
  CONSTRAINT schedule_failure_attempts CHECK (attempts BETWEEN 1 AND 5),
  CONSTRAINT schedule_failure_retry CHECK (
    next_attempt_at IS NULL OR (attempts < 5 AND error_code = 'TEMPORARY_FAILURE' AND next_attempt_at > recorded_at)
  )
) ENGINE=InnoDB;
