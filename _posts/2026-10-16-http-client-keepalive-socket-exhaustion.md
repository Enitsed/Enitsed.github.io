---
layout: post
title: "열 번에 한 번 소켓이 끊긴다 — HTTP 클라이언트 커넥션 재사용의 비용"
date: 2026-10-16
tags: [backend, nodejs, typescript, devops, performance]
excerpt: "외부 API 호출이 대체로 잘 되는데 하루에 몇 건은 ECONNRESET으로 죽고, 상대 서버 로그에는 그 요청이 없습니다. 커넥션을 재사용하지 않을 때 내는 비용과 재사용하기 시작하면 생기는 유휴 소켓 경쟁, keepAliveMsecs가 유휴 수명이 아니라는 점, maxSockets가 만드는 보이지 않는 큐, 포트와 NAT 쪽 한도, 그리고 오래 붙어 있는 커넥션이 로드밸런서의 분산을 무력화하는 지점까지."
---

외부 API 호출이 대체로 잘 됩니다. 그런데 하루에 몇 건씩 `ECONNRESET`이나 `socket hang up`으로 죽습니다.

재현은 안 되고, 상대 서버 로그에는 그 요청이 아예 없습니다. 네트워크가 불안정하다는 결론으로 가기 쉬운데, 이건 커넥션을 재사용하기로 한 순간부터 생기는 종류의 실패입니다.

재사용을 끄면 이 실패는 사라집니다. 대신 다른 비용이 올라옵니다. 양쪽을 다 보고 고르는 게 이 글의 목적입니다.

## 매 요청마다 새로 연결하면 무엇을 내는가

연결을 재사용하지 않으면 요청 하나가 이렇게 시작합니다.

1. 이름 조회 — Node.js에서는 `getaddrinfo`가 libuv 스레드풀로 갑니다.
2. TCP 3-way 핸드셰이크 — 왕복 1회.
3. TLS 핸드셰이크 — 왕복이 더 붙습니다.
4. 그다음에야 요청 바이트가 나갑니다.

같은 리전 안이면 왕복이 짧아서 눈에 잘 안 띕니다. **리전이 다르거나 외부 결제사·알림사처럼 인터넷을 건너가는 호출에서는 핸드셰이크가 응답 시간의 절반을 넘기기도 합니다.**

증상은 특징적입니다. p50은 멀쩡한데 **한 요청이 외부 호출을 여러 번 하는 엔드포인트에서만 p99가 튑니다.** 호출 수에 비례해 핸드셰이크가 쌓이기 때문입니다.

이름 조회가 스레드풀을 거친다는 점도 겹칩니다. 스레드풀이 다른 일로 차 있으면 조회가 큐에서 기다리고, 그러면 외부 호출만 느려집니다. [이벤트 루프 블로킹](/blog/nodejs-event-loop-blocking/)에서 다룬 두 번째 범인이 여기서 다시 나옵니다.

그리고 닫은 연결은 바로 사라지지 않습니다. 능동적으로 닫은 쪽에는 `TIME_WAIT` 상태가 남고, 이게 쌓이면 뒤에서 포트가 마릅니다. 이건 뒤에서 따로 보겠습니다.

## 지금 재사용되고 있는지부터 확인한다

"keep-alive는 요즘 기본이죠"라는 말이 가장 위험합니다. 기본값이 하나가 아닙니다.

Node.js 문서 기준으로 `new Agent()`의 `keepAlive`는 **기본이 꺼짐**이고, `http.globalAgent`는 keep-alive가 켜진 채 `timeout`이 5초로 설정돼 있습니다([v19.0.0에서 바뀐 동작](https://nodejs.org/api/http.html#httpglobalagent)). 즉 **직접 에이전트를 만들면 글로벌 에이전트보다 설정이 나빠질 수 있습니다.**

더 흔한 함정은 라이브러리입니다. HTTP 클라이언트 래퍼가 내부에서 자기 에이전트를 만들어 쓰면, 글로벌 에이전트에 무엇을 해도 그 호출에는 아무 영향이 없습니다.

그래서 추측하지 말고 프로세스에서 직접 찍어봅니다.

```typescript
import http from 'node:http';
import https from 'node:https';

// 내가 쓰는 에이전트가 실제로 어떤 값으로 돌고 있는지
for (const [name, agent] of [
  ['http.globalAgent', http.globalAgent],
  ['https.globalAgent', https.globalAgent],
] as const) {
  const { keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets, timeout } =
    agent.options as Record<string, unknown>;
  console.log(name, { keepAlive, keepAliveMsecs, maxSockets, maxFreeSockets, timeout });
}
```

그다음은 재사용이 실제로 일어나는지입니다. 에이전트는 소켓 상태를 그대로 노출합니다.

```typescript
const snapshot = (agent: http.Agent) => ({
  // 요청에 쓰이고 있는 소켓
  active: Object.values(agent.sockets).reduce((n, s) => n + s.length, 0),
  // 다음 요청을 기다리는 유휴 소켓 — 이게 0이면 재사용이 안 되고 있다
  free: Object.values(agent.freeSockets ?? {}).reduce((n, s) => n + s.length, 0),
  // 소켓을 못 잡아 큐에 선 요청 — 이게 쌓이면 상한이 병목이다
  queued: Object.values(agent.requests).reduce((n, r) => n + r.length, 0),
});

setInterval(() => console.log('agent', snapshot(https.globalAgent)), 10_000);
```

`free`가 계속 0이면 재사용이 안 되고 있습니다. 호스트 쪽에서도 같은 걸 셀 수 있습니다.

```bash
# 목적지별로 몇 개가 ESTABLISHED인지 — 재사용되면 요청량이 늘어도 이 수는 완만하게 움직인다
ss -tan state established 'dport = :443' | awk '{print $5}' | sort | uniq -c | sort -rn | head

# TIME_WAIT가 쌓이고 있는지
ss -tan state time-wait | wc -l
```

요청량은 늘었는데 ESTABLISHED 수가 같이 비례해서 늘고 `TIME_WAIT`가 쌓이면, 매 요청마다 새로 맺고 있는 것입니다.

## keepAliveMsecs는 유휴 소켓의 수명이 아니다

여기서 거의 모두가 한 번 헛디딥니다.

`keepAliveMsecs`는 **TCP keep-alive 프로브를 보내기 시작하는 지연**입니다. 유휴 소켓을 몇 초 뒤에 닫을지 정하는 값이 아닙니다. 이름이 비슷해서 "1초 뒤에 닫히겠네"로 읽히는데, 그렇지 않습니다.

코어 에이전트에서 유휴 소켓의 수명을 정하는 것은 `timeout` 옵션입니다. 글로벌 에이전트에 5초가 들어가 있는 것도 이 값입니다.

```typescript
export const agent = new https.Agent({
  keepAlive: true,
  timeout: 10_000,       // 유휴 소켓을 10초 쥐고 있다가 닫는다
  keepAliveMsecs: 1_000, // TCP 프로브 지연 — 위와 별개의 값
  maxSockets: 64,
  maxFreeSockets: 16,
});
```

> `timeout`은 소켓 비활동 타임아웃이라 요청이 진행되는 중에도 적용됩니다. 그리고 이 타임아웃은 `'timeout'` 이벤트만 발생시키고 **요청을 자동으로 끊지 않습니다.** 응답을 기다리다 멈추는 상황을 막으려면 요청 쪽 타임아웃을 따로 걸어야 합니다.
> 버전에 따라 서버의 `Keep-Alive` 힌트를 다루는 옵션이 추가되기도 했으니, 쓰는 버전의 `http` 문서에서 기본값을 한 번 확인하는 편이 안전합니다.

`timeout`을 주지 않고 `keepAlive: true`만 켜면 유휴 소켓을 오래 쥐게 됩니다. 그게 바로 다음 문제의 재료입니다.

## 간헐적 ECONNRESET의 구조

유휴 소켓의 수명은 양쪽이 **각자** 정합니다. 그리고 서로에게 알려주지 않습니다.

서버나 로드밸런서가 유휴 타임아웃에 도달해 FIN을 보냅니다. 그 FIN이 도착하기 전, 혹은 처리되기 전에 클라이언트가 그 소켓을 집어 요청을 씁니다. 상대는 이미 닫은 소켓에 들어온 데이터라 RST로 답합니다.

애플리케이션에서는 `ECONNRESET` 또는 `socket hang up`으로 보입니다. **상대 서버 로그에 요청이 없는 이유가 여기 있습니다. 요청이 애플리케이션까지 가지 않았습니다.**

재사용률이 높고 유휴 시간이 긴 호출에서 비율이 올라갑니다. 트래픽이 한가한 새벽에 더 자주 보이는 것도 같은 이유입니다.

고치는 방향은 두 개이고, 둘 다 필요합니다.

**첫째, 수명 부등식을 맞춥니다.**

```text
클라이언트 유휴 소켓 수명  <  서버/LB의 유휴 타임아웃
```

클라이언트가 먼저 닫으면 경쟁이 생기지 않습니다. 상대 유휴 타임아웃을 알 수 있으면 그보다 넉넉히 짧게 잡습니다. 모르면 짧게 잡는 쪽이 안전합니다. 재사용 이득을 조금 잃는 대신 경쟁이 사라집니다.

[배포 때마다 5xx가 찍히는 이유](/blog/graceful-shutdown-deploy-5xx/)에서 서버 쪽 keep-alive 경쟁을 맞출 때 쓴 것과 같은 모양의 부등식입니다. 방향만 반대입니다.

소켓을 고르는 순서도 여기에 영향을 줍니다. 코어 에이전트의 `scheduling` 기본값은 `'lifo'`라서, 가장 최근에 쓴 소켓을 먼저 재사용합니다. 오래 놀던 소켓 — 상대가 이미 닫았을 가능성이 높은 쪽 — 을 덜 집게 되니 이 기본값은 그냥 두는 편이 낫습니다.

undici는 서버가 보내는 `Keep-Alive` 힌트를 읽어 자기 유휴 타임아웃을 조정합니다. 기본값은 유휴 타임아웃 4초, 힌트로 올릴 수 있는 상한 10분이고, 힌트에서 1초를 깎아 전송 지연을 감안합니다. 상대가 힌트를 주는 서버라면 이쪽이 경쟁에 덜 취약합니다.

**둘째, 그래도 0은 안 되니 재시도를 둡니다.**

이 실패는 요청이 상대 애플리케이션에 도달하지 않았다는 점에서 재시도하기 좋은 축에 듭니다. 다만 **"도달하지 않았다"를 클라이언트가 확신할 수 있는 경우에만** 그렇습니다.

Node.js는 요청 객체에 그 요청이 **재사용한 소켓으로 나갔는지**를 남겨둡니다. 오류 객체가 아니라 요청 객체에 있다는 점이 중요합니다.

```typescript
import https from 'node:https';

const RETRIABLE = new Set(['ECONNRESET', 'EPIPE']);

type Tagged = NodeJS.ErrnoException & { reusedSocket?: boolean };

function attempt(url: string, agent: https.Agent): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(body));
    });

    req.on('error', (err: Tagged) => {
      // 판별은 요청 객체에서 가져온다
      err.reusedSocket = req.reusedSocket === true;
      reject(err);
    });
  });
}

export async function call(url: string, agent: https.Agent): Promise<string> {
  try {
    return await attempt(url, agent);
  } catch (err) {
    const e = err as Tagged;
    if (e.reusedSocket && RETRIABLE.has(e.code ?? '')) {
      return await attempt(url, agent);   // 새 소켓으로 한 번만
    }
    throw err;
  }
}
```

이 판별이 말해주는 것은 "유휴 소켓 경쟁이었을 가능성이 높다"까지입니다. **요청이 상대에게 도달하지 않았음을 증명해주지는 않습니다.**

응답을 받기 전에 끊긴 경우는 서버가 요청을 읽은 뒤에 끊은 것일 수도 있습니다. Node.js 문서도 이 판별을 **멱등한 요청의 재시도**에 쓰라고 안내합니다. 멱등하지 않은 호출에 이걸 근거로 재시도를 붙이는 건 범위를 넘는 해석입니다.

> 결제 생성처럼 중복이 돈이 되는 호출은 이 판별에 기대지 말고 [멱등키](/blog/idempotency-key-payment-api/)를 붙이는 쪽이 맞습니다. 그러면 "도달했는지 모르겠다"가 더 이상 무서운 상태가 아니게 됩니다.

재시도 횟수는 1회로 충분합니다. 이 실패는 새 소켓을 맺으면 사라지는 종류입니다. 여기에 백오프와 다단계 재시도를 얹으면 [재시도 증폭](/blog/retry-timeout-budget-circuit-breaker/) 쪽 문제를 새로 만듭니다.

## maxSockets가 만드는 보이지 않는 큐

코어 에이전트의 `maxSockets` 기본값은 호스트당 무제한입니다. 상한이 없으면 하류가 느려질 때 소켓이 계속 늘어납니다.

그 끝은 셋 중 하나입니다. 파일 디스크립터 한도, 포트 고갈, 혹은 **상대 서버를 우리가 밀어서 같이 눕히는 것**입니다. 하류가 느려졌다는 신호에 동시 호출을 늘려 응답하는 셈이라, 방향이 반대입니다.

그래서 상한을 겁니다. 그런데 상한을 걸면 **소켓을 못 잡은 요청이 에이전트 안에서 큐에 섭니다.**

이 대기는 어느 지표에도 안 나옵니다. 상대 API의 응답 시간은 정상이고, 우리 엔드포인트 응답 시간만 올라갑니다. [커넥션 풀이 마르는 순간](/blog/db-connection-pool-exhaustion/)에서 DB 풀을 두고 했던 이야기와 똑같은 구조이고, 이쪽은 풀이 외부 HTTP라는 점만 다릅니다.

그러니 큐 길이를 반드시 내보냅니다. 위 `snapshot()`의 `queued`가 그 값입니다. 0에서 자꾸 떠오르면 상한이 병목이거나 하류가 느려진 것이고, 둘은 대응이 다릅니다.

| 신호 | 해석 | 할 일 |
| --- | --- | --- |
| `queued` 증가, 상대 응답 시간 정상 | 상한이 낮다 | `maxSockets`를 올린다 |
| `queued` 증가, 상대 응답 시간도 증가 | 하류가 느려졌다 | 올리지 말고 빨리 실패시킨다 |
| `free`가 0에 가깝고 `active`만 큼 | 재사용이 안 된다 | `keepAlive`·`maxFreeSockets` 확인 |

두 번째 칸에서 상한을 올리는 것이 가장 흔한 오판입니다. 그 조치는 장애를 더 길게 만듭니다.

그리고 **큐 대기가 타임아웃에 포함되는지 확인해야 합니다.** 응답 타임아웃만 걸어두면 큐에서 기다린 시간은 예산 밖에 있게 되고, 그러면 "3초 타임아웃"이 실제로는 몇 초든 될 수 있습니다. 데드라인은 큐에 들어가기 전부터 흐르게 만들어야 합니다.

undici를 쓰면 상한이 오리진 단위로 명시됩니다.

```typescript
import { Agent, request } from 'undici';

const dispatcher = new Agent({
  connections: 64,          // 오리진당 커넥션 상한
  pipelining: 1,            // 파이프라이닝은 켜지 말 것 (아래)
  keepAliveTimeout: 10_000, // 유휴 소켓 수명
  keepAliveMaxTimeout: 60_000,
  headersTimeout: 5_000,
  bodyTimeout: 10_000,
});

export const call = (url: string) => request(url, { dispatcher });
```

> 내장 `fetch`의 디스패처를 바깥에서 갈아끼우는 방법은 런타임 버전에 따라 다릅니다. 커넥션 설정을 통제해야 하는 호출이라면 `undici`를 직접 의존성으로 두고 디스패처를 명시해 넘기는 쪽이 예측 가능합니다.

`pipelining`은 켜지 마세요. 한 커넥션에 요청을 연달아 밀어 넣는 방식인데, 앞 요청이 느리면 뒤가 전부 막히고 중간에 커넥션이 끊기면 어느 요청이 처리됐는지 알 수 없게 됩니다. 처리량은 HTTP/2 쪽으로 가는 게 맞습니다.

## 프로세스 밖의 한도 — 포트와 NAT

여기까지는 전부 프로세스 안의 설정이고, 그 밖에 두 개의 한도가 더 있습니다.

로컬 포트가 첫째입니다. 나가는 연결은 로컬 포트를 하나 잡고, 닫은 뒤에도 `TIME_WAIT` 동안 그 자리를 비켜주지 않습니다.

```bash
# 쓸 수 있는 로컬 포트 범위
cat /proc/sys/net/ipv4/ip_local_port_range
```

다행히 포트는 목적지와 묶여서 구별됩니다. 식별자는 (출발 IP, 출발 포트, 목적 IP, 목적 포트) 네 쌍이라, **같은 목적지로 짧은 연결을 많이 맺을 때만 고갈이 보입니다.** 그래서 외부 API 하나를 폭풍처럼 호출하는 서비스가 제일 먼저 밟습니다.

밟으면 `EADDRNOTAVAIL`이나 연결 실패로 나옵니다. 이때 범위를 넓히거나 `TIME_WAIT` 재사용 옵션을 건드리는 건 임시방편입니다. **근본 해결은 연결을 재사용해서 새 연결 자체를 줄이는 것입니다.**

둘째는 NAT입니다. 프라이빗 서브넷에서 NAT 게이트웨이를 거쳐 나간다면, 포트 한도가 우리 호스트가 아니라 그 게이트웨이에 걸립니다.

AWS NAT 게이트웨이는 포트를 할당하지 못한 횟수를 `ErrorPortAllocation` 지표로 내보냅니다. `ActiveConnectionCount`와 같이 보면 "연결이 몇 개까지 늘어났을 때 터지는지"가 보입니다. 구체적인 상한값은 공식 문서를 확인하세요.

알람을 걸어두면 좋은 지표입니다. 여기서 터지면 애플리케이션 로그에는 그냥 타임아웃으로 보여서, 지표 없이 원인을 찾기가 아주 어렵습니다.

{% comment %} TODO: 운영 환경에서 실제로 밟아본 한도가 있으면 수치와 증상을 적어주세요 {% endcomment %}

## 재사용이 가려버린 것 — DNS와 부하 분산

재사용은 공짜가 아닙니다. 대가는 **주소가 바뀌어도 모른다**는 점입니다.

Node.js는 이름 조회 결과를 TTL에 맞춰 캐시해두지 않습니다. 그래서 매 연결마다 조회하는데, keep-alive로 연결을 재사용하면 조회 자체가 줄어듭니다. 지연이 줄어드니 좋은 일입니다.

문제는 **로드밸런서 뒤의 상대**입니다. 로드밸런서의 주소는 고정이 아니고, 노드가 교체되면 이름이 가리키는 IP가 바뀝니다. 그런데 이미 맺어둔 TCP 연결은 이름이 아니라 IP에 붙어 있습니다.

그래서 커넥션을 무기한 쥐고 있으면 두 가지가 생깁니다.

- **분산이 안 됩니다.** 상대가 스케일 아웃을 해도 우리 트래픽은 처음 잡은 쪽으로만 계속 갑니다.
- **교체를 못 따라갑니다.** 빠진 노드를 계속 쓰다가 그 노드가 정리되는 순간 연결이 끊깁니다.

그래서 유휴 수명과 별개로 **커넥션 자체의 최대 수명**이 필요합니다. undici의 `keepAliveMaxTimeout`이 이 상한 역할을 하고, 코어 에이전트를 쓴다면 주기적으로 유휴 소켓을 정리하는 쪽으로 비슷하게 만들 수 있습니다.

```typescript
// 유휴 소켓만 끊는다. 진행 중인 요청의 소켓은 건드리지 않는다.
setInterval(() => {
  for (const sockets of Object.values(agent.freeSockets ?? {})) {
    for (const socket of [...sockets]) socket.destroy();
  }
}, 60_000);
```

반대 방향의 유혹도 있습니다. 조회가 느려서 DNS 캐시 라이브러리를 붙이는 경우인데, 이때 **TTL을 무시하고 길게 캐시하면 위의 두 번째 문제를 애플리케이션 계층에 한 번 더 만드는 것**입니다. 캐시를 쓰려면 TTL을 지키는 구현인지 확인하세요.

## HTTP/2로 가면 달라지는 것

HTTP/2는 커넥션 하나에서 여러 요청을 동시에 흘립니다. 그래서 위에서 본 문제의 상당 부분이 사라집니다.

소켓 수가 요청 동시성과 분리되니 포트 고갈이 사실상 없어지고, 핸드셰이크도 한 번으로 끝납니다. `maxSockets` 같은 상한의 의미도 달라집니다.

대신 새로 내주는 것이 있습니다.

- **커넥션 하나에 전부 올라탑니다.** 그 연결이 끊기면 진행 중인 모든 요청이 같이 영향을 받습니다.
- **TCP 레벨의 막힘은 남습니다.** 스트림은 나뉘지만 전송 계층은 하나라, 패킷 유실이 전체 스트림에 영향을 줍니다.
- **분산 쏠림이 더 심해집니다.** 커넥션이 하나뿐이니 앞 절의 문제가 그대로 커집니다. 커넥션 수명 상한이 더 중요해집니다.
- 상대 서버와 중간 경로가 전부 지원해야 합니다.

호출 상대가 우리가 통제하는 내부 서비스이고 호출량이 많다면 가장 깔끔한 선택입니다. 외부 업체 API라면 지원 여부부터 확인해야 하고, 지원하지 않을 때의 폴백이 결국 HTTP/1.1 keep-alive라서 위 설정이 그대로 필요합니다.

## 체크리스트

- [ ] 외부 호출에 쓰는 에이전트의 `keepAlive`·`timeout`·`maxSockets`를 **값으로 찍어** 확인했는가
- [ ] 라이브러리가 자기 에이전트를 만들어 쓰고 있지 않은가
- [ ] 클라이언트 유휴 소켓 수명이 상대/LB의 유휴 타임아웃보다 짧은가
- [ ] 재사용 소켓이 죽은 경우를 가려내 1회 재시도하는 경로가 있는가
- [ ] 멱등하지 않은 호출에 멱등키가 붙어 있는가
- [ ] 에이전트의 `free`·`active`·`queued`를 지표로 내보내고 있는가
- [ ] 큐 대기 시간이 타임아웃 예산 안에 들어 있는가
- [ ] 커넥션의 최대 수명 상한이 있는가 (LB 노드 교체·스케일 아웃 대응)
- [ ] NAT 게이트웨이를 거친다면 `ErrorPortAllocation`에 알람이 있는가

마지막으로 순서 하나. **재사용을 켜는 것보다 지표를 먼저 붙이는 쪽이 낫습니다.**

재사용은 평소 지연을 줄여주지만, 실패의 모양을 바꿉니다. 바뀐 모양을 볼 수 있는 상태에서 켜면 설정 몇 개 조정으로 끝나고, 안 보이는 상태에서 켜면 "간헐적 네트워크 오류"라는 이름의 영구 미제로 남습니다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- keep-alive를 켜거나 끄면서 실제로 달라진 지연·실패율
- 포트나 NAT 한도를 밟아본 사례와 대응

{% endcomment %}
