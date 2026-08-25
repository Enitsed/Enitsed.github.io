---
layout: post
title: "EKS에서 ECS로 무중단 전환하기"
date: 2026-08-15
tags: [devops, aws, ecs, kubernetes]
excerpt: "쿠버네티스(EKS)로 운영하던 서비스를 ECS로 옮기는 절차 정리. 리소스 매핑, 태스크 정의 작성, ALB 가중치 라우팅으로 무중단 이전하기."
---

쿠버네티스와 ECS 중 무엇이 나은가는 이 글의 주제가 아닙니다.
이미 EKS 위에 서비스가 올라가 있고, 그걸 안 끊기게 옮겨야 하는 상황을 다룹니다.

## 언제 ECS가 더 맞는가

판단 기준은 대체로 세 가지로 좁혀집니다.

첫째는 컨트롤플레인 고정 비용입니다. EKS는 클러스터가 떠 있기만 해도 시간 단위 고정 요금이 붙습니다.
ECS는 컨트롤플레인 요금이 없고 태스크가 쓰는 컴퓨트(Fargate 또는 EC2)에만 과금됩니다.
워크로드가 작을수록 이 고정비가 전체에서 차지하는 비중이 커집니다.
(정확한 단가는 리전마다 다르니 EKS/ECS 요금 페이지를 직접 확인하세요.)

둘째는 업그레이드 주기입니다. 쿠버네티스 마이너 버전은 정해진 기간만 표준 지원을 받고, 그 뒤에는 연장 지원 구간으로 넘어가면서 추가 과금이 붙습니다.
즉 EKS를 쓰는 한 클러스터 업그레이드는 사라지지 않는 반복 업무이고, 애드온(CNI, CoreDNS, kube-proxy) 호환 버전까지 같이 맞춰야 합니다.
ECS에는 이 주기 자체가 없습니다.

셋째는 팀 규모 대비 운영 부담입니다. 인그레스 컨트롤러, cluster-autoscaler 또는 Karpenter, 시크릿 연동, RBAC까지 결국 누군가 계속 봐야 합니다.
전담 인프라 인원이 없다면 이 표면적을 줄이는 쪽이 낫습니다.

### 반대로 EKS가 유리한 경우

- 멀티 클라우드/온프레미스와 매니페스트를 공유해야 할 때
- Operator, CRD, 서비스 메시(Istio, Linkerd) 같은 쿠버네티스 생태계에 이미 깊게 의존할 때
- Helm 기반 배포 자산과 사내 표준이 이미 쌓여 있을 때
- GPU 스케줄링, 노드 어피니티, 토폴로지 분산 같은 세밀한 스케줄링이 필요할 때

ECS의 스케줄링 표현력은 쿠버네티스보다 확실히 좁습니다.
위 항목 중 하나라도 강하게 걸린다면 전환 비용이 절감분을 넘길 수 있습니다.

<!-- TODO: 실제로 어떤 이유로 EKS에서 ECS로 전환하기로 결정했는지, 그리고 팀 내부에서 어떤 논의가 있었는지 적어주세요 -->

<!-- TODO: 전환 후 실제 인프라 비용 절감 수치(금액 또는 비율)를 채워주세요 -->

## 리소스 매핑

먼저 기존 매니페스트를 훑으면서 대응표를 만들어두면 이후 작업이 단순 반복이 됩니다.

| 쿠버네티스 | ECS |
| --- | --- |
| Deployment | Service + Task Definition |
| Pod | Task |
| Service (ClusterIP) | Cloud Map 기반 Service Discovery |
| Service (LoadBalancer) | ALB/NLB Target Group |
| Ingress | ALB Listener Rule |
| ConfigMap | 컨테이너 `environment` 또는 SSM Parameter Store |
| Secret | `secrets` + Secrets Manager / SSM SecureString |
| HPA | Service Auto Scaling (Application Auto Scaling) |
| DaemonSet | 스케줄링 전략 `DAEMON` (EC2 시작 유형 전용) |
| CronJob | EventBridge Scheduler → ECS `RunTask` |
| ServiceAccount (IRSA) | Task Role |
| resources.requests/limits | 태스크·컨테이너의 `cpu` / `memory` |

주의할 지점이 몇 개 있습니다.
`DAEMON` 전략은 Fargate에서 못 씁니다. 노드마다 하나씩 띄우는 로그 수집기 같은 게 있다면 EC2 시작 유형이 필요하거나, 아예 다른 방식으로 대체해야 합니다.
그리고 쿠버네티스의 `requests`/`limits`와 달리 ECS 태스크의 `cpu`/`memory`는 사실상 예약값에 가깝습니다. 오버커밋을 전제로 리소스를 잡아뒀다면 그대로 옮기면 안 됩니다.

## 태스크 정의 작성

Deployment 하나가 태스크 정의 하나로 내려온다고 보면 됩니다.

```json
{
  "family": "api",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "executionRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/api-task-role",
  "containerDefinitions": [
    {
      "name": "api",
      "image": "<account-id>.dkr.ecr.ap-northeast-2.amazonaws.com/api:latest",
      "essential": true,
      "portMappings": [
        { "containerPort": 3000, "protocol": "tcp" }
      ],
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "PORT", "value": "3000" }
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:ap-northeast-2:<account-id>:secret:prod/api-AbCdEf"
        },
        {
          "name": "REDIS_URL",
          "valueFrom": "arn:aws:ssm:ap-northeast-2:<account-id>:parameter/prod/api/redis-url"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/api",
          "awslogs-region": "ap-northeast-2",
          "awslogs-stream-prefix": "ecs"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

몇 가지 짚어둘 점입니다.

- `executionRoleArn`은 ECS 에이전트가 이미지를 당기고 시크릿을 읽고 로그를 쓰는 데 쓰는 역할입니다. `taskRoleArn`은 애플리케이션 코드가 AWS API를 호출할 때 쓰는 역할이고요. IRSA로 파드에 붙여뒀던 권한은 후자로 옮깁니다.
- `secrets[].valueFrom`에는 Secrets Manager 시크릿 ARN이나 SSM 파라미터 ARN을 넣습니다. 값은 컨테이너 시작 시 환경변수로 주입되고 태스크 정의에는 남지 않습니다. JSON 시크릿의 특정 키만 꺼내려면 ARN 뒤에 `:키이름::` 형식을 붙일 수 있습니다.
- `logConfiguration`의 로그 그룹은 자동 생성되지 않습니다. 미리 만들어두지 않으면 태스크가 시작 단계에서 실패합니다.
- 컨테이너 `healthCheck`는 이미지 안에 해당 명령(위 예제라면 `curl`)이 있어야 동작합니다. distroless 계열이라면 이 블록을 빼고 ALB 헬스체크에만 의존해야 합니다.
- Fargate는 `cpu`/`memory` 조합이 정해져 있습니다. 값은 공식 문서의 조합표에서 확인하세요.

### Fargate와 EC2 중 무엇을 쓸까

Fargate는 노드 관리가 없어 대부분의 웹 API에 무난합니다. AMI 패치도, 노드 오토스케일러도 필요 없습니다.
EC2 시작 유형은 이런 경우에 고릅니다.

- `DAEMON` 스케줄링이 필요할 때
- GPU나 특수 인스턴스 타입이 필요할 때
- Savings Plans / 스팟으로 컴퓨트 단가를 더 눌러야 할 때
- 컨테이너 밀도를 높여 인스턴스를 알뜰하게 채워야 할 때

## 무중단 전환 절차

핵심은 **ALB를 유지한 채 그 뒤의 타깃만 바꾸는 것**입니다.
DNS를 바꾸면 TTL과 클라이언트 캐시 때문에 전환 시점을 통제할 수 없습니다. ALB 리스너 규칙의 가중치를 조절하면 초 단위로 비율을 옮기고 되돌릴 수 있습니다.

절차는 이렇습니다.

1. 기존 EKS용 타깃 그룹(`tg-eks`)은 그대로 둔다.
2. 같은 VPC에 ECS 서비스를 띄우고 새 타깃 그룹(`tg-ecs`)에 등록한다. 이때 가중치는 0이라 실트래픽은 아직 안 간다.
3. 리스너 규칙을 가중치 기반 forward로 바꾼다.
4. 0 → 5 → 25 → 50 → 100 순으로 올리며 각 단계에서 지표를 확인한다.
5. 100%가 안정되면 EKS 디플로이먼트를 0으로 줄이고, 며칠 뒤 클러스터를 정리한다.

가중치 규칙은 이렇게 겁니다.

```bash
aws elbv2 modify-rule \
  --rule-arn "$RULE_ARN" \
  --actions '[
    {
      "Type": "forward",
      "ForwardConfig": {
        "TargetGroups": [
          { "TargetGroupArn": "'"$TG_EKS"'", "Weight": 95 },
          { "TargetGroupArn": "'"$TG_ECS"'", "Weight": 5 }
        ],
        "TargetGroupStickinessConfig": { "Enabled": false }
      }
    }
  ]'
```

가중치는 절대값이 아니라 비율입니다. `95`/`5`든 `19`/`1`이든 결과는 같습니다.
세션 고정이 필요하면 `TargetGroupStickinessConfig`를 켜고 `DurationSeconds`를 주면 되는데, 그만큼 이전 속도가 느려지고 두 스택 사이에 사용자가 묶이게 되니 스테이트리스 서비스라면 끄는 편이 단순합니다.

### 헬스체크와 드레이닝

가중치를 올리기 전에 두 가지를 맞춰둡니다.

```bash
# 연결 드레이닝 시간 (기본 300초)
aws elbv2 modify-target-group-attributes \
  --target-group-arn "$TG_ECS" \
  --attributes Key=deregistration_delay.timeout_seconds,Value=30
```

`deregistration_delay.timeout_seconds`는 타깃을 뺄 때 진행 중인 요청을 기다려주는 시간입니다.
기본값 300초는 롤링 배포를 매우 느리게 만듭니다. 요청이 짧은 API라면 30초 정도로 줄이되, 애플리케이션이 SIGTERM을 받고 그 안에 그레이스풀 셧다운을 끝내는지 먼저 확인하세요.

서비스 쪽에는 헬스체크 유예 시간을 줍니다.

```bash
aws ecs update-service \
  --cluster prod \
  --service api \
  --health-check-grace-period-seconds 90
```

`healthCheckGracePeriodSeconds`는 태스크가 뜬 뒤 ALB 헬스체크 실패를 무시해주는 구간입니다.
부팅에 시간이 걸리는 애플리케이션에서 이 값이 짧으면, 준비도 되기 전에 언헬시 판정을 받고 죽었다 뜨는 루프에 빠집니다. 컨테이너의 `startPeriod`와 함께 실제 콜드 스타트 시간보다 넉넉하게 잡아야 합니다.

### 롤백 조건

가중치를 올리기 전에 되돌릴 기준을 먼저 정해두는 편이 낫습니다. 보통 이런 것들을 봅니다.

- ECS 타깃 그룹의 `HTTPCode_Target_5XX_Count`가 EKS 쪽 대비 유의미하게 높은지
- `TargetResponseTime` p95/p99가 나빠졌는지
- `UnHealthyHostCount`가 0이 아닌 상태로 유지되는지
- 애플리케이션 에러 로그 발생률

롤백은 가중치를 원래대로 되돌리는 API 호출 하나면 끝납니다. 그래서 DNS 전환보다 이 방식이 안전합니다.

## 배포 파이프라인 교체

`kubectl apply` 자리에 태스크 정의 갱신 + 서비스 업데이트가 들어갑니다.

```yaml
name: deploy

on:
  push:
    branches: [main]

permissions:
  id-token: write
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<account-id>:role/github-actions-deploy
          aws-region: ap-northeast-2

      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
          TAG: ${{ github.sha }}
        run: |
          docker build -t "$REGISTRY/api:$TAG" .
          docker push "$REGISTRY/api:$TAG"

      - id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: .aws/task-definition.json
          container-name: api
          image: ${{ steps.ecr.outputs.registry }}/api:${{ github.sha }}

      - uses: aws-actions/amazon-ecs-deploy-task-definition@v1
        with:
          task-definition: ${{ steps.taskdef.outputs.task-definition }}
          cluster: prod
          service: api
          wait-for-service-stability: true
```

(액션 버전 태그는 각 저장소의 최신 릴리스를 확인하고 고정하세요.)

`render-task-definition`은 커밋해둔 태스크 정의 JSON에서 이미지만 갈아끼운 파일을 만들고, `deploy-task-definition`이 그 파일을 새 리비전으로 등록한 뒤 서비스를 업데이트합니다.
`wait-for-service-stability: true`를 주면 서비스가 안정 상태가 될 때까지 잡이 기다리므로 배포 실패가 파이프라인에서 드러납니다.

CLI로 직접 하면 이렇게 됩니다.

```bash
aws ecs register-task-definition --cli-input-json file://.aws/task-definition.json
aws ecs update-service --cluster prod --service api --task-definition api --force-new-deployment
aws ecs wait services-stable --cluster prod --services api
```

### 롤링과 블루/그린

기본 배포 컨트롤러(`ECS`)는 롤링 업데이트입니다. `minimumHealthyPercent`와 `maximumPercent`로 교체 중 유지할 태스크 수를 조절합니다.
예를 들어 `100`/`200`이면 새 태스크를 먼저 다 띄운 뒤 기존 것을 내려서 용량이 줄지 않습니다. 대신 순간 리소스가 두 배로 듭니다.

`CODE_DEPLOY` 컨트롤러를 쓰면 블루/그린이 됩니다. 타깃 그룹 두 개와 리스너를 미리 준비해야 하지만, 트래픽 전환이 한 번에 일어나고 문제 시 이전 태스크셋으로 즉시 되돌릴 수 있습니다. 카나리·선형 전환 설정과 알람 기반 자동 롤백도 붙습니다.
운영 부담을 줄이려고 ECS로 왔다면 우선 롤링으로 시작하고, 실제로 롤백 속도가 문제가 될 때 블루/그린을 붙이는 순서가 무난합니다.

## 전환 후 확인할 것

**여기서 놓치면 관측이 통째로 비는 지점이 셋 있습니다.** 먼저 로그 경로가 바뀝니다. Fluent Bit이 파드 로그를 긁어가던 구조에서 `awslogs` 드라이버가 CloudWatch Logs로 직접 보내는 구조가 됩니다. 로그 그룹 이름과 보존 기간을 정하고, 로그를 참조하던 대시보드와 쿼리를 다시 걸어야 합니다. 기존 수집기를 계속 쓰고 싶다면 FireLens로 우회하는 방법도 있습니다.

메트릭 이름도 바뀝니다. Prometheus가 kubelet/cAdvisor에서 긁던 컨테이너 메트릭이 사라집니다. Container Insights로 CloudWatch에 모으든지, ADOT 사이드카를 붙여 기존 Prometheus로 계속 보내든지 정해야 합니다. Grafana 대시보드의 쿼리와 알람은 어느 쪽이든 다시 써야 합니다.

마지막으로 오토스케일링 임계값을 다시 잡아야 합니다. HPA 설정을 그대로 옮기면 안 됩니다. 태스크당 할당된 vCPU가 파드 리밋과 다르면 같은 부하에서도 CPU 사용률 수치가 다르게 나옵니다.

```bash
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/prod/api \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 --max-capacity 20
```

타깃 트래킹 정책은 `ECSServiceAverageCPUUtilization`이나 `ALBRequestCountPerTarget`을 씁니다.
후자가 요청량 기반이라 트래픽 패턴을 더 직접적으로 따라갑니다.
스케일아웃 지연은 Fargate 태스크 기동 시간에 콜드 스타트까지 더해지므로, 임계값은 기존 HPA보다 여유 있게 잡는 편이 안전합니다.

<!-- TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 전환 중 실제로 겪은 문제와 해결 과정
- 전환 작업에 실제로 걸린 기간과 트래픽 규모

-->
