---
layout: post
title: "로그인은 됐는데 다음 요청에 쿠키가 없다 — SameSite·Domain·Secure가 거르는 것"
date: 2026-10-27
tags: [backend, auth, security, api, typescript]
excerpt: "로그인 응답에 Set-Cookie가 분명히 있는데 다음 요청에는 쿠키가 안 실립니다. 쿠키가 출처가 아니라 사이트 단위로 묶이는 구조, SameSite 세 값이 실제로 거르는 요청, 결제사에서 돌아오면 세션이 풀린 것처럼 보이는 이유, Domain을 적는 순간 서브도메인 전체가 신뢰 범위가 되는 문제, 크로스 사이트 요청에서 쿠키가 저장조차 되지 않는 조건, 프록시 뒤에서 Secure 판단이 틀어지는 자리, 그리고 쿠키와 Authorization 헤더를 가르는 기준까지."
---

응답 헤더에는 `Set-Cookie`가 있습니다. 개발자 도구 네트워크 탭에서도 보입니다.
그런데 바로 다음 요청의 `Cookie` 헤더는 비어 있고, 서버는 401을 돌려줍니다.

쿠키는 보냈느냐 안 보냈느냐의 문제가 아닙니다. **브라우저가 저장할지, 저장한 걸 이 요청에 실을지를 속성으로 판단하고**, 그 판단은 서버 코드와 다른 규칙으로 돕니다.

## 쿠키는 출처가 아니라 사이트 단위로 묶인다

같은 출처(origin)는 스킴·호스트·포트가 모두 같아야 합니다. 쿠키는 그 기준을 쓰지 않습니다.

쿠키의 범위는 **호스트와 경로**로 정해지고, 포트는 아예 보지 않습니다.
`http://localhost:3000`에서 심은 쿠키는 `http://localhost:4000`에도 실려 갑니다. 로컬에서 서비스 두 개를 띄워놓고 세션이 섞이는 일이 여기서 생깁니다.

스킴도 기본적으로는 구분하지 않습니다. `Secure`를 붙이지 않으면 http로 심은 쿠키가 https 요청에도 실리고, 반대도 됩니다.

여기에 `SameSite`를 판정할 때 쓰는 단위가 하나 더 있습니다. **사이트(site)** 입니다.
사이트는 등록 가능한 도메인, 즉 `example.co.kr` 같은 공개 접미사 바로 아래 한 단계까지를 묶은 것입니다.

```text
api.example.com  ↔  www.example.com   같은 사이트 (same-site)
example.com      ↔  example.net       다른 사이트 (cross-site)
example.com      ↔  example.com:8443  같은 사이트 (포트는 무관)
```

그래서 세 단어가 서로 다른 것을 가리킵니다. 저장 범위는 호스트가 정하고, 실어 보낼지는 사이트가 정하고, 스크립트 접근 권한은 출처가 정합니다.
증상을 볼 때 "지금 막힌 게 저장인지 전송인지"를 먼저 갈라야 하는 이유입니다.

## SameSite — 어떤 요청에 실어 보낼지

`SameSite`는 **요청을 일으킨 쪽과 요청이 가는 쪽이 다른 사이트일 때** 쿠키를 실을지 정합니다.

| 값 | 같은 사이트 요청 | 다른 사이트에서 온 최상위 이동 | 다른 사이트의 fetch·이미지·iframe |
| --- | --- | --- | --- |
| `Strict` | 실림 | **안 실림** | 안 실림 |
| `Lax` | 실림 | 안전한 메서드(GET 등)의 이동에만 실림 | 안 실림 |
| `None` | 실림 | 실림 | 실림 (`Secure` 필수) |

여기서 실무에서 가장 자주 밟는 게 `Strict`입니다.

결제사나 외부 인증 화면으로 보냈다가 리다이렉트로 돌아오는 경로를 생각해보세요.
브라우저 입장에서 그 복귀 요청은 **다른 사이트에서 시작된 최상위 이동**입니다. `Strict`면 쿠키가 빠지고, 서버는 로그인하지 않은 사용자로 봅니다.

사용자 눈에는 "결제하고 돌아왔더니 로그아웃됐다"로 보입니다. 새로고침하면 그다음부터는 같은 사이트 요청이라 정상으로 돌아오는데, 이 '한 번만 이상함'이 원인을 찾기 어렵게 만듭니다.

그래서 세션 쿠키의 기본값은 `Lax`가 현실적입니다. 외부에서 돌아오는 링크와 리다이렉트는 살리고, 다른 사이트가 몰래 거는 fetch와 폼 전송은 막습니다.

> `SameSite`를 생략하면 최신 브라우저 상당수가 `Lax`로 취급합니다.
> 다만 이 기본값은 브라우저와 버전에 따라 다르게 적용돼 왔습니다. 생략하지 말고 명시적으로 적으세요.

`None`은 다른 사이트에서도 쿠키가 필요할 때만 씁니다. 위젯을 iframe으로 끼워주거나, 프런트와 API가 아예 다른 도메인일 때입니다.
이때 `Secure` 없이는 브라우저가 쿠키 자체를 거부합니다.

```http
Set-Cookie: sid=...; HttpOnly; Secure; SameSite=None; Path=/
```

그리고 `None`에 의존하는 설계는 수명을 보장할 수 없습니다.
서드파티 쿠키 차단 정책은 브라우저마다 다르고 계속 바뀌어 왔습니다. 지금 어디까지 막히는지는 각 브라우저 문서를 봐야 하고, 설계 쪽에서는 **크로스 사이트 쿠키는 언제든 막힐 수 있다**를 가정하는 편이 안전합니다.

임베드 용도라면 파티션된 쿠키(`Partitioned`)처럼 끼워진 쪽마다 저장소를 나누는 방향이 따로 있습니다. 적용 조건이 브라우저별로 다르니 쓰기 전에 현재 문서를 확인하세요.

## Domain — 공유할지 격리할지

`Domain`을 적지 않으면 쿠키는 **응답을 준 그 호스트에만** 붙습니다. 호스트 전용(host-only) 쿠키입니다.

```http
Set-Cookie: sid=...; HttpOnly; Secure; SameSite=Lax; Path=/
```

적으면 그 도메인과 **모든 서브도메인**으로 범위가 넓어집니다.

```http
Set-Cookie: sid=...; Domain=example.com; HttpOnly; Secure; SameSite=Lax; Path=/
```

`www.example.com`과 `app.example.com`이 세션을 같이 써야 한다면 이게 필요합니다. 문제는 넓어진 범위가 공유만 늘리지 않는다는 점입니다.

쿠키는 **서브도메인 사이에 벽이 없습니다.** 어느 한 호스트에서 심은 `Domain=example.com` 쿠키는 다른 호스트 요청에도 실립니다.
그러니까 서브도메인 하나가 뚫리면, 거기서 심은 쿠키가 다른 서비스로 실려 갑니다. 값을 미리 고정해두는 세션 고정 공격의 경로가 되기도 합니다.

문서용 정적 호스팅, 외부 SaaS에 CNAME으로 붙인 서브도메인, 예전에 쓰다 만 테스트 호스트 — 이런 것들이 다 같은 쿠키 범위 안에 들어옵니다.

그래서 기준은 단순합니다. **공유가 꼭 필요한 쿠키만 `Domain`을 붙이고, 나머지는 호스트 전용으로 둡니다.**

호스트 전용을 못 바꾸게 못 박는 접두사도 있습니다.

```http
Set-Cookie: __Host-sid=...; Secure; Path=/; HttpOnly; SameSite=Lax
```

`__Host-` 접두사가 붙은 쿠키는 `Secure`여야 하고, `Domain`을 가질 수 없고, `Path=/`여야 합니다. 조건을 어기면 브라우저가 저장을 거부합니다.
서브도메인 쪽에서 같은 이름의 쿠키를 덮어쓰는 경로가 막히므로, 세션 쿠키에는 붙여둘 만합니다.
`__Secure-` 접두사는 `Secure`만 요구하는 약한 버전입니다.

`Path`는 보안 경계가 아니라 전송 범위입니다. 경로를 좁혀도 같은 출처의 스크립트에서 다른 경로 쿠키에 접근할 길이 있으므로, 격리 수단으로 기대지 마세요.

## 저장조차 안 되는 경우 — 크로스 사이트 요청의 Set-Cookie

프런트가 `app.example.com`, API가 `api.other.com`처럼 사이트가 갈린 구성에서 가장 흔한 증상입니다.
로그인 응답에 `Set-Cookie`가 왔는데 저장이 안 됩니다.

조건이 양쪽에 다 걸려 있습니다. 클라이언트는 자격증명을 실어 보내겠다고 해야 하고,

```typescript
await fetch('https://api.other.com/login', {
  method: 'POST',
  credentials: 'include',          // 이게 없으면 쿠키를 보내지도 받지도 않는다
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
```

서버는 자격증명 허용과 **구체적인 출처**를 같이 돌려줘야 합니다.

```typescript
import cors from 'cors';

app.use(
  cors({
    origin: ['https://app.example.com'],   // 와일드카드와 credentials는 같이 못 쓴다
    credentials: true,                     // Access-Control-Allow-Credentials: true
  }),
);
```

`Access-Control-Allow-Origin: *`와 `credentials: true`는 함께 쓸 수 없습니다. 하나라도 빠지면 브라우저가 응답을 받아놓고 쿠키를 버립니다.
네트워크 탭에는 `Set-Cookie`가 그대로 보이니 서버를 의심하기 쉬운데, 서버는 제 할 일을 한 상태입니다.

쿠키 쪽 속성도 당연히 `SameSite=None; Secure`여야 합니다. 앞 절의 수명 문제가 그대로 따라옵니다.

> 프리플라이트(`OPTIONS`) 요청에는 쿠키가 실리지 않습니다. 프리플라이트 핸들러에서 인증을 요구하면 본 요청이 시작조차 못 합니다.

가능하면 **프런트와 API를 같은 사이트로 맞추는 쪽**이 훨씬 덜 아픕니다. `app.example.com`과 `api.example.com`이면 `SameSite=Lax`로 끝나고, 서드파티 쿠키 정책 변화에 흔들리지 않습니다.
도메인을 하나 더 붙이는 비용과, 크로스 사이트 쿠키를 평생 관리하는 비용을 견주면 대개 전자가 쌉니다.

## Secure가 프록시 뒤에서 틀어지는 자리

`Secure` 쿠키는 보안 컨텍스트에서만 심기고 실립니다. 운영에서는 https이니 문제가 없는데, 두 군데서 어긋납니다.

하나는 **로드밸런서가 TLS를 끊어주는 구성**입니다. 애플리케이션이 받는 요청은 평문 http이므로, 프레임워크가 "안전하지 않은 연결"이라 판단해 `Secure` 쿠키를 아예 심지 않거나 거부합니다.

```typescript
app.set('trust proxy', 1);   // X-Forwarded-Proto 를 신뢰해 req.secure 를 판단

app.use(
  session({
    name: '__Host-sid',
    cookie: { secure: true, httpOnly: true, sameSite: 'lax', path: '/' },
    // ...
  }),
);
```

`trust proxy`는 `X-Forwarded-*` 헤더를 믿겠다는 선언입니다. 그래서 **신뢰할 수 있는 프록시 뒤에서만** 켜야 합니다. 아무나 그 헤더를 넣을 수 있는 경로라면 스킴과 클라이언트 IP 판단을 공짜로 넘겨주는 셈이 됩니다.

다른 하나는 로컬 개발입니다. 브라우저는 `localhost`를 안전한 출처로 취급하는 경우가 있어 http에서도 `Secure` 쿠키가 동작할 수 있지만, 브라우저와 버전에 따라 다릅니다.
로컬에서만 로그인이 안 되면 여기를 의심하고, 환경에 따라 속성을 나누세요.

```typescript
const isProd = process.env.NODE_ENV === 'production';

res.cookie('sid', token, {
  httpOnly: true,
  secure: isProd,
  sameSite: 'lax',
  path: '/',
  maxAge: 1000 * 60 * 60 * 24 * 14,
});
```

## 쿠키가 커지면 헤더가 막는다

쿠키 하나의 크기와 도메인별 개수에는 브라우저마다 한도가 있습니다. 대략 수 KB 수준이고, 넘으면 **저장이 조용히 실패합니다.** 예외도 에러 응답도 없습니다.

더 먼저 터지는 건 프록시입니다. 앞단 웹서버와 로드밸런서에는 요청 헤더 전체 크기 한도가 있어서, 쿠키가 쌓이면 서버 코드에 닿기 전에 400이나 431로 끊깁니다.
증상은 "특정 사용자만 로그인 후 모든 요청이 실패"처럼 나타납니다. 오래 쓴 서비스에서 분석·실험·동의 관련 쿠키가 누적되면 현실적으로 닿는 한도입니다.

그래서 쿠키에는 **식별자만** 둡니다. 권한 목록이나 프로필 같은 걸 넣기 시작하면 모든 요청마다 그 바이트를 실어 보내게 되고, 갱신도 어려워집니다.

## SameSite는 CSRF 방어를 대체하지 않는다

`SameSite=Lax`가 다른 사이트의 POST를 막아주니 CSRF 토큰을 빼도 되지 않냐는 이야기가 나옵니다. 방어가 한 겹 늘어난 건 맞지만, 대체는 아닙니다.

`Lax`는 **안전한 메서드의 최상위 이동**에는 쿠키를 실어 보냅니다. 그러니 GET으로 상태를 바꾸는 엔드포인트가 하나라도 있으면 그 경로는 그대로 열려 있습니다.
링크 클릭만으로 탈퇴나 삭제가 되는 API를 만들지 않는 것이 먼저입니다.

같은 사이트 안에서 올라오는 요청도 `SameSite`가 걸러주지 않습니다. 서브도메인 하나가 뚫린 상황이 그 경우입니다.

서버에서 한 겹 더 보려면 브라우저가 붙여주는 메타 헤더를 봅니다.

```typescript
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ALLOWED_ORIGINS = new Set(['https://app.example.com']);

app.use((req, res, next) => {
  if (!UNSAFE.has(req.method)) return next();

  const site = req.get('sec-fetch-site');          // same-origin | same-site | cross-site | none
  if (site && site !== 'same-origin' && site !== 'same-site') {
    return res.status(403).json({ code: 'CROSS_SITE_FORBIDDEN' });
  }

  const origin = req.get('origin');                 // 폼 전송·fetch 에는 붙는다
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return res.status(403).json({ code: 'ORIGIN_FORBIDDEN' });
  }

  return next();
});
```

두 헤더 모두 **없을 수 있다**는 점이 중요합니다. 지원하지 않는 클라이언트나 서버 간 호출에는 붙지 않으므로, 없으면 거부하는 규칙은 멀쩡한 호출을 끊습니다.
그래서 이건 보조 장치이고, 상태를 바꾸는 요청에는 토큰 검증을 같이 둡니다.

## 쿠키냐 Authorization 헤더냐

같은 토큰을 어디에 실을지는 클라이언트 종류가 정합니다.

| | 쿠키 | `Authorization` 헤더 |
| --- | --- | --- |
| 스크립트 탈취(XSS) | `HttpOnly`면 읽히지 않음 | 저장소에 두면 읽힘 |
| CSRF | 자동 전송되므로 따로 막아야 함 | 자동 전송되지 않음 |
| 크로스 사이트 | 브라우저 정책에 묶임 | 영향 없음 |
| 네이티브 앱·서버 간 호출 | 쿠키 저장소 동작이 제각각 | 다루기 쉬움 |

웹 브라우저가 주 클라이언트면 `HttpOnly` 쿠키가 낫습니다. XSS가 났을 때 토큰 자체를 들고 나가지 못하는 쪽이 피해가 작습니다.
앱과 외부 연동이 주라면 헤더가 낫습니다. 쿠키 정책과 싸울 일이 없습니다.

둘을 섞어야 할 때는 **경계를 엔드포인트로 나눕니다.** 브라우저용 세션 갱신 엔드포인트만 쿠키를 읽고, 나머지 API는 헤더만 봅니다.
한 엔드포인트가 둘 다 받아들이게 두면, 쿠키로 들어온 요청에만 필요한 CSRF 검증이 헤더 경로에서 조용히 비활성화되는 구성이 되기 쉽습니다.

{% comment %} TODO: 쿠키 속성 때문에 실제로 겪은 일이 있다면 적어주세요. 어떤 구성이었고 무엇을 바꿔서 풀었는지 {% endcomment %}

## 지울 때도 속성이 맞아야 한다

쿠키 삭제는 같은 이름에 만료를 과거로 준 `Set-Cookie`를 다시 보내는 일입니다.
이때 **`Domain`과 `Path`가 심을 때와 같아야** 합니다. 다르면 브라우저는 다른 쿠키로 보고, 원래 쿠키는 그대로 남습니다.

```http
Set-Cookie: sid=; Domain=example.com; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax
```

로그아웃을 눌렀는데 계속 로그인 상태인 버그의 절반은 여기서 옵니다. 과거에 `Domain` 있는 쿠키와 호스트 전용 쿠키를 둘 다 심은 이력이 있으면, 이름이 같은 쿠키가 두 개 저장돼 있고 요청에는 둘 다 실립니다.
서버는 그중 하나만 읽습니다. 어느 쪽을 읽는지는 보장되지 않습니다.

그래서 쿠키 이름과 속성 조합을 바꿀 때는, 새 이름으로 심고 **옛 이름을 명시적으로 지우는 경로**를 한동안 같이 둬야 합니다.

`Expires`나 `Max-Age`를 아예 주지 않은 쿠키는 세션 쿠키가 되어 브라우저를 닫으면 사라집니다. 다만 세션 복원 기능이 켜져 있으면 되살아나는 경우가 있어, 기대보다 오래 남습니다.

## 확인하는 순서

증상이 났을 때 추측보다 빠른 건 응답 헤더를 그대로 보는 것입니다.

```bash
curl -i -s -X POST https://api.example.com/login \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://app.example.com' \
  -d '{"email":"a@b.c","password":"..."}' | grep -i -E 'set-cookie|access-control'
```

- `Set-Cookie`가 응답에 있는가 — 없으면 서버 문제입니다.
- 있는데 저장이 안 되는가 — `Secure`, `SameSite=None` 조합, `__Host-` 조건, 크로스 사이트라면 `Access-Control-Allow-Credentials`와 구체적 출처를 봅니다.
- 저장은 됐는데 안 실리는가 — 브라우저 저장소에서 쿠키의 `Domain`·`Path`·`SameSite`를 확인하고, 그 요청이 같은 사이트인지부터 가릅니다.
- 같은 이름의 쿠키가 두 개 있지 않은가 — 이게 보이면 원인은 거의 여기입니다.

쿠키는 속성 다섯 개가 전부인데, 그 다섯 개가 저장·전송·접근이라는 서로 다른 축에 걸쳐 있습니다.
증상에서 축을 먼저 가르면, 볼 곳은 매번 한 줄로 줄어듭니다.
