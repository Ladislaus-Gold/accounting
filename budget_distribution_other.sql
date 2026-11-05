-- «Аванс, зарплата и другое»: колонка для распределения «Другое» по категориям.
-- Запусти один раз в Supabase: SQL Editor -> вставить -> Run.
-- Можно запускать повторно, ничего не сломается.

alter table budget_distribution
  add column if not exists other numeric not null default 0;
