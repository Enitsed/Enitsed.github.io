---
layout: post
title: "대수는 늘었는데 피크는 이미 지나갔다 — 스케일 아웃이 늦는 구조와 지표 선택"
date: 2026-11-06
tags: [devops, aws, kubernetes, ecs, monitoring]
excerpt: "오토스케일링은 정상 동작했는데 피크 구간에는 타임아웃이 쌓입니다. 관측부터 웜업까지 쌓이는 지연 체인을 구간별로 재는 법, CPU·요청수·큐 백로그 중 무엇을 기준으로 삼을지의 트레이드오프, 그리고 대수를 늘려도 나아지지 않는 경우."
---

트래픽이 몰린 구간에 타임아웃이 쌓였습니다. 그런데 오토스케일링 이력을 열어보면 대수는 제대로 늘어나 있습니다.

둘 다 사실입니다. 늘어난 **시점**이 피크가 끝난 뒤였을 뿐입니다.

이건 설정값을 잘못 넣은 문제가 아니라, 스케일 아웃이 구조적으로 뒤늦게 도착하는 일이라서 그 지연을 먼저 재야 손댈 자리가 보입니다.

## 스케일 아웃은 왜 항상 늦는가

부하가 올라간 순간부터 새 인스턴스가 실제로 요청을 받기까지, 아래 단계가 **순서대로 더해집니다.**

```text
부하 상승
  │  ① 관측      — 지표가 수집되는 주기
  │  ② 집계      — 모니터링 시스템에 들어가 조회 가능해질 때까지
  │  ③ 평가      — 오토스케일러가 지표를 보는 주기, 알람의 연속 위반 조건
  │  ④ 결정      — 목표 대수 계산, 안정화 창(stabilization), 쿨다운
  │  ⑤ 기동      — 컨테이너·노드가 뜨고 이미지를 받는 시간
  │  ⑥ 준비      — readiness 통과, LB 타깃 등록과 health check 통과
  │  ⑦ 웜업      — JIT·커넥션 풀·캐시가 더워질 때까지
  ▼
새 인스턴스가 제 몫을 받기 시작
```

각 단계가 수십 초짜리면 전체는 **분 단위**가 됩니다. 그리고 트래픽 피크가 이보다 짧으면 스케일 아웃은 원리적으로 피크를 못 잡습니다.

여기서 중요한 건 단계마다 **설정이 있는 곳이 다르다**는 점입니다.

| 단계 | 어디서 정해지는가 | 줄일 여지 |
| --- | --- | --- |
| ① 관측 | 메트릭 수집 주기 (에이전트·CloudWatch 해상도) | 해상도를 올리면 비용이 오른다 |
| ② 집계 | 모니터링 백엔드의 반영 지연 | 대개 우리 손 밖 |
| ③ 평가 | 오토스케일러 주기, 알람 연속 위반 횟수 | 줄이면 노이즈에 더 민감해진다 |
| ④ 결정 | 안정화 창·쿨다운·스텝 정책 | 스케일 아웃 쪽만 따로 줄일 수 있다 |
| ⑤ 기동 | 이미지 크기, 노드 여유, 런타임 시작 시간 | 여기가 보통 가장 크고, 가장 많이 줄인다 |
| ⑥ 준비 | readiness·health check 설정 | 과하게 보수적이면 그대로 지연이 된다 |
| ⑦ 웜업 | 애플리케이션 시작 경로 | 사전 웜업으로 옮길 수 있다 |

> ③④의 기본값은 플랫폼과 버전, 클러스터 설정에 따라 다릅니다.
> 숫자를 외워서 계산하지 말고 **본인 환경의 값을 직접 확인하세요.** 쿠버네티스 HPA의 평가 주기와 안정화 창 기본값, ECS/Application Auto Scaling의 쿨다운 기본값은 각 공식 문서에 명시돼 있습니다.

## 어디서 시간을 먹는지 먼저 잰다

추정 대신 타임스탬프 네 개를 모으면 구간이 갈라집니다. **부하 상승 시각 / 알람 전환 시각 / 스케일 활동 시작 시각 / 새 인스턴스가 트래픽을 받기 시작한 시각**입니다.

ECS는 스케일 활동 이력에 시작과 종료가 남습니다.

```bash
aws application-autoscaling describe-scaling-activities \
  --service-namespace ecs \
  --resource-id "service/prod-cluster/api" \
  --max-results 10 \
  --query 'ScalingActivities[].{Start:StartTime,End:EndTime,Cause:Cause,Status:StatusMessage}' \
  --output table
```

`Cause`에는 어떤 알람이 이 활동을 유발했는지가 들어옵니다. 그 알람의 상태 전환 시각을 따로 보면 ①~③ 구간이 드러납니다.

```bash
aws cloudwatch describe-alarm-history \
  --alarm-name "TargetTracking-service/prod-cluster/api-AlarmHigh-..." \
  --history-item-type StateUpdate \
  --query 'AlarmHistoryItems[].{At:Timestamp,Summary:HistorySummary}' \
  --output table
```

쿠버네티스라면 HPA가 판단 근거와 결정 이력을 그대로 보여줍니다.

```bash
kubectl describe hpa api
# Metrics / Events 섹션: 관측값, 목표값, 그리고 언제 몇 개로 바꿨는지

kubectl get events --field-selector involvedObject.name=api \
  --sort-by=.lastTimestamp
```

그다음 ⑤⑥을 봅니다. 파드 생성 시각과 Ready 전환 시각의 차이가 기동+준비 시간입니다.

```bash
kubectl get pods -l app=api \
  -o custom-columns='NAME:.metadata.name,CREATED:.metadata.creationTimestamp,READY:.status.conditions[?(@.type=="Ready")].lastTransitionTime'
```

이 네 숫자를 한 번만 모아보면, 대개 **범인이 한 구간에 몰려 있습니다.** 그 구간이 아닌 곳의 설정을 조정하는 건 효과가 없습니다.

{% comment %} TODO: 실제로 측정한 구간별 시간(관측~알람, 알람~활동 시작, 기동~Ready)을 적어주세요 {% endcomment %}

## 무엇을 기준으로 스케일할 것인가

지연을 줄이는 것과 별개로, **기준 지표가 틀리면 아무리 빨라도 엉뚱한 시점에 움직입니다.**

### CPU 사용률

가장 기본이고, 가장 자주 어긋나는 선택입니다.

CPU가 지표로 작동하려면 **CPU가 그 서비스의 병목**이어야 합니다. 요청 대부분을 DB와 외부 API를 기다리는 데 쓰는 서비스는 포화 상태에서도 CPU가 한가합니다. 큐에 요청이 쌓이고 지연이 올라가는데 사용률은 40%에서 더 오르지 않습니다.

평균이라는 점도 걸립니다. 여러 인스턴스 평균을 보면 한쪽에 쏠린 부하가 희석되고, 한 인스턴스 안에서도 짧은 포화 구간이 평균에 묻힙니다.

### 타깃당 요청 수

ECS의 target tracking은 정의된 지표 중 `ALBRequestCountPerTarget`을 쓸 수 있습니다. 타깃 하나가 받는 분당 요청 수를 목표로 둡니다.

```bash
aws application-autoscaling put-scaling-policy \
  --service-namespace ecs \
  --resource-id "service/prod-cluster/api" \
  --scalable-dimension ecs:service:DesiredCount \
  --policy-name "api-rps-per-target" \
  --policy-type TargetTrackingScaling \
  --target-tracking-scaling-policy-configuration '{
    "TargetValue": 600.0,
    "PredefinedMetricSpecification": {
      "PredefinedMetricType": "ALBRequestCountPerTarget",
      "ResourceLabel": "app/prod-alb/1a2b3c4d5e6f7g8h/targetgroup/api-tg/9i8h7g6f5e4d3c2b"
    },
    "ScaleInCooldown": 300,
    "ScaleOutCooldown": 60
  }'
```

`ResourceLabel`은 로드밸런서 ARN 접미사와 타깃 그룹 ARN 접미사를 이어붙인 형식이고, 이 지표를 쓸 때만 지정합니다. 정책을 걸면 Application Auto Scaling이 필요한 CloudWatch 알람을 알아서 만들고 관리합니다.

이 지표가 CPU보다 나은 건, **부하의 원인에 더 가깝기 때문**입니다. 대신 전제가 있습니다. 요청당 비용이 어느 정도 균일해야 합니다.
가벼운 조회와 무거운 리포트 생성이 같은 타깃 그룹에 섞여 있으면 요청 수는 같아도 실제 부하는 전혀 다릅니다. 이럴 땐 경로를 나누고 타깃 그룹도 나누는 쪽이 지표를 고르는 것보다 먼저입니다.

### 큐 백로그

비동기 워커라면 기준이 분명합니다. 처리해야 할 일이 얼마나 쌓였는지입니다.

주의할 점은 **큐 길이 자체를 목표로 두면 안 된다**는 것입니다. 큐 길이는 워커 수에 비례해 줄어드는 값이 아니라서, 목표값이 대수와 함께 의미가 변합니다. AWS 문서도 이 이유로 **워커 1대당 백로그**를 커스텀 지표로 올려 쓰라고 안내합니다.

```text
워커당 백로그 = 큐에 쌓인 메시지 수 / 실행 중인 워커 수
목표값       = 허용 지연 / 메시지 1건 평균 처리 시간
```

메시지 하나를 평균 0.1초에 처리하고 허용 지연이 10초라면 목표값은 `10 / 0.1 = 100`건입니다. 이렇게 두면 **목표값이 비즈니스 요구(허용 지연)에서 바로 유도됩니다.** CPU 60%라는 숫자에는 이런 근거를 붙이기 어렵습니다.

지표는 직접 올려야 합니다.

```typescript
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs";
import { ECSClient, DescribeServicesCommand } from "@aws-sdk/client-ecs";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const sqs = new SQSClient({});
const ecs = new ECSClient({});
const cw = new CloudWatchClient({});

export async function handler() {
  const attrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: process.env.QUEUE_URL!,
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  );
  const backlog = Number(attrs.Attributes?.ApproximateNumberOfMessages ?? 0);

  const svc = await ecs.send(
    new DescribeServicesCommand({
      cluster: process.env.CLUSTER!,
      services: [process.env.SERVICE!],
    }),
  );
  const running = svc.services?.[0]?.runningCount ?? 0;

  // 0대일 때 0으로 나누지 않도록. 대수가 0이면 백로그 전체를 그대로 올려
  // 0 → 1 스케일 아웃이 걸리게 한다.
  const perTask = running > 0 ? backlog / running : backlog;

  await cw.send(
    new PutMetricDataCommand({
      Namespace: "Custom/Worker",
      MetricData: [
        {
          MetricName: "BacklogPerTask",
          Dimensions: [{ Name: "ServiceName", Value: process.env.SERVICE! }],
          Value: perTask,
          Unit: "Count",
          Timestamp: new Date(),
        },
      ],
    }),
  );
}
```

이 람다를 짧은 주기로 돌리고, 그 지표에 target tracking을 겁니다. 올리는 주기가 곧 ①번 구간의 길이라는 점만 기억하면 됩니다.

쿠버네티스에서 같은 걸 하려면 외부 지표를 HPA에 연결하는 어댑터나 KEDA 같은 도구가 필요합니다. 구성 방식은 도구별로 다르니 해당 문서를 보세요.

### 포화에 가까운 지표

가장 정직한 기준은 **지금 안에서 기다리는 요청이 몇 개인가**입니다. 동시 처리 중인 요청 수, 내부 큐 길이, 커넥션 풀 대기 시간 같은 값입니다.

이 값들은 CPU와 달리 I/O 바운드 서비스에서도 포화를 바로 반영합니다. 대신 애플리케이션이 직접 내보내야 하고, 지표 이름과 라벨 설계를 같이 생각해야 합니다.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api
  minReplicas: 4
  maxReplicas: 40
  metrics:
    - type: Pods
      pods:
        metric:
          name: http_inflight_requests   # 애플리케이션이 내보내는 값
        target:
          type: AverageValue
          averageValue: "30"
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0      # 올릴 때는 주저하지 않는다
      policies:
        - type: Percent
          value: 100
          periodSeconds: 30
    scaleDown:
      stabilizationWindowSeconds: 600    # 내릴 때는 충분히 기다린다
      policies:
        - type: Percent
          value: 10
          periodSeconds: 60
```

핵심은 `behavior`를 **위아래로 비대칭하게** 두는 것입니다. 늦게 올리면 장애가 되고, 성급하게 내리면 다음 파동에서 다시 처음부터 기다립니다. 둘의 비용이 다르니 설정도 달라야 합니다.

## 못 줄이는 지연은 미리 채워둔다

구간을 다 재고 줄여도 분 단위가 남는 경우가 있습니다. 그러면 남은 선택은 **반응을 빠르게 하는 것**이 아니라 **미리 늘려두는 것**입니다.

- **최소 대수를 올린다.** 가장 단순하고 확실하며, 항상 그만큼 비용이 나갑니다.
- **예약 스케일링.** 피크 시각이 반복되는 서비스라면 가장 비용 효율이 좋습니다. 등하원 시간대나 업무 시작 시각처럼 사람의 일과에 묶인 트래픽은 대개 예측 가능합니다.
- **목표값을 낮춘다.** 목표 60%를 40%로 내리면 상시 여유분이 생깁니다. 반응 속도가 아니라 **버틸 수 있는 급증 폭**을 사는 것입니다.
- **노드 여유를 미리 확보한다.** ⑤번이 큰 원인이 노드 증설인 경우, 파드 레벨 스케일링을 빠르게 해도 노드를 기다립니다.

```bash
aws application-autoscaling put-scheduled-action \
  --service-namespace ecs \
  --resource-id "service/prod-cluster/api" \
  --scalable-dimension ecs:service:DesiredCount \
  --scheduled-action-name "weekday-morning-preheat" \
  --schedule "cron(40 7 ? * MON-FRI *)" \
  --timezone "Asia/Seoul" \
  --scalable-target-action "MinCapacity=12,MaxCapacity=40"
```

예약 스케일링은 **목표 대수를 고정하는 게 아니라 최소치를 올리는 쪽**이 안전합니다. 예측이 틀려 더 필요해지면 그때부터는 다시 지표 기반 정책이 받습니다.

{% comment %} TODO: 서비스의 트래픽 패턴이 시간대별로 예측 가능한지, 예약 스케일링과 최소 대수 중 무엇을 쓰고 있는지 적어주세요 {% endcomment %}

## 스케일 인에서 더 자주 다친다

스케일 아웃이 늦으면 지연이 생기고, 스케일 인이 성급하면 **진행 중인 작업이 끊깁니다.** 후자가 더 눈에 안 띄고 더 오래 남습니다.

특히 **지표가 좋아진 원인이 스케일 아웃이었을 때** 문제가 됩니다. 대수를 늘려 사용률이 내려가고, 내려간 사용률을 보고 다시 줄이고, 줄이니 또 올라가는 왕복이 생깁니다. 안정화 창이 이걸 막는 장치입니다.

여러 정책을 겹쳐 쓸 때의 동작도 확인해두는 편이 낫습니다. Application Auto Scaling은 대체로 **스케일 아웃에는 관대하고 스케일 인에는 보수적인** 방향으로 정책들을 종합하지만, 정확한 판정 규칙은 공식 문서에서 확인하세요.

그리고 줄이는 쪽에서는 종료 처리가 전제 조건입니다. 드레이닝과 종료 신호 처리가 제대로 안 돼 있으면, 스케일 인은 그 자체로 오류를 만들어내는 동작이 됩니다.

## 대수를 늘려도 나아지지 않는 것

마지막으로, 오토스케일링이 **해결하지 못하거나 오히려 악화시키는** 경우가 있습니다. 이걸 구분하지 못하면 대수만 늘어나고 지연은 그대로입니다.

- **공유 자원이 상한인 경우.** 인스턴스가 늘면 DB 커넥션 총량도 같이 늘어납니다. DB가 먼저 포화하면 대수를 늘릴수록 전체가 느려집니다. 스케일 상한은 애플리케이션이 아니라 가장 먼저 마르는 공유 자원이 정합니다.
- **하류가 제한을 걸고 있는 경우.** 외부 API 레이트 리밋이 병목이면 호출하는 쪽을 늘려도 처리량은 그대로이고 429만 늘어납니다.
- **락 경합이 병목인 경우.** 같은 행을 두고 경쟁한다면 동시 처리 주체를 늘리는 건 경합을 키우는 선택입니다.
- **요청 하나가 느린 경우.** 단일 요청의 지연은 대수와 무관합니다. 처리량 부족과 지연 과다는 다른 문제이고, 전자만 스케일링으로 풀립니다.

그래서 스케일링 정책을 손대기 전에 질문 하나를 먼저 통과시키는 편이 낫습니다. **지금 부족한 것이 처리량인가, 아니면 한 건의 속도인가.**

## 체크리스트

- [ ] 부하 상승 → 알람 → 스케일 활동 → 트래픽 수신까지 **실제 타임스탬프**를 모아봤는가
- [ ] 그중 가장 긴 구간이 어디인지 알고 있는가
- [ ] 기준 지표가 그 서비스의 실제 병목을 반영하는가 (I/O 바운드인데 CPU를 보고 있지 않은가)
- [ ] 목표값에 근거가 있는가 (허용 지연에서 유도했는가, 관행으로 정했는가)
- [ ] 스케일 아웃과 스케일 인의 반응 속도를 비대칭으로 두었는가
- [ ] 피크 시각이 예측 가능하다면 예약 스케일링을 검토했는가
- [ ] `maxReplicas`까지 늘어났을 때 DB 커넥션 총량이 견디는가
- [ ] 스케일 인이 진행 중인 요청·작업을 끊지 않는가

오토스케일링은 "켜면 알아서 되는 기능"처럼 보이지만, 실제로는 **지표 선택과 지연 예산을 설계하는 일**입니다.

그리고 둘 중 먼저 할 것은 측정입니다. 구간을 재지 않은 상태에서 쿨다운 숫자를 바꾸는 건, 어느 구간이 긴지도 모른 채 가장 만지기 쉬운 값을 만지는 것에 가깝습니다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제 설정과 결과

- 어떤 지표로 바꿨고 목표값을 어떻게 정했는지
- 바꾼 뒤 피크 구간의 지연과 비용이 어떻게 달라졌는지

{% endcomment %}
