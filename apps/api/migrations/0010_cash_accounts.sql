ALTER TABLE accounts
  DROP CHECK accounts_deposit_terms,
  MODIFY COLUMN kind ENUM('regular','deposit','cash') NOT NULL DEFAULT 'regular',
  ADD CONSTRAINT accounts_terms_match_kind CHECK (
    (kind IN ('regular','cash') AND annual_rate_percent IS NULL AND maturity_date IS NULL)
    OR (kind = 'deposit' AND annual_rate_percent IS NOT NULL AND annual_rate_percent >= 0
      AND maturity_date IS NOT NULL AND maturity_date >= start_date)
  );
