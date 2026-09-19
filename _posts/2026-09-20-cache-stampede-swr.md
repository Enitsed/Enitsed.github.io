---
layout: post
title: "히트율은 99%인데 DB가 주기적으로 튄다 — 캐시 스탬피드"
date: 2026-09-20
tags: [backend, redis, cache, architecture, typescript]
excerpt: "캐시를 붙였는데 원본 부하가 주기적으로 치솟습니다. 미스가 한 지점에 몰리는 구조를 뜯어보고 singleflight, 재계산 락, 논리적 TTL(stale-while-revalidate), TTL 지터, 음수 캐싱을 언제 무엇으로 고를지 정리합니다."
---

캐시를 붙였고 히트율은 99%를 넘습니다. 평균 응답 시간도 내려갔습니다.
그런데 DB CPU 그래프에 몇 분 간격으로 뾰족한 봉우리가 반복해서 찍힙니다.

평균은 좋아졌는데 최악은 그대로이거나 오히려 나빠진 상태입니다. 남은 1%가 고르게 흩어져 있지 않기 때문입니다.

## 히트율이 말해주지 않는 것

히트율은 전체에 대한 비율이고, **미스가 언제 몰려서 오는지는 말해주지 않습니다.**

캐시 미스는 대부분 TTL 만료에서 나옵니다. 그리고 하나의 키는 정확히 한 시점에 만료됩니다.
그 순간 그 키를 보던 모든 요청이 동시에 "없다"는 답을 받고, **전부 원본으로 갑니다.**

몇 건이나 갈지는 대략 곱셈으로 나옵니다.

> 동시에 원본으로 가는 요청 수 ≈ 해당 키의 초당 요청 수 × 원본 재계산에 걸리는 시간

초당 500건이 들어오는 키의 재계산이 200ms 걸린다면, 만료 직후 첫 응답이 캐시에 들어갈 때까지 약 100건이 같은 쿼리를 동시에 돌립니다.
DB 입장에서는 동일한 무거운 쿼리 100개가 한꺼번에 들어온 것이고, 그러면 재계산 시간 자체가 200ms보다 길어집니다. 길어지면 그 사이에 들어오는 요청이 더 늘어납니다.

이게 캐시 스탬피드(cache stampede)입니다. **부하가 스스로를 키우는 모양**이라 임계를 넘으면 회복이 느립니다.

그리고 인기 있는 키일수록 심합니다. 캐시를 붙여서 가장 크게 이득을 본 키가, 만료 순간에는 가장 위험한 키입니다.

## 순진한 구현이 만드는 모양

교과서적인 cache-aside 구현부터 봅니다.

```typescript
import Redis from "ioredis";

const redis = new Redis(process.env.REDIS_URL!);

async function getRanking(key: string): Promise<Ranking> {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  // ── 만료 직후, 이 구간에 도착한 요청이 전부 여기로 들어온다 ──
  const fresh = await computeRanking();          // 무거운 집계 쿼리
  await redis.set(key, JSON.stringify(fresh), "PX", 60_000);
  return fresh;
}
```

코드에 버그는 없습니다. 각 요청은 정직하게 미스를 확인하고 정직하게 원본을 조회합니다.
**문제는 이 함수가 "지금 다른 누군가도 같은 걸 계산하고 있다"는 사실을 알 방법이 없다는 것**입니다.

해결 방향은 결국 셋 중 하나입니다.

- 중복 계산을 **합친다** — 여러 요청이 하나의 계산을 공유한다
- 계산 주체를 **한 명으로 줄인다** — 나머지는 기다리거나 낡은 값을 받는다
- 애초에 **만료 순간을 만들지 않는다** — 만료 전에 미리 갱신한다

아래는 이 셋을 구현 난이도 순으로 본 것입니다.

## 같은 프로세스 안에서 합치기

가장 싸게 얻을 수 있는 개선입니다. 진행 중인 계산의 Promise를 키별로 들고 있다가, 같은 키 요청이 오면 그 Promise를 그대로 돌려줍니다.

```typescript
const inflight = new Map<string, Promise<Ranking>>();

function singleflight(key: string, fn: () => Promise<Ranking>): Promise<Ranking> {
  const running = inflight.get(key);
  if (running) return running;                   // 이미 누가 계산 중이면 얹혀 간다

  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function getRanking(key: string): Promise<Ranking> {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  return singleflight(key, async () => {
    const fresh = await computeRanking();
    await redis.set(key, JSON.stringify(fresh), "PX", 60_000);
    return fresh;
  });
}
```

`finally`로 지우는 게 중요합니다. 계산이 실패했을 때 Map에 실패한 Promise가 남아 있으면, 그 뒤 요청이 전부 같은 실패를 돌려받습니다.

효과는 명확합니다. **한 프로세스에서 나가는 동시 쿼리가 1개로 줄어듭니다.**
동시에 한계도 명확합니다. 프로세스가 10대면 원본으로 10개가 갑니다. 100개가 10개가 된 것이니 충분한 경우도 많고, 그렇지 않은 경우도 있습니다.

> 인스턴스 수가 적고 원본이 그 정도는 견딘다면 여기서 멈춰도 됩니다. 의존성이 하나도 늘지 않는 유일한 선택지입니다.

## 프로세스 밖에서 합치기 — 재계산 락

전체에서 한 번만 계산하려면 프로세스 밖에 조정자가 필요합니다. Redis 락이 흔히 쓰이는 이유입니다.

```typescript
import { randomUUID } from "node:crypto";

async function recomputeWithLock(key: string): Promise<Ranking | null> {
  const lockKey = `lock:${key}`;
  const token = randomUUID();

  const got = await redis.set(lockKey, token, "PX", 10_000, "NX");
  if (got !== "OK") return null;                 // 다른 쪽이 계산 중이다

  try {
    const fresh = await computeRanking();
    await redis.set(key, JSON.stringify(fresh), "PX", 60_000);
    return fresh;
  } finally {
    // 내 토큰일 때만 지운다. 만료된 뒤 남의 락을 지우지 않기 위해서다.
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1, lockKey, token,
    );
  }
}
```

여기서 진짜 설계 결정은 락을 잡는 쪽이 아니라 **못 잡은 쪽을 어떻게 할 것인가**입니다.

- **기다렸다 다시 조회한다** — 짧게 sleep하고 캐시를 다시 읽습니다. 값은 항상 신선하지만, 재계산 시간만큼 응답이 늦습니다. 재계산이 느리면 이 대기가 그대로 커넥션 점유가 되고, 원본 부하를 옮겨놓은 꼴이 되기도 합니다.
- **낡은 값을 돌려준다** — 만료된 값이 아직 남아 있다면 그걸 줍니다. 응답은 빠르고 원본은 조용합니다. 대신 일부 사용자가 잠시 옛 데이터를 봅니다.
- **그냥 실패시킨다** — 정합성이 중요하고 빈 응답이 허용되는 경우에만 고를 수 있습니다.

두 번째가 대체로 실용적인데, 그러려면 **만료된 값이 아직 Redis에 남아 있어야** 합니다. TTL로 지워버렸다면 돌려줄 낡은 값 자체가 없습니다.

그래서 다음 절의 발상이 나옵니다.

> 락으로 상호 배제를 얻는 것은 여기까지입니다. 락이 실제로 보장하는 범위는 [분산 락이 보장하지 못하는 것](/blog/distributed-lock-fencing/)에 적어둔 것과 같고, **캐시 갱신은 두 번 돌아도 결과가 같은 쪽**이라 그 한계가 문제가 되지 않는 대표적인 용도입니다.

## 만료를 논리적으로 다루기

Redis의 TTL과 애플리케이션이 생각하는 "신선함"을 분리합니다.
값 안에 만료 시각을 넣어두고, 실제 키 TTL은 그보다 훨씬 길게 잡습니다.

```typescript
type Entry<T> = { v: T; exp: number };           // exp = 논리적 만료 시각 (epoch ms)

const FRESH_MS = 60_000;                          // 이 시간이 지나면 갱신 대상
const GRACE_MS = 600_000;                         // 그 뒤로도 이만큼은 물리적으로 보관

async function getRanking(key: string): Promise<Ranking> {
  const raw = await redis.get(key);

  if (!raw) {
    // 줄 수 있는 낡은 값조차 없는 경우. 여기서만 기다린다.
    return (await recomputeWithLock(key)) ?? waitAndRead(key);
  }

  const entry: Entry<Ranking> = JSON.parse(raw);
  if (Date.now() < entry.exp) return entry.v;     // 신선하다

  // 만료됐지만 값은 있다 — 일단 돌려주고, 갱신은 뒤에서 한 명만 한다
  void recomputeWithLock(key).catch((e) => logger.warn({ e, key }, "cache refresh failed"));
  return entry.v;
}
```

`recomputeWithLock`은 값을 저장할 때 `exp`를 함께 넣고, TTL은 `FRESH_MS + GRACE_MS`로 잡습니다.

이 구조의 성질이 앞의 둘과 다릅니다.

- **사용자를 기다리게 하는 경로가 사라집니다.** 첫 적재 시점을 빼면 모든 요청이 캐시에서 즉시 응답을 받습니다.
- **원본에 가는 요청은 갱신 한 건뿐입니다.** 락이 나머지를 막습니다.
- 대신 **`FRESH_MS`가 지난 뒤 갱신이 끝날 때까지, 일부 사용자는 낡은 값을 봅니다.**

마지막 줄이 이 방식의 값입니다. 공짜가 아니라, 지연과 원본 부하를 **낡음(staleness)으로 바꾼 것**입니다.
랭킹, 추천, 통계 위젯처럼 몇 초 낡아도 무방한 데이터에는 거의 항상 이득입니다. 잔액이나 재고 수량처럼 낡은 값이 곧 오답인 데이터에는 쓰면 안 됩니다.

`void`로 갱신을 띄우는 부분은 주의가 필요합니다. 요청 단위로 살아 있는 런타임에서는 응답 후 프로세스가 곧바로 정리되어 갱신이 잘릴 수 있습니다.
서버리스처럼 실행이 응답과 함께 끝나는 환경이라면 백그라운드 갱신 대신 **별도 갱신 워커**를 두는 편이 확실합니다.

## TTL을 흩어놓기

한 키가 만료될 때 몰리는 문제를 풀었다면, 다음은 **여러 키가 같은 순간에 만료되는** 문제입니다.

같은 시점에 한꺼번에 적재된 키들은 같은 시점에 한꺼번에 만료됩니다. 배포 직후 캐시를 미리 채우거나, 대량 무효화 뒤 다시 채우거나, 정각에 도는 배치가 캐시를 갱신하는 경우가 전부 여기 해당합니다.
개별 키의 스탬피드는 막아뒀어도, 서로 다른 키 수천 개가 동시에 갱신에 들어가면 원본이 받는 총량은 똑같이 튑니다.

TTL에 난수를 섞어 만료 시점을 흩는 것으로 대부분 완화됩니다.

```typescript
function jitter(baseMs: number, ratio = 0.1): number {
  const delta = baseMs * ratio;
  return Math.round(baseMs - delta + Math.random() * delta * 2);   // ±10%
}

await redis.set(key, payload, "PX", jitter(FRESH_MS + GRACE_MS));
```

비율은 트래픽 모양에 따라 정합니다. 만료 시점이 고르게 퍼질 만큼은 넓어야 하고, 데이터가 허용하는 낡음의 상한을 넘지 않을 만큼은 좁아야 합니다.

## 없는 것도 캐싱한다

지금까지는 캐시에 값이 있다가 사라지는 경우였습니다. **처음부터 원본에도 없는 키**는 다른 문제를 만듭니다.

존재하지 않는 ID로 들어온 조회는 캐시 미스 → 원본 조회 → 결과 없음 → **캐시에 저장할 것이 없음**으로 끝납니다.
같은 요청이 또 오면 똑같이 원본까지 갑니다. 캐시가 전혀 작동하지 않는 경로가 생기는 것이고, 무작위 ID를 긁는 트래픽이 들어오면 캐시를 그대로 통과해 원본만 때립니다.

없다는 사실 자체를 짧게 캐싱합니다.

```typescript
const NOT_FOUND = "\u0000nf";                     // 일반 값과 겹치지 않는 표식

async function getUser(id: string): Promise<User | null> {
  const key = `user:${id}`;
  const raw = await redis.get(key);
  if (raw === NOT_FOUND) return null;
  if (raw) return JSON.parse(raw);

  const user = await db.findUser(id);
  if (!user) {
    await redis.set(key, NOT_FOUND, "PX", jitter(30_000));   // 짧게
    return null;
  }
  await redis.set(key, JSON.stringify(user), "PX", jitter(300_000));
  return user;
}
```

음수 캐싱의 TTL은 **짧게** 잡습니다. 없던 리소스가 생기는 건 흔한 일이고, TTL이 길면 방금 만든 데이터가 한참 안 보입니다.
리소스를 생성하는 경로에서 해당 키를 지워주면 이 창을 없앨 수 있는데, 생성 경로가 여러 곳이면 한 곳은 빠지기 마련이라 **짧은 TTL을 최종 방어선으로 남겨두는 편**이 안전합니다.

## 쓰기가 일어날 때

원본이 바뀌면 캐시를 어떻게 할 것인가. 선택지는 갱신(update)과 무효화(invalidate) 둘입니다.

대체로 **지우는 쪽**이 낫습니다. 쓰기 직후에 새 값을 계산해 넣으면, 그 값을 아무도 읽지 않을 때 계산이 통째로 낭비되고 무엇보다 동시 쓰기에서 순서가 뒤집히기 쉽습니다.
지워두면 다음 읽기가 최신 값을 채웁니다.

그런데 cache-aside에는 지워도 남는 경로가 있습니다.

```text
읽기 A: 캐시 미스 → DB 조회 (값 = v1) → ... 여기서 멈춤
쓰기 B:                          DB 갱신 (v2) → 캐시 삭제
읽기 A:                                              → 캐시에 v1 저장  ← 낡은 값이 박힌다
```

읽기가 DB에서 값을 읽은 뒤 캐시에 쓰기 전까지 멈춰 있고, 그 사이에 쓰기가 전부 끝나버린 경우입니다.
확률은 낮지만 구조적으로 막히지 않고, 한 번 박히면 **다음 만료까지 계속 낡은 값**입니다.

완전히 막으려면 캐시와 DB를 한 트랜잭션에 묶어야 하는데, 서로 다른 시스템이라 그럴 수 없습니다.
[트랜잭셔널 아웃박스](/blog/transactional-outbox-pattern/)에서 DB 쓰기와 메시지 발행이 묶이지 않던 것과 같은 형태의 문제입니다.

현실적인 대응은 두 가지입니다.

- **쓰기 후 잠시 뒤 한 번 더 지운다.** 위 경로에서 늦게 박힌 값을 걷어냅니다. "잠시"를 얼마로 할지가 추정이라 완벽하지는 않지만, 창을 크게 좁힙니다.
- **TTL을 최종 방어선으로 둔다.** 무효화를 아무리 잘 걸어도 빠뜨리는 경로는 생기므로, 만료 없는 캐시는 두지 않습니다.

무효화 대신 **키에 버전을 넣는 방법**도 있습니다. `user:42:v7`처럼 쓰고 갱신할 때 버전을 올리면, 옛 키는 아무도 읽지 않는 채로 TTL에 따라 사라집니다.
지우는 작업이 사라지니 위 경쟁 자체가 없어지는 대신, 버전 값을 어딘가에서 읽어야 하므로 조회가 한 단계 늘어납니다.

## 무엇을 봐야 아는가

앞의 증상이 지표로 잡히려면 히트율만으로는 부족합니다.

| 지표 | 왜 보는가 |
| --- | --- |
| 캐시에서 오지 않은 요청의 **원본 QPS** | 스탬피드는 여기서 스파이크로 보입니다. 히트율은 거의 안 움직입니다 |
| 미스의 **시간 분포** | 고르게 퍼져 있는지, 특정 순간에 몰리는지. 몰린다면 TTL 동기화입니다 |
| 재계산 **소요 시간의 상위 백분위** | 곱셈의 한쪽 항입니다. 이게 늘면 동시 진입도 같이 늘어납니다 |
| 갱신 락 **획득 실패 수** | 합치기가 실제로 동작하는지 보여줍니다. 0이면 경쟁이 없거나 락이 안 걸리고 있는 것입니다 |
| 낡은 값으로 응답한 비율 | SWR을 쓴다면 이게 곧 품질 지표입니다. 계속 높다면 `FRESH_MS`가 너무 짧습니다 |

응답 시간도 평균이 아니라 p99로 봐야 이 문제가 보입니다. 캐시는 평균을 끌어내리면서 꼬리를 길게 만드는 쪽이라, 평균만 보면 개선으로만 읽힙니다.

## 고를 때 보는 순서

```text
낡은 값을 잠깐 보여줘도 되는가?
├─ 예 → 논리적 TTL + 갱신 락 (SWR). 지연 관점에서 가장 낫다.
└─ 아니오
   ├─ 인스턴스가 적고 원본이 그만큼은 견디는가?
   │   └─ 예 → 프로세스 내 singleflight. 의존성이 늘지 않는다.
   └─ 아니오 → 재계산 락 + 짧은 대기 후 재조회. 대기 시간이 원본 부하를 대신 받는다.

공통으로 함께 둘 것
├─ TTL 지터 — 여러 키가 같이 만료되는 것을 막는다
├─ 음수 캐싱 — 없는 키가 캐시를 통과하는 것을 막는다
└─ 만료 없는 캐시를 두지 않는다 — 무효화는 언젠가 빠진다
```

## 정리

- 히트율은 미스가 **언제 몰리는지**를 말해주지 않습니다. 원본 QPS를 따로 봐야 스탬피드가 보입니다.
- 동시에 원본으로 가는 요청 수는 대략 `키의 QPS × 재계산 시간`입니다. 둘 중 하나를 줄이거나, 중복을 합쳐야 합니다.
- `singleflight`는 가장 싸고, 효과는 인스턴스 수만큼만 남습니다. 그래도 먼저 넣을 값은 합니다.
- 논리적 TTL과 백그라운드 갱신은 지연과 원본 부하를 **낡음으로 바꿉니다.** 그 교환이 허용되는 데이터인지가 유일한 판단 기준입니다.
- TTL 지터와 음수 캐싱은 어떤 전략을 고르든 같이 들어갑니다. 둘 다 몇 줄이고, 없으면 다른 모양으로 같은 문제가 돌아옵니다.
- 캐시 무효화는 언제나 새는 곳이 생깁니다. **만료 없는 캐시를 두지 않는 것**이 마지막 방어선입니다.

{% comment %} TODO: 실제 서비스에서 캐시 스탬피드를 겪었다면 어떤 키였는지, 어떤 전략으로 대응했고 원본 부하가 어떻게 달라졌는지 적어주세요 {% endcomment %}
