INSERT INTO categories (id, kind, name_en, name_ru)
VALUES ('mobile-phone', 'expense', 'Mobile phone', 'Мобильная связь')
ON DUPLICATE KEY UPDATE id = categories.id;
