create table if not exists public.wall_posts (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  title text not null,
  description text not null,
  ticket_image_url text,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  check (status in ('pending', 'approved', 'denied'))
);

create table if not exists public.wall_comments (
  id bigserial primary key,
  post_id bigint not null references public.wall_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_wall_posts_status_created on public.wall_posts(status, created_at desc);
create index if not exists idx_wall_comments_post_created on public.wall_comments(post_id, created_at asc);

alter table public.wall_posts enable row level security;
alter table public.wall_comments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='wall_posts' and policyname='wall_posts_select_public_approved'
  ) then
    create policy wall_posts_select_public_approved
    on public.wall_posts for select
    using (status = 'approved' or auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='wall_posts' and policyname='wall_posts_insert_own'
  ) then
    create policy wall_posts_insert_own
    on public.wall_posts for insert
    with check (auth.uid() = user_id);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='wall_comments' and policyname='wall_comments_select_public'
  ) then
    create policy wall_comments_select_public
    on public.wall_comments for select
    using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='wall_comments' and policyname='wall_comments_insert_own'
  ) then
    create policy wall_comments_insert_own
    on public.wall_comments for insert
    with check (auth.uid() = user_id);
  end if;
end $$;
