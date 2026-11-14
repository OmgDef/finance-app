ALTER TABLE accounts
  ADD COLUMN kind ENUM('regular','deposit') NOT NULL DEFAULT 'regular',
  ADD COLUMN annual_rate_percent DECIMAL(7,4),
  ADD COLUMN maturity_date DATE,
  ADD CONSTRAINT accounts_deposit_terms CHECK (
    (kind = 'regular' AND annual_rate_percent IS NULL AND maturity_date IS NULL)
    OR (kind = 'deposit' AND annual_rate_percent IS NOT NULL AND annual_rate_percent >= 0
      AND maturity_date IS NOT NULL AND maturity_date >= start_date)
  );
