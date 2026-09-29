---
layout: post
title: "둘이 저장했는데 한 명 수정만 남았다 — 갱신 분실과 낙관적 잠금"
date: 2026-09-30
tags: [backend, mysql, api, architecture, typescript]
excerpt: "트랜잭션을 제대로 걸어도 두 사람의 수정은 서로를 덮어씁니다. 읽기와 쓰기 사이에 사용자의 편집 시간이 끼는 구조, 조건부 UPDATE와 버전 컬럼, ETag·If-Match로 계층을 올리는 법, 그리고 충돌을 누가 풀어야 하는지."
---

두 사람이 같은 글을 열어 각자 고치고 저장했습니다. 나중에 누른 쪽 내용만 남아 있습니다.

로그에는 아무것도 없습니다. 두 요청 모두 200을 받았고, 트랜잭션은 둘 다 정상 커밋됐습니다.
**아무도 실패하지 않았는데 한 사람의 작업만 사라진** 상태입니다.

## 트랜잭션은 이걸 막아주지 않는다

갱신 분실(lost update)은 읽고, 고치고, 쓰는 세 단계가 두 주체에서 겹칠 때 생깁니다.

```text
A: SELECT body → "원본"
B: SELECT body → "원본"
A: UPDATE body = "원본 + A의 문단"   커밋
B: UPDATE body = "원본 + B의 문단"   커밋   ← A의 문단이 사라짐
```

여기서 흔한 오해는 격리 수준을 올리면 해결된다는 것입니다.
`REPEATABLE READ`든 `SERIALIZABLE`이든, **두 트랜잭션이 시간상 겹치지 않으면 막을 것이 없습니다.**
A가 커밋한 뒤에 B가 트랜잭션을 시작했다면 DB 입장에서는 완벽하게 순차적인 두 작업입니다.

문제는 B가 화면에 띄우고 있던 값이 A의 커밋 전에 읽은 값이라는 데 있고, 그 사실은 DB가 알 도리가 없습니다.

길이 차이가 핵심입니다. DB 트랜잭션은 밀리초 단위지만, **사용자의 편집은 분 단위**입니다.
읽기와 쓰기 사이에 사람의 생각하는 시간이 들어가는 순간, 그 구간은 어떤 트랜잭션 안에도 들어가지 않습니다.

## 잠글 수 있는 경우와 없는 경우

같은 트랜잭션 안에서 읽고 쓴다면 비관적 잠금으로 막을 수 있습니다.

```sql
START TRANSACTION;
SELECT stock FROM items WHERE id = 1 FOR UPDATE;  -- 다른 트랜잭션은 여기서 대기
UPDATE items SET stock = ? WHERE id = 1;
COMMIT;
```

이 구간이 짧다면 좋은 답입니다. 서버가 읽고 계산하고 쓰는 데 수 밀리초면 끝나니까요.

편집 화면에는 이걸 쓸 수 없습니다. 사용자가 글을 여는 순간 `FOR UPDATE`를 걸면
저장 버튼을 누를 때까지 트랜잭션이 열려 있어야 합니다.

- 커넥션 하나가 그 시간 내내 묶입니다. 동시 편집자 수만큼 커넥션이 필요해집니다.
- 사용자가 탭을 닫으면 그 트랜잭션은 타임아웃이 날 때까지 남습니다.
- 잠긴 행을 건드리는 다른 작업이 줄줄이 대기합니다.

> 애플리케이션 트랜잭션을 사용자 상호작용에 걸쳐 열어두는 구조는 거의 항상 잘못된 선택입니다.
> 커넥션 풀이 마르는 사고의 흔한 원인이기도 합니다.

## 먼저 물어볼 것 — 읽고 고쳐 쓰기가 꼭 필요한가

잠금 이야기로 들어가기 전에 확인할 게 있습니다. 많은 경우 **읽기 자체를 없앨 수 있습니다.**

재고 차감은 현재 값을 읽어올 이유가 없습니다.

```sql
-- 읽고, 앱에서 계산하고, 쓴다 (경쟁 발생)
SELECT stock FROM items WHERE id = 1;
UPDATE items SET stock = ? WHERE id = 1;

-- 계산과 조건을 DB에 넘긴다 (원자적)
UPDATE items SET stock = stock - 1
 WHERE id = 1 AND stock >= 1;
```

아래 쿼리는 `stock`이 그 사이 어떻게 바뀌었든 올바르게 동작하고, 재고가 모자라면 0행을 돌려줍니다.
포인트 적립, 조회수 증가, 상태 플래그 전환처럼 **현재 값에 대한 증분이나 조건부 전이**로 표현되는 것은 전부 여기에 해당합니다.

낙관적 잠금이 필요한 건 그렇게 표현할 수 없는 경우입니다. "내가 본 이 내용을 이걸로 바꿔라" 같은,
사용자가 본 상태 자체가 요청의 전제인 수정입니다.

## 조건부 UPDATE와 버전 컬럼

전제를 `WHERE`에 넣으면 DB가 대신 확인해 줍니다.

```sql
ALTER TABLE documents
  ADD COLUMN version INT UNSIGNED NOT NULL DEFAULT 1;
```

```sql
UPDATE documents
   SET title = ?, body = ?, version = version + 1, updated_at = NOW(3)
 WHERE id = ? AND version = ?;
```

읽을 때 받은 `version`을 저장 요청에 다시 실어 보내고, 그 값이 아직 그대로일 때만 쓰기가 적용됩니다.
그 사이 누가 먼저 저장했다면 `version`이 올라가 있으므로 조건이 어긋나고 **0행이 바뀝니다.**

잠금을 잡지 않으니 대기도 없습니다. 대신 실패가 진입 시점이 아니라 **저장 시점에** 나타납니다.

### 영향 행 수를 세는 함정

`UPDATE`의 성패를 영향 행 수로 판단할 때 주의할 점이 있습니다.
MySQL의 `affected_rows`는 기본적으로 **조건에 매칭된 행 수가 아니라 실제로 값이 바뀐 행 수**입니다.

즉 조건은 맞았지만 넣으려는 값이 기존 값과 똑같으면 0이 나옵니다.
버전 조건만 넣고 `version`을 올리지 않는 구현이라면, 사용자가 아무것도 고치지 않고 저장했을 때
**충돌이 아닌데 충돌로 보고합니다.**

`version = version + 1`이 이 함정을 자동으로 피해줍니다. 버전은 매번 값이 달라지니 매칭되면 반드시 1이 나옵니다.

> 클라이언트 플래그로 매칭된 행 수를 돌려받도록 바꿀 수도 있습니다.
> 다만 드라이버와 커넥션 설정에 따라 달라지는 값에 정확성을 의존하는 것보다,
> 버전을 항상 증가시켜 애초에 모호함을 없애는 편이 안전합니다.

### 0행이 뜻하는 두 가지

0행은 "다른 사람이 먼저 고쳤다"일 수도 있고 "그 행이 지워졌다"일 수도 있습니다.
둘은 사용자에게 완전히 다른 이야기라 구분해야 합니다.

```typescript
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise';

export class ConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super('document was modified by someone else');
  }
}
export class NotFoundError extends Error {}

export async function updateDocument(
  pool: Pool,
  id: number,
  expectedVersion: number,
  patch: { title: string; body: string },
): Promise<number> {
  const [res] = await pool.execute<ResultSetHeader>(
    `UPDATE documents
        SET title = ?, body = ?, version = version + 1, updated_at = NOW(3)
      WHERE id = ? AND version = ?`,
    [patch.title, patch.body, id, expectedVersion],
  );

  if (res.affectedRows === 1) return expectedVersion + 1;

  // 0행이 나왔다. 충돌인지 삭제인지 가린다.
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT version FROM documents WHERE id = ?',
    [id],
  );
  if (rows.length === 0) throw new NotFoundError();
  throw new ConflictError(rows[0].version as number);
}
```

ORM을 쓴다면 버전 컬럼을 다루는 기능이 있는지 먼저 확인하세요.
없거나 조건을 원하는 대로 넣지 못한다면, 위처럼 조건부 `UPDATE`와 영향 행 수 확인으로 내려가는 게 확실합니다.
**추상화가 이 조건을 어떻게 SQL로 옮기는지 모르는 상태에서는 갱신 분실을 막았다고 말할 수 없습니다.**

## 무엇을 버전으로 쓸 것인가

버전 자리에 쓸 수 있는 값은 셋인데, 성질이 꽤 다릅니다.

| | 정수 카운터 | `updated_at` | 내용 해시 |
| --- | --- | --- | --- |
| 스키마 변경 | 컬럼 추가 필요 | 대개 이미 있음 | 불필요 |
| 같은 시각 두 수정 | 안전 | 정밀도에 따라 놓침 | 안전 |
| 내용이 원상복구된 경우 | 충돌로 본다 | 충돌로 본다 | 충돌 아님으로 본다 |
| 비용 | 없음 | 없음 | 매번 해시 계산 |

`updated_at`은 컬럼을 추가하지 않아도 되어 끌리지만 함정이 있습니다.
타입이 `DATETIME`(정밀도 0)이면 해상도가 1초입니다. 같은 초 안에 두 수정이 들어오면 **두 번째 수정이 충돌을 통과합니다.**
쓰려면 최소한 밀리초 이상(`DATETIME(3)`)으로 두고, 그래도 안전을 보증하지는 않는다는 점을 알고 써야 합니다.

정수 카운터는 지루하지만 이 문제가 없습니다. 값이 단조 증가하고 시계와 무관합니다.

해시 방식은 "값이 결국 같아졌으면 충돌이 아니다"라는 판단이 필요할 때만 고릅니다.
대신 어떤 필드를 해시에 넣을지를 정해야 하고, 그 목록이 곧 계약이 됩니다.

## 버전은 어디에 붙이나

행 하나만 바뀌는 수정이라면 그 행에 붙이면 됩니다. 문제는 여러 테이블이 함께 바뀌는 경우입니다.

예약 하나가 `reservations` 한 행과 `reservation_seats` 여러 행으로 이루어져 있다고 해봅시다.
좌석만 바꾸는 수정에서 좌석 행의 버전만 본다면, **좌석을 추가하는 수정과 삭제하는 수정이 서로를 못 봅니다.**

이럴 때는 함께 바뀌어야 하는 단위 전체에 버전 하나를 둡니다. 보통 그 단위의 대표 행입니다.

```sql
START TRANSACTION;

UPDATE reservations
   SET version = version + 1, updated_at = NOW(3)
 WHERE id = ? AND version = ?;
-- 여기서 0행이면 롤백하고 409

DELETE FROM reservation_seats WHERE reservation_id = ?;
INSERT INTO reservation_seats (reservation_id, seat_no) VALUES ...;

COMMIT;
```

대표 행의 `UPDATE`가 그 행에 대한 쓰기 잠금까지 겸하므로, 같은 예약을 동시에 고치는 트랜잭션은 자연스럽게 직렬화됩니다.
버전 확인과 잠금을 한 문장으로 얻는 셈입니다.

> 순서를 뒤집어 자식 행부터 고치면 두 트랜잭션이 서로 다른 순서로 잠금을 잡게 되어 데드락이 생기기 쉽습니다.
> **대표 행을 항상 먼저 잠그는 규칙**을 정해두면 이 부류가 줄어듭니다.

## 계층을 올린다 — ETag와 If-Match

버전을 응답 본문에 넣어 왕복시켜도 동작하지만, HTTP에는 이미 같은 일을 하는 표준 헤더가 있습니다.

```typescript
app.get('/documents/:id', async (req, res) => {
  const doc = await findDocument(Number(req.params.id));
  if (!doc) return res.sendStatus(404);

  res.setHeader('ETag', `"${doc.version}"`);
  res.json(doc);
});

app.put('/documents/:id', async (req, res) => {
  const ifMatch = req.header('If-Match');
  if (!ifMatch) {
    // 전제 없는 덮어쓰기를 허용하지 않겠다는 선언
    return res.status(428).json({ code: 'PRECONDITION_REQUIRED' });
  }

  const expected = Number(ifMatch.replace(/^W\/|"/g, ''));
  try {
    const next = await updateDocument(pool, Number(req.params.id), expected, req.body);
    res.setHeader('ETag', `"${next}"`);
    res.sendStatus(204);
  } catch (e) {
    if (e instanceof NotFoundError) return res.sendStatus(404);
    if (e instanceof ConflictError) {
      const current = await findDocument(Number(req.params.id));
      res.setHeader('ETag', `"${e.currentVersion}"`);
      return res.status(412).json({ code: 'PRECONDITION_FAILED', current });
    }
    throw e;
  }
});
```

얻는 게 몇 가지 있습니다.

전제가 **본문이 아니라 헤더**에 있으니 요청 스키마와 섞이지 않습니다.
프록시나 API 게이트웨이 같은 중간 계층도 이 의미를 압니다.
그리고 `If-Match` 없이 들어온 요청을 거절하면, 클라이언트가 전제를 빼먹은 채 덮어쓰는 일을 서버가 구조적으로 막습니다.

응답 코드는 두 가지가 쓰입니다. `If-Match`가 어긋났을 때는 `412`가 스펙에 맞고,
버전을 본문으로 주고받는 구조라면 `409`를 쓰는 게 보통입니다. 섞어 쓰지만 않으면 됩니다.

> `If-Match`는 강한 비교를 쓰기 때문에 `W/`가 붙은 약한 ETag는 절대 매칭되지 않습니다.
> 동시성 제어에 쓰는 ETag에는 `W/`를 붙이지 마세요. 정확한 비교 규칙은 HTTP 시맨틱스 RFC를 확인하는 편이 좋습니다.

충돌 응답에 **현재 값을 같이 실어주는 것**이 실무에서 꽤 큽니다.
클라이언트가 다시 GET을 날리지 않아도 되고, 그 사이 또 바뀌어서 두 번째 충돌이 나는 경쟁도 줄어듭니다.

## 충돌을 누가 푸는가

여기서부터는 기술이 아니라 제품 결정입니다. 충돌을 잡아냈다고 문제가 끝나지 않습니다.

서버가 자동 재시도하면 안 되는 경우가 많습니다.
최신 버전을 다시 읽어 같은 본문으로 `UPDATE`를 재시도하는 건 **덮어쓰기와 정확히 같은 동작**입니다.
낙관적 잠금을 붙여놓고 그 결과를 스스로 무효화하는 셈이죠.

재시도해도 되는 건 요청이 "현재 값 기준의 증분"으로 표현될 때뿐입니다.
그건 앞에서 본 것처럼 애초에 원자적 `UPDATE`로 쓰는 게 낫습니다.

그러면 선택지는 셋입니다.

**사용자에게 되돌린다.** 가장 정직하고 가장 흔합니다. 다만 "다른 사용자가 수정했습니다. 새로고침하세요"만 띄우면
사용자가 쓴 내용이 그대로 날아갑니다. 최소한 작성 중이던 값은 화면에 남겨두고, 가능하면 양쪽 차이를 보여줘야 합니다.

**자동 병합한다.** 필드별로 한쪽만 바꿨다면 기계적으로 합칠 수 있습니다.
같은 필드를 양쪽이 바꿨다면 그때만 사용자에게 묻습니다. 구현 비용이 올라가는 대신 충돌 체감이 크게 줄어듭니다.

**충돌이 안 나게 모델을 바꾼다.** 덧글이나 항목처럼 서로 독립적인 것을 한 문서 안에 넣어두면
관계없는 수정끼리 충돌합니다. 별도 행으로 분리하면 충돌 자체가 사라집니다.

{% comment %} TODO: 실제로 운영하는 서비스에서 충돌을 어떻게 보여주는지, 자동 병합을 넣었다면 어느 필드까지 넣었는지 적어주세요 {% endcomment %}

## 필드를 쪼개면 충돌이 줄지만

문서 전체를 `PUT`하는 대신 바뀐 필드만 `PATCH`하면 충돌 빈도가 내려갑니다.
A는 제목만, B는 본문만 고쳤다면 서로 부딪힐 이유가 없으니까요.

다만 그 대가로 **필드 사이의 불변식이 무너질 수 있습니다.**

```text
현재: start_at = 10:00, end_at = 11:00

A: start_at = 14:00 으로 변경   (A의 화면에서는 14:00~15:00)
B: end_at   = 10:30 으로 변경   (B의 화면에서는 10:00~10:30)

결과: start_at = 14:00, end_at = 10:30   ← 누구도 의도하지 않은 값
```

각 수정은 혼자서는 타당했는데 합쳐지니 말이 안 되는 상태가 됐습니다.

그래서 쪼개는 단위는 화면이 아니라 **불변식이 걸린 범위**를 따라야 합니다.
서로 제약을 주고받는 필드는 한 덩어리로 묶어 같은 버전 아래 두고, 정말 독립적인 것만 분리합니다.

## 고를 때 보는 순서

| | 비관적 잠금 | 낙관적 잠금 |
| --- | --- | --- |
| 실패가 드러나는 시점 | 진입할 때 (대기) | 저장할 때 (거부) |
| 충돌이 잦을 때 | 유리 | 헛일한 작업이 늘어남 |
| 임계 구간이 길 때 | 쓸 수 없음 | 사실상 유일한 선택 |
| 자원 점유 | 잠금·커넥션 유지 | 없음 |
| 사용자가 치르는 비용 | 기다림 | 다시 작업 |

순서는 이렇게 보면 정리됩니다.

1. **원자적 `UPDATE`로 표현되는가.** 되면 여기서 끝냅니다. 잠금도 버전도 필요 없습니다.
2. **읽기와 쓰기가 한 트랜잭션 안에 있고 짧은가.** 그러면 `FOR UPDATE`가 가장 단순합니다.
3. **사이에 사용자 시간이 끼는가.** 그러면 낙관적 잠금 외의 선택지는 없습니다.

세 번째에서 "충돌이 드물 테니 그냥 두자"로 넘어가고 싶어지는데, 그 판단의 문제는
**충돌이 나도 아무 기록이 남지 않는다**는 데 있습니다. 빈도를 알 수 없으니 넘어가도 되는지 판단할 근거도 없습니다.

버전 컬럼을 붙이고 409를 세기 시작하면 그때부터 숫자가 생깁니다.
정말 드물면 그 지표가 증명해 주고, 생각보다 잦으면 그건 원래 고쳤어야 할 문제입니다.

## 정리

- 갱신 분실은 트랜잭션이나 격리 수준으로 막히지 않습니다. 읽기와 쓰기 사이에 사용자 시간이 끼기 때문입니다.
- 증분이나 조건부 전이로 표현되는 수정은 원자적 `UPDATE`로 옮기면 경쟁 자체가 사라집니다.
- 그렇게 못 하면 버전 컬럼과 조건부 `UPDATE`를 씁니다. `version = version + 1`을 함께 넣어야 영향 행 수가 모호해지지 않습니다.
- 0행은 충돌일 수도 삭제일 수도 있으니 구분해서 응답합니다.
- 여러 행이 함께 바뀌면 버전은 대표 행 하나에 두고, 그 행을 항상 먼저 잠급니다.
- HTTP 계층에서는 `ETag`와 `If-Match`로 올리고, 충돌 응답에 현재 값을 실어 보냅니다.
- 서버의 자동 재시도는 대개 덮어쓰기와 같습니다. 충돌을 어떻게 보여줄지가 진짜 설계입니다.
