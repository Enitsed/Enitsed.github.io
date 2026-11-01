---
layout: post
title: "로그는 다 찍혀 있는데 그 요청만 볼 수 없다 — 구조화 로깅과 상관관계 ID"
date: 2026-11-02
tags: [backend, observability, nodejs, typescript, devops]
excerpt: "동시 요청의 로그가 섞여서 한 요청의 궤적을 모을 수 없는 문제. JSON 한 줄 구조, AsyncLocalStorage로 요청 ID를 인자 없이 전파하는 방법, 마스킹이 조용히 새는 자리와 볼륨·보존 설계까지."
---

장애 보고를 받고 로그를 엽니다. 에러 스택은 있습니다.
그런데 그 에러가 어느 요청에서 났고, 그 요청이 그 전에 무슨 일을 했는지는 알 수 없습니다.

초당 수십 건이 동시에 돌고 있으면 한 요청의 로그 다섯 줄은 다른 요청 이백 줄 사이에 흩어져 있습니다.
로그가 없어서 못 보는 게 아니라, **모을 수 없어서** 못 봅니다.

## 섞인다는 게 무슨 뜻인가

서버 하나에 요청 셋이 동시에 들어오면 출력은 이렇게 나옵니다.

```text
step 1
fast only step
step 2 after await
```

첫 줄과 셋째 줄이 같은 요청인지, 둘째 줄과 셋째 줄이 같은 요청인지 이 출력만 보고는 알 수 없습니다.
`await` 하나만 들어가도 다른 요청의 로그가 그 사이로 끼어들기 때문입니다.

인스턴스가 여러 대라면 로그 묶음 자체가 나뉘고, 재시도가 섞이면 같은 작업의 로그가 서로 다른 시각에 두 번 나타납니다.

여기서 보통 꺼내는 해결책은 메시지를 자세하게 쓰는 것입니다.

```typescript
console.log(`[order] user=${userId} 결제 요청 시작 amount=${amount}`);
```

이러면 사람이 읽기는 좋아지는데, 문제가 두 개 남습니다.

**검색이 안 됩니다.** `user=123`으로 grep 하면 `user=1234`도 걸립니다. "500 응답만, 특정 경로에서, 지연 1초 이상"은 정규식으로 쓸 수 있는 조건이 아닙니다.

**스택 트레이스가 여러 줄입니다.** 로그 수집기는 대개 한 줄을 한 레코드로 읽으니, 에러 하나가 레코드 열 개로 쪼개집니다. 쪼개진 조각은 서로 연결되지 않습니다.

## 한 줄 = 한 JSON 객체

그래서 사람이 읽을 문장 대신 기계가 읽을 객체를 찍습니다. 사람이 읽는 건 조회 도구가 맡습니다.

```typescript
// logger.ts
import pino from 'pino';

export const root = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'api', env: process.env.NODE_ENV ?? 'local' },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'message',
  formatters: {
    level: (label) => ({ level: label }),   // 30 대신 "info"
  },
  serializers: { err: pino.stdSerializers.err },
});
```

`formatters.level`을 지정하는 이유는 기본 출력이 숫자이기 때문입니다. 조회할 때 `level = 30`보다 `level = "error"`가 쓰기 쉽습니다.

에러는 전용 직렬화기를 거쳐야 합니다. `Error` 객체를 그냥 넣으면 열거 가능한 속성이 없어서 `{}`로 찍히고, 그때는 메시지도 스택도 남지 않습니다.

```typescript
logger.error({ err: new Error('boom') }, 'payment failed');
```

```json
{"level":"error","time":"2026-11-02T00:00:00.000Z","service":"api","env":"prod",
 "err":{"type":"Error","message":"boom","stack":"Error: boom\n    at ..."},
 "message":"payment failed"}
```

스택이 **문자열 필드 안에** 들어가므로 레코드가 쪼개지지 않습니다. 여러 줄 문제가 여기서 사라집니다.

그리고 출력은 stdout으로만 보냅니다. 컨테이너에서는 런타임이 stdout을 수집해 가므로, 애플리케이션이 파일을 열고 로테이션까지 관리할 이유가 없습니다.
파일로 쓰면 디스크가 차고, 재시작하면 사라지고, 수집 경로가 두 갈래가 됩니다.

## 요청 ID를 인자로 넘기지 않는다

ID 하나만 모든 줄에 같이 찍히면 섞인 로그를 다시 모을 수 있습니다. 문제는 **그 ID를 어떻게 깊은 함수까지 내려보내는가**입니다.

가장 단순한 답은 전부 인자로 넘기는 것입니다. 그러면 로깅과 아무 상관 없는 함수 시그니처가 전부 바뀌고, 한 군데라도 빠뜨리면 그 구간의 로그가 고아가 됩니다.

Node에는 이걸 위한 도구가 있습니다. `AsyncLocalStorage`는 비동기 호출 체인을 따라 유지되는 저장소라, `await`을 몇 번 건너가도 같은 값을 돌려줍니다.

```typescript
// context.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import { root } from './logger';

const als = new AsyncLocalStorage<Logger>();

export const runWithLogger = <T>(logger: Logger, fn: () => T) => als.run(logger, fn);

/** 어디서든 호출. 컨텍스트가 없으면 루트 로거로 떨어진다. */
export const log = (): Logger => als.getStore() ?? root;
```

`?? root`가 중요합니다. 부팅 코드나 스케줄러처럼 요청 컨텍스트가 없는 곳에서도 `log()`는 동작해야 합니다. 여기서 던지면 로깅 때문에 앱이 죽습니다.

미들웨어에서 요청마다 자식 로거를 만들어 심습니다.

```typescript
// request-context.ts
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { root } from './logger';
import { runWithLogger } from './context';

export const requestContext: RequestHandler = (req, res, next) => {
  const reqId = req.header('x-request-id') ?? randomUUID();
  res.setHeader('x-request-id', reqId);

  const logger = root.child({ req_id: reqId, method: req.method, route: req.path });
  const startedAt = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    logger.info(
      { status: res.statusCode, latency_ms: Math.round(ms * 100) / 100 },
      'request',
    );
  });

  runWithLogger(logger, next);
};
```

`child()`로 만든 로거는 넘긴 필드를 **이후 모든 줄에 자동으로 붙입니다.** 핸들러는 그걸 의식할 필요가 없습니다.

```typescript
app.get('/orders/:id', async (req, res) => {
  log().info('fetching order');          // req_id, method, route 가 자동으로 붙는다
  const order = await repo.find(req.params.id);
  log().info({ order_status: order.status }, 'order loaded');
  res.json(order);
});
```

이제 앞의 섞인 출력이 이렇게 바뀝니다.

```text
{"req_id":"ccfe3672-...","route":"/slow","message":"step 1"}
{"req_id":"d026edbd-...","route":"/fast","message":"fast only step"}
{"req_id":"ccfe3672-...","route":"/slow","message":"step 2 after await"}
```

줄의 순서는 그대로 섞여 있지만, `req_id`로 필터하면 한 요청의 궤적만 뽑힙니다.
그리고 응답 헤더로 같은 ID를 돌려주므로, 사용자가 캡처해 온 화면이나 클라이언트 에러 리포트에서 서버 로그로 바로 건너갈 수 있습니다.

> `res.on('finish')`는 응답이 정상적으로 다 나간 경우에 발생합니다. 클라이언트가 중간에 끊은 요청까지 세려면 `close`도 함께 봐야 합니다.
> 두 이벤트가 같은 요청에서 모두 발생할 수 있으니 한 번만 찍도록 플래그를 두세요.

## ID는 경계를 넘어야 한다

ID가 서비스 하나 안에서만 유효하면 반쪽입니다. 요청이 게이트웨이를 거쳐 들어오고 다른 서비스를 호출한다면, 그 전부가 같은 ID를 공유해야 합니다.

받을 때는 들어온 헤더를 **우선 신뢰하고**, 없을 때만 새로 만듭니다. 위 미들웨어가 그 순서입니다.
이미 트레이싱을 붙였다면 W3C `traceparent`의 트레이스 ID를 쓰는 편이 낫습니다. 로그와 트레이스가 같은 키로 맞춰지기 때문입니다.

```typescript
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const fromTraceparent = (header?: string) => TRACEPARENT.exec(header ?? '')?.[1];

const reqId =
  req.header('x-request-id') ??
  fromTraceparent(req.header('traceparent')) ??
  randomUUID();
```

정규식으로 형식을 검증하는 건 그냥 꼼꼼함이 아닙니다. 외부에서 들어온 헤더 값을 그대로 로그 필드에 넣으면, 길이 제한도 문자 제한도 없는 값이 인덱싱되는 필드로 들어갑니다.
개행이 섞인 값이 들어오면 한 줄 규칙도 깨집니다. **헤더는 사용자 입력입니다.**

보낼 때는 HTTP 클라이언트에 한 번만 심어둡니다. 호출 지점마다 챙기면 반드시 빠지는 곳이 생깁니다.

```typescript
export async function callService(path: string, init: RequestInit = {}) {
  const reqId = log().bindings().req_id;        // 자식 로거에 심어둔 값
  const headers = new Headers(init.headers);
  if (reqId) headers.set('x-request-id', String(reqId));
  return fetch(`${BASE_URL}${path}`, { ...init, headers });
}
```

비동기 경계에서는 전파가 **끊어집니다.** 큐에 메시지를 넣는 순간 호출 체인이 끝나기 때문입니다.
그래서 ID는 메시지 페이로드(또는 메시지 속성)에 실어 보내고, 컨슈머가 꺼내서 다시 컨텍스트를 세웁니다.

```typescript
// 프로듀서
await sqs.send(new SendMessageCommand({
  QueueUrl: url,
  MessageBody: JSON.stringify({ ...payload, _req_id: log().bindings().req_id }),
}));

// 컨슈머
const body = JSON.parse(record.body);
const logger = root.child({
  req_id: body._req_id ?? randomUUID(),
  job: 'settle-order',
  message_id: record.messageId,
  receive_count: Number(record.attributes?.ApproximateReceiveCount ?? 1),
});
await runWithLogger(logger, () => handle(body));
```

`receive_count`를 같이 찍는 이유는 재처리된 메시지를 구분하기 위해서입니다.
같은 `req_id`의 로그가 두 벌 나왔을 때 "중복 처리"인지 "재시도"인지는 이 숫자가 알려줍니다([가시성 타임아웃과 DLQ](/blog/sqs-consumer-visibility-timeout-dlq/)).

## 트레이스와 로그를 같은 키로 묶기

트레이싱을 쓰고 있다면 로그 줄에 `trace_id`와 `span_id`를 같이 넣어둡니다.
느린 요청을 트레이스에서 찾은 다음 그 ID로 로그를 거는 경로가 생기고, 반대 방향도 됩니다.

```typescript
import { trace } from '@opentelemetry/api';

export function traceFields() {
  const sc = trace.getActiveSpan()?.spanContext();
  return sc ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
}
```

주의할 점은 `span_id`가 **요청 단위가 아니라 스팬 단위**라는 것입니다.
자식 로거를 만들 때 한 번 박아두면 요청 내내 같은 값이 찍히고, 그건 사실과 다릅니다. 스팬별로 정확히 맞추려면 찍는 시점에 평가해야 합니다.

```typescript
log().info({ ...traceFields(), order_id: id }, 'order loaded');
```

이 비용이 아깝다면 `trace_id`만 자식 로거에 넣고 `span_id`는 포기하는 게 합리적인 타협입니다. 로그에서 트레이스로 건너가는 데는 `trace_id`만 있으면 됩니다.
어차피 샘플링에 걸러진 요청은 트레이스가 없으니, 로그 쪽에 ID가 남아 있는 편이 유용합니다([컨텍스트 전파와 꼬리 샘플링](/blog/opentelemetry-trace-context-sampling/)).

## 마스킹은 생각보다 쉽게 샌다

로그는 평문으로 오래 남고, 보는 사람이 DB보다 많습니다. 테이블은 암호화해두고 로그로 같은 값을 흘리면 암호화의 의미가 없어집니다([개인정보 암호화와 블라인드 인덱스](/blog/pii-column-encryption-blind-index/)).

pino는 경로 기반 마스킹을 제공합니다.

```typescript
redact: {
  paths: [
    'req.headers.authorization',
    'req.headers.cookie',
    'user.email',
    'body.children[*].name',
  ],
  censor: '[REDACTED]',
}
```

여기에 **함정이 하나** 있습니다. 경로가 리터럴이라 한 단계만 어긋나면 그대로 통과합니다.
`*.password`를 넣고 안심하기 쉬운데, 실제로 돌려보면 이렇습니다.

```json
{"password":"p0","a":{"password":"[REDACTED]"},"a2":{"b":{"password":"p2"}}}
```

`*`는 **정확히 한 단계**만 맞춥니다. 최상위 `password`도, 두 단계 아래 `a2.b.password`도 걸리지 않습니다.
중첩 깊이가 바뀌는 리팩터링 한 번에 마스킹이 조용히 풀립니다. 아무 에러도 나지 않고, 알게 되는 건 로그를 들여다볼 일이 생긴 다음입니다.

그래서 경계 바깥으로 나가는 필드는 **허용 목록**으로 뒤집는 쪽이 안전합니다. 모르는 키는 기본적으로 버립니다.

```typescript
const ALLOWED = new Set([
  'level', 'time', 'message', 'service', 'env',
  'req_id', 'trace_id', 'span_id', 'method', 'route', 'status', 'latency_ms',
  'err', 'user_id', 'order_id', 'job',
]);

const logger = pino({
  // ...
  formatters: {
    log: (obj) => Object.fromEntries(
      Object.entries(obj).filter(([k]) => ALLOWED.has(k)),
    ),
  },
});

logger.info({ req_id: 'r1', status: 200, email: 'leak@example.com' }, 'done');
// → {"level":"info","req_id":"r1","status":200,"message":"done"}
```

트레이드오프는 분명합니다. 새 필드를 찍으려면 목록에 추가해야 하고, 추가를 잊으면 **디버깅하려던 값이 사라집니다.**
그래서 전부 다 이렇게 하기보다, 개인정보가 섞일 수 있는 경로의 로거만 이 설정으로 두고 나머지는 거부 목록으로 가는 절충이 현실적입니다.

목록과 무관하게 지켜야 하는 것들도 있습니다.

- **요청 객체를 통째로 넣지 않습니다.** 헤더, 쿠키, 바디가 전부 따라 들어옵니다.
- **에러 객체를 믿지 않습니다.** HTTP 클라이언트 에러는 요청 설정을 품고 있어서, 거기에 `Authorization` 헤더와 요청 바디가 그대로 들어 있는 경우가 흔합니다.
- **ORM 쿼리 로그에 파라미터가 포함되는지 확인합니다.** 평문 주민번호나 토큰이 `WHERE` 절 값으로 찍힙니다.
- 식별자는 값 대신 참조로 찍습니다. `email` 대신 `user_id`, 카드번호 대신 마지막 네 자리.

{% comment %} TODO: 실제로 운영에서 마스킹이 빠져 있던 자리를 발견한 경험이 있다면 이 자리에 사례로 적어주세요 {% endcomment %}

## 레벨은 "누가 반응하는가"로 정한다

레벨 기준이 없으면 두 가지 중 하나가 됩니다. 전부 `info`거나, 전부 `error`입니다. 둘 다 결과는 같습니다. 아무도 안 봅니다.

기준을 심각도가 아니라 **대응 주체**로 잡으면 선이 그어집니다.

| 레벨 | 질문 | 예 |
| --- | --- | --- |
| `error` | 사람이 지금 봐야 하는가 | 의존성 호출 실패, 처리되지 않은 예외, 데이터 불일치 |
| `warn` | 지금은 괜찮지만 추세를 봐야 하는가 | 재시도 성공, 폴백 사용, 임계치 근접 |
| `info` | 나중에 이 요청을 재구성해야 하는가 | 요청 완료, 상태 전이, 외부 호출 결과 |
| `debug` | 특정 문제를 파는 동안만 필요한가 | 중간 계산, 쿼리 파라미터 |

가장 흔한 오분류는 **사용자 입력 오류를 `error`로 찍는 것**입니다.
400 응답은 시스템이 정상 동작한 결과입니다. 이게 `error`에 섞이면 에러 로그의 대부분이 정상 동작이 되고, 진짜 에러가 그 안에 묻힙니다.

레벨은 재배포 없이 바꿀 수 있어야 합니다. 장애 중에 `debug`를 보려고 이미지를 다시 빌드할 수는 없습니다.

```typescript
// 환경변수로 시작 레벨을 정하고, 런타임에 올릴 수단을 열어둔다
root.level = process.env.LOG_LEVEL ?? 'info';

process.on('SIGUSR2', () => {
  root.level = root.level === 'debug' ? 'info' : 'debug';
  root.info({ level: root.level }, 'log level toggled');
});
```

자식 로거는 생성 시점의 레벨을 따르므로, 이미 만들어진 자식에는 이 변경이 반영되지 않을 수 있습니다. 라이브러리 버전별 동작은 문서를 확인하세요.

## 볼륨은 곱셈으로 늘어난다

로그 비용은 한 줄의 크기가 아니라 곱셈에서 옵니다.

```text
일일 볼륨 ≈ 초당 요청 수 × 요청당 줄 수 × 줄 크기 × 86,400
```

요청당 줄 수가 3에서 10으로 늘면 비용도 세 배가 됩니다. 그리고 그 추가된 7줄은 대개 "혹시 필요할까 봐" 넣은 것들입니다.

그래서 줄이는 순서는 이렇습니다.

**집계로 답할 수 있는 건 로그로 찍지 않습니다.** "에러율이 올랐는가"는 메트릭이 답할 질문입니다.
로그는 "그래서 그게 어느 요청이었는가"에 답하는 도구입니다. 두 도구의 역할을 섞으면 비싼 쪽으로 쏠립니다([메트릭 카디널리티와 라벨 설계](/blog/metric-cardinality-label-design/)).

**성공 요청은 샘플링합니다.** 단, 요청 단위로 결정해야 합니다. 줄 단위로 샘플링하면 한 요청의 로그가 절반만 남아서 추적이 불가능해집니다.

```typescript
const SAMPLE_RATE = Number(process.env.LOG_SAMPLE_RATE ?? 1);

// 요청 진입 시점에 한 번 정하고 컨텍스트에 싣는다
const sampled = Math.random() < SAMPLE_RATE;

res.on('finish', () => {
  const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const interesting = res.statusCode >= 500 || latencyMs > 1000;
  if (sampled || interesting) {
    logger.info({ status: res.statusCode, latency_ms: Math.round(latencyMs), sampled }, 'request');
  }
});
```

`interesting` 조건이 핵심입니다. 느린 요청과 실패는 **샘플링에서 제외**합니다. 정작 필요한 로그가 확률적으로 사라지면 샘플링으로 아낀 돈보다 손해가 큽니다.

**보존 기간을 티어로 나눕니다.** 대부분의 조회는 최근 며칠 안에서 일어납니다. 그보다 오래된 로그는 조회 가능한 상태로 둘 필요가 없는 경우가 많습니다.
짧은 보존 기간을 둔 로그 그룹에서 객체 스토리지로 내보내고, 거기서 다시 수명 주기 정책으로 저장 클래스를 내리는 구성이 일반적입니다.

> 로그 저장·조회·수집의 과금 방식과 단가, 보존 기간 설정의 단위는 서비스와 리전에 따라 다르고 바뀝니다.
> 구성을 정하기 전에 해당 서비스의 요금 문서를 직접 확인하세요.

다만 보존 기간은 비용만으로 정할 수 없습니다. 감사나 법적 요구가 있는 로그(인증 시도, 개인정보 접근 기록)는 별도 그룹으로 분리해서 다른 기간을 적용합니다.
전부 한 그룹에 넣으면 가장 긴 요구사항이 전체 비용을 결정합니다.

## 확인하는 법

설정이 의도대로 됐는지는 네 가지로 봅니다.

**한 요청이 끝에서 끝까지 이어지는가.** 응답 헤더의 ID로 모든 줄이 걸리는지 봅니다. 중간에 끊긴다면 그 구간이 컨텍스트 밖입니다.

```bash
REQ_ID=$(curl -s -D - -o /dev/null http://localhost:8080/orders/1 \
  | awk 'tolower($1)=="x-request-id:"{print $2}' | tr -d '\r')
echo "req_id=$REQ_ID"
```

```text
fields @timestamp, level, message, latency_ms, status
| filter req_id = "REQ_ID"
| sort @timestamp asc
```

**마스킹이 실제로 걸리는가.** 이건 테스트로 박아두는 게 맞습니다. 리팩터링으로 조용히 풀리는 종류의 설정이기 때문입니다.

```typescript
import { Writable } from 'node:stream';

function capture(fn: (l: pino.Logger) => void): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, cb) { out += chunk.toString(); cb(); },
  });
  fn(pino({ ...loggerOptions }, sink));
  return out;
}

it('마스킹 대상 값이 출력에 남지 않는다', () => {
  const out = capture((l) =>
    l.info({ user: { email: 'secret@example.com' }, req: { headers: { authorization: 'Bearer t0ken' } } }, 'x'),
  );
  expect(out).not.toContain('secret@example.com');
  expect(out).not.toContain('t0ken');
  expect(out).toContain('[REDACTED]');
});
```

값이 **나타나지 않는지**로 검증하는 게 중요합니다. `[REDACTED]`가 있는지만 보면, 다른 필드가 마스킹됐을 때도 통과합니다.

**모든 줄이 유효한 JSON인가.** 라이브러리를 거치지 않는 출력이 하나라도 섞여 있으면 수집기가 그 줄을 버리거나 통째로 문자열로 취급합니다.

```bash
# 로컬에서 테스트를 돌리고 파싱 실패 줄만 본다
npm test 2>&1 | grep -v '^$' | while IFS= read -r l; do
  printf '%s' "$l" | jq -e . >/dev/null 2>&1 || echo "NOT JSON: $l"
done
```

여기서 걸리는 건 대개 `console.log` 잔재, 의존 라이브러리의 자체 출력, 그리고 프레임워크의 기본 접근 로그입니다. 마지막 것은 끄고 직접 찍는 편이 형식이 통일됩니다.

**요청당 줄 수를 세어봅니다.** 스테이징에서 요청 하나를 보내고 몇 줄이 나오는지 봅니다. 예상보다 많으면 거기가 볼륨의 출처입니다.

{% comment %} TODO: 실제 운영 서비스의 요청당 로그 줄 수나 볼륨을 쓸 수 있다면 이 자리에. 공개할 수 없으면 이 주석째로 지우세요 {% endcomment %}

## 정리

- 로그가 쓸 수 없게 되는 이유는 양이 적어서가 아니라 **한 요청으로 모을 키가 없어서**다.
- 사람이 읽을 문장 대신 JSON 객체를 찍는다. 에러는 전용 직렬화기를 거쳐 스택을 **한 필드 안에** 넣는다.
- 요청 ID는 인자로 넘기지 않고 `AsyncLocalStorage`로 전파하고, 자식 로거에 심어 모든 줄에 자동으로 붙인다.
- 들어온 `x-request-id`나 `traceparent`를 우선 쓰고, 큐처럼 체인이 끊기는 경계에서는 페이로드에 실어 보낸다.
- 거부 목록 마스킹은 경로가 리터럴이라 조용히 샌다. `*`는 한 단계만 맞는다. 바깥으로 나가는 필드는 허용 목록으로 뒤집는다.
- 레벨은 심각도가 아니라 **누가 반응하는가**로 나눈다. 400을 `error`에 넣으면 에러 로그가 무의미해진다.
- 볼륨은 곱셈이다. 집계로 답할 질문은 메트릭에 넘기고, 샘플링은 줄이 아니라 **요청 단위**로, 실패와 느린 요청은 제외한다.
