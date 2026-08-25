---
layout: post
title: "운영 DB를 건드리지 않고 지표 대시보드 만들기"
date: 2026-08-25
tags: [data, etl, mysql, superset, devops]
excerpt: "리드 리플리카에서 증분 추출해 별도 집계 DB에 적재하고 Superset으로 시각화하는 구조. 복제 지연, 워터마크, 멱등한 재실행까지."
---

"결제 추이랑 가입자 수 좀 볼 수 있을까요."

이 요청은 대개 가볍게 들어옵니다. BI 도구를 하나 띄우고 운영 DB에 연결하면 그날 안에 차트가 나오니까요.
문제는 그렇게 만든 대시보드가 몇 달 뒤에 청구서가 아니라 지연 시간으로 돌아온다는 데 있습니다.

## 운영 DB에 대시보드를 직접 붙이면 생기는 일

가장 빠른 방법은 BI 도구를 운영 DB에 그냥 연결하는 것입니다. 실제로 처음엔 그렇게 시작하게 되고, 한동안은 잘 돕니다.
문제는 대시보드가 늘어난 뒤에 옵니다.

우선 쿼리 모양을 통제할 수 없습니다. 대시보드 쿼리는 `GROUP BY` 한 뒤 기간 필터를 거는 형태가 많은데, 이건 인덱스가 잘 안 듣는 축에 속합니다.
사용자가 기간을 "최근 1년"으로 바꾸는 순간 수백만 행을 훑는 쿼리가 되고, 그걸 누가 언제 돌릴지는 예측할 수 없습니다.

증상은 차단이 아니라 잠식으로 옵니다. InnoDB에서 읽기 쿼리가 쓰기를 직접 막지는 않지만, 버퍼 풀은 공유 자원입니다.
집계 쿼리가 콜드한 오래된 페이지를 잔뜩 끌어올리면 운영 쿼리가 쓰던 페이지가 밀려나고, 그때부터 평소에 잘 돌던 쿼리의 지연 시간이 슬금슬금 올라갑니다.
어디를 봐도 범인이 없어서 원인을 찾기 어려운 종류의 성능 저하입니다.

시간이 더 지나면 대시보드가 스키마에 묶입니다. 대시보드 SQL이 운영 테이블을 직접 참조하면 그 테이블 구조를 바꿀 때마다 차트가 깨지는데,
그런데 이 SQL은 애플리케이션 코드 어디에도 없습니다. BI 도구 안에 들어 있어서 배포 시점에 눈에 띄지 않고, 며칠 뒤에 "차트가 비었다"는 이야기로 돌아옵니다.

그래서 경로를 하나 끼워 넣습니다.

## 구조

```
운영 DB (Primary)
   │  복제
   ▼
Read Replica  ──추출──▶  ETL 잡  ──적재──▶  집계 DB  ◀──조회──  Superset
```

역할을 나누면 이렇습니다.

| 구간 | 역할 | 감수하는 것 |
| --- | --- | --- |
| Read Replica | 운영 트래픽과 분리된 읽기 지점 | 복제 지연만큼 데이터가 늦음 |
| ETL 잡 | 증분 추출 · 변환 · 적재 | 스케줄 주기만큼 신선도가 떨어짐 |
| 집계 DB | 대시보드가 조회하는 유일한 대상 | 저장소가 하나 늘어남 |
| Superset | 시각화와 권한 | 운영 스키마를 모름 |

핵심은 **대시보드가 운영 스키마를 전혀 모르게 만드는 것**입니다.
집계 테이블이 일종의 계약이 되고, 운영 테이블 구조가 바뀌어도 ETL 잡만 고치면 대시보드는 그대로 돕니다.

리플리카를 하나 더 띄우는 비용이 아깝게 느껴질 수 있는데, 대시보드가 운영 지연 시간에 영향을 주기 시작하면 원인을 찾는 데 드는 시간이 훨씬 비쌉니다.

<!-- TODO: 실제로 어떤 지표부터 요청이 들어왔는지, 그리고 처음에 운영 DB에 직접 붙였다가 겪은 문제가 있었다면 적어주세요 -->

## 리드 리플리카에서 읽을 때 주의할 것

리플리카에 붙였다고 끝이 아닙니다. 두 가지가 발목을 잡습니다.

**복제 지연을 먼저 확인하고 시작합니다.** 지연이 큰 상태에서 추출하면 "어제까지" 뽑았다고 생각한 구간에 구멍이 생깁니다.

```sql
-- MySQL 8.0 이상
SELECT
  CHANNEL_NAME,
  SERVICE_STATE,
  LAST_QUEUED_TRANSACTION,
  LAST_APPLIED_TRANSACTION
FROM performance_schema.replication_applier_status_by_worker;

SHOW REPLICA STATUS\G   -- Seconds_Behind_Source 확인
```

`Seconds_Behind_Source`는 완벽한 지표는 아니지만(적용 스레드가 놀고 있으면 0으로 나옵니다) 임계값 가드로는 충분합니다.
ETL 잡 시작 시점에 이 값이 임계치를 넘으면 그냥 이번 회차를 건너뛰고 다음 스케줄을 기다리는 편이 낫습니다. 반쯤 뽑힌 데이터를 적재하는 것보다 낫습니다.

두 번째는 긴 쿼리가 복제에 밀려 끊기는 문제입니다. 리플리카에서 오래 걸리는 조회를 돌리는 동안 프라이머리에서 같은 행에 대한 변경이 넘어오면, 복제 적용 스레드가 대기하다가 설정된 시간이 지나면 조회 쿼리 쪽이 취소됩니다.
Aurora와 RDS MySQL 모두 이 동작을 조절하는 파라미터가 있으니(엔진과 버전마다 이름이 다릅니다) 사용하는 엔진의 문서에서 확인하세요.
근본적인 대응은 **한 번에 뽑는 구간을 작게 자르는 것**입니다. 한 시간치씩 나눠 뽑으면 개별 쿼리가 짧아져 이 문제 자체가 잘 생기지 않습니다.

## 증분 추출 기준 잡기

매번 전체를 다시 읽으면 데이터가 늘어날수록 잡이 느려지고, 결국 스케줄 주기를 넘깁니다. 증분으로 가야 합니다.

기준 컬럼은 이 순서로 고릅니다.

1. **`updated_at` 같은 갱신 시각 컬럼** — 있으면 가장 편합니다. 단, 애플리케이션이 모든 갱신 경로에서 이 값을 반드시 채우는지 확인해야 합니다. 배치로 `UPDATE`를 돌리면서 빼먹는 코드가 하나라도 있으면 그 행은 영원히 안 따라옵니다.
2. **자동 증가 PK** — 삽입만 있고 수정이 없는 로그성 테이블에 적합합니다. 수정이 일어나는 테이블에는 못 씁니다.
3. **CDC(binlog)** — 위 둘이 모두 불가능하거나 삭제까지 추적해야 할 때. 대신 파이프라인이 한 단계 더 복잡해집니다.

워터마크는 별도 테이블에 남깁니다.

```sql
CREATE TABLE etl_watermark (
  job_name   VARCHAR(64)  NOT NULL PRIMARY KEY,
  last_value DATETIME(6)  NOT NULL,
  updated_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                          ON UPDATE CURRENT_TIMESTAMP(6)
);
```

여기서 흔히 밟는 함정이 하나 있습니다. 추출 조건을 `updated_at > last_value`로 쓰고 워터마크를 `NOW()`로 갱신하면, **경계 시점에 커밋 중이던 트랜잭션을 놓칩니다.**
`updated_at`은 트랜잭션 시작 시점에 정해지는데 커밋은 그 뒤에 되므로, 잡이 읽는 순간에는 아직 안 보이지만 값은 이미 과거인 행이 생깁니다.

그래서 **안전 여유(lag)를 두고 상한을 막습니다.**

```sql
SELECT *
FROM payments
WHERE updated_at >  :last_value
  AND updated_at <= :upper_bound   -- NOW() - INTERVAL 5 MINUTE
ORDER BY updated_at
LIMIT 5000;
```

워터마크는 실제로 읽어온 마지막 행의 `updated_at`으로 갱신하고, 여유 구간 안쪽은 다음 회차에 다시 훑게 둡니다.
같은 행을 두 번 읽는 건 괜찮습니다 — 아래에서 적재를 멱등하게 만들 것이기 때문입니다. 놓치는 것이 훨씬 나쁩니다.

## 적재 스키마: 얇은 집계 테이블

여기서 스타 스키마니 팩트/디멘션이니 하는 데이터 웨어하우스 모델링으로 바로 넘어가고 싶어지는데, 대시보드 몇 개 띄우는 단계에서는 과합니다.
**차트 하나가 필요로 하는 모양 그대로 테이블을 만드는 편**이 훨씬 단순합니다.

```sql
CREATE TABLE agg_daily_revenue (
  stat_date     DATE         NOT NULL,
  product_type  VARCHAR(32)  NOT NULL,
  order_count   INT          NOT NULL,
  gross_amount  BIGINT       NOT NULL,
  refund_amount BIGINT       NOT NULL,
  updated_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                             ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (stat_date, product_type)
);

CREATE TABLE agg_daily_users (
  stat_date      DATE        NOT NULL,
  gender         VARCHAR(16) NOT NULL,
  age_band       VARCHAR(16) NOT NULL,
  signup_count   INT         NOT NULL,
  active_count   INT         NOT NULL,
  PRIMARY KEY (stat_date, gender, age_band)
);
```

집계 키를 그대로 기본 키로 잡아두면 적재가 `INSERT ... ON DUPLICATE KEY UPDATE` 한 문장으로 끝나고, 이게 곧 **멱등성**이 됩니다.
잡이 중간에 죽어서 같은 구간을 다시 돌려도 결과가 같습니다. 재실행을 무서워하지 않아도 되는 파이프라인이 운영하기 훨씬 편합니다.

```sql
INSERT INTO agg_daily_revenue
  (stat_date, product_type, order_count, gross_amount, refund_amount)
VALUES (?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  order_count   = VALUES(order_count),
  gross_amount  = VALUES(gross_amount),
  refund_amount = VALUES(refund_amount);
```

주의할 점은 **집계는 원본 구간 전체를 다시 계산해야 정확하다**는 것입니다.
어제 결제가 오늘 환불되면 어제 날짜의 `refund_amount`가 바뀝니다. 그래서 증분으로 "변경된 행"을 찾되, 그 행들이 속한 **날짜 구간을 통째로 다시 집계**해 덮어씁니다.

개인정보가 섞이는 지점도 여기서 정리합니다. 성별·연령 같은 속성은 **밴드로 묶어 적재**하고 원본 생년월일이나 식별자는 집계 DB로 넘기지 않습니다.
대시보드는 개별 사용자를 볼 이유가 없고, 넘기지 않으면 접근 권한을 관리할 대상도 줄어듭니다.

## 잡 실행과 재시도

잡 자체는 특별할 게 없습니다. 중요한 건 실패했을 때의 동작입니다.

```typescript
type JobResult = { rows: number; watermark: Date };

async function runIncremental(job: string): Promise<JobResult | null> {
  const lagSeconds = await replicaLagSeconds();
  if (lagSeconds > MAX_LAG_SECONDS) {
    logger.warn({ job, lagSeconds }, "복제 지연이 커서 이번 회차를 건너뜁니다");
    return null;                       // 다음 스케줄에 다시 시도
  }

  const last = await readWatermark(job);
  const upper = new Date(Date.now() - SAFETY_LAG_MS);

  let cursor = last;
  let total = 0;

  // 한 번에 다 뽑지 않고 잘라서 읽는다. 리플리카에서 긴 쿼리는 끊길 수 있다.
  for (;;) {
    const rows = await extract(job, cursor, upper, BATCH_SIZE);
    if (rows.length === 0) break;

    const dates = new Set(rows.map((r) => toStatDate(r.updated_at)));
    await recomputeAndUpsert([...dates]);   // 구간을 통째로 다시 집계해 덮어쓴다

    cursor = rows[rows.length - 1].updated_at;
    total += rows.length;

    await writeWatermark(job, cursor);      // 배치마다 전진시켜 재시작 지점을 좁힌다
  }

  return { rows: total, watermark: cursor };
}
```

워터마크를 **배치마다** 갱신하는 게 포인트입니다. 잡 전체가 끝난 뒤에 한 번만 쓰면, 중간에 죽었을 때 처음부터 다시 해야 합니다.
적재가 멱등하니 배치 단위로 전진시켜도 안전합니다.

스케줄러는 이미 쓰고 있는 것에 얹으면 됩니다. 잡이 몇 개 안 되면 EventBridge Scheduler로 ECS 태스크를 띄우는 정도로 충분하고, 의존 관계가 생기고 백필을 자주 돌리게 되면 그때 워크플로 오케스트레이터를 검토하는 순서가 무난합니다.
처음부터 오케스트레이터를 세우면 그 자체가 운영 대상이 하나 더 늘어나는 일입니다.

**겹쳐 도는 것만 막아두세요.** 잡이 예상보다 오래 걸려 다음 스케줄과 겹치면 같은 구간을 두 인스턴스가 동시에 집계합니다. 결과가 틀리진 않지만(멱등하니까) 리플리카에 불필요한 부하가 갑니다.

```sql
SELECT GET_LOCK('etl:daily_revenue', 0);   -- 0이면 이미 도는 중, 즉시 종료
```

## Superset 연결

Superset은 **집계 DB만** 보게 합니다. 운영 DB 커넥션은 아예 등록하지 않는 편이 낫습니다. 등록해두면 언젠가 누군가 거기에 차트를 만듭니다.

연결 계정은 읽기 전용으로 따로 팝니다.

```sql
CREATE USER 'superset_ro'@'%' IDENTIFIED BY '<password>';
GRANT SELECT ON analytics.* TO 'superset_ro'@'%';
```

Superset 쪽 데이터베이스 설정에서 확인할 것들입니다.

- **DML 허용을 끕니다** (`Allow DML`). 켜두면 SQL Lab에서 `UPDATE`/`DELETE`가 나갑니다. 읽기 전용 계정이면 어차피 막히지만 두 겹으로 막아둡니다.
- **쿼리 타임아웃**을 짧게 잡습니다. 누군가 실수로 무거운 쿼리를 돌려도 집계 DB가 오래 붙들리지 않습니다.
- **캐시 시간**을 ETL 주기에 맞춥니다. 5분마다 적재하는데 캐시가 1시간이면 대시보드가 계속 옛 숫자를 보여줍니다. 반대로 하루 한 번 적재하는 지표에 캐시를 짧게 두면 매번 집계 DB를 때립니다.

차트는 가능한 한 **집계 테이블을 그대로 읽는 형태**로 만듭니다.
Superset의 SQL Lab에서 조인과 서브쿼리를 잔뜩 엮은 가상 데이터셋을 만들면 편하긴 한데, 그 순간 로직이 ETL이 아니라 BI 도구 안으로 들어갑니다.
버전 관리도 안 되고 리뷰도 안 되는 자리라, 계산은 ETL에 두고 Superset은 그리기만 하게 두는 편이 오래갑니다.

<!-- TODO: 실제로 어떤 대시보드를 만들었고 사업팀에서 어떻게 쓰고 있는지, 그 과정에서 나온 요구사항 변경이 있었다면 적어주세요 -->

## 조용한 실패를 막는 장치

이 구조에서 가장 위험한 건 잡이 죽는 것이 아니라 **죽은 걸 아무도 모르는 것**입니다.
숫자가 안 바뀌어도 차트는 그대로 그려지고, 사람들은 그 숫자를 보고 판단합니다.

그래서 마지막 적재 시각을 대시보드 안에 같이 노출합니다. 잡이 멈췄을 때 "숫자가 이상한데요"로 시작하던 대화가 "데이터가 안 들어왔네요"로 바뀝니다.

```sql
SELECT job_name, last_value, updated_at
FROM etl_watermark
ORDER BY updated_at;
```

같은 값으로 알림도 겁니다. 스케줄 주기의 두세 배가 지나도록 워터마크가 안 움직이면 사람에게 알리게 해두면 됩니다.
프로세스의 생존이 아니라 **데이터의 전진**을 본다는 점에서, 앞서 말한 복제 지연 가드와 같은 성격의 장치입니다.

나머지는 시간이 지나면서 천천히 드러나는 것들입니다.

- 집계 테이블 행 수 — 일별 집계는 잘 안 커지지만 차원을 하나둘 붙이면 곱셈이 됩니다. 차원을 추가할 때 "이 조합이 몇 행이 되는가"를 먼저 계산해 보는 습관이 도움이 됩니다.
- 운영 스키마 변경 — 컬럼이 사라지면 ETL 잡이 깨집니다. 이건 오히려 좋은 신호입니다. 대시보드가 조용히 비는 대신 잡이 시끄럽게 실패하니까요.

<!-- TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 파이프라인을 운영하면서 실제로 터진 문제와 대응
- 적재 주기와 데이터 규모, 집계 DB 사양

-->
