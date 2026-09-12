---
layout: post
title: "운영 중인 큰 테이블에 컬럼 추가하기 — 온라인 DDL과 gh-ost 사이에서"
date: 2026-09-12
tags: [mysql, database, devops, sql]
excerpt: "컬럼 하나 추가하는 ALTER가 왜 서비스 전면 장애가 되는가. 메타데이터 락이 쌓이는 경로를 진단하고, INSTANT·INPLACE·COPY와 gh-ost·pt-osc를 언제 고르는지 정리합니다."
---

스테이징에서 0.2초에 끝난 `ALTER TABLE`이 운영에서 10분 넘게 안 끝나는 건 그나마 양호한 쪽입니다.
더 흔한 전개는, ALTER 자체는 아직 시작도 못 했는데 그 테이블을 읽는 모든 요청이 같이 멈추는 것입니다.

테이블이 커서 느린 문제와, 락이 줄을 서서 서비스가 멈추는 문제는 원인도 대응도 다릅니다.
둘을 갈라서 보고, 어떤 선택지가 있는지 적어둡니다.

> 온라인 DDL의 지원 범위는 엔진과 **마이너 버전마다 다릅니다.**
> 아래 동작은 MySQL 8.x InnoDB 기준이고, 특정 변경이 어떤 알고리즘으로 가능한지는 반드시 현행 공식 문서와 뒤에 적은 방법으로 직접 확인하세요.

## 컬럼 하나가 서비스를 멈추는 경로

InnoDB가 "온라인"이라고 말하는 건 **복사하는 동안** 읽기·쓰기가 계속된다는 뜻입니다.
DDL을 시작할 때와 끝낼 때는 그것과 별개로 **배타적 메타데이터 락(MDL)**이 필요합니다. 짧게 잡고 놓지만, 잡으려면 먼저 기존 보유자가 놓아야 합니다.

문제는 여기서 생깁니다.

1. 누군가 `orders`를 읽는 트랜잭션을 열어둔 채 커밋하지 않고 있다 (공유 MDL 보유)
2. ALTER가 배타적 MDL을 요청하고 **대기**로 들어간다
3. 그 뒤에 들어온 `orders` 쿼리는 — 읽기든 쓰기든 — ALTER 뒤에 줄을 선다
4. 커넥션이 반납되지 않고 쌓여서 **풀이 고갈되고, 그 테이블과 무관한 API까지 같이 죽는다**

3번이 핵심입니다. MDL 대기는 선착순이라, 먼저 기다리는 ALTER를 추월해서 읽기가 통과하지 못합니다.
그래서 **ALTER 한 줄이 테이블 단위가 아니라 서비스 단위 장애로 번집니다.**

```text
t0  트랜잭션 A: SELECT ... (커밋 안 함)      ← 공유 MDL 보유
t1  ALTER TABLE orders ...                  ← 배타 MDL 대기
t2  SELECT / INSERT / UPDATE ...            ← ALTER 뒤에서 대기
t3  커넥션 풀 고갈
```

범인은 대개 ALTER가 아니라 **t0의 열린 트랜잭션**입니다. 오토커밋을 끄고 읽기만 하고 커밋을 잊은 코드, 트랜잭션 안에서 외부 API를 호출하며 응답을 기다리는 코드, 끝나지 않는 배치 같은 것들입니다.

## 지금 무엇이 무엇을 기다리는가

증상이 났을 때 추측하지 말고 조회합니다. 어느 쪽이 보유자이고 어느 쪽이 대기자인지가 바로 나옵니다.

```sql
SELECT ml.OBJECT_SCHEMA, ml.OBJECT_NAME,
       ml.LOCK_TYPE, ml.LOCK_STATUS,
       t.PROCESSLIST_ID, t.PROCESSLIST_TIME, t.PROCESSLIST_INFO
FROM performance_schema.metadata_locks ml
JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID
WHERE ml.OBJECT_SCHEMA = 'myapp'
  AND ml.OBJECT_NAME = 'orders'
ORDER BY ml.LOCK_STATUS, t.PROCESSLIST_TIME DESC;
```

`LOCK_STATUS`가 `GRANTED`인 행이 붙잡고 있는 쪽, `PENDING`이 기다리는 쪽입니다.
`PROCESSLIST_TIME`이 유난히 큰 `GRANTED` 행이 보이면 그게 원인입니다. 결과가 비어 있으면 `performance_schema.setup_instruments`에서 MDL 계측이 켜져 있는지 확인하세요.

오래 열려 있는 트랜잭션은 따로 봅니다.

```sql
SELECT trx_mysql_thread_id AS conn_id,
       TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age_sec,
       trx_state, trx_query
FROM information_schema.innodb_trx
ORDER BY trx_started;
```

`trx_query`가 `NULL`인데 `age_sec`이 큰 행이 가장 질이 나쁩니다. **지금 쿼리를 돌리고 있지도 않으면서 트랜잭션만 붙들고 있는 상태**라서, 프로세스 목록만 봐서는 한가한 커넥션처럼 보입니다.

스키마 변경 작업은 이 조회를 먼저 돌려 깨끗한 걸 확인하고 시작합니다. 시작 전에 5초 쓰는 게 끝나고 30분 쓰는 것보다 쌉니다.

## 세 가지 알고리즘

같은 `ALTER TABLE`이라도 InnoDB가 내부적으로 택하는 길이 셋입니다. 비용 차이가 자릿수 단위로 납니다.

| 알고리즘 | 하는 일 | 소요 | 동시 쓰기 |
| --- | --- | --- | --- |
| `INSTANT` | 데이터는 건드리지 않고 메타데이터만 갱신 | 테이블 크기와 무관 | 영향 거의 없음 |
| `INPLACE` | 기존 테이블 파일 안에서 재구성·인덱스 생성 | 크기에 비례 | 대개 허용 |
| `COPY` | 새 테이블을 만들어 행을 전부 복사 | 크기에 비례, 가장 느림 | **막힘** |

엔진이 알아서 가장 싼 길을 고르기는 합니다. 문제는 **조건이 안 맞으면 조용히 한 단계 내려간다**는 점입니다.
`INSTANT`인 줄 알고 돌린 게 `COPY`로 떨어지면, 그때부터는 테이블 크기만큼 시간이 걸리고 그동안 쓰기가 막힙니다.

그래서 의도한 알고리즘을 **명시해서** 돌립니다.

```sql
-- 기대: 메타데이터만 바뀐다
ALTER TABLE orders
  ADD COLUMN settled_at DATETIME NULL, ALGORITHM=INSTANT;

-- 기대: 테이블 재구성은 하되 쓰기는 막지 않는다
ALTER TABLE orders
  ADD INDEX idx_orders_settled_at (settled_at), ALGORITHM=INPLACE, LOCK=NONE;
```

이렇게 쓰면 조건이 안 맞을 때 **시작하지 않고 에러를 냅니다.** 서비스를 멈춘 뒤에 알게 되는 것보다 훨씬 낫습니다.
명시 없이 돌려놓고 "왜 안 끝나지"를 보는 게 이 작업에서 가장 흔한 실수입니다.

거부되면 거기서 판단이 갈립니다. 조건을 맞춰 바꿔 쓸 수 있는지, 아니면 뒤에 나오는 외부 도구로 갈지.

### INSTANT에는 한도가 있다

`INSTANT`로 컬럼을 추가하거나 제거하면 테이블에 **행 버전**이 하나 늘어납니다. 예전 행은 그대로 두고 "이 버전부터는 컬럼이 하나 더 있다"를 메타데이터에 적는 방식이라, 공짜가 아니라 빚입니다.

이 버전 수에는 상한이 있고, 상한에 닿으면 그다음 `INSTANT`는 거부됩니다.

```sql
SELECT NAME, TOTAL_ROW_VERSIONS
FROM information_schema.INNODB_TABLES
WHERE NAME = 'myapp/orders';
```

그동안 `INSTANT`로 몇 번 손댔는지가 여기 누적돼 있습니다. 테이블을 재구성하는 작업(`OPTIMIZE TABLE` 등)을 하면 0으로 돌아갑니다.

그래서 자주 스키마가 바뀌는 테이블이라면, **가장 싼 수단이 언젠가 떨어진다**는 걸 알고 있어야 합니다.
평소엔 `INSTANT`로 넘기다가 정작 급한 날 거부당하면 대안을 그 자리에서 찾게 됩니다. 값을 주기적으로 확인하고, 여유가 있을 때 재구성해 두는 편이 낫습니다.

> 상한값과 어떤 변경이 `INSTANT`로 가능한지는 버전에 따라 달라집니다. 숫자를 외우지 말고 위 쿼리와 명시 실행으로 확인하세요.

## 레플리카에서 한 번 더 아프다

소스에서 끝났다고 끝이 아닙니다. DDL은 복제를 타고 레플리카에서 **다시** 실행됩니다.

`COPY`나 무거운 `INPLACE` 작업이 레플리카에서 재생되는 동안 그 뒤의 변경은 밀립니다. 결과는 복제 지연입니다.

- 리드 리플리카를 보는 대시보드와 배치가 **조용히 옛 데이터를 봅니다.** 에러가 아니라서 더 늦게 발견됩니다.
- 읽기를 리플리카로 분산하는 구조라면 방금 쓴 데이터가 안 보이는 현상이 생깁니다.
- 지연이 커지면 리플리카를 승격해 복구하는 계획 자체가 무효가 됩니다.

그래서 소스에서 몇 분 걸리는 작업은 레플리카에서도 그만큼 걸린다고 보고 일정을 잡습니다.
리플리카로 지표를 뽑고 있다면 **작업 시간대를 집계 배치와 겹치지 않게** 두는 것만으로도 사고 하나를 피합니다.

## 외부 도구로 가는 기준

엔진이 `COPY`밖에 길이 없다고 할 때, 선택지는 둘입니다. 쓰기를 막고 견디거나, 새 테이블을 만들어 천천히 옮기고 마지막에 이름만 바꾸는 것.

후자를 해주는 도구가 `gh-ost`와 `pt-online-schema-change`입니다. 둘의 구조적 차이는 **원본의 변경을 어떻게 따라잡는가**입니다.

| | gh-ost | pt-online-schema-change |
| --- | --- | --- |
| 변경 추적 | 바이너리 로그를 읽는다 | 원본에 **트리거**를 건다 |
| 원본 쓰기 부담 | 낮음 | 트리거 실행분이 모든 쓰기에 붙음 |
| 레플리카에서 복사 | 가능 | 소스에서 수행 |
| 따라잡기 한계 | 바이너리 로그 처리가 단일 스레드 | 트리거라 쓰기를 바로 따라감 |
| 중단 후 재개 | 제한적 | 지원 |
| 외래키·트리거 있는 테이블 | 제약이 많음 | 제약이 많음 |

읽는 방향은 이렇게 됩니다. **쓰기가 많은 테이블이면 gh-ost**가 유리합니다. 트리거 오버헤드가 쓰기 경로에 직접 붙지 않고, 복사를 레플리카에서 수행해 소스 부담을 더 줄일 수 있습니다.

반대로 **쓰기가 아주 몰리는 순간에는 gh-ost가 못 따라올 수 있습니다.** 바이너리 로그를 단일 스레드로 처리하기 때문입니다.
긴 작업을 여러 번 나눠 재개해야 하는 상황이라면 pt-osc 쪽이 편합니다.

두 도구 모두 **외래키나 트리거가 걸린 테이블에서는 제약이 큽니다.** 쓰기 전에 대상 테이블의 제약을 먼저 확인하세요. 여기서 막히면 도구 선택이 아니라 설계 문제로 넘어갑니다.

gh-ost는 부하 임계값과 전환 시점을 플래그로 통제합니다.

```bash
gh-ost \
  --host="$DB_HOST" --database=myapp --table=orders \
  --user=ghost --password="$GHOST_PASS" \
  --alter="ADD COLUMN settled_at DATETIME NULL" \
  --chunk-size=1000 \
  --max-load="Threads_running=50" \
  --critical-load="Threads_running=200" \
  --max-lag-millis=1500 \
  --postpone-cut-over-flag-file=/tmp/gh-ost.orders.postpone \
  --execute
```

여기서 실제로 중요한 건 마지막 두 줄입니다.

`--max-load`에 닿으면 복사를 **스로틀**하고, `--critical-load`에 닿으면 **중단**합니다. 전자는 "천천히 해라", 후자는 "당장 손 떼라"입니다. 둘을 같은 값으로 두면 구분이 사라집니다.

`--postpone-cut-over-flag-file`은 복사를 다 끝내놓고 **전환만 보류**하게 만듭니다. 파일을 지우는 순간 전환이 일어납니다.
복사는 새벽에 돌려두고 전환은 사람이 보고 있는 시간에 하는 식으로 쓸 수 있습니다. 유일하게 짧은 락이 필요한 구간을 눈 떠 있을 때로 옮기는 것이고, **이게 이 도구를 쓰는 실질적인 이유 중 하나입니다.**

pt-osc를 쓸 때는 `--dry-run`으로 한 번 돌려 계획을 확인하고 `--execute`로 바꿉니다.

```bash
pt-online-schema-change \
  --alter "ADD COLUMN settled_at DATETIME NULL" \
  D=myapp,t=orders \
  --max-load "Threads_running=50" \
  --critical-load "Threads_running=200" \
  --chunk-time 0.5 \
  --dry-run
```

어느 쪽이든 **전환 시점에는 짧은 배타 락이 필요합니다.** 무중단이 아니라 "중단 구간을 짧게, 그리고 고른 시점에"라고 이해하는 편이 정확합니다.

{% comment %} TODO: 실제로 다룬 테이블 규모와 어떤 도구를 골랐는지, 그 판단 근거가 있었다면 적어주세요 {% endcomment %}

## 스키마와 코드를 같이 바꾸지 않는다

도구보다 먼저 정해야 하는 건 순서입니다. 스키마와 코드를 한 번에 바꾸면 배포 중간 상태에서 반드시 깨집니다.
구 버전과 신 버전 인스턴스가 잠시 같이 떠 있고, 그 둘이 같은 DB를 보기 때문입니다.

그래서 **넓힌 다음 좁힙니다.**

1. 컬럼을 **`NULL` 허용으로** 추가한다. 이 시점의 코드는 이 컬럼을 모른다.
2. 새 컬럼에도 쓰기 시작한다. 읽기는 아직 기존 경로.
3. 과거 데이터를 나눠서 백필한다.
4. 읽기를 새 컬럼으로 옮긴다.
5. 제약(`NOT NULL` 등)을 걸고, 필요하면 구 컬럼을 제거한다.

1번에서 `NOT NULL`을 바로 걸면 구 버전 코드의 `INSERT`가 전부 실패합니다. 제약은 **모든 쓰기 경로가 값을 채우게 된 뒤** 마지막에 겁니다.
이 순서 하나로 배포 창을 잡을 필요가 없어집니다.

백필은 한 번의 `UPDATE`로 하지 않습니다. 큰 테이블을 한 문장으로 갱신하면 언두 로그가 불고 복제도 밀립니다.

```typescript
const CHUNK = 2_000;
let cursor = 0;

for (;;) {
  const [res] = await pool.query<ResultSetHeader>(
    `UPDATE orders
        SET settled_at = paid_at
      WHERE settled_at IS NULL
        AND id > ? AND id <= ?`,
    [cursor, cursor + CHUNK],
  );

  cursor += CHUNK;
  if (cursor > maxId) break;

  // 복제 지연이 붙으면 스스로 쉬어간다
  if (await replicaLagSeconds() > 2) {
    await sleep(5_000);
  }
}
```

`id` 범위로 끊는 게 `LIMIT`보다 낫습니다. 재실행할 때 어디까지 했는지가 커서 하나로 남고, 같은 구간을 다시 돌려도 `settled_at IS NULL` 조건 때문에 결과가 같습니다.
**중간에 멈춰도 이어서 돌릴 수 있는 형태**로 만들어 두는 게 핵심입니다. 백필은 대체로 한 번에 안 끝납니다.

복제 지연을 보고 쉬어가는 부분을 빼먹지 마세요. 백필은 급한 작업이 아니라서, 느리게 도는 대신 아무 일도 안 일어나게 만드는 쪽이 맞습니다.

## 줄 서는 걸 막는 안전장치

마지막으로, 판단이 틀렸을 때 피해를 줄이는 설정입니다.

`lock_wait_timeout`은 메타데이터 락을 얼마나 기다릴지 정합니다. 기본값이 사실상 무한에 가까워서, 그냥 두면 ALTER가 영원히 대기하며 뒤에 줄을 세웁니다.

```sql
SET SESSION lock_wait_timeout = 5;

ALTER TABLE orders
  ADD COLUMN settled_at DATETIME NULL, ALGORITHM=INSTANT;
```

5초 안에 못 잡으면 **실패하고 빠집니다.** 실패는 재시도하면 되고, 그 사이 쌓인 대기는 풀립니다.
스키마 변경을 자동화한다면 이 설정을 넣고 **짧은 타임아웃 + 재시도**로 돌리는 편이 안전합니다. 한 번에 성공하는 것보다 실패가 빨리 드러나는 게 중요합니다.

대기가 이미 쌓였다면 순서는 이렇습니다. ALTER를 먼저 죽이고, 그다음 원인이 된 오래된 트랜잭션을 처리합니다.

```sql
KILL <alter_connection_id>;   -- 줄의 앞을 먼저 치운다
KILL <stale_trx_connection_id>;
```

ALTER를 그대로 둔 채 원인 트랜잭션만 죽이면, ALTER가 락을 잡고 이번엔 자기가 오래 도는 쪽이 됩니다.
`COPY`로 떨어진 ALTER였다면 그게 더 긴 장애가 됩니다. **앞부터 치우는 순서를 기억해두세요.**

## 체크리스트

- [ ] 작업 전에 `innodb_trx`로 오래된 트랜잭션이 없는지 확인했는가
- [ ] `ALGORITHM`을 **명시**해서 실행하는가 (조용히 `COPY`로 내려가지 않게)
- [ ] `lock_wait_timeout`을 짧게 잡았는가
- [ ] `TOTAL_ROW_VERSIONS`가 상한에 가깝지 않은가
- [ ] 대상 테이블에 외래키·트리거가 있는지 확인했는가
- [ ] 레플리카에서 재생되는 시간과 집계 배치 일정이 겹치지 않는가
- [ ] 컬럼을 `NULL` 허용으로 먼저 추가하고, 제약은 마지막에 거는가
- [ ] 백필이 중단 후 이어서 돌릴 수 있는 형태인가
- [ ] 문제가 생겼을 때 **ALTER를 먼저 죽인다**는 순서를 공유했는가

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 스키마 변경 중 실제로 터진 문제와 대응
- 테이블 규모와 소요 시간

{% endcomment %}
