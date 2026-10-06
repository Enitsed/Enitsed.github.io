---
layout: post
title: "캐시가 아닌 키까지 사라진다 — Redis 메모리 상한과 축출 정책"
date: 2026-10-07
tags: [backend, redis, devops, architecture, typescript]
excerpt: "Redis 하나에 캐시와 락과 멱등키를 같이 넣으면, 메모리 상한에 닿는 순간 축출 정책이 그 셋을 구분해주지 않습니다. noeviction이 쓰기를 거부하는 지점과 allkeys-lru가 락을 지우는 지점, volatile-*가 noeviction으로 되돌아가는 조건, TTL이 조용히 사라지는 경로, 큰 키 하나가 단일 스레드를 막는 구조, 그리고 evicted_keys를 인스턴스 성격에 따라 다르게 읽어야 하는 이유까지."
---

분산 락이 간헐적으로 풀리고, 멱등키가 없어져서 같은 요청이 두 번 처리됩니다. 로그인 세션도 가끔 끊깁니다.
배포는 없었고 애플리케이션 예외도 없습니다.

Redis가 메모리 상한에 닿았을 뿐입니다. 그리고 축출 정책은 **"이건 지워도 되는 캐시고 저건 지우면 안 되는 락"을 구분하지 않습니다.**

## 상한에 닿으면 무엇이 일어나는가

`maxmemory`가 0이면 상한이 없습니다. 좋아 보이지만, 그때 한도를 정하는 건 OS입니다.
스왑이 시작되면 Redis의 모든 응답이 느려지고, 그러다 OOM killer가 프로세스를 죽입니다. **상한을 안 거는 쪽이 더 나쁩니다.**

상한을 걸면 그 지점부터는 `maxmemory-policy`가 동작을 결정합니다. 기본값은 `noeviction`이고, 이 경우 Redis는 아무 키도 버리지 않고 쓰기를 거부합니다.

```text
(error) OOM command not allowed when used memory > 'maxmemory'.
```

여기서 중요한 건 **거부되는 명령이 전부가 아니라는 점**입니다. 메모리를 늘릴 수 있는 명령만 막히고 `GET`, `EXISTS`, `TTL` 같은 읽기는 그대로 성공합니다.

그래서 증상이 이상하게 잡힙니다. 헬스체크는 통과하고, 캐시 적중률 지표도 정상으로 보이고, 조회 API도 멀쩡합니다.
**쓰기 경로만 조용히 실패합니다.** 캐시 저장 실패를 로그만 찍고 넘기는 코드였다면 지표에서도 안 보입니다.

상한 값을 정할 때 두 가지를 같이 봅니다.

하나는 `used_memory`에 데이터만 들어가는 게 아니라는 점입니다. 복제 백로그와 클라이언트 출력 버퍼 같은 것들이 같은 계정에 잡히기 때문에, 데이터 크기만 보고 상한을 맞추면 트래픽이 몰릴 때 예상보다 빨리 닿습니다.

다른 하나는 **`maxmemory` 밖에서 필요한 메모리**입니다. RDB 저장이나 AOF 재작성은 프로세스를 fork하고, 그 동안 변경된 페이지만큼 물리 메모리를 더 씁니다.
물리 메모리를 `maxmemory`로 꽉 채워두면 평소엔 괜찮다가 저장 시점에 스왑이 걸립니다.

> 매니지드 서비스는 기본 파라미터 그룹의 `maxmemory-policy`와 예약 메모리 비율이 `redis.conf` 기본값과 다를 수 있습니다.
> "기본값이 `noeviction`이니 우리도 그럴 것"이라고 가정하지 말고 실제 값을 조회해서 확인하세요.

```bash
redis-cli CONFIG GET maxmemory maxmemory-policy maxmemory-samples
```

## 정책 여덟 가지는 두 개의 축이다

정책 이름이 많아 보이지만 축은 둘입니다. **무엇을 후보로 삼는가**와 **후보 중 무엇을 고르는가.**

| 정책 | 축출 후보 | 고르는 기준 |
| --- | --- | --- |
| `noeviction` | 없음 | 쓰기를 거부 |
| `allkeys-lru` | 모든 키 | 최근에 안 쓰인 것 |
| `allkeys-lfu` | 모든 키 | 덜 자주 쓰인 것 |
| `allkeys-random` | 모든 키 | 무작위 |
| `volatile-lru` | TTL 있는 키 | 최근에 안 쓰인 것 |
| `volatile-lfu` | TTL 있는 키 | 덜 자주 쓰인 것 |
| `volatile-random` | TTL 있는 키 | 무작위 |
| `volatile-ttl` | TTL 있는 키 | 남은 TTL이 짧은 것 |

`volatile-*`를 고르면 "TTL을 안 걸어둔 키는 보호된다"는 뜻이 됩니다. 세션이나 락처럼 사라지면 안 되는 것에 TTL을 안 걸고, 캐시에만 TTL을 걸어 구분하는 방식입니다.

여기에 함정이 하나 있습니다.

> `volatile-*` 정책에서 TTL이 걸린 키가 하나도 없으면, Redis는 축출할 후보를 못 찾고 **`noeviction`과 똑같이 동작합니다.** 쓰기가 거부되고 `evicted_keys`는 올라가지 않습니다.

즉 TTL 없는 키가 메모리를 다 먹은 상태에서는 이 정책이 아무것도 못 합니다.
`volatile-*`는 "보호할 게 적고 버릴 게 많을 때" 성립하는 선택이고, 그 비율이 뒤집히면 보호 장치가 아니라 정지 버튼이 됩니다.

### LRU는 근사치고, LFU는 다른 것을 센다

Redis는 가장 오래 안 쓰인 키를 찾기 위해 전체를 훑지 않습니다. 후보 몇 개를 표본으로 뽑아 그중 가장 오래된 것을 버립니다.
표본 개수가 `maxmemory-samples`이고 기본값은 5입니다. 늘리면 실제 LRU에 가까워지고 CPU를 더 씁니다.

LFU는 기준 자체가 다릅니다. 최근성이 아니라 **접근 빈도**를 세고, 그 카운터를 로그 스케일로 올리면서 시간이 지나면 감쇠시킵니다.

```bash
redis-cli CONFIG GET lfu-log-factor lfu-decay-time
# lfu-log-factor  10   카운터가 증가하는 속도 (클수록 천천히)
# lfu-decay-time  1    분 단위 감쇠 주기
```

선택 기준은 접근 패턴입니다. 배치가 한 번 전체를 훑고 지나가는 환경이라면 LRU는 그 배치가 건드린 키들을 "최근에 쓴 키"로 보고 살려둡니다.
인기 있는 소수의 키가 트래픽 대부분을 받는 형태(상품 상세, 인기 피드)라면 LFU가 그 키들을 더 잘 지킵니다.

반대로 최근 데이터만 의미가 있는 시계열 성격이라면 LRU가 더 맞습니다. LFU는 과거에 인기였던 키를 생각보다 오래 붙들고 있습니다.

키별 빈도는 `OBJECT FREQ`로 볼 수 있지만, **LFU 정책일 때만 동작합니다.** 정책을 바꿔보기 전에 이 값으로 판단할 수는 없습니다.

## 지워도 되는 키와 안 되는 키를 같이 두면

문제의 뿌리는 정책 선택이 아니라 **배치**입니다. Redis에 들어가는 것들을 "사라졌을 때 무슨 일이 생기는가"로 줄 세워보면 성격이 전혀 다릅니다.

| 용도 | 사라지면 | 성격 |
| --- | --- | --- |
| 조회 결과 캐시 | 원본에서 다시 계산 | 버려도 됨 |
| 세션 | 로그아웃 | 사용자 경험 손상 |
| 레이트 리밋 카운터 | 한도를 넘겨 허용 | 보호 장치 무력화 |
| 분산 락 | 상호 배제가 깨짐 | 정합성 손상 |
| 멱등키 | 같은 요청이 두 번 처리 | 정합성 손상 |

축출 정책은 **인스턴스 하나에 하나**입니다. 이 다섯 가지를 같은 인스턴스에 넣으면 정책을 어느 쪽으로 정해도 한쪽이 희생됩니다.

`allkeys-lru`로 두면 캐시만 지워지지 않습니다. 락과 멱등키도 후보가 됩니다.
그리고 **멱등키는 LRU 기준으로 가장 약한 쪽입니다.** 한 번 쓰고 재시도가 없으면 다시 읽히지 않는 데이터라, 접근 최근성으로 줄 세우면 맨 앞에 섭니다.
멱등키가 사라진 뒤 도착한 재시도는 처음 보는 요청으로 처리됩니다. 결제라면 중복 결제입니다.

`noeviction`으로 두면 정합성은 지켜지지만 캐시 쓰기가 전부 실패합니다.
그러면 캐시 미스가 원본으로 그대로 흘러가고, 원본 부하가 올라가 응답이 느려지고, 느려진 만큼 동시 요청이 쌓입니다. 메모리 문제가 DB 장애로 번지는 경로입니다.

논리 DB로 나누는 건 해결이 아닙니다.

> `SELECT 1`로 키스페이스를 나눠도 `maxmemory`는 인스턴스 단위이고, 축출 후보도 전체 키스페이스에서 뽑힙니다.
> 1번 DB에 락을 넣어둬도 0번 DB의 캐시가 메모리를 채우면 락이 축출 대상이 됩니다. 클러스터 모드에서는 논리 DB를 쓸 수도 없습니다.

그래서 기준은 하나로 정리됩니다. **사라졌을 때 정합성이 깨지는 데이터는 캐시와 같은 인스턴스에 두지 않습니다.**

- 캐시 전용 인스턴스: `allkeys-lru` 또는 `allkeys-lfu`. 축출은 정상 동작이고, 메모리가 꽉 찬 상태로 도는 게 기대값입니다.
- 락·멱등키·레이트 리밋: `noeviction`. 대신 **모든 키에 TTL을 걸어** 메모리가 단조 증가하지 않게 만듭니다. 여기서 쓰기가 거부되는 건 사고이므로 알람을 걸어둡니다.
- 세션: 둘 중 어디에 둘지는 서비스가 로그아웃을 얼마나 감당하는지에 달렸습니다. 중간을 택한다면 `volatile-lru`로 두고 TTL 유무로 보호 대상을 나누는 방법이 있지만, 앞에서 본 함정을 같이 안고 가야 합니다.

인스턴스를 늘리는 비용이 아깝다면, 적어도 **캐시와 정합성 데이터 둘로만** 나누세요. 이 경계 하나가 위 다섯 줄 중 아래 두 줄을 지킵니다.

{% comment %} TODO: 실제로 인스턴스를 어떻게 나눠서 운영했는지, 나누기 전에 어떤 증상을 봤는지 적어주세요 {% endcomment %}

## TTL이 조용히 사라지는 경로

`noeviction` 인스턴스에서 메모리가 단조 증가하는 원인은 대체로 TTL을 안 건 키입니다. 그리고 TTL은 생각보다 쉽게 사라집니다.

가장 흔한 건 **덮어쓰기**입니다. `SET`은 기존 TTL을 제거합니다.

```bash
redis-cli SET lock:order:42 holder-a EX 30
redis-cli TTL lock:order:42      # 30
redis-cli SET lock:order:42 holder-b
redis-cli TTL lock:order:42      # -1  영구 키가 됐다
```

`INCR`이나 `HSET`처럼 값을 갱신하는 명령은 기존 TTL을 유지하는데 `SET`은 그렇지 않습니다. 이 비대칭이 버그가 되는 자리입니다.
TTL을 유지하면서 값만 바꿔야 한다면 `SET ... KEEPTTL`을 쓰거나, 처음부터 갱신 명령으로 설계합니다.

두 번째는 **컬렉션**입니다. `HSET`, `SADD`, `LPUSH`에는 TTL 옵션이 없습니다. 키가 새로 생길 때 TTL 없이 시작하고, `EXPIRE`를 따로 걸어줘야 합니다.
이걸 빼먹으면 해시 하나가 영구히 남습니다.

그래서 캐시 쓰기는 **TTL을 뺄 수 없는 하나의 경로**로 모으는 편이 낫습니다.

```typescript
import Redis from "ioredis";

// 캐시 전용 인스턴스. TTL 없는 쓰기를 아예 노출하지 않는다.
class CacheStore {
  constructor(private readonly redis: Redis) {}

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error(`cache ttl must be a positive integer: ${ttlSeconds}`);
    }
    await this.redis.set(key, value, "EX", ttlSeconds);
  }

  async setField(
    key: string,
    field: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    // 컬렉션은 생성과 TTL 설정이 두 명령으로 갈리니 같이 보낸다
    await this.redis.multi().hset(key, field, value).expire(key, ttlSeconds).exec();
  }
}
```

`setField`에는 단서가 하나 붙습니다. 매 쓰기마다 `EXPIRE`를 다시 걸면 **TTL이 계속 뒤로 밀려서** 쓰기가 꾸준한 키는 사실상 영구 키가 됩니다.
그게 의도가 아니라면 키 생성 시점에만 걸도록 분기하거나, `EXPIRE`의 조건 옵션을 쓰세요(지원 버전을 확인해야 합니다).

### 지금 TTL 없는 키가 얼마나 있는지

추측하지 말고 셉니다. `KEYS`는 쓰지 않습니다. 전체 키스페이스를 훑는 동안 단일 스레드를 붙잡습니다.

```typescript
async function auditTtl(redis: Redis, pattern: string) {
  let cursor = "0";
  let total = 0;
  let persistent = 0;

  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
    cursor = next;
    if (keys.length === 0) continue;

    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.pttl(key);
    const res = await pipeline.exec();

    keys.forEach((_, i) => {
      total += 1;
      // -1: TTL 없음, -2: 조회 사이에 사라진 키
      if (res?.[i]?.[1] === -1) persistent += 1;
    });
  } while (cursor !== "0");

  return { total, persistent };
}
```

`SCAN`은 커서 방식이라 한 번에 한 조각만 가져옵니다. 전체를 다 돌면 시작 시점부터 끝까지 존재한 키는 모두 나오지만, **같은 키가 두 번 나올 수 있습니다.**
정확한 집계가 필요하면 중복을 제거해야 하고, 경향만 보려면 표본으로 충분합니다.

만료와 회수가 같은 시점이 아니라는 점도 알아두면 혼란이 줄어듭니다.
Redis는 키에 접근할 때 만료를 확인해 지우고, 동시에 백그라운드에서 TTL 있는 키를 표본 조사해 지웁니다.
그래서 **TTL이 지났는데도 메모리가 바로 안 줄어드는 건 정상입니다.** 아무도 안 읽는 키는 백그라운드 주기가 집어갈 때까지 자리를 차지합니다.

## 큰 키 하나가 전체를 막는다

메모리 문제는 지연 문제로 번집니다. 연결 지점이 **단일 스레드**입니다.

명령 하나를 처리하는 동안 다른 모든 요청은 기다립니다. 보통은 모든 명령이 마이크로초 단위라 문제가 안 되는데, 키 하나가 커지면 거기서 깨집니다.

- `HGETALL`, `SMEMBERS`, `LRANGE 0 -1` — 요소 수에 비례합니다. 10만 요소 해시를 통째로 가져오는 호출 하나가 다른 전부를 세웁니다.
- `DEL` — 삭제도 O(N)입니다. 큰 컬렉션을 지우는 순간이 가장 길게 막히는 구간일 수 있습니다. `UNLINK`를 쓰면 키를 즉시 떼어내고 실제 해제는 백그라운드로 넘깁니다.
- 축출과 만료도 해제를 수반합니다. 큰 키가 축출되는 순간 같은 비용이 듭니다. 이 해제를 비동기로 돌리는 `lazyfree-*` 설정이 있으니 배포된 값을 확인해두세요.

측정은 `redis-cli` 옵션으로 합니다.

```bash
redis-cli --bigkeys          # 타입별 최대 키와 평균 크기
redis-cli --memkeys          # MEMORY USAGE 기준 상위 키
redis-cli MEMORY USAGE cart:user:1234 SAMPLES 0   # 0이면 전부 조사해 정확한 값
```

`--bigkeys`와 `--memkeys`는 `SCAN` 기반이라 전수 조회보다 안전하지만 그래도 명령을 많이 보냅니다. 가능하면 리플리카에서 돌리세요.

구조로 푸는 방법은 둘입니다. 하나는 키를 쪼개는 것(사용자별, 날짜별, 해시 슬롯별), 다른 하나는 컬렉션에 상한을 두고 `LTRIM`이나 `ZREMRANGEBYRANK`로 꼬리를 잘라내는 것입니다.
"언젠가 지울 것"으로 남겨두면 지워지지 않습니다.

> 운영 인스턴스에서 `KEYS`, `FLUSHALL`, 큰 컬렉션에 대한 `DEL`은 쓰지 않습니다. 단일 스레드라 한 명령이 전체 지연이 됩니다.
> 위험한 명령은 `rename-command`나 ACL로 막아두는 편이 안전합니다.

## 무엇을 보고 알 수 있나

사용률만 보면 늦습니다. 축출이 시작되면 사용률은 상한 근처에서 평평하게 유지되기 때문에, 그 그래프만으로는 "잘 돌고 있다"와 구분되지 않습니다.

```bash
redis-cli INFO memory | grep -E 'used_memory:|used_memory_rss:|maxmemory:|maxmemory_policy:|mem_fragmentation_ratio'
redis-cli INFO stats  | grep -E 'evicted_keys|expired_keys|keyspace_hits|keyspace_misses'
redis-cli SLOWLOG GET 10
```

봐야 하는 건 이쪽입니다.

- `evicted_keys` — 정책이 버린 키의 누적 수입니다. **증가율**을 봅니다. 평소 0이던 것이 오르기 시작한 시점이 상한에 닿은 시점입니다.
- `expired_keys` — TTL이 다해서 지워진 키입니다. `evicted_keys`와 섞어 보면 원인을 잘못 짚습니다. 전자는 메모리 압박, 후자는 정상 동작입니다.
- `keyspace_hits` / `keyspace_misses` — 적중률입니다. 축출이 시작되면 여기가 먼저 기울고, 그다음에 원본 부하가 보입니다.
- `mem_fragmentation_ratio` — `used_memory_rss / used_memory`입니다. 1.5를 넘으면 단편화를 의심하고, **1보다 작으면 스왑을 쓰고 있다는 뜻으로 이쪽이 더 급합니다.** 단편화는 `activedefrag`로 완화할 수 있지만 CPU를 씁니다.
- `SLOWLOG` — 큰 키 문제는 평균 지연이 아니라 꼬리에서 보입니다. 여기 올라온 명령의 키를 `MEMORY USAGE`로 재보면 대개 범인이 나옵니다.

같은 지표를 인스턴스 성격에 따라 **반대로 읽어야 한다**는 점이 중요합니다.

- 캐시 전용 인스턴스: `evicted_keys`가 꾸준히 오르는 건 정상입니다. 설계대로 도는 겁니다. 알람은 적중률 하락에 겁니다.
- 락·멱등키 인스턴스: `evicted_keys`가 0보다 크면 정합성이 이미 깨졌을 수 있습니다. **0에서 벗어나는 순간**이 알람이고, OOM 에러 발생도 같이 봅니다.

하나 더. 리플리카는 자기 판단으로 축출하지 않습니다. 프라이머리가 축출하면서 보내는 삭제를 받아 반영합니다.
그래서 리플리카의 메모리 지표만 보고 축출 여부를 판단할 수 없고, 반대로 **페일오버로 리플리카가 승격되면 그때부터는 자기 설정으로 축출을 시작합니다.**
프라이머리와 리플리카의 파라미터가 다르면 승격 순간에 동작이 바뀝니다.

{% comment %} TODO: 실제로 메모리 압박을 겪었을 때 어떤 지표로 먼저 발견했는지, 알람을 어떤 기준으로 걸어두었는지 적어주세요 {% endcomment %}

## 정리

- `maxmemory`를 안 걸면 한도를 OS가 정합니다. 스왑과 OOM kill이 축출보다 나쁩니다.
- 기본 정책은 `noeviction`이고, 이때 막히는 건 쓰기뿐입니다. 읽기는 성공하므로 헬스체크와 조회 지표로는 발견되지 않습니다.
- 매니지드 서비스의 기본 파라미터 그룹은 `redis.conf` 기본값과 다를 수 있습니다. 가정하지 말고 `CONFIG GET`으로 확인하세요.
- `volatile-*`는 TTL 있는 키가 하나도 없으면 `noeviction`과 똑같이 동작합니다. 보호 대상이 많아지는 쪽으로 기울면 정지 버튼이 됩니다.
- LRU는 `maxmemory-samples`(기본 5)개 표본으로 고르는 근사치입니다. 전체를 훑는 배치가 있으면 LFU가 인기 키를 더 잘 지킵니다.
- 축출 정책은 인스턴스 단위 하나입니다. 논리 DB로 나눠도 `maxmemory`와 축출 후보는 분리되지 않습니다.
- 멱등키는 "쓰고 다시 안 읽는" 접근 패턴이라 LRU에서 가장 먼저 지워집니다. 캐시와 같은 인스턴스에 두지 마세요.
- `SET`은 기존 TTL을 제거합니다. `INCR`·`HSET`과 동작이 다르고, 여기서 영구 키가 만들어집니다.
- 컬렉션 명령에는 TTL 옵션이 없습니다. 생성과 `EXPIRE`를 같이 보내되, 매 쓰기마다 다시 걸면 TTL이 계속 밀립니다.
- TTL이 지난 키가 바로 회수되지는 않습니다. 접근 시점과 백그라운드 표본 검사 둘로 지워집니다.
- 큰 키의 조회·삭제·축출은 단일 스레드를 막습니다. `DEL` 대신 `UNLINK`, 그리고 `--bigkeys`·`--memkeys`로 먼저 재보세요.
- 알람은 사용률이 아니라 `evicted_keys`의 변화에 걸고, 그 값을 캐시 인스턴스와 정합성 인스턴스에서 반대로 읽으세요.
