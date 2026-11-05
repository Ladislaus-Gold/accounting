-- Разделение одной операции на несколько категорий.
-- Запустить один раз в Supabase: SQL Editor -> New query -> Run.

create table if not exists public.transaction_splits (
  id bigint generated always as identity primary key,
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  category_id bigint not null references public.categories(id),
  amount numeric not null check (amount > 0),
  sort_order integer not null default 0
);
create index if not exists transaction_splits_tx_idx on public.transaction_splits(transaction_id);

alter table public.transaction_splits enable row level security;
drop policy if exists "owner only" on public.transaction_splits;
create policy "owner only" on public.transaction_splits for all to authenticated
  using (auth.uid() = '87c04c71-67ca-4fc4-bfb4-c9c3cf451ae9'::uuid)
  with check (auth.uid() = '87c04c71-67ca-4fc4-bfb4-c9c3cf451ae9'::uuid);
revoke all on public.transaction_splits from anon;

-- Бюджет: у разделённой операции в категории идут её части, у обычной - как раньше.
create or replace function public.month_category_totals(p_month date)
returns table(category_id bigint, action text, total numeric)
language sql stable
as $$
  with tx as (
    select t.id, t.category_id, t.action, t.amount
    from transactions t
    where t.date >= (date_trunc('month', p_month::timestamp) at time zone 'Europe/Kyiv')
      and t.date <  ((date_trunc('month', p_month::timestamp) + interval '1 month') at time zone 'Europe/Kyiv')
      and t.action in ('EXPENSE', 'INCOME', 'RETURN')
  )
  select s.category_id, tx.action, sum(s.amount) as total
  from tx join transaction_splits s on s.transaction_id = tx.id
  group by s.category_id, tx.action
  union all
  select tx.category_id, tx.action, sum(tx.amount) as total
  from tx
  where not exists (select 1 from transaction_splits s where s.transaction_id = tx.id)
  group by tx.category_id, tx.action;
$$;

-- Откат (если понадобится):
-- drop table public.transaction_splits;
-- и вернуть старую функцию month_category_totals без join на transaction_splits.
