CREATE TABLE IF NOT EXISTS recovery_state (
  id TINYINT PRIMARY KEY CHECK (id = 1),
  version BIGINT UNSIGNED NOT NULL CHECK (version BETWEEN 2 AND 9999999999),
  snapshot_at BIGINT NOT NULL,
  incident_at BIGINT NOT NULL,
  prepared_at BIGINT NOT NULL,
  CONSTRAINT recovery_time_order CHECK (snapshot_at <= incident_at AND incident_at <= prepared_at)
) ENGINE=InnoDB;
--> statement-breakpoint
ALTER TABLE schedule_rules ADD COLUMN recovery_held BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint
ALTER TABLE schedule_date_failures
  MODIFY error_code ENUM('TEMPORARY_FAILURE','SCHEDULE_DATA_INVALID','RECOVERY_UNCERTAIN') NOT NULL;
