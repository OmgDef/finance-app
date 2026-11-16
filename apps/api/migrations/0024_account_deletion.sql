ALTER TABLE accounts ADD COLUMN deleted_at BIGINT;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN deleted_at BIGINT;
--> statement-breakpoint
UPDATE transactions t
JOIN schedule_occurrences o ON o.transaction_id = t.id
JOIN schedule_rules r ON r.id = o.rule_id
SET t.deleted_at = r.deleted_at
WHERE r.deleted_at IS NOT NULL;
