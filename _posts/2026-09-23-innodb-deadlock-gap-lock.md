---
layout: post
title: "같은 행을 건드리지도 않았는데 데드락 — InnoDB 락 읽는 법"
date: 2026-09-23
tags: [mysql, database, backend, sql, typescript]
excerpt: "데드락은 두 트랜잭션이 같은 행을 반대 순서로 잡을 때만 나는 게 아닙니다. 인덱스 레코드와 갭 락이 실제로 무엇을 잠그는지, 데드락 로그에서 범인을 찾는 법, 그리고 1213과 1205를 다르게 다뤄야 하는 이유."
---

배치가 밤마다 `Deadlock found when trying to get lock`으로 죽습니다.
코드를 보면 두 배치가 같은 행을 건드리는 구간이 없습니다. 심지어 아직 존재하지도 않는 행을 INSERT 하다가 서로 막히기도 합니다.

InnoDB가 잠그는 대상이 "행"이 아니라 **인덱스 레코드와 그 사이의 틈**이라서 생기는 일입니다.
이 구분을 하고 나면 데드락 로그가 읽히기 시작합니다.

## 데드락은 고장이 아니다

InnoDB는 락 대기 그래프에서 순환이 생기면 곧바로 감지하고 한쪽을 희생시킵니다. 되돌린 양이 적은 쪽이 대개 희생자가 됩니다.
그래서 데드락이 났다는 건 DB가 제 일을 했다는 뜻이고, **처리해야 하는 쪽은 애플리케이션**입니다.

문제는 자주 같이 묶이는 두 에러가 성격이 전혀 다르다는 점입니다.

| | 1213 `ER_LOCK_DEADLOCK` | 1205 `ER_LOCK_WAIT_TIMEOUT` |
| --- | --- | --- |
| 원인 | 대기 순환 감지 | 락을 기다리다 제한 시간 초과 |
| 롤백 범위 | **트랜잭션 전체** | **실패한 문장만** |
| 감지 시점 | 즉시 | 대기 시간이 다 지난 뒤 |

1205가 위험한 이유가 여기 있습니다. 문장 하나만 실패하고 **트랜잭션은 아직 열려 있는 채로 살아 있습니다.**
이걸 모르고 실패한 문장만 다시 실행하면, 앞서 성공한 문장들이 그대로 남은 상태에서 이어 붙게 됩니다. 절반만 적용된 트랜잭션이 커밋되는 경로입니다.

> 롤백 범위는 `innodb_rollback_on_timeout` 설정에 따라 달라집니다. 현재 값을 확인하고, 애플리케이션에서는 **어느 쪽이든 명시적으로 `ROLLBACK`을 부른 뒤** 재시도하도록 짜는 편이 안전합니다.
> 락 대기 제한 시간(`innodb_lock_wait_timeout`)의 기본값도 버전과 환경에 따라 다르니 직접 조회해서 확인하세요.

```sql
SELECT @@innodb_lock_wait_timeout, @@innodb_rollback_on_timeout, @@transaction_isolation;
```

## 잠기는 건 행이 아니라 인덱스 레코드다

InnoDB의 행 락은 **인덱스 레코드에** 걸립니다. 테이블 어딘가에 있는 튜플에 도장을 찍는 게 아닙니다.

여기서 바로 따라오는 결론이 하나 있습니다. 쓸 인덱스가 없으면 스캔한 레코드 전부가 잠깁니다.

```sql
-- status 에 인덱스가 없다면
UPDATE orders SET status = 'settled' WHERE status = 'pending';
```

조건에 맞는 행이 열 건이어도, 옵티마이저가 풀 스캔을 골랐다면 **훑고 지나간 모든 레코드**에 락이 걸립니다.
조건에 맞지 않아 풀리는 락도 있지만 그건 격리 수준에 따라 다르고, REPEATABLE READ에서는 상당수가 트랜잭션 끝까지 남습니다.

그래서 데드락 조사에서 제일 먼저 볼 것은 락 순서가 아니라 **실행 계획**입니다.

```sql
EXPLAIN UPDATE orders SET status = 'settled' WHERE status = 'pending';
```

`type: ALL`이거나 `rows`가 실제 대상보다 훨씬 크면, 그 문장은 자기가 건드릴 생각이 없던 행까지 붙들고 있는 중입니다.
인덱스 하나 추가해서 사라지는 데드락이 생각보다 많습니다.

## 갭 락 — 없는 행도 잠근다

REPEATABLE READ에서 InnoDB는 레코드만 잠그지 않고 **레코드 앞의 빈 구간**도 같이 잠급니다. 이 둘을 합친 걸 넥스트 키 락이라고 부릅니다.
팬텀 읽기를 막기 위한 장치입니다. 내가 읽은 범위에 남이 새 행을 끼워 넣지 못하게 막아야 하니까요.

`id`가 10, 20, 30인 테이블을 생각해 봅니다.

```sql
SELECT * FROM orders WHERE id BETWEEN 10 AND 20 FOR UPDATE;
```

이 문장은 10과 20이라는 레코드뿐 아니라 **11부터 19까지의 존재하지 않는 구간**도 잠급니다.
다른 트랜잭션이 `id = 15`를 INSERT 하려 하면 거기서 멈춥니다. 충돌하는 행이 없는데도 막힙니다.

INSERT는 삽입 의도 락(insert intention)이라는 걸 먼저 잡는데, 이게 **남이 잡고 있는 갭 락과 충돌**합니다.
두 트랜잭션이 각자 다른 값을 넣으려다 서로의 갭을 기다리면 그대로 순환이 됩니다. "같은 행을 건드린 적 없는데 데드락"의 대표적인 모양이 이것입니다.

유니크 인덱스도 같은 함정을 가지고 있습니다.

```sql
-- 두 트랜잭션이 같은 값을 넣으려 할 때
INSERT INTO idempotency_keys (key_hash, request_id) VALUES ('abc...', 1001);
```

중복으로 실패한 INSERT도 조용히 넘어가지 않습니다. 중복을 확인하는 과정에서 그 레코드에 공유 락을 잡고, **실패한 뒤에도 트랜잭션이 끝날 때까지 그 락을 들고 있습니다.**
`INSERT ... ON DUPLICATE KEY UPDATE`나 `REPLACE`도 같은 이유로 데드락 신고가 잦은 문장입니다.

외래 키도 한 줄 적어둡니다. 자식 행을 INSERT 하면 InnoDB가 부모 행이 있는지 확인하면서 **부모 레코드에 공유 락**을 겁니다.
부모를 UPDATE 하는 트랜잭션과 자식을 INSERT 하는 트랜잭션이 엇갈리면, 코드상으로는 다른 테이블을 만지는데도 데드락이 납니다.

## 데드락 로그 읽는 법

가장 최근 한 건은 언제든 꺼내 볼 수 있습니다.

```sql
SHOW ENGINE INNODB STATUS\G
```

출력에서 `LATEST DETECTED DEADLOCK` 섹션만 보면 됩니다. 다만 이름 그대로 **가장 최근 한 건만** 남고 다음 데드락이 덮어씁니다.
새벽에 난 데드락을 아침에 보려면 전부 에러 로그로 남기는 설정을 켜둬야 합니다.

```sql
SET GLOBAL innodb_print_all_deadlocks = ON;
```

관리형 DB라면 세션에서 바꾸는 대신 파라미터 그룹에서 켭니다. RDS는 이 값이 동적 파라미터라 재부팅 없이 반영되고, 데드락은 그다음부터 에러 로그에 쌓입니다.

로그는 대략 이런 모양입니다.

```text
*** (1) TRANSACTION:
TRANSACTION 84219, ACTIVE 0 sec starting index read
mysql tables in use 1, locked 1
LOCK WAIT 3 lock struct(s), heap size 1136, 2 row lock(s)
UPDATE orders SET status = 'settled' WHERE id = 2450

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 142 page no 51 index PRIMARY of table `shop`.`orders`
trx id 84219 lock_mode X locks rec but not gap

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 142 page no 51 index PRIMARY of table `shop`.`orders`
trx id 84219 lock_mode X locks rec but not gap waiting

*** (2) TRANSACTION:
...
*** WE ROLL BACK TRANSACTION (1)
```

볼 자리는 네 군데입니다.

- **`HOLDS THE LOCK(S)`** — 이미 쥐고 있는 것. 여기 찍힌 인덱스 이름이 락 경로를 알려줍니다.
- **`WAITING FOR`** — 기다리는 것. 1번이 기다리는 락을 2번이 들고 있고, 그 반대도 성립하면 순환입니다.
- **`index ...`** — `PRIMARY`가 아니라 보조 인덱스 이름이 찍혔다면, 그 인덱스를 타고 들어가다 잠긴 것입니다.
- **`lock_mode`** — 무엇을 잠갔는지.

락 모드 표기는 이렇게 읽습니다.

| 표기 | 잠근 것 |
| --- | --- |
| `lock_mode X locks rec but not gap` | 레코드만 |
| `lock_mode X locks gap before rec` | 앞의 빈 구간만 |
| `lock_mode X` (뒤에 수식 없음) | 레코드 + 앞 구간 (넥스트 키) |
| `lock_mode X insert intention waiting` | 삽입하려다 남의 갭 락에 막힘 |
| `lock mode S` | 공유 락 — 외래 키 확인, 중복 키 확인 |

`insert intention waiting`이 보이면 갭 락 문제입니다. 락 순서를 아무리 맞춰도 안 풀립니다.
로그에 찍힌 문장만 보고 "이 UPDATE가 범인"이라고 단정하지 않는 것도 중요합니다. **표시되는 건 마지막 문장 하나**고, 락은 그 앞의 문장들이 잡아둔 경우가 많습니다.

진행 중인 대기를 실시간으로 보려면 MySQL 8.0의 `performance_schema`를 씁니다.

```sql
SELECT
  r.trx_id             AS waiting_trx,
  r.trx_mysql_thread_id AS waiting_thread,
  r.trx_query          AS waiting_query,
  b.trx_id             AS blocking_trx,
  b.trx_query          AS blocking_query
FROM performance_schema.data_lock_waits w
JOIN information_schema.innodb_trx r ON r.trx_id = w.REQUESTING_ENGINE_TRANSACTION_ID
JOIN information_schema.innodb_trx b ON b.trx_id = w.BLOCKING_ENGINE_TRANSACTION_ID;
```

어떤 락이 무슨 값에 걸려 있는지는 `data_locks`에서 봅니다. `LOCK_DATA`에 실제 키 값이 찍히는 게 이 뷰의 가장 큰 쓸모입니다.

```sql
SELECT OBJECT_NAME, INDEX_NAME, LOCK_TYPE, LOCK_MODE, LOCK_STATUS, LOCK_DATA
FROM performance_schema.data_locks
WHERE OBJECT_SCHEMA = 'shop';
```

`sys.innodb_lock_waits` 뷰를 쓰면 위 조인을 직접 쓰지 않아도 되고, 블로킹 스레드를 끊을 `KILL` 문까지 만들어줍니다.

{% comment %} TODO: 실제로 조사했던 데드락 로그가 있다면, 어떤 lock_mode가 찍혔고 어느 문장이 범인이었는지 한 건만 붙여주세요 {% endcomment %}

## 락 순서를 맞추는 쪽

갭 락과 무관한, 교과서적인 순환도 여전히 흔합니다. 두 트랜잭션이 같은 두 행을 반대 순서로 잡는 경우입니다.

```sql
-- 트랜잭션 A
UPDATE accounts SET balance = balance - 1000 WHERE id = 1;
UPDATE accounts SET balance = balance + 1000 WHERE id = 2;

-- 트랜잭션 B (동시에)
UPDATE accounts SET balance = balance - 500 WHERE id = 2;
UPDATE accounts SET balance = balance + 500 WHERE id = 1;
```

해법은 **잠그는 순서를 전역으로 하나 정하는 것**입니다. 업무 순서가 어떻든, 락은 항상 같은 기준(대개 기본 키 오름차순)으로 먼저 잡습니다.

```typescript
// 출금/입금 순서와 무관하게, 항상 작은 id 부터 잠근다
const ids = [fromId, toId].sort((a, b) => a - b);
for (const id of ids) {
  await conn.query('SELECT id FROM accounts WHERE id = ? FOR UPDATE', [id]);
}
// 이 시점부터는 두 행 모두 내 것이다
await conn.query('UPDATE accounts SET balance = balance - ? WHERE id = ?', [amount, fromId]);
await conn.query('UPDATE accounts SET balance = balance + ? WHERE id = ?', [amount, toId]);
```

한 문장에 `IN (...)`으로 몰아넣고 `ORDER BY`를 붙이는 방법도 쓰이지만, 그때의 잠금 순서는 옵티마이저가 고른 접근 경로를 따릅니다.
확실하게 하려면 위처럼 **정렬된 순서로 문장을 나눠 잠그는 쪽**이 읽기도 쉽고 보장도 분명합니다.

같은 원리가 배치에도 적용됩니다. 한 배치는 `ORDER BY created_at`으로 순회하고 다른 배치는 `WHERE id = ?`로 단건 처리한다면, 두 순회 순서는 언제든 엇갈립니다.
같은 테이블을 여러 경로로 갱신한다면 순회 기준을 하나로 맞춰두세요.

## 격리 수준을 내리는 선택

갭 락이 원인이라면 READ COMMITTED가 꽤 직접적인 답입니다. 이 수준에서는 갭 락을 대부분 쓰지 않고, 조건에 맞지 않는 레코드의 락도 문장이 끝나면서 풀립니다.

대신 내주는 것이 있습니다.

- 같은 트랜잭션 안에서 같은 쿼리를 두 번 실행하면 **결과가 달라질 수 있습니다.** 읽고 판단한 뒤 쓰는 코드는 전제가 흔들립니다.
- 범위를 읽고 그 범위에 아무도 끼어들지 않았다고 가정하는 로직은 성립하지 않습니다. 필요하면 유니크 제약으로 따로 막아야 합니다.
- 복제 안전성 때문에 로우 기반 바이너리 로그가 전제입니다. 문장 기반이면 복제가 어긋날 수 있습니다.

전역으로 바꾸기 부담스럽다면 문제가 나는 트랜잭션에서만 내릴 수 있습니다.

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
START TRANSACTION;
-- ...
COMMIT;
```

다만 커넥션 풀을 쓴다면 세션 설정이 다음 사용자에게 그대로 넘어갑니다. 풀에 반환하기 전에 되돌리거나, 아예 격리 수준이 다른 별도 풀을 두는 편이 사고가 적습니다.

격리 수준을 건드리기 전에 먼저 해볼 것이 있다는 점도 적어둡니다. **트랜잭션을 짧게 만드는 것**입니다.
락을 쥔 채 외부 API를 호출하거나, 파일을 쓰거나, 사용자 입력을 기다리는 구간이 트랜잭션 안에 들어 있으면 그 시간만큼 충돌 확률이 커집니다.
읽기만 하는 조회를 트랜잭션 앞쪽으로 빼고, 잠그는 구간을 뒤로 몰아 짧게 끝내는 것만으로 줄어드는 데드락이 많습니다.

## 그래도 재시도는 필요하다

동시 쓰기가 있는 한 데드락을 0으로 만들 수는 없습니다. 줄이는 작업과 별개로, **1213은 재시도로 흡수한다**는 전제를 두고 짜는 게 맞습니다.

```typescript
const DEADLOCK = 1213;       // ER_LOCK_DEADLOCK
const LOCK_TIMEOUT = 1205;   // ER_LOCK_WAIT_TIMEOUT

async function runInTx<T>(
  pool: Pool,
  fn: (conn: PoolConnection) => Promise<T>,
  maxAttempts = 3,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      // 1205 는 문장만 롤백됐을 수 있다. 어느 쪽이든 명시적으로 되돌린다.
      await conn.rollback().catch(() => undefined);

      const errno = (err as { errno?: number }).errno;
      if ((errno === DEADLOCK || errno === LOCK_TIMEOUT) && attempt < maxAttempts) {
        const base = 50 * 2 ** (attempt - 1);
        await sleep(base + Math.random() * base);   // 지터 없으면 같이 몰려와 또 부딪힌다
        continue;
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}
```

세 가지만 지키면 됩니다.

**재시도 단위는 문장이 아니라 트랜잭션 전체입니다.** 1213은 이미 전부 롤백된 상태이고, 1205는 반쪽이 남아 있을 수 있습니다. 둘 다 처음부터 다시 하는 게 유일하게 안전한 선택입니다.

**콜백 안에 외부 부수효과를 넣지 않습니다.** 재시도되면 그 안의 결제 요청도, 메일 발송도 두 번 일어납니다. 트랜잭션 밖으로 빼거나, 아웃박스에 적어두고 커밋 뒤에 내보냅니다.

**지터를 넣습니다.** 같은 시각에 충돌한 트랜잭션들이 같은 간격으로 깨어나면 같은 자리에서 다시 부딪힙니다.

재시도 횟수는 넉넉히 잡을 필요가 없습니다. 몇 번을 더 해도 계속 실패한다면 그건 일시적 경쟁이 아니라 구조적 충돌이고, 재시도가 아니라 락 경로를 고쳐야 하는 신호입니다.
그래서 **재시도 횟수와 데드락 발생 건수는 지표로 뽑아두는 편**이 좋습니다. 조용히 흡수되기만 하면 언제 늘었는지 아무도 모릅니다.

{% comment %} TODO: 운영에서 데드락을 어떤 지표로 보고 있는지(에러 로그 알림, Prometheus 메트릭 등) 방식이 있다면 적어주세요 {% endcomment %}

## 정리

데드락 조사는 순서가 정해져 있습니다.

1. `EXPLAIN`으로 **잠글 필요가 없는 행까지 잠그고 있는지** 본다. 인덱스로 끝나는 경우가 제일 많다.
2. 데드락 로그의 `lock_mode`를 읽는다. `insert intention`이나 `gap before rec`가 보이면 갭 락 문제고, 락 순서를 맞춰도 풀리지 않는다.
3. 같은 행을 여러 경로로 갱신한다면 **잠그는 순서를 하나로 통일**한다.
4. 트랜잭션에서 잠글 필요 없는 구간을 밖으로 뺀다.
5. 남는 건 재시도로 흡수하되, 건수는 지표로 남긴다.

갭 락은 없애야 할 결함이 아니라 REPEATABLE READ가 팬텀을 막기 위해 치르는 비용입니다.
READ COMMITTED로 내리는 건 그 비용을 안 내는 대신 일관성 보장을 덜 받겠다는 선택이고, 어느 쪽이 맞는지는 그 트랜잭션이 무엇을 전제로 쓰였는지에 달려 있습니다.
