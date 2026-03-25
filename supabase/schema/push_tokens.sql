-- Expo push tokens for HR / watchlist alerts.
-- Run in Supabase SQL Editor after Auth is enabled.

create extension if not exists pgcrypto;

create table if not exists public.user_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  expo_push_token text not null,
  platform text,
  updated_at timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

create index if not exists user_push_tokens_user_id_idx on public.user_push_tokens (user_id);

alter table public.user_push_tokens enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_push_tokens' and policyname = 'push_tokens_select_own'
  ) then
    create policy push_tokens_select_own
    on public.user_push_tokens
    for select
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_push_tokens' and policyname = 'push_tokens_insert_own'
  ) then
    create policy push_tokens_insert_own
    on public.user_push_tokens
    for insert
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_push_tokens' and policyname = 'push_tokens_update_own'
  ) then
    create policy push_tokens_update_own
    on public.user_push_tokens
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_push_tokens' and policyname = 'push_tokens_delete_own'
  ) then
    create policy push_tokens_delete_own
    on public.user_push_tokens
    for delete
    using (auth.uid() = user_id);
  end if;
end $$;
