---
layout: post
title: "인덱스를 추가했는데 그대로 느리다 — 복합 인덱스의 컬럼 순서와 EXPLAIN 읽기"
date: 2026-10-10
tags: [mysql, database, backend, sql, performance]
excerpt: "느린 쿼리에 인덱스를 걸어도 실행 계획이 안 바뀌는 경우가 있습니다. 선행 컬럼 규칙과 key_len으로 몇 컬럼까지 쓰였는지 읽는 법, 범위 조건이 뒤쪽 컬럼을 닫아버려 정렬이 filesort로 떨어지는 구조, 함수와 암묵적 형변환으로 인덱스가 무효가 되는 경로, 인덱스를 타고도 느린 랜덤 룩업과 커버링 인덱스, 옵티마이저가 일부러 풀 스캔을 고르는 선택도 문제, 그리고 인덱스를 늘릴 때 쓰기 쪽에서 내주는 것까지."
---

느린 쿼리를 찾아 `WHERE`에 들어간 컬럼으로 인덱스를 만들고 배포했는데, 응답 시간이 그대로입니다.
`EXPLAIN`을 떠보면 새로 만든 인덱스 이름이 `key`에 찍혀 있기도 합니다.

인덱스는 "걸려 있다/없다"의 문제가 아니라 **쿼리가 그 인덱스의 어디까지 쓸 수 있는가**의 문제입니다.
컬럼 순서 하나로 같은 인덱스가 범위를 좁히는 도구가 되거나, 그냥 통째로 훑는 대상이 됩니다.

## 예제

예약 목록 API가 쓰는 테이블입니다.

```sql
CREATE TABLE reservations (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  status      VARCHAR(20)     NOT NULL,   -- PENDING / CONFIRMED / CANCELED
  reserved_at DATETIME        NOT NULL,
  user_phone  VARCHAR(20)     NOT NULL,
  memo        TEXT            NULL,
  PRIMARY KEY (id),
  KEY idx_tenant_reserved (tenant_id, reserved_at)
) ENGINE=InnoDB;
```

목록 쿼리는 이렇게 생겼습니다.

```sql
SELECT id, status, reserved_at, user_phone
FROM reservations
WHERE tenant_id = 42
  AND status = 'CONFIRMED'
  AND reserved_at >= '2026-10-01 00:00:00'
ORDER BY reserved_at DESC
LIMIT 20;
```

`idx_tenant_reserved`가 있으니 인덱스는 "타고" 있습니다. 그런데도 느립니다.

## EXPLAIN에서 실제로 봐야 하는 칸

`EXPLAIN`을 읽을 때 `key`에 인덱스 이름이 찍혔는지만 확인하고 끝내면 아무것도 모른 것과 같습니다.
의미 있는 칸은 다섯 개입니다.

| 칸 | 읽는 법 |
| --- | --- |
| `type` | `ref`·`range`는 범위를 좁혔다는 뜻, `index`는 **인덱스 전체 스캔**, `ALL`은 테이블 전체 스캔 |
| `key` | 실제로 고른 인덱스 |
| `key_len` | 그 인덱스의 **앞에서 몇 바이트까지** 탐색에 썼는가 |
| `rows` / `filtered` | 읽을 것으로 추정한 행 수와, 그중 조건을 통과할 것으로 본 비율 |
| `Extra` | `Using index`(커버링), `Using filesort`, `Using temporary`, `Using index condition` |

이 중 실무에서 가장 많이 쓰이면서 가장 안 보는 칸이 `key_len`입니다.
**복합 인덱스의 몇 번째 컬럼까지 쓰였는지가 여기서 드러납니다.**

`tenant_id`(8바이트 BIGINT)만 썼다면 8이고, `reserved_at`까지 썼다면 거기에 DATETIME 길이가 더해집니다.
바이트 수는 타입·NULL 허용 여부·문자셋에 따라 달라지니, 정확히 계산하려 들기보다 **쿼리를 고치기 전과 후의 `key_len`을 비교**하는 쪽이 실용적입니다. 숫자가 커졌으면 더 많은 컬럼으로 좁혔다는 뜻입니다.

`rows`와 `filtered`를 같이 보는 습관도 중요합니다. `rows`가 50만이고 `filtered`가 2%라면, **인덱스로 50만 행을 읽어와서 그중 1만 행만 남겼다**는 뜻입니다. 인덱스는 탔지만 거르는 일은 인덱스가 안 해준 겁니다.

> `EXPLAIN`의 `rows`는 추정치이고 실제 읽은 행 수가 아닙니다. 실제 수치가 필요하면 MySQL 8.0 계열의 `EXPLAIN ANALYZE`로 실행해보는 편이 확실합니다(지원 여부는 사용 중인 버전의 공식 문서를 확인하세요).

## 선행 컬럼이 없으면 쓰지 못한다

복합 인덱스는 컬럼을 이어붙인 하나의 정렬된 키입니다. `(tenant_id, reserved_at)` 인덱스는 전화번호부가 "성 → 이름" 순으로 정렬된 것과 같습니다.

성을 모르고 이름만 아는 상태로는 전화번호부를 좁힐 수 없습니다. 그래서 이런 쿼리는 이 인덱스를 못 씁니다.

```sql
-- 선행 컬럼(tenant_id)이 조건에 없다
SELECT * FROM reservations WHERE reserved_at >= '2026-10-01';
```

여기서 흔히 나오는 반박이 "최신 버전에는 선행 컬럼을 건너뛰는 최적화가 있다"는 것입니다.
MySQL 8.0 계열에는 index skip scan이 있긴 하지만 적용 조건이 까다로워서, **설계 원칙으로 기대할 만한 동작은 아닙니다.** 선행 컬럼은 여전히 거의 항상 조건에 있어야 합니다.

## 범위 조건이 뒤쪽 컬럼을 닫는다

예제 쿼리가 느린 진짜 이유는 여기입니다. 인덱스가 `(tenant_id, reserved_at)`인데 `status`는 인덱스에 없습니다.

그러면 이 순서로 일이 벌어집니다.

1. `tenant_id = 42 AND reserved_at >= ...`로 인덱스 범위를 잡는다
2. 그 범위에 들어온 행을 **전부 테이블에서 읽는다**
3. 읽은 행마다 `status = 'CONFIRMED'`를 확인해 버린다

10월 이후 예약이 50만 건이고 그중 확정이 1만 건이면, 20건을 돌려주려고 50만 번 룩업할 수도 있습니다.
`LIMIT 20`은 이걸 막아주지 않습니다. 조건을 통과하는 20건을 찾을 때까지 계속 읽기 때문입니다.

인덱스를 다시 만듭니다.

```sql
ALTER TABLE reservations
  ADD KEY idx_tenant_status_reserved (tenant_id, status, reserved_at);
```

이제 동등 조건 두 개로 지점을 특정하고, 그 안에서 `reserved_at`은 이미 정렬돼 있습니다.
범위 조건과 `ORDER BY`를 같은 인덱스로 처리하니 `Using filesort`도 사라집니다. `DESC` 정렬은 인덱스를 역방향으로 읽으면 되니 추가 비용이 거의 없습니다.

순서를 뒤집어 `(tenant_id, reserved_at, status)`로 만들면 어떨까요. 범위와 정렬은 처리되지만 **`status`는 범위 조건 뒤에 있어서 탐색에 쓰이지 못합니다.**
범위 조건 하나가 그 뒤의 모든 컬럼을 탐색 대상에서 닫아버립니다. 그래서 규칙은 이렇게 정리됩니다.

**동등 비교 컬럼 → 정렬 컬럼 → 범위 비교 컬럼** 순으로 놓습니다.

정렬이 인덱스로 처리되지 않는 경우도 같은 규칙에서 나옵니다.

```sql
-- idx(tenant_id, status, reserved_at)에서
-- status가 여러 값이면 reserved_at은 범위 전체에 걸쳐 정렬돼 있지 않다
WHERE tenant_id = 42 AND status IN ('PENDING', 'CONFIRMED')
ORDER BY reserved_at DESC
```

각 `status` 값 안에서는 정렬돼 있지만, 두 구간을 합친 결과는 정렬 순서가 아닙니다. 대부분 `Using filesort`가 붙습니다.
이런 쿼리가 핵심 경로라면 상태를 "진행 중/종료" 같은 플래그 하나로 바꿔 동등 비교로 만드는 쪽이 인덱스 설계와 맞습니다.

## 컬럼을 감싸는 순간 못 쓴다

조건절에서 컬럼에 함수를 씌우면 인덱스는 무효가 됩니다. 인덱스에 들어 있는 건 원래 값이고, 함수를 통과한 값은 거기 없기 때문입니다.

```sql
-- 인덱스를 못 쓴다
WHERE DATE(reserved_at) = '2026-10-10'

-- 범위로 바꿔 쓴다
WHERE reserved_at >= '2026-10-10 00:00:00'
  AND reserved_at <  '2026-10-11 00:00:00'
```

더 찾기 어려운 쪽은 **암묵적 형변환**입니다.

```sql
-- user_phone은 VARCHAR인데 숫자로 비교했다
WHERE user_phone = 01012345678;
```

문자열 컬럼과 숫자를 비교하면 MySQL은 **컬럼 쪽을 숫자로 변환합니다.** 모든 행에 변환이 걸리니 인덱스를 못 쓰고, `'01012345678'`과 `1012345678`은 숫자로 같지도 않아서 결과까지 틀립니다.
ORM이 타입을 느슨하게 바인딩하거나 JSON 바디의 숫자를 그대로 넘기는 코드에서 조용히 생깁니다.

> 반대 방향, 즉 숫자 컬럼에 문자열 리터럴을 비교하는 경우는 리터럴만 변환되므로 인덱스를 계속 쓸 수 있습니다. 같은 "타입 불일치"가 한쪽에서만 문제가 됩니다.

조인에서는 **콜레이션 불일치**가 같은 일을 합니다. 서로 다른 콜레이션 컬럼을 조인하면 한쪽을 변환하면서 그쪽 인덱스를 못 씁니다.
테이블을 다른 시기에 만들었거나 메이저 업그레이드로 기본 콜레이션이 바뀐 스키마에서 자주 보입니다.

표현식 자체로 조회해야 한다면 생성 컬럼에 인덱스를 걸거나, MySQL 8.0 계열이 지원하는 함수 기반 인덱스를 쓰는 선택이 있습니다. 제약 사항은 버전별로 다르니 공식 문서를 확인하세요.

## OR와 LIKE가 범위를 못 만드는 경우

인덱스 탐색은 "여기서부터 여기까지"라는 **연속된 구간 하나**를 잡는 일입니다. 조건이 그 구간으로 번역되지 않으면 인덱스는 할 일이 없어집니다.

서로 다른 컬럼을 `OR`로 묶으면 구간이 둘로 쪼개집니다.

```sql
-- 한 번의 인덱스 탐색으로 번역되지 않는다
WHERE user_phone = '01012345678' OR memo LIKE '%환불%'
```

옵티마이저가 양쪽 인덱스를 각각 읽어 합치는 index merge를 고를 때도 있지만, 한쪽이라도 인덱스가 없으면 그 순간 풀 스캔입니다.
조건이 각각 선택도가 높다면 쿼리를 둘로 나눠 `UNION ALL`로 합치는 편이 계획을 예측 가능하게 만듭니다. 중복 제거가 필요하면 `UNION`이지만, 정렬 비용이 추가로 듭니다.

`LIKE`는 **접두사 패턴일 때만** 구간이 됩니다.

```sql
WHERE user_phone LIKE '0101234%'   -- 범위로 번역된다
WHERE user_phone LIKE '%1234567%'  -- 시작점을 모르니 전부 읽는다
```

중간 일치 검색이 요구사항이라면 인덱스를 더 붙이는 게 아니라 접근 방식을 바꿔야 합니다. 전문 검색이나 별도 검색엔진 쪽 문제입니다.

## 인덱스를 타고도 느린 경우

세컨더리 인덱스 리프에는 인덱스 컬럼과 **기본키 값만** 들어 있습니다. 그 외 컬럼이 필요하면 기본키로 클러스터드 인덱스를 한 번 더 찾아갑니다.

이 룩업이 행마다 랜덤 I/O가 되므로, 읽을 행이 많으면 **인덱스를 타는 쪽이 풀 스캔보다 느려질 수 있습니다.**

필요한 컬럼이 전부 인덱스 안에 있으면 이 단계가 사라집니다. `Extra`에 `Using index`가 찍히는 상태, 커버링 인덱스입니다.

```sql
ALTER TABLE reservations
  ADD KEY idx_cover (tenant_id, status, reserved_at, user_phone);
```

`SELECT *`로는 커버링이 성립하지 않습니다. 특히 예제의 `memo TEXT`처럼 큰 컬럼을 끌고 오면 선택지 자체가 없어집니다.
목록 API에서 **실제로 화면에 쓰는 컬럼만 골라 받는 것**이 인덱스 설계의 일부입니다.

다만 커버링을 위해 컬럼을 계속 붙이면 인덱스가 테이블만큼 커집니다. 트래픽이 집중된 쿼리 하나를 위해 쓸 카드이고, 모든 쿼리에 적용할 기법은 아닙니다.

## 옵티마이저가 일부러 안 고르는 경우

인덱스를 만들었는데 `key`가 `NULL`이고 `type`이 `ALL`이면, 옵티마이저가 **읽어보고 포기한** 것입니다.

```sql
-- 전체의 95%가 CONFIRMED라면
WHERE status = 'CONFIRMED'
```

선택도가 낮은 컬럼은 인덱스로 좁히는 의미가 없고, 앞서 본 랜덤 룩업까지 붙으니 풀 스캔이 실제로 더 빠릅니다.
이건 옵티마이저의 오판이 아니라 맞는 판단입니다. **고를 만한 인덱스가 아닌 것**이 문제입니다.

판단의 근거는 통계치입니다. 통계가 오래됐거나 대량 변경 직후라면 추정이 크게 틀어질 수 있습니다.

```sql
ANALYZE TABLE reservations;

-- 값 분포가 심하게 치우친 컬럼은 히스토그램으로 알려줄 수 있다
ANALYZE TABLE reservations UPDATE HISTOGRAM ON status WITH 16 BUCKETS;
```

여기서 `FORCE INDEX`로 강제하고 싶어지는데, 급한 불을 끄는 수단으로만 쓰는 게 좋습니다.

```sql
SELECT ... FROM reservations FORCE INDEX (idx_tenant_status_reserved) WHERE ...
```

데이터 분포가 바뀌거나 인덱스 이름이 바뀌면 이 쿼리는 더 나쁜 계획에 고정되거나 그냥 깨집니다.
근본 해결은 인덱스 구성이나 쿼리 형태를 바꾸는 쪽입니다.

{% comment %} TODO: 실제로 인덱스 순서를 바꿔 해결한 쿼리가 있다면, 변경 전후의 EXPLAIN과 응답 시간을 적어주세요 {% endcomment %}

## 늘릴 때 내주는 것

인덱스는 조회를 빠르게 하는 대신 **쓰기마다 갱신 대상이 하나 늘어납니다.** `INSERT`·`UPDATE`·`DELETE`가 모두 느려지고, 버퍼 풀에서 데이터와 자리를 다툽니다.

그래서 쌓인 인덱스를 정리하는 일이 인덱스를 추가하는 일과 같은 비중을 가집니다.

`(tenant_id)` 단독 인덱스는 `(tenant_id, status)`가 있으면 **필요 없습니다.** 선행 컬럼이 같으면 짧은 쪽은 긴 쪽의 접두사로 대체됩니다.
반대로 `(status, tenant_id)`는 접두사가 달라 별개입니다. 중복인지 아닌지는 **선행 컬럼이 겹치는지**로 판단합니다.

실제로 안 쓰이는 인덱스는 조회해서 확인할 수 있습니다.

```sql
SELECT * FROM sys.schema_unused_indexes;

SELECT object_name, index_name, count_star, count_read, count_write
FROM performance_schema.table_io_waits_summary_by_index_usage
WHERE object_schema = DATABASE() AND index_name IS NOT NULL
ORDER BY count_star;
```

> 이 수치는 서버가 켜진 뒤 누적된 값입니다. 재시작 직후나 월말 배치만 쓰는 인덱스는 "안 쓰임"으로 보일 수 있으니, 충분한 기간을 두고 판단하세요.

인덱스를 지우는 것도 큰 테이블에서는 그 자체로 작업입니다. 삭제 전에 `ALTER TABLE ... ALTER INDEX idx_name INVISIBLE`로 안 보이게 해서 영향을 먼저 확인하는 방법도 있습니다. 문제가 생기면 다시 보이게 하면 됩니다.

## 설계 순서

새 인덱스가 필요하다고 판단했을 때 밟는 순서입니다.

1. 쿼리의 **동등 비교 컬럼**을 모은다. 이게 인덱스 앞쪽이다
2. `ORDER BY` 컬럼을 그다음에 놓는다
3. **범위 비교 컬럼을 마지막에** 놓는다. 그 뒤는 탐색에 쓰이지 못한다
4. 자주 쓰이는 쿼리라면 `SELECT` 목록까지 덮을 수 있는지 본다
5. 선행 컬럼이 겹치는 기존 인덱스가 있으면 **새로 만들지 말고 뒤에 컬럼을 붙인다**
6. `EXPLAIN`으로 `key_len`과 `Extra`가 기대한 대로 바뀌었는지 확인한다

6번을 운영 데이터와 비슷한 규모에서 해야 의미가 있습니다. 행이 수천 개뿐인 개발 DB에서는 어떤 인덱스를 만들어도 빠르고, 옵티마이저는 자주 풀 스캔을 고릅니다.
인덱스 선택은 분포에 달린 문제라, **데이터가 없는 환경에서는 검증이 안 됩니다.**
