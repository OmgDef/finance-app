UPDATE faq_entries
SET answer_en = REPLACE(answer_en,
      'Your old device will lose access, and your accounts and history will appear on the new one.',
      'Your accounts and history are available on all activated devices. If you no longer use the old phone, sign out on it. If you lost it, ask your administrator to revoke device access.'),
    answer_ru = REPLACE(answer_ru,
      'Доступ с прежнего устройства завершится, а счета и история появятся на новом.',
      'Счета и история доступны на всех активированных устройствах. Если вы больше не пользуетесь прежним телефоном, выйдите на нём из приложения. Если телефон потерян, попросите администратора отозвать доступ с устройств.'),
    version = version + 1
WHERE id = 'pin-or-phone'
  AND (INSTR(BINARY answer_en, 'Your old device will lose access, and your accounts and history will appear on the new one.') > 0
    OR INSTR(BINARY answer_ru, 'Доступ с прежнего устройства завершится, а счета и история появятся на новом.') > 0);
--> statement-breakpoint
ALTER TABLE users DROP COLUMN active_device_id;
