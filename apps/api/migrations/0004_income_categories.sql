INSERT INTO categories (id, kind, name_en, name_ru) VALUES
  ('deposit-interest', 'income', 'Deposit interest', 'Проценты по вкладам'),
  ('other-income', 'income', 'Other income', 'Прочие доходы')
ON DUPLICATE KEY UPDATE id = categories.id;
