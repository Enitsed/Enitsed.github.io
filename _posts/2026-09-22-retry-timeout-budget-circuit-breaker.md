---
layout: post
title: "재시도를 켰더니 장애가 길어졌다 — 타임아웃 예산과 재시도 증폭"
date: 2026-09-22
tags: [backend, architecture, typescript, api, devops]
excerpt: "하류가 흔들릴 때 재시도는 부하를 곱해서 되돌려줍니다. 타임아웃을 안 걸면 실제로 얼마나 기다리는지, 계층마다 재시도를 걸면 몇 배가 되는지, 데드라인 전파·지터·재시도 예산·서킷 브레이커를 어디에 둘지 정리합니다."
---

하류 API가 가끔 실패해서 재시도를 넣습니다. 3회, 지수 백오프. 에러율이 내려가고 잘 돌아갑니다.

그러다 하류가 제대로 한 번 흔들리면, 재시도를 넣기 전보다 복구가 오래 걸립니다.
재시도는 **실패가 드물 때** 성공률을 올리는 장치인데, 장애는 실패가 드물지 않은 상태이기 때문입니다.

## 재시도가 곱셈이 되는 지점

요청 하나가 5% 확률로 독립적으로 실패한다면 재시도는 잘 작동합니다. 두 번째 시도는 대개 성공합니다.

하류가 과부하라면 전제가 깨집니다. 실패는 독립이 아니라 **동시에, 전부** 일어납니다.
그 순간 모든 클라이언트가 재시도를 시작하고, 이미 버거운 서버에 트래픽이 곱해져서 돌아갑니다.

계층이 겹치면 곱셈이 누적됩니다.

```text
클라이언트 ──(3회)──> 게이트웨이 ──(3회)──> BFF ──(3회)──> 결제 서비스
                                          원래 요청 1건 → 최대 27건
```

각 계층은 "3회면 적당하지"라고 판단했지만 맨 아래가 받는 건 27배입니다. 계층마다 따로 정한 값이라 누구도 이 숫자를 본 적이 없습니다.

더 나쁜 건 회복 구간입니다. 하류가 겨우 처리를 시작하려는 순간 쌓여 있던 재시도가 한꺼번에 밀려들어 다시 무너뜨립니다.
부하가 원래 수준으로 돌아왔는데도 시스템이 스스로 회복하지 못하는 상태가 여기서 만들어집니다.

## 타임아웃이 없으면 기본값은 "영원히"

재시도는 실패를 인지한 다음에야 시작되고, 그 인지 시점을 정하는 게 타임아웃입니다. 그래서 순서가 타임아웃이 먼저입니다.

타임아웃은 하나가 아니라 최소한 셋입니다.

| 종류 | 언제 끊는가 | 안 걸면 |
| --- | --- | --- |
| 연결(connect) | TCP·TLS 수립까지 | 패킷이 조용히 버려지는 구간에서 한참 매달림 |
| 응답 대기(read) | 바이트가 안 올 때 | 서버가 붙들고만 있으면 무한 대기 |
| 전체(total) | 요청 시작부터 본문 수신 완료까지 | 응답이 찔끔씩 오면 read 타임아웃은 계속 갱신됨 |

흔한 실수는 read 타임아웃만 거는 것입니다. 상대가 1분에 한 바이트씩 보내면 read 타임아웃은 영원히 안 걸립니다.
**실제로 필요한 건 전체 시간 상한**이고, 나머지 둘은 그 안을 쪼개는 값입니다.

```typescript
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 2_000);
try {
  const res = await fetch(url, { signal: ac.signal });
  return await res.json();   // 본문을 읽는 동안에도 같은 신호가 걸려 있다
} finally {
  clearTimeout(timer);
}
```

런타임이 지원한다면 `AbortSignal.timeout(2_000)`으로 짧게 쓸 수 있습니다.
중요한 건 **본문 읽기까지 신호 안에 들어간다**는 점입니다. 응답 헤더만 받고 타이머를 풀면 전체 상한이 아닙니다.

> HTTP 클라이언트·DB 드라이버의 기본 타임아웃은 라이브러리마다 다르고, "기본값 없음"인 경우도 드물지 않습니다.
> 값을 외우지 말고 **쓰는 라이브러리의 현행 문서에서 확인하고 명시적으로 설정**하세요.

타임아웃이 빠지기 쉬운 자리가 하나 더 있습니다. **커넥션 풀에서 커넥션을 얻기까지 기다리는 시간**입니다.
하류가 느려지면 커넥션이 전부 점유되고, 그다음 요청은 아직 소켓도 못 잡은 채 풀 앞에 줄을 섭니다.
여기에 상한이 없으면 HTTP 타임아웃을 아무리 잘 걸어놔도 그 앞에서 시간이 새어나갑니다.

## 타임아웃 예산 — 부등식으로 맞춘다

계층별 타임아웃을 각자 정하면 거의 항상 어긋납니다. 기준은 하나의 부등식입니다.

```text
상류 타임아웃  ≥  (하류 타임아웃 × 시도 횟수) + 백오프 대기 합 + 자기 처리 시간
```

이게 깨지면 두 가지 중 하나가 일어납니다.

**너무 짧으면** 상류는 이미 포기하고 에러를 줬는데 하류 작업은 계속 돌아갑니다. 아무도 받지 않을 응답을 만드느라 자원을 쓰는 것이고, 재시도 2·3회차는 시작될 기회조차 없이 버려집니다.

**너무 길면** 하류가 느려진 만큼 상류의 워커와 커넥션이 묶입니다. 장애가 한 서비스에 머물지 않고 위로 전파되는 경로가 이것입니다.

값은 아래에서 위로 올라오며 정하는 편이 낫습니다.

| 계층 | 시도 | 호출당 상한 | 필요한 자기 예산 |
| --- | --- | --- | --- |
| 결제 서비스 → 외부 PG | 2 | 3s | 6s + 백오프 |
| BFF → 결제 서비스 | 1 | 8s | 8s + 처리 |
| 게이트웨이 → BFF | 1 | 10s | — |

재시도는 **한 계층에만** 두는 게 기본입니다. 위 표에서 재시도를 가진 건 외부 PG를 부르는 맨 아래뿐입니다.
가장 아래에 두는 이유는, 거기가 실패 원인을 가장 잘 알고 증폭 폭도 가장 작기 때문입니다.

### 데드라인은 값으로 내려보낸다

계층마다 타임아웃을 고정값으로 두면, 상류에서 이미 8초를 쓴 뒤 시작한 하류 호출이 자기 몫 3초를 그대로 씁니다.
답은 남은 시간을 함께 내려보내는 것입니다.

```typescript
type Deadline = { at: number };                    // epoch ms
const remaining = (d: Deadline) => d.at - Date.now();

const MIN_USEFUL_MS = 50;                          // 이보다 적게 남았으면 시작하지 않는다

async function callDownstream(path: string, d: Deadline, perCallMs: number) {
  const left = remaining(d);
  if (left < MIN_USEFUL_MS) throw new DeadlineExceededError(path);

  return fetch(BASE_URL + path, {
    signal: AbortSignal.timeout(Math.min(left, perCallMs)),
    headers: { "x-deadline-ms": String(left) },     // 하류가 자기 상한을 여기서 줄인다
  });
}
```

남은 시간이 거의 없을 때 **호출을 아예 시작하지 않는 것**이 이 구조의 핵심 이득입니다.
어차피 버려질 작업을 하류에 밀어 넣지 않으니, 과부하 구간에서 하류가 헛도는 양이 줄어듭니다.

> HTTP에는 데드라인 전파 표준 헤더가 없습니다. gRPC의 타임아웃 메타데이터처럼 프로토콜이 제공하는 게 아니라면,
> 헤더 이름과 단위는 **내부 규약으로 정하고 문서화**해야 합니다. 외부에서 들어온 값은 그대로 믿지 말고 서버 상한으로 한 번 자릅니다.

## 무엇을 재시도해도 되는가

질문은 둘입니다. 안전한가, 그리고 재시도할 값어치가 있는가.

| 실패 유형 | 요청이 서버에 닿았나 | 재시도 |
| --- | --- | --- |
| DNS 실패, 연결 거부 | 안 닿음 (확실) | 안전 |
| 연결 후 타임아웃·연결 끊김 | **알 수 없음** | 멱등할 때만 |
| 429, 503 | 닿았고 거절됨 | `Retry-After` 존중 |
| 500, 502, 504 | 알 수 없음 | 멱등할 때만 |
| 400, 401, 403, 422 | 닿았고 거부됨 | 무의미 — 같은 요청은 또 실패 |

가장 많이 틀리는 칸은 두 번째 줄입니다. **응답을 못 받은 것과 처리가 안 된 것은 다릅니다.**
서버가 결제를 만들고 나서 응답이 유실됐을 수도 있고, 그 요청을 재시도하면 두 번 결제됩니다.
그래서 쓰기 재시도는 [멱등키](/blog/idempotency-key-payment-api/)를 먼저 붙인 다음에 켜는 게 순서입니다.

4xx는 입력이 문제라 백 번 보내도 같은 답이 오고, 그동안 하류 용량만 축냅니다.
429만 예외입니다. "지금 말고 나중에"라는 뜻이라 대기 후 재시도가 맞습니다.

```typescript
function retryAfterMs(res: Response): number | null {
  const v = res.headers.get("retry-after");
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs * 1000;    // 초 단위 형식
  const at = Date.parse(v);                         // HTTP-date 형식
  return Number.isNaN(at) ? null : at - Date.now();
}
```

서버가 언제 다시 오라고 알려줬다면 그 값이 우리 백오프 계산보다 정확합니다. 두 형식이 모두 허용되니 둘 다 처리해야 합니다.

## 백오프에는 반드시 지터를 넣는다

고정 간격 재시도는 폭풍을 만듭니다. 같은 순간에 실패한 클라이언트들이 같은 간격으로 깨어나 1초 뒤에 다시 한꺼번에 몰립니다.

지수 백오프만으로도 부족합니다. 간격이 늘어나도 **여전히 서로 같은 시점**이라, 무작위를 섞어 시점을 흩어야 합니다.

```typescript
const BASE_MS = 100;
const CAP_MS = 2_000;

// full jitter: [0, min(cap, base * 2^n)) 구간에서 균등 추출
const backoff = (attempt: number) =>
  Math.random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt);

async function withRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: { attempts: number; deadline: Deadline; retriable: (e: unknown) => boolean },
): Promise<T> {
  let last: unknown;

  for (let i = 0; i < opts.attempts; i++) {
    const left = remaining(opts.deadline);
    if (left < MIN_USEFUL_MS) break;               // 남은 예산 안에서만 재시도한다

    try {
      return await fn(AbortSignal.timeout(left));
    } catch (e) {
      last = e;
      if (!opts.retriable(e)) throw e;             // 재시도 무의미한 오류는 즉시 올린다

      const wait = Math.min(backoff(i), remaining(opts.deadline) - MIN_USEFUL_MS);
      if (wait <= 0) break;
      await sleep(wait);
    }
  }
  throw last;
}
```

눈여겨볼 건 횟수가 아니라 **데드라인이 함께 걸려 있다는 점**입니다.
횟수만 제한하면 "3회 × 3초 + 백오프"가 예산을 넘겨도 계속 돌지만, 남은 시간을 매번 확인하면 초과가 구조적으로 불가능합니다.

## 횟수가 아니라 비율로 막는 재시도 예산

"요청당 3회"는 전체 부하에 대해 아무것도 말해주지 않습니다. 하류가 100% 실패하는 순간, 정상 트래픽이 그대로 3배가 되니까요.

필요한 건 클라이언트 쪽에서의 총량 제한입니다. **성공한 요청에 비례해서만 재시도 토큰을 채웁니다.**

```typescript
class RetryBudget {
  private tokens: number;

  constructor(
    private readonly ratio = 0.1,   // 성공 요청의 10%까지만 재시도에 쓴다
    private readonly max = 100,
  ) {
    this.tokens = max;
  }

  onSuccess() {
    this.tokens = Math.min(this.max, this.tokens + this.ratio);
  }

  tryConsume(): boolean {
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
```

성질 하나가 이 구조의 전부입니다. **하류가 전면 장애면 성공이 없으니 토큰이 곧 마르고, 재시도가 저절로 꺼집니다.**
간헐적 실패일 때는 성공이 계속 토큰을 채우니 재시도가 정상 작동합니다. 상황을 판단하는 코드를 따로 쓰지 않아도 됩니다.

예산이 바닥나면 재시도 없이 바로 실패로 올리고 그 사실을 지표로 남깁니다.
`retry_budget_exhausted` 같은 카운터가 올라가는 순간이 곧 하류 장애의 조기 신호입니다.

## 서킷 브레이커 — 빨리 실패하기

재시도 예산이 재시도만 줄인다면 브레이커는 **원 요청까지 끊습니다.**
하류가 확실히 죽어 있을 때 매번 3초를 기다렸다 실패하는 건 상류 자원만 묶는 일이라, 그럴 바엔 즉시 실패하는 편이 낫습니다.

```typescript
type State = "closed" | "open" | "half_open";

class Breaker {
  private state: State = "closed";
  private fail = 0;
  private total = 0;
  private openedAt = 0;
  private probing = false;

  constructor(
    private readonly o: { minSamples: number; failRatio: number; openMs: number },
  ) {}

  private allow(): boolean {
    if (this.state === "open") {
      if (Date.now() - this.openedAt < this.o.openMs) return false;
      this.state = "half_open";
      this.probing = false;
    }
    if (this.state === "half_open") {
      if (this.probing) return false;              // 탐색 요청은 한 번에 하나만
      this.probing = true;
    }
    return true;
  }

  private open() {
    this.state = "open";
    this.openedAt = Date.now();
    this.fail = this.total = 0;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.allow()) throw new CircuitOpenError();

    try {
      const r = await fn();
      if (this.state === "half_open") this.state = "closed";
      this.total++;
      this.settle();
      return r;
    } catch (e) {
      if (this.state === "half_open" || !isDownstreamFault(e)) {
        if (this.state === "half_open") this.open();
        throw e;
      }
      this.total++;
      this.fail++;
      this.settle();
      throw e;
    }
  }

  private settle() {
    if (this.total < this.o.minSamples) return;    // 표본이 적으면 비율을 믿지 않는다
    if (this.fail / this.total >= this.o.failRatio) this.open();
    this.fail = this.total = 0;
  }
}
```

구현에서 실제로 물리는 지점들입니다.

**무엇을 실패로 세는가.** 타임아웃과 5xx는 하류 잘못이지만 400·422는 우리 요청이 잘못된 것입니다.
검증 실패를 실패로 세면 **멀쩡한 하류 앞에서 브레이커가 열립니다.** 위 코드의 `isDownstreamFault`가 그 경계입니다.

**표본 수 하한.** 트래픽이 적은 경로에서 비율만 보면 2건 중 1건 실패로 50%가 나옵니다. 최소 표본을 안 두면 브레이커가 쉴 새 없이 여닫힙니다.

**half-open 동시 진입.** 열린 시간이 끝나는 순간 대기 중이던 요청이 전부 통과하면, 겨우 살아나던 하류가 다시 넘어집니다. 탐색은 한 건씩입니다.

**브레이커는 프로세스마다 따로입니다.** 인스턴스가 100대면 회복 시점에 탐색 요청도 100건이 한꺼번에 갑니다.
`openMs`에 약간의 무작위를 섞으면 이 동기화가 풀립니다. 앞의 지터와 같은 이유입니다.

> 브레이커를 어느 단위로 만들지가 설계입니다. 대개 **하류 서비스별, 필요하면 엔드포인트별**입니다.
> 하나의 느린 엔드포인트 때문에 그 서비스 호출 전체가 끊기면 장애 범위를 우리 손으로 넓히는 셈이 됩니다.

브레이커가 열렸을 때 무엇을 돌려줄지도 같이 정해야 합니다.
캐시된 값, 축소된 응답, 아니면 명시적인 503 중 하나입니다. **폴백이 없으면 브레이커는 그저 더 빨리 실패하는 장치**이고, 그것만으로도 의미는 있지만 사용자에게 보이는 결과는 실패 그대로입니다.

## 어디에 둘까

| 위치 | 장점 | 주의 |
| --- | --- | --- |
| 애플리케이션 코드 | 도메인 지식 반영 (멱등 여부, 폴백) | 호출 지점마다 중복되기 쉬움 |
| 공용 클라이언트·SDK | 정책을 한 곳에서 관리 | 기본값이 켜져 있는지 모르고 이중 적용 |
| 서비스 메시·프록시 | 코드 변경 없이 일괄 적용 | 멱등 여부를 모름 — 쓰기까지 재시도할 위험 |

가장 흔한 사고가 **이중 재시도**입니다. 메시에 3회가 켜져 있는 줄 모르고 앱에서 3회를 더 걸면 9회가 됩니다.
어느 계층에 재시도가 있는지 한 장으로 적어두는 것만으로 앞에서 본 27배가 안 생깁니다.

재시도로 풀 문제가 아닌 경우도 있습니다.

- 하류가 느린 게 상시라면 **큐로 비동기화**하는 쪽이 맞습니다. 요청 경로에서 기다리며 재시도하는 건 용량을 맞추는 방법이 아닙니다.
- 우리 쪽이 과부하라면 재시도가 아니라 **부하 차단**입니다. 받을 수 없는 요청은 큐에 쌓지 말고 빨리 429로 돌려보내는 게 전체 지연을 줄입니다.
- 같은 대상에 대한 중복 호출이라면 [요청 병합](/blog/cache-stampede-swr/)으로 애초에 호출 수를 줄일 수 있습니다.

## 정리

세 가지만 지켜도 대부분의 증폭은 사라집니다.

모든 외부 호출에 **전체 시간 상한**이 있을 것. 커넥션 풀 대기까지 포함해서.

재시도는 **한 계층에만**, 그리고 데드라인과 예산 안에서. 횟수 제한만으로는 총량이 안 잡힙니다.

재시도할 수 있는 오류인지 **분류**할 것. 특히 "응답을 못 받았다"와 "처리되지 않았다"를 같은 칸에 넣지 말 것.

{% comment %} TODO: 실제 서비스에서 계층별로 타임아웃을 몇으로 맞췄는지, 재시도 예산이나 브레이커를 도입한 뒤 지표가 어떻게 달라졌는지 수치가 있으면 넣어주세요 {% endcomment %}
