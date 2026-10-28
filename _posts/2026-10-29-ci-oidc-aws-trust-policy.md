---
layout: post
title: "액세스 키는 지웠는데 역할은 아무나 수임할 수 있다 — CI OIDC 신뢰 정책"
date: 2026-10-29
tags: [devops, aws, cicd, security, github]
excerpt: "CI에서 장기 액세스 키를 걷어내는 작업은 반나절이면 끝나지만, 무엇이 안전해졌는지는 신뢰 정책에 적힌 조건 몇 줄이 정합니다. sub 클레임이 트리거마다 달라지는 방식, 와일드카드가 열어주는 범위, 환경 기준으로 묶는 이유, 레포 이름 기반 문자열이 조용히 깨지는 지점, OIDC로도 막지 못하는 것, 그리고 GitLab CI에서 같은 구조를 세우는 법까지."
---

CI에서 AWS 액세스 키를 걷어내는 작업은 대체로 반나절이면 끝납니다. OIDC 공급자를 만들고, 역할을 만들고, 배포가 도는 걸 확인하고, 레포 시크릿에서 키를 지웁니다.

그런데 이 작업으로 실제로 무엇이 안전해졌는지는 코드가 아니라 **신뢰 정책에 적힌 조건 몇 줄**이 정합니다.
그 줄이 느슨하면, 지운 키 자리에 "깃허브에서 워크플로를 돌릴 수 있는 사람 아무나"가 들어와 앉습니다.

## 장기 키가 실제로 무엇이 문제인가

"키가 유출되면 위험하다"는 말은 너무 당연해서 아무것도 설명해주지 않습니다. 운영에서 실제로 아픈 건 다른 지점입니다.

**만료가 없습니다.** 2년 전에 만든 키가 지금도 유효하고, 그동안 누가 어디에 복사해 갔는지 알 방법이 없습니다. 레포 시크릿, 로컬 `.env`, 누군가의 메모, 지금은 쓰지 않는 CI 설정.

**회전이 배포입니다.** 새 키를 만들고, 쓰는 곳을 전부 찾아 바꾸고, 옛 키를 지웁니다. 하나라도 놓치면 배포가 깨지니 자연스럽게 미루게 되고, 미룬 키는 계속 삽니다.

**노출과 발각 사이가 깁니다.** 키 자체에는 "어디서 쓰였는가"가 안 적혀 있어서, CloudTrail을 뒤져 IP와 시각을 보기 전까지는 정상 사용과 구분되지 않습니다.

OIDC는 이 셋을 같은 방식으로 없앱니다. **저장된 비밀을 검증 가능한 주장으로 바꿉니다.**

## 토큰 교환이 하는 일

```text
워크플로 잡 ──(1) id_token 요청 ────────▶ CI 제공자의 OIDC 공급자
            ◀─(2) 서명된 JWT (iss, aud, sub, ...)

            ──(3) AssumeRoleWithWebIdentity(JWT) ──▶ AWS STS
            ◀─(4) 수명 짧은 임시 자격증명
```

핵심은 세 가지입니다. 저장해둘 비밀이 없고, 자격증명은 실행마다 새로 발급되며, 수명이 짧습니다.

AWS 쪽에서 보면 이렇게 됩니다. 신뢰할 외부 신원 공급자를 하나 등록해두고, 그 공급자가 서명한 토큰을 가져오는 요청에 한해 역할을 내줍니다.
서명 검증은 AWS가 공급자의 공개키로 알아서 합니다. 우리가 정해야 하는 건 그다음입니다. **그 공급자가 서명한 토큰 중에서 어떤 것을 받아줄 것인가.**

> OIDC 공급자를 등록할 때의 지문(thumbprint) 관련 절차는 공급자별로 바뀐 적이 있습니다. 등록 단계는 현행 공식 문서를 보고 따라가세요. 이 글이 다루는 건 그다음 단계인 신뢰 정책입니다.

## 신뢰 정책이 유일한 문지기

IAM 역할에는 성격이 다른 정책 두 개가 붙습니다.

| | 정하는 것 | OIDC에서의 무게 |
| --- | --- | --- |
| 신뢰 정책 (trust policy) | **누가** 이 역할이 될 수 있는가 | 인증의 전부 |
| 권한 정책 (permission policy) | 역할이 **무엇을** 할 수 있는가 | 피해 범위 |

액세스 키를 쓸 때는 "키를 가진 사람"이 곧 인증이었습니다. 키를 없앴으니 이제 그 자리를 신뢰 정책이 혼자 지킵니다.

조건 없이 쓰면 이렇게 됩니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity"
  }]
}
```

이 정책이 말하는 것은 "깃허브 액션스 OIDC 공급자가 서명한 토큰이면 통과"입니다.
그 공급자는 **깃허브의 모든 레포지토리**에 토큰을 발급합니다. 즉 아무나 레포를 하나 만들고 워크플로를 돌리면 이 역할을 수임할 수 있습니다.

> 조건 없는 웹 아이덴티티 신뢰 정책은 액세스 키를 깃허브에 공개한 것과 결과가 비슷합니다. 키를 지운 뒤에 더 위험해지는 경로가 여기입니다.

조건을 어디에 걸지는 토큰 안에 무엇이 들어 있는지에 달려 있습니다.

## sub는 트리거마다 다른 값이 된다

깃허브 액션스가 발급하는 토큰의 `sub` 클레임은 "이 잡이 무엇으로 실행되고 있는가"를 담습니다. 그런데 그 형태가 트리거에 따라 다릅니다.

| 실행 맥락 | `sub` 값 |
| --- | --- |
| main 브랜치 푸시 | `repo:OWNER/REPO:ref:refs/heads/main` |
| 태그 | `repo:OWNER/REPO:ref:refs/tags/v1.2.3` |
| 풀 리퀘스트 | `repo:OWNER/REPO:pull_request` |
| `environment`를 선언한 잡 | `repo:OWNER/REPO:environment:production` |

여기서 두 가지가 실무에 바로 걸립니다.

**풀 리퀘스트는 브랜치 ref로 오지 않습니다.** PR 번호도, 소스 브랜치도 `sub`에 들어가지 않고 `:pull_request` 하나로 고정됩니다.
그래서 `ref:refs/heads/*` 패턴은 PR에서 도는 잡을 통째로 걸러냅니다. 의도한 것이라면 좋은 성질이고, PR에서도 역할을 써야 하는데 안 되는 거라면 원인이 대개 여기입니다.

**`environment`를 선언하면 트리거와 무관하게 값이 고정됩니다.** 푸시든 태그든 수동 실행이든 `environment:production` 하나로 옵니다.
배포 역할을 환경 기준으로 묶으면 조건이 한 줄로 끝나고, 트리거를 하나 늘릴 때마다 신뢰 정책을 고치지 않아도 됩니다.

## 값을 손으로 적지 말고 찍어본다

`sub`를 문서 보고 타이핑하면 대개 한 번에 안 맞습니다. 실제 값을 먼저 보는 게 빠릅니다.

```yaml
- name: 발급되는 토큰의 클레임 확인
  run: |
    TOKEN=$(curl -sS \
      -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r '.value')

    payload=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+')
    case $(( ${#payload} % 4 )) in
      2) payload="$payload==" ;;
      3) payload="$payload=" ;;
    esac
    echo "$payload" | base64 -d | jq '{sub, aud, repository, ref, workflow_ref}'
```

`ACTIONS_ID_TOKEN_REQUEST_*` 환경변수는 `id-token: write` 권한이 있는 잡에만 주입됩니다. 변수가 비어 있다면 권한부터 확인할 차례입니다.

JWT는 서명된 것이지 암호화된 게 아니라서 페이로드는 그냥 base64url입니다. 위 디코딩은 그 변환(`-_` → `+/`)과 패딩을 맞추는 과정입니다.

> 이 토큰은 짧게 살지만 유효한 자격증명 교환 수단입니다. 토큰 자체를 로그에 찍지 말고, 위처럼 **필요한 클레임만 뽑아** 출력하세요.

이 확인 단계가 중요한 이유가 하나 더 있습니다. **`sub`의 형식 자체가 고정된 상수가 아닙니다.**

깃허브는 레포 이름 대신 변하지 않는 소유자·레포지토리 숫자 ID를 `sub`에 담는 방식을 도입했고, 일정 시점 이후에 만들어진 레포는 이 형식으로 발급됩니다.
이름 기반 문자열을 신뢰 정책에 적어두면 **레포 이름을 바꾸거나 조직을 옮기는 순간 조용히 깨지고**, 반대로 예전 예제를 그대로 복사하면 새 레포에서 처음부터 안 맞습니다.

> 현재 자기 레포가 어떤 형식으로 발급하는지는 위 스니펫으로 직접 확인하고, 형식의 세부 표기와 적용 대상은 공식 문서에서 확인하세요. 추측해서 적은 문자열은 `AccessDenied` 한 줄로만 돌아옵니다.

## 조건을 좁히는 법

최소한 `aud`와 `sub` 둘 다 겁니다.

```json
"Condition": {
  "StringEquals": {
    "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
    "token.actions.githubusercontent.com:sub": [
      "repo:my-org/my-repo:environment:production"
    ]
  }
}
```

공식 액션을 쓰면 `aud`는 기본적으로 `sts.amazonaws.com`입니다. 값 하나짜리 조건이라 빼먹기 쉬운데, 토큰이 **우리 쪽에 쓰라고 발급된 것인지**를 보는 유일한 줄입니다.

`sub`는 배열로 여러 값을 나열할 수 있습니다. 배열 안은 OR입니다.

와일드카드가 필요하면 연산자를 바꿔야 합니다.

```json
"StringLike": {
  "token.actions.githubusercontent.com:sub": "repo:my-org/my-repo:ref:refs/tags/v*"
}
```

여기서 자주 나오는 실수 두 가지입니다.

**`StringEquals`에 `*`를 쓰면 와일드카드로 동작하지 않습니다.** 리터럴 문자열로 비교되어 아무것도 매칭되지 않습니다. 패턴을 쓰려면 `StringLike`여야 합니다.

**와일드카드 위치가 범위를 결정합니다.** `repo:my-org/*`는 조직 안 모든 레포에 역할을 내줍니다. 그 조직에 레포를 만들 수 있는 사람 전부가 배포 자격증명을 얻는다는 뜻입니다.
`repo:my-org/my-repo:*`도 비슷하게 넓습니다. 그 레포의 모든 브랜치와 PR이 포함됩니다.

정리하면 기준은 하나입니다. **와일드카드는 "브랜치 이름 뒷부분"이나 "태그 버전"처럼 변하는 조각에만 쓰고, 레포와 소유자 자리에는 쓰지 않습니다.**

## 워크플로 쪽에서 할 일

{% raw %}
```yaml
permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    permissions:
      id-token: write      # OIDC 토큰 요청 권한
      contents: read
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::<account-id>:role/gha-deploy-production
          role-session-name: gha-${{ github.run_id }}
          aws-region: ap-northeast-2

      - run: aws sts get-caller-identity
```
{% endraw %}

`permissions`를 워크플로 최상단에 두면 **모든 잡**이 토큰을 요청할 수 있게 됩니다. 테스트 잡까지 포함해서요.
토큰이 필요한 잡에만 `id-token: write`를 주는 편이 낫습니다. 최상단에는 `contents: read` 정도만 남겨둡니다.

`role-session-name`에 실행 식별자를 넣어두면 CloudTrail에서 "어느 실행이 이 호출을 했는가"가 바로 보입니다. 사고가 났을 때 되짚는 시간이 달라집니다.

세션 길이는 액션에 지정한 값과 역할의 최대 세션 시간 중 **짧은 쪽**에 묶입니다. 배포 잡이 그보다 오래 걸리면 중간에 자격증명이 만료되니, 길이를 늘리기 전에 잡이 왜 그렇게 긴지를 먼저 보는 게 맞습니다.

{% comment %} TODO: 실제로 운영하는 환경이 몇 개이고 역할을 어떤 단위로 쪼갰는지, 전환하면서 남은 장기 키가 있었는지 적어주세요 {% endcomment %}

## 수임할 수 있다는 것과 무엇이든 한다는 것은 다르다

신뢰 정책을 좁히고 나면 다음은 권한 정책입니다. 여기서 흔한 타협이 하나 있습니다. 배포가 자꾸 권한 부족으로 깨지니까 일단 넓게 열어두는 것입니다.

**역할을 환경 단위로 쪼개는 게 먼저입니다.** 스테이징 역할이 프로덕션 리소스를 건드릴 수 없게 해두면, 조건을 하나 잘못 적었을 때의 결과가 "스테이징이 망가짐"에서 멈춥니다.

그리고 배포 역할에 `iam:*`를 붙이지 않습니다. IAM을 다룰 수 있는 역할은 **자기 자신의 권한을 늘릴 수 있습니다.** 신뢰 정책을 아무리 좁혀도 그 역할을 한 번 잡으면 그다음은 제한이 없어집니다.
IaC로 인프라를 관리한다면 리소스 생성 권한과 배포 권한을 다른 역할로 나누고, 전자는 사람의 승인을 거치게 하는 쪽이 안전합니다.

## OIDC가 막아주지 않는 것

이쪽이 더 중요합니다. 키를 없앴다는 사실이 통제가 생겼다는 뜻은 아닙니다.

**브랜치 조건의 강도는 브랜치 보호의 강도와 같습니다.** `refs/heads/main`으로 조건을 좁혀도, main에 푸시할 수 있는 사람은 워크플로 파일을 고쳐서 그 역할로 아무 명령이나 돌릴 수 있습니다.
신뢰 정책은 "main에서 도는 잡"까지만 보장하지, 그 잡이 무엇을 하는지는 모릅니다.

**환경 조건도 보호 규칙이 있어야 의미가 생깁니다.** `environment:production`으로 묶었다면, 그 환경에 필수 리뷰어와 배포 가능 브랜치 제한을 걸어둬야 조건이 실제 게이트가 됩니다. 이름만 선언된 환경은 아무도 막지 않습니다.

**서드파티 액션은 수임한 세션 안에서 돕니다.** 자격증명을 환경 안에서 그대로 쓸 수 있다는 뜻입니다. 외부 액션은 태그가 아니라 커밋 SHA로 고정하세요. 태그는 옮겨 달 수 있습니다.

**임시 자격증명도 유효한 자격증명입니다.** 로그에 찍히면 남은 수명 동안 누구나 씁니다. 짧다는 건 피해 창이 작다는 뜻이지 없다는 뜻이 아닙니다.

> 포크에서 올라온 PR의 워크플로는 토큰 권한이 제한됩니다. 이 동작은 보안상 민감해서 조건이 바뀌어 왔으니, 포크 PR에서 자격증명이 필요한 구조를 짜기 전에 현행 문서를 확인하세요. 대개는 **포크 PR에서 배포 역할을 쓰지 않도록 설계하는 쪽**이 맞습니다.

정리하면 OIDC가 해결하는 건 "비밀을 어디에 보관할 것인가"입니다. "누가 배포할 수 있는가"는 여전히 브랜치 보호와 환경 보호 규칙이 정합니다.

## 안 되면 보는 순서

실패는 거의 항상 한 줄로 옵니다.

```text
Not authorized to perform sts:AssumeRoleWithWebIdentity
```

이 메시지는 무엇이 안 맞는지 알려주지 않습니다. 순서대로 좁힙니다.

1. 앞의 스니펫으로 **실제 발급된 `sub`를 찍습니다.** 여기서 끝나는 경우가 대부분입니다.
2. 찍은 값과 신뢰 정책의 문자열을 한 글자씩 대조합니다. 대소문자도 구분합니다.
3. `aud` 조건이 액션이 요청한 audience와 같은지 봅니다.
4. CloudTrail에서 `AssumeRoleWithWebIdentity` 이벤트를 찾습니다. 요청이 AWS까지 도달은 했는지, 거기 실린 값이 무엇인지가 보입니다.

CloudTrail에 이벤트 자체가 없다면 AWS 앞에서 끝난 것입니다. `id-token: write`가 없어 토큰 발급 단계에서 실패했을 가능성이 큽니다.

## GitLab CI에서 같은 구조

구조는 같고 이름만 다릅니다. 잡에서 토큰을 선언하고, 그 토큰으로 역할을 수임합니다.

```yaml
deploy:
  id_tokens:
    AWS_ID_TOKEN:
      aud: https://gitlab.com
  script:
    - >
      aws sts assume-role-with-web-identity
      --role-arn "$AWS_ROLE_ARN"
      --role-session-name "gitlab-$CI_PIPELINE_ID"
      --web-identity-token "$AWS_ID_TOKEN"
      --duration-seconds 3600
      > /tmp/creds.json
    - export AWS_ACCESS_KEY_ID=$(jq -r '.Credentials.AccessKeyId' /tmp/creds.json)
    - export AWS_SECRET_ACCESS_KEY=$(jq -r '.Credentials.SecretAccessKey' /tmp/creds.json)
    - export AWS_SESSION_TOKEN=$(jq -r '.Credentials.SessionToken' /tmp/creds.json)
```

`sub`는 프로젝트 경로와 ref를 담은 형태(`project_path:mygroup/myproject:ref_type:branch:ref:main`)로 오고, 신뢰 정책에서 `aud`와 함께 조건으로 겁니다.

**GitLab.com에서는 `namespace_id`·`project_id` 같은 숫자 ID 조건 키도 쓸 수 있습니다.** 프로젝트 경로를 바꿔도 깨지지 않으니, 가능하면 이쪽이 낫습니다.
셀프 매니지드 인스턴스는 지원 범위가 다르니 현행 문서를 확인하세요.

깃허브의 숫자 ID 기반 `sub`와 같은 발상입니다. **이름은 바뀌고 ID는 안 바뀐다**는 것, 그리고 신뢰 정책은 바뀌는 쪽에 걸면 안 된다는 것.

## 체크리스트

- [ ] 신뢰 정책에 `sub` 조건이 **있는가** (없으면 전 세계가 수임 가능)
- [ ] `aud` 조건을 같이 걸었는가
- [ ] 와일드카드가 소유자·레포 자리에 들어가 있지 않은가
- [ ] `StringEquals`에 `*`를 쓰지 않았는가 (패턴은 `StringLike`)
- [ ] 신뢰 정책의 `sub` 문자열을 **실제 발급 값과 대조**했는가
- [ ] 레포 이름 변경·이전 시 깨질 수 있다는 걸 알고 적었는가
- [ ] `id-token: write`를 워크플로 전체가 아니라 **필요한 잡에만** 줬는가
- [ ] 환경별로 역할을 나눴는가
- [ ] 배포 역할에 `iam:*`가 붙어 있지 않은가
- [ ] 조건으로 건 브랜치·환경에 보호 규칙이 실제로 걸려 있는가
- [ ] 외부 액션을 커밋 SHA로 고정했는가
- [ ] **옛 액세스 키를 실제로 삭제했는가** (비활성화가 아니라)

마지막 항목이 제일 자주 남습니다. OIDC로 전환하고 배포가 잘 도는 걸 확인한 뒤에도, 옛 키는 "혹시 몰라서" 비활성화 상태로 남아 있곤 합니다.

그 상태에서는 전환으로 얻은 게 절반입니다. **키가 존재하는 한 공격 표면은 그대로입니다.** 마지막 사용 시각을 확인하고, 며칠 지켜본 뒤 지우는 것까지가 이 작업입니다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 전환하면서 걸렸던 조건 불일치와 원인
- 역할을 어떤 단위로 나눴는지와 그 기준

{% endcomment %}
