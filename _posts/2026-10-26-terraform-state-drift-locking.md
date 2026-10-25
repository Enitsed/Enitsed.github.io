---
layout: post
title: "plan이 멀쩡한 리소스를 지우겠다고 한다 — Terraform state가 실제로 들고 있는 것"
date: 2026-10-26
tags: [devops, terraform, aws, iac]
excerpt: "코드는 그대로인데 plan에 destroy가 찍힙니다. state가 리소스 주소와 실제 자원을 어떻게 묶어두는지, 코드·state·실제 셋을 비교해 계획이 만들어지는 구조, 이름만 바꿨을 뿐인데 재생성이 뜨는 이유와 moved·import·removed로 state를 직접 건드리지 않고 고치는 법, 잠금이 없을 때 state가 덮어써지는 경로, 평문으로 남는 값들, 그리고 state를 어디서 쪼개야 사고 범위가 줄어드는지까지."
---

코드는 어제와 같은데 `terraform plan`이 운영 중인 리소스를 destroy 하겠다고 합니다.
누가 콘솔에서 뭘 만졌나 싶어 들여다봐도 리소스는 멀쩡히 거기 있습니다.

이런 계획이 나오는 이유는 대부분 하나입니다. Terraform이 보는 세계가 셋인데, 그중 하나가 어긋나 있습니다.

## state는 무엇을 들고 있는가

Terraform 코드는 리소스를 `aws_ecs_service.api` 같은 **주소**로 부릅니다. 클라우드에는 그런 이름의 개념이 없습니다. 거기 있는 건 ARN이나 ID뿐입니다.

state 파일이 하는 일은 그 사이를 잇는 것입니다.

```text
코드의 주소                실제 자원
aws_ecs_service.api   ↔   arn:aws:ecs:ap-northeast-2:...:service/prod/api
aws_s3_bucket.assets  ↔   prod-assets-ap-northeast-2
```

이 매핑과 함께, 마지막으로 적용했을 때 각 속성이 어떤 값이었는지도 같이 적혀 있습니다.

왜 굳이 파일로 들고 있어야 하는지는 반대로 생각하면 쉽습니다. state가 없다면 Terraform은 매번 계정 전체를 뒤져서 "내가 만든 게 어느 것인지" 알아내야 합니다.
태그로 추정할 수는 있겠지만 추정입니다. 그리고 추정이 틀리면 남의 리소스를 지웁니다.

그래서 state는 캐시가 아니라 **소유권 장부**에 가깝습니다. 여기 적혀 있는 것만 Terraform이 자기 것으로 취급하고, 적혀 있지 않은 것은 존재하지 않는 셈 칩니다.

## 계획은 셋을 비교해서 만들어진다

`plan`이 보는 것은 세 가지입니다.

- **코드** — 이렇게 되어야 한다 (desired)
- **state** — 마지막에 이렇게 만들었다 (recorded)
- **실제** — 지금 클라우드에 이렇게 있다 (actual)

`plan`은 먼저 실제를 읽어 state를 최신화하고(refresh), 그다음 코드와 비교해 차이를 메울 동작을 고릅니다.
세 자리 중 어디에 있고 없느냐로 결과가 갈립니다.

| 코드 | state | 실제 | plan 결과 |
| --- | --- | --- | --- |
| O | X | X | create |
| O | O | O | 속성이 같으면 no-op, 다르면 update 또는 replace |
| X | O | O | **destroy** |
| O | O | X | create (누군가 콘솔에서 지웠다) |
| O | X | O | create 시도 → 이미 있다며 실패 |

서두의 증상은 세 번째 줄입니다. 리소스는 실제로 있고 state에도 있는데 **코드에서 사라진** 상태입니다.
브랜치를 잘못 잡았거나, 모듈 호출을 지웠거나, `count`/`for_each`에 넘기는 값이 줄어든 경우입니다.

마지막 줄도 자주 봅니다. 콘솔에서 급하게 만든 리소스를 나중에 코드로 옮겨 적었을 때 나오는 모습입니다. 이건 뒤에서 `import`로 풉니다.

무엇이 원인인지 가를 때 가장 먼저 보는 건 state에 실제로 뭐가 들어 있는지입니다.

```bash
terraform state list | grep ecs
terraform state show aws_ecs_service.api
```

## 콘솔에서 고친 것 — 드리프트

장애 중에 콘솔에서 태스크 수를 올리는 일은 생깁니다. 급할 때는 그게 맞습니다.
문제는 그다음 `apply`가 그걸 **원래대로 되돌린다**는 점입니다. 코드에는 옛 값이 적혀 있으니까요.

지금 어긋난 게 있는지만 확인하려면 계획을 갱신 전용으로 돌립니다.

```bash
terraform plan -refresh-only
```

이건 "코드대로 맞추겠다"가 아니라 "실제가 state와 다른 곳이 여기다"만 보여줍니다. 코드를 고치기 전에 현황을 파악할 때 씁니다.

되돌리는 게 맞는 드리프트도 있고, 되돌리면 안 되는 드리프트도 있습니다. 후자는 **Terraform 밖의 주체가 정당하게 바꾸는 값**입니다.

오토스케일링이 조정하는 태스크 수가 대표적입니다. 코드에 `desired_count = 2`를 적어두면 배포할 때마다 스케일이 2로 깎입니다.

```hcl
resource "aws_ecs_service" "api" {
  name            = "api"
  desired_count   = 2   # 최초 생성 시에만 의미가 있다

  lifecycle {
    ignore_changes = [desired_count]
  }
}
```

`ignore_changes`는 "이 속성의 차이는 계획에 넣지 말라"는 뜻입니다. 소유권을 부분적으로 넘기는 선언입니다.

> `ignore_changes`를 넓게 거는 것은 대가가 있습니다. 그 속성은 이제 코드가 사실을 말하지 않습니다.
> 코드를 읽고 운영 상태를 짐작하던 사람이 틀리게 됩니다. 꼭 필요한 속성만, 이유를 주석으로 남기고 거는 편이 낫습니다.

지워지면 곤란한 리소스에는 방어선을 하나 더 둡니다.

```hcl
resource "aws_db_instance" "main" {
  # ...
  lifecycle {
    prevent_destroy = true
  }
}
```

이게 걸려 있으면 destroy가 포함된 계획은 apply 단계가 아니라 **계획 단계에서 실패합니다.** 실수로 모듈을 지웠을 때 DB가 같이 날아가는 경로를 막아줍니다.

{% comment %} TODO: 실제로 드리프트 때문에 겪은 일이 있다면 적어주세요. 어떤 속성이었고 ignore_changes로 넘겼는지, 아니면 코드를 고쳤는지 {% endcomment %}

## 이름만 바꿨는데 재생성이 뜬다

리팩터링하다 `aws_ecs_service.api`를 `module.api.aws_ecs_service.this`로 옮기면 plan은 이렇게 나옵니다.

```text
# aws_ecs_service.api will be destroyed
# module.api.aws_ecs_service.this will be created
```

Terraform 입장에서는 당연합니다. 주소가 장부의 열쇠인데 옛 주소는 코드에서 사라졌고 새 주소는 state에 없습니다. 둘이 같은 것이라는 사실은 사람만 압니다.

예전에는 이걸 `terraform state mv`로 처리했습니다. 동작은 하지만 **그 사실이 코드에 남지 않습니다.** 누군가 로컬에서 명령을 쳤다는 것을 리뷰에서 확인할 방법이 없고, 다른 사람의 CI에서는 그 명령이 돌지 않습니다.

`moved` 블록은 같은 일을 코드로 적습니다.

```hcl
moved {
  from = aws_ecs_service.api
  to   = module.api.aws_ecs_service.this
}
```

이러면 plan에 destroy 대신 이름이 바뀐다는 내용이 나옵니다. 리뷰에서 보이고, 머지되면 모두의 환경에서 같은 결과가 나옵니다.

`for_each` 키를 바꿀 때도 같습니다. 인덱스 기반 `count`를 쓰다 중간 요소를 빼면 뒤쪽이 전부 한 칸씩 밀려 재생성됩니다.
목록 순서가 바뀔 수 있는 자원이라면 처음부터 `count`보다 **안정적인 키를 쓰는 `for_each`** 가 안전합니다.

> `moved`·`import`·`removed` 블록은 각각 도입된 버전이 다릅니다. 지금 쓰는 버전에서 지원하는지 공식 문서에서 확인하고 쓰세요.

## 이미 있는 것을 편입하기 — import

콘솔로 만든 리소스를 코드로 가져올 때, 코드만 적고 apply 하면 "이미 존재한다"며 실패합니다. 코드와 실제는 있는데 state에 매핑이 없는 상태입니다.

`import` 블록은 이 매핑을 만듭니다.

```hcl
import {
  to = aws_s3_bucket.legacy_assets
  id = "legacy-assets-prod"
}

resource "aws_s3_bucket" "legacy_assets" {
  bucket = "legacy-assets-prod"
}
```

CLI의 `terraform import`와 달리 이건 **plan으로 먼저 확인할 수 있습니다.** 무엇이 편입되고, 편입 후 어떤 변경이 생길지가 apply 전에 보입니다.

여기서 중요한 건 편입 자체가 아니라 그다음입니다. 손으로 만든 리소스는 콘솔 기본값이 잔뜩 붙어 있고, 코드에 그걸 다 적지 않으면 plan이 그 차이를 전부 바꾸겠다고 합니다.

> 편입에 성공했다는 기준은 **plan이 비는 것**입니다. `Import complete`만 보고 넘어가면, 다음 사람이 무심코 돌린 apply가 암호화 설정이나 수명주기 규칙을 날립니다.

속성이 많아 손으로 적기 벅차면 설정을 뽑아낼 수 있습니다.

```bash
terraform plan -generate-config-out=generated.tf
```

나온 파일은 초안입니다. 읽을 수 있게 정리하고, 하드코딩된 값을 변수로 바꾼 다음에 쓰세요. 그대로 커밋하면 사람이 읽을 수 없는 코드가 늘어납니다.

## 지우지 않고 손만 떼기 — removed

관리에서 빼고 싶지만 리소스는 남겨야 할 때가 있습니다. 다른 팀에 넘기거나, 다른 state로 옮기는 경우입니다.

코드에서 블록만 지우면 destroy가 됩니다. `terraform state rm`을 쓰면 안 지워지지만, 앞서와 같은 이유로 흔적이 남지 않습니다.

```hcl
removed {
  from = aws_s3_bucket.legacy_assets

  lifecycle {
    destroy = false
  }
}
```

`destroy = false`가 "장부에서만 빼고 실물은 두라"는 부분입니다. 이걸 빠뜨리면 평범한 삭제가 됩니다.

## 잠금이 없으면 state가 덮어써진다

state를 로컬 파일로 두면 혼자 쓸 때는 잘 돌아가고, 두 번째 사람이 합류하는 날 깨집니다. 각자의 장부가 서로 다른 사실을 기록하기 시작합니다.

원격 백엔드로 옮기면 장부는 한 곳이 됩니다.

```hcl
terraform {
  backend "s3" {
    bucket       = "myorg-tfstate"
    key          = "prod/network/terraform.tfstate"
    region       = "ap-northeast-2"
    encrypt      = true
    use_lockfile = true
  }
}
```

공유만으로는 부족합니다. 두 사람이 동시에 apply 하면 이런 일이 생깁니다.

1. A와 B가 같은 state를 읽는다
2. A가 apply 해서 리소스를 만들고 state를 쓴다
3. B가 **A의 변경을 모르는 채로** 자기 state를 쓴다
4. A가 만든 리소스는 실물로 남았는데 장부에서 사라진다

4번이 고약합니다. 리소스는 살아서 비용을 쓰는데 Terraform은 그 존재를 모릅니다. 다음 plan은 같은 것을 또 만들려 하거나, 이름 충돌로 실패합니다.

그래서 잠금이 필요합니다. 위 설정의 `use_lockfile = true`가 S3에 잠금 파일을 두고 동시 실행을 막는 옵션입니다. 먼저 잡은 쪽이 끝날 때까지 다른 실행은 기다립니다.

> 과거에는 이 잠금을 DynamoDB 테이블로 구성했습니다. 현재 S3 백엔드 문서에서는 DynamoDB 기반 잠금을 **더 이상 권장하지 않고 향후 제거 예정**이라고 안내합니다.
> 기존 구성을 옮길 때의 절차와 필요한 IAM 권한은 현행 공식 문서를 확인하세요.

버킷 **버저닝은 반드시 켭니다.** 이건 잠금과 별개 문제입니다. state가 깨졌을 때 되돌릴 수 있는 유일한 수단이고, 켜는 비용은 사실상 없습니다.

## state에는 평문이 들어간다

RDS 비밀번호를 변수로 넘기면 그 값은 state에 **평문으로 저장됩니다.** 리소스의 민감한 속성도 마찬가지입니다.

출력에 `sensitive = true`를 붙이면 콘솔 출력에서만 가려집니다. state 파일 안의 값은 그대로입니다.

```hcl
output "db_password" {
  value     = aws_db_instance.main.password
  sensitive = true   # 화면에 안 보일 뿐, state에는 남는다
}
```

그래서 state 파일 자체를 비밀로 다뤄야 합니다.

- 저장 시 암호화를 켜고(`encrypt = true`), 가능하면 KMS 키를 지정합니다
- state 버킷 접근 권한을 사람이 아니라 **CI 역할 중심**으로 좁힙니다. 읽기 권한이 곧 자격증명 열람 권한입니다
- state 파일을 로컬로 내려받아 디버깅했다면 끝나고 지웁니다
- 애초에 비밀번호를 Terraform으로 넘기지 않는 방법을 먼저 봅니다. 자격증명을 시크릿 매니저에서 만들게 하고, Terraform은 그 참조만 다루는 구조면 평문이 state에 들어갈 일이 줄어듭니다

## state를 어디서 쪼갤 것인가

처음에는 전부 한 state에 담는 게 편합니다. 커지면 두 가지가 같이 나빠집니다.

**plan이 느려집니다.** refresh는 state에 든 리소스를 전부 조회하므로 수백 개가 되면 계획 한 번에 몇 분이 걸립니다. 느려지면 사람들이 plan을 건너뛰기 시작하고, 그게 더 큰 문제입니다.

**사고 범위가 커집니다.** 보안 그룹 규칙 하나 고치는 apply가 DB와 VPC를 같은 장부 위에서 건드립니다. 잠금도 전체 단위로 걸려서, 한 사람이 apply 하는 동안 다른 작업이 전부 막힙니다.

쪼개는 기준으로 쓸 만한 것은 **변경 주기**와 **권한 경계**입니다.

| 경계 | 예 | 변경 빈도 |
| --- | --- | --- |
| 네트워크 | VPC, 서브넷, NAT | 거의 없음 |
| 데이터 | RDS, ElastiCache | 드묾 |
| 애플리케이션 | ECS 서비스, ALB 규칙 | 잦음 |

하루에도 몇 번 바뀌는 것과 1년에 한 번 바뀌는 것을 같은 state에 두면, 자주 바뀌는 쪽 때문에 안 바뀌는 쪽이 계속 위험에 노출됩니다.

다만 쪼개면 참조가 경계를 넘습니다. 애플리케이션 쪽에서 VPC ID가 필요하면 다른 state를 읽거나, 태그·이름으로 조회하거나, 파라미터 스토어 같은 곳을 거쳐야 합니다.

```hcl
# 다른 state를 직접 읽는 방식 — 가장 직관적이지만 결합이 생긴다
data "terraform_remote_state" "network" {
  backend = "s3"
  config = {
    bucket = "myorg-tfstate"
    key    = "prod/network/terraform.tfstate"
    region = "ap-northeast-2"
  }
}
```

이 방식은 읽는 쪽이 **상대 state의 내부 구조와 저장 위치에 의존**하게 만듭니다. 네트워크 쪽에서 출력 이름을 바꾸면 애플리케이션 쪽이 깨집니다.
의존 방향이 한쪽으로만 흐르게 두고(애플리케이션 → 네트워크), 반대 방향 참조가 생기면 경계를 잘못 그은 신호로 보는 편이 낫습니다.

쪼개는 수를 늘릴수록 경계 비용도 늘어납니다. 처음부터 잘게 나누기보다, plan 시간이 불편해지거나 권한을 분리해야 할 이유가 생겼을 때 나누는 쪽이 현실적입니다.

{% comment %} TODO: 실제로 운영하는 state 구성(몇 개로 쪼갰는지, 기준이 무엇이었는지)을 적어주세요 {% endcomment %}

## CI에서 돌릴 때

사람이 로컬에서 apply 하는 동안에는 눈으로 계획을 보고 판단합니다. CI에서는 그 판단을 구조로 만들어야 합니다.

핵심은 **plan 결과를 파일로 고정해 그 파일을 apply 하는 것**입니다.

```bash
terraform plan -out=tfplan -lock-timeout=5m
# 사람이 검토하고 승인
terraform apply -lock-timeout=5m tfplan
```

`plan`과 `apply`를 따로 돌리면 그 사이에 누군가 코드를 머지하거나 콘솔을 만질 수 있습니다. 그러면 승인한 계획과 실제로 적용되는 계획이 달라집니다.
저장한 계획 파일을 적용하면 "검토한 그것"이 적용됩니다. 그사이 state가 바뀌었다면 apply는 그냥 실패합니다. 실패하는 게 맞습니다.

`-lock-timeout`도 같이 둡니다. 없으면 잠금이 잡혀 있을 때 즉시 실패하고, 파이프라인 재실행이 늘어납니다.

> 계획 파일에는 변경될 값이 **평문으로 들어갑니다.** 빌드 아티팩트로 오래 보관하거나 접근 제한 없는 곳에 올리지 마세요. state 파일과 같은 수준으로 다뤄야 합니다.

잠금이 비정상 종료로 남았을 때 쓰는 `force-unlock`은 **사람이 상황을 확인한 뒤에만** 씁니다. 파이프라인에 자동으로 넣으면, 정상적으로 돌고 있는 다른 apply의 잠금을 풀어버립니다.

## 정리

- plan은 코드·state·실제 셋을 비교합니다. 이상한 계획이 나오면 셋 중 무엇이 어긋났는지부터 가릅니다
- destroy가 뜨면 대개 코드에서 사라졌거나 주소가 바뀐 것입니다. 실물이 사라진 게 아닙니다
- 주소를 바꿀 땐 `moved`, 편입은 `import`, 관리 해제는 `removed` — 손으로 `state mv`·`state rm` 하지 않습니다. 코드에 남아야 리뷰되고 재현됩니다
- 원격 백엔드 + 잠금 + 버저닝은 셋이 한 묶음입니다. 하나라도 빠지면 장부가 깨질 길이 남습니다
- state는 비밀을 담고 있습니다. 접근 권한을 자격증명 수준으로 다룹니다
- state 분리는 변경 주기와 권한 경계로, 필요해졌을 때 나눕니다
- CI에서는 저장한 계획 파일을 적용합니다. 승인한 것과 적용되는 것이 같아야 합니다

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- state가 꼬였을 때 어떻게 복구했는지
- 쪼개는 기준을 실제로 어떻게 잡았는지

{% endcomment %}
