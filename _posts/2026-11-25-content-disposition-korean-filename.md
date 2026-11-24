---
layout: post
title: "'원아 명단.xlsx'로 내려받았는데 'download'로 저장된다 — Content-Disposition과 한글 파일명"
date: 2026-11-25
tags: [backend, typescript, api, aws, security]
excerpt: "한글 파일명을 헤더에 넣으면 서버가 예외를 던지거나 브라우저가 '???'로 저장하는 이유. filename과 filename*의 차이, RFC 5987 인코딩을 직접 할 때 encodeURIComponent가 빠뜨리는 문자, 파일명 정제와 바이트 단위 자르기, fetch·S3 프리사인 URL로 받을 때 헤더가 무시되는 경로, inline과 attachment의 보안 차이."
---

다운로드 버튼을 누르면 파일은 받아집니다. 그런데 저장된 이름이 `download`이거나 `???.xlsx`이고, 어떤 환경에서는 아예 500이 납니다.
파일 내용은 멀쩡하니 버그 리포트도 "이름이 이상해요" 정도로 들어옵니다. 원인은 HTTP 헤더가 원래 한글을 담도록 만들어지지 않았다는 데 있습니다.

## 헤더에 한글을 그대로 넣으면

가장 먼저 해보는 코드는 이렇습니다.

```typescript
res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
```

`name`이 `원아 명단.xlsx`라면 Node.js에서는 응답이 나가기도 전에 예외가 납니다.

```text
TypeError [ERR_INVALID_CHAR]: Invalid character in header content ["Content-Disposition"]
```

Node.js의 HTTP 모듈은 헤더 값에 탭, 출력 가능한 ASCII, 그리고 `0x80`~`0xFF` 범위의 문자만 허용합니다. 헤더 값을 바이트 하나당 문자 하나(Latin-1)로 다루기 때문입니다.
한글 음절은 이 범위를 한참 넘으니 거부됩니다. 같은 검사 덕분에 파일명에 섞인 `\r\n`으로 헤더를 끼워 넣는 공격도 여기서 막힙니다.

여기서 흔히 쓰는 우회가 UTF-8 바이트를 Latin-1 문자열인 척 넘기는 방법입니다.

```typescript
// 이렇게 하면 예외는 안 나지만 권하지 않는다
const raw = Buffer.from(name, "utf8").toString("latin1");
res.setHeader("Content-Disposition", `attachment; filename="${raw}"`);
```

헤더에는 UTF-8 바이트가 그대로 실리고, 그 바이트를 UTF-8로 읽어줄지 Latin-1로 읽을지는 **받는 쪽 마음**입니다.
어떤 브라우저에서는 제대로 보이고 어떤 클라이언트에서는 `ì›ì•„`처럼 깨집니다. 표준이 정해둔 방법이 따로 있으니 그쪽을 씁니다.

## filename과 filename*

`Content-Disposition`의 파라미터는 RFC 6266이 정의하고, 비 ASCII 값을 싣는 방법은 RFC 5987(현행 RFC 8187)의 확장 표기를 따릅니다.
파라미터 이름 뒤에 `*`를 붙이고, `문자셋'언어'퍼센트인코딩된값` 형태로 씁니다.

```text
Content-Disposition: attachment; filename="export.xlsx"; filename*=UTF-8''%EC%9B%90%EC%95%84%20%EB%AA%85%EB%8B%A8.xlsx
```

두 개를 같이 보내는 이유가 있습니다.

- `filename*` — 실제로 보여주고 싶은 이름. 현대 브라우저는 둘 다 있으면 이쪽을 우선합니다.
- `filename` — `filename*`를 해석하지 못하는 클라이언트를 위한 대체 이름. ASCII만 넣습니다.

RFC 6266도 둘을 함께 보낼 때 `filename`을 먼저, `filename*`를 뒤에 두라고 권합니다. 앞쪽만 읽고 마는 구현이 있기 때문입니다.

> 언어 자리(`''` 사이)는 비워두는 게 보통입니다. 문자셋은 `UTF-8`만 쓴다고 생각하면 됩니다.
> RFC 8187은 수신 측이 반드시 지원해야 하는 문자셋으로 UTF-8을 정해두었습니다.

## 라이브러리에 맡길 때 생기는 '???'

Express의 `res.attachment()`와 `res.download()`는 내부에서 `content-disposition` 패키지를 써서 이 헤더를 만들어줍니다.
직접 호출하면 무엇이 나오는지 보입니다.

```typescript
import contentDisposition from "content-disposition";

contentDisposition("원아 명단 (최종).xlsx");
// attachment; filename="?? ?? (??).xlsx"; filename*=UTF-8''%EC%9B%90...%29.xlsx
```

`filename*`는 제대로 들어갑니다. 문제는 대체 이름입니다. 기본 동작은 Latin-1로 표현할 수 없는 문자를 `?`로 바꾸는 것이라, 한글 파일명이면 물음표만 남습니다.
`filename*`를 읽는 브라우저에서는 안 보이지만, 그걸 못 읽는 도구로 받으면 `?? ??.xlsx`라는 이름이 됩니다. 윈도우에서는 `?`가 파일명에 쓸 수 없는 문자라 그대로 저장되지도 않습니다.

대체 이름은 직접 지정하는 편이 낫습니다.

```typescript
res.setHeader(
  "Content-Disposition",
  contentDisposition("원아 명단 (최종).xlsx", { fallback: "roster.xlsx" }),
);
// attachment; filename="roster.xlsx"; filename*=UTF-8''%EC%9B%90...
```

`fallback`에 다시 한글을 넣으면 `fallback must be ISO-8859-1 string`으로 예외가 납니다. 날짜나 ID를 섞은 ASCII 이름을 만들어 넣으면 됩니다.

## 직접 만든다면 — encodeURIComponent가 남기는 문자

라이브러리를 쓰지 않거나 다른 런타임에서 같은 헤더를 만들어야 할 때가 있습니다. 퍼센트 인코딩이니 `encodeURIComponent`면 될 것 같지만 한 가지가 빠집니다.

```typescript
encodeURIComponent("명단 (최종)*'.xlsx");
// "%EB%AA%85%EB%8B%A8%20(%EC%B5%9C%EC%A2%85)*'.xlsx"
```

`encodeURIComponent`는 `! ' ( ) *`를 인코딩하지 않습니다. 그런데 RFC 5987의 값 문법(`attr-char`)은 `'`, `(`, `)`, `*`를 허용하지 않습니다.
특히 `'`는 문자셋과 언어를 나누는 구분자라, 파일명에 섞여 있으면 파서가 값을 엉뚱한 위치에서 자를 수 있습니다. 괄호는 "최종 (1)" 같은 이름에 흔히 들어갑니다.

```typescript
export function encodeRFC5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}
```

MDN의 `encodeURIComponent` 문서에 같은 목적의 예제가 있으니 함께 확인해보세요.

## 헤더보다 먼저 — 파일명 정제

인코딩이 정확해도 이름 자체가 문제인 경우가 있습니다. 파일명은 대개 사용자가 입력한 제목이나 업로드 당시 원래 이름에서 오기 때문입니다.

- 경로 구분자(`/`, `\`)나 `..` — 브라우저가 대부분 걸러주지만, 같은 이름을 서버 쪽 경로나 압축 파일 내부 경로에 쓰는 순간 문제가 됩니다.
- 윈도우 예약 문자(`: * ? " < > |`)와 끝에 붙은 점·공백 — 저장 단계에서 브라우저가 임의로 바꿉니다.
- 제어 문자 — 헤더에 넣으면 앞에서 본 `ERR_INVALID_CHAR`가 납니다.
- 길이 — 퍼센트 인코딩하면 한글 한 음절이 `%EC%9B%90`처럼 아홉 글자가 됩니다. 긴 제목이면 헤더가 금방 길어집니다.

길이는 **바이트로** 자릅니다. 파일 시스템의 이름 길이 제한은 보통 바이트 기준이고, 글자 수로 자르면 한글 이름만 유독 제한을 넘습니다.
자를 때는 코드 포인트 단위로 순회해야 이모지나 서로게이트 쌍이 반으로 쪼개지지 않습니다.

```typescript
const encoder = new TextEncoder();

export function sanitizeFilename(input: string, maxBytes = 180): string {
  let name = input
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim()
    .replace(/[. ]+$/, "");
  if (name === "") name = "download";

  // 확장자는 남기고 본문만 자른다
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
  const base = ext ? name.slice(0, dot) : name;

  const budget = maxBytes - encoder.encode(ext).length;
  let out = "";
  let used = 0;
  for (const ch of base) {          // for...of는 코드 포인트 단위로 돈다
    const size = encoder.encode(ch).length;
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  return out + ext;
}
```

맨 앞의 `normalize("NFC")`는 [어제 글](/blog/unicode-normalization-korean-nfc-nfd/)에서 다룬 자모 분리 문제 때문입니다.
맥에서 올라온 NFD 이름을 그대로 내려보내면, 같은 파일을 받았는데 사용자 PC에서 이름 검색이 안 되는 일이 생깁니다.

> 상한 180바이트는 예시입니다. 실제 상한은 파일 시스템과 OS마다 다르고, 프록시와 로드밸런서에도 헤더 크기 제한이 있습니다.
> 내 환경의 제한값은 각 제품 문서에서 확인하고 여유 있게 잡으세요.

정제와 인코딩을 묶으면 헤더 생성은 한 함수로 끝납니다.

```typescript
export function dispositionHeader(
  filename: string,
  fallback: string,
  type: "attachment" | "inline" = "attachment",
): string {
  const safe = sanitizeFilename(filename);

  // 정제 후 이름에는 " 와 \ 가 남지 않으므로 그대로 따옴표 안에 넣을 수 있다
  if (/^[\x20-\x7e]*$/.test(safe)) {
    return `${type}; filename="${safe}"`;
  }
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(safe)}`;
}

res.setHeader(
  "Content-Disposition",
  dispositionHeader("2026년 11월 원아 명단 (최종).xlsx", "roster-2026-11.xlsx"),
);
```

## 헤더가 아예 쓰이지 않는 경로

헤더를 정확히 만들어도 이름이 `download`로 나오는 경우가 남습니다. 브라우저가 그 헤더를 보고 저장하는 경로가 아니기 때문입니다.

### fetch로 받아서 Blob으로 저장할 때

인증 토큰을 `Authorization` 헤더로 보내야 하는 API라면, 링크 대신 `fetch`로 받아서 Blob URL을 만들어 저장하곤 합니다.
이 경우 `Content-Disposition`은 브라우저의 다운로드 처리에 쓰이지 않습니다. 저장 이름은 `<a download="...">`에 넣은 값으로 정해지고, 비워두면 브라우저가 임의 이름을 붙입니다.

그래서 프런트엔드가 헤더를 직접 읽어야 합니다. API가 다른 출처라면 `Access-Control-Expose-Headers`에 `Content-Disposition`을 넣어야 스크립트에서 보입니다.

```typescript
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;

  const star = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(header);
  if (star && star[1].trim().toUpperCase() === "UTF-8") {
    try {
      return decodeURIComponent(star[2].trim());
    } catch {
      // 잘못 인코딩된 값이면 아래 filename으로 넘어간다
    }
  }

  const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(header);
  if (quoted) return quoted[1].replace(/\\(.)/g, "$1");

  const bare = /filename\s*=\s*([^;\s]+)/i.exec(header);
  return bare ? bare[1] : null;
}

const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
const blob = await res.blob();
const a = document.createElement("a");
a.href = URL.createObjectURL(blob);
a.download = filenameFromDisposition(res.headers.get("Content-Disposition")) ?? "download";
a.click();
URL.revokeObjectURL(a.href);
```

`filename*`를 먼저 찾는 순서가 중요합니다. `filename`부터 찾으면 대체 이름인 `roster.xlsx`가 먼저 걸립니다.
다만 이 방식은 파일 전체를 메모리에 올린 뒤에 저장합니다. 큰 파일이라면 아래처럼 링크로 직접 받게 하는 쪽이 낫습니다.

### S3 프리사인 URL로 넘길 때

큰 파일은 서버를 거치지 않고 S3 프리사인 URL로 내려보내는 경우가 많습니다. 이때는 우리 서버가 응답 헤더를 쓰지 않습니다.
그리고 대부분의 브라우저는 **다른 출처 URL에서는 `<a download>` 속성을 무시**하니, 프런트엔드에서 이름을 지정할 수도 없습니다.

S3의 `GetObject`는 응답 헤더를 요청 시점에 덮어쓰는 파라미터를 받습니다. 프리사인 URL에 넣으면 서명에 포함되어 사용자가 바꿀 수 없습니다.

```typescript
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({});

export async function downloadUrl(file: { key: string; displayName: string }) {
  const command = new GetObjectCommand({
    Bucket: process.env.BUCKET,
    Key: file.key,
    ResponseContentDisposition: dispositionHeader(file.displayName, "download.bin"),
  });
  return getSignedUrl(s3, command, { expiresIn: 300 });
}
```

객체 키를 서버가 만든 ID로 두고 보여줄 이름은 DB에 따로 저장했다면, 여기서 그 이름을 붙여주는 구조가 자연스럽게 맞아떨어집니다.
같은 객체를 사용자마다 다른 이름으로 내려줄 수도 있습니다.

> 프리사인 URL 앞에 CloudFront를 두는 구성이라면, 쿼리 문자열이 오리진까지 전달되는지와 캐시 키에 포함되는지에 따라 동작이 달라집니다.
> 캐시 정책과 오리진 요청 정책 설정을 공식 문서에서 확인하세요.

## inline과 attachment는 보안 설정이기도 하다

`Content-Disposition`의 첫 토큰은 브라우저에게 "열어서 보여줘(`inline`)"와 "저장해(`attachment`)" 중 무엇을 원하는지 알려줍니다.
PDF나 이미지를 미리보기로 띄우고 싶어서 `inline`을 쓰는 건 자연스럽습니다. 문제는 **사용자가 올린 파일**을 `inline`으로, 그것도 서비스 도메인에서 내려줄 때입니다.

사용자가 HTML이나 SVG를 올렸고 그걸 `inline`과 `text/html`(또는 `image/svg+xml`)로 응답하면, 그 안의 스크립트가 서비스 출처에서 실행됩니다.
같은 출처의 쿠키와 API에 접근할 수 있으니 저장형 XSS와 다르지 않습니다.

선택지를 정리하면 이렇습니다.

| 방식 | 사용자 경험 | 위험 |
| --- | --- | --- |
| 전부 `attachment` | 미리보기 없음, 항상 저장 | 가장 낮음 |
| 허용 목록 타입만 `inline` | PDF·이미지 미리보기 가능 | 타입 판정을 믿을 수 있어야 함 |
| 사용자 파일 전용 도메인에서 `inline` | 미리보기 자유로움 | 쿠키·출처가 분리되어 피해 범위가 좁음 |

어느 쪽이든 공통으로 지킬 것이 있습니다.

- `Content-Type`은 업로드 때 클라이언트가 보낸 값을 믿지 말고, 서버가 검증한 타입 목록에서 정한 값으로 내려줍니다.
- `X-Content-Type-Options: nosniff`를 붙여 브라우저가 내용을 보고 타입을 추측하지 않게 합니다.
- 허용 목록에 없는 타입은 무조건 `attachment`로 내립니다.

```typescript
const INLINE_TYPES = new Set(["application/pdf", "image/png", "image/jpeg", "image/webp"]);

function dispositionType(contentType: string): "inline" | "attachment" {
  return INLINE_TYPES.has(contentType) ? "inline" : "attachment";
}

res.setHeader("Content-Type", file.contentType);          // 서버가 검증해 저장한 값
res.setHeader("X-Content-Type-Options", "nosniff");
res.setHeader(
  "Content-Disposition",
  dispositionHeader(file.displayName, "file.bin", dispositionType(file.contentType)),
);
```

SVG를 허용 목록에서 뺀 것은 의도입니다. 이미지처럼 보이지만 스크립트를 품을 수 있는 형식이라, 미리보기가 꼭 필요하다면 래스터 이미지로 변환해서 보여주는 편이 안전합니다.

## 정리

- 헤더 값은 Latin-1로 다뤄집니다. 한글은 그대로 넣지 말고 `filename*=UTF-8''...`로 퍼센트 인코딩합니다.
- `filename`에는 사람이 알아볼 수 있는 ASCII 대체 이름을 직접 넣습니다. 라이브러리 기본값은 `???`입니다.
- 직접 인코딩한다면 `encodeURIComponent`가 남기는 `' ( ) *`를 추가로 처리합니다.
- 인코딩 전에 NFC 정규화, 위험 문자 치환, 바이트 단위 자르기를 거칩니다.
- `fetch`+Blob이면 프런트엔드가 헤더를 파싱하고, S3 프리사인 URL이면 `ResponseContentDisposition`으로 이름을 실어 보냅니다.
- 사용자 파일을 `inline`으로 내줄 때는 타입 허용 목록과 `nosniff`를 함께 둡니다.

다운로드 파일명은 기능 명세에 잘 적히지 않는 부분이라, 깨져도 한참 뒤에 발견됩니다.
헤더 생성 함수를 하나로 모아두고, 한글·괄호·작은따옴표·긴 이름이 섞인 테스트 케이스를 몇 개 넣어두는 것만으로 대부분은 미리 걸러집니다.
