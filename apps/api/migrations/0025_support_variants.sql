ALTER TABLE support_settings
  DROP CHECK support_settings_chk_1,
  ADD CONSTRAINT support_settings_supported_id CHECK (id IN (1, 2));
--> statement-breakpoint
INSERT INTO support_settings (id) VALUES (1), (2)
ON DUPLICATE KEY UPDATE id = support_settings.id;
--> statement-breakpoint
ALTER TABLE faq_entries
  ADD COLUMN support_id TINYINT NOT NULL DEFAULT 1,
  ADD INDEX faq_entries_by_support (support_id, position, id),
  ADD CONSTRAINT faq_entries_support_fk FOREIGN KEY (support_id) REFERENCES support_settings (id);
--> statement-breakpoint
INSERT INTO faq_entries (id, support_id, position, published, question_en, answer_en, question_ru, answer_ru) VALUES
  ('comabank-access', 2, 10, TRUE,
    'How do I activate ComaBank?',
    'Ask your administrator for an activation code. Enter your account email and code, then set a four-digit PIN. To add another phone, use an activation code issued for that installation.',
    'Как активировать ComaBank?',
    'Попросите администратора выдать код активации. Введите email учётной записи и код, затем задайте PIN из четырёх цифр. Для подключения другого телефона используйте код, выданный для этой установки.'),
  ('comabank-balances', 2, 20, TRUE,
    'How are balances shown for different currencies?',
    'The Accounts screen adds up your active accounts by currency. Rubles, US dollars and euros each have their own total.',
    'Как отображаются остатки в разных валютах?',
    'На экране «Счета» остатки активных счетов складываются по каждой валюте. Рубли, доллары США и евро отображаются отдельными суммами.'),
  ('comabank-expense', 2, 30, TRUE,
    'How do I record a purchase?',
    'Open Payments and choose an expense or one of the quick categories. Enter the amount, check the account, category and date, then save the entry.',
    'Как учесть покупку?',
    'Откройте «Платежи» и выберите расход или одну из быстрых категорий. Введите сумму, проверьте счёт, категорию и дату, затем сохраните запись.'),
  ('comabank-transfer', 2, 40, TRUE,
    'How do I record a transfer between currencies?',
    'Choose a transfer in Payments and select the accounts to debit and credit. Enter the actual amount for each currency, then save the entry.',
    'Как учесть перевод между счетами в разных валютах?',
    'Выберите перевод в разделе «Платежи» и укажите счета списания и зачисления. Введите фактическую сумму в каждой валюте и сохраните запись.'),
  ('comabank-cards', 2, 50, TRUE,
    'How do I link a card to an account?',
    'Open Settings, then Manage accounts. Select an account and choose Add card. You can set a name, a colour, a payment network and the last four digits.',
    'Как привязать карту к счёту?',
    'Откройте «Настройки» → «Управление счетами», выберите счёт и нажмите «Добавить карточку». Укажите название и цвет. Платёжную систему и последние четыре цифры можно добавить по желанию.'),
  ('comabank-schedule', 2, 60, TRUE,
    'Where can I manage recurring entries?',
    'Open Settings and choose Schedule settings. Open Rules to add or change a recurring entry. Open Schedule dates to see when the entries are due.',
    'Где настроить регулярные операции?',
    'Откройте «Настройки» → «Настройки расписания». В разделе «Правила» можно создать или изменить регулярную операцию. В разделе «Даты графика» видны запланированные даты.'),
  ('comabank-statement', 2, 70, TRUE,
    'How do I export a statement?',
    'Open the account, choose PDF statement and select the period. You can then save or share the generated file.',
    'Как получить выписку?',
    'Откройте нужный счёт, выберите выписку PDF и укажите период. Готовый файл можно сохранить или отправить.'),
  ('comabank-contacts', 2, 80, TRUE,
    'How do I get help with ComaBank?',
    'Open Help and choose an available contact. If no contacts are listed, reach out to the administrator who issued your activation code.',
    'Как связаться с поддержкой ComaBank?',
    'Откройте «Помощь» и выберите доступный контакт. Если контакты ещё не указаны, обратитесь к администратору, выдавшему код активации.')
ON DUPLICATE KEY UPDATE id = faq_entries.id;
