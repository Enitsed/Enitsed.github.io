---
layout: post
title: "설정을 JSON 컬럼에 담았더니 조회가 막힌다 — MySQL JSON의 인덱스와 비용"
date: 2026-10-19
tags: [mysql, database, backend, sql, architecture]
excerpt: "컬럼을 늘리지 않으려고 JSON 하나에 담으면, 나중에 그 안의 값으로 찾는 순간 테이블 전체를 읽습니다. 바이너리 포맷이 입력을 정규화하는 지점, 함수 조건이 인덱스를 못 타는 이유와 생성 컬럼·함수 인덱스로 되찾는 법, 배열 검색용 다중 값 인덱스가 걸어둔 한도, 문서를 통째로 다시 쓰는 코드가 만드는 갱신 분실, CHECK와 JSON_SCHEMA_VALID로 일부만 되찾는 제약, 그리고 무엇을 꺼내 컬럼으로 만들지 가르는 기준까지."
---

기능마다 옵션이 하나씩 붙습니다. 그때마다 `ALTER TABLE`을 돌리는 게 번거로워서 `settings JSON` 하나로 받습니다. 처음 몇 달은 아무 문제가 없습니다.

그러다 "리포트 기능 켜둔 기관만 뽑아줘"가 들어옵니다. 조건을 적어보면 쿼리가 테이블 전체를 읽고, 값이 `true`인 행과 `"true"`인 행이 섞여 있고, 애초에 그 키가 없는 행도 있습니다.

JSON 컬럼은 스키마 변경을 미뤄주는 장치입니다. 미룬 것이 사라지지는 않고, **조회 조건·제약·마이그레이션 쪽으로 옮겨 쌓입니다.**

어디로 옮겨 가는지를 알고 쓰면 괜찮은 선택이고, 모르고 쓰면 몇 달 뒤에 한꺼번에 돌려받습니다.

## JSON 컬럼이 저장하는 것은 우리가 넣은 문자열이 아니다

MySQL의 `JSON` 타입은 텍스트가 아닙니다. 삽입 시점에 파싱해서 바이너리 포맷으로 저장합니다.

그래서 읽을 때마다 파싱하지 않아도 되고, 키로 바로 접근할 수 있습니다. 대신 **넣은 문자열이 그대로 보존되지 않습니다.**

```sql
SELECT CAST('{"b": 1, "a": 2}' AS JSON);
-- {"a": 2, "b": 1}
```

키 순서가 바뀌고, 공백이 정규화되고, 중복 키는 그대로 남지 않습니다. 외부 API 응답의 원문을 서명 검증이나 재현에 써야 한다면 `JSON` 컬럼에 담으면 안 됩니다. 그런 용도는 `LONGTEXT`에 원문 그대로 보관하고, 조회용 사본을 따로 두는 쪽이 맞습니다.

`LONGTEXT`와 비교하면 `JSON`을 쓰는 이유가 분명해집니다.

| | `JSON` | `LONGTEXT` |
| --- | --- | --- |
| 저장 시 검증 | 유효하지 않으면 거부 | 아무 문자열이나 들어간다 |
| 키 접근 | `->`, `->>`로 바로 | 애플리케이션에서 파싱 |
| 부분 갱신 | `JSON_SET` 등으로 가능 | 전체를 다시 쓴다 |
| 원문 보존 | 정규화됨 | 그대로 |

유효성 하나만으로도 `JSON`이 낫습니다. 깨진 문자열이 들어온 걸 몇 달 뒤 조회 시점에 알게 되는 쪽이 훨씬 비쌉니다.

## 조회 조건이 되는 순간 무너진다

`->>`와 `->`는 편해 보이지만 결국 함수 호출입니다. `col->>'$.plan'`은 `JSON_UNQUOTE(JSON_EXTRACT(col, '$.plan'))`의 축약입니다.

컬럼이 함수 안에 들어가면 인덱스를 쓸 수 없습니다. JSON 컬럼 자체에는 인덱스를 걸 수도 없으니, 아래 쿼리는 선택지 없이 전체 스캔입니다.

```sql
SELECT center_id
  FROM center_settings
 WHERE settings->>'$.plan' = 'pro';     -- 전체 스캔
```

복합 인덱스에서 함수와 암묵적 형변환이 인덱스를 무효로 만드는 것과 같은 이야기이고, 여기서는 **피할 방법이 없는 것이 기본값**이라는 점만 다릅니다.

되찾는 방법은 두 가지입니다. 하나는 값을 생성 컬럼으로 꺼내서 그 컬럼에 인덱스를 거는 것입니다.

```sql
-- 컬럼 추가와 인덱스 생성은 나눠서 돌린다
ALTER TABLE center_settings
  ADD COLUMN plan VARCHAR(32) AS (settings->>'$.plan') VIRTUAL,
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE center_settings
  ADD KEY ix_plan (plan),
  ALGORITHM=INPLACE, LOCK=NONE;
```

`VIRTUAL`은 행에 값을 저장하지 않고 읽을 때 계산합니다. 인덱스에는 물리적으로 들어가니 인덱스를 타는 데는 지장이 없고, 컬럼 추가 자체가 테이블을 다시 쓰지 않습니다.

`STORED`는 행에 값을 저장해서 테이블 재구성이 필요합니다. 큰 테이블에서는 그 차이가 작업 시간 전부를 가릅니다. 특별한 이유가 없으면 `VIRTUAL`입니다.

> 생성 컬럼을 추가해도 인덱스 생성은 별개의 작업입니다. 큰 테이블이라면 `ALGORITHM`과 `LOCK`을 명시해서, 의도한 알고리즘이 아닐 때 조용히 테이블을 복사하는 대신 에러로 멈추게 하세요.

다른 하나는 생성 컬럼 없이 식 자체에 인덱스를 거는 함수 인덱스입니다(MySQL 8.0.13 이상).

```sql
ALTER TABLE center_settings
  ADD KEY ix_plan ((CAST(settings->>'$.plan' AS CHAR(32))));
```

괄호가 두 겹인 것이 문법입니다. JSON 식에는 `CAST`가 필요합니다. JSON 타입 그대로는 인덱스를 만들 수 없습니다.

함수 인덱스는 컬럼이 늘지 않아 깔끔하지만, **쿼리에 적은 식이 인덱스에 적은 식과 정확히 같아야** 쓰입니다. `CAST` 길이가 다르거나 `->`와 `->>`가 섞이면 안 타고, 그 사실이 에러가 아니라 느린 쿼리로만 나타납니다.

어느 쪽을 택하든 확인은 `EXPLAIN`입니다.

```sql
EXPLAIN SELECT center_id FROM center_settings
 WHERE settings->>'$.plan' = 'pro';
-- key 가 비어 있으면 못 탄 것이다. key_len 도 같이 본다.
```

여기서 자주 걸리는 게 타입과 콜레이션입니다. JSON에서 꺼낸 값의 문자셋·콜레이션은 테이블 기본값과 다를 수 있고, 다르면 비교 과정에서 변환이 일어나 인덱스를 못 씁니다.

`SHOW CREATE TABLE`로 생성 컬럼의 콜레이션을 직접 확인하세요. 대소문자 구분이 기대와 다르게 동작하는 것도 대개 같은 자리입니다.

숫자와 불린은 한 겹 더 꼬입니다. `->>`는 따옴표를 벗긴 **문자열**을 돌려주므로, 숫자 비교를 하려면 생성 컬럼 타입을 숫자로 두고 캐스팅을 식 안에서 끝내야 합니다.

```sql
-- 문자열 비교가 아니라 숫자 비교가 되게 한다
ALTER TABLE center_settings
  ADD COLUMN max_children INT UNSIGNED
      AS (CAST(settings->>'$.limits.max_children' AS UNSIGNED)) VIRTUAL;

ALTER TABLE center_settings
  ADD KEY ix_max_children (max_children);
```

키가 없는 행은 이 컬럼이 `NULL`이 됩니다. 그 행들을 "기본값으로 간주"하려면 쿼리마다 `IS NULL`을 같이 다뤄야 하고, 그게 번거롭다는 사실이 이미 신호입니다. 조건으로 쓰는 값은 결국 컬럼으로 꺼내 기본값을 DB에 맡기는 쪽이 싸게 끝납니다.

## 배열 안을 찾을 때 — 다중 값 인덱스와 그 한도

JSON을 쓰는 이유 중 하나는 배열입니다. 태그, 담당자 목록, 권한 같은 것들이죠.

배열 포함 검색에는 전용 함수가 있습니다.

```sql
-- 하나라도 들어 있으면
SELECT id FROM classrooms WHERE JSON_OVERLAPS(tags, '["infant", "am"]');

-- 전부 들어 있어야
SELECT id FROM classrooms WHERE JSON_CONTAINS(tags, '["infant", "am"]');

-- 단일 값 포함
SELECT id FROM classrooms WHERE 42 MEMBER OF (members->'$.teacher_ids');
```

이 세 가지는 다중 값 인덱스(multi-valued index, MySQL 8.0.17 이상)를 탈 수 있습니다. 한 행이 인덱스에 여러 개의 키를 만드는 형태입니다.

```sql
ALTER TABLE classrooms
  ADD KEY ix_teacher_ids
      ((CAST(members->'$.teacher_ids[*]' AS UNSIGNED ARRAY)));
```

문제는 제약이 꽤 많다는 점입니다. 공식 문서의 `CREATE INDEX` 절에 나열돼 있는데, 실무에서 바로 걸리는 것들만 옮기면 이렇습니다.

- **온라인 생성이 안 됩니다.** `ALGORITHM=COPY`로 동작해서, 큰 테이블에서는 테이블 복사 작업이 됩니다. 운영 중이라면 외부 도구를 써야 하는 규모의 일입니다.
- **커버링 인덱스가 못 됩니다.** 인덱스만 읽고 끝나는 최적화는 기대할 수 없고, 매칭된 행을 다시 읽습니다.
- **범위 스캔이 안 됩니다.** 등호와 포함 검색만입니다. 정렬에도 쓸 수 없습니다.
- **인덱스 하나에 다중 값 키 파트는 하나**만 들어갑니다.
- **빈 배열은 인덱스 레코드를 만들지 않습니다.** 배열에 JSON `null`도 넣을 수 없습니다. "태그가 없는 교실"은 이 인덱스로 찾을 수 없습니다.
- 문자열 배열은 지원되는 문자셋·콜레이션이 제한돼 있습니다. 대소문자·악센트를 구분하는 쪽만 가능해서, **대소문자 무시 매칭을 기대할 수 없습니다.** 저장 전에 소문자로 정규화해 두는 편이 안전합니다.
- 한 행이 만들 수 있는 키 개수에도 상한이 있습니다. 수백 개 넘는 배열을 담을 생각이라면 접근 자체를 다시 봐야 합니다.

목록을 다시 보면, 이건 **관계 테이블을 피한 대가를 인덱스 쪽에서 치르는 구조**입니다.

태그를 조건으로 자주 쓰고 집계도 해야 한다면 `classroom_tags(classroom_id, tag)` 테이블이 정답에 가깝습니다. 조인 한 번이 늘어나는 대신 범위·정렬·커버링·유니크 제약이 전부 돌아옵니다.

다중 값 인덱스가 맞는 자리는 좁습니다. 배열이 한 문서 안에서만 의미가 있고, 조건이 "포함되는가" 하나로 끝나고, 그 배열로 정렬하거나 집계할 일이 없을 때입니다.

## 문서를 통째로 다시 쓰면 갱신이 사라진다

JSON 컬럼의 흔한 사고는 인덱스가 아니라 쓰기 쪽에서 납니다.

애플리케이션에서 문서를 읽고, 객체를 수정하고, 통째로 `UPDATE`하는 코드가 자연스럽게 나옵니다.

```typescript
const row = await getSettings(centerId);
row.settings.report = { enabled: true };
await saveSettings(centerId, row.settings);   // 문서 전체를 덮어쓴다
```

읽기와 쓰기 사이에 다른 요청이 같은 문서의 **다른 키**를 바꿨다면, 그 변경은 사라집니다. 갱신 분실이고, 필드별 컬럼으로 나뉘어 있었다면 일어나지 않았을 일입니다.

JSON은 여러 필드를 한 값으로 묶기 때문에 **서로 무관한 수정끼리도 충돌 범위에 들어옵니다.**

바꿀 경로만 지정해서 DB에서 수정하면 이 문제가 사라집니다.

```sql
UPDATE center_settings
   SET settings = JSON_SET(settings, '$.report.enabled', TRUE)
 WHERE center_id = ?;
```

덤으로 최적화가 하나 붙습니다. 컬럼이 `JSON` 타입이고 `JSON_SET`·`JSON_REPLACE`·`JSON_REMOVE`로 갱신하며 새 값이 기존 값 자리에 들어갈 수 있을 때, MySQL은 문서 전체를 다시 쓰지 않고 제자리에서 고칠 수 있습니다.

값 전체를 대입하는 형태는 이 최적화를 받지 못하고, 요소를 새로 추가하는 경우도 제외됩니다. 조건이 까다로우니 기대기보다 확인하는 쪽이 낫습니다.

```sql
SELECT JSON_STORAGE_SIZE(settings) AS size_bytes,
       JSON_STORAGE_FREE(settings) AS free_bytes
  FROM center_settings
 WHERE center_id = ?;
```

복제로 흘러가는 양도 같이 봅니다. 행 기반 복제는 기본적으로 **바뀐 키가 하나여도 문서 전체를 바이너리 로그에 적습니다.**

수십 KB짜리 문서의 불린 하나를 자주 토글하는 테이블이라면, 그 자체가 복제 지연과 바이너리 로그 증가의 원인이 됩니다. `binlog_row_value_options=PARTIAL_JSON`으로 부분 갱신만 기록하게 할 수 있지만, 바이너리 로그 포맷·복제 대상 호환성 같은 전제가 붙습니다. 관리형 DB라면 파라미터 그룹에서 바꿀 수 있는지부터 확인하세요.

## 사라진 제약을 일부만 되찾기

JSON으로 옮기는 순간 DB가 강제해주던 것들이 전부 없어집니다. 타입도, 필수 여부도, 허용값 집합도, 유니크도, 외래키도요.

소프트 삭제가 유니크 제약을 애플리케이션 몫으로 넘기는 것과 같은 종류의 이동이고, 범위는 훨씬 넓습니다.

`CHECK` 제약과 `JSON_SCHEMA_VALID()`로 모양 검증 일부는 DB에 돌려놓을 수 있습니다.

```sql
ALTER TABLE center_settings
  ADD CONSTRAINT ck_settings_shape CHECK (
    JSON_SCHEMA_VALID(
      '{
        "type": "object",
        "required": ["plan"],
        "properties": {
          "plan": { "enum": ["free", "pro"] },
          "report": {
            "type": "object",
            "properties": { "enabled": { "type": "boolean" } }
          }
        }
      }',
      settings
    )
  );
```

제약을 추가할 때 기존 행도 검사하니, 먼저 위반 행을 찾아 정리해야 추가가 통과합니다.

```sql
SELECT center_id
  FROM center_settings
 WHERE NOT JSON_SCHEMA_VALID('{ ... 위와 같은 스키마 ... }', settings)
 LIMIT 50;
```

여기서 한계가 분명해집니다. 스키마가 DDL 안의 문자열 리터럴로 들어가서, 옵션 하나 추가할 때마다 `ALTER TABLE`을 돌려야 합니다. **스키마 변경을 피하려고 JSON을 썼는데 스키마 변경이 돌아온 셈**입니다.

그래서 현실적인 배치는 이렇습니다.

- **쓰기 경로의 입력 검증은 애플리케이션에서** 합니다. 타입 스키마를 코드에 두면 검증과 타입이 한 곳에서 관리됩니다.
- **DB의 `CHECK`는 최후 방어선으로 얇게** 둡니다. 꼭 지켜야 하는 최소 불변식(최상위가 객체인지, 필수 키 몇 개가 있는지) 정도에서 멈춥니다.

```typescript
import { z } from 'zod';

const Settings = z.object({
  plan: z.enum(['free', 'pro']),
  report: z.object({ enabled: z.boolean() }).default({ enabled: false }),
  limits: z.object({ max_children: z.number().int().positive() }).partial(),
});

// 저장 직전에 한 번만 통과시킨다. 통과한 값만 DB로 간다.
export const parseSettings = (raw: unknown) => Settings.parse(raw);
```

읽기 쪽도 같이 봐야 합니다. 과거에 들어간 행은 지금 스키마를 만족하지 않으니, **읽을 때 기본값을 채우는 경로**가 필요합니다. 그 경로가 없으면 오래된 행에서 `undefined`가 흘러다닙니다.

### 이중 인코딩

드라이버가 객체를 알아서 직렬화하는데 코드에서 한 번 더 문자열로 만들면, 문서가 아니라 **문자열 하나**가 저장됩니다.

이 행은 유효한 JSON이라 거부되지 않습니다. 대신 `->>'$.plan'`이 `NULL`을 돌려주고, 생성 컬럼도 인덱스도 조용히 아무것도 못 찾습니다.

한 번 세어보면 바로 드러납니다.

```sql
SELECT JSON_TYPE(settings) AS t, COUNT(*) AS rows_count
  FROM center_settings
 GROUP BY t;
-- OBJECT 가 아니라 STRING 이 섞여 있으면 이중 인코딩된 행이다
```

마이그레이션 직후나 데이터 보정 스크립트를 돌린 뒤에 한 번씩 확인해볼 값입니다.

## 무엇을 꺼내 컬럼으로 만들 것인가

판단 기준은 "스키마가 고정인가"보다 **그 값을 어떻게 쓰는가**입니다.

| 쓰는 방식 | 둘 자리 |
| --- | --- |
| `WHERE` 조건으로 쓴다 | 컬럼 (또는 생성 컬럼 + 인덱스) |
| `GROUP BY`·`ORDER BY`에 쓴다 | 컬럼 |
| 유니크·외래키·`NOT NULL`이 필요하다 | 컬럼 |
| 다른 테이블과 조인한다 | 컬럼 또는 별도 테이블 |
| 항목이 여러 개이고 각각을 조건으로 쓴다 | 관계 테이블 |
| 문서를 통째로 읽고 통째로 쓴다 | JSON |
| 키 집합이 테넌트마다 다르고 조건으로 안 쓴다 | JSON |

마지막 두 줄이 JSON이 정말 잘 맞는 자리입니다. 구체적으로는 이런 것들입니다.

- 외부 API 응답이나 웹훅 페이로드 보관 (원문 보존이 필요하면 `LONGTEXT`)
- 주문 시점의 배송지·약관 동의처럼 **그때의 모습을 굳혀두는 스냅샷**
- 감사 로그의 변경 전후 값
- 거의 조회되지 않는 옵션들의 꼬리

반대로 "이 옵션 켠 기관 목록"처럼 조건이 될 가능성이 보이는 값은, 처음부터 컬럼으로 두는 비용이 가장 쌉니다.

이미 JSON에 들어가 있는 값을 꺼내는 작업은 컬럼 추가 → 양쪽 쓰기 → 백필 → 읽기 전환 → 제약 추가 순서로 넓힌 다음 좁히면 배포 창 없이 가능합니다. 다만 **이 작업은 생각보다 길게 끌립니다.** 읽는 코드가 한 군데가 아니고, JSON 쪽을 보던 쿼리와 리포트가 어디까지 퍼져 있는지 처음에는 안 보입니다.

## 운영에서 드러나는 비용

인덱스를 해결하고 나서 남는 것은 문서 크기입니다.

InnoDB는 긴 가변 길이 컬럼을 행 밖 오버플로 페이지에 둡니다. 큰 JSON을 가진 테이블은 **그 컬럼을 읽을 때 추가 I/O**가 붙습니다.

그래서 `SELECT *`가 비싸집니다. 목록 API가 설정 문서 전체를 매번 끌어오고 있는데, 화면에서는 두 개 필드만 씁니다.

```sql
-- 목록에서는 필요한 값만
SELECT center_id, plan, JSON_VALUE(settings, '$.report.enabled' RETURNING UNSIGNED) AS report_on
  FROM center_settings
 WHERE plan = 'pro';
```

`JSON_VALUE`는 추출과 캐스팅을 한 번에 하는 함수로, MySQL 8.0.21 이상에서 쓸 수 있습니다. 더 좋은 건 조건과 결과 컬럼이 전부 생성 컬럼 안에 들어와 **커버링 인덱스로 끝나는** 모양입니다. 큰 문서를 가진 테이블에서는 이 차이가 큽니다.

버퍼 풀도 같이 봐야 합니다. 큰 문서는 그만큼 페이지를 차지하고, 자주 쓰이는 다른 테이블의 페이지를 밀어냅니다. 조건으로 안 쓰이는 큰 문서를 핫한 테이블에 같이 두는 구조라면, 별도 테이블로 떼어 1:1로 조인하는 쪽이 나을 수 있습니다.

지표로 둘 만한 것은 세 가지입니다.

```sql
-- 문서 크기 분포. 상위 꼬리가 길면 거기부터 본다
SELECT MAX(JSON_STORAGE_SIZE(settings)) AS max_bytes,
       AVG(JSON_STORAGE_SIZE(settings)) AS avg_bytes,
       SUM(JSON_STORAGE_SIZE(settings) > 65536) AS over_64kb
  FROM center_settings;

-- 깊이와 키 개수. 기대보다 깊으면 스키마가 무너지고 있다는 신호
SELECT MAX(JSON_DEPTH(settings)) AS max_depth,
       MAX(JSON_LENGTH(settings)) AS max_keys
  FROM center_settings;
```

{% comment %} TODO: 실제 운영에서 JSON 컬럼 문서 크기가 어느 정도까지 커졌는지, 그 시점에 무엇이 먼저 느려졌는지 적어주세요 {% endcomment %}

## 체크리스트

- [ ] JSON 안의 값을 `WHERE`·`ORDER BY`에 쓰는 쿼리가 있는가, 있다면 `EXPLAIN`에서 인덱스를 타는가
- [ ] 생성 컬럼을 `VIRTUAL`로 두었는가 (`STORED`는 테이블 재구성)
- [ ] 생성 컬럼의 타입과 콜레이션이 비교 대상과 맞는가 (`SHOW CREATE TABLE`로 확인)
- [ ] 함수 인덱스를 썼다면 쿼리의 식이 인덱스의 식과 완전히 같은가
- [ ] 배열 검색에 다중 값 인덱스를 고려했다면, 커버링·범위·빈 배열 제약을 감수할 수 있는가
- [ ] 문서를 읽어서 통째로 덮어쓰는 코드 경로가 있는가 (갱신 분실)
- [ ] 자주 토글되는 큰 문서가 바이너리 로그를 얼마나 만드는지 봤는가
- [ ] 쓰기 경로에 스키마 검증이 있고, 읽기 경로에 기본값 채우기가 있는가
- [ ] `JSON_TYPE`으로 이중 인코딩된 행이 없는지 확인했는가
- [ ] 목록 조회가 큰 문서를 통째로 끌어오고 있지 않은가
- [ ] 문서 크기·깊이 분포를 주기적으로 보는가

정리하면 기준은 하나입니다. **JSON은 "통째로 다루는 값"에 쓰는 타입입니다.**

그 안의 한 조각을 이름으로 부르기 시작하면 — 조건으로 쓰고, 세고, 정렬하고, 제약을 걸고 싶어지면 — 그건 이미 컬럼입니다. 생성 컬럼과 인덱스는 그 전환을 미뤄주는 좋은 장치지, 전환을 없애주는 장치는 아닙니다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- JSON에 담았다가 컬럼으로 꺼낸 값과 그 판단 기준
- 생성 컬럼·함수 인덱스를 적용하고 실제로 달라진 실행 계획

{% endcomment %}
