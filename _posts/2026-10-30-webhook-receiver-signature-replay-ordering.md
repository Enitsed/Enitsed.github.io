---
layout: post
title: "결제는 승인됐는데 주문은 대기 중이다 — 웹훅 수신기가 조용히 흘리는 것들"
date: 2026-10-30
tags: [backend, typescript, api, security, architecture]
excerpt: "외부 서비스가 보내는 웹훅은 우리가 만든 API와 조건이 다릅니다. 호출자를 고칠 수 없고 재전송 정책도 상대가 정합니다. 서명 검증이 원본 바이트에서 깨지는 자리, 타임스탬프 없는 서명이 재전송에 뚫리는 이유, 200을 언제 돌려줄 것인가, 4xx와 5xx를 나누지 않으면 한 건이 영원히 도는 구조, 중복과 순서 역전을 흡수하는 방법, 웹훅이 아예 오지 않을 때의 보정까지."
---

결제사 콘솔에는 승인이 찍혀 있고, 사용자는 돈이 빠져나갔다고 합니다. 그런데 우리 주문은 아직 `PENDING`입니다.

웹훅 전송 이력을 열어보면 `200 OK`가 남아 있습니다. 받기는 받았다는 뜻입니다.
받아서 아무 일도 하지 않았거나, 하다 말았거나, 두 번 받아서 서로 덮었거나 — 수신기가 틀리는 방식은 전송 이력에 남지 않습니다.

## 수신기는 우리 API와 조건이 다르다

우리가 만든 API는 클라이언트도 우리가 만듭니다. 이상하면 양쪽을 같이 고칩니다.

웹훅은 그 전제가 전부 빠집니다.

- **호출자를 고칠 수 없습니다.** 재시도 간격, 타임아웃, 동시 전송 여부 전부 상대가 정합니다.
- **응답 코드가 상대의 행동을 바꿉니다.** 우리가 무심코 돌려준 `500`이 재전송을 부르고, `400`이 그 이벤트를 영구히 버립니다.
- **같은 이벤트가 여러 번, 순서가 뒤집혀 옵니다.** 대부분의 전송은 "최소 한 번"이고, 순서 보장은 명시된 경우에만 있습니다.
- **본문을 신뢰할 근거가 요청 자체에 없습니다.** 공개된 엔드포인트라 누구나 아무 JSON이나 POST할 수 있습니다.

그래서 수신기는 "핸들러 하나 더"가 아니라 별도 조건에서 설계해야 하는 입구입니다.

## 서명이 안 맞는 가장 흔한 이유

시크릿도 맞고 알고리즘도 맞는데 서명이 틀립니다. 대개 **비교 대상이 원본 바이트가 아닌 경우**입니다.

서명은 상대가 보낸 바이트열 그대로에 HMAC을 걸어 만든 값입니다. 그런데 보통의 프레임워크는 핸들러에 닿기 전에 JSON을 파싱해 객체로 바꿔버립니다.
그 객체를 다시 `JSON.stringify`로 직렬화하면 **원본과 바이트가 달라집니다.**

- 공백과 개행 문자가 사라집니다.
- 키 순서가 보장되지 않습니다.
- 비ASCII 문자나 이스케이프 표기가 달라질 수 있습니다.
- 숫자 표기가 정규화됩니다 (`1.0` → `1`, `1e3` → `1000`).

하나만 달라도 해시는 전혀 다른 값이 됩니다. 그래서 파싱 전에 원본 버퍼를 따로 들고 있어야 합니다.

```typescript
import express from "express";
import crypto from "node:crypto";

const app = express();

// 웹훅 경로에만, 원본 바이트를 따로 보관하면서 파싱한다
app.use(
  "/webhooks",
  express.json({
    limit: "256kb",
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);
```

> 전역에 `express.json()`을 먼저 걸어두면 웹훅 경로의 본문은 이미 그 미들웨어가 소비해버립니다. 뒤에 붙인 `verify`는 호출되지 않고 `rawBody`는 `undefined`가 됩니다. 라우트별 파서를 전역 파서보다 **앞에** 두거나, 전역 파서에서 웹훅 경로를 제외하세요. 프레임워크마다 원본 본문을 꺼내는 옵션이 따로 있으니 쓰는 쪽 문서를 확인하는 게 빠릅니다.

검증 함수는 이렇게 됩니다.

```typescript
function verifySignature(raw: Buffer, given: string, secret: string): boolean {
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");

  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");

  // 길이가 다르면 timingSafeEqual은 예외를 던진다. 먼저 걸러야 한다
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}
```

`===`로 비교하지 않는 이유는 문자열 비교가 처음 다른 바이트에서 즉시 끝나기 때문입니다. 비교에 걸린 시간이 "몇 바이트까지 맞았는가"를 흘립니다.
`crypto.timingSafeEqual`은 길이가 같은 동안 일정 시간으로 비교합니다. 대신 **길이가 다르면 던지므로** 그 앞에 길이 검사가 필요합니다.

서명 대상 문자열을 어떻게 조립하는지는 공급자마다 다릅니다. 타임스탬프와 본문을 특정 구분자로 이어 붙이는 방식이 흔하고, 헤더 이름과 버전 접두사도 제각각입니다.
**이 조립 규칙은 추측하지 말고 해당 공급자 문서의 예시와 바이트 단위로 맞춰보세요.** 여기서 한 글자 틀리면 "시크릿이 잘못됐다"로 오진하게 됩니다.

## 서명만으로는 재전송을 막지 못한다

서명이 유효한 요청을 그대로 복사해 다시 보내면, 서명도 그대로 유효합니다.

중간에서 요청을 한 번이라도 볼 수 있었다면 — 로그 수집기, 프록시, 예전에 켜둔 디버그 덤프 — 그 요청은 언제든 재생할 수 있는 유효한 요청입니다.
환불 이벤트 하나를 열 번 재생하면 어떻게 되는지가 바로 이 구멍의 크기입니다.

그래서 서명 대상에 타임스탬프가 포함되고, 수신 측은 그 값이 현재 시각에서 너무 멀면 거부합니다.

```typescript
const TOLERANCE_SEC = 300;

function withinTolerance(tsHeader: string | undefined, nowMs = Date.now()): boolean {
  const ts = Number(tsHeader);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(nowMs / 1000 - ts) <= TOLERANCE_SEC;
}
```

허용 폭은 트레이드오프입니다. 좁히면 재생 창이 줄지만 시계 오차와 정상적인 재전송 지연에 걸려 멀쩡한 이벤트를 버립니다.
넓히면 그 시간만큼 재생이 가능합니다. 이 값은 뒤에 나오는 이벤트 ID 멱등 처리와 **같이** 걸어야 의미가 있습니다. 중복 흡수가 되어 있으면 재생된 요청도 두 번째부터는 아무 일도 하지 않습니다.

> IP 허용목록은 보조 수단으로만 쓰세요. 공급자 쪽 송신 IP는 공지 없이 늘어나는 일이 있고, 그때 조용히 전부 거부되기 시작합니다. 서명이 본선이고 IP는 덤입니다.

한 가지 더, 웹훅 경로는 전역 인증 미들웨어에서 빼야 합니다. 토큰을 요구하는 가드에 웹훅이 걸리면 상대는 `401`을 계속 받다가 정책대로 재전송을 멈춥니다.
이 경우 우리 쪽 에러 로그에는 "인증 실패"만 남아서, 결제 이벤트가 유실되고 있다는 사실과 연결되지 않습니다.

## 200을 언제 돌려줄 것인가

수신 핸들러에서 주문 상태를 바꾸고, 재고를 차감하고, 영수증 메일을 보내고 나서 `200`을 돌려주는 코드가 가장 흔합니다. 그리고 가장 먼저 무너집니다.

송신 측 타임아웃은 짧습니다. 처리에 그 시간을 넘기면 상대는 실패로 간주하고 재전송합니다.
우리 입장에서는 **처리는 계속 돌고 있는데 같은 이벤트가 또 들어오는** 상태가 됩니다. 처리가 느려질수록 재전송이 늘고, 재전송이 늘면 더 느려집니다.

| | 끝까지 처리하고 200 | 접수만 하고 200 |
| --- | --- | --- |
| 응답 시간 | 처리 시간에 비례 | 쓰기 한 번 |
| 처리가 느릴 때 | 재전송이 겹쳐 증폭 | 영향 없음 |
| 실패 재시도 | 상대의 정책에 의존 | 우리가 제어 |
| 실패를 아는 시점 | 응답에서 바로 | 별도 지표 필요 |
| 구현 비용 | 핸들러 하나 | 테이블 + 워커 |

접수만 하고 `200`을 돌려주는 쪽이 운영하기 쉽습니다. 다만 **실패가 응답에서 사라지므로** 밀린 건수를 보는 지표가 반드시 같이 있어야 합니다. 그게 없으면 조용히 쌓입니다.

```typescript
app.post("/webhooks/payments", async (req, res) => {
  const raw = (req as express.Request & { rawBody?: Buffer }).rawBody;
  if (!raw) return res.status(400).send("raw body missing");

  if (!withinTolerance(req.header("x-timestamp"))) {
    return res.status(400).send("stale timestamp");
  }
  if (!verifySignature(raw, req.header("x-signature") ?? "", SECRET)) {
    return res.status(401).send("bad signature");
  }

  const result = await enqueue({
    provider: "pg",
    eventId: req.body.id,              // 공급자가 부여한 이벤트 식별자
    type: req.body.type,
    occurredAt: req.body.created_at,
    payload: req.body,
  });

  // 중복이어도 200. 상대가 재전송을 멈추게 하는 게 목적이다
  res.status(result === "NEW" ? 202 : 200).end();
});
```

## 4xx와 5xx를 나누지 않으면 한 건이 영원히 돈다

응답 코드는 보고가 아니라 **상대에게 내리는 지시**입니다.

| 상황 | 응답 | 상대의 행동 | 우리가 원하는 것 |
| --- | --- | --- | --- |
| 서명 불일치 | 4xx | 재전송 안 함 | 맞다. 재전송해도 또 틀린다 |
| 본문 파싱 실패 | 4xx | 재전송 안 함 | 맞다. 같은 본문은 또 실패한다 |
| 모르는 이벤트 타입 | 2xx | 성공 처리 | 맞다. 우리가 안 쓰는 타입이다 |
| 중복 이벤트 | 2xx | 성공 처리 | 맞다. 이미 처리했다 |
| DB 일시 장애 | 5xx | 재전송 | 맞다. 다음엔 될 수 있다 |
| 우리 코드 버그 | 5xx | 재전송 | **틀렸다.** 고칠 때까지 계속 돈다 |

마지막 줄이 실제로 사고가 나는 자리입니다. 처리 로직의 버그로 예외가 나면 영원히 실패하는 이벤트가 상대의 재전송 정책이 끝날 때까지 계속 들어옵니다.
그동안 우리 에러 로그는 같은 스택 트레이스로 가득 차고, 그 사이에 섞인 다른 이벤트의 실패는 묻힙니다.

접수와 처리를 분리하면 이 구분이 자연스럽게 정리됩니다. 입구에서는 **"이 요청이 우리가 받아도 되는 요청인가"**만 판단하고, 처리 실패는 우리 워커의 재시도와 보류 큐가 맡습니다.
입구에서 `5xx`가 나가야 하는 경우는 접수 자체가 실패했을 때, 즉 저장을 못 했을 때로 좁아집니다.

## 같은 이벤트가 두 번, 다른 순서로 온다

중복은 막는 게 아니라 흡수합니다. 기준은 공급자가 부여한 이벤트 ID이고, 흡수 지점은 유니크 제약입니다.

```sql
CREATE TABLE webhook_event (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider      VARCHAR(32)     NOT NULL,
  event_id      VARCHAR(128)    NOT NULL,
  event_type    VARCHAR(64)     NOT NULL,
  occurred_at   DATETIME(3)     NULL,
  payload       JSON            NOT NULL,
  status        VARCHAR(16)     NOT NULL DEFAULT 'RECEIVED',
  attempts      INT UNSIGNED    NOT NULL DEFAULT 0,
  last_error    TEXT            NULL,
  received_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at  DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_provider_event (provider, event_id),
  KEY ix_status_received (status, received_at)
) ENGINE=InnoDB;
```

`provider`를 키에 같이 넣는 이유는 공급자가 둘 이상이 되는 순간 이벤트 ID가 충돌할 수 있기 때문입니다. 나중에 겪고 나서 고치기엔 번거로운 자리입니다.

```typescript
const ER_DUP_ENTRY = 1062;

async function enqueue(e: ReceivedEvent): Promise<"NEW" | "DUPLICATE"> {
  try {
    await db.query(
      `INSERT INTO webhook_event
         (provider, event_id, event_type, occurred_at, payload)
       VALUES (?, ?, ?, ?, ?)`,
      [e.provider, e.eventId, e.type, e.occurredAt, JSON.stringify(e.payload)],
    );
    return "NEW";
  } catch (err) {
    if ((err as { errno?: number }).errno === ER_DUP_ENTRY) return "DUPLICATE";
    throw err;
  }
}
```

"있는지 보고 없으면 넣는다"로 쓰지 않는 이유는, 재전송이 동시에 두 개 들어오면 둘 다 "없다"를 보기 때문입니다.
**유니크 제약이 판정하게 하고 중복 키 예외를 정상 흐름으로 받는 쪽**이 동시성에 안전합니다.

### 순서 역전

더 까다로운 건 순서입니다. `payment.captured`가 먼저 도착하고 `payment.authorized`가 나중에 오는 일이 실제로 생깁니다.
이벤트 하나하나를 "현재 상태를 이 이벤트의 상태로 덮는다"로 처리하면, 늦게 온 과거 이벤트가 최신 상태를 되돌립니다.

받는 쪽에서 쓸 수 있는 방법은 두 가지입니다.

첫째, 전이 규칙을 명시해 불가능한 전이를 버립니다.

```typescript
const ALLOWED: Record<PaymentStatus, PaymentStatus[]> = {
  PENDING:    ["AUTHORIZED", "FAILED", "CANCELED"],
  AUTHORIZED: ["CAPTURED", "CANCELED"],
  CAPTURED:   ["REFUNDED", "PARTIALLY_REFUNDED"],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  FAILED:     [],
  CANCELED:   [],
  REFUNDED:   [],
};

function canApply(from: PaymentStatus, to: PaymentStatus): boolean {
  return from === to || ALLOWED[from].includes(to);
}
```

`from === to`를 허용에 넣어둔 건 중복 이벤트가 재처리될 때 "불가능한 전이"로 오판되지 않게 하기 위함입니다. 같은 상태로의 전이는 아무것도 바꾸지 않고 성공으로 끝나야 합니다.

둘째, 단조성을 조건에 넣어 한 문장으로 처리합니다.

```sql
UPDATE payment
   SET status = ?, status_changed_at = ?
 WHERE id = ?
   AND status_changed_at < ?;
```

갱신된 행이 0이면 더 최신 이벤트가 이미 반영된 상태입니다. 다만 여기 쓰는 시각은 **상대 시스템의 시계**이고, 밀리초가 같은 두 이벤트는 구분되지 않습니다.
공급자가 단조 증가하는 시퀀스를 같이 준다면 그걸 쓰는 편이 안전합니다. 없다면 전이 규칙 쪽이 더 믿을 만합니다.

## 페이로드를 얼마나 믿을 것인가

본문에 금액이 들어 있으면 그대로 쓰고 싶어집니다. 조회 한 번을 아낄 수 있으니까요.

문제는 그 값이 **우리 DB로 들어가는 외부 입력**이라는 점입니다. 서명 검증은 "이 바이트가 공급자에게서 왔다"까지만 보장하고, 재생된 과거 요청도 그 검증을 통과합니다.

그래서 금액, 상태, 소유권처럼 틀리면 돈이 움직이는 값은 알림으로만 받고 조회로 확정하는 편이 낫습니다.

```typescript
// 웹훅은 "뭔가 바뀌었다"는 신호로 쓰고, 값은 조회로 확정한다
const fresh = await pg.getPayment(event.payload.payment_id);

if (fresh.orderId !== order.id) {
  throw new Error(`payment ${fresh.id} does not belong to order ${order.id}`);
}
if (fresh.amount !== order.amount || fresh.currency !== order.currency) {
  await flagForManualReview(order.id, { expected: order.amount, actual: fresh.amount });
  return;
}
await applyStatus(order, fresh.status);
```

`orderId` 대조가 들어간 이유는, 이벤트 ID만 보면 **남의 결제 이벤트**로 내 주문을 완료시킬 수 있기 때문입니다.
외부에서 받은 식별자는 항상 우리 쪽 레코드와의 소유 관계를 확인하고 써야 합니다.

조회를 한 번 더 하는 비용은 생깁니다. 공급자 API 호출 실패에도 대비해야 하고요.
그래도 상태 변경이 돈과 연결되는 이벤트라면 이쪽이 맞습니다. 로그인 알림처럼 틀려도 되돌릴 수 있는 이벤트는 페이로드를 그대로 써도 무리가 없습니다.

## 웹훅이 아예 오지 않을 때

여기까지 다 해도 남는 경우가 있습니다. 상대 쪽 장애, 우리 쪽 배포 중 다운타임, 재전송 정책 소진.

웹훅만으로 상태를 맞추려 하면 이 구멍은 메울 수 없습니다. **밀린 것을 찾아내는 잡**이 따로 필요합니다.

```sql
-- 접수됐지만 처리되지 않은 채 오래 머문 이벤트
SELECT id, provider, event_id, event_type, attempts, last_error
  FROM webhook_event
 WHERE status IN ('RECEIVED', 'FAILED')
   AND received_at < NOW(3) - INTERVAL 5 MINUTE
 ORDER BY received_at
 LIMIT 200;
```

이건 접수는 됐는데 처리가 막힌 건을 찾습니다. 애초에 도착하지 않은 건은 우리 테이블에 없으니 이 쿼리로는 보이지 않습니다.
그쪽은 **우리 레코드를 기준으로** 찾아야 합니다. 생성된 지 일정 시간이 지났는데도 중간 상태에 머물러 있는 결제를 골라 공급자 API로 직접 확인하는 방식입니다.

```sql
SELECT id, pg_payment_id, created_at
  FROM payment
 WHERE status = 'PENDING'
   AND created_at BETWEEN NOW() - INTERVAL 1 DAY AND NOW() - INTERVAL 10 MINUTE
 ORDER BY created_at
 LIMIT 500;
```

이 잡은 거의 항상 0건을 돌려줍니다. 그게 정상이고, 0건이 아닌 날을 잡기 위해 둡니다.
그리고 이 경로는 웹훅 처리와 **같은 함수**를 호출해야 합니다. 보정용 코드를 따로 쓰면 둘의 동작이 서서히 갈라지고, 하필 사고 날 때 보정 쪽만 틀립니다.

## 무엇을 보고 알 수 있나

수신기는 조용히 고장 나는 종류의 컴포넌트입니다. 응답은 `200`이고 에러 로그도 깨끗한데 아무 일도 일어나지 않습니다.

최소한 이 네 가지는 보고 있어야 합니다.

- **접수 대비 처리 완료 건수.** 벌어지기 시작하면 워커가 막힌 것입니다.
- **가장 오래 밀린 미처리 이벤트의 나이.** 건수보다 이게 먼저 움직입니다.
- **서명 실패율.** 평소 0에 가깝다가 갑자기 전부 실패하면 시크릿 회전이나 파서 변경을 의심합니다.
- **보정 잡이 고친 건수.** 0이 아니면 웹훅 경로에 뭔가 새고 있다는 뜻입니다.

로그에는 이벤트 ID, 타입, 판정 결과만 남기세요. 본문 전체를 찍으면 카드 정보나 개인정보가 로그 저장소로 흘러가고, 서명 헤더를 찍으면 재생에 필요한 재료를 같이 남기게 됩니다.

## 체크리스트

- 원본 바이트를 파싱 전에 확보했는가. 전역 파서가 먼저 소비하지 않는가
- 서명 비교가 상수 시간인가. 길이 검사가 그 앞에 있는가
- 타임스탬프 허용 폭이 있는가. 이벤트 ID 멱등과 같이 걸려 있는가
- 웹훅 경로가 전역 인증 가드에서 빠져 있는가
- 응답 코드가 상대의 재전송 여부를 의도대로 지시하는가
- 중복 판정이 유니크 제약인가, 조회 후 삽입인가
- 순서 역전을 전이 규칙이나 단조성 조건으로 막고 있는가
- 외부 식별자를 쓸 때 우리 레코드와의 소유 관계를 확인하는가
- 도착하지 않은 이벤트를 우리 레코드 기준으로 찾는 잡이 있는가
- 밀린 이벤트의 나이를 보는 지표가 있는가

{% comment %} TODO: 실제로 연동했던 공급자에서 겪은 문제(서명 조립 규칙, 재전송 정책, 순서 역전 사례)가 있으면 여기에 적어주세요 {% endcomment %}
