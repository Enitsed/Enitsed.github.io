---
layout: post
title: "락을 걸었는데 배치가 두 번 돌았다 — 분산 락이 보장하지 못하는 것"
date: 2026-09-18
tags: [backend, redis, mysql, architecture, typescript]
excerpt: "스케줄러를 두 대로 늘리면 배치가 두 번 돕니다. Redis 락의 최소 구현과 흔한 세 가지 결함, TTL과 작업 시간의 경쟁, 펜싱 토큰, DB 기반 락과의 비교, 그리고 락 대신 유일성 제약으로 푸는 쪽이 나은 경우까지."
---

스케줄러를 한 대에서 두 대로 늘린 다음부터, 정산 배치가 가끔 두 번 돕니다.
코드에는 분명 락이 있습니다. 로그를 열어보면 두 인스턴스가 **둘 다 락 획득에 성공했다고 찍혀 있습니다.**

락이 없어서 생긴 문제가 아닙니다. 락이 지켜주는 범위를 실제보다 넓게 믿어서 생긴 문제입니다.

## 프로세스 안의 락은 프로세스 경계에서 끝난다

인스턴스가 한 대일 때는 언어가 주는 뮤텍스나 세마포어로 충분합니다. 같은 메모리를 공유하니까요.

인스턴스를 두 대로 늘리는 순간 그 전제가 사라집니다. 각 프로세스는 자기 메모리 안에서 정직하게 락을 걸고, 서로의 존재를 모릅니다.
Node.js처럼 단일 스레드라 "동시성 문제는 없다"고 생각하던 코드가 가장 먼저 깨지는 지점이기도 합니다.

그래서 프로세스 밖에 락을 둡니다. 다만 그 전에 물어볼 게 있습니다.

> 이 작업은 **두 번 실행되면 결과가 틀리는** 작업인가, 아니면 **두 번 실행되면 낭비인** 작업인가?

이 구분이 이 글의 전부입니다. 널리 인용되는 표현으로는 정확성(correctness)을 위한 락과 효율(efficiency)을 위한 락입니다.

- **효율을 위한 락** — 같은 캐시를 두 인스턴스가 동시에 채우는 것 같은 경우. 가끔 겹쳐도 결과는 같고, 비용만 조금 더 씁니다.
- **정확성을 위한 락** — 정산 금액을 더하거나, 재고를 차감하거나, 외부에 송금하는 경우. 겹치면 결과가 틀립니다.

**뒤에 나오는 모든 락 구현은 첫 번째 용도에는 충분하고, 두 번째 용도에는 그것만으로 부족합니다.** 왜 부족한지가 본론입니다.

## 최소한의 Redis 락

가장 널리 쓰는 형태부터 봅니다.

```typescript
import Redis from "ioredis";
import { randomUUID } from "node:crypto";

const redis = new Redis(process.env.REDIS_URL!);

async function acquire(key: string, ttlMs: number): Promise<string | null> {
  const token = randomUUID();
  // NX: 키가 없을 때만 세팅, PX: 밀리초 TTL. 둘은 한 번에 가야 한다.
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  return ok === "OK" ? token : null;
}
```

세 가지가 한 줄에 다 들어가 있습니다. **없을 때만 쓰기**(NX), **만료 시간**(PX), 그리고 **소유자를 식별하는 토큰**입니다.
셋 중 하나라도 빠지면 아래 결함이 하나씩 생깁니다.

### 결함 1 — TTL이 없다

락을 잡은 프로세스가 죽으면 키가 영원히 남습니다. 그 뒤로 아무도 그 작업을 못 합니다.
배포 중에 한 번 이런 일이 생기면, 원인을 찾기 전까지는 사람이 Redis에 들어가 키를 지우는 게 유일한 복구 수단이 됩니다.

`SET` 다음 줄에서 `EXPIRE`를 부르는 것도 안 됩니다. 두 명령 사이에서 죽으면 똑같이 TTL 없는 키가 남습니다.
**만료는 획득과 같은 원자 연산 안에 있어야 합니다.**

### 결함 2 — 해제할 때 소유자를 확인하지 않는다

```typescript
// 이렇게 하면 안 된다
await redis.del(key);
```

내 락이 이미 TTL로 만료됐고 그 사이 다른 인스턴스가 같은 키를 잡았다면, 이 `DEL`은 **남의 락을 풀어버립니다.**
그리고 이건 로그에 아무 흔적도 남기지 않습니다.

그래서 토큰을 비교하고 지워야 하는데, `GET`으로 읽고 비교한 뒤 `DEL`을 부르면 그 사이에 또 만료될 수 있습니다.
비교와 삭제가 하나의 원자 연산이어야 합니다. Redis에서는 Lua로 묶습니다.

```typescript
const UNLOCK = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

async function release(key: string, token: string): Promise<boolean> {
  const n = (await redis.eval(UNLOCK, 1, key, token)) as number;
  return n === 1;
}
```

`release`가 `false`를 돌려주는 건 그냥 넘길 일이 아닙니다.
**내가 락을 잃은 채로 작업을 계속하고 있었다는 뜻**이라, 최소한 경고 로그는 남겨야 합니다.

### 결함 3 — 재시도를 안 하거나, 너무 열심히 한다

락을 못 잡았을 때의 기본값은 **그냥 포기하는 것**이어야 합니다. 배치라면 다음 주기에 다시 오면 됩니다.

기다려야 하는 경우라도 즉시 재시도를 반복하면 인스턴스 수만큼 Redis를 때립니다. 지수 백오프에 지터를 섞고 상한을 둡니다.

```typescript
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: (token: string) => Promise<T>,
  opts: { retries?: number } = {},
): Promise<T | null> {
  const retries = opts.retries ?? 0;

  for (let i = 0; i <= retries; i++) {
    const token = await acquire(key, ttlMs);
    if (token) {
      try {
        return await fn(token);
      } finally {
        await release(key, token);   // 실패해도 예외로 덮지 않는다
      }
    }
    if (i < retries) {
      const backoff = Math.min(2 ** i * 100, 2_000);
      await new Promise((r) => setTimeout(r, backoff + Math.random() * 100));
    }
  }
  return null;   // 못 잡았다. 예외가 아니라 정상적인 결과다.
}
```

여기까지가 "제대로 만든 Redis 락"입니다. 그리고 여기서 멈추면 처음의 그 로그가 설명되지 않습니다.

## TTL은 어떤 값을 넣어도 틀린다

TTL을 정하려고 보면 양쪽이 다 나쁩니다.

| TTL | 문제 |
| --- | --- |
| 작업 시간보다 짧게 | 작업이 끝나기 전에 락이 풀린다. 다른 인스턴스가 들어와 **동시에 실행**된다 |
| 작업 시간보다 길게 | 프로세스가 죽었을 때 그 시간만큼 아무도 작업을 못 한다 |

"작업이 보통 30초 걸리니 TTL은 2분" 같은 식으로 여유를 주게 되는데, 이 여유가 얼마여야 충분한지는 알 수 없습니다.
작업이 느려지는 이유가 우리 코드 밖에 있기 때문입니다. DB가 느려지거나, 외부 API가 지연되거나, 컨테이너가 CPU 스로틀링에 걸리면 30초짜리가 5분이 됩니다.

그래서 **갱신(워치독)**을 붙입니다. 작업이 도는 동안 주기적으로 TTL을 늘리는 것입니다.

```typescript
const EXTEND = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

function startWatchdog(key: string, token: string, ttlMs: number) {
  const timer = setInterval(async () => {
    const ok = (await redis.eval(EXTEND, 1, key, token, ttlMs)) as number;
    if (ok !== 1) {
      // 갱신 실패 = 락을 이미 잃었다. 작업을 중단시켜야 한다.
      console.error(JSON.stringify({ msg: "lock:lost", key }));
    }
  }, Math.floor(ttlMs / 3));   // TTL의 1/3 주기 — 한두 번 놓쳐도 버틴다

  timer.unref();
  return () => clearInterval(timer);
}
```

갱신은 TTL 문제를 **줄이지만 없애지 못합니다.** 갱신 타이머도 결국 우리 프로세스 안에서 도는 코드라서,
프로세스가 멈추면 갱신도 같이 멈추기 때문입니다. 락이 만료된 뒤 프로세스가 다시 깨어나면, 자기가 락을 잃은 줄 모르고 작업을 이어갑니다.

## 그래서 두 인스턴스가 동시에 "락을 갖고 있다"

락 만료와 작업 지속이 어긋나는 경로는 하나가 아닙니다.

- **GC 일시 정지**나 컨테이너 CPU 스로틀링 — 프로세스가 수 초간 아무것도 못 합니다.
- **네트워크 지연** — 락 획득 응답이 늦게 도착합니다. 받았을 때 이미 TTL의 상당 부분이 지나 있습니다.
- **Redis 페일오버** — 복제가 비동기라, 프라이머리가 넘어갈 때 아직 복제되지 않은 락 키가 사라질 수 있습니다. 새 프라이머리는 그 키를 모르니 다음 요청에 락을 내줍니다.

시간 순서로 보면 이렇게 됩니다.

```text
A: 락 획득 ──── 작업 시작 ──[ 멈춤 ]────────── 작업 재개 → 쓰기!
                              락 TTL 만료 ─┐
B:                                         └─ 락 획득 → 작업 → 쓰기!
```

A는 자기가 락을 잃은 시점을 알 방법이 없습니다. 멈춰 있었으니까요.
**분산 락으로 상호 배제를 100% 보장하려는 시도는 여기서 막힙니다.** 여러 Redis 노드에 락을 거는 알고리즘(Redlock)도 이 시나리오를 두고 오랜 논쟁이 있었고, 시계와 일시 정지를 어디까지 가정할지에 대한 이견이 핵심이었습니다.

논쟁의 결론을 실무로 옮기면 한 줄입니다.

> 락은 겹침을 **드물게** 만들어줄 뿐, **없앤다고 가정하면 안 됩니다.**

## 펜싱 토큰 — 리소스가 거부하게 만든다

겹침을 완전히 막을 수 없다면, 겹쳤을 때 **뒤늦게 깨어난 쪽의 쓰기를 리소스가 거부**하게 만들면 됩니다.

락을 줄 때 단조 증가하는 번호를 같이 발급하고, 쓰기에 그 번호를 실어 보냅니다.
리소스는 지금까지 본 것보다 작거나 같은 번호의 요청을 버립니다.

```typescript
async function acquireWithFence(key: string, ttlMs: number) {
  const token = randomUUID();
  const ok = await redis.set(key, token, "PX", ttlMs, "NX");
  if (ok !== "OK") return null;

  // 락을 잡은 쪽만 번호를 올린다. 이 값은 절대 줄지 않는다.
  const fence = await redis.incr(`${key}:fence`);
  return { token, fence };
}
```

쓰기 쪽은 조건부 갱신이 됩니다.

```sql
-- 마지막으로 본 번호보다 큰 요청만 통과시킨다
UPDATE settlement_state
   SET last_fence  = :fence,
       settled_at  = NOW(3)
 WHERE job_name    = :job
   AND last_fence  < :fence;
```

영향받은 행이 0이면 **내가 낡은 락 소유자**라는 뜻이니 즉시 중단합니다.

```typescript
const [res] = await conn.execute(SQL_UPDATE, { fence, job });
if (res.affectedRows === 0) {
  throw new Error("stale lock holder: aborting");
}
```

이 방식의 제약도 분명합니다.

- **리소스가 조건부 쓰기를 지원해야 합니다.** DB는 위처럼 되고, S3처럼 조건부 쓰기 수단이 있는 저장소도 됩니다. 반면 "이메일 발송" 같은 외부 호출에는 끼워 넣을 자리가 없습니다.
- `INCR` 카운터 자체도 Redis에 있으므로, 페일오버로 되감기면 번호가 겹칠 수 있습니다. 번호가 정말 중요하면 DB의 시퀀스나 오토 인크리먼트에서 받는 편이 안전합니다.
- 리소스가 여러 개면 각각에 대해 같은 장치가 필요합니다.

정리하면 펜싱 토큰은 **리소스가 하나이고 그게 DB일 때** 가장 잘 들어맞습니다. 그리고 그 조건이라면, 애초에 락을 DB에 거는 선택지가 있습니다.

## DB로 거는 락

이미 쓰고 있는 DB가 있는데 락 때문에 Redis를 새로 들이는 건 비용이 큰 선택입니다. DB에는 이미 락 수단이 셋 있습니다.

**네임드 락**은 임의의 문자열에 거는 락입니다. MySQL이라면 이렇습니다.

```sql
-- 두 번째 인자는 대기 시간(초). 0이면 못 잡았을 때 즉시 0을 돌려준다.
SELECT GET_LOCK('settlement:2026-09-18', 0);
-- ... 작업 ...
SELECT RELEASE_LOCK('settlement:2026-09-18');
```

PostgreSQL에는 어드바이저리 락이 있습니다.

```sql
-- 세션 수준: 명시적으로 풀거나 세션이 끊길 때까지 유지
SELECT pg_try_advisory_lock(:key);

-- 트랜잭션 수준: 커밋/롤백 시 자동 해제 — 해제를 잊을 수 없다
SELECT pg_advisory_xact_lock(:key);
```

키가 정수라서 문자열 작업 이름을 해시해 넘겨야 합니다. 내부 해시 함수에 기대기보다 애플리케이션에서 해시를 계산해 넘기는 편이 예측 가능합니다.

두 방식 모두 **커넥션이 끊기면 락이 자동으로 풀린다**는 성질을 공유합니다. 이게 TTL보다 나은 점입니다.
프로세스가 죽으면 TCP 연결이 끊기고 서버가 그걸 감지해 락을 회수하므로, "얼마나 기다릴지"를 우리가 정하지 않아도 됩니다.

> 다만 **커넥션 풀과 상성이 나쁩니다.** 락은 세션에 묶이는데 풀은 커넥션을 돌려쓰기 때문에,
> 락을 잡은 커넥션과 작업을 수행하는 커넥션이 달라지면 락이 아무 의미가 없습니다.
> 풀에서 커넥션 하나를 빌려 **작업이 끝날 때까지 붙들고** 그 위에서 쿼리를 돌려야 합니다.
> 네임드 락의 이름 길이 제한과 한 세션이 동시에 쥘 수 있는 락 개수는 엔진과 버전에 따라 다르니 현행 공식 문서에서 확인하세요.

세 번째는 **행 락**입니다. 작업 하나당 한 행을 두고 `SELECT ... FOR UPDATE`로 잡습니다.

```sql
BEGIN;
SELECT * FROM job_lock WHERE job_name = 'settlement' FOR UPDATE NOWAIT;
-- ... 같은 트랜잭션 안에서 작업 ...
COMMIT;
```

`NOWAIT`을 붙이면 잡혀 있을 때 대기 없이 오류로 돌아옵니다. 여러 건을 나눠 처리한다면 `SKIP LOCKED`로 잠긴 행을 건너뛰는 쪽이 자연스럽습니다.

대신 **락 유지 기간이 트랜잭션 길이와 같아집니다.** 외부 API 호출을 포함하는 긴 작업을 트랜잭션 안에 넣으면 그동안 커넥션과 언두 로그를 붙들고 있게 되므로, 이 방식은 짧은 작업에만 씁니다.

| 방식 | 해제 | 강점 | 약점 |
| --- | --- | --- | --- |
| Redis SET NX PX | TTL 만료 | 빠르고 DB 부하 없음 | TTL 추정, 페일오버 시 유실 |
| 네임드 락 / 어드바이저리 락 | 커넥션 종료 | TTL 불필요, 인프라 추가 없음 | 커넥션을 점유, 풀 사용 시 주의 |
| 행 락 (FOR UPDATE) | 트랜잭션 종료 | 데이터와 같은 트랜잭션에 묶임 | 긴 작업에 부적합 |

## 락을 빼고 푸는 쪽이 더 나은 경우

처음의 정산 배치로 돌아가 봅니다. 여기서 정말 필요한 건 "동시에 한 명만 들어온다"가 아니라 **"이 날짜의 정산은 한 번만 일어난다"**입니다.

그렇다면 유일성 제약으로 직접 표현할 수 있습니다.

```sql
CREATE TABLE job_run (
  job_name    VARCHAR(100) NOT NULL,
  run_key     VARCHAR(64)  NOT NULL,   -- 예: '2026-09-18'
  status      VARCHAR(20)  NOT NULL,   -- running | done | failed
  started_at  DATETIME(3)  NOT NULL,
  finished_at DATETIME(3)  NULL,
  PRIMARY KEY (job_name, run_key)
);
```

시작할 때 행을 넣어보고, 중복 키 오류가 나면 이미 누군가 했거나 하고 있다는 뜻입니다.

```typescript
try {
  await conn.execute(
    `INSERT INTO job_run (job_name, run_key, status, started_at)
     VALUES (?, ?, 'running', NOW(3))`,
    [job, runKey],
  );
} catch (e: any) {
  if (e.code === "ER_DUP_ENTRY") return;   // 이번 주기는 우리 차례가 아니다
  throw e;
}
```

락과 달리 이건 **시간에 의존하지 않습니다.** TTL도, 갱신 주기도, 시계도 없습니다.
제약은 DB 안에 있고, 두 인스턴스가 동시에 `INSERT`해도 한쪽만 통과한다는 건 엔진이 보장합니다.

대신 **실패한 실행을 어떻게 다시 돌릴지**를 설계해야 합니다. `running`인 채로 프로세스가 죽으면 그 행이 남아 다음 시도를 막기 때문입니다.
`started_at`이 충분히 오래된 `running` 행만 회수하도록 조건부 갱신을 두는 식이 되는데, "충분히 오래"를 정해야 하니 TTL 문제가 형태를 바꿔 돌아오는 셈입니다.
차이는, 이 판단이 **묵시적인 만료가 아니라 눈에 보이는 한 줄의 조건**이라는 점입니다.

작업 자체를 멱등하게 만들 수 있다면 더 낫습니다. 두 번 실행돼도 결과가 같다면 락은 정확성 장치가 아니라 낭비를 줄이는 최적화로 내려오고,
그때는 앞의 단순한 Redis 락으로 충분합니다. 멱등하게 만드는 방법은 [결제 API에 멱등키 붙이기](/blog/idempotency-key-payment-api/)에 적어둔 것과 같은 결입니다.

## 고를 때 보는 순서

```text
두 번 실행되면 결과가 틀리는가?
├─ 아니오 → Redis SET NX PX 로 충분하다. TTL은 넉넉히, 갱신은 선택.
└─ 예
   ├─ 작업 단위를 유일 키로 표현할 수 있는가?
   │   └─ 예 → UNIQUE 제약으로 막는다. 락보다 먼저 검토할 선택지.
   ├─ 쓰기 대상이 DB 하나인가?
   │   └─ 예 → 펜싱 토큰, 또는 어드바이저리 락 + 같은 커넥션 유지.
   └─ 외부 호출이 섞여 있는가?
       └─ 예 → 락만으로는 못 막는다. 외부 API의 멱등키를 쓴다.
```

마지막 갈래가 제일 중요합니다. 외부로 나가는 호출은 우리 락 안에 없습니다.
그쪽에 멱등키 같은 수단이 없다면, 어떤 락을 써도 중복 호출 가능성은 남습니다.

## 정리

- 프로세스 밖의 락은 **상호 배제를 보장하지 않습니다.** TTL 만료와 프로세스 정지가 겹치는 경로가 항상 남습니다.
- 그래도 제대로 만든 락은 겹침을 드물게 만들어줍니다. **NX + TTL + 소유자 토큰 + 원자적 해제** 네 가지는 빠뜨리지 않습니다.
- 갱신은 완화책이지 해결책이 아닙니다. 갱신 실패는 로그가 아니라 **작업 중단 신호**로 다뤄야 합니다.
- 정확성이 걸린 곳에서는 리소스 쪽에 방어선을 둡니다. 펜싱 토큰이나 유일성 제약처럼, **시간에 기대지 않는 장치**여야 합니다.
- 락을 고르기 전에 "이 작업을 멱등하게 만들 수 있는가"를 먼저 물어보는 편이 대체로 빨리 끝납니다.

{% comment %} TODO: 실제 운영에서 분산 락을 어디에 썼는지(대상 작업, Redis/DB 중 무엇), 중복 실행이 실제로 발생했다면 그 원인과 대응을 적어주세요 {% endcomment %}
