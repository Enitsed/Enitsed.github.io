---
layout: post
title: "트레이싱을 붙였는데 장애 때 못 쓰는 이유 — 컨텍스트 전파와 꼬리 샘플링"
date: 2026-09-14
tags: [observability, opentelemetry, devops, typescript]
excerpt: "자동 계측만 켜두면 트레이스는 큐 경계에서 끊기고, 확률 샘플링은 정작 느린 요청을 버립니다. traceparent 전파, 로그에 trace_id 넣기, 헤드 샘플링과 꼬리 샘플링의 트레이드오프를 정리합니다."
---

장애 대응 중에 에러 로그를 하나 찾았습니다. 그런데 이게 어느 요청에서 났는지, 그 요청이 앞뒤로 무엇을 했는지는 로그 한 줄에 없습니다.

트레이싱 도구는 이미 붙어 있는데도 그렇습니다. 대시보드에는 그래프가 잘 그려지고, 정작 지금 필요한 그 요청 하나는 거기 없습니다.

## 자동 계측이 끝내주지 않는 것

`@opentelemetry/auto-instrumentations-node`를 켜면 HTTP 서버·클라이언트, DB 드라이버, Redis 같은 것들이 알아서 스팬을 만듭니다. 시작점으로는 충분합니다.

```typescript
// instrumentation.ts — 애플리케이션 코드보다 먼저 로드되어야 한다
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
```

```bash
# CommonJS
node --require ./instrumentation.js app.js

# 서비스 이름과 내보낼 주소는 환경변수로 준다
OTEL_SERVICE_NAME=payment-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
```

`traceExporter`나 `spanProcessor`를 넘기지 않으면 기본 OTLP 익스포터가 자동으로 설정됩니다. 그래서 초기 설정에서는 코드로 익스포터를 만들 필요가 없습니다.

> 리소스 속성을 코드로 만드는 API(`Resource`, `resourceFromAttributes` 등)는 버전에 따라 이름과 형태가 바뀐 이력이 있습니다.
> `OTEL_SERVICE_NAME`·`OTEL_RESOURCE_ATTRIBUTES` 환경변수로 주면 SDK 버전에 덜 묶입니다. 코드로 쓸 거라면 **설치한 버전의 문서를 확인하세요.**

여기까지 하면 "HTTP 요청 하나가 DB를 몇 번 쳤는지"는 보입니다. 문제는 **요청이 프로세스 경계를 넘는 순간**입니다.

## 트레이스가 끊기는 지점

분산 트레이싱이 성립하는 이유는 trace ID가 요청을 따라 이동하기 때문입니다. HTTP에서는 이게 헤더로 실려 갑니다.

```text
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
             ^^ ^------------ trace-id ------------^ ^-- span-id --^ ^^
             버전                 16바이트                8바이트    플래그
```

마지막 플래그의 최하위 비트가 **sampled** 입니다. `01`이면 이 트레이스는 기록하기로 결정된 것이고, `00`이면 아니라는 뜻입니다. 이 값이 그대로 하위 서비스에 전달되어, 한 트레이스는 전 구간이 함께 남거나 함께 버려집니다.

HTTP 자동 계측은 이 헤더를 알아서 넣고 뺍니다. 그래서 서비스 A가 서비스 B를 REST로 부르면 트레이스가 이어집니다.

**끊기는 건 HTTP가 아닌 경계입니다.**

- SQS·Kafka 같은 메시지 큐
- 크론이나 배치에서 시작하는 작업
- 지연 실행 잡 큐 (요청 때 넣고 나중에 꺼낸다)
- 웹훅으로 나갔다가 다시 들어오는 경로

이 경로들은 공통점이 있습니다. **메시지 본문은 개발자가 만들고, 헤더에 해당하는 자리가 정해져 있지 않습니다.** 자동 계측이 넣을 곳을 모르니 넣지 못하고, 컨슈머는 부모 없는 새 트레이스를 시작합니다.

증상은 이렇게 나타납니다. API 트레이스는 "큐에 넣음"에서 끝나고, 워커 트레이스는 하늘에서 뚝 떨어진 것처럼 시작합니다. 둘을 이어줄 값이 없어서, 장애 때 "이 실패한 워커 작업이 어느 사용자 요청에서 왔는가"에 답하지 못합니다.

## 컨텍스트를 직접 넘기기

`@opentelemetry/api`의 `propagation`이 이 일을 합니다. 캐리어(평범한 객체)에 현재 컨텍스트를 써넣고, 반대편에서 꺼냅니다.

프로듀서 쪽입니다.

```typescript
import { propagation, context } from "@opentelemetry/api";

type JobPayload = {
  orderId: string;
  // 트레이스 컨텍스트를 담을 자리를 페이로드에 명시적으로 만든다
  _carrier: Record<string, string>;
};

function buildJob(orderId: string): JobPayload {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  // carrier === { traceparent: "00-...-01", tracestate?: "..." }

  return { orderId, _carrier: carrier };
}
```

컨슈머 쪽입니다. 꺼낸 컨텍스트 **안에서** 스팬을 열어야 부모로 연결됩니다.

```typescript
import { propagation, context, trace, SpanStatusCode } from "@opentelemetry/api";

const tracer = trace.getTracer("order-worker");

async function handleJob(payload: JobPayload) {
  const parentCtx = propagation.extract(context.active(), payload._carrier ?? {});

  await context.with(parentCtx, () =>
    tracer.startActiveSpan("order.process", async (span) => {
      try {
        await processOrder(payload.orderId);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    }),
  );
}
```

`context.with(parentCtx, ...)`를 빼먹고 `tracer.startActiveSpan`만 부르면 조용히 새 트레이스가 만들어집니다. **에러가 나지 않기 때문에** 알아채기 어렵고, 나중에 트레이스를 찾을 때가 되어서야 드러납니다.

`span.end()`를 `finally`에 두는 것도 같은 이유입니다. 예외 경로에서 스팬을 닫지 않으면 그 트레이스는 영영 완성되지 않습니다.

> 큐에 따라 컨텍스트를 넣을 적절한 자리가 이미 있습니다. SQS는 메시지 속성, Kafka는 레코드 헤더입니다.
> 페이로드 본문에 섞기보다 그쪽을 쓰는 편이 낫습니다. 본문 스키마를 검증하는 컨슈머가 있으면 `_carrier` 같은 필드가 거부될 수 있습니다.

## 로그에 trace_id를 넣는다

트레이스가 이어져도 로그가 따로 놀면 반쪽입니다. 실무에서 가장 자주 하는 동작이 **로그 한 줄에서 트레이스로 건너뛰는 것**이기 때문입니다.

필요한 건 하나입니다. 모든 로그 줄에 현재 trace ID를 박아 넣는 것.

직접 넣는다면 이렇게 됩니다.

```typescript
import { trace } from "@opentelemetry/api";

function traceFields() {
  const span = trace.getActiveSpan();
  if (!span) return {};

  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

logger.error({ ...traceFields(), orderId }, "결제 승인 실패");
```

pino나 winston을 쓴다면 `@opentelemetry/instrumentation-pino`, `@opentelemetry/instrumentation-winston`이 스팬 컨텍스트 안에서 찍힌 로그에 트레이스 식별자 필드를 자동으로 붙여줍니다. 붙는 필드 이름은 옵션으로 바꿀 수 있으니, 로그 수집 파이프라인의 필드 규칙에 맞춰두면 됩니다.

여기서 실수가 생기는 지점이 하나 있습니다. **스팬 컨텍스트 밖에서 찍힌 로그에는 아무것도 붙지 않습니다.** 프로세스 부팅, 이벤트 리스너, `setInterval` 안쪽 같은 곳입니다. 자동 주입을 켜두고 "이제 모든 로그에 trace_id가 있다"고 가정하면, 하필 그런 자리에서 난 에러를 추적할 수 없습니다.

## 1%를 뽑으면 문제도 1%만 남는다

여기까지 하면 데이터는 제대로 모입니다. 다음 문제는 양입니다.

트레이스를 전부 저장하면 비용이 로그보다 빠르게 오릅니다. 요청 하나가 스팬 수십 개를 만들고, 그게 트래픽에 곱해지기 때문입니다. 그래서 샘플링을 겁니다.

### 헤드 샘플링

트레이스가 **시작될 때** 기록 여부를 정하는 방식입니다. 설정이 간단하고 비용이 예측 가능합니다.

```bash
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.05
```

`parentbased_`가 붙은 이유가 중요합니다. 부모의 결정을 따르게 해서, 한 트레이스가 중간에 반만 남는 상황을 막습니다. 서비스마다 비율을 다르게 주더라도 **최초 진입점의 결정이 전 구간에 적용됩니다.**

문제는 결정 시점입니다. 요청이 시작될 때는 이게 느릴지 실패할지 알 수 없습니다.

> 5% 샘플링에서는 에러 트레이스도 5%만 남습니다.
> 장애가 나서 트레이스를 찾을 때, 95%의 확률로 그 요청은 없습니다.

### 꼬리 샘플링

트레이스가 **끝난 뒤에** 정하는 방식입니다. 컬렉터가 한 트레이스의 스팬을 잠시 모아두고, 다 모였다고 판단되면 그때 정책을 적용합니다.

`tail_sampling` 프로세서는 코어가 아니라 **contrib 배포판**에 들어 있습니다. 코어 이미지로 돌리면 `unknown type: "tail_sampling"` 으로 기동이 실패합니다.

```yaml
processors:
  tail_sampling:
    decision_wait: 10s
    num_traces: 50000
    policies:
      - name: errors
        type: status_code
        status_code:
          status_codes: [ERROR]

      - name: slow
        type: latency
        latency:
          threshold_ms: 2000

      - name: baseline
        type: probabilistic
        probabilistic:
          sampling_percentage: 5
```

정책은 OR로 평가됩니다. 에러이거나, 2초를 넘겼거나, 아니면 무작위 5%. 문제 있는 트레이스는 전부 남기고 정상 트레이스는 비율만큼만 남기는 구성입니다.

대가가 세 가지 있습니다.

**메모리.** `decision_wait` 동안 스팬을 들고 있어야 합니다. `num_traces`가 그 버퍼 크기고, 넘치면 결정 전에 버려집니다. 트래픽이 늘면 여기부터 조입니다.

**지연.** 트레이스가 백엔드에 도착하기까지 `decision_wait`만큼 늦습니다. 장애 대응 중에 "방금 그 요청"이 아직 안 보이는 이유가 대개 이것입니다.

**라우팅.** 한 트레이스의 모든 스팬이 **같은 컬렉터 인스턴스**에 도착해야 합니다. 컬렉터를 여러 대로 띄우고 앞에 일반 로드밸런서를 두면, 같은 트레이스의 스팬이 흩어져서 각 인스턴스가 반쪽만 보고 판단합니다. trace ID 기준으로 분배하는 계층을 앞에 두어야 합니다.

실무에서는 이 셋 때문에 **컬렉터를 2계층으로** 두는 구성이 흔합니다. 앞단은 수집만 하고, 뒷단에서 trace ID로 모아 꼬리 샘플링을 겁니다.

| | 헤드 샘플링 | 꼬리 샘플링 |
| --- | --- | --- |
| 결정 시점 | 트레이스 시작 | 트레이스 종료 후 |
| 에러·지연 보장 | 안 됨 | 됨 |
| 필요한 자원 | 거의 없음 | 컬렉터 메모리 |
| 운영 난이도 | 낮음 | trace ID 기반 라우팅 필요 |
| 네트워크 전송량 | 줄어듦 | 안 줄어듦 (버릴 것도 일단 받는다) |

마지막 줄이 자주 간과됩니다. 꼬리 샘플링은 **저장 비용을 줄이지 전송 비용을 줄이지 않습니다.** 애플리케이션에서 컬렉터까지는 전부 흘러갑니다.

그래서 규모가 커지면 둘을 겹쳐 씁니다. 애플리케이션에서 헤드 샘플링으로 명백히 불필요한 것(헬스체크, 정적 자원)을 먼저 쳐내고, 남은 것에 꼬리 샘플링을 거는 식입니다.

## 에러로 표시되지 않은 에러

꼬리 샘플링의 `status_code` 정책은 스팬에 붙은 상태를 봅니다. 그러니 **스팬이 에러라고 말해주지 않으면 그 트레이스는 걸러지지 않습니다.**

자동 계측이 표시해주는 범위는 생각보다 좁습니다. HTTP 서버 계측은 대개 5xx 응답을 에러로 잡아줍니다. 그 밖은 애플리케이션이 직접 말해야 합니다.

걸러지지 않는 대표적인 경우들입니다.

- 예외를 잡아서 **200으로 응답하고** 본문에 실패를 담는 API
- 4xx로 응답하는 실패. 클라이언트 잘못이라 서버 에러가 아니지만, 갑자기 늘면 봐야 하는 신호입니다
- 워커에서 잡을 실패하고 재시도 큐에 넣는 경로. 요청-응답이 없으니 상태 코드도 없습니다
- 외부 API 호출이 실패했는데 폴백으로 넘어가 전체는 성공한 경우

그래서 도메인이 "실패"라고 부르는 지점에서 직접 표시해줍니다.

```typescript
import { trace, SpanStatusCode } from "@opentelemetry/api";

async function approvePayment(req: ApproveRequest) {
  const span = trace.getActiveSpan();

  const result = await pg.approve(req);
  if (!result.ok) {
    // HTTP 200으로 나가더라도 트레이스에는 실패로 남긴다
    span?.setStatus({ code: SpanStatusCode.ERROR, message: result.code });
    span?.setAttribute("app.failure_reason", result.code);
  }
  return result;
}
```

반대 방향의 실수도 있습니다. **정상인데 에러로 표시하는 것**입니다. 재고 없음이나 중복 요청 거절처럼 자주 일어나는 정상 분기를 에러로 찍으면, 꼬리 샘플링이 그걸 전부 통과시켜서 비용만 오르고 신호 대 잡음비는 나빠집니다.

`status_code` 하나로 부족하면 정책을 조합합니다. `and` 정책으로 조건을 겹치거나, `string_attribute`로 특정 속성 값을 가진 트레이스만 남기는 식입니다. 다만 정책을 늘릴수록 "왜 이 트레이스가 없지"를 설명하기 어려워지니, 세 개 안쪽에서 시작하는 편이 낫습니다.

## 카디널리티는 메트릭의 문제다

스팬에 사용자 ID나 주문 번호를 붙여도 되는지 망설이는 경우가 있는데, 여기서 두 신호를 구분해야 합니다.

**메트릭에서는 라벨 하나가 시계열 하나입니다.** `user_id`를 라벨로 붙이면 사용자 수만큼 시계열이 생기고, 이건 실제로 시스템을 무너뜨립니다.

**트레이스는 그렇지 않습니다.** 스팬은 개별 이벤트 레코드라 속성을 추가해도 시계열이 늘지 않습니다. 오히려 "이 사용자의 이 주문"으로 좁혀 찾는 게 트레이싱을 쓰는 이유에 가깝습니다.

```typescript
const span = trace.getActiveSpan();
span?.setAttributes({
  "app.order_id": orderId,      // 좋다 — 특정 건을 찾을 수 있다
  "app.user_id": userId,        // 좋다
  "app.payment_method": method, // 좋다
});
```

다만 **넣으면 안 되는 것**은 분명합니다. 카드번호, 주민등록번호, 토큰, 비밀번호, 응답 본문 전체 같은 것들입니다.
트레이스 백엔드는 대개 로그보다 접근 통제가 느슨하게 운영되고, 한 번 들어간 값은 보존 기간이 끝날 때까지 남습니다.

속성 이름에 접두사를 붙여두면 나중에 편합니다. `http.`·`db.` 같은 이름은 시맨틱 컨벤션이 쓰는 영역이라, 직접 넣는 값은 `app.`처럼 구분해두면 충돌하지 않습니다.

> 시맨틱 컨벤션의 속성 이름과 상수 export 이름은 안정화 과정에서 바뀐 것들이 있습니다.
> 상수를 코드에서 import해 쓸 거라면 설치한 패키지 버전의 목록을 확인하세요.

## 붙이기 전에 정할 것

도구를 켜는 것보다 **무엇에 답하고 싶은가**를 먼저 정해두면 설정이 단순해집니다.

- [ ] 큐·배치 경계에서 컨텍스트를 명시적으로 전파하는가 (자동 계측은 여기까지 안 온다)
- [ ] 모든 로그에 trace ID가 붙는가, 그리고 **안 붙는 자리가 어디인지** 아는가
- [ ] 에러와 느린 요청의 트레이스가 확률과 무관하게 남는가
- [ ] 꼬리 샘플링을 쓴다면 같은 트레이스가 같은 컬렉터로 가는가
- [ ] 스팬 속성에 민감정보가 들어갈 경로가 없는가
- [ ] 트레이스 보존 기간과 그에 따른 비용을 알고 있는가

{% comment %} TODO: 실제로 구성한 컬렉터 배치(사이드카/데몬셋/게이트웨이 중 무엇인지)와 백엔드 선택, 샘플링 비율을 어떻게 정했는지 적어주세요 {% endcomment %}

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 트레이스가 끊겨서 원인 파악이 늦어졌던 사례
- 샘플링 비율을 조정하며 확인한 비용 변화

{% endcomment %}
