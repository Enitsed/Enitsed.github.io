---
layout: post
title: "결제 API에 멱등키 붙이기 — 타임아웃 한 번이 중복 결제가 되기까지"
date: 2026-09-12
tags: [backend, api, typescript, mysql]
excerpt: "재시도 한 번이 어떻게 두 번의 결제가 되는가. 멱등키를 누가 언제 만드는지, 유니크 제약으로 저장하는 법, 진행 중 요청 처리와 응답 재생, 보관 기간의 트레이드오프까지."
---

사용자 화면에는 타임아웃이 떴는데 서버 로그에는 승인 성공이 찍혀 있습니다.
사용자는 실패한 줄 알고 버튼을 다시 누르고, 카드는 두 번 긁힙니다.

재시도를 없애는 건 답이 아닙니다. 네트워크는 계속 끊길 것이고 클라이언트는 계속 다시 보낼 것이기 때문입니다.
두 번 들어와도 한 번만 일어나게 만드는 쪽이 유일하게 성립하는 방향입니다.

## 응답이 유실되는 경로

서버 쪽에서 보면 실패는 두 종류인데, 클라이언트 쪽에서는 둘의 겉모습이 같습니다.

- **요청이 서버에 닿지 못한 실패** — 아무 일도 일어나지 않았다
- **응답이 클라이언트에 닿지 못한 실패** — 이미 다 일어났다

끊긴 소켓에서 얻을 수 있는 정보는 "응답이 없다"뿐이고, 여기서 둘을 구분할 방법은 없습니다.
그래서 안전한 클라이언트는 재시도하고, 재시도는 두 번째 실행이 됩니다.

응답이 사라지는 경로는 생각보다 많습니다.

- 사용자가 버튼을 두 번 누른다
- 앱이 백그라운드로 갔다 돌아오며 요청을 다시 건다
- 로드밸런서나 API 게이트웨이가 자체 타임아웃 후 업스트림에 재시도한다
- HTTP 클라이언트 라이브러리의 기본 재시도 설정이 켜져 있다
- 모바일 네트워크가 LTE와 와이파이 사이에서 전환된다

**마지막 두 개가 특히 곤란합니다.** 애플리케이션 코드에는 재시도를 넣은 적이 없는데도 요청이 두 번 도착합니다.

이 중 무엇도 막을 수 없으니, 요청 자체가 "이건 아까 그 시도"라는 정보를 들고 와야 합니다. 그게 멱등키입니다.

## 키는 클라이언트가 만든다

서버가 키를 만들면 아무것도 해결되지 않습니다. 재시도할 때마다 새 키가 발급되니 서버는 여전히 매번을 처음으로 봅니다.
**키를 만드는 주체는 재시도를 가로지르며 기억할 수 있는 쪽**, 즉 클라이언트여야 합니다.

그러면 언제 만드는가가 다음 질문이 되고, 여기서 대부분의 버그가 생깁니다.

| 키를 만드는 시점 | 재시도에서 같은가 | 문제 |
| --- | --- | --- |
| HTTP 요청 직전 매번 | 아니다 | 재시도마다 새 결제가 된다 |
| 결제 시도를 시작할 때 한 번 | 같다 | 의도한 동작 |
| 사용자 ID + 금액 해시 | 같다 | 같은 금액을 일부러 두 번 결제할 수 없다 |

키의 수명은 **"사용자의 결제 의도 한 번"**에 맞춥니다. 결제 화면에 들어갈 때 만들고, 성공하거나 사용자가 명시적으로 취소할 때까지 같은 값을 씁니다.

```typescript
// 결제 시도 단위로 한 번만 만들고, 재시도에서는 그대로 다시 쓴다
const idempotencyKey = crypto.randomUUID();

async function requestPayment(body: PaymentRequest) {
  return withRetry(() =>
    fetch("/payments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey, // 재시도해도 같은 값
      },
      body: JSON.stringify(body),
    }),
  );
}
```

> 브라우저의 `crypto.randomUUID()`는 보안 컨텍스트(HTTPS 또는 localhost)에서만 제공됩니다.
> 사내망 HTTP 환경이라면 폴백을 준비해두세요.

재시도를 화면 새로고침이나 앱 재실행 너머까지 이어가려면 키를 로컬에 저장해야 합니다.
여기까지 갈지는 서비스 성격에 따라 갈리는데, 판단 기준은 하나입니다. **사용자가 "결제됐나?" 하고 같은 화면에 다시 들어올 수 있다면 저장해야 합니다.**

## 저장은 유니크 제약으로

서버 구현을 "키가 있는지 조회하고, 없으면 삽입한다"로 짜면 아무것도 막지 못합니다.
동시에 도착한 두 요청은 둘 다 조회에서 "없음"을 보고 둘 다 진행합니다. 창이 좁을 뿐 확실히 열려 있습니다.

**실제 방어선은 데이터베이스의 유니크 제약입니다.** 먼저 삽입을 시도하고, 삽입이 실패하는 쪽이 자신이 두 번째임을 알게 하는 순서로 뒤집습니다.

```sql
CREATE TABLE idempotency_keys (
  user_id       BIGINT            NOT NULL,
  endpoint      VARCHAR(128)      NOT NULL,
  idem_key      VARCHAR(64)       NOT NULL,
  request_hash  CHAR(64)          NOT NULL,
  state         ENUM('IN_PROGRESS','COMPLETED') NOT NULL,
  resource_id   VARCHAR(64)       NULL,
  response_code SMALLINT UNSIGNED NULL,
  response_body JSON              NULL,
  lease_until   DATETIME(3)       NULL,
  created_at    DATETIME(3)       NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, endpoint, idem_key),
  KEY idx_created_at (created_at)
) ENGINE=InnoDB;
```

기본 키를 `(user_id, endpoint, idem_key)`로 잡은 게 이 스키마에서 가장 중요한 결정입니다.

키를 **전역 유일**로 잡으면, 다른 사용자가 우연히 또는 의도적으로 같은 값을 보냈을 때 남의 응답이 재생됩니다.
결제 응답에는 주문 정보가 들어 있으니 이건 그냥 정보 유출입니다. 키의 유효 범위는 반드시 **사용자 단위**로 좁힙니다.

`endpoint`를 넣은 이유도 비슷합니다. 클라이언트가 결제와 환불에 같은 키를 재사용하는 실수를 하면, 범위가 나뉘어 있지 않은 한 환불 요청이 결제 응답을 받아갑니다.

`request_hash`는 같은 키로 **다른 내용**이 들어왔을 때를 위한 것입니다. 10,000원으로 시작한 키가 50,000원짜리 요청을 들고 다시 오면, 이건 재시도가 아니라 클라이언트 버그입니다.
조용히 첫 응답을 재생하면 버그가 숨고, 나중에 훨씬 이해하기 어려운 형태로 드러납니다.

## 처리 흐름

들어온 요청은 네 갈래 중 하나입니다.

```typescript
type Begin =
  | { kind: "fresh" }                                       // 처음 보는 키
  | { kind: "in_progress" }                                 // 다른 요청이 처리 중
  | { kind: "replay"; status: number; body: unknown }       // 이미 끝난 요청
  | { kind: "mismatch" };                                   // 같은 키, 다른 내용
```

삽입을 먼저 시도하고, 중복 키 오류를 잡아서 분기합니다.

```typescript
const LEASE_SECONDS = 30;

async function begin(conn: Connection, ctx: Ctx): Promise<Begin> {
  try {
    await conn.execute(
      `INSERT INTO idempotency_keys
         (user_id, endpoint, idem_key, request_hash, state, lease_until)
       VALUES (?, ?, ?, ?, 'IN_PROGRESS', NOW(3) + INTERVAL ? SECOND)`,
      [ctx.userId, ctx.endpoint, ctx.key, ctx.hash, LEASE_SECONDS],
    );
    return { kind: "fresh" };
  } catch (e: any) {
    if (e?.code !== "ER_DUP_ENTRY") throw e; // 중복 키가 아니면 진짜 오류
  }

  const [rows] = await conn.execute(
    `SELECT request_hash, state, response_code, response_body
       FROM idempotency_keys
      WHERE user_id = ? AND endpoint = ? AND idem_key = ?`,
    [ctx.userId, ctx.endpoint, ctx.key],
  );

  const row = (rows as any[])[0];
  if (!row) return { kind: "in_progress" }; // 정리 배치와 겹친 희귀 경우
  if (row.request_hash !== ctx.hash) return { kind: "mismatch" };
  if (row.state !== "COMPLETED") return { kind: "in_progress" };

  return { kind: "replay", status: row.response_code, body: row.response_body };
}
```

> PostgreSQL이라면 `INSERT ... ON CONFLICT DO NOTHING`에 `RETURNING`을 붙여 한 번에 판정할 수 있습니다.
> 예외로 잡는다면 유니크 위반 코드는 `23505`입니다.

요청 지문은 **받은 원문 바이트**로 계산해야 합니다.
파싱한 객체를 `JSON.stringify`로 되돌리면 키 순서나 숫자 표기가 달라져, 같은 요청인데 지문이 바뀌는 일이 생깁니다.

```typescript
import { createHash } from "node:crypto";

// 원문을 보존해둔다
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

const fingerprint = (raw: Buffer) =>
  createHash("sha256").update(raw).digest("hex");
```

핸들러는 분기 결과를 그대로 응답으로 옮깁니다.

```typescript
app.post("/payments", async (req: any, res) => {
  const key = req.get("Idempotency-Key");
  if (!key) {
    return res.status(400).json({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  }

  const ctx = {
    userId: req.user.id,
    endpoint: "POST /payments",
    key,
    hash: fingerprint(req.rawBody),
  };

  const r = await begin(conn, ctx);

  switch (r.kind) {
    case "mismatch":
      return res.status(422).json({ code: "IDEMPOTENCY_KEY_REUSED" });

    case "in_progress":
      return res
        .set("Retry-After", "1")
        .status(409)
        .json({ code: "REQUEST_IN_PROGRESS" });

    case "replay":
      return res
        .set("Idempotent-Replayed", "true") // 표준이 아니라 관례
        .status(r.status)
        .json(r.body);

    case "fresh":
      return await handlePayment(req, res, ctx); // 끝나면 COMPLETED로 갱신
  }
});
```

## 처리 중인 요청에 무엇을 돌려줄까

첫 요청이 아직 외부 결제사 응답을 기다리는 사이에 재시도가 도착하면, 선택지는 둘입니다.

**기다리게 한다**: 첫 요청이 끝날 때까지 붙잡고 있다가 같은 응답을 준다. 클라이언트 코드는 단순해지지만, 서버 커넥션이 묶입니다.
결제사가 느려지는 순간 대기 중인 요청이 같이 쌓이고, 느려짐이 곧 커넥션 고갈이 됩니다.

**즉시 409로 돌려보낸다**: 서버가 자원을 붙들지 않습니다. 대신 클라이언트가 이 응답을 제대로 해석해야 합니다.

대개 두 번째가 낫습니다. 다만 여기에 **가장 흔한 구현 실수**가 붙어 있습니다.

> 409를 받은 클라이언트가 "결제 실패"를 사용자에게 보여주면 안 됩니다.
> 409는 "당신의 결제가 지금 처리 중"이라는 뜻이고, 올바른 동작은 잠시 뒤 같은 키로 다시 물어보는 것입니다.

서버 팀과 클라이언트 팀이 다르면 이 의미는 반드시 문서로 남겨야 합니다. 상태 코드만 정해두면 절반은 실패로 처리합니다.

### 좀비 IN_PROGRESS

`IN_PROGRESS`를 써두고 서버가 죽으면 그 키는 영원히 잠깁니다. 사용자는 몇 번을 다시 눌러도 409만 받습니다.
`lease_until`은 이걸 풀기 위한 것입니다. 리스가 만료된 레코드는 다음 요청이 회수해서 자기 것으로 만듭니다.

```sql
UPDATE idempotency_keys
   SET request_hash = ?, lease_until = NOW(3) + INTERVAL 30 SECOND
 WHERE user_id = ? AND endpoint = ? AND idem_key = ?
   AND state = 'IN_PROGRESS'
   AND lease_until < NOW(3);
```

**회수는 공짜가 아닙니다.** 첫 요청이 죽은 게 아니라 그냥 느린 것뿐이었다면, 회수하는 순간 같은 결제가 두 번 진행됩니다.
그래서 리스 시간은 정상 처리 최대 시간보다 넉넉하게 잡고, 여기를 최종 방어선으로 삼지 않습니다.

## 멱등키 테이블은 최종 방어선이 아니다

이 구조의 진짜 어려운 지점은 따로 있습니다. **외부 결제사 호출은 우리 DB 트랜잭션 안에 들어오지 않습니다.**

트랜잭션을 열고, 외부 호출을 하고, 결과를 쓰고 커밋하는 순서로 짜면 이렇게 됩니다.
외부 승인은 성공했는데 커밋 직전에 프로세스가 죽으면, 우리 DB에는 아무 흔적이 없고 카드사에는 승인이 남습니다.
다음 요청은 키를 찾지 못하고 다시 승인합니다.

그래서 순서를 이렇게 갈라둡니다.

1. `IN_PROGRESS` 레코드와 **주문번호를 먼저 커밋**한다
2. 그 주문번호로 외부 결제사를 호출한다
3. 결과를 받아 `COMPLETED`로 갱신한다

1번이 커밋돼 있으면, 2번과 3번 사이에서 죽어도 "이 주문번호로 승인을 시도했다"는 사실은 남습니다.
복구는 그 주문번호로 결제사에 조회해서 실제 상태를 맞추는 대사(reconciliation) 작업이 맡습니다. **이 배치가 없으면 위 구조는 절반만 동작합니다.**

여기서 한 번 더 중요한 게 주문번호를 **멱등키에서 결정론적으로 파생**시키는 것입니다.

```typescript
// 같은 멱등키 → 항상 같은 주문번호
const merchantOrderId = `ord_${createHash("sha256")
  .update(`${userId}:${idemKey}`)
  .digest("hex")
  .slice(0, 24)}`;
```

재시도가 몇 번을 들어와도 결제사에 가는 주문번호가 같아집니다.
결제 대행사는 대개 상점 주문번호의 중복을 거절하므로, 우리 테이블이 통째로 사라져도 마지막 한 겹이 남습니다.
다만 중복 주문번호를 어떻게 처리하는지는 대행사마다 다르니 **연동하는 곳의 문서에서 확인하세요.** 결제사가 자체 멱등키 헤더를 지원한다면 그쪽을 쓰는 게 더 낫습니다.

도메인 테이블에도 제약을 하나 겁니다.

```sql
ALTER TABLE payments
  ADD COLUMN idem_key VARCHAR(64) NOT NULL,
  ADD UNIQUE KEY uk_payments_idem (user_id, idem_key);
```

멱등키 테이블이 앞에서 걸러주는 건 대부분의 경우이고, 이 제약은 그걸 통과한 예외를 막습니다.
방어선을 두 겹으로 두는 이유는, 앞 절에서 본 리스 회수처럼 **앞단이 원리적으로 틀릴 수 있는 구간**이 남아 있기 때문입니다.

## 응답 재생이 돌려주는 것

재생되는 건 **그때의 응답**이지 지금의 상태가 아닙니다.

결제가 성공한 뒤 환불됐더라도, 같은 키로 다시 요청하면 저장해둔 201과 그때의 본문이 나갑니다.
이상해 보이지만 이게 맞습니다. 멱등성은 "같은 요청은 같은 결과"를 보장하는 것이지 최신 상태 조회가 아닙니다. 최신 상태가 필요하면 클라이언트는 `GET`으로 물어야 합니다.

실패 응답을 저장할지는 나눠서 정합니다.

- **5xx와 타임아웃** — 저장하지 않고 키를 풀어줍니다. 재시도가 의미 있으려면 다시 시도할 수 있어야 합니다.
- **400·422 같은 요청 자체의 오류** — 저장하지 않습니다. 저장해두면 클라이언트가 본문을 고쳐 보내도 지문 불일치로 막혀 영영 진행이 안 됩니다.
- **한도 초과, 잔액 부족 같은 도메인 실패** — 저장합니다. 재시도해도 결과가 같고, 결제사 쪽에서는 승인 시도가 실제로 한 번 일어났을 수 있습니다.

경계가 애매한 케이스가 반드시 생기니, 팀에서 한 번 정하고 API 문서에 적어두는 편이 낫습니다.

## 보관 기간

키를 얼마나 들고 있을지는 양쪽으로 비용이 있습니다.

짧으면 늦게 도착한 재시도가 **새 결제**가 됩니다. 길면 테이블이 계속 커지고, 결제 경로의 모든 요청이 지나가는 테이블이라 그 자체로 부담이 됩니다.

기준은 시간이 아니라 **클라이언트가 같은 키를 다시 보낼 수 있는 최대 창**입니다.
앱이 키를 로컬에 저장했다가 사용자가 다음 날 앱을 열었을 때 재시도한다면, 서버 보관 기간이 그보다 짧으면 의미가 없습니다.
그래서 앱의 키 수명과 서버 보관 기간은 **같이 정해야 하는 한 쌍**입니다.

정리는 한 문장으로 크게 지우지 말고 쪼개서 반복합니다.

```sql
DELETE FROM idempotency_keys
 WHERE created_at < NOW() - INTERVAL 3 DAY
 ORDER BY created_at
 LIMIT 2000;
```

큰 삭제 한 방은 긴 트랜잭션과 복제 지연을 만듭니다. 작게 여러 번이 낫고, 이 방식은 중간에 멈춰도 다음 실행이 이어서 합니다.

### Redis로 하면 안 되나

`SET key value NX PX`는 한 줄로 끝나서 매력적이고, 실제로 앞단 필터로는 좋습니다.

다만 두 가지를 감안해야 합니다. 메모리 압박에 따른 축출이나 페일오버로 **키가 예정보다 먼저 사라질 수 있고**, 응답 본문 재생을 하려면 직렬화와 크기 관리를 직접 해야 합니다.
정확성이 곧 돈인 경로라면 판정 근거는 영속 저장소에 두고, 최종 유일성은 앞서 본 도메인 유니크 제약에 맡기는 편이 안전합니다.

## HTTP 표현

헤더 이름은 `Idempotency-Key`가 사실상의 관례이고, IETF HTTPAPI 워킹그룹에서 표준화 초안(Internet-Draft)이 진행 중입니다.
**아직 RFC로 확정된 스펙이 아닙니다.** 이름과 기본 발상은 널리 쓰여 안정적이지만, 오류 응답 형식 같은 세부는 개정될 수 있으니 확정 스펙처럼 못 박지 말고 현행 초안을 확인하세요.

멱등키가 필요한 건 `POST`와 `PATCH`입니다. `GET`·`PUT`·`DELETE`는 메서드 정의상 이미 멱등하므로 키를 요구할 이유가 없습니다.

상태 코드에는 합의된 정답이 없습니다. 이 글에서 고른 조합은 이렇습니다.

| 상황 | 응답 | 클라이언트가 할 일 |
| --- | --- | --- |
| 키 누락·형식 오류 | 400 | 고쳐서 새 키로 다시 |
| 같은 키가 처리 중 | 409 + `Retry-After` | 잠시 뒤 같은 키로 재시도 |
| 같은 키, 다른 본문 | 422 | 버그. 새 키를 쓴다 |
| 완료된 키의 재요청 | 원래 상태 코드 + 재생 표시 | 정상 응답으로 처리 |

어떤 코드를 고르느냐보다, **각 응답에 클라이언트가 어떻게 반응해야 하는지가 문서에 적혀 있느냐**가 훨씬 중요합니다.
409를 실패로 처리하는 클라이언트 하나면 앞의 설계는 전부 무의미해집니다.

{% comment %} TODO: 실제 결제 연동에서 중복 요청이 들어온 경로나 대사 배치에서 잡힌 사례가 있다면 이 자리에 적어주세요 {% endcomment %}

## 정리

붙일 때 순서대로 확인할 것들입니다.

- [ ] 키를 클라이언트가, 결제 시도 단위로 만드는가
- [ ] 재시도에서 같은 키를 그대로 재사용하는가
- [ ] 키의 유효 범위가 사용자 단위로 좁혀져 있는가
- [ ] 조회 후 삽입이 아니라 **유니크 제약**이 방어선인가
- [ ] 요청 지문을 원문 바이트로 계산하는가
- [ ] 처리 중 응답을 클라이언트가 실패로 표시하지 않는가
- [ ] 좀비 `IN_PROGRESS`를 회수할 방법이 있는가
- [ ] 외부 결제사 호출 **전에** 주문번호가 커밋되는가
- [ ] 미완결 건을 맞추는 대사 배치가 있는가
- [ ] 도메인 테이블에도 유니크 제약이 걸려 있는가
- [ ] 서버 보관 기간과 클라이언트 키 수명이 서로 맞는가
