---
layout: post
title: "목록 한 화면에 원본 사진 40장이 나간다 — 이미지 변환을 어디에 둘 것인가"
date: 2026-11-17
tags: [backend, aws, cloudfront, performance, typescript]
excerpt: "업로드된 원본을 그대로 내려주다 생기는 일에서 출발해, 사전 생성과 요청 시 변환의 트레이드오프, 캐시 키를 프리셋으로 묶는 이유, 디코딩 폭탄과 EXIF 처리, 같은 변환이 동시에 N번 도는 문제까지."
---

요즘 휴대폰으로 찍은 사진 한 장은 수 MB입니다.
그걸 받아서 S3에 넣고, 목록 API에서 그 키로 URL을 만들어 내려주면 기능은 완성됩니다.

목록 한 화면이 40장이면 100MB가 넘게 나가고 있다는 사실은 기능이 완성된 뒤에 드러납니다.
그리고 이 문제를 고치는 방법은 한 가지가 아니라, 어디서 줄일지를 고르는 문제입니다.

## 원본을 그대로 내려주면 어디가 먼저 아픈가

눈에 먼저 보이는 건 전송량입니다. CDN 비용이 늘고, 모바일에서는 목록이 스크롤을 따라오지 못합니다.

하지만 더 고약한 쪽은 **디코딩**입니다. 4000×3000 JPEG을 100px 썸네일로 그리려면 클라이언트가 일단 1200만 픽셀을 메모리에 펼쳐야 합니다.
목록에 40장이면 그걸 40번 합니다. 네트워크가 빨라도 느린 이유가 여기 있고, 저사양 기기에서는 앱이 그냥 죽습니다.

그래서 "작게 내려주기"는 대역폭 최적화가 아니라 **클라이언트 메모리 문제**이기도 합니다. 캐시를 잘 걸어서 해결되는 종류가 아닙니다.

## 줄이는 위치는 세 군데다

| | 업로드 시 사전 생성 | 요청 시 변환 + CDN | 클라이언트 리사이즈 후 업로드 |
| --- | --- | --- | --- |
| 첫 요청 지연 | 없음 (이미 있다) | 변환 시간만큼 | 없음 |
| 변형 추가 | 과거 데이터 전부 백필 | URL만 바꾸면 끝 | 불가 (원본이 이미 작다) |
| 저장 비용 | 변형 수에 비례 | 캐시만큼 | 가장 낮다 |
| 원본 보존 | 보존 | 보존 | **원본이 없다** |
| 변환 비용 | 업로드당 1회 | 캐시 미스당 1회 | 0 |
| 트래픽 폭증 시 | 안전 | 변환기가 병목 | 안전 |

클라이언트 리사이즈는 업로드 대역폭까지 줄여주지만, 원본이 영구히 사라집니다.
나중에 "확대해서 보기"나 "원본 내려받기"가 요구사항으로 들어오면 되돌릴 방법이 없습니다. 보존이 조금이라도 의미 있는 서비스라면 원본은 받아두고, 줄이는 건 서버에서 하는 쪽이 안전합니다.

사전 생성과 요청 시 변환 중에서는, **변형 목록이 앞으로 늘어날 것 같은지**가 실질적인 갈림길입니다.
화면이 추가될 때마다 새 크기가 필요한 서비스에서 사전 생성을 고르면, 그때마다 과거 전체를 다시 돌리는 배치를 써야 합니다.

## 사전 생성 — 변형 목록이 곧 운영 부담이다

업로드 완료를 트리거로 변환을 돌리는 구조입니다. S3 이벤트든 큐든, 업로드 경로와 분리하는 게 중요합니다.

```typescript
import sharp from "sharp";

const PRESETS = {
  thumb:  { width: 160,  height: 160,  fit: "cover"  as const },
  card:   { width: 480,  height: 360,  fit: "cover"  as const },
  detail: { width: 1280, height: 1280, fit: "inside" as const },
};

export async function generateVariants(origin: Buffer, keyBase: string) {
  // 원본 메타데이터는 한 번만 읽는다
  const meta = await sharp(origin).metadata();

  for (const [name, p] of Object.entries(PRESETS)) {
    const out = await sharp(origin, { limitInputPixels: 50_000_000, failOn: "error" })
      .rotate()                       // EXIF 방향을 픽셀로 반영한다 (resize보다 먼저)
      .resize({ ...p, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    await putObject(`derived/${keyBase}/${name}.webp`, out, "image/webp");
  }

  return { width: meta.width, height: meta.height };
}
```

`withoutEnlargement`를 빼먹으면 작은 원본을 억지로 키워서 저장합니다. 용량만 늘고 화질은 그대로입니다.

`fit`은 용도에 따라 갈립니다. 목록 카드는 비율을 맞춰 잘라내는 `cover`가 자연스럽고, 상세 화면은 잘리면 안 되니 긴 변 기준으로 맞추는 `inside`가 맞습니다.
이걸 하나로 통일하려다 보면 어느 한쪽이 이상해집니다.

사전 생성에서 실제로 부담이 되는 건 변환 자체가 아니라 **되돌리기**입니다.
프리셋 하나를 추가하거나 품질 설정을 바꾸면 과거 데이터에는 적용되지 않습니다. 그래서 전체 재생성 배치가 필요하고, 그 배치는 원본 수에 비례해서 돕니다.

대안은 **부분 사전 생성**입니다. 목록처럼 반드시 쓰이는 크기 하나만 미리 만들고, 나머지는 요청 시 변환에 맡깁니다.
가장 자주 보이는 화면의 첫 요청 지연을 없애면서 변형 추가의 자유도는 유지하는 조합입니다.

## 요청 시 변환 — 캐시가 설계의 전부다

URL에 변환 조건을 담고, 그 URL이 처음 호출될 때 만들어 CDN이 캐시하는 구조입니다.

```text
https://img.example.com/derived/9f/3c/abc123/card.webp
                        ^^^^^^^ 원본 키 + 프리셋 이름
```

배치는 크게 두 가지입니다.

**CDN 캐시만 쓰는 방식.** CDN 미스가 오리진(변환기)으로 가고, 변환기가 원본을 읽어 변환해 응답합니다.
단순하지만 **CDN에서 객체가 밀려나거나 TTL이 지나면 같은 변환을 또 돕니다.** 접근이 드문 이미지가 많은 서비스에서는 이 재변환이 꾸준한 비용으로 남습니다.

**파생 버킷에 영구화하는 방식.** CDN 오리진은 파생 버킷이고, 거기에 객체가 없으면(404) 변환기가 만들어 **버킷에 쓴 뒤** 응답합니다.
이후로는 CDN 캐시가 비어도 오리진에서 바로 나옵니다. 변환이 원본·프리셋 조합당 평생 한 번으로 수렴합니다.

```typescript
// 파생 버킷 미스를 변환으로 메우는 경로
export async function handleDerivedMiss(path: string) {
  const parsed = parseDerivedPath(path);        // 원본 키 + 프리셋 이름
  if (!parsed) return notFound();               // 규칙에 안 맞는 경로는 바로 거절

  const origin = await getObject(parsed.originKey);
  if (!origin) return notFound();

  const out = await transform(origin.body, PRESETS[parsed.preset]);

  // 다음 요청부터는 변환 없이 버킷에서 나간다
  await putObject(path, out, "image/webp", {
    cacheControl: "public, max-age=31536000, immutable",
  });

  return { body: out, contentType: "image/webp" };
}
```

영구화의 대가는 정리입니다. 원본이 삭제되면 파생물이 고아로 남고, 쓰이지 않는 프리셋의 파생물도 계속 쌓입니다.
파생 버킷에는 **수명주기 규칙을 걸어두는 편**이 낫습니다. 지워져도 다음 요청에 다시 만들어지니 손실이 아닙니다. 이게 파생물을 원본과 **다른 버킷**에 두는 이유이기도 합니다.

> `Cache-Control: immutable`은 경로가 내용에 1:1로 묶여 있을 때만 안전합니다. 같은 경로의 내용이 바뀔 수 있다면 쓰면 안 됩니다.
> 자세한 건 [자산 캐시와 배포 순서](/blog/static-asset-cache-deploy-invalidation/)에 적어둔 것과 같은 이야기입니다.

## 파라미터를 열어두면 캐시가 무의미해진다

요청 시 변환을 만들면 `?w=320&h=240&q=80` 같은 형태가 제일 먼저 떠오릅니다. 유연하고, 프런트에서 쓰기 편합니다.

그리고 그 순간 **캐시 키가 무한해집니다.** `w=320`과 `w=321`은 서로 다른 객체이고, 각각 한 번씩 변환을 돌립니다.
악의가 없어도 그렇습니다. 반응형 레이아웃이 컨테이너 너비를 그대로 넘기면 기기마다 다른 값이 들어옵니다.

악의가 있으면 더 간단합니다. `w`를 1부터 4000까지 올려가며 호출하는 것만으로 변환기를 포화시킬 수 있습니다.
원본 한 장으로 수천 번의 디코딩·인코딩을 유발할 수 있다는 뜻이고, 이건 캐시가 막아주지 않습니다. 전부 미스니까요.

그래서 **허용하는 조합을 유한하게 묶습니다.**

```typescript
// 경로에서 프리셋 이름만 받는다. 숫자는 받지 않는다
const DERIVED_PATH = /^derived\/[0-9a-f]{2}\/[0-9a-f]{2}\/([A-Za-z0-9_-]{8,64})\/([a-z]+)\.webp$/;

function parseDerivedPath(path: string) {
  const m = DERIVED_PATH.exec(path);
  if (!m) return null;

  const [, originId, preset] = m;
  if (!(preset in PRESETS)) return null;        // 모르는 프리셋은 404

  return { originKey: `origin/${originId}`, preset: preset as keyof typeof PRESETS };
}
```

프리셋 이름만 받으면 변환 조합이 프리셋 개수로 고정됩니다. 캐시 적중률이 올라가고, 변환 비용 상한이 생깁니다.

임의 크기가 정말 필요하다면 **파라미터에 서명을 붙입니다.** 서버가 발급한 URL만 유효하게 만드는 방식입니다.

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";

function sign(path: string, secret: string) {
  return createHmac("sha256", secret).update(path).digest("base64url").slice(0, 16);
}

function verify(path: string, sig: string, secret: string) {
  const expected = Buffer.from(sign(path, secret));
  const given = Buffer.from(sig);
  // 길이가 다르면 timingSafeEqual이 예외를 던진다
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

서명을 쓰면 유연함은 지키지만, **서명마다 캐시 키가 갈린다**는 점은 그대로입니다. 캐시 효율을 생각하면 서명은 "프리셋으로 못 묶는 예외 경로"에만 두는 게 낫습니다.

{% comment %} TODO: 실제로 어떤 프리셋 조합을 쓰고 있는지, 임의 크기 요구가 있었다면 어떻게 처리했는지 적어주세요 {% endcomment %}

## 변환기 자체가 공격면이다

이미지 디코딩은 신뢰할 수 없는 입력을 파싱하는 일입니다. 업로드 검증을 통과한 파일이라도 변환 단계에서 다시 방어선을 둬야 합니다.

가장 흔한 게 **디코딩 폭탄**입니다. 압축률이 극단적으로 높은 PNG는 파일로는 수십 KB인데 펼치면 수억 픽셀이 됩니다.
파일 크기 제한은 이걸 전혀 막지 못합니다. 걸러야 하는 건 바이트가 아니라 **픽셀 수**입니다.

```typescript
const MAX_PIXELS = 50_000_000;   // 서비스가 받아줄 최대 해상도

const img = sharp(input, {
  limitInputPixels: MAX_PIXELS,  // 초과하면 디코딩 전에 거절
  failOn: "error",               // 깨진 입력을 조용히 통과시키지 않는다
  sequentialRead: true,          // 큰 이미지에서 메모리 사용을 낮춘다
});
```

sharp는 `limitInputPixels`에 기본 상한을 두고 있습니다. 그 기본값은 서비스에서 받아줄 해상도보다 훨씬 큰 편이니, **명시적으로 내려 잡는 게 맞습니다.**

> `failOn`의 허용 값과 `limitInputPixels` 기본값은 버전에 따라 달라졌습니다(과거에는 `failOnError` 불리언이었습니다).
> 쓰는 버전의 문서에서 확인하세요.

그다음은 **포맷 허용 목록**입니다. 특히 SVG는 받지 않는 쪽을 기본으로 두세요.
SVG는 이미지가 아니라 문서이고, 외부 리소스 참조와 스크립트를 담을 수 있습니다. 래스터 변환 과정에서 그 참조가 해석될 여지가 있어서, 성격이 다른 입력입니다.

```typescript
const ALLOWED = new Set(["jpeg", "png", "webp", "avif", "heif"]);

const meta = await img.metadata();
if (!meta.format || !ALLOWED.has(meta.format)) {
  throw new UnsupportedImage(meta.format ?? "unknown");
}
```

판단 기준은 확장자나 `Content-Type`이 아니라 **디코더가 읽은 실제 포맷**입니다. 업로드 쪽 이야기는 [프리사인 업로드](/blog/s3-presigned-upload-validation/)에 따로 적어뒀습니다.

애니메이션도 챙겨야 합니다. 프레임이 수백 장인 GIF나 애니메이션 WebP를 그대로 변환하면 프레임 수만큼 작업이 늘어납니다.
썸네일이라면 첫 프레임만 쓰면 충분합니다. 라이브러리에서 페이지(프레임) 범위를 지정하는 옵션을 확인하세요.

마지막은 **격리와 상한**입니다. 변환은 CPU와 메모리를 함께 먹는 작업이라, API 프로세스와 같은 자리에서 돌리면 변환 몇 건이 전체 응답을 끌고 내려갑니다.
별도 함수나 별도 서비스로 떼고, 요청당 타임아웃과 동시 실행 상한을 둡니다. 이벤트 루프를 쓰는 런타임이라면 더 그렇습니다([이벤트 루프 블로킹](/blog/nodejs-event-loop-blocking/)).

## EXIF — 회전과 위치정보

휴대폰 사진은 센서 방향 그대로 저장되고, "똑바로 보이게 돌려라"는 지시는 EXIF 방향 태그에 들어갑니다.

여기서 조용히 깨지는 조합이 있습니다. 변환 과정에서 메타데이터를 제거하면 **방향 태그도 같이 사라지는데, 픽셀은 돌아가지 않은 상태**라는 것입니다.
원본은 똑바로 보였는데 썸네일만 90도 누워 있는 현상이 이겁니다.

해결은 간단하지만 순서가 중요합니다. **리사이즈 전에 방향을 픽셀로 반영**해야 합니다.

```typescript
await sharp(input)
  .rotate()                     // 인자 없이 호출하면 EXIF 방향을 적용한다
  .resize({ width: 480, height: 360, fit: "cover" })
  .webp({ quality: 80 })
  .toBuffer();
```

`rotate()`를 `resize()` 뒤에 두면 가로·세로가 바뀐 상태로 잘려서, 의도한 구도가 아닌 결과가 나옵니다.

메타데이터 제거는 그 자체로도 필요합니다. 사진의 EXIF에는 **촬영 위치(GPS)와 기기 정보**가 들어 있을 수 있습니다.
사용자가 올린 사진을 공개 URL로 서비스하면서 EXIF를 그대로 두면, 의도하지 않게 위치를 공개하는 셈이 됩니다.

sharp는 기본적으로 메타데이터를 결과물로 옮기지 않습니다. 반대로 **일부러 유지하는 호출을 넣었다면** 무엇이 따라가는지 확인해야 합니다.
색이 틀어지는 걸 막기 위해 ICC 프로필만 남기고 싶은 경우가 있는데, 그때도 GPS까지 통째로 남기지는 않도록 옵션을 좁히세요.

## 포맷 협상 — Accept를 캐시 키에 그대로 넣지 않는다

같은 이미지를 WebP나 AVIF로 내려주면 같은 화질에서 용량이 줄어듭니다. 문제는 **어떤 포맷을 보낼지 어떻게 정하는가**입니다.

요청의 `Accept` 헤더를 보고 고르는 게 정석입니다. 그리고 그걸 CDN 캐시 키에 그대로 넣으면 캐시가 무너집니다.
`Accept` 값은 브라우저와 버전마다 문자열이 미세하게 달라서, 사실상 요청마다 다른 키가 됩니다.

필요한 정보는 전체 문자열이 아니라 **"이 클라이언트가 avif를 받나, webp를 받나, 둘 다 아닌가"** 세 갈래뿐입니다.
그래서 엣지에서 `Accept`를 읽어 정규화한 값으로 바꿔치기하고, 캐시 키에는 그 정규화된 값만 넣습니다.

```javascript
// CloudFront Functions (viewer request) — Accept를 세 갈래로 정규화
function handler(event) {
  var req = event.request;
  var accept = (req.headers.accept && req.headers.accept.value) || "";

  var fmt = accept.indexOf("image/avif") >= 0 ? "avif"
          : accept.indexOf("image/webp") >= 0 ? "webp"
          : "jpeg";

  req.headers["x-image-format"] = { value: fmt };
  delete req.headers.accept;     // 원래 Accept는 캐시 키에서 빼버린다
  return req;
}
```

캐시 정책에서 `x-image-format`만 키에 포함시키면 변형이 원본당 최대 세 벌로 고정됩니다.

오리진 응답에는 `Vary`를 정확히 적어야 합니다. 정규화한 헤더를 기준으로 응답이 갈린다면 `Vary: x-image-format`이고, 이걸 빼먹으면 중간 캐시가 avif 응답을 avif를 못 받는 클라이언트에게 줄 수 있습니다.

AVIF는 공짜가 아닙니다. 인코딩이 WebP보다 뚜렷하게 느려서, **요청 시 변환에서 AVIF를 켜면 캐시 미스 지연이 눈에 띄게 늘어납니다.**
목록처럼 미스가 잦은 경로는 WebP까지만 두고, 상세 화면이나 사전 생성 대상에만 AVIF를 쓰는 식으로 나누는 편이 무난합니다.

> 포맷별 브라우저 지원 범위는 계속 바뀝니다. 지금 기준은 지원 현황 자료를 직접 확인하고, 폴백 경로는 반드시 남겨두세요.

## 같은 변환이 동시에 N번 돈다

새 콘텐츠를 공개한 직후가 가장 위험한 구간입니다. 아직 아무도 그 이미지를 요청하지 않았으니 캐시는 비어 있고, 그 상태에서 요청이 한꺼번에 들어옵니다.

캐시 미스가 전부 변환기로 내려가면 **똑같은 결과를 만드는 작업이 동시에 수백 번** 돕니다.
[캐시 스탬피드](/blog/cache-stampede-swr/)와 같은 구조인데, 이쪽은 미스 한 건의 비용이 DB 쿼리보다 훨씬 비쌉니다.

완화 수단은 세 겹입니다.

**CDN 계층의 동시 요청 병합.** 같은 캐시 키에 대한 동시 요청을 하나로 묶어 오리진에 한 번만 보내는 동작입니다.
CloudFront에는 이 동작과, 리전 캐시 앞에 중간 계층을 두는 Origin Shield가 있습니다. 다만 캐시 동작 설정에 따라 병합이 일어나지 않는 조합이 있으니(최소 TTL 설정 등) 전제를 공식 문서에서 확인하세요.

**변환 단계의 중복 제거.** 오리진에 도달한 요청끼리는 애플리케이션이 직접 막습니다. 짧은 수명의 락을 잡고, 못 잡은 요청은 결과를 기다립니다.

```typescript
// 같은 파생 키에 대한 변환을 한 번만 수행한다
const inflight = new Map<string, Promise<Buffer>>();

function transformOnce(key: string, run: () => Promise<Buffer>) {
  const existing = inflight.get(key);
  if (existing) return existing;

  const p = run().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
```

이 코드는 **프로세스 안에서만** 유효합니다. 변환기가 여러 대로 뜨면 대수만큼은 중복됩니다.
거기까지 막으려면 외부 락이 필요한데, 변환 한 건의 비용과 락 운영 비용을 견줘보면 대개 프로세스 내 중복 제거 + 파생물 영구화로 충분합니다.

**미리 데우기.** 공개 시점이 정해져 있다면, 공개 직전에 주요 프리셋 URL을 한 번씩 호출해 캐시를 채워둡니다.
업로드 시 사전 생성이 결국 이 문제를 구조적으로 없애는 방법이라는 점도 여기서 다시 보입니다.

## 원본이 바뀌면 파생물은 어떻게 되는가

프로필 사진 교체처럼 "같은 대상의 이미지가 바뀌는" 경우가 반드시 생깁니다.

같은 URL을 유지하면서 내용만 바꾸면 **CDN과 브라우저가 옛 이미지를 계속 보여줍니다.** 무효화를 거는 방법도 있지만, 대상이 많아지면 그게 또 일이 됩니다.

더 단순한 답은 **경로를 불변으로 만드는 것**입니다. 원본을 저장할 때마다 새 식별자를 부여하고, 교체는 그 식별자를 바꾸는 것으로 처리합니다.

```text
origin/01HQ...A1/            ← 교체하면 새 식별자가 생긴다
derived/9f/3c/01HQ...A1/card.webp
```

경로가 내용에 묶이니 무효화가 필요 없고, `immutable`을 자신 있게 붙일 수 있습니다.
옛 식별자의 원본과 파생물은 참조가 끊긴 뒤 수명주기 규칙으로 정리합니다.

파생 경로에 `9f/3c` 같은 접두사를 끼워 넣은 이유도 있습니다. 식별자 해시의 앞자리를 디렉터리로 쪼개 한 접두사 아래 객체가 지나치게 몰리지 않게 하는 관행입니다.
요즘 객체 스토리지는 접두사 분산을 알아서 처리하는 편이지만, 목록 조회나 수명주기 규칙을 범위로 걸 때 쪼개진 구조가 다루기 편합니다.

## 정리

- 원본을 그대로 내려주는 건 대역폭 문제만이 아니라 **클라이언트 디코딩 비용** 문제다.
- 원본은 보존하고 변환은 서버에서 한다. 클라이언트 리사이즈는 되돌릴 수 없다.
- 변형 목록이 늘어날 서비스라면 요청 시 변환, 변형이 고정적이라면 사전 생성. 자주 쓰는 하나만 사전 생성하는 조합도 좋다.
- 변환 조건은 **프리셋으로 유한하게 묶는다.** 임의 숫자를 받으면 캐시 키가 무한해지고 변환 비용 상한이 사라진다.
- 픽셀 수 상한을 명시하고, 포맷은 디코더가 읽은 값으로 허용 목록을 검사한다. SVG는 기본적으로 받지 않는다.
- `rotate()`를 `resize()` 전에 두고, 결과물에 GPS가 따라가지 않게 한다.
- `Accept`는 세 갈래로 정규화해서 캐시 키에 넣고, 오리진은 `Vary`를 정확히 쓴다.
- 파생물을 영구화하면 재변환이 사라지고, 경로를 불변으로 만들면 무효화가 사라진다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 부딪힌 것

- 선택한 구조(사전 생성 / 요청 시 변환)와 그 이유
- 프리셋 구성과 변환기 메모리·타임아웃을 어떻게 잡았는지
- 포맷 협상을 어디까지 적용했는지

{% endcomment %}
