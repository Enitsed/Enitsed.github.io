---
layout: post
title: "500 에러인데 브라우저는 CORS 문제라고 말한다 — 프리플라이트와 자격 증명"
date: 2026-11-20
tags: [backend, web, security, typescript, devops]
excerpt: "CORS 에러 메시지가 실제 원인을 가리는 이유에서 출발해, 프리플라이트가 깨지는 자리들, 자격 증명을 붙이면 달라지는 규칙, 오리진을 에코할 때 Vary를 빼면 생기는 캐시 오염, 그리고 이 설정을 앱과 게이트웨이 중 어디에 둘 것인가."
---

브라우저 콘솔에 CORS 에러가 찍히면 보통 서버 설정부터 의심합니다.
그런데 그 요청은 이미 서버에 도착해 500으로 끝났고, 응답에 헤더가 없어서 브라우저가 그 사실을 알려주지 못한 경우도 많습니다.

CORS가 거르는 것은 응답이 아니라 **응답을 읽을 권한**입니다.
디버깅이 유독 어려운 이유가 여기서 나옵니다.

## 막히는 지점이 어디인가

단순 요청의 경우, 브라우저는 요청을 먼저 보냅니다. 서버는 그걸 받아서 처리하고, DB에 쓰기까지 합니다.
그다음 응답이 돌아왔을 때 허용 헤더가 없으면, 브라우저가 **스크립트에게 응답을 넘겨주지 않습니다.**

| | CORS가 하는 일 | CORS가 하지 않는 일 |
| --- | --- | --- |
| 강제 주체 | 브라우저 | 서버 |
| 대상 | 다른 오리진의 스크립트 | `curl`, 서버 간 호출, 모바일 앱 |
| 효과 | 응답 읽기 차단 | 요청 도달 차단 |

여기서 두 가지 결론이 나옵니다.

첫째, **CORS는 서버를 보호하는 수단이 아닙니다.** 허용 목록을 조여도 브라우저 밖에서 오는 요청은 그대로 들어옵니다. 인증과 권한 검사는 별개로 서버에서 해야 합니다.

둘째, 그래도 **자격 증명이 붙는 순간 CORS는 실제 보안 경계가 됩니다.** 쿠키가 실리는 요청의 응답을 읽도록 허용한다는 건, 그 오리진의 스크립트가 로그인한 사용자 데이터를 읽어도 된다는 뜻입니다. 뒤에서 다시 다룹니다.

## 두 종류의 요청

브라우저는 조건을 보고 사전 확인(preflight)을 보낼지 결정합니다.
아래를 모두 만족하면 사전 확인 없이 바로 나갑니다.

- 메서드가 `GET`, `HEAD`, `POST` 중 하나
- 스크립트가 직접 설정한 헤더가 안전 목록(`Accept`, `Accept-Language`, `Content-Language`, `Content-Type` 등) 안에만 있음
- `Content-Type`이 `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain` 중 하나

하나라도 어긋나면 `OPTIONS` 요청이 먼저 나갑니다.

실무에서 이 조건이 의미하는 건 간단합니다. **`Content-Type: application/json`을 쓰거나 `Authorization` 헤더를 붙이면 프리플라이트가 생깁니다.**
즉 요즘 만드는 JSON API는 거의 항상 프리플라이트를 거칩니다. 피하려고 애쓸 영역이 아니라, 제대로 응답해주는 쪽이 맞습니다.

브라우저 없이 그대로 재현할 수 있습니다.

```bash
curl -i -X OPTIONS https://api.example.com/v1/orders \
  -H 'Origin: https://app.example.com' \
  -H 'Access-Control-Request-Method: PATCH' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

응답에서 확인할 것은 네 가지입니다.

```text
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET,POST,PATCH,DELETE
Access-Control-Allow-Headers: authorization,content-type
Access-Control-Max-Age: 600
```

이 `curl` 한 줄이 브라우저 콘솔보다 훨씬 많은 것을 알려줍니다. 상태 코드와 본문을 그대로 볼 수 있으니까요.

## 프리플라이트가 깨지는 자리

### 인증 미들웨어가 OPTIONS를 먼저 잡는다

**프리플라이트 요청에는 쿠키도 `Authorization` 헤더도 실리지 않습니다.** 브라우저가 의도적으로 빼고 보냅니다.

그래서 인증 미들웨어가 CORS 처리보다 앞에 있으면, 프리플라이트는 401이나 403으로 끝납니다.
브라우저는 "허용 헤더가 없다"고만 말하고, 서버 로그에는 인증 실패가 찍힙니다. 양쪽을 같이 보지 않으면 연결이 안 됩니다.

순서가 전부입니다.

```typescript
import express from "express";

const app = express();

const ALLOWED_ORIGINS = new Set([
  "https://app.example.com",
  "https://admin.example.com",
]);

// 1) CORS 처리는 인증보다 먼저, 그리고 프리플라이트는 여기서 끝낸다
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "authorization,content-type,x-request-id",
    );
    res.setHeader("Access-Control-Max-Age", "600");
    return res.status(204).end();
  }

  next();
});

// 2) 그다음이 인증
app.use(authenticate);
```

### 응답이 리다이렉트다

**프리플라이트 응답이 3xx면 브라우저는 따라가지 않고 그 자리에서 실패합니다.**

범인은 대개 CORS와 무관한 설정입니다.

- `http` → `https` 강제 리다이렉트
- 트레일링 슬래시 정규화 (`/v1/orders` → `/v1/orders/`)
- 프록시 앞단의 경로 재작성

프론트엔드가 호출하는 URL이 리다이렉트 없이 바로 200이나 204로 끝나는지 확인하면 됩니다.

### 허용 목록에 헤더 하나가 빠졌다

요청에 커스텀 헤더를 하나 추가했는데 서버의 `Access-Control-Allow-Headers`를 안 고친 경우입니다.
추적용 `X-Request-Id`를 붙이는 순간 멀쩡했던 API가 전부 막히는 패턴이 여기입니다.

브라우저가 보낸 `Access-Control-Request-Headers` 값을 서버 로그에 남겨두면 이런 건 바로 보입니다.

## 자격 증명이 붙으면 규칙이 달라진다

`fetch`에 `credentials: "include"`를 주면 와일드카드가 전부 막힙니다.

```typescript
await fetch("https://api.example.com/v1/me", {
  credentials: "include",
});
```

이때 서버가 지켜야 할 것들입니다.

- `Access-Control-Allow-Origin: *`는 거부됩니다. **요청의 `Origin` 값을 그대로 되돌려줘야** 합니다.
- `Access-Control-Allow-Credentials: true`가 있어야 합니다.
- `Allow-Headers`와 `Allow-Methods`의 `*`도 와일드카드로 해석되지 않습니다. 이름을 나열해야 합니다.

> CORS를 통과한다고 쿠키가 실리는 것은 아닙니다.
> 크로스 사이트 요청에 쿠키가 따라가려면 쿠키 쪽 조건(`SameSite=None; Secure`)도 같이 만족해야 합니다. 두 개는 독립된 관문입니다.

오리진을 되돌려주게 되면 허용 목록 검사가 유일한 방어선이 됩니다. 여기서 흔한 실수가 정규식입니다.

```typescript
// 위험: 앵커가 없어서 app.example.com.evil.com 도 통과한다
const ok = /https:\/\/app\.example\.com/.test(origin);

// 서브도메인을 열어야 한다면 최소한 양쪽을 고정한다
const ok2 = /^https:\/\/[a-z0-9-]+\.example\.com$/.test(origin);
```

가능하면 정규식 대신 **문자열 집합 비교**를 쓰는 편이 안전합니다. 허용할 오리진이 수십 개가 아니라면 열거하는 비용이 더 싸게 끝납니다.

서브도메인을 와일드카드로 여는 선택에도 비용이 있습니다. 사용자가 하위 도메인을 만들 수 있는 구조라면, 그 도메인 하나가 뚫리는 순간 API 응답을 읽을 수 있게 됩니다.

{% comment %} TODO: 운영 중 서비스에서 허용 오리진을 어떻게 관리하고 있는지(환경 변수, 설정 서비스 등)와 스테이징·프리뷰 도메인을 어떻게 처리했는지 적어주세요 {% endcomment %}

## Vary를 빼면 캐시가 섞인다

오리진을 에코하는 순간 **같은 URL에 대해 응답이 요청마다 달라집니다.** 그런데 중간에 공유 캐시가 있으면 그걸 모릅니다.

CDN이 `admin.example.com`용으로 만들어진 응답을 캐시해두고, 그다음에 들어온 다른 오리진 요청에 그대로 내려줄 수 있습니다.
반대로 허용되지 않은 오리진에 대한 응답이 캐시되면, 정상 오리진까지 같이 막힙니다.

그래서 에코할 때는 `Vary: Origin`이 필수입니다.

```text
Access-Control-Allow-Origin: https://app.example.com
Vary: Origin
```

CDN을 앞에 두고 있다면 여기서 한 단계가 더 있습니다. **`Origin` 헤더를 원본까지 전달하고 캐시 키에도 포함**시켜야 합니다.
그렇지 않으면 원본이 `Vary`를 제대로 붙여도 CDN이 첫 응답 하나로 모든 오리진에 답합니다. 설정 이름은 CDN마다 다르니 해당 제품 문서를 확인하세요.

## 프리플라이트 비용 줄이기

JSON API라면 프리플라이트를 없앨 수는 없고, 횟수를 줄이는 쪽으로 갑니다. `Access-Control-Max-Age`가 그 레버입니다.

```text
Access-Control-Max-Age: 600
```

이 값이 있으면 브라우저는 같은 조합(오리진·경로·메서드·헤더)에 대한 프리플라이트 결과를 그만큼 재사용합니다.
단, **브라우저마다 상한이 있어 큰 값을 줘도 잘립니다.** 실제 상한은 브라우저별로 다르니 숫자를 가정하지 말고 개발자 도구에서 프리플라이트가 실제로 줄었는지 확인하는 편이 확실합니다.

반대 방향의 비용도 있습니다. 캐시된 동안에는 서버에서 허용 목록을 고쳐도 그 브라우저에는 반영되지 않습니다.
설정을 자주 바꾸는 단계라면 짧게 두고, 안정되면 늘리는 쪽이 편합니다.

## 응답 헤더를 스크립트가 못 읽는다

응답 본문은 잘 받는데 헤더만 `null`로 나오는 경우가 있습니다.
크로스 오리진에서 스크립트가 기본으로 읽을 수 있는 응답 헤더는 `Content-Type`, `Cache-Control`, `Content-Length`, `Last-Modified` 등 안전 목록뿐입니다.

그 밖의 헤더는 서버가 명시적으로 열어줘야 합니다.

```typescript
res.setHeader("Access-Control-Expose-Headers", "x-total-count,content-disposition");
```

실제로 걸리는 자리는 보통 둘입니다.

- 목록 API가 총 건수를 헤더로 주는 경우 — 페이지네이션 UI가 안 그려집니다.
- 파일 다운로드에서 `Content-Disposition`의 파일명을 읽으려는 경우 — 저장 이름이 엉뚱해집니다.

## 에러 응답에 헤더가 없으면 원인이 숨는다

이 글의 처음으로 돌아갑니다.

CORS 헤더를 라우트 핸들러 안에서 붙이면, 그 앞에서 터진 요청에는 헤더가 없습니다.
500을 만드는 예외 핸들러, 본문 파싱 실패로 나는 400, 게이트웨이가 직접 만드는 502와 504가 모두 그렇습니다.

브라우저는 이 모든 경우를 "CORS 에러"로 보고합니다. 상태 코드도 본문도 스크립트에 넘겨주지 않으니, 프론트엔드 쪽에서는 구분할 방법이 없습니다.

그래서 두 가지를 같이 해둡니다.

**CORS 헤더는 에러 경로에도 붙입니다.** 애플리케이션 최상단 미들웨어나 프록시 계층에서 처리하면 예외와 무관하게 붙습니다.

```nginx
# 허용 목록을 map 으로 둔다. $http_origin 을 그대로 에코하면 모든 오리진이 통과한다.
map $http_origin $cors_origin {
    default                        "";
    "https://app.example.com"      $http_origin;
    "https://admin.example.com"    $http_origin;
}

# add_header 는 기본적으로 성공·리다이렉트 응답에만 붙는다.
# always 를 붙여야 4xx·5xx 에도 나간다.
add_header Access-Control-Allow-Origin $cors_origin always;
add_header Access-Control-Allow-Credentials "true" always;
add_header Vary Origin always;
```

**그리고 브라우저 콘솔을 원인 분석의 근거로 쓰지 않습니다.** 같은 요청을 `Origin` 헤더만 붙여 `curl`로 때려보면 실제 상태 코드와 본문이 바로 나옵니다.
서버 로그의 상관관계 ID와 맞춰 보면 대부분 1분 안에 갈립니다.

## 어디에 둘 것인가

CORS 응답을 만들 수 있는 계층이 여러 개라서, 정해두지 않으면 두 곳에서 붙어 헤더가 중복됩니다.
**중복된 `Access-Control-Allow-Origin` 헤더는 브라우저가 거부합니다.** 두 계층이 각자 잘 동작해도 합쳐지면 실패하는 구조입니다.

| 위치 | 장점 | 비용 |
| --- | --- | --- |
| 애플리케이션 | 경로·메서드별로 세밀하게, 코드와 함께 배포 | 서비스마다 중복 구현, 게이트웨이 에러에는 못 붙음 |
| 리버스 프록시 | 에러 응답까지 일괄 적용 | 경로별 분기가 설정 파일로 흘러감 |
| API 게이트웨이·CDN | 원본 부담 없음, 프리플라이트를 앞에서 끝냄 | 배포 주기가 앱과 다름, 캐시 키 설정 필요 |

규모가 작으면 애플리케이션 한 곳에 두는 게 추적하기 쉽습니다.
서비스가 여러 개로 늘어나면 공통 계층으로 올리되, **올린 뒤에는 애플리케이션 쪽 설정을 반드시 걷어내야** 합니다.

## 막혔을 때 보는 순서

1. `curl -X OPTIONS`에 `Origin`과 `Access-Control-Request-*`를 붙여 프리플라이트를 재현한다. 상태 코드부터 본다.
2. 2xx가 아니면 CORS가 아니라 **라우팅·인증·리다이렉트** 문제다. 미들웨어 순서를 본다.
3. 2xx인데도 막히면 `Allow-Headers`에 실제 보낸 헤더가 다 들어있는지 대조한다.
4. 자격 증명을 쓴다면 `Allow-Origin`이 에코인지, `Allow-Credentials`가 있는지, 쿠키의 `SameSite`가 맞는지 본다.
5. 간헐적으로만 실패하면 캐시를 의심한다. `Vary: Origin`과 CDN 캐시 키를 확인한다.
6. 본문이 오는데 헤더만 못 읽으면 `Expose-Headers`다.

{% comment %} TODO: 실제로 겪은 CORS 이슈 중 원인이 CORS가 아니었던 사례가 있다면 적어주세요 {% endcomment %}
