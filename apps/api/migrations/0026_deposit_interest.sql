ALTER TABLE accounts
  ADD COLUMN next_interest_date DATE NULL,
  ADD COLUMN interest_review_before BIGINT NULL,
  ADD INDEX accounts_interest_due (next_interest_date, id);
--> statement-breakpoint
UPDATE accounts SET next_interest_date = LEAST(DATE_ADD(start_date, INTERVAL 1 MONTH), maturity_date),
  interest_review_before = FLOOR(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000)
WHERE kind = 'deposit' AND maturity_date > start_date;
--> statement-breakpoint
CREATE TABLE deposit_interest_periods (
  account_id CHAR(36) CHARACTER SET ascii NOT NULL,
  payment_date DATE NOT NULL,
  from_date DATE NOT NULL,
  calculated_minor DECIMAL(38,0) NOT NULL,
  outcome ENUM('posted','existing','reconciled','zero') NOT NULL,
  transaction_id CHAR(36) CHARACTER SET ascii NULL,
  adjustment_id CHAR(36) CHARACTER SET ascii NULL,
  PRIMARY KEY (account_id, payment_date),
  UNIQUE KEY deposit_interest_transaction (transaction_id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (transaction_id) REFERENCES transactions(id),
  FOREIGN KEY (adjustment_id) REFERENCES balance_adjustments(id)
) ENGINE=InnoDB;
--> statement-breakpoint
UPDATE faq_entries SET
  answer_en = 'Interest is added to the deposit monthly at the saved annual rate and earns interest in later periods. Open Deposit interest on the account to review and apply any earlier periods.',
  answer_ru = 'Проценты зачисляются на вклад каждый месяц по указанной годовой ставке и учитываются при следующих начислениях. В карточке вклада откройте «Проценты по вкладу», чтобы проверить и применить расчёт за прошлые периоды.'
WHERE id = 'deposit-interest'
  AND answer_en = 'When the bank credits interest, record income on the deposit account and choose Deposit interest. The rate on the deposit card is for reference.'
  AND answer_ru = 'Когда банк начислит проценты, создайте доход на счёте вклада и выберите категорию «Проценты по вкладам». Ставка в карточке вклада указана для справки.';
