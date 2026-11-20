---
layout: post
title: "고객이 적어준 주소로 우리 서버가 요청을 보낸다 — 웹훅 발신의 SSRF와 재전송"
date: 2026-11-21
tags: [backend, security, typescript, api, architecture]
excerpt: "웹훅을 받는 쪽이 아니라 보내는 쪽이 되면 위험의 방향이 바뀝니다. 외부에서 입력된 URL이 내부망을 가리킬 때 차단 목록이 통하지 않는 이유, 검사를 연결 직전으로 내리는 방법, 상대의 느린 서버가 우리 지연이 되지 않게 끊는 지점, 재시도 분류와 자동 비활성화, 그리고 보장하지 않는 것을 문서에 적어두는 일까지."
---

웹훅을 받을 때는 상대를 믿지 않는 것이 전부였습니다.
보내는 쪽이 되면 반대가 됩니다. 요청을 **우리 서버가** 만들고, 그 목적지를 외부에서 입력한 문자열이 정합니다.

그 문자열은 우리 VPC 안쪽을 가리킬 수 있고, 그 서버는 응답을 30초 동안 주지 않을 수도 있습니다.
둘 다 우리 쪽 문제로 나타납니다.

## 수신기와 위험의 방향이 다르다

| | 웹훅 수신 | 웹훅 발신 |
| --- | --- | --- |
| 요청을 만드는 쪽 | 상대 | 우리 |
| 목적지 결정 | 우리 (고정) | 상대가 입력한 값 |
| 재전송 정책 | 상대가 정함 | 우리가 정하고 책임짐 |
| 느린 상대의 영향 | 없음 | 우리 워커가 묶임 |
| 주요 위험 | 위조·재전송·중복 | SSRF·자원 고갈·전달 실패 |

수신기 쪽 이야기는 [웹훅 수신기가 조용히 흘리는 것들](/blog/webhook-receiver-signature-replay-ordering/)에 적어뒀고, 여기서는 발신만 다룹니다.

## 그 URL은 우리 네트워크 안쪽을 가리킬 수 있다

고객이 설정 화면에 `http://169.254.169.254/latest/meta-data/`를 적어두고 이벤트를 하나 발생시키면, 요청은 우리 애플리케이션 서버에서 나갑니다.
응답 본문을 전달 로그에 저장해 화면에 보여주고 있다면, 그 응답을 고객이 읽습니다.

내부 관리 API, 사내 깃 서버, Redis나 Elasticsearch의 HTTP 포트도 같은 방식으로 노출됩니다.
공격자가 원하는 건 보통 응답 본문이고, 응답을 안 보여줘도 **상태 코드와 응답 시간 차이만으로 내부 포트 스캔이 됩니다.**

### 차단 목록으로는 막히지 않는다

`localhost`와 `169.254.169.254`를 문자열로 거르는 코드가 가장 흔한 첫 시도인데, 우회 경로가 너무 많습니다.

```javascript
new URL("http://2130706433/x").hostname;          // '127.0.0.1'
new URL("http://0x7f.0x0.0x0.0x1/").hostname;     // '127.0.0.1'
new URL("http://evil.com@169.254.169.254/").hostname;  // '169.254.169.254'
new URL("http://localhost./").hostname;           // 'localhost.'
```

위 두 줄은 URL 파서가 알아서 정규화해주지만, 아래 두 줄은 그렇지 않습니다.
`evil.com@`은 사용자 정보 부분이라 실제 접속 대상은 뒤쪽이고, 사람이 보는 문자열과 접속지가 다릅니다.

문자열을 아무리 잘 걸러도 남는 구멍이 둘 더 있습니다.

**DNS.** `internal.attacker.com`을 `10.0.1.23`으로 응답하게 만들면 호스트 이름 검사는 전부 통과합니다. 공격자가 자기 도메인의 레코드를 바꾸는 일을 막을 방법은 없습니다.

**검사와 연결 사이의 시간차.** 호스트 이름을 검사한 뒤 `fetch`를 호출하면 DNS 조회는 그때 다시 일어납니다. 검사할 때 공인 IP를 주고 연결할 때 사설 IP를 주는 응답(DNS 리바인딩)이면 검사는 의미가 없습니다.

### 검사는 실제로 연결할 IP에서 한다

그래서 검사 지점을 DNS 조회 **결과**로 내려야 합니다. Node에서는 소켓이 쓰는 `lookup` 함수를 직접 넘길 수 있습니다.

```typescript
import dns from "node:dns";
import type { LookupFunction } from "node:net";

// 외부로 내보내면 안 되는 IPv4 범위
const DENY_V4: [string, number][] = [
  ["0.0.0.0", 8],        // this host
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local (클라우드 메타데이터)
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved
];

const toInt = (ip: string) =>
  ip.split(".").reduce((acc, oct) => ((acc << 8) >>> 0) + Number(oct), 0) >>> 0;

function isDeniedV4(ip: string): boolean {
  const value = toInt(ip);
  return DENY_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === ((toInt(base) & mask) >>> 0);
  });
}

function isDenied(address: string, family: number): boolean {
  if (family === 4) return isDeniedV4(address);

  const lower = address.toLowerCase();

  // ::ffff:10.0.0.1 같은 IPv4 매핑 주소를 놓치면 전부 새어나간다
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isDeniedV4(mapped[1]);

  if (lower === "::" || lower === "::1") return true;

  const head = parseInt(lower.split(":")[0] || "0", 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7  unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}
```

이 함수를 `lookup`에 끼워 넣습니다.

```typescript
export const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);

    const allowed = addresses.filter((a) => !isDenied(a.address, a.family));
    if (allowed.length === 0) {
      const blocked = Object.assign(new Error(`blocked host: ${hostname}`), {
        code: "EBLOCKED",
      });
      return callback(blocked, "", 0);
    }

    // 소켓이 all:true 로 물어볼 때와 아닐 때의 콜백 형태가 다르다
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0].address, allowed[0].family);
  });
};
```

> `net.connect`가 커스텀 `lookup`을 호출할 때 넘기는 옵션에는 `all: true`가 들어옵니다.
> 이때 콜백에 문자열 주소를 넘기면 `Invalid IP address: undefined`로 연결이 깨집니다. 두 형태를 모두 처리해야 합니다.

이렇게 하면 검사한 주소와 연결하는 주소가 같아집니다. 호스트 이름이 무엇이든, 몇 개의 A 레코드를 들고 있든 통과한 IP로만 나갑니다.
`Host` 헤더와 TLS SNI는 원래 호스트 이름이 그대로 쓰이므로 가상 호스팅이나 인증서 검증도 깨지지 않습니다.

`undici`를 쓰면 디스패처에 붙입니다.

```typescript
import { Agent, request } from "undici";

const webhookAgent = new Agent({
  connect: { lookup: guardedLookup, timeout: 3_000 },
  headersTimeout: 5_000,
  bodyTimeout: 5_000,
});

const res = await request(endpoint.url, {
  dispatcher: webhookAgent,
  method: "POST",
  headers,
  body,
  maxRedirections: 0,     // 리다이렉트는 따라가지 않는다
});
```

차단된 요청은 `EBLOCKED`로 실패하는데, `undici`에서는 `err.cause.code`에 들어옵니다. 이걸 네트워크 오류와 같이 묶어 재시도 대상으로 분류하면 막아놓은 주소를 계속 두드리게 되니, 설정 오류로 따로 떼어내야 합니다.

### 리다이렉트는 따라가지 않는다

리다이렉트를 자동으로 따라가면 검사를 한 번 더 해야 합니다. 공인 IP에서 302로 `http://169.254.169.254/`를 돌려주는 건 아주 쉬운 우회입니다.

웹훅 전달에서 리다이렉트를 따라갈 이유도 거의 없습니다. 3xx는 **상대 설정이 잘못됐다는 신호**로 보고 전달 실패로 기록하는 편이 낫습니다.
고객에게는 "엔드포인트가 리다이렉트를 반환했습니다"라고 보여주면 스스로 고칩니다.

> HTTP 클라이언트는 대부분 리다이렉트를 기본으로 따라갑니다.
> `fetch`는 `redirect: "manual"`, `undici`는 `maxRedirections: 0`(기본값), `axios`는 `maxRedirects: 0`입니다. 쓰는 클라이언트의 기본값을 확인하세요.

### 받아들일 URL 자체도 좁힌다

연결 단계 방어와 별개로, 저장할 때 걸러야 하는 것들이 있습니다.

- 스킴은 `https`만. `http`를 허용하면 서명이 중간에서 보입니다. 사내 테스트용으로 열어야 한다면 그 환경에서만.
- 포트는 기본 포트만. `:6379`, `:9200`, `:2375` 같은 값을 허용할 이유가 없습니다.
- 사용자 정보(`user@host`)가 있으면 거부. 정상 요청에는 쓰이지 않습니다.
- 길이와 문자 제한. 저장 후 다른 곳에서 다시 파싱될 때 해석이 갈리는 걸 줄여줍니다.

### 네트워크에서 한 겹 더

애플리케이션 코드는 실수할 수 있습니다. 다른 사람이 다른 클라이언트로 전달 기능을 하나 더 만들면 방어가 처음부터 다시 시작됩니다.

그래서 **웹훅 전달 워커만 별도 서브넷에 두고, 송신 규칙으로 사설 대역을 막는** 구성이 확실합니다.
코드와 네트워크 두 군데가 같이 틀려야 사고가 되므로 사고 확률이 눈에 띄게 내려갑니다.

인스턴스 메타데이터는 토큰을 먼저 받아야 하는 방식(IMDSv2)으로 강제해두면, 단순 GET 한 번으로 자격 증명을 꺼내는 경로가 막힙니다.
홉 제한 같은 설정값은 컨테이너 네트워크 모드에 따라 달라지니 해당 공식 문서를 확인하세요.

{% comment %} TODO: 실제 구성에서 송신 제한을 어디에(보안 그룹, NAT, 프록시) 걸었는지 적어주세요 {% endcomment %}

## 서명은 받는 쪽이 검증할 수 있는 형태로

보내는 쪽에서 정할 것은 세 가지입니다. 무엇을 서명 대상 문자열로 만들지, 어떤 헤더로 보낼지, 시크릿을 어떻게 바꿀지.

```typescript
import crypto from "node:crypto";

function signPayload(secret: string, body: string, timestamp: number) {
  // 타임스탬프를 서명에 포함시켜야 받는 쪽이 재전송을 걸러낼 수 있다
  const signed = `v1:${timestamp}:${body}`;
  return crypto.createHmac("sha256", secret).update(signed).digest("hex");
}

export function deliveryHeaders(
  secrets: string[],       // 회전 중에는 두 개가 들어온다
  body: string,
  event: { id: string; type: string },
) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    "user-agent": "acme-webhooks/1",
    "x-webhook-id": event.id,
    "x-webhook-event": event.type,
    "x-webhook-timestamp": String(timestamp),
    "x-webhook-signature": secrets
      .map((s) => `v1=${signPayload(s, body, timestamp)}`)
      .join(","),
  };
}
```

서명 대상은 **직렬화된 본문 바이트 그대로**여야 합니다. 받는 쪽은 JSON을 파싱하기 전 원본으로 검증하므로, 우리가 객체를 다시 직렬화해 서명하면 키 순서나 공백 하나로 어긋납니다.
그래서 `body` 문자열을 먼저 만들고 그 문자열로 서명한 뒤, 같은 문자열을 전송해야 합니다.

시크릿 회전은 **서명을 여러 개 보내는 것**으로 해결됩니다. 새 시크릿을 발급하면 일정 기간 두 서명을 같이 실어 보내고, 받는 쪽은 하나라도 맞으면 통과시킵니다.
이 기간이 지나면 옛 시크릿을 지웁니다. 헤더에 여러 값을 쉼표로 나열하는 형식을 처음부터 쓰지 않으면 나중에 회전할 길이 없어집니다.

버전 접두사 `v1=`도 같은 이유입니다. 서명 방식을 바꿀 때 받는 쪽이 둘을 구분할 수 있어야 합니다.

## 상대의 느린 서버가 우리 지연이 되지 않게

전달을 요청 처리 흐름 안에서 하면 상대 서버의 응답 시간이 우리 API 응답 시간이 됩니다.
웹훅 발신은 예외 없이 **커밋 이후 비동기로** 내보내야 합니다. 트랜잭션 안에서 보내면 롤백된 이벤트가 이미 나가 있는 상태가 됩니다.

> DB 커밋과 발신을 원자적으로 묶는 문제는 아웃박스 패턴과 같은 이야기입니다.
> 이벤트를 같은 트랜잭션에서 테이블에 적고, 워커가 그 테이블을 읽어 전달하는 구조는 [트랜잭셔널 아웃박스](/blog/transactional-outbox-pattern/)에 적어뒀습니다.

타임아웃은 세 단계로 나눠 짧게 잡습니다. 연결, 응답 헤더, 본문 수신입니다.
웹훅 응답 본문은 로그용으로 몇 KB만 받으면 되니 넉넉하게 줄 이유가 없습니다. 응답을 받아 저장할 때도 상한을 두고 잘라야 합니다.

더 중요한 건 **한 엔드포인트의 지연이 다른 고객의 전달을 막지 않는 것**입니다.
워커 풀 하나를 모두가 공유하면, 응답하지 않는 엔드포인트 하나가 워커 전부를 타임아웃까지 붙잡습니다.

| 방식 | 장점 | 비용 |
| --- | --- | --- |
| 공용 워커 풀 | 단순함 | 느린 엔드포인트 하나가 전체를 막음 |
| 엔드포인트별 동시성 상한 | 영향 범위를 가둠 | 상한 관리와 카운터가 필요 |
| 엔드포인트별 큐·파티션 | 격리가 확실, 순서 유지 가능 | 큐 수 증가, 핫 파티션 문제 |
| 실패 엔드포인트 차단 | 낭비되는 호출을 줄임 | 복구 감지 로직 필요 |

큐의 선두 차단과 공정 분배는 [워커 큐의 선두 차단과 공정 분배](/blog/worker-queue-fairness-tenant-isolation/)에서 더 다뤘습니다.
연속 실패하는 엔드포인트를 잠시 끊어두는 판단은 [타임아웃 예산과 재시도 증폭](/blog/retry-timeout-budget-circuit-breaker/)에서 다룬 회로 차단기와 같은 구조입니다.

## 무엇을 재시도하고 언제 포기하는가

응답을 두 부류로만 나누면(성공/실패) 재시도가 낭비되거나 영원히 돕니다. 분류를 먼저 정합니다.

```typescript
type Outcome =
  | { kind: "delivered" }
  | { kind: "retry"; after?: number }
  | { kind: "failed"; reason: string }       // 재시도해도 소용없음
  | { kind: "disable"; reason: string };     // 엔드포인트를 꺼야 함

export function classify(status: number, headers: Record<string, string>): Outcome {
  if (status >= 200 && status < 300) return { kind: "delivered" };

  // 리다이렉트는 따라가지 않으므로 설정 오류로 본다
  if (status >= 300 && status < 400) {
    return { kind: "failed", reason: `redirect to ${headers["location"] ?? "?"}` };
  }

  if (status === 408 || status === 429) {
    const retryAfter = Number(headers["retry-after"]);
    return {
      kind: "retry",
      after: Number.isFinite(retryAfter) ? retryAfter : undefined,
    };
  }

  // 410 Gone 은 "더 보내지 말라"는 신호로 약속해둘 수 있다
  if (status === 410) return { kind: "disable", reason: "endpoint gone" };

  if (status >= 400 && status < 500) {
    return { kind: "failed", reason: `client error ${status}` };
  }

  return { kind: "retry" };
}
```

4xx를 재시도하지 않는 이유는 분명합니다. 상대가 우리 페이로드를 거부한 거라 똑같이 보내면 똑같이 거부됩니다.
다만 **401과 403은 애매합니다.** 상대가 인증 설정을 고치는 중일 수도 있어서, 몇 번은 재시도하되 횟수를 짧게 두는 쪽이 현실적입니다.

간격에는 지터를 넣습니다. 지터가 없으면 한 번 끊긴 엔드포인트에 재시도가 같은 순간으로 몰립니다.

```typescript
const BACKOFF_SECONDS = [5, 30, 120, 600, 1_800, 7_200, 21_600];

export function nextAttemptAt(attempt: number, retryAfter?: number): Date | null {
  if (attempt >= BACKOFF_SECONDS.length) return null;   // 포기

  const base = Math.max(BACKOFF_SECONDS[attempt], retryAfter ?? 0);
  const jitter = base * (Math.random() * 0.4 - 0.2);    // ±20%
  return new Date(Date.now() + (base + jitter) * 1_000);
}
```

구간을 어디까지 늘릴지는 **"고객이 서버를 복구할 시간"과 "지난 이벤트가 아직 쓸모 있는 시간"** 사이의 선택입니다.
결제 알림이라면 하루가 지나 도착해도 의미가 있지만, 실시간 현황 갱신이라면 한 시간 뒤 도착은 이미 쓸모가 없습니다. 이벤트 종류별로 다르게 둘 이유가 여기 있습니다.

연속 실패가 길어지면 엔드포인트를 자동으로 끕니다. 끌 때는 반드시 알려야 합니다. 조용히 꺼두면 고객은 "웹훅이 원래 불안정하다"고 이해합니다.

- 연속 실패가 기준을 넘으면 비활성화하고 메일·화면으로 통지
- 비활성화 기간에 발생한 이벤트는 전달 로그에 남겨 재전송 가능하게
- 고객이 엔드포인트를 수정하거나 테스트 전송에 성공하면 다시 활성화

## 보장하지 않는 것을 문서에 적는다

발신자가 실제로 지킬 수 있는 건 생각보다 적습니다. 적지 않으면 상대는 지켜진다고 가정하고 구현합니다.

- **최소 한 번 전달.** 우리가 200을 못 받으면 다시 보냅니다. 상대가 받고 나서 응답이 유실되면 중복이 됩니다. 그래서 이벤트 ID를 헤더와 본문에 모두 넣고, 상대가 그걸로 중복을 거를 수 있게 합니다.
- **순서 미보장.** 재시도 때문에 늦은 이벤트가 뒤에 도착합니다. 본문에 이벤트 발생 시각과 리소스 버전을 넣어두면 상대가 오래된 이벤트를 버릴 수 있습니다.
- **페이로드는 요약.** 전체 상태를 다 실어 보내면 민감 정보가 전달 로그와 상대 로그에 남습니다. ID와 변경 종류만 보내고 상세는 API로 다시 조회하게 하는 쪽이 안전합니다. 대신 상대의 호출이 늘어납니다.
- **재시도 간격과 포기 시점.** 숫자로 공개해두면 상대가 자기 쪽 복구 절차를 설계할 수 있습니다.

## 전달 로그는 디버깅이 아니라 기능이다

웹훅이 도착하지 않았다는 문의는 반드시 들어옵니다. 그때 "우리는 보냈습니다"라고만 말할 수 있으면 아무 문제도 해결되지 않습니다.

```sql
CREATE TABLE webhook_delivery (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  endpoint_id   BIGINT UNSIGNED NOT NULL,
  event_id      CHAR(26)        NOT NULL,     -- 이벤트 식별자
  attempt       INT UNSIGNED    NOT NULL DEFAULT 0,
  status        VARCHAR(16)     NOT NULL,     -- pending/delivered/failed/dropped
  http_status   SMALLINT UNSIGNED NULL,
  error_code    VARCHAR(32)     NULL,         -- EBLOCKED, ETIMEDOUT ...
  duration_ms   INT UNSIGNED    NULL,
  response_head JSON            NULL,
  response_body VARBINARY(2048) NULL,         -- 상한을 두고 자른다
  next_retry_at DATETIME(3)     NULL,
  created_at    DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_pending (status, next_retry_at),
  KEY idx_endpoint_time (endpoint_id, created_at),
  KEY idx_event (event_id)
) ENGINE=InnoDB;
```

이 테이블로 세 가지가 가능해집니다. 고객 화면에 시도 이력을 그대로 보여주기, 특정 이벤트를 수동으로 재전송하기, 그리고 엔드포인트별 실패율을 지표로 뽑기.

응답 본문을 저장할 때는 두 가지를 조심해야 합니다. **상한 없이 저장하면 상대가 보낸 10MB HTML이 그대로 들어옵니다.** 그리고 이 본문은 고객이 통제하는 값이라, 화면에 그릴 때는 이스케이프해야 합니다.

보관 기간도 정해둡니다. 전달 로그는 이벤트 수에 비례해 늘어나는 테이블이라 방치하면 가장 큰 테이블이 됩니다.

{% comment %} TODO: 전달 로그 보관 기간과 파티셔닝 여부를 어떻게 정했는지 적어주세요 {% endcomment %}

## 직접 만들 것인가

웹훅 발신은 "POST 한 번"으로 시작해서 큐·재시도·서명 회전·전달 로그·수동 재전송·엔드포인트 관리 화면까지 늘어납니다. 전용 서비스를 쓰는 선택지도 있습니다.

| | 직접 구현 | 전용 서비스 |
| --- | --- | --- |
| 초기 비용 | 큐와 워커만 있으면 시작 가능 | 연동만 |
| SSRF 방어 | 우리가 책임짐 | 제공 여부를 확인해야 함 |
| 페이로드 | 내부 데이터를 그대로 다룸 | 외부로 나감 (검토 필요) |
| 전달 로그 UI | 직접 만들어야 함 | 대개 포함 |
| 종속성 | 없음 | 장애 시 우리 웹훅도 멈춤 |

엔드포인트가 몇 개뿐인 내부 연동이라면 직접 만드는 쪽이 간단합니다.
외부 개발자에게 공개하는 기능이고 엔드포인트가 계속 늘어난다면, 직접 만들 범위가 생각보다 넓다는 점을 먼저 보는 편이 좋습니다.

## 점검 순서

웹훅 발신을 붙였다면 이 순서로 확인해볼 만합니다.

1. 엔드포인트에 `http://127.0.0.1:8080/`을 저장해본다. 저장 단계에서 막히는가.
2. 공인 IP로 응답하다가 사설 IP로 바뀌는 도메인을 넣어본다. 연결 단계에서 막히는가.
3. 302로 메타데이터 주소를 돌려주는 엔드포인트를 넣어본다. 따라가는가.
4. 응답을 주지 않는 엔드포인트를 하나 등록하고 이벤트를 쏟아본다. 다른 엔드포인트 전달이 밀리는가.
5. 500을 계속 반환하는 엔드포인트가 몇 번 만에 꺼지는가. 그때 통지가 나가는가.
6. 같은 이벤트가 두 번 도착할 수 있다는 사실이 공개 문서에 적혀 있는가.
