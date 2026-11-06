-- Расписание опроса Monobank (pg_cron + pg_net).
-- Выполнить после schema.sql и после деплоя Edge Function "mono".
-- Создаёт два задания: mono-poll (каждые 2 минуты) и mono-balance (каждые 30 минут).
-- Секрет вебхука в задания не зашит: он читается из public.mono_settings в момент запуска.
--
-- Обычно этот вызов делает само приложение при подключении карты (Ещё -> Monobank).

select public.mono_enable_polling('https://ozgorwowudjhyvdncilu.supabase.co/functions/v1/mono');
