# Supabase 댓글 · 글 작성 UI · GA4 설계

**날짜:** 2026-08-15
**대상:** `Enitsed.github.io` (개인 사이트, GitHub Pages)
**목표:** 정적 사이트를 유지한 채 ① Supabase 기반 댓글, ② 브라우저에서 글을 발행하는 `/admin`, ③ GA4 측정을 붙인다. AdSense는 커스텀 도메인 확보 후로 미룬다.

**전제:** 현재 사이트는 JavaScript 파일이 하나도 없는 순수 정적 Jekyll 사이트이며, GitHub Pages 기본 Jekyll 빌드를 쓴다(`jekyll-paginate`, `jekyll-sitemap`만 사용). 커스텀 도메인 없음(`enitsed.github.io`).

---

## 1. 확정된 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 댓글 백엔드 | Supabase 직접 구현 | 데이터 소유권. giscus 대비 운영 부담은 감수 |
| 댓글 작성 권한 | 소셜 로그인 필수 (GitHub / Google) | 봇 스팸 차단, RLS가 `auth.uid()` 기준으로 단순해짐 |
| 댓글 본문 | 순수 텍스트 + 줄바꿈만 | 마크다운 허용 시 XSS sanitize를 직접 해야 함 |
| 글 작성 | Supabase Auth + Edge Function → GitHub 커밋 | 글이 git에 남아 SEO·RSS·태그 아카이브가 그대로 유지됨 |
| 측정 | GA4 지금, AdSense는 도메인 확보 후 | github.io 서브도메인은 `ads.txt`를 루트에 못 둠 |
| Supabase 일시정지 | GitHub Actions cron 핑으로 방지 | 무료 플랜은 7일 무요청 시 프로젝트 정지 |

### 명시적으로 채택하지 않은 것 (YAGNI)

대댓글, 좋아요/반응, 알림 메일, 댓글 수정 이력, 글 초안 저장, 이미지 업로드. 전부 1차 범위 밖이다. 필요해지면 별도 사이클로 다룬다.

---

## 2. 아키텍처

```
Jekyll / GitHub Pages (정적 HTML)        ← 빌드 방식 변경 없음
        │
        ├─ 댓글    : 브라우저 ESM → Supabase Auth + Postgres
        ├─ 글 작성 : /admin → Edge Function → GitHub Contents API → _posts/*.md
        └─ 측정    : GA4 gtag (production 빌드에서만)
```

**번들러를 도입하지 않는다.** `@supabase/supabase-js`를 esm.sh에서 ESM으로 직접 import한다.

```html
<script type="module">
  import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
</script>
```

번들러를 쓰려면 GitHub Pages 기본 빌드를 버리고 GitHub Actions 워크플로로 전환해야 하는데, 현재 규모에서는 이득보다 유지 비용이 크다. 대신 CDN 의존이 생기므로 import URL에 **버전을 고정**한다(`@2` 대신 정확한 마이너 버전 권장).

### 새로 추가되는 파일

| 파일 | 역할 |
|---|---|
| `_includes/comments.html` | 댓글 UI 마크업 + 스크립트 로드 |
| `assets/js/comments.js` | 댓글 조회·작성·삭제, 로그인 |
| `assets/js/admin.js` | 글 작성 폼, Edge Function 호출 |
| `assets/css/_comments.scss` | 댓글 스타일 |
| `assets/css/_admin.scss` | 글 작성 페이지 스타일 |
| `admin/index.html` | 글 작성 페이지 (noindex) |
| `privacy/index.md` | 개인정보처리방침 |
| `_includes/analytics.html` | GA4 gtag 스니펫 |
| `.github/workflows/supabase-keepalive.yml` | Supabase 일시정지 방지 cron |
| `supabase/functions/publish-post/index.ts` | 글 발행 Edge Function (배포용 소스) |

`_config.yml`에 추가할 키: `supabase_url`, `supabase_anon_key`, `ga4_id`, `admin_user_id`.

> anon key와 GA4 ID는 공개돼도 되는 값이다. anon key의 방어선은 전적으로 RLS이므로, 3절의 정책이 이 설계의 보안 핵심이다.

---

## 3. 데이터 모델과 RLS

```sql
create table public.comments (
  id           uuid primary key default gen_random_uuid(),
  post_slug    text not null,
  user_id      uuid not null references auth.users(id) on delete cascade,
  author_name  text not null,
  author_avatar text,
  body         text not null,
  created_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  constraint body_length check (char_length(body) between 1 and 2000),
  constraint slug_format check (post_slug ~ '^[a-z0-9가-힣-]{1,120}$')
);

create index comments_post_slug_idx on public.comments (post_slug, created_at);

alter table public.comments enable row level security;
```

### 정책

```sql
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
```

`DELETE` 정책은 만들지 않는다. 삭제는 `deleted_at`을 채우는 `UPDATE`로만 이뤄지며, 정책이 없으면 RLS가 기본 거부하므로 물리 삭제 경로가 닫힌다.

이 `UPDATE` 정책은 컬럼을 구분하지 않으므로, 작성자가 API를 직접 호출하면 `body`도 고칠 수 있다. 본인 댓글 수정은 허용해도 무방한 동작이라 그대로 둔다(UI에는 삭제 버튼만 노출). 다만 **관리자는 남의 댓글 본문까지 고칠 수 있다**는 뜻이므로, 그 권한을 원치 않으면 관리자 조건을 `deleted_at`만 바꾸도록 트리거로 좁혀야 한다. 1차에서는 단일 운영자이므로 좁히지 않는다.

`author_name`/`author_avatar`를 `with check`로 강제하지 않는 점은 의도적인 타협이다. 사용자가 표시 이름을 임의로 넣을 수 있으나, `user_id`가 위조 불가이므로 사칭 판별과 사후 삭제가 가능하다. 이름까지 강제하려면 JWT 클레임을 읽는 함수가 필요한데 1차 범위에서는 과하다.

### 속도 제한

```sql
create or replace function public.check_comment_rate_limit()
returns trigger language plpgsql security definer as $$
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
```

`security definer`가 필요한 이유: 트리거 안의 `select`가 RLS를 우회해 같은 사용자의 최근 댓글을 전부 세야 하기 때문이다. 함수 소유자를 신뢰할 수 있는 역할로 두고 `search_path`를 고정해야 한다.

---

## 4. 인증

- Supabase Auth의 GitHub·Google OAuth 프로바이더를 사용한다.
- 리디렉트 URL에 `https://enitsed.github.io/**`를 등록한다. 로컬 개발용으로 `http://localhost:4000/**`도 함께 등록한다.
- 로그인은 댓글 폼에서 `signInWithOAuth({ provider, options: { redirectTo: location.href } })`로 시작해 **읽던 글로 되돌아오게** 한다.
- 세션은 supabase-js가 localStorage에 보관한다. 별도 처리 없음.

---

## 5. 댓글 UI

`_layouts/post.html`의 이전/다음 네비 **아래**에 `{% include comments.html %}`를 넣는다. 글 식별자는 `page.slug`를 쓴다.

동작:

1. 페이지 로드 → `post_slug`로 댓글 조회 → 렌더
2. 비로그인 상태면 "GitHub으로 로그인 / Google로 로그인" 버튼만 노출
3. 로그인 상태면 textarea + 작성 버튼, 본인 댓글에는 삭제 버튼
4. 작성 성공 시 목록 앞에 낙관적으로 추가하지 않고 재조회한다 (트리거 거부를 사용자에게 정확히 알리기 위해)

**렌더링은 반드시 `textContent`로 한다.** 본문·이름·아바타 alt 어디에도 `innerHTML`을 쓰지 않는다. 줄바꿈은 CSS `white-space: pre-wrap`으로 처리한다. 아바타 URL은 `https://` 스킴만 허용한다.

에러 표시: 네트워크 실패, 속도 제한(P0001), 길이 초과를 각각 구분해 한국어 메시지로 보여준다. 프로젝트 일시정지 상태면 요청이 실패하므로 "댓글을 불러오지 못했습니다" 폴백을 노출하되, 글 본문 읽기는 영향받지 않아야 한다.

---

## 6. 글 작성 (`/admin`)

### 페이지

`admin/index.html` — 프론트매터에 `sitemap: false`, `<meta name="robots" content="noindex, nofollow">`를 넣는다. 저장소가 공개이므로 페이지 존재 자체는 숨길 수 없다. **접근 통제는 Edge Function에서만 이뤄진다.**

폼 필드: `title`, `slug`(제목에서 자동 생성, 수정 가능), `tags`(쉼표 구분), `excerpt`, `body`(마크다운). 미리보기는 1차 범위 밖.

### Edge Function `publish-post`

```
POST /functions/v1/publish-post
Authorization: Bearer <supabase access token>
{ title, slug, tags[], excerpt, body }
```

처리 순서:

1. `Authorization` 헤더의 JWT를 Supabase가 검증한 사용자로 해석
2. `user.id !== ADMIN_USER_ID`면 **403** 반환 — 이 한 줄이 유일한 권한 관문이다
3. 입력 검증: slug 형식, 길이 상한, 필수 필드
4. 프론트매터 + 본문으로 마크다운 문자열 조립. 제목·excerpt는 YAML 안전하게 인용 처리
5. GitHub Contents API로 커밋

```
PUT /repos/Enitsed/Enitsed.github.io/contents/_posts/YYYY-MM-DD-<slug>.md
{ message, content: <base64>, branch: "master" }
```

6. 커밋 **전에** 같은 경로를 `GET .../contents/<path>`로 조회해, 이미 있으면 함수가 **409**로 거절한다. 실수로 기존 글을 날리는 경로를 만들지 않는다.

> GitHub Contents API는 기존 파일을 갱신할 때 그 파일의 `sha`를 요구한다. 즉 `sha` 없이 PUT하면 GitHub 쪽에서도 실패하지만(422), 그 오류를 사용자에게 그대로 노출하면 원인을 알기 어렵다. 함수가 먼저 확인해 명확한 409와 한국어 메시지를 돌려준다. **`sha`를 채워 덮어쓰는 경로는 구현하지 않는다.**

GitHub PAT는 Edge Function 시크릿(`GITHUB_TOKEN`)에만 둔다. fine-grained PAT로 이 저장소의 `Contents: Read and write` 하나만 부여한다. `ADMIN_USER_ID`도 시크릿으로 둔다.

커밋 후 GitHub Pages 빌드까지 1~2분 걸리므로, UI에 "발행됨. 반영까지 1~2분 걸립니다" 안내와 커밋 URL을 표시한다.

---

## 7. GA4

`_includes/analytics.html`을 만들고 `head.html`에서 조건부로 include한다.

```liquid
{% if jekyll.environment == "production" and site.ga4_id %}
  {% include analytics.html %}
{% endif %}
```

로컬 `jekyll serve`는 `development` 환경이라 통계가 오염되지 않는다. GitHub Pages 빌드는 `production`이다.

---

## 8. 개인정보처리방침 (`/privacy/`)

수집·저장 항목을 사실 그대로 적는다.

- **GA4**: 방문 페이지, 리퍼러, 기기·브라우저 정보, 대략적 지역. IP는 Google이 처리 후 저장하지 않음
- **댓글**: 소셜 계정의 이메일·표시 이름·프로필 이미지 URL, 댓글 본문, 작성 시각
- **보관·삭제**: 본인 댓글은 직접 삭제 가능. 계정 삭제 요청은 이메일로
- **제3자**: Google(GA4), Supabase(댓글 저장)

푸터에 `/privacy/` 링크를 추가한다. AdSense 심사 필수 요건이라 지금 만들어 두면 나중에 재작업이 없다.

---

## 9. Supabase 일시정지 방지

```yaml
# .github/workflows/supabase-keepalive.yml
on:
  schedule:
    - cron: "0 3 * * 1,4"   # 주 2회
  workflow_dispatch:
```

`comments` 테이블에 `limit 1` 조회 요청을 anon key로 보낸다. 무료 플랜의 7일 유휴 기준보다 짧은 주기면 충분하다.

**알려진 한계:** GitHub은 저장소에 60일간 활동이 없으면 예약 워크플로를 자동 비활성화한다. 블로그를 계속 쓰면 문제되지 않지만, 장기간 방치하면 핑도 멈춘다는 점을 인지해야 한다. `workflow_dispatch`를 함께 두어 수동 실행이 가능하게 한다.

---

## 10. 보안 점검 목록

| 위협 | 대응 |
|---|---|
| anon key 노출 | 전제로 삼음. RLS가 유일한 방어선 (3절) |
| 남의 이름으로 댓글 작성 | `with check (auth.uid() = user_id)` |
| 댓글 XSS | `textContent`만 사용, `innerHTML` 금지 |
| 댓글 도배 | 트리거 속도 제한 (1분 5개) |
| 타인이 글 발행 | Edge Function의 `ADMIN_USER_ID` 대조, 403 |
| PAT 유출 | Edge Function 시크릿에만 보관, fine-grained·단일 저장소·contents만 |
| 기존 글 덮어쓰기 | 동일 경로 존재 시 409 |
| 물리 삭제 | `DELETE` 정책 미생성으로 경로 차단 |

---

## 11. 단계별 범위

| Phase | 내용 | 정슬기님이 직접 해야 할 일 |
|---|---|---|
| 1 | GA4 + `/privacy/` + 푸터 링크 | GA4 속성 생성, 측정 ID 전달 |
| 2 | 스키마·RLS·트리거, 댓글 UI, keepalive cron | Supabase 프로젝트 생성, GitHub/Google OAuth 앱 등록, URL·anon key·본인 uid 전달 |
| 3 | `/admin` + Edge Function 발행 | fine-grained PAT 발급, Edge Function 배포(`supabase functions deploy`) |

Phase 1은 계정 작업이 GA4 ID 하나뿐이라 먼저 끝낼 수 있다. Phase 2·3은 외부 계정 설정이 선행되어야 하므로, 그 시점에 필요한 값과 절차를 안내한다.

## 12. 범위 밖

- **AdSense** — 커스텀 도메인 확보 및 콘텐츠 축적 후 별도 사이클
- 커스텀 도메인 구입·DNS 설정
- 대댓글, 좋아요, 알림, 초안 저장, 이미지 업로드
- 댓글 마크다운 렌더링
