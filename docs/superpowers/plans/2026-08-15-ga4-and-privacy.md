# GA4 측정 + 개인정보처리방침 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GA4 측정 코드를 프로덕션 빌드에만 주입하고, `/privacy/` 개인정보처리방침 페이지를 만들어 푸터에서 연결한다.

**Architecture:** 새 의존성이나 빌드 스텝 없이 Jekyll include + Liquid 조건문만 쓴다. GA4 스니펫은 `_includes/analytics.html`에 격리하고, `head.html`은 `jekyll.environment == "production"` 이고 `site.ga4_id`가 설정된 경우에만 include한다. 개인정보처리방침은 정적 마크다운 페이지다.

**Tech Stack:** Jekyll (GitHub Pages 기본 빌드), Liquid, kramdown. 새 gem 없음.

**Spec:** `docs/superpowers/specs/2026-08-15-supabase-comments-cms-design.md` (7절, 8절)

## Global Constraints

- **새 gem·플러그인 추가 금지.** GitHub Pages 기본 빌드에서 동작해야 한다. `_config.yml`의 `plugins`는 `jekyll-paginate`, `jekyll-sitemap`에서 늘리지 않는다.
- **빌드 스텝 추가 금지.** 번들러·GitHub Actions 빌드 워크플로를 도입하지 않는다.
- **GA4는 `jekyll.environment == "production"` 에서만 로드한다.** 로컬 `jekyll serve`(development)에서 통계가 오염되면 안 된다.
- **CSS는 기존 파셜을 쓴다.** 이 계획에서 새 SCSS 파일을 만들지 않는다.
- **푸시하지 않는다.** 커밋까지만 하고, 배포는 사람이 확인 후 결정한다.
- 문서 경로 `docs/`는 `_config.yml`의 `exclude`에 있어 사이트 빌드에 포함되지 않는다.
- 검증 빌드 출력은 저장소를 더럽히지 않도록 `_site`(gitignore됨)를 쓴다.

---

### Task 1: GA4 측정 코드 조건부 주입

**Files:**
- Create: `_includes/analytics.html`
- Modify: `_config.yml` (최상단 사이트 메타 블록에 `ga4_id` 추가)
- Modify: `_includes/head.html:104-106` (파일 끝 `<link rel="alternate">` 뒤에 include 추가)

**Interfaces:**
- Consumes: 없음
- Produces: `site.ga4_id` 설정 키. Task 2 및 이후 Phase 2·3 계획이 `_config.yml`의 같은 메타 블록에 키를 추가할 때 이 위치 규칙을 따른다.

- [ ] **Step 1: 실패하는 검증을 먼저 작성**

`scripts/verify-analytics.sh`를 만들지 않는다. 대신 아래 명령을 그대로 쓴다 — 아직 구현이 없으므로 실패해야 한다.

```bash
JEKYLL_ENV=production bundle exec jekyll build --quiet \
  && grep -q "googletagmanager.com/gtag/js" _site/index.html \
  && echo "FOUND" || echo "MISSING"
```

- [ ] **Step 2: 검증을 실행해 실패 확인**

Run: 위 Step 1 명령
Expected: `MISSING` 출력 (아직 스니펫이 없음)

- [ ] **Step 3: `_config.yml`에 측정 ID 키 추가**

`lang: ko` 줄 바로 아래에 추가한다. 값은 아직 발급 전이므로 **빈 문자열로 둔다.** 빈 값이면 include가 걸리지 않아 아무것도 렌더되지 않는 것이 의도된 동작이다.

```yaml
lang: ko

# Google Analytics 4 측정 ID (G-XXXXXXXXXX). 비어 있으면 로드하지 않음.
ga4_id: ""
```

- [ ] **Step 4: `_includes/analytics.html` 생성**

```html
<!-- Google Analytics 4 -->
<script async src="https://www.googletagmanager.com/gtag/js?id={{ site.ga4_id }}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){ dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', '{{ site.ga4_id }}');
</script>
```

- [ ] **Step 5: `_includes/head.html` 끝에 조건부 include 추가**

파일 마지막 줄(`<link rel="alternate" type="application/rss+xml" ...>`) 다음에 빈 줄 하나를 두고 추가한다.

```liquid
{% if jekyll.environment == "production" and site.ga4_id != "" %}
  {% include analytics.html %}
{% endif %}
```

- [ ] **Step 6: 빈 ID에서는 로드되지 않음을 확인**

Run:
```bash
JEKYLL_ENV=production bundle exec jekyll build --quiet \
  && grep -c "googletagmanager" _site/index.html || echo "0 (정상)"
```
Expected: `0 (정상)` — `ga4_id`가 빈 문자열이므로 조건이 거짓이다.

- [ ] **Step 7: 임시 ID로 production 주입을 확인**

`_config.yml`의 `ga4_id`를 임시로 `"G-TEST123456"`으로 바꾸고 빌드한다.

Run:
```bash
JEKYLL_ENV=production bundle exec jekyll build --quiet
grep -o 'gtag/js?id=[^"]*' _site/index.html
grep -o "gtag('config', '[^']*')" _site/blog/hello-world/index.html
```
Expected: 두 줄 모두 `G-TEST123456`이 찍혀 나온다. 홈과 글 페이지 양쪽에 들어갔는지 확인하는 것이 목적이다.

- [ ] **Step 8: development 빌드에서는 빠지는지 확인**

Run:
```bash
bundle exec jekyll build --quiet
grep -c "googletagmanager" _site/index.html || echo "0 (정상)"
```
Expected: `0 (정상)` — `JEKYLL_ENV`가 없으면 development이므로 조건이 거짓이다.

이 단계가 이 태스크의 핵심이다. 여기서 숫자가 0이 아니면 로컬 개발 트래픽이 통계에 섞인다.

- [ ] **Step 9: `ga4_id`를 다시 빈 문자열로 되돌리기**

```yaml
ga4_id: ""
```

실제 ID는 정슬기님이 GA4 속성을 만든 뒤 채운다. 임시 ID를 커밋하면 존재하지 않는 속성으로 요청이 나간다.

- [ ] **Step 10: 커밋**

```bash
git add _config.yml _includes/analytics.html _includes/head.html
git commit -m "feat: GA4 측정 코드 조건부 주입 (production + ga4_id 설정 시에만)"
```

---

### Task 2: 개인정보처리방침 페이지와 푸터 링크

**Files:**
- Create: `privacy/index.md`
- Modify: `_includes/footer.html:8` (copyright 문단을 링크 포함하도록 교체)

**Interfaces:**
- Consumes: Task 1이 도입한 `site.ga4_id`. 본문에서 GA4 사용 사실을 서술하는 근거이며, 코드 참조는 없다.
- Produces: `/privacy/` 경로. Phase 2 계획에서 댓글 저장 항목을 이 문서에 덧붙인다.

- [ ] **Step 1: 실패하는 검증을 먼저 실행**

```bash
bundle exec jekyll build --quiet \
  && test -f _site/privacy/index.html && echo "FOUND" || echo "MISSING"
```
Expected: `MISSING`

- [ ] **Step 2: `privacy/index.md` 생성**

`blog/index.html`과 동일하게 `layout: default`를 쓰고, 본문은 `section` 클래스로 감싼다. `mono-label` + `h1` 조합은 기존 페이지 관례다.

```markdown
---
layout: default
title: 개인정보처리방침
description: 이 사이트가 수집하는 정보와 그 처리 방식.
permalink: /privacy/
sitemap: false
---

<div class="section" markdown="1">

<p class="mono-label">// privacy</p>

# 개인정보처리방침

이 사이트(`enitsed.github.io`)가 수집하는 정보와 그 처리 방식을 정리한 문서입니다.
최종 수정일: 2026-08-15

## 방문 통계 (Google Analytics 4)

방문 통계 확인을 위해 Google Analytics 4를 사용합니다. 다음 정보가 Google로 전송됩니다.

- 방문한 페이지 주소와 머문 시간
- 유입 경로(리퍼러)
- 기기·운영체제·브라우저 종류
- 대략적인 접속 지역(도시 단위)

이름·이메일처럼 개인을 특정할 수 있는 정보는 이 경로로 수집하지 않습니다.
브라우저의 추적 차단 기능이나 [Google 애널리틱스 차단 부가기능](https://tools.google.com/dlpage/gaoptout)으로 거부할 수 있습니다.

## 처리 위탁

| 수탁자 | 목적 |
| --- | --- |
| Google LLC | 방문 통계 분석 (Google Analytics 4) |
| GitHub, Inc. | 사이트 호스팅 (GitHub Pages) |

## 문의

수집 정보에 대한 문의나 삭제 요청은 아래로 연락 주세요.

- 이메일: [sllki1@naver.com](mailto:sllki1@naver.com)

</div>
```

- [ ] **Step 3: 페이지가 생성되는지 확인**

Run:
```bash
bundle exec jekyll build --quiet && test -f _site/privacy/index.html && echo "FOUND"
```
Expected: `FOUND`

- [ ] **Step 4: 마크다운이 HTML로 변환됐는지 확인**

`markdown="1"` 속성이 없으면 kramdown이 `<div>` 안의 마크다운을 그대로 두어 `##`가 글자로 보인다. 그것을 잡는 검증이다.

Run:
```bash
grep -c "<h2" _site/privacy/index.html
grep -c "^##" _site/privacy/index.html || echo "0 (정상)"
```
Expected: 첫 줄은 `3` (h2가 3개), 둘째 줄은 `0 (정상)`

- [ ] **Step 5: 사이트맵에서 제외됐는지 확인**

Run:
```bash
grep -c "privacy" _site/sitemap.xml || echo "0 (정상)"
```
Expected: `0 (정상)` — `sitemap: false`가 동작한 것이다.

- [ ] **Step 6: 푸터에 링크 추가**

`_includes/footer.html`의 copyright 문단을 아래로 교체한다. 기존 `mono-label` 클래스와 `·` 구분자 스타일을 유지한다.

교체 전:
```liquid
    <p class="mono-label">© {{ 'now' | date: "%Y" }} {{ site.author }} · built with Jekyll</p>
```

교체 후:
```liquid
    <p class="mono-label">
      © {{ 'now' | date: "%Y" }} {{ site.author }} · built with Jekyll ·
      <a href="{{ '/privacy/' | relative_url }}">개인정보처리방침</a>
    </p>
```

- [ ] **Step 7: 모든 페이지 푸터에 링크가 들어갔는지 확인**

Run:
```bash
bundle exec jekyll build --quiet
grep -l 'href="/privacy/"' _site/index.html _site/blog/index.html _site/about/index.html _site/blog/hello-world/index.html | wc -l
```
Expected: `4` — 푸터가 공통 레이아웃이므로 전 페이지에 들어가야 한다.

- [ ] **Step 8: 링크가 실제 파일을 가리키는지 확인**

Run:
```bash
test -f _site/privacy/index.html && echo "링크 대상 존재"
```
Expected: `링크 대상 존재`

- [ ] **Step 9: 커밋**

```bash
git add privacy/index.md _includes/footer.html
git commit -m "feat: 개인정보처리방침 페이지 + 푸터 링크"
```

---

## 완료 후 남는 것

- `_config.yml`의 `ga4_id`는 빈 문자열이다. 정슬기님이 GA4 속성을 만들고 `G-`로 시작하는 측정 ID를 채우면 그때부터 측정이 시작된다. 코드 변경은 필요 없다.
- 푸시는 하지 않았다. 배포 여부는 사람이 결정한다.
- 개인정보처리방침의 "처리 위탁" 표에는 Supabase가 아직 없다. Phase 2에서 댓글을 붙일 때 추가한다.

## 이 계획이 다루지 않는 것

- Supabase 댓글 (Phase 2 별도 계획)
- `/admin` 글 작성 UI와 Edge Function (Phase 3 별도 계획)
- AdSense (커스텀 도메인 확보 후)
