ALTER TABLE transaction_versions ADD COLUMN income_source VARCHAR(120);
--> statement-breakpoint
ALTER TABLE schedule_rule_versions
  ADD COLUMN sets_income_source BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN income_source VARCHAR(120),
  ADD CONSTRAINT schedule_income_source_patch CHECK (sets_income_source OR income_source IS NULL);
--> statement-breakpoint
ALTER TABLE schedule_occurrences ADD COLUMN income_source VARCHAR(120);
