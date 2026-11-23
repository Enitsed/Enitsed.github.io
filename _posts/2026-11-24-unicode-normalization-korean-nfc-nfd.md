---
layout: post
title: "화면에는 '보고서'라고 보이는데 검색이 안 된다 — 한글 자모 분리와 유니코드 정규화"
date: 2026-11-24
tags: [backend, typescript, mysql, search, api]
excerpt: "맥에서 올린 파일 이름이 검색되지 않고, 20자 제한인 제목이 DB에서 잘리는 이유. 같은 글자가 서로 다른 바이트로 저장되는 NFC·NFD 문제, 경계에서 정규화하는 위치, NFKC를 함부로 쓰면 안 되는 이유, 글자 수를 세는 세 가지 단위, 이미 섞여 들어간 데이터를 찾아 고치는 방법."
---

화면에는 분명히 `보고서.pdf`라고 보이는데, `보고서`로 검색하면 나오지 않습니다. 오타도 공백도 없습니다.
데이터를 16진수로 찍어보면 그제야 차이가 보입니다. 같은 글자가 **서로 다른 바이트**로 저장돼 있습니다.

## 같은 '한'이 두 가지로 저장된다

유니코드에는 한글 음절을 표현하는 방법이 두 가지 있습니다.
완성형 음절 하나(`U+D55C`)로 쓰는 방법과, 초성·중성·종성 자모 세 개(`U+1112 U+1161 U+11AB`)를 이어 쓰는 방법입니다.

둘은 화면에 똑같이 그려지고, 유니코드 표준상으로도 **정준 동등(canonically equivalent)** 합니다. 하지만 문자열 비교는 바이트를 봅니다.

```typescript
const composed = "한";                       // NFC
const decomposed = "한".normalize("NFD");    // 자모 분리

composed === decomposed;                     // false
composed.length;                             // 1
decomposed.length;                           // 3

Buffer.from(composed).toString("hex");       // "ed959c"
Buffer.from(decomposed).toString("hex");     // "e18492e185a1e186ab"

"보고서.pdf".normalize("NFD").includes("보고서");  // false
```

이 두 형태를 한쪽으로 맞추는 규칙이 **정규화 형식**입니다. 이 글에서 다루는 건 넷 중 셋입니다.

| 형식 | 하는 일 | 한글 음절 |
| --- | --- | --- |
| NFC | 분해 후 다시 조합 | 완성형 1글자 |
| NFD | 정준 분해 | 자모 2~3개 |
| NFKC | 호환 분해 후 조합 | 완성형 1글자, 단 다른 문자도 바뀜 |

## NFD는 어디서 들어오는가

가장 흔한 경로는 **macOS에서 만든 파일 이름**입니다. 맥의 파일 시스템과 앱을 거친 이름은 자모가 분리된 형태로 넘어오는 경우가 많고, 브라우저는 그 이름을 `multipart/form-data`의 `filename`에 그대로 실어 보냅니다.
윈도우 사용자가 같은 이름의 파일을 올리면 NFC로 들어오니, 한 테이블 안에 두 형태가 섞입니다.

> 어떤 조합에서 NFD가 넘어오는지는 OS 버전, 파일을 만든 앱, 브라우저에 따라 다릅니다.
> "맥이면 항상 NFD"라고 가정하고 분기하지 말고, **들어오는 모든 문자열을 정규화**하는 쪽이 안전합니다.

파일 이름만이 아닙니다. 맥에서 만든 파일을 열어 내용을 복사해 붙여넣거나, 다른 시스템이 내보낸 CSV를 임포트할 때도 섞여 들어옵니다.
증상은 대체로 이렇습니다.

- `LIKE '%보고서%'`나 전문 검색에 걸리지 않는다
- 같은 이름이 유니크 제약을 통과해 중복 생성된다
- 20자 제한 제목이 DB의 `VARCHAR(20)`을 넘었다며 거부된다
- 제목을 잘라 표시했더니 마지막 글자가 `ㅎㅏ`처럼 깨진다

세 번째가 의외의 지점입니다. MySQL의 `VARCHAR(n)`은 바이트가 아니라 **문자(코드 포인트) 수**로 셉니다.
NFD로 들어온 20음절 제목은 받침 유무에 따라 40~60 코드 포인트가 되니, 화면상 20자인데 DB는 넘쳤다고 판단합니다.

## 경계에서 한 번, NFC로

해법 자체는 짧습니다. **시스템 경계에서 한 번 NFC로 정규화**하고, 그 안쪽은 정규화된 문자열만 다룬다고 가정합니다.
저장할 때, 비교할 때, 검색어를 받을 때 따로따로 처리하면 반드시 한 군데를 빠뜨립니다.

요청 본문 전체를 재귀로 훑는 미들웨어로 두면 개별 핸들러가 신경 쓸 필요가 없습니다.

```typescript
import type { Request, Response, NextFunction } from "express";

function normalizeDeep(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normalizeDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.normalize("NFC")] = normalizeDeep(v);
    }
    return out;
  }
  return value;
}

export function nfcBody(req: Request, _res: Response, next: NextFunction) {
  if (req.body) req.body = normalizeDeep(req.body);
  next();
}
```

이 미들웨어가 놓치는 경로가 있습니다. 쿼리스트링, 경로 파라미터, 그리고 업로드 파일의 원래 이름입니다.
검색어는 쿼리스트링으로 오는 경우가 많으니 검색 핸들러 입구에서 따로 처리하고, 파일 이름은 업로드 처리 코드에서 명시적으로 정규화합니다.

```typescript
// multer 같은 업로드 미들웨어가 넘겨준 원래 파일 이름
const displayName = file.originalname.normalize("NFC");
```

> 업로드 라이브러리가 `filename`을 어떤 인코딩으로 해석하는지도 따로 확인하세요.
> 정규화 이전에 바이트를 잘못된 문자셋으로 읽어 이미 깨진 문자열이라면 NFC로는 복구되지 않습니다.

### 정규화하면 안 되는 문자열

경계에서 전부 정규화하라고 했지만, **바이트 그대로가 의미인 값**은 예외입니다.

- 웹훅 서명 검증에 쓰는 원본 요청 본문 — 한 바이트라도 바뀌면 HMAC이 맞지 않습니다. 서명 검증은 정규화 미들웨어보다 **앞에서**, 파싱 전 원본 바이트로 합니다.
- 비밀번호 — 정규화 여부에 따라 해시 입력이 달라집니다. 정책을 도중에 바꾸면 기존 해시와 맞지 않는 사용자가 생기니, 처음에 정하고 바꾸지 않는 값으로 다룹니다.
- 외부에서 받은 식별자나 토큰 — 상대 시스템이 바이트 단위로 비교합니다.

### 저장소 키에는 사용자가 준 이름을 쓰지 않는다

S3 같은 오브젝트 스토리지의 키는 바이트열입니다. NFC 키와 NFD 키는 서로 다른 객체가 됩니다.
사용자 파일 이름을 키에 넣으면 정규화 정책을 바꾸는 순간 기존 객체를 못 찾게 됩니다.

키는 서버가 만든 ID로 두고, 사용자에게 보여줄 이름은 DB 컬럼에 NFC로 따로 저장하는 편이 정규화 문제와 경로 조작 문제를 한 번에 피합니다.

```typescript
const key = `uploads/${tenantId}/${randomUUID()}`;
await db.insert("files", { key, display_name: file.originalname.normalize("NFC") });
```

## NFKC를 쓰고 싶어지는 순간

NFKC는 더 공격적으로 합칩니다. 전각 `Ａ`를 `A`로, `①`을 `1`로, 합자 `ﬁ`를 `fi`로 바꿉니다.
아이디나 닉네임에서 눈속임 중복을 막으려고 NFKC를 고려하게 되는데, 한글에서는 부작용이 있습니다.

```typescript
"Ａ①ﬁ".normalize("NFKC");                         // "A1fi"

"ㄱ".codePointAt(0)!.toString(16);                  // "3131" (호환용 자모)
"ㄱ".normalize("NFKC").codePointAt(0)!.toString(16); // "1100" (초성 자모)
"ㄱ".normalize("NFC").codePointAt(0)!.toString(16);  // "3131" (그대로)
```

키보드로 입력한 낱자 `ㄱ`(호환용 자모)이 NFKC를 거치면 **초성 결합용 자모**로 바뀝니다. 앞뒤 글자와 결합하거나 렌더링이 달라질 수 있고, 초성 검색처럼 낱자를 다루는 기능이 있다면 그대로 깨집니다.

그래서 저장용 정규화는 NFC로 두고, NFKC는 **비교용 별도 컬럼**에만 씁니다. 원본은 사용자가 쓴 그대로 보여주고, 중복 판정이나 검색 매칭만 정규화된 값으로 합니다.

```sql
ALTER TABLE users
  ADD COLUMN nickname_key VARCHAR(64) NOT NULL DEFAULT '',
  ADD UNIQUE KEY uk_users_nickname_key (nickname_key);
```

```typescript
function nicknameKey(raw: string): string {
  return raw.normalize("NFKC").trim().toLowerCase();
}
```

이 구조면 비교 규칙을 나중에 바꿔도 원본은 그대로이고, 비교 컬럼만 다시 계산하면 됩니다.

## 글자 수를 세는 단위는 세 가지다

"제목은 20자까지"라는 요구사항은 단순해 보이지만, 무엇을 한 글자로 볼지가 정해져 있지 않습니다.

```typescript
const family = "👨‍👩‍👧";

family.length;                    // 8  UTF-16 코드 유닛
[...family].length;               // 5  코드 포인트 (사람 3 + 결합자 2)

const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
[...seg.segment(family)].length;  // 1  사람이 보는 글자

[...seg.segment("한글".normalize("NFD"))].length;  // 2
```

| 단위 | JS에서 | 누가 쓰는가 |
| --- | --- | --- |
| UTF-16 코드 유닛 | `str.length` | 브라우저 `maxlength` 등 |
| 코드 포인트 | `[...str].length` | MySQL `VARCHAR(n)`, `CHAR_LENGTH()` |
| 바이트 | `Buffer.byteLength(str)` | MySQL `LENGTH()`, 인덱스 키 길이 |
| 문자소(grapheme) | `Intl.Segmenter` | 사람의 눈 |

프런트엔드와 백엔드, DB가 각자 다른 단위로 세면 "화면에서는 통과했는데 서버가 거부"가 생깁니다.
현실적인 선택은 이렇습니다.

- 검증은 **DB가 세는 단위(코드 포인트)** 로 하고, NFC 정규화 이후에 셉니다. 이러면 서버 검증을 통과한 값이 DB에서 거부되지 않습니다.
- 사용자에게 보여주는 "12/20" 같은 카운터만 문자소 기준으로 셉니다.
- DB 컬럼 길이는 요구사항보다 여유 있게 잡아, 이모지 몇 개 때문에 저장이 실패하지 않게 합니다.

### 자를 때는 문자소 단위로

목록에서 제목을 잘라 보여줄 때 `slice`를 쓰면 서로게이트 쌍이나 결합 문자 중간이 잘립니다.
반쪽짜리 서로게이트는 UTF-8로 인코딩되면서 `U+FFFD`(`�`)로 바뀝니다.

```typescript
Buffer.from("a👍".slice(0, 2)).toString("hex");  // "61efbfbd" — 깨진 문자

export function truncateGraphemes(text: string, max: number, ellipsis = "…"): string {
  const seg = new Intl.Segmenter("ko", { granularity: "grapheme" });
  const parts: string[] = [];
  for (const { segment } of seg.segment(text)) {
    if (parts.length === max) return parts.join("") + ellipsis;
    parts.push(segment);
  }
  return parts.join("");
}
```

NFD 한글을 정규화하지 않은 채 코드 포인트로 자르면 `ㅎㅏ`처럼 음절 중간이 잘립니다. 앞 절의 경계 정규화가 여기서도 효과를 냅니다.

## 보이지 않는 문자

정규화로 해결되지 않는 비슷한 증상도 있습니다. 복사해 붙여넣은 문자열에 섞여 오는 **폭 없는 문자**입니다.
`String.prototype.trim()`은 줄바꿈 없는 공백(`U+00A0`)과 BOM(`U+FEFF`)은 지우지만, 폭 없는 공백(`U+200B`)은 지우지 않습니다.

```typescript
" a﻿".trim().length;  // 1
"​a".trim().length;        // 2 — 남아 있다

// 이름·제목처럼 서식이 필요 없는 필드에서만
const INVISIBLE = /[​-‍⁠﻿]/g;
const cleaned = raw.normalize("NFC").replace(INVISIBLE, "").trim();
```

> `U+200D`(폭 없는 결합자)는 이모지 조합에 쓰입니다. 위처럼 지우면 가족 이모지가 사람 셋으로 쪼개집니다.
> 자유 서술 본문에는 적용하지 말고, 식별 목적의 짧은 필드에만 쓰세요.

## DB는 어떻게 비교하는가

MySQL 문자열 비교는 콜레이션을 따릅니다. 콜레이션이 NFC와 NFD 한글을 같은 값으로 보는지는 **버전과 콜레이션에 따라 다를 수 있으니** 쓰고 있는 환경에서 직접 확인하는 편이 확실합니다.

```sql
-- '한'(NFC)과 'ㅎ+ㅏ+ㄴ'(NFD 자모)를 바이트로 직접 넣어 비교한다
SELECT
  CONVERT(X'ED959C' USING utf8mb4)
    = CONVERT(X'E18492E185A1E186AB' USING utf8mb4) COLLATE utf8mb4_0900_ai_ci AS ai_ci,
  CONVERT(X'ED959C' USING utf8mb4)
    = CONVERT(X'E18492E185A1E186AB' USING utf8mb4) COLLATE utf8mb4_bin        AS bin;
```

결과가 어떻든 **DB의 비교 규칙에 기대지 않는 편**을 권합니다. 콜레이션이 같다고 봐도 `LIKE`의 부분 일치, 전문 검색의 n-gram 토큰, 외부 검색 엔진의 색인은 각자 다르게 동작합니다.
저장하는 값 자체를 NFC로 맞춰두면 이 질문을 할 필요가 없어집니다.

> PostgreSQL은 `normalize()` 함수와 `IS NFC NORMALIZED` 술어를 제공합니다. 사용 가능 버전과 DB 인코딩 조건은 공식 문서에서 확인하세요.

{% comment %} TODO: 실제 서비스에서 NFD 데이터가 섞여 문제가 된 사례가 있었다면 어느 화면·필드였는지 적어주세요 {% endcomment %}

## 이미 섞여 들어간 데이터 고치기

경계 정규화를 배포해도 기존 데이터는 그대로입니다. MySQL에는 정규화 함수가 없으니, 애플리케이션에서 읽어 판별하고 다시 씁니다.

판별 기준은 간단합니다. 한글 결합용 자모 블록(`U+1100`~`U+11FF`)이 들어 있으면 NFD 한글일 가능성이 높고, 정규화 결과가 원본과 다르면 고칠 대상입니다.

```typescript
const CONJOINING_JAMO = /[ᄀ-ᇿ]/;

function needsFix(value: string): boolean {
  return CONJOINING_JAMO.test(value) && value !== value.normalize("NFC");
}
```

전체 테이블을 한 번에 읽지 않고 기본키 순서로 끊어서 처리합니다.

```typescript
const BATCH = 500;
let lastId = 0;

for (;;) {
  const rows = await db.query<{ id: number; display_name: string }>(
    "SELECT id, display_name FROM files WHERE id > ? ORDER BY id LIMIT ?",
    [lastId, BATCH],
  );
  if (rows.length === 0) break;
  lastId = rows[rows.length - 1].id;

  for (const row of rows) {
    if (!needsFix(row.display_name)) continue;
    const fixed = row.display_name.normalize("NFC");
    // 읽은 뒤 사용자가 바꿨다면 덮어쓰지 않는다
    await db.query(
      "UPDATE files SET display_name = ? WHERE id = ? AND display_name = ?",
      [fixed, row.id, row.display_name],
    );
  }
}
```

고치기 전에 확인할 것이 두 가지 있습니다.

첫째, **유니크 제약 충돌**입니다. 같은 이름이 NFC와 NFD로 각각 저장돼 있었다면, 정규화하는 순간 두 행이 같은 값이 됩니다.
먼저 충돌 목록을 뽑아 어느 쪽을 남길지 정하고 나서 갱신해야 배치가 중간에 멈추지 않습니다.

둘째, **이 값을 키로 쓰는 다른 곳**입니다. 검색 색인, 캐시 키, 외부 시스템에 넘긴 식별자가 옛 값을 들고 있다면 같이 갱신하거나 재색인해야 합니다.

## 정리

- 같은 한글이 NFC와 NFD 두 가지 바이트로 저장될 수 있고, 맥에서 온 파일 이름이 대표적인 유입 경로다.
- 시스템 경계에서 한 번 NFC로 맞춘다. 서명 원문·비밀번호·외부 토큰은 예외로 둔다.
- NFKC는 비교용 컬럼에만 쓴다. 한글 낱자를 바꿔버린다.
- 길이 검증은 DB가 세는 단위로, 화면 표시와 자르기는 문자소 단위로 한다.
- 기존 데이터는 판별해서 고치되, 유니크 충돌과 파생 데이터를 먼저 확인한다.
