---
layout: post
title: "반복 일정 하나를 고쳤더니 1년치가 전부 바뀌었다 — 반복 규칙과 예외를 저장하는 방법"
date: 2026-11-16
tags: [backend, database, mysql, typescript, sql]
excerpt: "매주 반복되는 일정을 미리 전개해서 저장할 것인가 규칙으로 저장할 것인가. RRULE 표현과 함정, 이 회차만·이후 전부·전체라는 세 가지 수정 범위, 구간 조회를 위한 전개 캐시, 그리고 과거 회차를 어디까지 보존할 것인가."
---

"매주 화요일 10시"는 한 줄이지만 1년이면 50회가 넘습니다.
그중 3월 셋째 주만 11시로 옮기고, 5월 한 주는 쉬고, 9월부터는 수요일로 바꾸자고 하면 그 한 줄은 더 이상 한 줄이 아닙니다.

반복 일정은 저장 방식을 고르는 순간 이후에 들어올 수정 요구의 난이도가 결정됩니다.
그리고 대개 가장 먼저 떠오르는 방식이 가장 먼저 막힙니다.

## 전개와 규칙, 어느 쪽을 원본으로 둘 것인가

선택지는 둘입니다. 반복을 **미리 펼쳐서 행으로 저장**하거나, **규칙 한 줄로 저장**하고 조회할 때 펼치거나.

| | 전개 저장 | 규칙 저장 |
| --- | --- | --- |
| 구간 조회 | 인덱스 범위 스캔으로 끝 | 전개해봐야 안다 |
| 이 회차만 수정 | 그 행만 고치면 된다 | 예외를 따로 표현해야 한다 |
| 규칙 전체 수정 | N개 행을 전부 고친다 | 한 줄을 고친다 |
| 종료 없는 반복 | 표현 불가 (어딘가에서 끊어야 한다) | `FREQ=WEEKLY` 한 줄 |
| 저장량 | 회차 수에 비례 | 일정 수에 비례 |
| 규칙이 뭐였는지 | 행에서 역추적할 수 없다 | 그대로 남아 있다 |

전개 저장의 문제는 **의도가 사라진다**는 점입니다. 50개 행을 보고 "매주 화요일"이었는지 "2주마다 화요일 두 번"이었는지 되살릴 수 없습니다.
그래서 "이후 전부 수정"이 들어오면 어디까지가 한 묶음인지 판단할 근거가 없습니다.

규칙 저장의 문제는 **조회**입니다. `WHERE start_at BETWEEN ...`을 쓸 수 없습니다.
11월 달력 한 장을 그리려면 모든 일정의 규칙을 꺼내 애플리케이션에서 전개한 뒤 걸러야 하고, 이건 일정 수가 늘면 그대로 비용이 됩니다.

결론부터 적으면, 실무에서 쓸 만한 조합은 **규칙을 원본으로 두고 전개 결과를 캐시 테이블에 쌓는 것**입니다.
원본이 규칙이니 의도가 남고, 조회는 전개된 행을 보니 인덱스를 씁니다. 캐시는 언제든 규칙에서 다시 만들 수 있습니다.

## 규칙을 어떻게 적을 것인가

직접 포맷을 만들 이유가 없습니다. iCalendar(RFC 5545)의 `RRULE`이 이미 이 문제를 다 풀어놨고, 캘린더 클라이언트와 주고받을 때도 그대로 쓰입니다.

```text
FREQ=WEEKLY;BYDAY=TU                      매주 화요일
FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE        2주마다 월·수
FREQ=MONTHLY;BYMONTHDAY=1                 매월 1일
FREQ=MONTHLY;BYDAY=FR;BYSETPOS=-1         매월 마지막 금요일
FREQ=DAILY;COUNT=10                       10회만
FREQ=WEEKLY;BYDAY=TU;UNTIL=20270301T000000Z
```

요일 약어는 `SU,MO,TU,WE,TH,FR,SA`이고, `BYSETPOS`는 조건에 맞는 후보들 중 몇 번째를 고를지 지정합니다. 음수는 뒤에서부터입니다.

규칙 자체는 시작 시각을 담지 않습니다. 반복의 기준점은 별도의 `DTSTART`이고, `RRULE`은 거기서부터 어떻게 되풀이될지만 말합니다.
그래서 **`DTSTART`를 바꾸면 전개 결과가 전부 달라집니다.** 규칙은 그대로인데 결과가 바뀌는 첫 번째 경우입니다.

### 여기서 자주 틀리는 것들

`COUNT`와 `UNTIL`은 **같이 쓸 수 없습니다.** 둘 다 종료 조건이라 하나만 허용됩니다.

`UNTIL`은 포함(inclusive)입니다. "2월까지"를 `UNTIL=20270228...`로 적으면 그날 회차가 들어갑니다.
그리고 `DTSTART`가 시간대를 가진 값이면 **`UNTIL`은 UTC로 적어야 합니다.** 지역 시간을 그대로 넣으면 스펙 위반이고, 라이브러리에 따라 조용히 다른 결과가 나옵니다.

`INTERVAL`이 2 이상인 주간 반복은 **주의 시작 요일(`WKST`)에 따라 결과가 달라집니다.** 기본값은 월요일이고, 일요일 시작인 서비스라면 명시해야 합니다.

```text
FREQ=WEEKLY;INTERVAL=2;BYDAY=SU,SA;WKST=SU
```

월말도 함정입니다. `BYMONTHDAY=31`은 31일이 없는 달을 **그냥 건너뜁니다.** 2월 말로 밀어주지 않습니다.
"매월 말일"을 원한다면 `BYMONTHDAY=-1`을 씁니다.

> 전개 로직을 직접 구현하는 건 권하지 않습니다. `BYSETPOS`, 윤년, 월말, `WKST`가 걸린 경계에서 틀리고, 그 버그는 몇 달 뒤 특정 달에만 터집니다.
> 쓰는 언어의 RRULE 구현체를 쓰고, 지원 범위와 알려진 제약은 해당 문서에서 확인하세요.

## 스키마

규칙을 담는 테이블, 회차별 예외를 담는 테이블, 전개 캐시 세 개로 나눕니다.

```sql
CREATE TABLE schedules (
  id             BINARY(16)   NOT NULL PRIMARY KEY,
  owner_id       BINARY(16)   NOT NULL,
  title          VARCHAR(255) NOT NULL,
  -- 반복의 기준점. 인스턴트가 아니라 벽시계 시간으로 저장한다
  dtstart_local  DATETIME     NOT NULL,
  duration_min   INT          NOT NULL,
  timezone       VARCHAR(64)  NOT NULL,   -- 'Asia/Seoul'
  rrule          VARCHAR(512) NULL,       -- NULL이면 반복 없는 단일 일정
  -- 분할된 규칙들을 하나의 계열로 묶는 키
  series_id      BINARY(16)   NOT NULL,
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_series (series_id),
  KEY idx_owner  (owner_id, dtstart_local)
) ENGINE=InnoDB;
```

`duration_min`으로 길이를 저장하는 이유가 있습니다. 종료 시각을 따로 저장하면 회차마다 시작과 끝을 둘 다 전개해야 하고, 둘이 어긋날 여지가 생깁니다.

예외는 별도 테이블에 두고, **원래 전개되었어야 할 시작 시각**으로 식별합니다.

```sql
CREATE TABLE schedule_overrides (
  schedule_id    BINARY(16)   NOT NULL,
  -- 규칙에서 전개된 원래 시작 시각 (벽시계). 예외의 식별자다
  occurrence_key DATETIME     NOT NULL,
  cancelled      TINYINT(1)   NOT NULL DEFAULT 0,
  title          VARCHAR(255) NULL,       -- NULL이면 원본을 따른다
  start_local    DATETIME     NULL,
  duration_min   INT          NULL,
  PRIMARY KEY (schedule_id, occurrence_key)
) ENGINE=InnoDB;
```

핵심은 `occurrence_key`입니다. 이게 **옮긴 뒤의 시각이 아니라 옮기기 전의 시각**이어야 합니다.
10시 회차를 11시로 옮긴 뒤 다시 전개하면 규칙은 여전히 10시를 내놓습니다. 그 10시를 "이미 예외 처리된 회차"로 알아보려면 원래 시각이 열쇠여야 합니다.

전개 캐시는 조회 전용입니다.

```sql
CREATE TABLE schedule_occurrences (
  schedule_id    BINARY(16) NOT NULL,
  occurrence_key DATETIME   NOT NULL,
  start_at       DATETIME   NOT NULL,   -- UTC
  end_at         DATETIME   NOT NULL,   -- UTC
  PRIMARY KEY (schedule_id, occurrence_key),
  KEY idx_range (start_at, end_at)
) ENGINE=InnoDB;
```

취소된 회차는 캐시에 넣지 않습니다. 조회 때마다 `LEFT JOIN`으로 걸러내는 대신, 캐시를 만들 때 이미 반영하는 쪽이 조회 경로를 단순하게 유지합니다.

## 구간 조회

달력 한 화면은 이 쿼리 하나입니다.

```sql
SELECT o.schedule_id, o.occurrence_key, o.start_at, o.end_at,
       COALESCE(v.title, s.title) AS title
FROM schedule_occurrences o
JOIN schedules s ON s.id = o.schedule_id
LEFT JOIN schedule_overrides v
       ON v.schedule_id = o.schedule_id
      AND v.occurrence_key = o.occurrence_key
WHERE s.owner_id = :owner
  AND o.start_at < :range_end
  AND o.end_at   > :range_start
ORDER BY o.start_at;
```

겹침 조건을 `BETWEEN`으로 쓰면 안 됩니다. `start_at BETWEEN :from AND :to`는 **구간을 걸쳐 있는 일정을 빠뜨립니다.**
전날 23시에 시작해 다음 날로 넘어가는 회차가 오늘 달력에서 사라지는 식입니다. 반쯤 열린 구간 비교(`start < end_of_range AND end > start_of_range`)가 정답입니다.

{% comment %} TODO: 실제 서비스에서 한 화면당 조회 범위를 어떻게 잡았는지(주/월 단위, 선행 로딩 여부) 적어주세요 {% endcomment %}

## 세 가지 수정 범위

반복 일정의 수정 요청은 항상 셋 중 하나입니다. UI에서 먼저 물어봐야 하고, 저장 방식도 각각 다릅니다.

### 이 회차만

예외 행 하나를 넣고, 캐시의 해당 행만 갱신합니다. 규칙은 손대지 않습니다.

```sql
INSERT INTO schedule_overrides
  (schedule_id, occurrence_key, start_local, duration_min)
VALUES (:id, :original_start, :new_start, :duration)
ON DUPLICATE KEY UPDATE
  start_local  = VALUES(start_local),
  duration_min = VALUES(duration_min),
  cancelled    = 0;
```

> `VALUES()` 참조는 최근 MySQL에서 행 별칭 문법으로 대체되는 중입니다. 쓰는 버전의 문서를 확인하세요.

취소는 삭제가 아니라 `cancelled = 1`입니다. 행을 지우면 다음 전개에서 그 회차가 되살아납니다.

### 이후 전부

여기가 가장 많이 잘못 구현되는 지점입니다. 규칙을 그냥 고치면 **이미 지나간 회차까지 소급해서 바뀝니다.**

올바른 처리는 **규칙을 둘로 쪼개는 것**입니다. 원본에 `UNTIL`을 달아 경계 직전까지로 끊고, 경계부터는 새 규칙이 담당합니다.

```typescript
// "이 회차 이후 전부" = 규칙을 경계에서 분할한다
async function updateFromOccurrence(
  tx: Tx,
  scheduleId: string,
  boundaryKey: Date,        // 사용자가 누른 그 회차의 원래 시작 시각
  patch: SchedulePatch,
) {
  const origin = await tx.schedules.findUniqueOrThrow({ where: { id: scheduleId } });

  // 1) 원본은 경계 직전까지만 유효하게 만든다 (UNTIL은 UTC)
  await tx.schedules.update({
    where: { id: scheduleId },
    // untilBefore: 경계 직전(1초 전)을 해당 시간대 기준으로 UTC 인스턴트로 바꾼다
    data: { rrule: setUntil(origin.rrule, untilBefore(boundaryKey, origin.timezone)) },
  });

  // 2) 경계부터는 새 규칙이 담당한다. 같은 계열로 묶어둔다
  const next = await tx.schedules.create({
    data: {
      ownerId:      origin.ownerId,
      seriesId:     origin.seriesId,
      title:        patch.title        ?? origin.title,
      dtstartLocal: patch.startLocal   ?? boundaryKey,
      durationMin:  patch.durationMin  ?? origin.durationMin,
      timezone:     origin.timezone,
      rrule:        patch.rrule        ?? origin.rrule,
    },
  });

  // 3) 경계 이후의 예외는 새 규칙으로 넘긴다
  await tx.scheduleOverrides.updateMany({
    where: { scheduleId: origin.id, occurrenceKey: { gte: boundaryKey } },
    data:  { scheduleId: next.id },
  });

  // 4) 캐시는 경계 이후만 다시 만든다. 과거는 건드리지 않는다
  await rebuildOccurrences(tx, origin.id, { from: boundaryKey });
  await rebuildOccurrences(tx, next.id,   { from: boundaryKey });
  return next;
}
```

`series_id`를 두는 이유가 여기서 드러납니다. 분할을 반복하면 한 반복 일정이 `schedules` 행 여러 개로 흩어지는데,
"이 일정의 전체 이력"이나 "계열 전체 삭제"를 처리하려면 묶는 키가 필요합니다. 분할할 때마다 새 행이 생긴다는 점은 감수하는 비용입니다.

### 전체

규칙과 `DTSTART`를 고치고 캐시를 전부 다시 만듭니다. 이때 **기존 예외를 어떻게 할지 정해야 합니다.**

규칙이 바뀌면 예외의 `occurrence_key`가 더 이상 전개 결과에 존재하지 않을 수 있습니다. 화요일 반복을 수요일로 바꾸면 화요일 기준 예외는 전부 고아가 됩니다.
선택지는 둘뿐이고, 어느 쪽이든 사용자에게 알려야 합니다.

- **예외를 버린다** — 구현이 단순하고 결과가 예측 가능합니다. 대신 개별 조정이 조용히 사라집니다.
- **살려본다** — 전개 결과에 매칭되는 것만 남기고 나머지를 버립니다. 규칙이 많이 바뀌면 결과를 설명하기 어려워집니다.

버리는 쪽을 기본으로 두고 확인 문구를 띄우는 편이 사고가 적습니다.

## 타임존 — 인스턴트로 저장하면 안 되는 이유

반복 일정이 뜻하는 건 "UTC 01:00"이 아니라 **"현지 10시"**입니다. 그래서 규칙과 기준점은 벽시계 시간 + 시간대 ID로 저장하고, UTC는 전개 결과에만 둡니다.

서머타임이 있는 지역에서는 이 차이가 바로 드러납니다. 전환 주에 UTC 오프셋이 바뀌므로, 인스턴트로 저장해두면 그 주부터 한 시간씩 밀립니다.
한국은 지금 서머타임이 없어 체감되지 않지만, 1980년대 후반에 일시적으로 시행된 적이 있고 시간대 규칙 자체는 tzdata 갱신으로 계속 바뀝니다.

[하루 경계가 어긋나는 문제](/blog/timezone-datetime-day-boundary/)와 뿌리는 같지만, 반복 일정에는 한 가지가 더 붙습니다.
**이미 전개해둔 캐시는 과거의 시간대 규칙으로 계산된 값**이라는 점입니다. 그래서 캐시는 반드시 규칙에서 재생성 가능해야 하고, 그게 원본이 아니어야 하는 이유입니다.

전개 순서도 뒤집으면 안 됩니다. UTC로 바꿔놓고 반복을 돌리면 오프셋이 바뀌는 구간에서 벽시계 시간이 어긋납니다.

```typescript
// 반복은 벽시계 시간으로 돌리고, 마지막에 시간대를 적용해 UTC로 바꾼다
function expand(s: Schedule, from: Date, until: Date): Occurrence[] {
  const localStarts = expandRruleInWallClock(s.rrule, s.dtstartLocal, from, until);

  return localStarts.map((local) => {
    const startAt = zonedTimeToUtc(local, s.timezone);
    return {
      occurrenceKey: local,
      startAt,
      endAt: new Date(startAt.getTime() + s.durationMin * 60_000),
    };
  });
}
```

라이브러리의 전개 결과를 `Date`로 그대로 믿지 말고, **벽시계 성분만 꺼내 지역 시간대로 다시 조립하는 편**이 안전합니다.
RRULE 구현체는 대체로 시간대 없는 값을 다루면서 그 값을 `Date`에 담아 돌려주기 때문에, 서버 로컬 시간대에 따라 해석이 갈립니다.

## 끝이 없는 반복을 어디까지 펼칠 것인가

`FREQ=WEEKLY`에 종료 조건이 없으면 전개는 무한합니다. 그래서 캐시에는 **지평선(horizon)**이 필요합니다.

"지금부터 N개월"만 채워두고, 주기적으로 밀어주는 배치를 돌립니다. 숫자는 서비스가 달력을 얼마나 앞까지 보여주는지에 따라 정하면 됩니다.

```sql
-- 지평선 바깥은 지우고 (과거 회차는 남긴다)
DELETE FROM schedule_occurrences WHERE start_at >= :horizon_end;
```

채우는 쪽은 멱등해야 합니다. 배치가 두 번 돌거나 중간에 죽어도 결과가 같아야 합니다.

```sql
INSERT INTO schedule_occurrences
  (schedule_id, occurrence_key, start_at, end_at)
VALUES (:id, :key, :start, :end)
ON DUPLICATE KEY UPDATE
  start_at = VALUES(start_at),
  end_at   = VALUES(end_at);
```

`(schedule_id, occurrence_key)`가 기본키라서 재실행이 덮어쓰기로 수렴합니다. 전개 캐시를 쓰는 설계의 실질적인 이점이 이것입니다.
어긋났다고 판단되면 그냥 다 지우고 다시 만들면 됩니다.

> 지평선을 넘는 범위를 조회하면 캐시에 행이 없어 **일정이 비어 보입니다.** 조회 범위 상한을 API에서 막거나, 그 구간은 즉석 전개로 떨어뜨리는 분기를 두세요.
> 조용히 빈 달력을 보여주는 쪽이 에러보다 나쁩니다.

## 과거 회차는 바꾸지 않는다

마지막이 가장 중요합니다. **규칙을 고쳐도 지나간 회차는 다시 계산하지 않습니다.**

지난 회차는 예측이 아니라 기록입니다. 지난주 화요일에 수업이 있었다는 사실은 오늘 규칙을 바꿨다고 사라지지 않습니다.
출결이나 기록이 회차에 붙는 서비스라면 더 그렇습니다. 참석 기록이 달린 회차를 재생성으로 날려버리면 복구할 방법이 없습니다.

그래서 재생성 작업에는 항상 하한이 들어갑니다.

```typescript
const rebuildFrom = maxDate(boundary, now);   // 과거로는 내려가지 않는다
```

그리고 회차에 다른 데이터가 붙는 순간, 전개 캐시는 더 이상 순수한 캐시가 아닙니다.
그때는 회차 행을 캐시가 아닌 실체로 승격시키고, 참조가 달린 회차는 규칙 변경에서 제외하는 규칙을 명시해야 합니다.

## 정리

- 규칙(RRULE)을 원본으로, 전개 결과는 재생성 가능한 캐시로 둔다.
- 예외는 **옮기기 전 시작 시각**을 키로 식별한다. 취소는 삭제가 아니라 플래그다.
- "이후 전부"는 규칙 수정이 아니라 **규칙 분할**이다. 계열 키로 묶어둔다.
- 기준점은 벽시계 시간 + 시간대 ID로 저장하고, 전개한 다음에 UTC로 바꾼다.
- 종료 없는 반복은 지평선까지만 채우고, 범위를 넘는 조회를 막는다.
- 과거 회차는 재생성하지 않는다. 회차에 기록이 붙으면 캐시가 아니게 된다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 부딪힌 것

- 사용한 RRULE 구현체와 지원 범위에서 걸린 항목
- 지평선 길이와 재생성 배치 주기를 어떻게 잡았는지
- 회차에 붙는 데이터(출결·기록)를 어떻게 처리했는지

{% endcomment %}
