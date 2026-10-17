---
layout: post
title: "CPU 사용률은 30%인데 p99가 주기적으로 튄다 — 컨테이너 CPU 리밋과 쓰로틀링"
date: 2026-10-18
tags: [devops, kubernetes, performance, nodejs, ecs]
excerpt: "대시보드의 CPU 사용률은 끝까지 여유로운데 지연만 주기적으로 튑니다. 리밋이 100밀리초 단위 예산으로 바뀌는 구조, 평균 사용률이 쓰로틀링을 가리는 이유, cgroup에서 숫자를 꺼내는 법, 런타임이 호스트 코어 수를 믿어 예산을 앞당겨 태우는 경로, 리밋을 올리거나 없애거나 병렬도를 맞추는 선택의 트레이드오프, ECS·Fargate에서 달라지는 지점, 그리고 오토스케일링이 이 신호를 못 보는 이유까지."
---

p99가 주기적으로 튑니다. 그런데 대시보드의 CPU 사용률은 30%에서 더 올라가지 않습니다.

리밋을 올리면 지연이 나아지고 내리면 심해집니다. 그러면서도 사용률은 끝까지 여유로워 보입니다.

CPU가 모자란 게 맞는데 사용률 그래프에는 그게 안 나타납니다. 모자란 단위가 그래프의 단위와 다르기 때문입니다.

## 리퀘스트와 리밋은 서로 다른 일을 한다

같은 자리에 나란히 적혀 있어서 "최소와 최대"로 읽히는데, 커널에서는 전혀 다른 장치로 내려갑니다.

`requests`는 스케줄러가 파드를 어느 노드에 놓을지 정할 때 쓰는 예약값이고, 그다음에는 **경쟁이 생겼을 때의 분배 비율**로만 작동합니다. cgroup의 `cpu.weight`(v1에서는 `cpu.shares`)가 그 역할입니다.

노드에 여유가 있으면 리퀘스트를 넘겨 써도 아무 일도 생기지 않습니다. 리퀘스트는 상한이 아닙니다.

`limits`는 다릅니다. 이건 **일정 시간마다 쓸 수 있는 CPU 시간의 총량**으로 번역되고, 그 총량을 다 쓰면 남은 시간 동안 프로세스는 그냥 멈춰 서 있습니다.

| | `requests` | `limits` |
| --- | --- | --- |
| 내려가는 장치 | `cpu.weight` / `cpu.shares` | CFS quota (`cpu.max`) |
| 작동 시점 | 노드에 경쟁이 있을 때만 | 항상 |
| 넘기면 | 넘겨 쓸 수 있다 | 멈춘다(쓰로틀) |
| 증상 | 노드가 붐빌 때 느려짐 | 노드가 한가해도 느려짐 |

메모리와 비교하면 왜 이게 조용히 넘어가는지가 보입니다. 메모리 리밋을 넘기면 프로세스가 죽고 `OOMKilled`가 찍히니 못 보고 넘어갈 수가 없습니다.

CPU는 **압축 가능한 자원**으로 취급돼서, 넘기면 죽는 대신 느려집니다. 사건으로 기록되지 않고 지연 분포에만 흔적을 남깁니다.

## 100밀리초 단위로 끊어 쓴다

쿠버네티스는 CPU 리밋을 비율이 아니라 주기당 시간 예산으로 바꿉니다. 기본 주기는 100밀리초입니다.

```text
limit 500m  →  100ms 주기마다 CPU 시간 50ms
limit 2     →  100ms 주기마다 CPU 시간 200ms (코어 여러 개에서 합산)
```

여기서 두 가지가 중요합니다.

첫째, **예산은 스레드별이 아니라 cgroup 전체 합산**입니다. 스레드 4개가 동시에 돌면 실제 시간 12.5밀리초 만에 50밀리초를 다 태웁니다. 그러면 남은 87.5밀리초 동안 그 컨테이너의 모든 스레드가 멈춥니다.

둘째, **남은 예산은 다음 주기로 넘어가지 않습니다.** 한가한 주기에 아껴둔 몫을 바쁜 주기에 끌어다 쓸 수 없습니다.

이 둘이 겹치면 평균 사용률과 체감 지연이 갈라집니다. 요청이 고르게 들어오지 않고 뭉쳐 들어오는 서비스라면, 전체 평균은 낮으면서 특정 주기에서만 예산이 마릅니다.

그리고 대시보드의 사용률은 보통 30초나 1분 평균입니다. 100밀리초 안에서 벌어진 일은 그 평균에 거의 흔적을 남기지 않습니다.

> 사용률이 낮다는 것은 "CPU가 모자라지 않았다"의 근거가 되지 못합니다. 평균 사용률과 쓰로틀링은 서로 독립적인 지표이고, 둘 다 봐야 합니다.

지연에 더 직접적으로 나타나는 쪽은 멈춰 있는 시간입니다. 한 요청을 처리하는 중에 주기 경계를 두 번 밟으면, 하는 일이 같은데도 응답 시간에 수십 밀리초가 그냥 더해집니다.

## 숫자로 확인하기

추측할 필요가 없습니다. 커널이 쓰로틀 횟수와 멈춰 있던 시간을 세어줍니다.

```bash
# cgroup v2
cat /sys/fs/cgroup/cpu.max     # "50000 100000" → 주기 100ms, 예산 50ms ("max"면 리밋 없음)
cat /sys/fs/cgroup/cpu.stat    # nr_periods / nr_throttled / throttled_usec

# cgroup v1
cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us    # -1이면 리밋 없음
cat /sys/fs/cgroup/cpu/cpu.cfs_period_us
cat /sys/fs/cgroup/cpu/cpu.stat            # throttled_time은 나노초 단위
```

누적값이라 한 번 찍어서는 의미가 없습니다. 차분을 내야 비율이 나옵니다.

```bash
# 컨테이너 안에서 10초 동안의 쓰로틀 비율
read -r _ p1 <<< "$(grep nr_periods   /sys/fs/cgroup/cpu.stat)"
read -r _ t1 <<< "$(grep nr_throttled /sys/fs/cgroup/cpu.stat)"
sleep 10
read -r _ p2 <<< "$(grep nr_periods   /sys/fs/cgroup/cpu.stat)"
read -r _ t2 <<< "$(grep nr_throttled /sys/fs/cgroup/cpu.stat)"
awk -v p="$((p2-p1))" -v t="$((t2-t1))" \
  'BEGIN { printf "periods=%d throttled=%d ratio=%.1f%%\n", p, t, p ? t/p*100 : 0 }'
```

클러스터 전체로 보려면 cAdvisor가 같은 카운터를 내보냅니다.

```text
# 쓰로틀된 주기의 비율
sum by (pod, container) (rate(container_cpu_cfs_throttled_periods_total{container!=""}[5m]))
/
sum by (pod, container) (rate(container_cpu_cfs_periods_total{container!=""}[5m]))
```

읽는 기준은 이렇습니다. **0에 가까워야 정상**이고, 배치 작업이라면 꽤 높아도 문제가 아닐 수 있습니다.

반면 사용자 요청을 받는 API라면 한 자리 퍼센트도 의심해볼 값입니다. 쓰로틀된 주기의 비율은 "얼마나 자주 멈췄는지"만 말해주고, 그 주기에서 **얼마나 오래** 멈춰 있었는지는 `throttled_usec` 쪽을 봐야 합니다.

비율은 낮은데 멈춘 시간이 길면 드물게 크게 튀는 모양이고, 비율이 높은데 시간이 짧으면 상시로 조금씩 깎이는 모양입니다. 전자는 p99에, 후자는 처리량에 먼저 나타납니다.

컨테이너 단위로 집계된다는 점도 기억해둘 만합니다. 사이드카가 붙어 있으면 각자 자기 리밋과 자기 예산을 갖고, 로그 수집 사이드카 하나가 자기 리밋에서 쓰로틀돼 애플리케이션 쪽을 막는 경우도 생깁니다.

## 런타임이 코어 수를 잘못 읽는다

쓰로틀링이 심한 컨테이너를 들여다보면, 상당수는 런타임이 **자기한테 허락된 CPU가 얼마인지 모르는** 상태입니다.

CPU 리밋은 "이 코어만 쓰라"가 아니라 "시간을 이만큼만 쓰라"입니다. 코어를 떼어주는 게 아니라서, 프로세스 입장에서는 노드의 코어가 전부 보입니다.

그래서 코어 수를 보고 스레드 풀이나 워커 수를 정하는 코드는 노드 기준으로 커집니다. 리밋이 1코어인데 워커를 16개 띄우는 상황이 이렇게 만들어집니다.

Node.js라면 직접 찍어보는 게 빠릅니다.

```typescript
import os from 'node:os';
import fs from 'node:fs';

const readCgroup = (p: string) => {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; }
};

console.log({
  // 런타임이 보는 값 — 보통 노드의 코어 수다
  cpus: os.cpus().length,
  availableParallelism: os.availableParallelism?.(),
  // 커널이 실제로 허락한 예산
  cpuMax: readCgroup('/sys/fs/cgroup/cpu.max'),              // v2
  quota: readCgroup('/sys/fs/cgroup/cpu/cpu.cfs_quota_us'),   // v1
  threadpool: process.env.UV_THREADPOOL_SIZE ?? '(기본값)',
});
```

두 값이 어긋나 있으면 거기서부터 정리합니다. 리밋을 코어 수로 환산해 워커 수의 상한으로 쓰면 됩니다.

```typescript
import fs from 'node:fs';
import os from 'node:os';

// CFS quota를 코어 수로 환산한다. 리밋이 없으면 null.
function cpuLimit(): number | null {
  try {
    const [quota, period] = fs.readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(/\s+/);
    if (quota === 'max') return null;
    return Number(quota) / Number(period);
  } catch {
    return null;
  }
}

const limit = cpuLimit();
// 리밋이 1코어 미만이면 워커는 1개. 소수점을 올려 잡으면 예산만 더 빨리 태운다.
export const workers = Math.max(1, Math.floor(limit ?? os.availableParallelism()));
```

> `os.availableParallelism()`은 CPU 어피니티(cpuset)를 반영하는 쪽이라, 시간 예산으로 걸린 리밋은 반영되지 않는 것으로 보는 편이 안전합니다. 런타임 버전에 따라 달라질 수 있는 부분이니 위처럼 **값으로 찍어서** 확인하세요.

다른 런타임도 같은 문제를 각자 다루고 있습니다.

- **JVM**: 컨테이너 인식이 켜져 있으면 CPU 리밋을 반영해 사용 가능 프로세서 수를 계산하고, `-XX:ActiveProcessorCount`로 직접 지정할 수 있습니다. 이 값이 GC 스레드 수와 각종 기본 풀 크기를 좌우합니다.
- **Go**: 1.25부터 `GOMAXPROCS`가 cgroup의 CPU 리밋을 반영하도록 바뀌었고, 그 전에는 `uber-go/automaxprocs` 같은 라이브러리로 맞추는 게 관행이었습니다. 동작과 예외 조건은 쓰는 버전의 릴리스 노트를 확인하세요([Go 블로그 설명](https://go.dev/blog/container-aware-gomaxprocs)).
- **Node.js**: libuv 스레드풀(`UV_THREADPOOL_SIZE`)은 코어 수와 무관한 자체 기본값을 쓰고, `cluster` 워커 수는 코드가 정합니다. 둘 다 사람이 맞춰줘야 합니다.

여기서 직관과 반대인 결론이 나옵니다. **병렬도를 줄이면 빨라지는 경우가 있습니다.**

스레드를 늘려도 예산 총량은 그대로이고, 늘어난 스레드는 예산을 더 빨리 태워 멈춤 구간을 앞당깁니다. 거기에 컨텍스트 스위칭과 GC 스레드 경쟁이 더해져서, 처리량은 그대로인데 지연 분포만 나빠집니다.

## 고치는 선택지와 각자 내주는 것

| 선택 | 효과 | 내주는 것 |
| --- | --- | --- |
| 리밋을 올린다 | 즉시 완화 | 노드 용량·비용, 오버커밋 위험 |
| 런타임 병렬도를 리밋에 맞춘다 | 근본 교정 | 런타임마다 손으로 설정 |
| 리밋을 없앤다(리퀘스트만) | 버스트 허용 | 이웃 영향, 예측 가능성 |
| 요청당 CPU 작업을 줄인다 | 가장 오래 가는 해결 | 코드 변경 비용 |

**리밋을 올리는 것**은 가장 빠른 조치이고 대개 틀리지 않습니다. 다만 리밋의 총합이 노드 용량을 넘는 상태에서는, 여러 파드가 동시에 버스트하면 결국 노드에서 경쟁하게 되고 그때는 리퀘스트 비율이 분배를 결정합니다. 리밋을 올리는 것과 리퀘스트를 올리는 것은 효과가 다릅니다.

**병렬도를 맞추는 것**은 번거롭지만 효과가 오래 갑니다. 리밋이 1코어 미만인 파드에 워커를 여러 개 띄우고 있다면 여기부터 손대는 게 맞습니다.

**리밋을 아예 없애는 선택**도 실제로 많이 쓰입니다. 쓰로틀이 사라지니 지연 분포가 바로 좋아집니다.

대신 한 파드가 노드 CPU를 끌어다 쓰는 것을 막는 장치가 없어집니다. 리퀘스트가 분배를 보장해주긴 하지만, 그건 **경쟁이 발생한 뒤의 비율**이라 "평소에 나던 성능"이 노드 상황에 따라 달라집니다. 용량 계획과 성능 재현이 어려워지는 쪽을 받아들이는 선택입니다.

> 네임스페이스에 `LimitRange`가 걸려 있거나 관리형 플랫폼 정책이 리밋을 요구하면 이 선택지가 아예 없을 수도 있습니다. 리밋 유무가 QoS 클래스에도 영향을 주니, 축출 우선순위가 어떻게 바뀌는지 확인하고 결정하세요.

**요청당 작업을 줄이는 쪽**은 애초에 예산 안에 들어오게 만드는 방향입니다. 동기 CPU 작업을 요청 경로에서 떼어내는 이야기는 [이벤트 루프 블로킹](/blog/nodejs-event-loop-blocking/)에서 다룬 것과 같은 작업이고, 거기서 한 조치들이 쓰로틀 비율도 같이 내려줍니다.

주기 자체를 바꾸는 방법도 있긴 합니다. 주기를 짧게 하면 멈춤이 잘게 쪼개져 지연의 모양이 완만해집니다. 다만 이건 kubelet 설정이라 노드 전역에 적용되고, 주기가 짧아지면 스케줄링 오버헤드가 늘어납니다. 애플리케이션 쪽 선택지를 다 써본 뒤에 고려할 카드입니다.

커널도 한 번 확인할 대상입니다. 과거 커널에는 멀티코어에서 예산을 실제보다 빨리 소진한 것으로 계산하는 버그가 있었고, 5.4대에서 고쳐졌습니다. 아주 오래된 커널을 쓰고 있다면 설정을 아무리 만져도 비율이 안 내려갈 수 있습니다.

{% comment %} TODO: 실제로 리밋을 조정하거나 제거해본 경험이 있다면, 쓰로틀 비율과 p99가 어떻게 움직였는지 적어주세요 {% endcomment %}

## 리밋이 1코어 미만일 때

작은 리밋에서는 쓰로틀이 상수항처럼 붙습니다. 100m은 주기당 10밀리초이고, GC 한 번이나 TLS 핸드셰이크 하나가 그 예산을 통째로 먹을 수 있습니다.

이때 생기는 문제는 지연만이 아닙니다.

프로세스 시작 구간은 평소보다 CPU를 많이 쓰는데, 작은 리밋에서는 그 구간이 길게 늘어납니다. 그러면 readiness 프로브가 먼저 실패하고, 컨테이너가 재시작하고, 재시작이 또 시작 구간을 만듭니다.

그래서 작은 리밋을 쓸 때는 시작 구간을 따로 봐줘야 합니다. 쿠버네티스의 `startupProbe`는 이 구간에만 다른 기준을 적용하는 장치입니다.

```yaml
resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    # 리퀘스트와 같게 두면 성능이 예측 가능해지고, 벌려두면 버스트를 허용하는 대신 노드 상황에 따라 달라진다
    cpu: 1
    memory: 256Mi      # 메모리는 압축 불가 자원이라 벌려두면 OOMKill 위험만 늘어난다
startupProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 5
  failureThreshold: 30      # 시작 구간에만 넉넉히
livenessProbe:
  httpGet: { path: /healthz, port: 8080 }
  periodSeconds: 10
  failureThreshold: 3
```

"작게 많이"와 "크게 적게" 사이의 선택도 여기서 갈립니다.

레플리카를 늘리면 요청은 나눠지지만 **런타임 고정비는 나눠지지 않습니다.** 힙, 스레드, 그리고 커넥션 풀이 레플리카마다 한 벌씩 더 생깁니다.

DB 쪽에서 이게 어떻게 돌아오는지는 [커넥션 풀이 마르는 순간](/blog/db-connection-pool-exhaustion/)에서 본 구조와 같습니다. 파드를 잘게 쪼개 늘리는 선택은 DB 커넥션 총량을 같이 계산해야 합니다.

## ECS와 Fargate는 어떻게 다른가

커널에서 일어나는 일은 같습니다. 어디서 상한이 정해지는지가 다릅니다.

ECS 태스크 정의에는 CPU 값을 적는 자리가 두 곳 있습니다. 태스크 레벨 `cpu`와 컨테이너 레벨 `cpu`입니다.

```json
{
  "family": "api",
  "cpu": "1024",
  "memory": "2048",
  "containerDefinitions": [
    { "name": "api",     "cpu": 768, "essential": true },
    { "name": "logging", "cpu": 256, "essential": false }
  ]
}
```

태스크 레벨 값은 그 태스크가 쓸 수 있는 총량이고, 1024 단위가 1 vCPU에 해당합니다. 컨테이너 레벨 값은 성격이 달라서, 같은 태스크 안의 컨테이너들끼리 나눠 쓸 때의 **상대 가중치**로 작동합니다.

그래서 쿠버네티스의 `requests`/`limits`를 ECS로 그대로 옮기면 의도가 어긋납니다. 이 매핑은 [EKS에서 ECS로 전환](/blog/eks-to-ecs-migration/)할 때 먼저 확인했어야 하는 항목이고, 정확한 동작은 실행 유형(EC2/Fargate)에 따라 다르니 공식 문서를 보고 맞추는 게 안전합니다.

Fargate에서는 태스크 사이즈가 곧 상한이라 구조가 더 단순합니다. 대신 **노드에 여유가 있어서 넘겨 쓰는 일**도 없습니다. 쓰로틀은 예외가 아니라 정상 동작입니다.

지표 쪽이 더 불편합니다. CloudWatch 쪽 컨테이너 지표는 예약량 대비 사용량 중심이라, 쓰로틀 카운터를 바로 꺼내 쓸 수 있다고 전제하지 않는 편이 안전합니다. 확실한 방법은 컨테이너 안에서 cgroup을 읽어 직접 내보내는 것입니다.

```typescript
import fs from 'node:fs/promises';

async function readStat(): Promise<Record<string, number>> {
  // v2: "nr_periods 123\nnr_throttled 4\nthrottled_usec 56789"
  const raw = await fs.readFile('/sys/fs/cgroup/cpu.stat', 'utf8');
  return Object.fromEntries(
    raw.trim().split('\n').map((line) => {
      const [k, v] = line.split(/\s+/);
      return [k, Number(v)];
    }),
  );
}

let prev = await readStat();

setInterval(async () => {
  const cur = await readStat();
  const periods = cur.nr_periods - prev.nr_periods;
  const throttled = cur.nr_throttled - prev.nr_throttled;
  const stalledMs = (cur.throttled_usec - prev.throttled_usec) / 1000;
  prev = cur;

  if (periods > 0) {
    // 지표 수집기로 내보낸다. 로그만 남기면 추세를 못 본다.
    metrics.gauge('cpu.throttled_ratio', throttled / periods);
    metrics.gauge('cpu.stalled_ms_per_interval', stalledMs);
  }
}, 30_000);
```

cgroup v1 환경이라면 파일 경로와 필드 이름이 다릅니다. 두 버전을 모두 돌리고 있다면 양쪽 경로를 다 시도하는 코드가 필요합니다.

## 오토스케일링이 이 신호를 못 보는 이유

HPA의 CPU 기준은 보통 **리퀘스트 대비 사용률**입니다. 쓰로틀은 **리밋**에서 발생합니다. 기준이 서로 다릅니다.

리퀘스트와 리밋을 벌려놓은 파드는 이 둘이 어긋납니다. 리퀘스트 200m, 리밋 1인 파드가 리밋에 닿아 쓰로틀되는 중에도, HPA가 보는 사용률은 리퀘스트 대비라 이미 한참 전에 100%를 넘겨 있거나 반대로 평균에 희석돼 조용할 수 있습니다. 어느 쪽이든 **"쓰로틀되고 있다"는 사실 자체는 HPA에 전달되지 않습니다.**

더 중요한 건 레플리카를 늘려서 해결되는 문제와 그렇지 않은 문제가 섞여 있다는 점입니다.

- **처리량이 모자란 경우**: 레플리카를 늘리면 요청이 나눠지고 파드별 예산 소진이 줄어듭니다. 쓰로틀도 같이 내려갑니다.
- **요청 하나가 예산보다 큰 경우**: 레플리카를 늘려도 그 요청의 지연은 그대로입니다. 한 요청이 한 파드 안에서 처리되는 한, 그 파드의 리밋이 그 요청의 상한입니다.

두 번째를 첫 번째로 오진하면 레플리카만 늘어나고 p99는 그대로인 상태가 됩니다. 그래서 쓰로틀 비율은 스케일링 지표와 별개로 알람을 걸어두는 편이 낫습니다.

{% comment %} TODO: 실제로 운영에서 쓰로틀 비율에 알람을 걸고 있다면 기준값과 그 기준을 정한 이유를 적어주세요 {% endcomment %}

## 체크리스트

- [ ] 지연이 튀는 컨테이너의 `nr_throttled` / `nr_periods` 비율을 **값으로 확인**했는가
- [ ] 쓰로틀된 주기 수와 멈춰 있던 시간(`throttled_usec`)을 둘 다 보고 있는가
- [ ] 런타임이 보는 코어 수와 cgroup의 CPU 예산이 어긋나 있지 않은가
- [ ] 워커 수·스레드풀 크기를 노드 코어 수가 아니라 리밋 기준으로 정하고 있는가
- [ ] 사이드카가 자기 리밋에서 쓰로틀되고 있지 않은가
- [ ] 메모리 리밋은 리퀘스트와 같게 두었는가 (압축 불가 자원)
- [ ] 작은 리밋에서 시작 구간이 readiness 실패를 유발하지 않는가
- [ ] 레플리카를 늘릴 때 DB 커넥션 총량을 같이 계산했는가
- [ ] 쓰로틀 비율에 스케일링 지표와 별개의 알람이 있는가

마지막으로 순서 하나. **리밋을 조정하기 전에 쓰로틀 지표를 먼저 붙이는 쪽이 낫습니다.**

리밋은 숫자 하나라서 손대기 쉽고, 손대면 뭔가 나아진 것처럼 보입니다. 측정 없이 올리면 "넉넉하게 줘서 해결된 문제"로 끝나고, 같은 증상이 다른 서비스에서 다시 나올 때 또 처음부터 찾게 됩니다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 쓰로틀링을 처음 발견한 경로와 당시 지표
- 리밋·병렬도 조정 후 p99가 어떻게 바뀌었는지

{% endcomment %}
