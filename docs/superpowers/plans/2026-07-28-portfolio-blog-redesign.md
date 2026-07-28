# 포트폴리오 + 블로그 재구성 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 뚱이블로그(Gulp+Sass 스타터)를 걷어내고, 정슬기(Backend/DevOps/Smart Contract Developer)의 포트폴리오 + 블로그를 다크 테마 Jekyll 사이트로 새로 구축한다.

**Architecture:** GitHub Pages 기본 Jekyll(`github-pages` gem)로 빌드. Jekyll 내장 Sass로 스타일 컴파일. 페이지는 디렉터리 기반 URL(`/`, `/work/`, `/blog/`, `/about/`), 글은 `/blog/:title/`. 프로젝트 데이터는 `_data/projects.yml` 단일 파일로 관리하고 include가 카드로 렌더한다.

**Tech Stack:** Jekyll (github-pages gem), Liquid, Sass(SCSS), kramdown + rouge, jekyll-paginate, jekyll-sitemap, Google Fonts(Inter, JetBrains Mono).

## Global Constraints

- **Ruby 실행 환경:** Ruby 3.4.10이 `C:\tools\ruby34`에 설치돼 있음. 모든 명령 전에 PATH를 잡을 것. Git Bash: `export PATH="/c/tools/ruby34/bin:$PATH"`. PowerShell: `$env:Path = "C:\tools\ruby34\bin;$env:Path"`.
- **빌드 == 배포 일치:** 로컬은 `bundle exec jekyll build`/`serve`로 실행. `github-pages` gem 버전을 Gemfile에 고정.
- **다크 모드 고정.** 라이트 토글 없음.
- **개인정보 금지:** 전화번호·집주소·생년을 어떤 파일에도 넣지 말 것. 이메일(sllki1@naver.com)·GitHub·소셜만.
- **디자인 토큰(정확히 사용):** bg `#0d1117`, surface `#161b22`, border `#30363d`, text `#c9d1d9`, muted `#8b949e`, heading `#e6edf3`, accent-blue `#58a6ff`, accent-purple `#a855f7`, accent-green `#3fb950`, accent-pink `#ec4899`.
- **폰트:** 본문/제목 Inter, 코드·라벨·모노 포인트 JetBrains Mono.
- **"테스트 사이클":** 정적 사이트이므로 각 태스크의 검증은 `bundle exec jekyll build` 성공 + 생성된 `_site/` 산출물에 기대 문자열이 존재하는지 grep으로 확인한다.
- **커밋:** 태스크마다 커밋. 커밋 메시지는 한국어 관용(`feat:`, `chore:`, `style:` 접두어).

---

## File Structure

**삭제 (기존 Gulp 파이프라인 + 콘텐츠):**
```
gulpfile.js, package.json, package-lock.json
_posts/2018-*.md (4개)
_pages/ (about.html, contact.html, tags.html)
_includes/ (analytics, arrow_top, banner, disqus, head, header,
            javascripts, newsletter, pagination, social_footer — 전부)
_layouts/ (default.html, main.html, post.html — 전부, 새로 작성)
assets/css/ (main.css, sass/ 전체)
assets/js/ (custom.js, jquery-*.js, jquery.vide.min.js)
assets/video/, assets/fonts/font-awesome/
index.html (새로 작성)
```

**신규 생성:**
```
Gemfile                         github-pages gem
_config.yml                     사이트 정보·플러그인 (덮어씀)
index.html                      홈 (layout: home)
work/index.html                 /work/ 전체 프로젝트
blog/index.html                 /blog/ 글 목록(페이지네이션)
about/index.html                /about/ 소개
404.html                        Not Found
_data/projects.yml              프로젝트 데이터 (실제 6개)
_data/social.yml                소셜 링크
_layouts/default.html           HTML 골격
_layouts/home.html              홈 콘텐츠
_layouts/page.html              정적 페이지 래퍼
_layouts/post.html              글 상세
_includes/head.html             <head> 메타·폰트·CSS
_includes/nav.html              상단 네비
_includes/footer.html           하단
_includes/project-card.html     프로젝트 카드 1개
_includes/post-card.html        글 카드/행 1개
assets/css/main.scss            Sass 진입점(front matter 필수)
assets/css/_variables.scss      토큰
assets/css/_base.scss           리셋·타이포·기본
assets/css/_layout.scss         컨테이너·nav·footer·그리드
assets/css/_components.scss      카드·버튼·태그·히어로
assets/css/_syntax.scss         rouge 다크 하이라이트
_posts/2026-07-20-hello-world.md          샘플 글
_posts/2026-07-25-websocket-reconnect.md  샘플 글(코드블록 포함)
```

---

### Task 1: 클린 슬레이트 + 빌드 설정

기존 Gulp/콘텐츠 삭제, Gemfile·_config.yml 작성, 빈 빌드 성공까지.

**Files:**
- Delete: `gulpfile.js`, `package.json`, `package-lock.json`, `_posts/2018-*`, `_pages/`, `_includes/*`, `_layouts/*`, `assets/css/`, `assets/js/`, `assets/video/`, `assets/fonts/font-awesome/`, `index.html`
- Create: `Gemfile`, `_config.yml`

- [ ] **Step 1: 기존 파일 삭제**

Git Bash에서:
```bash
cd "C:/Users/enitsed/Enitsed.github.io"
git rm -r --quiet gulpfile.js package.json package-lock.json \
  _posts _pages _includes _layouts \
  "assets/css" "assets/js" "assets/video" "assets/fonts/font-awesome" \
  index.html
```
(파일명에 한글이 있는 `_posts`는 디렉터리째 삭제되므로 문제없음)

- [ ] **Step 2: `Gemfile` 작성**

```ruby
source "https://rubygems.org"

gem "github-pages", group: :jekyll_plugins
gem "webrick", "~> 1.8"        # Ruby 3.x 로컬 serve 용

# Windows/JRuby 타임존 데이터
gem "tzinfo-data", platforms: [:mingw, :x64_mingw, :mswin, :jruby]
gem "wdm", "~> 0.1", platforms: [:mingw, :x64_mingw, :mswin]
```

- [ ] **Step 3: `_config.yml` 작성**

```yaml
title: SeulGi Jeong
tagline: Backend · DevOps · Smart Contract Developer
description: >-
  정슬기(SeulGi Jeong) — 백엔드/DevOps/스마트컨트랙트 개발자의 포트폴리오와 블로그.
author: SeulGi Jeong
email: sllki1@naver.com
url: "https://enitsed.github.io"
baseurl: ""
lang: ko

# 페이지네이션 (blog/index.html 대상)
paginate: 12
paginate_path: "/blog/page:num/"

# 글 URL
permalink: /blog/:title/

# 빌드
markdown: kramdown
highlighter: rouge
kramdown:
  input: GFM
  syntax_highlighter: rouge

sass:
  style: compressed

plugins:
  - jekyll-paginate
  - jekyll-sitemap

exclude:
  - Gemfile
  - Gemfile.lock
  - README.md
  - LICENSE.txt
  - docs
  - .superpowers
  - vendor
```

- [ ] **Step 4: `bundle install`**

Git Bash:
```bash
export PATH="/c/tools/ruby34/bin:$PATH"
cd "C:/Users/enitsed/Enitsed.github.io"
bundle install
```
Expected: `Bundle complete!` (github-pages gem과 의존성 설치). Gemfile.lock 생성됨.

- [ ] **Step 5: 빈 빌드 확인**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
```
Expected: `done in N seconds` 출력, 에러 없음. (아직 페이지가 없어 `_site`는 거의 빔 — 정상)

- [ ] **Step 6: `.gitignore`에 Gemfile.lock 유지 여부/vendor 추가**

`.gitignore`에 다음 줄이 없으면 추가:
```
_site
.jekyll-cache/
.jekyll-metadata
.sass-cache
vendor/
```
(Gemfile.lock은 커밋한다 — 배포 재현성)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: Gulp 파이프라인·기존 콘텐츠 제거, github-pages Jekyll 설정"
```

---

### Task 2: Sass 디자인 시스템

토큰·리셋·기본 타이포 + 컴파일 진입점. CSS가 생성되는 것까지.

**Files:**
- Create: `assets/css/main.scss`, `assets/css/_variables.scss`, `assets/css/_base.scss`, `assets/css/_layout.scss` (레이아웃 뼈대만; 상세는 Task 3/4에서 채움)

**Interfaces:**
- Produces: SCSS 변수 `$bg,$surface,$border,$text,$muted,$heading,$blue,$purple,$green,$pink`, mixin `gradient($name)`, `.container` 클래스. 이후 태스크가 이 변수/믹스인을 `@import`로 사용.

- [ ] **Step 1: `assets/css/_variables.scss`**

```scss
// ── 색상 토큰 ──
$bg:      #0d1117;
$surface: #161b22;
$border:  #30363d;
$text:    #c9d1d9;
$muted:   #8b949e;
$heading: #e6edf3;

$blue:   #58a6ff;
$purple: #a855f7;
$green:  #3fb950;
$pink:   #ec4899;
$orange: #fb923c;

// ── 폰트 ──
$sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
$mono: "JetBrains Mono", "SF Mono", Consolas, Menlo, monospace;

// ── 레이아웃 ──
$radius: 14px;
$maxw: 960px;

// ── 그라데이션 이름 → 색 ──
@mixin gradient($name) {
  @if $name == blue-purple   { background: linear-gradient(135deg, #1f6feb, $purple); }
  @else if $name == purple-pink { background: linear-gradient(135deg, $purple, $pink); }
  @else if $name == pink-orange { background: linear-gradient(135deg, $pink, $orange); }
  @else if $name == green-blue  { background: linear-gradient(135deg, $green, $blue); }
  @else { background: linear-gradient(135deg, $blue, $purple); }
}
```

- [ ] **Step 2: `assets/css/_base.scss`**

```scss
*, *::before, *::after { box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  margin: 0;
  background: $bg;
  color: $text;
  font-family: $sans;
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

h1, h2, h3, h4 { color: $heading; font-weight: 700; line-height: 1.2; }

a { color: $blue; text-decoration: none; }
a:hover { text-decoration: underline; }

code, pre { font-family: $mono; }

img { max-width: 100%; height: auto; display: block; }

// 모노 라벨 (예: `$ whoami`, `// selected work`)
.mono-label {
  font-family: $mono;
  color: $muted;
  font-size: 0.85rem;
  letter-spacing: 0.02em;
}
```

- [ ] **Step 3: `assets/css/_layout.scss`**

```scss
.container {
  width: 100%;
  max-width: $maxw;
  margin: 0 auto;
  padding: 0 20px;
}

.section { margin: 56px 0; }

.grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 16px;
}
@media (min-width: 640px) {
  .grid-2 { grid-template-columns: 1fr 1fr; }
}
```

- [ ] **Step 4: `assets/css/main.scss` (진입점 — front matter 필수)**

파일 맨 위 빈 front matter가 있어야 Jekyll이 Sass로 처리한다.
```scss
---
---

@import "variables";
@import "base";
@import "layout";
@import "components";
@import "syntax";
```
> 주의: 아직 없는 `components`, `syntax`는 Task 4/8에서 만든다. 이 단계에서 빌드하면 import 에러가 나므로, **이 두 줄은 지금은 주석 처리**하고 해당 태스크에서 해제한다:
```scss
// @import "components";
// @import "syntax";
```

- [ ] **Step 5: 빌드 & CSS 생성 확인**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
grep -c "background:#0d1117\|#0d1117" _site/assets/css/main.css
```
Expected: `main.css`가 생성되고 grep 카운트 ≥ 1 (compressed CSS에 bg 색 존재).

- [ ] **Step 6: Commit**

```bash
git add assets/css
git commit -m "style: 다크 디자인 시스템 토큰·기본 스타일 추가"
```

---

### Task 3: default 레이아웃 + head/nav/footer

전 페이지 공통 골격. 빈 페이지 하나로 렌더 확인.

**Files:**
- Create: `_layouts/default.html`, `_includes/head.html`, `_includes/nav.html`, `_includes/footer.html`, `_data/social.yml`
- Test(임시): 루트에 `index.html`(최소 스텁) — Task 5에서 홈으로 대체

**Interfaces:**
- Produces: `layout: default`. `nav.html`은 `/work/ /blog/ /about/` 링크와 `seulgi.dev` 로고. `footer.html`은 `_data/social.yml` 반복.

- [ ] **Step 1: `_data/social.yml`**

```yaml
- name: GitHub
  url: https://github.com/Enitsed
- name: Instagram
  url: https://www.instagram.com/sllki1/
- name: Twitter
  url: https://twitter.com/sllki11
- name: Email
  url: mailto:sllki1@naver.com
```

- [ ] **Step 2: `_includes/head.html`**

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{% if page.title %}{{ page.title }} · {{ site.title }}{% else %}{{ site.title }} · {{ site.tagline }}{% endif %}</title>
<meta name="description" content="{{ page.description | default: site.description }}">
<meta name="author" content="{{ site.author }}">

<!-- Open Graph -->
<meta property="og:title" content="{{ page.title | default: site.title }}">
<meta property="og:description" content="{{ page.description | default: site.description }}">
<meta property="og:type" content="website">
<meta property="og:url" content="{{ page.url | absolute_url }}">

<!-- Fonts -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">

<link rel="stylesheet" href="{{ '/assets/css/main.css' | relative_url }}">
<link rel="alternate" type="application/rss+xml" title="{{ site.title }}" href="{{ '/feed.xml' | relative_url }}">
```

- [ ] **Step 3: `_includes/nav.html`**

```html
<nav class="nav">
  <div class="container nav__inner">
    <a class="nav__logo" href="{{ '/' | relative_url }}">seulgi.dev</a>
    <div class="nav__links">
      <a href="{{ '/work/' | relative_url }}"{% if page.url contains '/work' %} class="is-active"{% endif %}>work</a>
      <a href="{{ '/blog/' | relative_url }}"{% if page.url contains '/blog' %} class="is-active"{% endif %}>blog</a>
      <a href="{{ '/about/' | relative_url }}"{% if page.url contains '/about' %} class="is-active"{% endif %}>about</a>
    </div>
  </div>
</nav>
```

- [ ] **Step 4: `_includes/footer.html`**

```html
<footer class="footer">
  <div class="container footer__inner">
    <div class="footer__social">
      {% for s in site.data.social %}
        <a href="{{ s.url }}"{% unless s.url contains 'mailto' %} target="_blank" rel="noopener"{% endunless %}>{{ s.name }}</a>
      {% endfor %}
    </div>
    <p class="mono-label">© {{ 'now' | date: "%Y" }} {{ site.author }} · built with Jekyll</p>
  </div>
</footer>
```

- [ ] **Step 5: `_layouts/default.html`**

```html
<!DOCTYPE html>
<html lang="{{ site.lang | default: 'ko' }}">
<head>
  {% include head.html %}
</head>
<body>
  {% include nav.html %}
  <main class="container">
    {{ content }}
  </main>
  {% include footer.html %}
</body>
</html>
```

- [ ] **Step 6: nav/footer 스타일을 `_layout.scss`에 추가**

`assets/css/_layout.scss` 끝에 append:
```scss
.nav {
  border-bottom: 1px solid $border;
  position: sticky; top: 0; z-index: 10;
  background: rgba(13,17,23,0.85);
  backdrop-filter: blur(8px);
}
.nav__inner { display: flex; justify-content: space-between; align-items: center; height: 60px; }
.nav__logo { font-family: $mono; font-weight: 600; color: $blue; }
.nav__logo:hover { text-decoration: none; }
.nav__links a { color: $muted; margin-left: 18px; font-size: 0.95rem; }
.nav__links a:hover, .nav__links a.is-active { color: $heading; text-decoration: none; }

.footer { border-top: 1px solid $border; margin-top: 80px; padding: 32px 0; }
.footer__inner { display: flex; flex-direction: column; gap: 12px; }
.footer__social a { color: $muted; margin-right: 16px; font-size: 0.9rem; }
.footer__social a:hover { color: $blue; }
```

- [ ] **Step 7: 임시 홈 스텁 `index.html`**

```html
---
layout: default
title: Home
---
<h1>SeulGi Jeong</h1>
```

- [ ] **Step 8: 빌드 & 검증**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
grep -q "seulgi.dev" _site/index.html && grep -q "JetBrains+Mono" _site/index.html && echo OK
```
Expected: `OK` (nav 로고와 폰트 링크가 렌더됨).

- [ ] **Step 9: Commit**

```bash
git add _layouts/default.html _includes _data/social.yml assets/css/_layout.scss index.html
git commit -m "feat: default 레이아웃 + nav/footer/head include"
```

---

### Task 4: 프로젝트 데이터 + 카드 컴포넌트

`_data/projects.yml`(실제 6개) + `project-card` include + 카드 CSS. `/work/`에서 확인.

**Files:**
- Create: `_data/projects.yml`, `_includes/project-card.html`, `assets/css/_components.scss`, `work/index.html`
- Modify: `assets/css/main.scss` (components import 주석 해제)

**Interfaces:**
- Consumes: `_variables.scss`의 `gradient()` 믹스인.
- Produces: `{% include project-card.html project=... %}` — 입력은 project 객체(title, role, description, tech[], link?, repo?, gradient, featured, year). 카드 HTML 렌더.

- [ ] **Step 1: `_data/projects.yml` (실제 이력 기반)**

```yaml
- title: 엑스클루시브 (Xclusive)
  role: 백엔드/서버개발 · 팀장 · ㈜핑거랩스
  description: NFT(ERC721)로 접근 권한을 인증하는 디지털 콘텐츠 스트리밍 플랫폼. MSA API·데이터 모델 설계, 자동 트랜스코딩, 유료 콘텐츠 접근 제어.
  tech: [TypeScript, Express, "AWS (EKS/ECS)", Docker, GitHub Actions, MySQL, Redis, Grafana, Prometheus]
  highlights:
    - S3+Lambda+MediaConvert 자동 트랜스코딩, CloudFront Signed Cookie 유료 접근 제어
    - EKS→ECS 무중단 전환으로 인프라 비용 절감
  link: https://xclusive.market/ko
  gradient: blue-purple
  featured: true
  year: 2022

- title: 네고홈 (NegoHome)
  role: 백엔드/서버개발 · 팀장 · ㈜핑거랩스
  description: 사용자와 중개사를 잇는 부동산 중개 플랫폼. 인앱 결제 멤버십 구독, 핵심 도메인 모델·API 설계 및 CI/CD 구축.
  tech: [TypeScript, Next.js, Prisma, MySQL, Jenkins, "AWS EC2"]
  highlights:
    - 부동산 매물·회원·거래 제안 도메인 모델 설계 및 스키마 관리
    - Jenkins 기반 개발/프로덕션 CI/CD 파이프라인 구축
  link: https://app.negohome.net/
  gradient: green-blue
  featured: true
  year: 2023

- title: 선미야클럽 (Sunmiya Club)
  role: 스마트컨트랙트 개발 · ㈜핑거랩스
  description: ERC721 NFT 기반 멤버십 프로젝트. 스마트컨트랙트 개발·판매 운영, 온체인 이벤트 인덱싱, 오프라인 행사용 NFT 인증.
  tech: [Solidity, ERC721, TheGraph, TypeScript, Node.js]
  highlights:
    - TheGraph로 스마트컨트랙트 이벤트 감지 시스템 구축
    - 오프라인 이벤트 참여용 NFT 인증 시스템 구현
  gradient: purple-pink
  featured: true
  year: 2023

- title: 페이버릿 / 페이버스테이션
  role: 백엔드 · 스마트컨트랙트 · ㈜핑거랩스
  description: 토크노믹스 채굴/Vault 컨트랙트와 간편로그인 기반 온체인 지갑 연동. 구글·애플 계정으로 지갑을 연결하고 서명을 수행.
  tech: [Solidity, "ERC-4337", TypeScript, Grafana, Prometheus]
  highlights:
    - 구글/애플 계정 + 온체인 지갑 연동(계정 추상화)
    - Grafana/Prometheus 온체인 데이터 모니터링
  gradient: pink-orange
  featured: true
  year: 2023

- title: PeriFinance
  role: 스마트컨트랙트 개발
  description: DeFi DEX Swap dApp. Solidity 기반 DeFi 서비스 스마트컨트랙트와 Oracle 컨트랙트 개발·배포·운영.
  tech: [Solidity, DeFi, Oracle, TypeScript]
  gradient: blue-purple
  featured: false
  year: 2021

- title: 하이퍼라이프케어
  role: 백엔드/DevOps · 팀장 · ㈜하이퍼코퍼레이션
  description: 레거시 마이그레이션과 인프라 최적화. PHP→TypeScript 포팅, AWS Cognito 인증 전환, RDS Blue-Green 무중단 업그레이드.
  tech: [TypeScript, "AWS Cognito", "AWS RDS", Docker]
  gradient: green-blue
  featured: false
  year: 2024
```

- [ ] **Step 2: `_includes/project-card.html`**

```html
{% assign p = include.project %}
<article class="card">
  <div class="card__thumb grad--{{ p.gradient | default: 'blue-purple' }}">
    <span class="card__year mono-label">{{ p.year }}</span>
  </div>
  <div class="card__body">
    <h3 class="card__title">{{ p.title }}</h3>
    {% if p.role %}<p class="card__role mono-label">{{ p.role }}</p>{% endif %}
    <p class="card__desc">{{ p.description }}</p>
    {% if p.tech %}
    <ul class="card__tech">
      {% for t in p.tech %}<li>{{ t }}</li>{% endfor %}
    </ul>
    {% endif %}
    <div class="card__links">
      {% if p.link %}<a href="{{ p.link }}" target="_blank" rel="noopener">Live ↗</a>{% endif %}
      {% if p.repo %}<a href="{{ p.repo }}" target="_blank" rel="noopener">Code ↗</a>{% endif %}
    </div>
  </div>
</article>
```

- [ ] **Step 3: `assets/css/_components.scss`**

```scss
// ── 그라데이션 클래스 ──
.grad--blue-purple  { @include gradient(blue-purple); }
.grad--purple-pink  { @include gradient(purple-pink); }
.grad--pink-orange  { @include gradient(pink-orange); }
.grad--green-blue   { @include gradient(green-blue); }

// ── 프로젝트 카드 ──
.card {
  background: $surface;
  border: 1px solid $border;
  border-radius: $radius;
  overflow: hidden;
  display: flex; flex-direction: column;
  transition: transform .18s ease, border-color .18s ease;
}
.card:hover { transform: translateY(-4px); border-color: $blue; }
.card__thumb { height: 96px; position: relative; }
.card__year { position: absolute; top: 10px; right: 12px; color: rgba(255,255,255,.85); }
.card__body { padding: 16px; }
.card__title { margin: 0 0 4px; font-size: 1.15rem; }
.card__role { margin: 0 0 10px; font-size: 0.78rem; }
.card__desc { margin: 0 0 12px; color: $text; font-size: 0.95rem; }
.card__tech { list-style: none; padding: 0; margin: 0 0 14px; display: flex; flex-wrap: wrap; gap: 6px; }
.card__tech li {
  font-family: $mono; font-size: 0.72rem; color: $blue;
  border: 1px solid $border; border-radius: 20px; padding: 2px 9px;
}
.card__links a { font-family: $mono; font-size: 0.85rem; margin-right: 14px; }

// ── 섹션 헤더 ──
.section-head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 18px; }
.section-head a { font-family: $mono; font-size: 0.85rem; color: $muted; }
.section-head a:hover { color: $blue; text-decoration: none; }
```

- [ ] **Step 4: `main.scss`에서 components import 주석 해제**

`assets/css/main.scss`의 `// @import "components";` → `@import "components";`

- [ ] **Step 5: `work/index.html`**

```html
---
layout: default
title: Work
description: 정슬기의 프로젝트 모음 — 백엔드, DevOps, 스마트컨트랙트.
---
<div class="section">
  <p class="mono-label">// all projects</p>
  <h1>Work</h1>
  <div class="grid grid-2">
    {% for p in site.data.projects %}
      {% include project-card.html project=p %}
    {% endfor %}
  </div>
</div>
```

- [ ] **Step 6: 빌드 & 검증**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
grep -q "엑스클루시브" _site/work/index.html \
  && grep -q "grad--blue-purple" _site/work/index.html \
  && grep -q "xclusive.market" _site/work/index.html && echo OK
```
Expected: `OK` — 6개 프로젝트가 카드로 렌더되고 링크/그라데이션 클래스 존재.

- [ ] **Step 7: Commit**

```bash
git add _data/projects.yml _includes/project-card.html assets/css/_components.scss assets/css/main.scss work/index.html
git commit -m "feat: 프로젝트 데이터·카드 컴포넌트 + /work 페이지"
```

---

### Task 5: 홈 (히어로 + featured + 최신 글)

**Files:**
- Create: `_layouts/home.html`
- Modify: `index.html` (스텁 → 홈), `assets/css/_components.scss` (히어로 스타일 추가)

**Interfaces:**
- Consumes: `project-card.html`, `site.data.projects`(featured 필터), `site.posts`.
- Produces: `layout: home`.

- [ ] **Step 1: 히어로 스타일을 `_components.scss`에 추가**

파일 끝에 append:
```scss
// ── 히어로 ──
.hero { padding: 72px 0 40px; position: relative; overflow: hidden; }
.hero__glow-a, .hero__glow-b { position: absolute; border-radius: 50%; filter: blur(10px); pointer-events: none; }
.hero__glow-a { top: -80px; right: -60px; width: 300px; height: 300px;
  background: radial-gradient(circle, rgba(31,111,235,.33), transparent 70%); }
.hero__glow-b { bottom: -100px; left: -50px; width: 260px; height: 260px;
  background: radial-gradient(circle, rgba(168,85,247,.22), transparent 70%); }
.hero__inner { position: relative; z-index: 1; }
.hero__title { font-size: clamp(2.2rem, 6vw, 3.4rem); margin: 10px 0 14px; }
.hero__title .grad-text {
  background: linear-gradient(90deg, $blue, $purple, $pink);
  -webkit-background-clip: text; background-clip: text; color: transparent;
}
.hero__title .cursor { color: $green; }
.hero__desc { color: $muted; font-size: 1.1rem; max-width: 520px; }
.hero__cta { margin-top: 22px; display: flex; gap: 12px; }
.btn {
  font-family: $mono; font-size: 0.9rem; padding: 9px 16px; border-radius: 10px;
  border: 1px solid $border; color: $heading; background: $surface;
}
.btn:hover { border-color: $blue; text-decoration: none; }
.btn--primary { border-color: $blue; color: $blue; }

// ── 최신 글 목록(행) ──
.post-row { display: flex; justify-content: space-between; gap: 16px;
  padding: 14px 0; border-bottom: 1px solid $border; }
.post-row:hover .post-row__title { color: $blue; }
.post-row__title { color: $heading; font-weight: 500; }
.post-row__date { color: $muted; font-family: $mono; font-size: 0.85rem; white-space: nowrap; }
```

- [ ] **Step 2: `_layouts/home.html`**

```html
---
layout: default
---
<section class="hero">
  <span class="hero__glow-a"></span>
  <span class="hero__glow-b"></span>
  <div class="hero__inner">
    <p class="mono-label">$ whoami</p>
    <h1 class="hero__title">Backend · DevOps<br><span class="grad-text">Smart Contract</span> Developer<span class="cursor">_</span></h1>
    <p class="hero__desc">{{ site.description }}</p>
    <div class="hero__cta">
      <a class="btn btn--primary" href="{{ '/work/' | relative_url }}">View Work</a>
      <a class="btn" href="{{ '/about/' | relative_url }}">About Me</a>
    </div>
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="mono-label">// selected work</p>
    <a href="{{ '/work/' | relative_url }}">all →</a>
  </div>
  <div class="grid grid-2">
    {% assign featured = site.data.projects | where: "featured", true %}
    {% for p in featured %}
      {% include project-card.html project=p %}
    {% endfor %}
  </div>
</section>

<section class="section">
  <div class="section-head">
    <p class="mono-label">// from the blog</p>
    <a href="{{ '/blog/' | relative_url }}">all →</a>
  </div>
  {% for post in site.posts limit: 3 %}
    <a class="post-row" href="{{ post.url | relative_url }}">
      <span class="post-row__title">{{ post.title }}</span>
      <span class="post-row__date">{{ post.date | date: "%Y.%m" }}</span>
    </a>
  {% endfor %}
</section>
```

- [ ] **Step 3: `index.html` 교체**

```html
---
layout: home
---
```
(홈은 레이아웃이 전부 렌더하므로 본문 비움)

- [ ] **Step 4: 빌드 & 검증**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
grep -q "whoami" _site/index.html \
  && grep -q "grad-text" _site/index.html \
  && grep -q "엑스클루시브" _site/index.html && echo OK
```
Expected: `OK` — 히어로 + featured 프로젝트가 홈에 렌더됨. (최신 글은 Task 7에서 샘플 추가 후 채워짐)

- [ ] **Step 5: Commit**

```bash
git add _layouts/home.html index.html assets/css/_components.scss
git commit -m "feat: 홈 히어로 + featured 프로젝트 + 최신 글 섹션"
```

---

### Task 6: 블로그 목록 + 글 카드 + 페이지네이션 + 샘플 글

**Files:**
- Create: `blog/index.html`, `_includes/post-card.html`, `_posts/2026-07-20-hello-world.md`, `_posts/2026-07-25-websocket-reconnect.md`
- Modify: `assets/css/_components.scss` (페이지네이션 스타일)

**Interfaces:**
- Consumes: `paginator.posts`(jekyll-paginate), `post-card.html`.
- Produces: `{% include post-card.html post=... %}` — post 객체 → 카드 렌더.

- [ ] **Step 1: 샘플 글 `_posts/2026-07-20-hello-world.md`**

```markdown
---
layout: post
title: "블로그를 새로 시작합니다"
date: 2026-07-20
tags: [잡담, dev]
excerpt: "포트폴리오와 함께 개발 블로그를 다시 시작합니다. 백엔드·DevOps·스마트컨트랙트 경험을 기록할 예정입니다."
---

포트폴리오 사이트를 새로 만들면서 블로그도 함께 열었습니다.
앞으로 백엔드, 인프라(DevOps), 스마트컨트랙트 개발을 하며 배운 것들을 정리하려고 합니다.

## 다룰 주제

- Node.js / TypeScript 백엔드 설계
- AWS 인프라와 비용 최적화
- Solidity 스마트컨트랙트와 온체인 모니터링

잘 부탁드립니다.
```

- [ ] **Step 2: 샘플 글 `_posts/2026-07-25-websocket-reconnect.md` (코드블록 포함 — 하이라이트 검증용)**

````markdown
---
layout: post
title: "WebSocket 재연결 전략 정리"
date: 2026-07-25
tags: [backend, websocket, typescript]
excerpt: "실시간 서비스에서 안정적인 WebSocket 재연결을 위한 지수 백오프 구현 메모."
---

실시간 서비스에서 연결이 끊겼을 때 무작정 즉시 재연결하면 서버에 부하가 몰립니다.
지수 백오프(exponential backoff)로 간격을 늘려가며 재시도하는 편이 안전합니다.

```typescript
function reconnect(attempt = 0) {
  const delay = Math.min(1000 * 2 ** attempt, 30_000);
  setTimeout(() => {
    const ws = new WebSocket(URL);
    ws.onopen = () => { attempt = 0; };
    ws.onclose = () => reconnect(attempt + 1);
  }, delay);
}
```

지터(jitter)를 추가하면 다수 클라이언트가 동시에 재연결하는 것을 분산할 수 있습니다.
````

- [ ] **Step 3: `_includes/post-card.html`**

```html
{% assign post = include.post %}
<article class="post-item">
  <a class="post-item__link" href="{{ post.url | relative_url }}">
    <div class="post-item__head">
      <h3 class="post-item__title">{{ post.title }}</h3>
      <span class="post-item__date mono-label">{{ post.date | date: "%Y.%m.%d" }}</span>
    </div>
    {% if post.excerpt %}<p class="post-item__excerpt">{{ post.excerpt | strip_html | truncate: 140 }}</p>{% endif %}
    {% if post.tags %}
    <ul class="post-item__tags">
      {% for t in post.tags %}<li>#{{ t }}</li>{% endfor %}
    </ul>
    {% endif %}
  </a>
</article>
```

- [ ] **Step 4: `blog/index.html` (페이지네이션 대상)**

```html
---
layout: default
title: Blog
description: 정슬기의 개발 블로그 — 백엔드, 인프라, 스마트컨트랙트.
---
<div class="section">
  <p class="mono-label">// all posts</p>
  <h1>Blog</h1>
  <div class="post-list">
    {% for post in paginator.posts %}
      {% include post-card.html post=post %}
    {% endfor %}
  </div>

  {% if paginator.total_pages > 1 %}
  <nav class="pagination">
    {% if paginator.previous_page %}
      <a href="{{ paginator.previous_page_path | relative_url }}">← prev</a>
    {% endif %}
    <span class="pagination__info mono-label">{{ paginator.page }} / {{ paginator.total_pages }}</span>
    {% if paginator.next_page %}
      <a href="{{ paginator.next_page_path | relative_url }}">next →</a>
    {% endif %}
  </nav>
  {% endif %}
</div>
```

- [ ] **Step 5: 페이지네이션·글목록 스타일을 `_components.scss`에 추가**

```scss
// ── 블로그 목록 ──
.post-item { border-bottom: 1px solid $border; }
.post-item__link { display: block; padding: 20px 0; }
.post-item__link:hover { text-decoration: none; }
.post-item__link:hover .post-item__title { color: $blue; }
.post-item__head { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; }
.post-item__title { margin: 0; color: $heading; font-size: 1.2rem; }
.post-item__date { white-space: nowrap; }
.post-item__excerpt { color: $muted; margin: 8px 0 10px; }
.post-item__tags { list-style: none; display: flex; gap: 8px; padding: 0; margin: 0; flex-wrap: wrap; }
.post-item__tags li { font-family: $mono; font-size: 0.72rem; color: $purple; }

.pagination { display: flex; justify-content: center; align-items: center; gap: 20px; margin-top: 40px; }
.pagination a { font-family: $mono; color: $blue; }
```

- [ ] **Step 6: 빌드 & 검증**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
grep -q "WebSocket 재연결" _site/blog/index.html \
  && grep -q "post-item" _site/blog/index.html && echo LIST_OK
# 홈 최신 글도 이제 채워짐
grep -q "WebSocket 재연결" _site/index.html && echo HOME_OK
```
Expected: `LIST_OK` 와 `HOME_OK`.

- [ ] **Step 7: Commit**

```bash
git add blog/index.html _includes/post-card.html _posts assets/css/_components.scss
git commit -m "feat: 블로그 목록·글 카드·페이지네이션 + 샘플 글"
```

---

### Task 7: 글 상세 레이아웃 + 코드 하이라이트

**Files:**
- Create: `_layouts/post.html`, `assets/css/_syntax.scss`
- Modify: `assets/css/main.scss` (syntax import 주석 해제), `assets/css/_components.scss` (본문 타이포)

**Interfaces:**
- Consumes: rouge가 생성하는 `.highlight` 마크업.
- Produces: `layout: post`.

- [ ] **Step 1: `_layouts/post.html`**

```html
---
layout: default
---
<article class="post section">
  <p class="mono-label">
    <a href="{{ '/blog/' | relative_url }}">← blog</a>
  </p>
  <h1 class="post__title">{{ page.title }}</h1>
  <p class="post__meta mono-label">
    {{ page.date | date: "%Y.%m.%d" }}
    {% if page.tags %}· {% for t in page.tags %}#{{ t }} {% endfor %}{% endif %}
  </p>
  <div class="post__body">
    {{ content }}
  </div>
</article>
```

- [ ] **Step 2: 본문 타이포를 `_components.scss`에 추가**

```scss
// ── 글 본문 ──
.post__title { font-size: clamp(1.8rem, 4vw, 2.6rem); margin: 8px 0 10px; }
.post__meta { margin-bottom: 32px; }
.post__body { font-size: 1.05rem; }
.post__body h2 { margin: 36px 0 14px; }
.post__body h3 { margin: 28px 0 10px; }
.post__body p, .post__body ul, .post__body ol { margin: 0 0 18px; }
.post__body ul, .post__body ol { padding-left: 22px; }
.post__body blockquote {
  border-left: 3px solid $purple; margin: 0 0 18px; padding: 4px 0 4px 16px; color: $muted;
}
.post__body code {
  background: $surface; border: 1px solid $border; border-radius: 6px;
  padding: 1px 6px; font-size: 0.9em; color: $pink;
}
.post__body pre {
  background: $surface; border: 1px solid $border; border-radius: 10px;
  padding: 16px; overflow-x: auto; margin: 0 0 20px;
}
.post__body pre code { background: none; border: none; padding: 0; color: $text; }
```

- [ ] **Step 3: `assets/css/_syntax.scss` (rouge 다크 테마)**

```scss
// rouge 다크 하이라이트 (GitHub Dark 근사)
.highlight { background: transparent; }
.highlight .c, .highlight .c1, .highlight .cm { color: #8b949e; font-style: italic; } // comment
.highlight .k, .highlight .kd, .highlight .kn { color: #ff7b72; } // keyword
.highlight .s, .highlight .s1, .highlight .s2, .highlight .sb { color: #a5d6ff; } // string
.highlight .mi, .highlight .mf, .highlight .il { color: #79c0ff; } // number
.highlight .nf, .highlight .nx { color: #d2a8ff; } // function/name
.highlight .nt { color: #7ee787; } // tag
.highlight .nb, .highlight .bp { color: #ffa657; } // builtin
.highlight .o, .highlight .ow { color: #ff7b72; } // operator
.highlight .nc, .highlight .nn { color: #ffa657; } // class/namespace
.highlight .p { color: $text; } // punctuation
```

- [ ] **Step 4: `main.scss`에서 syntax import 주석 해제**

`// @import "syntax";` → `@import "syntax";`

- [ ] **Step 5: 빌드 & 검증**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
POST=$(ls _site/blog/websocket* -d)/index.html
grep -q "post__body" "$POST" && grep -q "highlight" "$POST" && echo OK
```
Expected: `OK` — 글 상세가 렌더되고 코드블록이 `.highlight`로 하이라이트됨.

- [ ] **Step 6: Commit**

```bash
git add _layouts/post.html assets/css/_syntax.scss assets/css/main.scss assets/css/_components.scss
git commit -m "feat: 글 상세 레이아웃 + rouge 다크 코드 하이라이트"
```

---

### Task 8: About 페이지

**Files:**
- Create: `about/index.html`, `_data/skills.yml`, `_data/timeline.yml`
- Modify: `assets/css/_components.scss` (about 스타일)

**Interfaces:**
- Consumes: `site.data.skills`, `site.data.timeline`, `site.data.social`.

- [ ] **Step 1: `_data/skills.yml`**

```yaml
- group: Language
  items: [TypeScript, JavaScript, Java, Solidity]
- group: Backend
  items: ["Node.js", NestJS, Express, Fastify, Spring, TypeORM, Prisma]
- group: Data
  items: [MySQL, PostgreSQL, Redis]
- group: DevOps
  items: [AWS, Docker, Kubernetes, "GitHub Actions", Jenkins, "AWS CDK"]
- group: Observability
  items: [Grafana, Prometheus, OpenTelemetry]
- group: Blockchain
  items: [Solidity, "ERC721", "ERC-4337", DeFi, TheGraph, "CN Node"]
```

- [ ] **Step 2: `_data/timeline.yml`**

```yaml
- period: 2022.02 – 현재
  org: ㈜핑거랩스
  role: 백엔드/DevOps·스마트컨트랙트 · 팀장
  detail: 엑스클루시브(NFT 스트리밍), 네고홈(부동산 중개), 선미야클럽·페이버릿(NFT/온체인).
- period: 2024.09 – 2025.04
  org: ㈜하이퍼코퍼레이션
  role: 백엔드/DevOps · 팀장
  detail: 하이퍼라이프케어 레거시 마이그레이션·인프라 최적화.
- period: 2020.08 – 2022.01
  org: 핀스프로토콜 · 태그앤유니버스 · 케이제이글로비스
  role: 백엔드/스마트컨트랙트
  detail: PeriFinance DeFi DEX·Oracle 컨트랙트 개발.
- period: 2018.03 – 2019.08
  org: ㈜크루메이트
  role: 백엔드/서버개발
  detail: CJ Cookit 신규 서비스(Spring) 개발·유지보수.
```

- [ ] **Step 3: `about/index.html`**

```html
---
layout: default
title: About
description: 정슬기(SeulGi Jeong) — 백엔드/DevOps/스마트컨트랙트 개발자 소개.
---
<div class="section about">
  <p class="mono-label">$ cat about.md</p>
  <h1>정슬기 <span class="about__en">SeulGi Jeong</span></h1>
  <p class="about__lead">
    백엔드 개발자로 7년 넘게 일하며 Node.js/TypeScript 애플리케이션과 AWS 인프라를 설계·운영했습니다.
    Web2와 Web3를 아우르는 서비스를 만들고, 스마트컨트랙트를 실제로 운영·업그레이드한 경험이 있습니다.
    단순한 기술 도입이 아니라 실제 필요성과 비용·복잡도를 기준으로 인프라와 시스템을 설계합니다.
  </p>

  <h2 class="mono-label">// skills</h2>
  <div class="skills">
    {% for g in site.data.skills %}
    <div class="skills__group">
      <h3 class="skills__label">{{ g.group }}</h3>
      <ul>{% for i in g.items %}<li>{{ i }}</li>{% endfor %}</ul>
    </div>
    {% endfor %}
  </div>

  <h2 class="mono-label">// experience</h2>
  <div class="timeline">
    {% for t in site.data.timeline %}
    <div class="timeline__item">
      <div class="timeline__period mono-label">{{ t.period }}</div>
      <div class="timeline__body">
        <h3>{{ t.org }}</h3>
        <p class="timeline__role mono-label">{{ t.role }}</p>
        <p>{{ t.detail }}</p>
      </div>
    </div>
    {% endfor %}
  </div>

  <h2 class="mono-label">// contact</h2>
  <div class="about__contact">
    {% for s in site.data.social %}
      <a href="{{ s.url }}"{% unless s.url contains 'mailto' %} target="_blank" rel="noopener"{% endunless %}>{{ s.name }}</a>
    {% endfor %}
  </div>
</div>
```

- [ ] **Step 4: about 스타일을 `_components.scss`에 추가**

```scss
// ── About ──
.about__en { color: $muted; font-weight: 400; font-size: 0.6em; }
.about__lead { font-size: 1.1rem; color: $text; max-width: 620px; margin: 12px 0 40px; }
.about h2 { margin: 40px 0 16px; }
.skills { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 640px) { .skills { grid-template-columns: 1fr 1fr; } }
.skills__group { background: $surface; border: 1px solid $border; border-radius: $radius; padding: 14px 16px; }
.skills__label { margin: 0 0 10px; font-size: 0.95rem; color: $blue; }
.skills__group ul { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.skills__group li { font-family: $mono; font-size: 0.75rem; color: $text; border: 1px solid $border; border-radius: 20px; padding: 2px 9px; }
.timeline__item { display: flex; gap: 18px; padding: 16px 0; border-bottom: 1px solid $border; }
.timeline__period { min-width: 130px; white-space: nowrap; }
.timeline__body h3 { margin: 0 0 4px; font-size: 1.05rem; }
.timeline__role { margin: 0 0 6px; color: $purple; }
.timeline__body p { margin: 0; color: $muted; }
.about__contact a { font-family: $mono; margin-right: 18px; color: $blue; }
@media (max-width: 639px) { .timeline__item { flex-direction: column; gap: 4px; } }
```

- [ ] **Step 5: 빌드 & 검증**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
grep -q "SeulGi Jeong" _site/about/index.html \
  && grep -q "핑거랩스" _site/about/index.html \
  && grep -q "Solidity" _site/about/index.html && echo OK
# 개인정보 미노출 확인 (전화번호 패턴이 없어야 함)
! grep -rq "8958-0333" _site && echo NO_PHONE
```
Expected: `OK` 와 `NO_PHONE`.

- [ ] **Step 6: Commit**

```bash
git add about/index.html _data/skills.yml _data/timeline.yml assets/css/_components.scss
git commit -m "feat: About 페이지 (소개·스킬·경력·연락처)"
```

---

### Task 9: 마무리 (404, 파비콘, RSS, README, 전체 점검)

**Files:**
- Create: `404.html`, `feed.xml`, `assets/favicon.svg`, `README.md`(덮어씀)
- Modify: `_includes/head.html` (favicon 링크)

- [ ] **Step 1: `404.html`**

```html
---
layout: default
title: 404
permalink: /404.html
---
<div class="section" style="text-align:center; padding:80px 0;">
  <p class="mono-label">$ cat page</p>
  <h1 style="font-size:3rem;">404</h1>
  <p class="hero__desc" style="margin:0 auto;">페이지를 찾을 수 없습니다.</p>
  <p style="margin-top:24px;"><a class="btn btn--primary" href="{{ '/' | relative_url }}">← Home</a></p>
</div>
```

- [ ] **Step 2: `feed.xml` (RSS)**

```xml
---
layout: null
permalink: /feed.xml
---
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>{{ site.title }}</title>
    <link>{{ site.url }}{{ site.baseurl }}</link>
    <description>{{ site.description }}</description>
    {% for post in site.posts limit: 20 %}
    <item>
      <title>{{ post.title | xml_escape }}</title>
      <link>{{ post.url | absolute_url }}</link>
      <pubDate>{{ post.date | date_to_rfc822 }}</pubDate>
      <description>{{ post.excerpt | strip_html | xml_escape }}</description>
    </item>
    {% endfor %}
  </channel>
</rss>
```

- [ ] **Step 3: `assets/favicon.svg` (터미널 프롬프트 모티프)**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#0d1117"/>
  <path d="M8 10l5 6-5 6" fill="none" stroke="#58a6ff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <line x1="16" y1="22" x2="24" y2="22" stroke="#3fb950" stroke-width="2.5" stroke-linecap="round"/>
</svg>
```

- [ ] **Step 4: `head.html`에 favicon 링크 추가**

`<link rel="stylesheet" ...main.css...>` 위에 추가:
```html
<link rel="icon" type="image/svg+xml" href="{{ '/assets/favicon.svg' | relative_url }}">
```

- [ ] **Step 5: `README.md` 교체**

```markdown
# enitsed.github.io

정슬기(SeulGi Jeong) — Backend · DevOps · Smart Contract Developer 포트폴리오 & 블로그.

## 개발

```bash
export PATH="/c/tools/ruby34/bin:$PATH"   # Windows Git Bash 기준
bundle install
bundle exec jekyll serve                   # http://localhost:4000
```

## 구조

- 프로젝트: `_data/projects.yml`
- 스킬/경력: `_data/skills.yml`, `_data/timeline.yml`
- 글: `_posts/YYYY-MM-DD-slug.md`
- 스타일: `assets/css/` (SCSS, 다크 테마 고정)

GitHub Pages가 `master` 브랜치를 자동 빌드·배포한다.
```

- [ ] **Step 6: 전체 빌드 + serve 스모크 테스트**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll build
# 산출물 존재 확인
for f in index.html work/index.html blog/index.html about/index.html 404.html feed.xml sitemap.xml; do
  test -f "_site/$f" && echo "OK $f" || echo "MISSING $f"
done
# 개인정보 미노출 최종 확인
! grep -rq "8958-0333" _site && echo NO_PHONE
```
Expected: 모든 파일 `OK`, `NO_PHONE`. (`sitemap.xml`은 jekyll-sitemap가 생성)

- [ ] **Step 7: 로컬 서브로 육안 확인 (선택, 권장)**

```bash
export PATH="/c/tools/ruby34/bin:$PATH"
bundle exec jekyll serve --host 127.0.0.1 --port 4000
```
브라우저에서 `http://127.0.0.1:4000` 접속 → 홈/work/blog/글상세/about/404 순회. 다크 테마·카드 hover·코드 하이라이트·반응형(창 좁히기) 확인 후 Ctrl+C.

- [ ] **Step 8: Commit**

```bash
git add 404.html feed.xml assets/favicon.svg _includes/head.html README.md
git commit -m "feat: 404·RSS·favicon·README + 전체 점검"
```

---

## Self-Review 결과

**Spec coverage:**
- 사이트 구조(홈/work/blog/글상세/about) → Task 3,5,6,7,8 ✓
- 콘텐츠 모델(`_data/projects.yml`, `_posts`, `_config.yml`) → Task 1,4,6 ✓
- 디자인 시스템(토큰·Inter/JetBrains Mono·카드) → Task 2,3,4,5 ✓
- 다크 고정 → 전 태스크 ✓
- github-pages gem 빌드 → Task 1 ✓
- 삭제 목록(Gulp·기존 콘텐츠) → Task 1 ✓
- About(스킬·경력·연락처) → Task 8 ✓
- 개인정보 미노출 → Task 8,9 검증 스텝 ✓
- 범위 밖(라이트 토글·검색·뉴스레터·댓글) → 미포함 ✓

**Placeholder scan:** 모든 스텝에 실제 코드·명령·기대출력 포함. TBD 없음.

**Type consistency:** include 파라미터명 일관 — `project-card.html`은 `include.project`(홈/work에서 `project=p`), `post-card.html`은 `include.post`(blog에서 `post=post`). 그라데이션 클래스 `grad--{name}` ↔ `_data/projects.yml`의 `gradient` 값(blue-purple/purple-pink/pink-orange/green-blue) 일치. SCSS 변수명 `_variables.scss` 정의와 사용처 일치.
