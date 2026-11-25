---
layout: post
title: "접수번호가 7번에서 9번으로 건너뛴다 — AUTO_INCREMENT의 빈 번호와 연속 채번"
date: 2026-11-26
tags: [mysql, database, backend, typescript, sql]
excerpt: "AUTO_INCREMENT 값이 롤백·중복 키·대량 삽입·재시작에서 비는 이유, 화면에 보이는 번호를 기본키와 분리해야 하는 까닭, 카운터 테이블로 범위별 연속 번호를 발급하는 코드와 그 대가인 직렬화, 번호 배정을 짧은 트랜잭션으로 떼어내는 방법, 취소된 번호를 지우지 않고 남기는 설계."
---

목록에 `7`, `8`, `10`이 보이면 사용자는 9번이 어디 갔냐고 묻습니다. 개발자는 "DB가 원래 그래요"라고 답하고 싶지만, 그 번호가 접수번호나 문서번호처럼 업무에 쓰이는 값이라면 그 답은 통하지 않습니다.
자동 증가 키는 **유일하고 대체로 커지는 값**을 약속할 뿐, 빈틈없이 이어지는 값을 약속하지 않습니다. 둘을 같은 컬럼에 맡기는 순간 문제가 시작됩니다.

## AUTO_INCREMENT는 왜 비는가

InnoDB는 동시에 들어오는 삽입이 서로 기다리지 않도록, 자동 증가 값을 **트랜잭션과 상관없이** 먼저 나눠줍니다. 한 번 나간 값은 돌려받지 않습니다.
그래서 아래 상황마다 번호가 하나 이상 비게 됩니다.

### 롤백

```sql
BEGIN;
INSERT INTO applications (child_name) VALUES ('김하늘');  -- id 9 배정
ROLLBACK;                                                  -- 9는 돌아오지 않는다

INSERT INTO applications (child_name) VALUES ('이바다');  -- id 10
```

트랜잭션 안에서 검증이 실패해 롤백하거나, 애플리케이션이 예외로 트랜잭션을 버리는 흔한 경로가 전부 여기에 해당합니다.
[DB 테스트 격리 글](/blog/db-integration-test-isolation/)에서 "롤백해도 카운터는 전진한다"고 적었던 것과 같은 성질입니다.

### 중복 키

`INSERT ... ON DUPLICATE KEY UPDATE`나 `INSERT IGNORE`는 실제로 행이 추가되지 않아도 값을 소비할 수 있습니다.
삽입을 시도하는 시점에 값이 먼저 배정되고, 그다음에야 중복이 판정되기 때문입니다. 업서트가 잦은 테이블에서 id가 빠르게 커지는 이유가 대개 이것입니다.

### 행 수를 모르는 대량 삽입

`INSERT ... SELECT`나 `LOAD DATA`처럼 몇 행이 들어갈지 미리 모르는 문장은, InnoDB가 값을 묶음으로 미리 잡아둡니다.
다 쓰지 못한 나머지는 버려지므로 **문장과 문장 사이에 틈**이 생깁니다.

> MySQL 8.0부터 `innodb_autoinc_lock_mode`의 기본값은 `2`(interleaved)입니다. 이 모드에서는 동시에 실행되는 대량 삽입끼리 값이 섞여 배정될 수도 있습니다.
> 모드별 동작은 MySQL 문서의 "AUTO_INCREMENT Handling in InnoDB"를 확인하세요.

### 재시작 — 비는 게 아니라 되살아나는 경우

MySQL 5.7까지는 서버를 재시작하면 카운터를 `MAX(id) + 1`로 다시 계산했습니다. 마지막 몇 행을 지운 뒤 재시작하면, **지운 행의 번호가 다시 발급**됩니다.
8.0부터는 카운터가 재시작 후에도 유지되어 이 문제가 없지만, 오래된 버전을 운영 중이라면 번호 재사용이 빈 번호보다 더 위험합니다. 외부에 이미 알려준 번호가 다른 데이터를 가리키게 되니까요.

## 번호를 고치기 전에 — 기본키와 표시 번호를 분리한다

가장 먼저 할 일은 자동 증가 키를 화면에서 치우는 것입니다. 기본키는 지금처럼 빈틈이 있어도 되는 내부 식별자로 두고, 사람이 보는 번호는 **별도 컬럼**으로 만듭니다.

```sql
CREATE TABLE applications (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tenant_id   BIGINT UNSIGNED NOT NULL,
  doc_no      VARCHAR(20)     NULL,          -- 사람이 보는 번호. 배정 전에는 NULL
  status      VARCHAR(16)     NOT NULL DEFAULT 'SUBMITTED',
  child_name  VARCHAR(50)     NOT NULL,
  created_at  DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_tenant_doc_no (tenant_id, doc_no)
);
```

분리하면 얻는 것이 몇 가지 더 있습니다.

- 번호 체계를 바꿔도(연도별 초기화, 접두어 추가) 기본키와 외래키는 그대로입니다.
- 기관마다 1번부터 시작하는 번호를 줄 수 있습니다. 전역 자동 증가 값으로는 불가능합니다.
- 외부에 연속된 내부 id를 노출하지 않게 됩니다. 순번 id는 전체 건수와 증가 속도를 드러내고, 다른 사람 리소스를 짐작하게 만듭니다. 이 부분은 [UUID 기본키 글](/blog/uuid-primary-key-innodb-clustered-index/)에서 따로 다뤘습니다.

`UNIQUE KEY`는 발급 로직에 버그가 있을 때 중복 번호가 저장되는 것을 막는 마지막 안전망입니다. `NULL`은 유니크 비교에서 서로 다른 값으로 취급되므로 배정 전 행이 여럿 있어도 괜찮습니다.

## 카운터 테이블로 연속 번호 발급하기

빈틈없는 번호를 주려면 "다음 번호"를 **업무 데이터와 같은 트랜잭션 안에서** 가져와야 합니다. 트랜잭션이 롤백되면 번호 증가도 같이 롤백되어야 하니까요.
범위(기관, 날짜, 문서 종류)마다 마지막으로 발급한 값을 행 하나에 둡니다.

```sql
CREATE TABLE doc_counters (
  tenant_id   BIGINT UNSIGNED NOT NULL,
  scope       VARCHAR(32)     NOT NULL,   -- 예: 'APP:2026-11-26'
  last_value  INT UNSIGNED    NOT NULL,
  PRIMARY KEY (tenant_id, scope)
);
```

발급은 두 문장입니다. 행이 없으면 1로 만들고, 있으면 1 올립니다. 그리고 방금 올린 값을 같은 트랜잭션에서 읽습니다.

```typescript
import type { PoolConnection, RowDataPacket } from "mysql2/promise";

export async function nextNumber(
  conn: PoolConnection,       // 반드시 호출자의 트랜잭션 안에 있는 커넥션
  tenantId: number,
  scope: string,
): Promise<number> {
  await conn.execute(
    `INSERT INTO doc_counters (tenant_id, scope, last_value)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE last_value = last_value + 1`,
    [tenantId, scope],
  );

  const [rows] = await conn.execute<RowDataPacket[]>(
    `SELECT last_value FROM doc_counters WHERE tenant_id = ? AND scope = ?`,
    [tenantId, scope],
  );
  return rows[0].last_value as number;
}
```

첫 문장이 카운터 행에 배타 락을 잡고, 그 락은 **커밋이나 롤백까지** 유지됩니다. 그 사이 같은 범위의 다른 요청은 첫 문장에서 기다립니다.
두 번째 `SELECT`는 잠금 없는 일반 조회지만, InnoDB는 트랜잭션이 직접 바꾼 행은 스냅샷과 관계없이 자기 변경분을 보여주므로 방금 올린 값이 읽힙니다.

> `SELECT ... FOR UPDATE`로 먼저 읽고 `UPDATE`하는 순서도 가능합니다. 다만 행이 아직 없을 때의 처리가 따로 필요해서, 위처럼 업서트로 시작하는 편이 짧습니다.

호출하는 쪽은 업무 삽입과 번호 발급을 한 트랜잭션으로 묶습니다.

```typescript
export async function submitApplication(pool: Pool, input: { tenantId: number; childName: string }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute<ResultSetHeader>(
      `INSERT INTO applications (tenant_id, child_name) VALUES (?, ?)`,
      [input.tenantId, input.childName],
    );

    // 검증·부가 작업을 모두 끝낸 뒤, 커밋 직전에 번호를 받는다
    const day = kstDate(new Date());
    const n = await nextNumber(conn, input.tenantId, `APP:${day}`);
    const docNo = `${day.replaceAll("-", "")}-${String(n).padStart(4, "0")}`;

    await conn.execute(`UPDATE applications SET doc_no = ? WHERE id = ?`, [docNo, result.insertId]);
    await conn.commit();
    return { id: result.insertId, docNo };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
```

`Pool`과 `ResultSetHeader`도 `mysql2/promise`에서 가져옵니다. 날짜 범위는 서버 타임존이 아니라 **업무 기준 시간대**로 잘라야 합니다. UTC로 자르면 오전 9시 전 접수가 전날 번호를 받습니다.

```typescript
export function kstDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
```

하루 경계가 어긋나는 문제는 [타임존 글](/blog/timezone-datetime-day-boundary/)에 자세히 적어두었습니다.

## 대가 — 같은 범위의 발급은 한 줄로 선다

이 방식이 빈틈을 막는 원리가 곧 비용입니다. 카운터 행 락은 트랜잭션이 끝날 때까지 풀리지 않으므로, **같은 범위의 트랜잭션은 순서대로 하나씩만** 진행됩니다.
처리량의 상한은 대략 "1초 ÷ 락을 잡은 뒤 커밋까지 걸리는 시간"입니다. 그래서 위 코드는 번호를 **커밋 직전에** 받습니다.

락을 오래 붙드는 실수는 대개 이런 모양입니다.

- 번호를 트랜잭션 맨 앞에서 받고, 그 뒤에 외부 API 호출이나 파일 업로드를 한다
- 번호를 받은 트랜잭션 안에서 큰 배치를 돌린다
- 범위를 전역 하나로 둔다 — 모든 기관이 같은 행 하나를 두고 줄을 선다

범위를 기관별·날짜별로 쪼개면 경합하는 요청 자체가 줄어듭니다. 번호가 "기관 안에서" 연속이면 충분한 경우가 대부분이라, 이건 요구사항과도 잘 맞습니다.

락 대기가 길어지면 `innodb_lock_wait_timeout`에 걸려 오류가 납니다. 새 범위의 첫 행을 여러 트랜잭션이 동시에 만들려 할 때는 데드락으로 끝나는 경우도 있습니다.
두 경우 모두 **트랜잭션 전체를 처음부터** 다시 시도하는 것이 맞습니다. 이미 롤백됐으니 번호는 비지 않습니다.

```typescript
const RETRYABLE = new Set(["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT"]);

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err: any) {
      if (!RETRYABLE.has(err?.code) || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 20 * i + Math.random() * 30));
    }
  }
}
```

재시도 자체가 부하를 키우는 상황은 [재시도와 타임아웃 예산 글](/blog/retry-timeout-budget-circuit-breaker/)의 내용이 그대로 적용됩니다. 횟수는 작게 둡니다.

## 번호 배정을 떼어내기

업무 트랜잭션이 길어서 번호를 커밋 직전에 받아도 락이 오래 잡힌다면, 저장과 번호 배정을 **두 개의 트랜잭션으로** 나눕니다.

1. 업무 데이터를 `doc_no = NULL`로 저장하고 커밋합니다. 오래 걸려도 카운터와 무관합니다.
2. 짧은 별도 트랜잭션에서 번호를 받고 `doc_no`를 채웁니다.

```typescript
export async function assignNumber(pool: Pool, id: number, tenantId: number, day: string) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute<RowDataPacket[]>(
      `SELECT doc_no FROM applications WHERE id = ? FOR UPDATE`,
      [id],
    );
    if (rows[0]?.doc_no) {           // 이미 배정됨 — 재시도로 두 번 불려도 안전
      await conn.commit();
      return rows[0].doc_no as string;
    }
    const n = await nextNumber(conn, tenantId, `APP:${day}`);
    const docNo = `${day.replaceAll("-", "")}-${String(n).padStart(4, "0")}`;
    await conn.execute(`UPDATE applications SET doc_no = ? WHERE id = ?`, [docNo, id]);
    await conn.commit();
    return docNo;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
```

번호 증가와 `doc_no` 기록이 한 트랜잭션이라, 2단계가 실패하면 번호도 소비되지 않습니다. 빈틈없음은 그대로 지켜집니다.
대신 **번호가 없는 시간**이 생깁니다. 화면에 "번호 발급 중"을 보여줄지, 2단계를 큐 워커가 맡을지, 실패한 행을 주기적으로 찾아 다시 배정할지 정해야 합니다.

`day`를 1단계에서 정해 넘기는 이유는, 2단계가 자정을 넘겨 실행될 때 접수일과 번호의 날짜가 달라지지 않게 하기 위해서입니다.
배정 순서와 접수 순서가 정확히 같아야 한다는 요구라면, 2단계를 범위별로 한 워커가 `id` 순서대로 처리하게 해야 합니다.

## 취소된 번호는 지우지 않는다

여기까지 해도 빈 번호는 생깁니다. 접수 후에 취소되는 건이 있기 때문입니다. 이건 막아야 할 틈이 아니라 **설명할 수 있어야 하는** 틈입니다.

그래서 연속 번호가 필요한 문서는 삭제하지 않고 상태만 바꿉니다. 번호는 행과 함께 남고, 목록에서는 "취소"로 보입니다.

```sql
UPDATE applications
SET status = 'CANCELLED'
WHERE id = ? AND status = 'SUBMITTED';
```

"번호에 빈틈이 없다"는 요구를 정확히 풀면, 대개 **모든 번호의 행방을 설명할 수 있다**는 뜻입니다. 1번부터 마지막 번호까지 각각이 유효한 문서이거나 취소된 문서이면 됩니다.
이렇게 읽으면 카운터 테이블이 필요한지부터 다시 판단할 수 있습니다. 소프트 삭제가 유니크 제약과 부딪히는 부분은 [소프트 삭제 글](/blog/soft-delete-unique-constraint/)에 정리했습니다.

{% comment %} TODO: 실제 서비스에서 연속 번호가 필요했던 문서 종류나 요구 배경이 있다면 적어주세요 {% endcomment %}

## 동시성 테스트

이 코드의 버그는 한 명이 쓸 때는 드러나지 않습니다. 같은 범위로 동시에 수십 번 발급하고, 결과가 정확히 `1..N`인지 확인하는 테스트를 하나 둡니다.

```typescript
it("동시에 발급해도 번호가 비거나 겹치지 않는다", async () => {
  const N = 50;
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_, i) =>
      withRetry(() => submitApplication(pool, { tenantId: 1, childName: `아이${i}` })),
    ),
  );

  const docNos = results
    .filter((r): r is PromiseFulfilledResult<{ id: number; docNo: string }> => r.status === "fulfilled")
    .map((r) => Number(r.value.docNo.split("-")[1]))
    .sort((a, b) => a - b);

  expect(docNos).toEqual(Array.from({ length: N }, (_, i) => i + 1));
});
```

커넥션 풀 크기를 `N`보다 작게 두면 일부 요청은 풀에서 기다리므로, 락 경합을 제대로 보려면 풀 크기도 함께 조정합니다. 실제 DB로 테스트를 돌리는 방법은 [테스트 격리 글](/blog/db-integration-test-isolation/)을 참고하세요.

> PostgreSQL의 시퀀스도 같은 이유로 빈틈 없는 번호를 보장하지 않습니다. `nextval()`은 롤백되지 않고, `CACHE`를 크게 잡으면 세션마다 값을 미리 가져가 순서도 섞입니다.
> 연속 번호가 필요하다면 PostgreSQL에서도 위와 같은 카운터 테이블 방식을 씁니다.

## 정리

| 요구사항 | 방식 | 대가 |
| --- | --- | --- |
| 유일하기만 하면 됨 | `AUTO_INCREMENT` 그대로 | 없음. 빈 번호는 정상 |
| 사람이 보는 번호, 빈틈 허용 | 별도 컬럼 + 범위별 카운터(트랜잭션 밖) | 번호 체계 관리 |
| 빈틈 없는 번호 | 카운터를 업무 트랜잭션 안에서, 커밋 직전에 | 범위별 직렬화 |
| 빈틈 없음 + 긴 업무 트랜잭션 | 저장 후 짧은 트랜잭션으로 배정 | 번호 없는 시간, 재배정 처리 |

- 자동 증가 키의 빈 번호는 버그가 아니라 동시성을 위해 선택된 동작입니다. 화면에 내보내지 않는 것이 첫 번째 해결입니다.
- 연속 번호는 공짜가 아닙니다. 범위를 좁게 쪼개고 락을 늦게 잡아 그 비용을 줄입니다.
- 취소는 삭제가 아니라 상태 변경으로 처리해, 모든 번호의 행방을 설명할 수 있게 둡니다.

"9번은 어디 갔나요"라는 질문에는 두 가지 정답이 있습니다. 애초에 9번을 보여주지 않거나, 9번이 취소된 접수라고 보여주는 것입니다.
어느 쪽이든 그 결정은 테이블을 만들 때 하는 편이 운영 중에 하는 것보다 훨씬 쌉니다.
