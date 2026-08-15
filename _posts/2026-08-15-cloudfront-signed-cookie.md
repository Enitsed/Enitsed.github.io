---
layout: post
title: "CloudFront Signed Cookie로 유료 스트리밍 접근 제어하기"
date: 2026-08-15
tags: [aws, cloudfront, typescript, backend]
excerpt: "S3에 올린 유료 영상을 권한 있는 사용자에게만 재생시키는 방법. Signed URL 대신 Signed Cookie를 쓰는 이유와 AWS SDK v3로 서명 쿠키를 발급하는 코드 정리."
---

NFT(ERC721) 보유 여부로 콘텐츠 접근 권한을 판정하는 스트리밍 플랫폼 **엑스클루시브**에서 쓴 구조를 정리합니다.
원본과 트랜스코딩 결과물은 S3에 두고 CloudFront로 서빙하는데, 버킷을 그냥 열어두면 URL만 알면 누구나 받아갈 수 있습니다.

CloudFront가 제공하는 접근 제어 수단은 Signed URL과 Signed Cookie 두 가지인데,
영상 스트리밍에서는 Signed Cookie 쪽이 훨씬 실용적입니다.

## 왜 Signed URL이 아니라 Signed Cookie인가

Signed URL은 **URL 하나당 서명 하나**입니다. 이미지나 PDF처럼 단일 파일을 내려줄 때는 더할 나위 없이 간단합니다.

문제는 HLS/DASH입니다. HLS로 트랜스코딩하면 결과물이 이렇게 생깁니다.

```text
/content/<id>/master.m3u8
/content/<id>/1080p/index.m3u8
/content/<id>/1080p/seg-00001.ts
/content/<id>/1080p/seg-00002.ts
...
/content/<id>/720p/index.m3u8
/content/<id>/720p/seg-00001.ts
...
```

매니페스트(`.m3u8`)가 참조하는 세그먼트는 수십에서 수백 개입니다.
플레이어는 재생 중에 이 세그먼트를 순차적으로, 화질이 바뀌면 다른 렌디션의 세그먼트까지 요청합니다.
Signed URL 방식을 쓰려면 매니페스트 안의 모든 세그먼트 URL에 서명을 박아 넣어야 하고,
그러려면 매니페스트를 정적 파일로 둘 수 없습니다. 요청이 올 때마다 서버에서 파싱해 URL을 다시 쓰고 반환해야 하고, ABR 스위칭 때 새로 로드되는 하위 매니페스트도 마찬가지입니다.

Signed Cookie는 **정책(policy) 하나로 경로 패턴 전체를 커버**합니다.
`/content/<id>/*`에 대해 한 번 쿠키를 발급해 두면, 그 아래 매니페스트든 세그먼트든 브라우저가 알아서 쿠키를 실어 보냅니다.
매니페스트는 S3에 올린 그대로 두면 되고, CDN 캐시도 정상적으로 동작합니다.

기준은 단순합니다. 서명 대상이 파일 하나면 Signed URL, 한 묶음의 여러 파일에 같은 권한을 적용해야 하면 Signed Cookie입니다.

## CloudFront 키 그룹 준비

서명에 쓸 RSA 키 페어를 만듭니다. CloudFront는 SHA-1 + RSA 서명을 사용하고, 퍼블릭 키는 2048비트 RSA여야 합니다.

```bash
openssl genrsa -out cf-private.pem 2048
openssl rsa -pubout -in cf-private.pem -out cf-public.pem
```

이후 순서는 개념만 알면 콘솔이든 IaC든 동일합니다.

1. **퍼블릭 키 등록** — `cf-public.pem`의 내용을 CloudFront에 퍼블릭 키로 등록합니다. 등록하면 ID가 발급되는데, 이게 나중에 쿠키에 담기는 `CloudFront-Key-Pair-Id` 값입니다.
2. **키 그룹 생성** — 퍼블릭 키를 하나 이상 묶어 키 그룹을 만듭니다. 그룹 단위인 이유는 로테이션 때문입니다. 새 키를 추가해 두 개를 동시에 신뢰 상태로 두고, 신규 서명만 새 키로 바꾼 뒤 기존 쿠키가 모두 만료되면 옛 키를 빼면 됩니다.
3. **비헤이비어에 적용** — 보호할 경로 패턴(예: `/content/*`)으로 캐시 비헤이비어를 만들고, 거기에 *Restrict viewer access*를 켠 뒤 신뢰할 키 그룹으로 위에서 만든 그룹을 지정합니다.

프라이빗 키(`cf-private.pem`)는 서명하는 서버만 가지고 있어야 합니다. 레포에 커밋하지 말고 Secrets Manager나 SSM Parameter Store에 넣어 런타임에 읽어오는 편이 안전합니다.

비헤이비어를 적용한 순간부터 해당 경로는 서명 없이 접근하면 `403 Forbidden`이 떨어집니다. S3 버킷은 OAC(Origin Access Control)로 CloudFront만 접근할 수 있게 잠가 두어야 우회 경로가 없습니다.

## 서버에서 서명 쿠키 발급하기

AWS SDK v3의 `@aws-sdk/cloudfront-signer` 패키지에 `getSignedCookies`가 있습니다.

```bash
npm i @aws-sdk/cloudfront-signer
```

와일드카드 경로를 쓰려면 Custom Policy가 필요합니다. 정책 JSON은 이렇게 생겼습니다.

```json
{
  "Statement": [
    {
      "Resource": "https://cdn.example.com/content/abc123/*",
      "Condition": {
        "DateLessThan": { "AWS:EpochTime": 1755255600 }
      }
    }
  ]
}
```

`Resource`에는 `*`(0개 이상의 문자)와 `?`(정확히 한 문자) 와일드카드를 쓸 수 있고,
`AWS:EpochTime`은 **초 단위** 유닉스 타임스탬프입니다. 이 두 가지가 실수 포인트입니다.

TypeScript로 옮기면 다음과 같습니다.

<!-- TODO: 엑스클루시브에서 실제로 사용한 쿠키 만료 시간(TTL) 값과 그 값을 고른 이유를 채워주세요 -->

```typescript
import { getSignedCookies } from "@aws-sdk/cloudfront-signer";

const CDN_ORIGIN = process.env.CDN_ORIGIN!;        // https://cdn.example.com
const KEY_PAIR_ID = process.env.CF_KEY_PAIR_ID!;   // 퍼블릭 키 ID
const PRIVATE_KEY = process.env.CF_PRIVATE_KEY!;   // PEM 전문

const TTL_SECONDS = 60 * 60;

export function buildContentCookies(contentId: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const resource = `${CDN_ORIGIN}/content/${contentId}/*`;

  const policy = JSON.stringify({
    Statement: [
      {
        Resource: resource,
        Condition: {
          DateLessThan: { "AWS:EpochTime": expiresAt },
        },
      },
    ],
  });

  return {
    cookies: getSignedCookies({
      keyPairId: KEY_PAIR_ID,
      privateKey: PRIVATE_KEY,
      policy,
    }),
    expiresAt,
  };
}
```

`Date.now()`는 밀리초라서 `1000`으로 나눠 초로 바꿔야 합니다.
`policy`를 넘기면 Custom Policy로 서명되고, 반환값은 `CloudFront-Policy`, `CloudFront-Signature`, `CloudFront-Key-Pair-Id` 세 개를 키로 갖는 객체입니다.
(만료 시각만 필요해서 `policy` 대신 `url` + `dateLessThan`을 넘기면 Canned Policy가 되고, 이때는 `CloudFront-Policy` 자리에 `CloudFront-Expires`가 옵니다. 와일드카드는 못 씁니다.)

Express 핸들러에서 세 개를 그대로 `Set-Cookie`로 내려줍니다.

```typescript
import { Router } from "express";

const router = Router();

router.post("/contents/:id/playback-token", async (req, res) => {
  const { id } = req.params;

  const allowed = await canAccessContent(req.user.address, id);
  if (!allowed) return res.status(403).json({ message: "NO_ACCESS" });

  const { cookies, expiresAt } = buildContentCookies(id);

  for (const [name, value] of Object.entries(cookies)) {
    res.cookie(name, String(value), {
      domain: ".example.com",
      path: `/content/${id}/`,
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      expires: new Date(expiresAt * 1000),
    });
  }

  res.json({
    manifestUrl: `${process.env.CDN_ORIGIN}/content/${id}/master.m3u8`,
    expiresAt,
  });
});
```

`Path`를 콘텐츠별 경로로 좁혀 두면, 한 사용자가 여러 콘텐츠를 볼 때 쿠키가 서로 덮어쓰이지 않습니다.
루트(`/`)로 설정하면 새 콘텐츠 재생 시 이전 쿠키가 교체되어 버립니다.

## 쿠키 도메인과 보안 속성

가장 걸리기 쉬운 조건이 하나 있습니다. **쿠키를 내려주는 서버와 CloudFront가 같은 상위 도메인 아래에 있어야 합니다.**

브라우저는 응답을 준 호스트의 상위 도메인으로만 `Domain` 속성을 지정할 수 있습니다.
API가 `api.example.com`이면 `Domain=.example.com`까지는 설정할 수 있지만, 등록 도메인이 다른 `d111111abcdef8.cloudfront.net`에는 쿠키를 심을 수 없습니다.

그래서 배포에 커스텀 도메인(예: `cdn.example.com`)을 CNAME으로 붙이고 ACM 인증서를 연결하는 것이 사실상 필수입니다.
그러면 `api.example.com`이 `Domain=.example.com`으로 내려준 쿠키가 `cdn.example.com` 요청에 자동으로 실립니다.

나머지 속성은 이렇게 잡습니다.

- `Secure` — 필수입니다. CloudFront는 HTTPS로 서빙되고, `SameSite=None`을 쓸 거면 브라우저가 `Secure`를 강제합니다.
- `HttpOnly` — 서명 쿠키는 JS에서 읽을 일이 없습니다. XSS로 유출되는 경로를 막습니다.
- `SameSite` — CDN과 앱이 같은 등록 도메인(`*.example.com`)이면 `Lax`로 충분합니다. 도메인이 완전히 다르면 `None`을 써야 하는데, 이건 아래 함정 항목에서 다시 이야기합니다.

## 권한 검증과 결합하기

쿠키 발급 엔드포인트는 곧 **인가(authorization) 지점**입니다. 흐름은 단순합니다.

1. 요청자를 인증한다(세션/JWT).
2. 이 사용자가 해당 콘텐츠에 접근할 권한이 있는지 판정한다.
3. 통과하면 그 콘텐츠 경로에만 유효한 쿠키를 발급한다.

엑스클루시브에서는 2번 판정을 **ERC721 NFT 보유 여부**로 했습니다.
콘텐츠마다 대응하는 컬렉션이 있고, 지갑이 그 토큰을 들고 있으면 재생 권한이 있는 구조입니다.

<!-- TODO: 실제 NFT 보유 판정 로직(체인 RPC 직접 조회 / 인덱서 사용 여부, 캐싱 전략과 TTL)을 채워주세요 -->

```typescript
async function canAccessContent(address: string, contentId: string): Promise<boolean> {
  // 콘텐츠 -> 컬렉션 컨트랙트 주소 매핑
  // ERC721 balanceOf(address) > 0 확인
  throw new Error("not implemented");
}
```

여기서 중요한 건 **판정 결과가 쿠키 수명 동안 유지된다**는 점입니다.
쿠키 TTL이 한 시간이면, 발급 직후 NFT를 팔아도 한 시간 동안은 재생이 됩니다.
권한 회수를 빠르게 반영하려면 TTL을 짧게 잡고 플레이어가 주기적으로 갱신 요청을 보내야 합니다.
TTL을 줄이면 갱신 요청이 늘어나니 트레이드오프를 어디에 둘지는 서비스 성격에 따라 다릅니다.

<!-- TODO: 엑스클루시브에서 TTL과 갱신 주기를 어떻게 정했는지, 그 판단 근거를 채워주세요 -->

## 자주 겪는 함정

**만료 시각 단위.** `AWS:EpochTime`은 초입니다. `Date.now()`를 그대로 넣으면 값이 천 배가 되고, 반대로 초를 밀리초 자리에 넣으면 이미 지난 시각이 됩니다. 어느 쪽이든 403이 떨어지는데 응답이 똑같아서 원인 찾기가 번거롭습니다.

**클럭 스큐.** 만료 판정은 CloudFront 시계 기준입니다. 서명 서버 시계가 앞서 있으면 의도보다 일찍 만료되고, `DateGreaterThan`(시작 시각)을 정책에 넣었다면 "아직 유효 기간이 안 됐다"며 거부될 수 있습니다. 시작 시각은 넣지 않거나, 넣더라도 몇 분 여유를 빼 두는 편이 안전합니다. 서버에는 시간 동기화(chrony/NTP)를 걸어 둡니다.

**CORS 요청에 쿠키가 안 실린다.** `fetch`/`XMLHttpRequest`는 기본적으로 크로스 오리진 요청에 쿠키를 보내지 않습니다. hls.js처럼 XHR로 세그먼트를 받는 플레이어는 명시적으로 켜 줘야 합니다.

```typescript
import Hls from "hls.js";

const hls = new Hls({
  xhrSetup: (xhr) => {
    xhr.withCredentials = true;
  },
});
hls.loadSource(manifestUrl);
hls.attachMedia(video);
```

`<video>`로 직접 HLS를 재생하는 경우(Safari 등)에는 엘리먼트에 `crossorigin="use-credentials"`를 붙입니다.

서버 쪽도 짝을 맞춰야 합니다. 자격 증명이 포함된 요청에는 `Access-Control-Allow-Origin`에 `*`를 쓸 수 없고 정확한 오리진을 돌려줘야 하며, `Access-Control-Allow-Credentials: true`가 필요합니다. CloudFront의 응답 헤더 정책이나 S3 CORS 설정에서 잡아 줍니다.

**서드파티 쿠키 차단.** CDN 도메인이 앱과 완전히 다른 등록 도메인이면(예: 앱은 `example.com`, CDN은 `*.cloudfront.net`) 그 쿠키는 서드파티 쿠키입니다. Safari의 ITP나 서드파티 쿠키를 막는 브라우저 설정에서는 조용히 버려집니다. 근본 해법은 앞서 말한 커스텀 도메인입니다. CDN을 앱과 같은 등록 도메인의 서브도메인으로 두면 퍼스트파티 쿠키가 됩니다.

**재생 중 만료.** 쿠키가 만료되면 그 시점 이후의 세그먼트 요청이 403을 받고, 플레이어는 대개 네트워크 에러로 처리합니다. 만료 시각을 클라이언트에 함께 내려주고(위 핸들러의 `expiresAt`) 만료 전에 미리 갱신 요청을 보내도록 만드는 편이 안전합니다. hls.js라면 `Hls.Events.ERROR`에서 403일 때 재발급받아 복구하는 경로도 함께 두면 좋습니다.

## 정리

- 키 그룹을 만들어 비헤이비어에 걸고, 서버는 Custom Policy로 `/content/<id>/*` 범위의 쿠키 3종을 발급합니다.
- CDN을 앱과 같은 등록 도메인의 서브도메인으로 두면 도메인·SameSite·서드파티 쿠키 문제가 한 번에 정리됩니다.
- 만료 시각은 초 단위이고, 쿠키 수명만큼 권한 회수가 지연된다는 점을 감안해 TTL을 정합니다.
