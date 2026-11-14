ALTER TABLE schedule_rules
  ADD COLUMN replaces_rule_id CHAR(36) CHARACTER SET ascii,
  ADD UNIQUE KEY schedule_replaces_rule (replaces_rule_id),
  ADD CONSTRAINT schedule_previous_rule FOREIGN KEY (replaces_rule_id) REFERENCES schedule_rules(id);
--> statement-breakpoint
ALTER TABLE schedule_occurrences
  ADD COLUMN source_occurrence_id CHAR(36) CHARACTER SET ascii,
  ADD CONSTRAINT schedule_source_occurrence FOREIGN KEY (source_occurrence_id) REFERENCES schedule_occurrences(id),
  ADD CONSTRAINT schedule_transferred_skip CHECK (
    source_occurrence_id IS NULL OR (status = 'skipped' AND adjustment_id IS NOT NULL)
  );
