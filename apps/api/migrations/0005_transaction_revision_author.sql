ALTER TABLE transaction_versions
  ADD COLUMN actor_role ENUM('user','admin') NOT NULL DEFAULT 'user',
  ADD COLUMN reason VARCHAR(500);
