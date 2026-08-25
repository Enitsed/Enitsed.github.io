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
최종 수정일: {% if site.supabase_url != "" %}2026-08-25{% else %}2026-08-15{% endif %}

## 웹폰트 (Google Fonts)

이 사이트는 Google Fonts에서 웹폰트(Inter, JetBrains Mono)를 불러옵니다. 폰트를 내려받는 과정에서 방문자의 IP 주소와 브라우저 정보(User-Agent)가 Google 서버로 전송됩니다. 이 요청은 애널리틱스 사용 여부와 관계없이 모든 페이지에서 발생하며, 사이트 내에서 끌 수 있는 방법은 없습니다.

## 방문 통계 (Google Analytics 4)

방문 통계 확인을 위해 Google Analytics 4를 사용합니다. 다음 정보가 Google로 전송됩니다.

- 방문한 페이지 주소와 머문 시간
- 유입 경로(리퍼러)
- 기기·운영체제·브라우저 종류
- IP 주소
- 대략적인 접속 지역(도시 단위, IP 주소로부터 추정)

이름·이메일·전화번호처럼 직접 신원을 특정하는 정보는 수집하지 않습니다. 다만 GA4는 브라우저에 `_ga`, `_ga_<측정 ID>` 쿠키를 저장해 무작위로 생성된 방문자 식별자를 보관하며, 이 식별자도 개인정보로 취급될 수 있습니다. 이 쿠키는 브라우저의 쿠키 설정에서 직접 삭제할 수 있습니다.
브라우저의 추적 차단 기능이나 [Google 애널리틱스 차단 부가기능](https://tools.google.com/dlpage/gaoptout)으로 거부할 수 있습니다.

{% if site.supabase_url != "" %}
## 댓글 (Supabase)

댓글을 쓰려면 GitHub 또는 Google 계정으로 로그인해야 합니다. 로그인하면 다음 정보가 Supabase에 저장됩니다.

- 소셜 계정의 이메일 주소, 표시 이름, 프로필 이미지 URL
- 작성한 댓글 본문과 작성 시각

로그인하지 않고 글만 읽는 경우에는 아무것도 저장되지 않습니다. 본인이 쓴 댓글은 댓글 옆의 삭제 버튼으로 직접 지울 수 있으며, 삭제한 댓글은 다른 방문자에게 더 이상 보이지 않습니다. 계정 자체의 삭제를 원하시면 아래 이메일로 요청해 주세요.
{% endif %}

## 보관 기간 및 국외 이전

Google Analytics 4가 수집한 데이터는 GA4 속성에 설정된 기본 보관 기간 동안 저장됩니다. 설정값은 GA4 관리자 화면에서 확인할 수 있습니다. Google LLC와 GitHub, Inc.{% if site.supabase_url != "" %}, Supabase, Inc.{% endif %}는 모두 대한민국 밖(미국)의 서버에서 데이터를 처리합니다.{% if site.supabase_url != "" %} 댓글 데이터는 삭제 요청 전까지 보관됩니다.{% endif %}

## 처리 위탁

| 수탁자 | 목적 |
| --- | --- |
| Google LLC | 방문 통계 분석 (Google Analytics 4) |
| Google LLC | 웹폰트 제공 (Google Fonts) |
| GitHub, Inc. | 사이트 호스팅 (GitHub Pages) |
{% if site.supabase_url != "" %}| Supabase, Inc. | 댓글 저장 및 로그인 처리 |
{% endif %}

## 문의

수집 정보에 대한 문의나 삭제 요청은 아래로 연락 주세요.

- 이메일: [sllki1@naver.com](mailto:sllki1@naver.com)

</div>
