# 포트폴리오 + 블로그 재구성 설계

**날짜:** 2026-07-28
**대상:** `Enitsed.github.io` (개인 사이트, GitHub Pages)
**목표:** 기존 뚱이블로그(Gulp+Sass 스타터)를 걷어내고, 소프트웨어 개발자용 **포트폴리오 + 블로그**를 다크 테마로 새로 구축한다.

---

## 1. 개요

- **성격:** 포트폴리오가 메인, 블로그가 부. 소프트웨어/웹 개발 분야.
- **디자인 톤:** 다크 터미널 색감 + 컬러풀 카드 레이아웃 (다크 모드 고정, 라이트 토글 없음).
- **빌드/배포:** GitHub Pages 기본 Jekyll. `github-pages` gem으로 로컬 == 배포 환경 일치. push 시 자동 빌드.
- **콘텐츠:** 기존 포스트·페이지 전부 삭제하고 백지에서 시작 (git 히스토리로 복구 가능). 프로젝트는 지금 플레이스홀더(샘플 3~4개)로 구조만 잡고, 추후 이력서 기반으로 `_data/projects.yml`을 채워 교체.

## 2. 사이트 구조 & 페이지

| 경로 | 페이지 | 내용 |
|------|--------|------|
| `/` | 홈 | 히어로(`$ whoami` → Software Developer) + 대표 프로젝트 카드 그리드(featured) + 최신 글 3개 |
| `/work/` | 작업물 | 전체 프로젝트 카드 그리드, 태그 필터 |
| `/blog/` | 블로그 | 글 목록, 페이지네이션 12개 |
| `/blog/:title/` | 글 상세 | 본문 + 코드 하이라이트 + (선택)댓글 |
| `/about/` | 소개 | 프로필, 기술 스택, 연락처·소셜 링크 통합 |

- 네비게이션: `seulgi.dev` 로고 + `work / blog / about`
- 기존 `contact` → About에 통합, `tags` → blog 필터로 대체

## 3. 콘텐츠 모델

**프로젝트** — `_data/projects.yml` 단일 파일로 관리 (이력서로 채우기 쉽게):

```yaml
- title: Realtime Chat App
  description: 저지연 웹소켓 채팅 서비스
  tech: [React, WebSocket, Redis]
  link: https://...            # 라이브 데모 (선택)
  repo: https://github.com/... # 소스 (선택)
  gradient: blue-purple        # 썸네일 색 (이미지 없을 때)
  image:                       # 있으면 그라데이션 대신 사용 (선택)
  featured: true               # 홈 노출 여부
  year: 2024
```

- 이미지 없으면 `gradient` 값으로 카드 썸네일 자동 생성 → 이력서만으로도 채워짐.
- 초기엔 샘플 3~4개 포함.

**블로그 글** — `_posts/YYYY-MM-DD-slug.md`, front matter: `title`, `date`, `tags`, `excerpt`, (선택)`image`.

**사이트 정보** — `_config.yml`: 이름·소개·소셜 링크(기존 instagram/facebook/twitter/email 재사용).

## 4. 디자인 시스템

**색상 (Sass 변수)**

```
배경 #0d1117 · 카드 #161b22 · 테두리 #30363d
본문 #c9d1d9 · 흐린 텍스트 #8b949e · 제목 #e6edf3
포인트: 블루 #58a6ff · 퍼플 #a855f7 · 그린 #3fb950 · 핑크 #ec4899
그라데이션: blue→purple→pink (히어로 제목, 카드 썸네일)
```

**타이포그래피**

- 본문/제목: **Inter** (fallback: system sans)
- 코드·라벨·포인트(`$ whoami`, `// selected work`, 기술스택): **JetBrains Mono** (fallback: system mono)
- Google Fonts 로드.

**공통 요소**

- 둥근 카드(radius 14px) + 얇은 테두리 + hover 시 떠오르는 효과.
- 코드 블록: rouge + 다크 하이라이트.
- 반응형: 모바일 카드 1열, 데스크톱 2열.

## 5. 파일 구조 & 빌드

**삭제**

```
gulpfile.js, package.json, package-lock.json      # Gulp/node 빌드 제거
assets/css/sass/ (기존 전체)                       # Sass 새로 작성
_posts/* (2018 포스트 4개), _pages/*               # 콘텐츠 삭제
_includes/* (banner, disqus, newsletter 등 미사용) # 정리
assets/video/, assets/fonts/font-awesome           # 미사용 정리
```

**신규 생성**

```
Gemfile                     github-pages gem
_config.yml                 사이트 정보·플러그인 (jekyll-paginate, jekyll-sitemap)
_data/projects.yml          프로젝트 데이터 (샘플 3~4개)
_layouts/                   default, home, page, post
_includes/                  head, nav, footer, project-card, post-card
_pages/                     work.html, blog.html, about.md
_posts/                     샘플 글 1~2개
assets/css/main.scss        Sass 진입점 (Jekyll 내장 컴파일)
assets/css/_variables.scss, _base.scss, _layout.scss, _components.scss, _syntax.scss
index.html                  홈
```

**빌드/로컬 확인**

- 로컬: `bundle exec jekyll serve` (Ruby 3.4.10 + Jekyll 설치 완료).
- 배포: push → GitHub Pages 자동 빌드.

## 6. 구성 요소별 책임 (isolation)

- **layouts/default** — `<html>` 골격, head/nav/footer include, 공통 컨테이너.
- **layouts/home** — 히어로 + featured 프로젝트 + 최신 글. `_data/projects.yml`와 `site.posts` 소비.
- **layouts/page** — work/about 등 정적 페이지 래퍼.
- **layouts/post** — 글 상세, 코드 하이라이트, 메타.
- **includes/project-card** — 프로젝트 1개 → 카드 HTML. 입력: project 객체. gradient/image 분기.
- **includes/post-card** — 글 1개 → 카드/행 HTML. 입력: post 객체.
- **\_components.scss** — 카드·버튼·태그·네비 스타일. **\_variables.scss** 토큰만 의존.

각 include는 하나의 데이터 객체를 받아 하나의 UI 조각을 렌더한다. 내부를 바꿔도 소비처(layout)는 영향받지 않는다.

## 7. 범위 밖 (YAGNI)

- 라이트/다크 토글, 다국어, 검색, 뉴스레터, 애니메이션 배너 비디오.
- 댓글은 선택 사항으로 남김(기본 비활성, 원하면 Disqus/utterances 추가).
- 프로젝트 상세 케이스 스터디 페이지(추후 필요 시 collection으로 확장).
