-- 댓글 스키마 · RLS · 속도 제한
--
-- 적용: Supabase 대시보드의 SQL Editor 에 붙여넣고 실행한다.
-- 실행 전 아래 <ADMIN_UUID> 를 관리자 계정의 auth.users.id 로 바꿔야 한다.
-- (한 번 로그인한 뒤 select id, email from auth.users; 로 확인)

create table public.comments (
  id            uuid primary key default gen_random_uuid(),
  post_slug     text not null,
  user_id       uuid not null references auth.users(id) on delete cascade,
  author_name   text not null,
  author_avatar text,
  body          text not null,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint body_length check (char_length(body) between 1 and 2000),
  constraint slug_format check (post_slug ~ '^[a-z0-9가-힣-]{1,120}$')
);

create index comments_post_slug_idx on public.comments (post_slug, created_at);

alter table public.comments enable row level security;

-- 읽기: 누구나, 삭제되지 않은 것만
create policy comments_select on public.comments
  for select using (deleted_at is null);

-- 작성: 로그인 사용자가 자기 이름으로만
create policy comments_insert on public.comments
  for insert to authenticated
  with check (auth.uid() = user_id and deleted_at is null);

-- 삭제(소프트): 본인 또는 관리자
create policy comments_update on public.comments
  for update to authenticated
  using (auth.uid() = user_id or auth.uid() = '<ADMIN_UUID>')
  with check (auth.uid() = user_id or auth.uid() = '<ADMIN_UUID>');

-- DELETE 정책은 만들지 않는다. RLS 가 기본 거부하므로 물리 삭제 경로가 닫힌다.

-- 속도 제한: 1분에 5개
-- security definer 가 필요한 이유 — 트리거 안의 select 가 RLS 를 우회해
-- 같은 사용자의 최근 댓글을 전부 세야 하기 때문이다.
create or replace function public.check_comment_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare recent_count int;
begin
  select count(*) into recent_count
  from public.comments
  where user_id = new.user_id and created_at > now() - interval '1 minute';

  if recent_count >= 5 then
    raise exception 'rate limit exceeded' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger comments_rate_limit
  before insert on public.comments
  for each row execute function public.check_comment_rate_limit();
