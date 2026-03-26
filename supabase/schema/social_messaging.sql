-- Messaging + notification layer for friendships.
-- Run after social_profiles.sql.

create table if not exists public.user_notifications (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  type text not null,
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  check (type in ('friend_request', 'friend_accept', 'message'))
);

create index if not exists idx_user_notifications_user_created
  on public.user_notifications (user_id, created_at desc);

alter table public.user_notifications enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_notifications' and policyname = 'user_notifications_select_own'
  ) then
    create policy user_notifications_select_own
    on public.user_notifications
    for select
    using (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_notifications' and policyname = 'user_notifications_insert_own_actor'
  ) then
    create policy user_notifications_insert_own_actor
    on public.user_notifications
    for insert
    with check (auth.uid() = actor_user_id or auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_notifications' and policyname = 'user_notifications_update_own'
  ) then
    create policy user_notifications_update_own
    on public.user_notifications
    for update
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
  end if;
end $$;

create table if not exists public.user_messages (
  id bigserial primary key,
  sender_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  check (sender_user_id <> recipient_user_id),
  check (char_length(trim(body)) > 0)
);

create index if not exists idx_user_messages_pair_created
  on public.user_messages (sender_user_id, recipient_user_id, created_at desc);

alter table public.user_messages enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_messages' and policyname = 'user_messages_select_participants'
  ) then
    create policy user_messages_select_participants
    on public.user_messages
    for select
    using (auth.uid() = sender_user_id or auth.uid() = recipient_user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_messages' and policyname = 'user_messages_insert_friends_only'
  ) then
    create policy user_messages_insert_friends_only
    on public.user_messages
    for insert
    with check (
      auth.uid() = sender_user_id
      and exists (
        select 1
        from public.user_friendships f
        where f.status = 'accepted'
          and (
            (f.user_id = sender_user_id and f.friend_user_id = recipient_user_id)
            or
            (f.user_id = recipient_user_id and f.friend_user_id = sender_user_id)
          )
      )
    );
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'user_messages' and policyname = 'user_messages_update_recipient_read'
  ) then
    create policy user_messages_update_recipient_read
    on public.user_messages
    for update
    using (auth.uid() = recipient_user_id)
    with check (auth.uid() = recipient_user_id);
  end if;
end $$;
