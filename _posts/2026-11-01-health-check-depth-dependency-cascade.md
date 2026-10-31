---
layout: post
title: "DB가 잠깐 흔들렸는데 서버가 전부 빠졌다 — 헬스체크를 어디까지 검사할 것인가"
date: 2026-11-01
tags: [devops, kubernetes, ecs, aws, backend]
excerpt: "헬스체크에 의존성 검사를 넣으면 공유 의존성 장애가 모든 인스턴스를 동시에 비정상으로 만든다. readiness와 liveness가 각각 답해야 하는 질문, 깊은 진단을 분리하는 엔드포인트 구성, 판정 시간 계산까지."
---

헬스체크는 고장난 인스턴스 하나를 빼기 위해 붙입니다.
그런데 인스턴스 전부가 같은 DB를 보고 있으면, DB가 몇 초 멈추는 순간 전부가 동시에 "고장"이라고 답합니다.

빼야 할 대상이 하나도 없는데 전부 빼려고 하는 상태입니다.
짧은 의존성 장애가 긴 전면 장애로 바뀌는 지점이 여기입니다.

## 헬스체크는 한 가지 질문이 아니다

플랫폼이 묻는 건 두 가지입니다. **지금 이 인스턴스에 요청을 보내도 되는가**, 그리고 **이 프로세스를 재시작해야 하는가**.

쿠버네티스는 `readinessProbe`와 `livenessProbe`로 나눠서 묻고, ECS라면 대상 그룹 헬스체크와 컨테이너 헬스체크가 각각 그 역할에 가깝습니다.

차이는 **실패했을 때 일어나는 일**입니다. 앞의 것은 트래픽에서 빼고, 뒤의 것은 프로세스를 죽입니다.
그래서 두 검사가 같은 엔드포인트를 보고 있으면, 트래픽만 빼고 싶었던 상황에서 컨테이너가 재시작됩니다. 배포 중 드레이닝에서 이게 어떻게 어긋나는지는 [종료 신호와 커넥션 드레이닝](/blog/graceful-shutdown-deploy-5xx/)에 적어뒀습니다.

여기서 볼 건 그다음 질문입니다. 그 엔드포인트가 **무엇까지 검사해야 하는가**.

## 얕으면 거짓 통과한다

처음 붙이는 헬스체크는 대개 이렇습니다.

```typescript
app.get('/healthz', (_req, res) => res.send('ok'));
```

이건 "HTTP 서버가 응답한다"까지만 말해줍니다. 프로세스가 떠 있고 포트가 열려 있으면 통과입니다.

문제는 그 조건이 참인데 요청은 전부 실패하는 상태가 실제로 흔하다는 점입니다.

- 커넥션 풀이 말라서 모든 쿼리가 획득 대기에 걸려 있다 ([커넥션 풀이 마르는 순간](/blog/db-connection-pool-exhaustion/))
- 설정이나 시크릿을 못 읽어서, 부팅은 됐지만 핸들러가 전부 500을 낸다
- 마이그레이션이 적용되지 않아 스키마가 코드와 맞지 않는다

그래서 다음 단계는 거의 정해져 있습니다. 의존성을 하나씩 찔러보는 쪽으로 갑니다.

```typescript
// 흔하지만 위험한 형태
app.get('/healthz', async (_req, res) => {
  await db.query('SELECT 1');
  await redis.ping();
  await fetch('https://api.payments.example/health');
  res.send('ok');
});
```

의도 자체는 정확합니다. 그런데 이걸 **로드밸런서에 꽂으면** 장애의 성격이 바뀝니다.

## 깊으면 장애를 증폭한다

핵심은 의존성이 **공유된다**는 사실입니다. 인스턴스 열 대가 같은 DB를 본다면, DB가 흔들릴 때 열 대가 같은 답을 동시에 냅니다.

결말은 둘 중 하나인데, 둘 다 좋지 않습니다.

**절반만 빠지는 경우.** 체크 타이밍이 어긋나 일부가 먼저 임계치를 넘깁니다.
남은 인스턴스가 전체 트래픽을 받고, 이미 느린 DB에 같은 양의 쿼리가 더 몰립니다. 그러면 나머지도 차례로 빠집니다.

**전부 빠지는 경우.** 이쪽은 조금 허무합니다. 대상 그룹의 모든 대상이 비정상이면 ALB는 요청을 버리지 않고 **모든 대상으로 그대로 보냅니다.** fail open이라고 부르는 동작입니다.

결국 전부 비정상인 상태의 결과는 헬스체크를 아예 안 넣은 것과 같습니다. 깊은 체크로 얻은 것이 없습니다.

> 모든 대상이 비정상일 때 ALB·NLB는 fail open으로 동작합니다. 정확한 조건과 적용 범위는 [대상 그룹 헬스체크 문서](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html)에서 확인하세요.

그리고 이 검사가 liveness 쪽에 걸려 있으면 하나가 더 붙습니다. DB가 느린 동안 **인스턴스 전체가 재시작**됩니다.

재시작하면 커넥션 풀과 인메모리 캐시가 비고, 다시 뜨면서 커넥션을 한꺼번에 새로 맺고, 캐시가 빈 채로 쿼리를 쏟습니다.
흔들리는 DB에 가장 하면 안 되는 일을 헬스체크가 자동으로 해주는 셈입니다.

그래서 판단 기준은 한 줄로 줄어듭니다.

> **헬스체크는 "이 인스턴스를 빼면 상황이 나아지는가"에만 답해야 합니다.**

DB가 죽어서 생긴 실패는 이 인스턴스를 빼도 나아지지 않습니다. 그러니 그 판단을 헬스체크에서 하면 안 됩니다.

## 그래서 무엇을 검사하는가

의존성을 **인스턴스 고유**와 **공유**로 나누면 선이 그어집니다.
인스턴스마다 답이 다를 수 있는 것만 로드밸런서에 알리고, 전부 같은 답을 내는 것은 알리지 않습니다.

| 신호 | 유형 | readiness | liveness |
| --- | --- | --- | --- |
| 부팅·마이그레이션 완료 여부 | 인스턴스 고유 | O | X |
| 종료 절차 시작(드레이닝) | 인스턴스 고유 | O | X |
| 로컬 커넥션 풀 포화 | 인스턴스 고유 | 조건부 | X |
| 이벤트 루프 지연 | 인스턴스 고유 | 조건부 | X |
| 공용 DB·Redis 응답 불가 | 공유 | X | X |
| 외부 API 장애 | 공유 | X | X |
| 응답 자체가 불가능한 프로세스 | 인스턴스 고유 | - | O |

"조건부"는 플래핑 때문입니다. 포화는 트래픽이 몰려서 생기는데, 포화를 이유로 스스로 빠지면 그 트래픽이 옆으로 가서 옆도 똑같이 포화시킵니다.
반영하려면 임계치를 넉넉하게 두고, 동시에 빠질 수 있는 대수에 상한이 있는 구조에서만 하세요.

이벤트 루프가 막혀 있으면 어차피 헬스체크 응답 자체가 늦어집니다 ([이벤트 루프 블로킹](/blog/nodejs-event-loop-blocking/)).
별도 신호로 집어넣기보다 프로브 타임아웃이 대신 잡아주게 두는 편이 단순합니다.

## 엔드포인트를 셋으로 나눈다

깊은 검사가 무의미하다는 뜻은 아닙니다. **누가 그 결과를 보고 무엇을 하는가**가 다를 뿐입니다.
로드밸런서가 보면 인스턴스를 빼지만, 알람이나 사람이 보면 원인을 찾습니다. 뒤쪽은 분명히 의미가 있습니다.

그래서 경로를 셋으로 나눕니다.

```typescript
let booted = false;      // 마이그레이션·설정 로딩까지 끝났는가
let accepting = true;    // 종료 절차가 시작되면 false

// 1) 프로세스 생존 — 재시작 판단용. 의존성을 보지 않는다.
app.get('/livez', (_req, res) => res.status(200).send('alive'));

// 2) 트래픽 수용 의사 — LB/대상 그룹이 본다. 로컬 상태만 본다.
app.get('/readyz', (_req, res) => {
  const ok = booted && accepting;
  res.status(ok ? 200 : 503).json({ booted, accepting });
});

// 3) 깊은 진단 — LB에 꽂지 않는다. 모니터링과 사람이 본다.
app.get('/statusz', async (_req, res) => {
  const checks = await inspectDependencies();
  const hardDown = checks.some((c) => c.kind === 'hard' && !c.ok);
  res.status(hardDown ? 503 : 200).json({ checks });
});
```

`/livez`가 아무 의존성도 보지 않는 게 핵심입니다. 이 검사의 실패는 곧 재시작이고, 재시작으로 고쳐지는 고장은 프로세스 자신의 고장뿐입니다.

`/statusz`는 503을 낼 수 있지만 **아무도 그걸로 인스턴스를 빼지 않습니다.** 알람의 입력이고, 장애 때 어디가 끊겼는지 사람이 가장 먼저 여는 페이지입니다.
여기에는 의존성을 마음껏 넣어도 됩니다.

> `/statusz`가 실수로 대상 그룹 헬스체크 경로에 들어가면 지금까지의 모든 설계가 무의미해집니다.
> 대상 그룹과 프로브의 경로 설정은 IaC에 박아두고 리뷰 대상으로 만드는 편이 안전합니다.

## 깊은 검사를 안전하게 만들기

`/statusz`도 공짜가 아닙니다. 세 가지를 지키지 않으면 진단용 엔드포인트가 그 자체로 부하가 됩니다.

**검사마다 자체 타임아웃.** 느린 의존성 하나가 전체 응답을 붙들면, 응답이 오기 전에 호출자가 먼저 포기합니다.

**결과 캐시.** 체크 호출 빈도는 생각보다 높습니다. ALB는 가용 영역별 로드밸런서 노드가 각각 모든 대상을 검사하므로, 체크 요청 수는 대략 `노드 수 × 대상 수 ÷ 간격`으로 늘어납니다.
여기에 모니터링 폴링과 쿠버네티스 프로브까지 겹치면, 헬스체크가 상시로 DB를 두드리는 트래픽이 됩니다.

**hard와 soft 구분.** 그게 없으면 캐시 하나 때문에 전체가 빨간불이 됩니다.

```typescript
type Check = { name: string; kind: 'hard' | 'soft'; ok: boolean; ms: number; error?: string };

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)),
  ]);

function cached(name: string, kind: Check['kind'], ttlMs: number, probe: () => Promise<unknown>) {
  let last: Check | null = null;
  let at = 0;
  return async (): Promise<Check> => {
    if (last && Date.now() - at < ttlMs) return last;
    const started = Date.now();
    try {
      await withTimeout(probe(), 1_000);
      last = { name, kind, ok: true, ms: Date.now() - started };
    } catch (e) {
      last = { name, kind, ok: false, ms: Date.now() - started, error: (e as Error).message };
    }
    at = Date.now();
    return last;
  };
}

const probes = [
  cached('mysql', 'hard', 5_000, () => db.query('SELECT 1')),
  cached('redis', 'soft', 5_000, () => redis.ping()),          // 캐시는 없어도 느려질 뿐이다
  cached('payments', 'soft', 15_000, () => paymentsClient.ping()),
];

const inspectDependencies = () => Promise.all(probes.map((p) => p()));
```

`redis`를 soft로 둔 건 **캐시가 없으면 느려지지만 멈추지는 않는다**는 전제가 있을 때입니다.
세션 저장소나 레이트 리밋 카운터를 Redis에 두고 그게 없으면 로그인이 안 되는 구조라면 soft가 아닙니다. 분류는 서비스마다 다시 해야 합니다.

{% comment %} TODO: 이 블로그 주인의 서비스 기준으로 hard/soft 분류를 실제 의존성 목록으로 바꿔 적어주면 더 좋습니다 {% endcomment %}

## 부팅 중과 종료 중은 또 다른 상태다

부팅이 끝나기 전의 실패는 고장이 아닙니다. 그런데 liveness를 처음부터 돌리면 플랫폼은 그걸 고장으로 읽고, 부팅이 느린 애플리케이션은 **뜨기도 전에 반복 재시작**에 들어갑니다.

쿠버네티스는 `startupProbe`로 이 구간을 분리합니다. 시작 프로브가 성공하기 전에는 liveness와 readiness를 **실행하지 않습니다.**

```yaml
startupProbe:
  httpGet: { path: /livez, port: 8080 }
  periodSeconds: 5
  failureThreshold: 60        # 이 조합이 허용하는 부팅 시간 = 5s × 60 = 300s

livenessProbe:
  httpGet: { path: /livez, port: 8080 }
  periodSeconds: 10
  timeoutSeconds: 2
  failureThreshold: 3

readinessProbe:
  httpGet: { path: /readyz, port: 8080 }
  periodSeconds: 5
  timeoutSeconds: 2
  failureThreshold: 2
```

ECS·ALB 조합이라면 역할이 둘로 나뉩니다. 컨테이너 헬스체크의 `startPeriod`가 부팅 구간을 덮고, 서비스의 헬스체크 유예 기간이 대상 그룹 판정을 미룹니다.

```hcl
resource "aws_lb_target_group" "api" {
  name        = "api"
  port        = 8080
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    path                = "/readyz"     # 깊은 진단 경로를 넣지 않는다
    matcher             = "200"
    interval            = 10
    timeout             = 3             # 반드시 interval 보다 작게
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
}

resource "aws_ecs_service" "api" {
  # ...
  health_check_grace_period_seconds = 120   # 부팅이 끝나기 전에 ELB 판정으로 태스크를 죽이지 않도록
}
```

> 각 설정의 허용 범위와 기본값은 버전과 서비스에 따라 다릅니다. 위 숫자는 설명을 위한 예시이므로 공식 문서에서 확인하고 쓰세요.

유예 기간을 짧게 두면 부팅이 느린 날에 태스크가 영원히 교체만 반복합니다. 길게 두면 진짜 고장난 태스크가 그만큼 오래 남습니다.
**부팅 시간의 최악값에 여유를 더한 값**이 출발점이고, 이미지가 커지거나 마이그레이션이 늘면 다시 봐야 하는 숫자입니다.

## 숫자를 맞추는 법

판정에 걸리는 시간은 곱셈으로 나옵니다.

```text
빠지는 데 걸리는 시간 ≈ 간격 × 실패 임계치 + 전파 지연
복귀에 걸리는 시간   ≈ 간격 × 성공 임계치 + 전파 지연
```

여기서 트레이드오프가 분명해집니다. 민감하게 하면 일시적 지연에도 대상이 빠져 플래핑하고, 둔감하게 하면 진짜 고장난 인스턴스가 오래 트래픽을 받습니다.
정답은 없고, **어느 쪽 실패가 더 비싼지**로 고릅니다. 인스턴스가 두 대뿐이라면 민감한 설정의 비용이 훨씬 큽니다.

한 가지는 선택이 아닙니다. **타임아웃은 간격보다 작아야 합니다.** 그러지 않으면 이전 검사가 끝나기 전에 다음 검사가 겹칩니다.

그리고 프로브 기본 타임아웃은 대체로 아주 짧게 잡혀 있습니다(쿠버네티스는 1초).
얕은 `/readyz`라면 충분하지만, 핸들러가 조금이라도 느려지면 그 타임아웃이 먼저 걸립니다. 바꾸든 유지하든 **값을 명시**해두는 편이 낫습니다.

## 헬스체크가 만드는 부수 효과

세 가지는 거의 항상 걸립니다.

**인증과 레이트 리밋 예외.** 헬스체크는 토큰을 들고 오지 않습니다. 전역 미들웨어 뒤에 헬스 경로가 있으면 401이 돌아오고, 대상은 전부 비정상이 됩니다.

**관측 노이즈.** 몇 초마다 들어오는 요청이 액세스 로그와 지연 시간 히스토그램을 채웁니다.
p99가 실제보다 좋아 보이는 것도 여기서 옵니다. 메트릭 라벨에서 헬스 경로를 빼두세요([메트릭 카디널리티와 라벨 설계](/blog/metric-cardinality-label-design/)).

**정보 노출.** `/statusz`는 내부 호스트명, 의존성 이름, 에러 메시지를 그대로 담기 쉽습니다. 외부에 열지 말고, 리스너 규칙이나 네트워크 경계에서 막아두세요.

## 확인하는 법

설정은 대개 "장애가 났을 때 어떻게 동작하는지"를 보기 전까지 검증되지 않습니다. 스테이징에서 네 가지를 봅니다.

```bash
# 1) 세 경로가 각자 다른 답을 하는지
for p in livez readyz statusz; do
  printf '%s -> ' "$p"
  curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' "http://localhost:8080/$p"
done

# 2) 대상 그룹이 실제로 보고 있는 경로 (여기에 statusz가 있으면 안 된다)
aws elbv2 describe-target-groups \
  --query 'TargetGroups[].{Name:TargetGroupName,Path:HealthCheckPath,Interval:HealthCheckIntervalSeconds}' \
  --output table
```

그다음이 중요한 검증입니다. **DB를 끊어보고 `/readyz`가 200을 유지하는지** 확인합니다.
보안 그룹에서 DB 포트를 잠그거나 자격 증명을 틀리게 주고, `/statusz`는 빨간불인데 대상은 그대로 붙어 있는 상태가 나오면 의도대로 된 것입니다.

마지막으로 배포를 한 번 돌려 **재시작 횟수**를 봅니다. 쿠버네티스라면 `kubectl get pods`의 `RESTARTS`, ECS라면 태스크 교체 이력입니다.
배포 때마다 조용히 몇 번씩 재시작되고 있었다면, 부팅 구간과 liveness가 겹쳐 있었다는 뜻입니다.

{% comment %} TODO: 실제 운영에서 헬스체크 설정 때문에 겪은 일이 있다면 이 자리에 사례로 적어주세요 {% endcomment %}

## 정리

- 헬스체크는 **이 인스턴스를 빼면 나아지는가**에만 답한다. 공유 의존성 장애는 여기에 답이 없다.
- `/livez`는 의존성을 보지 않고, `/readyz`는 로컬 상태만 보고, 깊은 진단은 LB에 꽂지 않는 별도 경로로 둔다.
- 모든 대상이 비정상이면 로드밸런서는 fail open 한다. 깊은 체크로 전부 빼는 건 아무 효과가 없고, liveness에 걸려 있으면 전면 재시작만 추가된다.
- 깊은 검사는 타임아웃·캐시·hard/soft 분류 셋을 갖춘 다음에 쓴다.
- 부팅 구간은 시작 프로브나 유예 기간으로 분리하고, 타임아웃은 간격보다 작게 둔다.
- 검증은 의존성을 실제로 끊어보고 대상이 빠지지 **않는지** 확인하는 것으로 끝낸다.
