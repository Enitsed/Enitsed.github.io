---
layout: post
title: "초대 코드를 넣었는데 다른 반으로 들어갔다 — MySQL 콜레이션이 정하는 '같은 문자열'"
date: 2026-11-28
tags: [mysql, database, backend, sql, typescript]
excerpt: "MySQL에서 두 문자열이 같은지는 컬럼의 콜레이션이 정합니다. _ci·_ai 콜레이션이 대소문자와 악센트를 합쳐버리는 자리, PAD SPACE와 NO PAD가 뒤 공백을 다르게 보는 문제, 애플리케이션의 비교와 DB의 비교가 어긋날 때 생기는 중복 키·캐시 키·레이트 리밋 우회, 콜레이션이 다른 컬럼끼리의 조인, 그리고 필드 성격별로 콜레이션을 고르고 바꾸는 절차."
---

애플리케이션에서 `'aB3x' === 'AB3X'`는 `false`입니다. 같은 두 값을 MySQL 8.0의 기본 설정 컬럼에 넣고 `=`로 비교하면 `1`이 나옵니다.
어느 쪽도 버그가 아닙니다. 문자열이 "같다"는 정의가 둘이 서로 다를 뿐이고, 그 정의는 DB에서 **콜레이션**이 정합니다.
문제는 대부분의 팀이 그 정의를 고른 적이 없다는 점입니다. 기본값이 골라준 것을 그대로 쓰고 있습니다.

## 기본값이 고른 것

MySQL 8.0의 `utf8mb4` 기본 콜레이션은 `utf8mb4_0900_ai_ci`입니다. 이름의 접미사가 비교 규칙입니다.

| 접미사 | 뜻 | 같다고 보는 예 |
| --- | --- | --- |
| `_ci` | case-insensitive | `A` = `a` |
| `_ai` | accent-insensitive | `é` = `e` |
| `_cs` | case-sensitive | |
| `_as` | accent-sensitive | |
| `_bin` | 코드 포인트(바이트) 기준 | |

`_ai_ci`는 대소문자와 악센트를 모두 무시하는 **가장 느슨한 비교**입니다.
이름 검색처럼 사람이 입력한 값을 찾을 때는 이게 오히려 편합니다. 문제는 같은 테이블에 사람이 읽는 값과 기계가 만든 값이 섞여 있다는 데서 시작합니다.

```sql
SELECT 'aB3x' = 'AB3X';                                   -- 1 (기본 콜레이션)
SELECT 'aB3x' = 'AB3X' COLLATE utf8mb4_0900_as_cs;        -- 0
SELECT 'café' = 'cafe';                                   -- 1
```

지금 쓰는 컬럼이 무엇인지는 스키마에서 바로 확인할 수 있습니다. 테이블 기본값이 아니라 **컬럼 단위로** 봐야 합니다.

```sql
SELECT TABLE_NAME, COLUMN_NAME, CHARACTER_SET_NAME, COLLATION_NAME
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND COLLATION_NAME IS NOT NULL
ORDER BY TABLE_NAME, ORDINAL_POSITION;
```

## 기계가 만든 값을 _ci 컬럼에 넣으면

대소문자를 구분하는 짧은 코드를 생각해봅시다. 초대 코드, 단축 URL, 공유 링크 토큰처럼 base62로 만드는 값들입니다.
대소문자를 구분하니까 여섯 자리로도 경우의 수가 충분하다고 계산했을 텐데, `_ci` 컬럼은 그 계산의 전제를 지웁니다.

```sql
CREATE TABLE class_invites (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  class_id    BIGINT UNSIGNED NOT NULL,
  code        VARCHAR(12)     NOT NULL,   -- 콜레이션을 지정하지 않았다
  PRIMARY KEY (id),
  UNIQUE KEY uk_code (code)
);
```

이 스키마에서 일어나는 일은 두 갈래입니다.

**유니크 키가 있을 때** — 생성기가 `aB3x9Q`를 만들었는데 이미 `Ab3X9q`가 있으면 `Duplicate entry`로 삽입이 실패합니다.
충돌 시 다시 만드는 재시도 루프가 있다면 조용히 넘어가지만, 실제로 쓸 수 있는 코드 공간은 대소문자를 합친 만큼으로 줄어 있습니다.

**유니크 키가 없을 때** — 더 나쁩니다. `WHERE code = ? LIMIT 1`이 **다른 반의 코드**를 돌려줄 수 있습니다.
사용자는 자기 코드를 정확히 넣었고, 애플리케이션은 아무 오류 없이 엉뚱한 반에 가입시킵니다.

기계가 만든 식별자는 사람이 읽는 텍스트가 아닙니다. 바이트가 같아야 같은 값이니, 컬럼도 그렇게 선언합니다.

```sql
ALTER TABLE class_invites
  MODIFY code VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL;
```

`ascii`로 두면 저장 공간도 줄고, 생성 규칙에 없는 문자가 들어오는 것도 막힙니다. 해시나 토큰처럼 아예 문자열일 필요가 없는 값이라면 `VARBINARY`나 `BINARY(n)`도 선택지입니다.

> 컬럼 콜레이션 변경은 대개 테이블 재구성을 동반합니다. 큰 테이블이라면 [온라인 스키마 변경](/blog/mysql-online-schema-change/)과 같은 절차로 다루세요.

## 뒤 공백 — PAD SPACE와 NO PAD

대소문자보다 덜 알려진 차이가 있습니다. 콜레이션마다 **뒤에 붙은 공백**을 비교에 넣을지가 다릅니다.

- **PAD SPACE** — 비교할 때 뒤 공백을 무시합니다. `'a ' = 'a'`가 참입니다. `utf8mb4_general_ci`, `utf8mb4_unicode_ci`, `utf8mb4_bin` 같은 예전 콜레이션이 여기에 속합니다.
- **NO PAD** — 공백도 다른 문자와 똑같이 비교합니다. `'a ' = 'a'`가 거짓입니다. `utf8mb4_0900_*` 계열이 여기에 속합니다.

```sql
SELECT COLLATION_NAME, PAD_ATTRIBUTE
FROM information_schema.COLLATIONS
WHERE COLLATION_NAME IN (
  'utf8mb4_general_ci', 'utf8mb4_bin',
  'utf8mb4_0900_ai_ci', 'utf8mb4_0900_bin'
);
```

이 차이가 드러나는 건 콜레이션을 바꿀 때입니다.
5.7에서 `utf8mb4_general_ci`로 만든 테이블을 8.0으로 올리면서 기본 콜레이션으로 맞추면, 그동안 `'kim@x.com '`과 `'kim@x.com'`을 같은 값으로 막아주던 유니크 키가 **둘을 다른 값으로 받아들이기 시작합니다.**
반대로 `utf8mb4_bin`이 "대소문자를 구분하니까 완전히 엄격하다"고 생각했다면, 뒤 공백은 여전히 무시한다는 점을 놓치기 쉽습니다.

여기서 함정이 하나 더 있습니다. PAD SPACE 컬럼에서 뒤 공백이 붙은 행을 찾으려고 `WHERE email <> TRIM(email)`을 쓰면 **한 건도 안 나옵니다.** 비교 자체가 공백을 무시하니까요. 길이로 봐야 합니다.

```sql
-- PAD SPACE 컬럼에서도 동작한다
SELECT id, email, CHAR_LENGTH(email) AS len
FROM users
WHERE CHAR_LENGTH(email) <> CHAR_LENGTH(TRIM(email));
```

> 조인에서 PAD SPACE 콜레이션의 뒤 공백 처리는 8.0 마이너 버전 사이에 바뀐 적이 있습니다. 운영 중인 버전의 릴리스 노트에서 확인하고, 애초에 공백이 저장되지 않도록 입력 경계에서 잘라내는 편이 안전합니다.

## 애플리케이션과 DB가 다르게 비교할 때

콜레이션 문제가 장애로 번지는 건 대개 DB 혼자일 때가 아니라, **애플리케이션이 같은 값을 다르게 비교할 때**입니다. JavaScript의 `===`, `Set`, `Map`, Redis 키는 전부 바이트 비교입니다.

### 임포트의 중복 제거

엑셀로 받은 명단을 넣기 전에 애플리케이션에서 중복을 걸렀다고 해봅시다.

```typescript
const unique = [...new Map(rows.map((r) => [r.email, r])).values()];
await insertMany(unique);   // 'Kim@x.com'과 'kim@x.com'이 둘 다 남는다
```

`Map`은 두 값을 다르게 봤고, `_ci` 유니크 키는 같게 봅니다. 배치 중간에 `Duplicate entry`가 터집니다.
[엑셀 임포트의 부분 실패](/blog/excel-csv-import-partial-failure/)에서 다룬 것처럼 행 단위 오류로 돌려줄 수는 있지만, 근본은 두 비교 규칙을 맞추는 것입니다.

### 캐시 키와 레이트 리밋

로그인 시도 횟수를 이메일 기준으로 센다고 해봅시다.

```typescript
const key = `login:fail:${input.email}`;      // 입력값 그대로
const user = await findUserByEmail(input.email); // _ci 컬럼 — 대소문자 무관하게 찾는다
```

DB는 `KIM@x.com`, `Kim@x.com`, `kIm@x.com`을 전부 같은 계정으로 찾아주는데, 카운터는 셋을 각각 따로 셉니다.
대소문자 조합만 바꿔가며 시도하면 [레이트 리밋](/blog/rate-limiting-token-bucket-redis/)의 한도가 몇 배로 늘어납니다. 캐시도 같은 사용자를 여러 키로 들고 있게 됩니다.

해결은 키를 만들기 전에 **DB가 보는 것과 같은 형태로** 값을 접는 것입니다. 가장 단순한 방법은 DB가 찾아준 행의 정식 값을 키로 쓰는 것입니다.

```typescript
const user = await findUserByEmail(input.email);
const subject = user ? `user:${user.id}` : `email:${normalizeEmail(input.email)}`;
const key = `login:fail:${subject}`;
```

### 그렇다면 애플리케이션에서 DB 규칙을 흉내 내면 되나

`Intl.Collator`의 `sensitivity: 'base'`는 대소문자와 악센트를 무시하는 비교라 `_ai_ci`와 비슷해 보입니다.

```typescript
const collator = new Intl.Collator("und", { sensitivity: "base" });
collator.compare("Café", "cafe") === 0;   // true
```

하지만 **비슷할 뿐 같지 않습니다.** MySQL의 `0900` 콜레이션은 특정 버전의 유니코드 정렬 가중치를 쓰고, 런타임의 ICU는 또 다른 버전을 씁니다. 특수 문자, 전각 문자, 결합 문자에서 판정이 갈릴 수 있습니다.
그래서 DB 규칙을 복제하기보다, **저장하기 전에 값을 한 가지 정규형으로 접는 쪽**을 권합니다. 정규형이 정해지면 애플리케이션과 DB가 어떤 규칙으로 비교하든 같은 답이 나옵니다.

```typescript
function normalizeEmail(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}
```

> 이메일 로컬 파트(`@` 앞)는 규격상 대소문자를 구분할 수 있습니다. 실무에서는 거의 모든 메일 서비스가 구분하지 않아 소문자로 접는 경우가 많지만, 이건 규격이 아니라 선택입니다.
> NFC 정규화를 함께 하는 이유는 [유니코드 정규화 글](/blog/unicode-normalization-korean-nfc-nfd/)에 적었습니다.

## 표시용 값과 비교용 값을 나눈다

사용자가 입력한 `Kim.SeulGi@Example.com`을 그대로 보여주고 싶은데, 비교는 소문자로 하고 싶다면 컬럼을 둘로 나눕니다.
생성 컬럼을 쓰면 애플리케이션이 정규형을 따로 써넣는 걸 잊어도 DB가 맞춰줍니다.

```sql
ALTER TABLE users
  ADD COLUMN email_key VARCHAR(255)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin
    GENERATED ALWAYS AS (LOWER(TRIM(email))) STORED,
  ADD UNIQUE KEY uk_email_key (email_key);
```

비교용 컬럼을 `_bin`으로 둔 이유는 접는 규칙을 **한 곳에만** 두기 위해서입니다. `LOWER`로 이미 접었는데 `_ci`까지 얹으면 규칙이 두 군데 생기고, 나중에 어느 쪽이 무엇을 합쳤는지 설명하기 어려워집니다.

> `LOWER(TRIM())`는 NFC 정규화를 하지 않습니다. MySQL에는 유니코드 정규화 함수가 없으니, 정규화가 필요하면 애플리케이션에서 접은 값을 일반 컬럼에 저장하는 방식이 낫습니다.
> 생성 컬럼과 애플리케이션 정규화를 함께 쓴다면 두 규칙이 정확히 같은지 테스트로 묶어두세요.

## 콜레이션이 다른 컬럼끼리 비교할 때

스키마 안에 콜레이션이 섞여 있으면 조인에서 두 가지 일이 생깁니다.

같은 문자셋에 콜레이션만 다른 두 컬럼을 `=`로 비교하면, MySQL은 어느 쪽 규칙을 써야 할지 정하지 못해 오류를 냅니다.

```sql
SELECT *
FROM users u
JOIN legacy_members m ON m.email = u.email;
-- ERROR 1267: Illegal mix of collations
--   (utf8mb4_general_ci,IMPLICIT) and (utf8mb4_0900_ai_ci,IMPLICIT) for operation '='
```

급한 마음에 한쪽에 `COLLATE`를 붙이면 오류는 사라지지만, 변환된 쪽 컬럼의 인덱스는 그 비교에 쓰이지 못합니다. 잘 돌던 조인이 풀 스캔으로 바뀌는 경로입니다.
문자셋이 다른 경우(`utf8mb3`와 `utf8mb4`)에는 오류 없이 MySQL이 알아서 변환하는데, 그래서 더 늦게 발견됩니다. [RDS 업그레이드 글](/blog/rds-blue-green-upgrade/)에서 업그레이드 직후 특정 API만 느려지면 콜레이션부터 보라고 적은 이유가 이것입니다.

어느 경우든 `EXPLAIN`으로 확인합니다. 인덱스를 기대한 테이블의 `type`이 `ALL`로 나오면 변환이 끼어든 겁니다.

### 한 쿼리만 엄격하게 비교하고 싶을 때

컬럼은 `_ci`로 두고 특정 조회에서만 대소문자를 구분하고 싶을 때가 있습니다. 비교 대상에 `COLLATE`를 붙이되, 원래 조건을 한 번 더 남겨두면 인덱스로 후보를 좁힌 뒤 엄격한 비교로 거릅니다.

```sql
SELECT id, class_id
FROM class_invites
WHERE code = ?                              -- _ci 인덱스로 후보를 좁힌다
  AND code = ? COLLATE utf8mb4_0900_as_cs;  -- 그중 정확히 일치하는 것만
```

> `WHERE BINARY code = ?` 형태도 자주 보이지만, 표현식의 `BINARY` 연산자는 MySQL 8.0.27부터 deprecated입니다. `CAST(... AS BINARY)`나 `COLLATE`를 쓰세요.

이건 임시방편입니다. 이런 조회가 여러 군데 생긴다면 그 컬럼은 애초에 콜레이션이 잘못 골라진 것입니다.

## 콜레이션을 바꾸기 전에

엄격한 쪽으로 바꾸는 건(`_ci` → `_bin`) 유니크 키를 깨지 않습니다. 같은 값으로 묶이던 것들이 갈라질 뿐입니다.
대신 **조회가 깨집니다.** 지금까지 `KIM@x.com`으로 찾던 코드가 결과를 못 받게 되니, 바꾸기 전에 입력 경계의 정규화가 먼저 배포돼 있어야 합니다.

느슨한 쪽으로 바꾸는 건(`_bin` → `_ci`, 또는 NO PAD → PAD SPACE) 반대로 유니크 키 위반으로 실패할 수 있습니다. 바꿀 콜레이션 기준으로 미리 묶어봅니다.

```sql
SELECT email COLLATE utf8mb4_0900_ai_ci AS folded,
       COUNT(*)                          AS cnt,
       GROUP_CONCAT(id ORDER BY id)      AS ids
FROM users
GROUP BY folded
HAVING cnt > 1;
```

여기서 나온 묶음은 기술적으로 고칠 수 없습니다. 같은 사람의 계정 둘인지, 다른 사람인지 판단이 필요합니다.
[소셜 계정 병합](/blog/social-login-account-linking-merge/)에서처럼 어느 쪽을 남길지, 연결된 데이터를 어떻게 옮길지 정한 다음에 콜레이션을 바꿉니다.

{% comment %} TODO: 운영 중인 서비스에서 콜레이션 때문에 생긴 문제(중복 키, 조인 성능 등)가 있었다면 어떤 테이블·필드였는지 적어주세요 {% endcomment %}

## 필드별로 고르기

정답 콜레이션은 없습니다. 필드가 **무엇을 같다고 봐야 하는지**에 따라 다릅니다.

| 필드 | 같다고 봐야 하는 것 | 권하는 방식 |
| --- | --- | --- |
| 초대 코드·토큰·해시 | 바이트가 같을 때만 | `ascii_bin` 또는 `VARBINARY` |
| 이메일·로그인 ID | 대소문자 무시 | 정규형 컬럼 + `_bin` 유니크 |
| 이름·제목 (검색용) | 사람이 같다고 느끼는 것 | 기본 `_ai_ci` 그대로 |
| 외부 시스템 ID | 상대 시스템 규칙대로 | 상대 문서 확인 후 `_bin`이 기본 |

느슨한 비교는 검색에서는 친절하지만 식별에서는 사고를 만듭니다. 기본값이 `_ai_ci`라는 건 **식별 컬럼마다 한 번은 의식적으로 골라야 한다**는 뜻입니다.

> PostgreSQL은 기본 콜레이션이 대소문자를 구분하고, 대소문자를 무시하려면 `citext` 확장이나 비결정적(nondeterministic) ICU 콜레이션을 씁니다. 비결정적 콜레이션에서 `LIKE` 같은 연산의 지원 범위는 버전마다 다르니 공식 문서에서 확인하세요.
