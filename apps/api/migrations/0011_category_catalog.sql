INSERT INTO categories (id, kind, name_en, name_ru) VALUES
  ('dining', 'expense', 'Dining out', 'Кафе и рестораны'),
  ('education', 'expense', 'Education', 'Образование'),
  ('entertainment', 'expense', 'Entertainment', 'Развлечения'),
  ('health', 'expense', 'Health', 'Здоровье'),
  ('housing', 'expense', 'Housing and utilities', 'Жильё и коммунальные услуги'),
  ('other-expense', 'expense', 'Other expenses', 'Прочие расходы'),
  ('shopping', 'expense', 'Shopping', 'Покупки'),
  ('transport', 'expense', 'Transport', 'Транспорт'),
  ('travel', 'expense', 'Travel', 'Путешествия'),
  ('freelance', 'income', 'Freelance', 'Подработка'),
  ('gift', 'income', 'Gifts', 'Подарки'),
  ('salary', 'income', 'Salary', 'Зарплата')
ON DUPLICATE KEY UPDATE id = categories.id;
