---
layout: post
title: "DB는 커밋됐는데 이벤트는 안 나갔다 — 트랜잭셔널 아웃박스"
date: 2026-09-16
tags: [backend, architecture, mysql, typescript]
excerpt: "DB 쓰기와 메시지 발행은 한 트랜잭션에 묶이지 않습니다. 이중 쓰기가 어느 순서로도 새는 이유, 아웃박스 테이블과 릴레이 구현(SKIP LOCKED 폴링 vs CDC), 그리고 최소 한 번 전달에서 소비자가 져야 하는 몫."
---

주문은 테이블에 멀쩡히 들어가 있는데, 그 주문으로 나갔어야 할 알림이 어디에도 없습니다.
코드를 열어보면 `INSERT` 바로 다음 줄에 `publish()`가 그대로 있습니다.

두 줄 사이에서 프로세스가 죽었거나, 브로커가 하필 그 순간 응답하지 않았을 뿐입니다.
DB와 브로커는 같은 트랜잭션에 들어오지 않고, 그래서 이 경로는 트래픽이 쌓이면 언젠가 반드시 어긋납니다.

## 이중 쓰기는 어느 순서로 해도 샌다

저장소 두 곳에 쓰는 코드는 순서가 두 가지뿐이고, 둘 다 실패 모드가 있습니다.

```typescript
// (1) DB 먼저
await db.transaction(async (tx) => {
  await tx.insert(orders).values(order);
});
await broker.publish("order.created", order);  // 여기서 죽으면 이벤트가 사라진다

// (2) 브로커 먼저
await broker.publish("order.created", order);
await db.transaction(async (tx) => {
  await tx.insert(orders).values(order);       // 여기서 롤백되면 유령 이벤트가 남는다
});
```

| 순서 | 중간에 끊기면 | 남는 상태 |
| --- | --- | --- |
| DB → 브로커 | 커밋은 끝났고 발행만 안 됨 | 이벤트 유실. 소비자는 그 일이 일어난 줄도 모른다 |
| 브로커 → DB | 발행은 끝났고 커밋이 롤백됨 | 유령 이벤트. 소비자가 조회하면 주문이 없다 |

`publish()`를 트랜잭션 **안쪽**으로 옮기는 변형도 자주 보이는데, 이건 더 나쁩니다.
커밋 전에 이벤트가 나가면 소비자는 아직 다른 세션에서 보이지 않는 행을 조회하러 오고, 롤백되면 그 행은 영영 생기지 않습니다.

분산 트랜잭션(2PC/XA)이 교과서적인 답이지만 실무에서 선택지에 오르는 일은 드뭅니다.
브로커와 드라이버가 모두 지원해야 하고, 코디네이터가 죽으면 **in-doubt 상태의 트랜잭션이 DB 락을 붙든 채로 남습니다.**
장애 하나를 막으려고 더 다루기 어려운 장애를 하나 들이는 거래가 됩니다.

남는 방향은 하나입니다. **원자적이어야 하는 두 쓰기를 한 저장소 안으로 밀어 넣는 것.**

## 아웃박스 테이블

보낼 이벤트를 브로커 대신 **같은 DB의 테이블에** 적습니다. 업무 데이터와 이벤트가 한 트랜잭션에 들어가므로 둘은 같이 커밋되거나 같이 사라집니다.
브로커로 옮기는 일은 별도 프로세스(릴레이)가 나중에 맡습니다.

```sql
CREATE TABLE outbox (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  aggregate_type  VARCHAR(64)  NOT NULL,
  aggregate_id    VARCHAR(64)  NOT NULL,
  event_type      VARCHAR(64)  NOT NULL,
  payload         JSON         NOT NULL,
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  published_at    DATETIME(3)  NULL,
  attempts        INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_pending (published_at, next_attempt_at, id)
) ENGINE=InnoDB;
```

`published_at IS NULL`이 미발행 표시이고, 릴레이는 이 조건으로만 테이블을 훑습니다.
`aggregate_id`는 뒤에서 브로커 파티션 키로 쓰기 위한 것이라 반드시 넣어둡니다.

> PostgreSQL이라면 `CREATE INDEX ... WHERE published_at IS NULL` 부분 인덱스를 쓰는 편이 훨씬 작고 빠릅니다.
> MySQL에는 부분 인덱스가 없어서, 발행 완료 행을 제때 지우는 것이 곧 인덱스 관리가 됩니다.

쓰기 쪽은 이렇게 됩니다. 중요한 건 **같은 트랜잭션 핸들**을 쓰는 것뿐입니다.

```typescript
await db.transaction(async (tx) => {
  const [order] = await tx.insert(orders).values(input).returning();

  await tx.insert(outbox).values({
    aggregateType: "order",
    aggregateId: String(order.id),
    eventType: "order.created",
    payload: {
      eventId: crypto.randomUUID(),
      orderId: order.id,
      userId: order.userId,
      amount: order.amount,        // 이 시점의 값을 그대로 박아 넣는다
      occurredAt: new Date().toISOString(),
    },
  });
});
```

`payload`에 값을 복사해 두는 이유가 있습니다.
릴레이가 발행할 때 `orders`를 다시 조회해서 본문을 만들면, 그 사이 바뀐 값이 실려서 **과거에 일어난 이벤트가 현재 상태를 말하게** 됩니다.
취소된 주문의 생성 이벤트가 취소된 금액을 들고 나가는 식입니다.

ORM을 쓴다면 `tx`가 아니라 전역 커넥션으로 새는 경로가 없는지 한 번 확인하세요.
리포지토리 계층이 자체 커넥션을 잡는 구조라면 아웃박스 삽입만 다른 트랜잭션에서 일어나고, 이 패턴이 통째로 무의미해집니다.

## 릴레이 — 폴링 방식

가장 단순한 릴레이는 미발행 행을 주기적으로 긁어 발행하는 워커입니다.
워커를 여러 대 띄워도 같은 행을 두 번 집지 않게 하는 게 핵심이고, 그 도구가 `SKIP LOCKED`입니다.

```sql
SELECT id, aggregate_id, event_type, payload
FROM outbox
WHERE published_at IS NULL
  AND next_attempt_at <= NOW(3)
ORDER BY id
LIMIT 100
FOR UPDATE SKIP LOCKED;
```

`FOR UPDATE`만 쓰면 뒤에 온 워커가 앞 워커의 배치를 기다리며 줄을 섭니다.
`SKIP LOCKED`는 잠긴 행을 건너뛰고 그다음 것을 집어가므로, 워커 수만큼 처리량이 늘어납니다.

> `SKIP LOCKED`는 MySQL 8.0, PostgreSQL 9.5부터 쓸 수 있습니다.
> 그 이전 버전이라면 워커를 한 대로 두거나, `id % N = <워커 번호>`로 범위를 나눠 경합 자체를 없애는 편이 안전합니다.

워커 한 바퀴는 이런 모양이 됩니다.

```typescript
async function relayOnce(): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute(PICK_PENDING_SQL);   // 위의 SELECT ... SKIP LOCKED
    if (rows.length === 0) return 0;

    for (const row of rows) {
      try {
        await broker.publish(row.event_type, row.payload, {
          key: row.aggregate_id,                        // 파티션 키
          timeout: 3_000,
        });
        await tx.execute(
          sql`UPDATE outbox SET published_at = NOW(3) WHERE id = ${row.id}`,
        );
      } catch (err) {
        const backoffSec = Math.min(2 ** row.attempts, 300);
        await tx.execute(sql`
          UPDATE outbox
             SET attempts = attempts + 1,
                 next_attempt_at = NOW(3) + INTERVAL ${backoffSec} SECOND
           WHERE id = ${row.id}
        `);
      }
    }
    return rows.length;
  });
}
```

여기서 놓치기 쉬운 게 **트랜잭션이 발행하는 동안 계속 열려 있다**는 점입니다.
브로커가 느려지면 그만큼 DB 락을 오래 붙들게 되므로, 발행 타임아웃을 짧게 걸고 배치 크기를 과하게 키우지 않아야 합니다.

폴링 주기도 그냥 고정하면 손해입니다. 한가할 때는 빈 쿼리만 계속 날리고, 바쁠 때는 주기만큼 지연이 붙습니다.

```typescript
let idle = 0;
for (;;) {
  const n = await relayOnce();
  idle = n > 0 ? 0 : Math.min(idle + 1, 10);
  await sleep(n > 0 ? 0 : 100 * idle);   // 건졌으면 곧바로 다음 배치
}
```

## 릴레이 — CDC 방식

다른 방향은 DB의 변경 로그(MySQL 바이너리 로그, PostgreSQL WAL)를 읽는 것입니다.
Debezium 같은 CDC 커넥터가 아웃박스 테이블의 `INSERT`를 감지해 그대로 브로커로 넘깁니다.

| | 폴링 워커 | CDC 커넥터 |
| --- | --- | --- |
| 추가 인프라 | 없음 (앱 프로세스 하나) | 커넥터와 그 운영 부담 |
| DB 부하 | 주기적 조회 쿼리 | 복제 로그 읽기 |
| 지연 | 폴링 주기에 좌우 | 대체로 더 짧음 |
| 디버깅 | 우리 코드라 붙기 쉬움 | 커넥터 내부 상태를 알아야 함 |
| 사전 조건 | 없음 | 복제 권한, 로그 포맷·보존 기간 설정 |

CDC 쪽 사전 조건은 생각보다 걸리는 지점이 많습니다.
복제용 계정 권한이 필요하고, 변경 로그 포맷이 행 단위여야 하며, 보존 기간이 짧으면 커넥터가 며칠 멈춘 사이 읽을 로그가 사라집니다.
정확한 설정 항목은 엔진과 커넥터 버전마다 다르니 해당 공식 문서를 기준으로 잡으세요.

발행 완료 행을 지우는 방식도 달라집니다.
CDC는 `DELETE`도 변경으로 보기 때문에, 정리 배치가 삭제 이벤트를 다시 파이프라인으로 흘려보내지 않도록 커넥터 쪽에서 걸러줘야 합니다.

판단 기준은 단순하게 잡습니다. **팀에 이미 CDC 파이프라인이 돌고 있으면 CDC, 없으면 폴링부터.**
폴링 워커는 하루면 만들고 지표도 직접 뽑을 수 있습니다. 이 패턴을 처음 들이면서 커넥터까지 같이 들이면, 장애 났을 때 의심할 대상이 하나 더 늘어납니다.

{% comment %} TODO: 실제로 어느 방식을 골랐고 왜 그랬는지, 운영하면서 바꾼 게 있다면 이 자리에 적어주세요 {% endcomment %}

## 여전히 "최소 한 번"이다

발행에는 성공했는데 `published_at`을 쓰기 전에 워커가 죽으면, 다음 워커가 같은 행을 다시 집어 발행합니다.
이 창은 구조적으로 닫히지 않습니다. 발행과 표시가 서로 다른 시스템에 일어나는 한, 처음의 이중 쓰기 문제가 작은 크기로 되돌아옵니다.

그래서 아웃박스가 보장하는 건 **유실 없음**이지 **정확히 한 번**이 아닙니다.
중복 제거는 소비자 쪽에서 해야 하고, 방법은 인바운드 API에 멱등키를 붙일 때와 같습니다.

```sql
CREATE TABLE consumed_events (
  consumer    VARCHAR(64) NOT NULL,
  event_id    VARCHAR(64) NOT NULL,
  consumed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (consumer, event_id)
) ENGINE=InnoDB;
```

`consumer`를 키에 넣은 이유는, 같은 이벤트를 알림 소비자와 정산 소비자가 **각각 한 번씩** 처리해야 하기 때문입니다.
`event_id`만으로 잡으면 먼저 처리한 쪽이 다른 쪽의 몫까지 소비해 버립니다.

삽입이 유니크 제약에 걸리면 이미 처리한 이벤트이므로 조용히 넘어갑니다.
가능하면 이 삽입과 실제 처리를 소비자 DB의 **한 트랜잭션**으로 묶으세요. 그러지 않으면 여기서 또 같은 이중 쓰기가 생깁니다.

같은 문제를 요청 경로에서 다루는 이야기는 [결제 API에 멱등키 붙이기](/blog/idempotency-key-payment-api/)에 따로 적어뒀습니다.

## 순서는 어디까지 보장되나

`id`가 `AUTO_INCREMENT`니까 발행 순서도 그대로겠지 싶지만, 그렇지 않습니다.
자동 증가 값은 `INSERT` 시점에 배정되고 커밋은 그보다 나중이라, **작은 id가 큰 id보다 늦게 커밋되는 일이 정상적으로 일어납니다.**

릴레이는 `published_at IS NULL`로 훑으니 이 행을 놓치지는 않습니다. 다만 늦게 나타난 작은 id는 다음 배치에서 집히므로 **순서가 뒤집힌 채로 발행됩니다.**
워커를 여러 대 띄우면 한 가지가 더 붙습니다. 같은 주문의 두 이벤트가 서로 다른 워커에 잡히면, 나중 것이 먼저 나갈 수 있습니다.

그러니 전역 순서는 처음부터 포기하고, 필요한 범위에서만 맞추는 편이 현실적입니다.

- 브로커 파티션 키를 `aggregate_id`로 둡니다. 같은 주문의 이벤트는 같은 파티션으로 가고, 파티션 안에서는 순서가 유지됩니다.
- 그래도 워커 단계의 역전이 남으므로, 순서가 중요한 집계는 `aggregate_id` 해시로 워커를 나눠 한 집계를 항상 같은 워커가 맡게 합니다.
- 더 견고한 쪽은 **소비자를 순서에 의존하지 않게 짜는 것**입니다. 이벤트에 버전이나 발생 시각을 실어 보내고, 소비자가 이미 가진 것보다 오래된 이벤트는 버립니다.

세 번째가 가능하면 앞의 두 개는 최적화 문제로 내려옵니다. 순서 보장에 기대는 소비자는 파이프라인 어디를 손대든 같이 깨집니다.

## 운영에서 실제로 손이 가는 것

**테이블이 계속 큽니다.** 발행이 끝난 행은 지워야 하는데, 즉시 지우면 재발행도 감사도 불가능해집니다.
며칠 보관하고 배치로 지우는 정도가 무난하고, 한 번에 지우지 말고 잘라서 반복 실행합니다.

```sql
DELETE FROM outbox
WHERE published_at IS NOT NULL
  AND published_at < NOW() - INTERVAL 7 DAY
ORDER BY id
LIMIT 1000;
```

**알림은 건수가 아니라 나이로 겁니다.** 미발행 건수는 트래픽에 따라 출렁여서 임계값을 잡기 어렵지만, 가장 오래된 미발행 행의 나이는 릴레이가 멈춘 순간부터 단조 증가합니다.

```sql
SELECT TIMESTAMPDIFF(SECOND, MIN(created_at), NOW()) AS oldest_pending_seconds
FROM outbox
WHERE published_at IS NULL;
```

이 값 하나면 릴레이가 죽은 것, 브로커가 막힌 것, 특정 행에서 계속 실패하는 것이 전부 같은 모양으로 드러납니다.

**계속 실패하는 행은 따로 빼둡니다.** `attempts`가 임계를 넘은 행은 대개 페이로드가 잘못됐거나 소비자 쪽 스키마와 안 맞는 경우입니다.
`SKIP LOCKED` 덕분에 뒤의 정상 이벤트를 막지는 않지만, 그래서 더 조용히 쌓입니다. 별도 조회와 알림을 걸어두지 않으면 아무도 모릅니다.

{% comment %} TODO: 아웃박스 지연이나 실패 행 알림을 실제로 어떤 임계값으로 잡았는지 적어주세요 {% endcomment %}

## 안 써도 되는 경우

이 패턴은 테이블 하나와 프로세스 하나, 그리고 정리 배치와 지표를 늘립니다. 그만한 값을 하는지 먼저 따져볼 만합니다.

- **이벤트가 유실돼도 다른 경로로 메워지는 경우.** 캐시 무효화나 검색 색인처럼 주기적 재구축이 있는 소비자라면 굳이 필요 없습니다.
- **소비자가 하나뿐이고 DB를 직접 읽을 수 있는 경우.** 상태 테이블을 폴링하는 쪽이 단순하고, 그 자체로 이미 유실이 없습니다.
- **대사(reconciliation) 배치가 이미 돌고 있는 경우.** 하루 한 번 맞추면 되는 지표라면 실시간 이벤트 정합성에 비용을 들일 이유가 적습니다.

반대로 값을 확실히 하는 쪽은, **"일어났는데 안 나갔다"를 사람이 손으로 메워야 하는 종류**입니다.
결제 완료 알림, 정산 집계, 외부 시스템 연동 같은 것들입니다. 여기서는 한 건의 유실이 CS와 수작업 보정으로 돌아오고, 그 비용은 테이블 하나보다 훨씬 비쌉니다.
