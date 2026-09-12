---
layout: post
title: "GitLab CI 배포 파이프라인 — GitHub Actions에서 넘어오며 정리한 것"
date: 2026-09-12
tags: [devops, gitlab, cicd, docker]
excerpt: ".gitlab-ci.yml 키워드를 GitHub Actions와 하나씩 대조한 메모. stages와 needs, 캐시와 아티팩트의 차이, 도커 이미지 빌드, rules와 승인 게이트, 기본값이 달라 걸리는 지점들."
---

GitHub Actions를 쓰다 `.gitlab-ci.yml`을 처음 열면 대부분은 그냥 읽힙니다. 스테이지가 있고, 잡이 있고, 셸 명령이 있습니다.

걸리는 건 그다음입니다. 같은 개념에 다른 이름이 붙어 있고, **이름이 같은 키워드는 기본값이 다릅니다.**
매번 문서를 다시 뒤지게 되는 지점들을 키워드 단위로 정리해 둡니다.

## 용어 대조표

| GitHub Actions | GitLab CI | 설명 |
| --- | --- | --- |
| workflow | pipeline | 한 번의 실행 단위 |
| job | job | 실행 단위. 양쪽 다 기본은 병렬 |
| step | `script`의 한 줄 | 스텝이라는 일급 개념이 없고 셸 명령의 배열이다 |
| `runs-on` | `tags` | 어느 러너에서 돌릴지. 실행 이미지는 `image`가 따로 담당 |
| `uses:` (액션) | 스크립트, `include`, 템플릿 | 재사용 단위가 액션이 아니라 **YAML 조각**이다 |
| `needs` | `needs` | 이름도 뜻도 같다. 단 stage 순서를 건너뛰는 효과까지 있다 |
| `environment` | `environment` | 배포 대상. 양쪽 다 UI에 이력이 쌓인다 |
| `secrets` | CI/CD variables (masked / protected) | 별도 저장소가 아니라 **변수의 속성** |
| `actions/upload-artifact` | `artifacts` | 액션이 아니라 키워드 |
| `actions/cache` | `cache` | 마찬가지로 키워드 |
| `strategy.matrix` | `parallel:matrix` | 변수 조합으로 잡을 복제한다 |

사고방식을 바꿔야 하는 칸은 `uses:` 한 줄입니다.
Actions에서는 "누가 만든 액션을 가져다 쓴다"가 기본 반사인데, GitLab에서는 대체로 직접 셸을 씁니다.
공유하려면 액션을 찾는 게 아니라 YAML 조각을 만들어 `include`로 끌어옵니다.

> GitLab은 재사용 단위로 CI/CD 컴포넌트라는 기능을 따로 제공합니다.
> 도입 버전과 사용 범위가 인스턴스 설정에 따라 다르니, 쓰기 전에 공식 문서에서 현재 상태를 확인하세요.

## 파이프라인의 뼈대

GitLab 파이프라인은 **stage의 나열**이고, 잡은 그중 하나에 소속됩니다.

```yaml
stages:
  - build
  - test
  - deploy

build:app:
  stage: build
  script:
    - npm ci
    - npm run build

test:unit:
  stage: test
  script:
    - npm run test:unit

test:lint:
  stage: test
  script:
    - npm run lint

deploy:staging:
  stage: deploy
  script:
    - ./scripts/deploy.sh staging
```

규칙은 두 줄입니다. 같은 stage의 잡은 **동시에** 돌고, 다음 stage는 **앞 stage가 전부 끝나야** 시작합니다.

`stages`를 선언하지 않으면 `build`, `test`, `deploy`가 기본으로 잡히고, 잡에 `stage`를 안 쓰면 `test`에 들어갑니다.
앞뒤로 `.pre`와 `.post`라는 예약 stage도 있어서, 선언 순서와 무관하게 각각 맨 처음과 맨 마지막에 붙습니다.

### needs로 DAG 만들기

stage 순서는 편하지만 불필요한 대기를 만듭니다. 린트가 3분 걸리는 동안 배포 잡이 놀고 있을 이유는 없습니다.
`needs`를 쓰면 그 잡은 stage 순서를 무시하고, 지정한 잡이 끝나는 즉시 시작합니다.

```yaml
deploy:staging:
  stage: deploy
  needs: ["build:app", "test:unit"]   # test:lint 는 기다리지 않는다
  script:
    - ./scripts/deploy.sh staging
```

`needs: []`로 비워두면 앞 stage를 전혀 기다리지 않고 파이프라인 시작과 동시에 돕니다.

한 가지 부작용이 딸려옵니다. **아티팩트도 `needs`를 따라갑니다.**
기본 동작은 앞 stage 잡들의 아티팩트를 전부 받아오는 것인데, `needs`를 쓰는 순간 **거기 적은 잡의 것만** 받습니다.
`needs`를 넣었더니 갑자기 `dist/`가 없다고 실패한다면 대개 이 경우입니다.

## 러너와 실행 환경

Actions의 `runs-on: ubuntu-latest`가 여기서는 두 키로 쪼개집니다. 어느 머신에서 돌릴지(`tags`)와 어떤 이미지 안에서 돌릴지(`image`)입니다.

러너는 GitLab이 제공하는 공용 러너를 쓰거나, 우리 인프라에 직접 띄워 등록하거나입니다.
직접 띄우면 사양과 네트워크를 우리가 정할 수 있습니다. VPC 안에서만 닿는 배포 대상이 있으면 사실상 선택지가 하나입니다.

> 러너 종류를 부르는 이름(shared / specific, instance / group / project)은 버전에 따라 바뀌었습니다.
> UI 라벨이 문서와 달라 보인다면 그 때문이니, 현재 버전 문서 기준으로 읽으세요.

executor는 러너를 등록할 때 고르는 실행 방식입니다.

| executor | 잡이 도는 곳 | 특징 |
| --- | --- | --- |
| `docker` | 매번 새로 만드는 컨테이너 | 격리가 깨끗하고 `image`로 환경을 고를 수 있다 |
| `shell` | 러너 호스트의 셸 | 빠르지만 잡끼리 상태를 공유한다 |
| `kubernetes` | 잡마다 뜨는 파드 | 동시 실행량에 따라 늘고 줄어든다 |

`shell`의 상태 공유는 편해 보이지만 "내 머신에선 되는데"가 CI에서 재현되는 버전입니다. 이유가 없으면 `docker`로 시작하는 편이 낫습니다.

`services`는 잡 옆에 같이 띄우는 사이드카입니다. 테스트용 DB가 대표적입니다.

```yaml
test:integration:
  stage: test
  image: node:22
  services:
    - name: postgres:16
      alias: db
  variables:
    POSTGRES_DB: app_test
    POSTGRES_USER: app
    POSTGRES_PASSWORD: test-only
    DATABASE_URL: "postgres://app:test-only@db:5432/app_test"
  script:
    - npm ci
    - npm run test:integration
```

서비스 컨테이너는 **호스트 이름으로 붙습니다.** `alias`를 주면 그 이름으로, 안 주면 이미지 이름에서 유도된 이름으로 접근합니다.
`localhost`로 붙으려다 실패하는 게 흔한 첫 실수입니다. 잡과 서비스는 별개의 호스트입니다.

`tags`는 러너 선택입니다. 러너에 붙여둔 태그와 잡의 `tags`가 맞아야 그 러너가 잡을 집어갑니다.
태그 없는 잡을 공용 러너가 집어갈지는 러너 설정에 달려 있습니다. "잡이 pending에서 안 움직인다"의 상당수가 이 조합 문제입니다.

## 캐시와 아티팩트는 다르다

가장 많이 헷갈리는 지점이고, 헷갈린 채로도 대충 돌아가서 더 오래 갑니다.

| | `cache` | `artifacts` |
| --- | --- | --- |
| 목적 | 속도 | 산출물 전달 |
| 저장 위치 | 러너 쪽 | GitLab 서버 |
| 보장 | **없음.** 비어 있어도 잡은 성공해야 한다 | 있음. 다음 잡이 의존할 수 있다 |
| 공유 범위 | 파이프라인을 넘어서 재사용 | 같은 파이프라인의 뒤쪽 잡 |
| 지우는 기준 | 러너 정리 정책 | `expire_in` |

> `cache`가 비어서 실패하는 파이프라인은 잘못 짠 것입니다. `artifacts`가 비어서 실패하는 건 정상입니다.

캐시 키를 브랜치 이름으로 잡는 예제가 흔한데, 의존성이 그대로여도 브랜치마다 캐시를 새로 만들게 됩니다.
바뀌는 건 lock 파일이니 **lock 파일 내용으로 키를 잡는 게** 맞습니다.

```yaml
.node-cache: &node-cache
  key:
    files:
      - package-lock.json
  paths:
    - .npm/

build:app:
  stage: build
  image: node:22
  cache:
    <<: *node-cache
  script:
    - npm ci --cache .npm --prefer-offline
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 week

test:unit:
  stage: test
  image: node:22
  cache:
    <<: *node-cache
    policy: pull
  script:
    - npm ci --cache .npm --prefer-offline
    - npm run test:unit
```

`cache:key:files`는 지정한 파일들의 내용에서 키를 계산합니다. lock 파일이 그대로면 같은 키, 한 줄이라도 바뀌면 새 키입니다.

`node_modules/`가 아니라 `.npm/`을 캐시한 것도 의도한 선택입니다.
`npm ci`는 어차피 `node_modules`를 지우고 다시 만들기 때문에, 캐시가 실제로 효과를 내는 곳은 네트워크로 받아오는 부분입니다.
읽기만 하면 되는 잡에 `policy: pull`을 준 이유도 같습니다. 매번 다시 올리면 그 업로드 시간이 절약분을 까먹습니다.

## 도커 이미지를 빌드해 레지스트리에 올리기

GitLab에는 프로젝트마다 컨테이너 레지스트리가 딸려 오고, 주소와 인증 정보가 미리 정의된 변수로 주입됩니다.
`CI_REGISTRY`(호스트), `CI_REGISTRY_IMAGE`(이 프로젝트의 이미지 경로), `CI_REGISTRY_USER`/`CI_REGISTRY_PASSWORD`(잡이 도는 동안만 유효한 로그인 정보)입니다. 따로 시크릿을 만들 필요가 없습니다.

```yaml
build:image:
  stage: build
  image: docker:27
  services:
    - docker:27-dind
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  before_script:
    - docker login -u "$CI_REGISTRY_USER" -p "$CI_REGISTRY_PASSWORD" "$CI_REGISTRY"
  script:
    - docker build -t "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" .
    - docker push "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA"
```

태그를 `CI_COMMIT_SHA`로 박은 게 핵심입니다. `latest`만 올리면 **지금 도는 이미지가 어느 커밋인지** 아무도 답할 수 없게 되는데, 장애 때 제일 먼저 필요한 정보가 그겁니다.
SHA로 박으면 이미지에서 커밋으로, 커밋에서 파이프라인으로 거꾸로 추적되고, 롤백도 "이전 SHA로 다시 배포"가 되어 재빌드가 필요 없습니다.
사람이 읽을 이름이 필요하면 SHA 태그에 별칭을 얹습니다. 기준은 항상 SHA 쪽입니다.

`docker:dind`는 잡 옆에 도커 데몬을 하나 더 띄우는 방식입니다.

> dind는 **privileged 모드로 동작하는 러너**를 요구합니다.
> 컨테이너 안에서 호스트 커널 권한을 상당 부분 얻는다는 뜻이라, 아무나 파이프라인을 고칠 수 있는 저장소에서는 위험합니다.
> 러너 설정 권한과 이 저장소에 푸시할 수 있는 사람의 범위를 같이 놓고 판단해야 합니다.

대안은 두 갈래입니다. Kaniko나 Buildah처럼 **데몬 없이 Dockerfile을 굽는 빌더**를 쓰면 privileged가 필요 없어 공용 러너에서 유리합니다.
대신 문법 지원 범위나 캐시 동작이 도커와 미묘하게 달라서 옮길 때 한 번은 검증이 필요합니다.
**호스트의 도커 소켓을 물려주는 방식**은 빠르지만 잡이 호스트의 도커를 그대로 조작하게 되므로, 신뢰 경계 안에서만 쓸 선택지입니다.

dind는 매번 빈 데몬으로 시작해서 레이어 캐시가 남지 않습니다. `--cache-from`으로 레지스트리의 이전 이미지를 끌어와 캐시로 쓰는 구성이 따로 필요합니다.

{% comment %} TODO: 실제로 어떤 방식(dind / Kaniko / 소켓 바인딩)을 골랐는지와 그 이유를 적어주세요 {% endcomment %}

## 환경별 배포와 승인 게이트

"언제 이 잡을 돌릴 것인가"를 정하는 키워드가 둘 있습니다.
**`only`/`except`는 더 이상 적극적으로 개발되지 않는 레거시이고, 지금 쓸 것은 `rules`입니다.** 한 잡에 둘을 섞어 쓸 수도 없습니다.

```yaml
deploy:staging:
  stage: deploy
  environment:
    name: staging
    url: https://staging.example.com
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
      when: on_success
    - when: never

deploy:prod:
  stage: deploy
  environment:
    name: production
    url: https://example.com
  rules:
    - if: $CI_COMMIT_TAG
      when: manual
      allow_failure: false
    - when: never
```

`rules`는 위에서부터 훑다가 **처음 맞는 하나에서 멈춥니다.** 나머지는 보지 않습니다.
마지막에 `- when: never`를 두는 습관이 안전합니다. 어디에도 안 걸린 경우가 명시적으로 처리됩니다.
`if` 외에 `changes:`(특정 경로가 바뀐 경우)와 `exists:`(특정 파일이 있는 경우)도 있어서, 모노레포에서 서비스별 배포 잡을 나눌 때 요긴합니다.

`when: manual`은 잡을 자동으로 돌리지 않고 UI에서 실행 버튼을 눌러야 시작하게 만듭니다. 프로덕션 앞에 두는 승인 게이트입니다.
여기에 기본값 함정이 하나 있습니다.

> `when: manual`을 잡에 직접 쓰면 `allow_failure`가 `true`로 잡혀서, 누르지 않아도 파이프라인은 성공으로 끝납니다.
> `rules:` 안에서 쓰면 반대로 `false`가 되어, 누를 때까지 파이프라인이 대기합니다.
> 무엇을 원하든 **명시적으로 적어두는 편**이 낫습니다. 위에서 `allow_failure: false`를 굳이 쓴 이유입니다.

`environment`를 붙여두면 UI에 환경 페이지가 생겨 어느 커밋이 언제 어디에 나갔는지가 쌓이고, 그 화면에서 이전 배포를 다시 돌릴 수 있습니다. 붙여두는 값이 싼 편입니다.

시크릿 쪽은 체크박스 두 개의 역할이 다릅니다. **Masked**는 잡 로그에 값이 찍히면 가려줍니다(값의 길이·문자에 제약이 있어 아무 문자열이나 되지는 않습니다).
**Protected**는 보호된 브랜치나 태그에서 도는 파이프라인에만 값을 주입합니다. 다른 브랜치의 잡에서는 변수 자체가 없습니다.

프로덕션 자격 증명을 실제로 지키는 건 Protected 쪽입니다. 마스킹은 로그 노출을 막을 뿐, 잡 안에서 값을 쓸 수 있다는 사실은 그대로입니다.
누구나 브랜치를 만들어 `.gitlab-ci.yml`을 고칠 수 있는 저장소에서 프로덕션 키가 protected가 아니면, 아무 브랜치에서나 꺼내 쓸 수 있습니다.
그래서 배포 대상 브랜치·태그를 protected로 두고, 거기 푸시·머지할 수 있는 사람을 제한하고, 변수도 protected로 둡니다. 셋 중 하나라도 빠지면 나머지가 무의미해집니다.

{% comment %} TODO: 실제 운영 중인 브랜치 전략(어느 브랜치/태그가 어느 환경으로 나가는지)을 적어주세요 {% endcomment %}

## 넘어올 때 걸리는 것들

개념보다 **기본값 차이**에서 시간을 더 씁니다.

### script는 첫 실패에서 멈춘다

`script`의 명령 하나가 0이 아닌 코드로 끝나면 잡은 거기서 실패하고 남은 줄은 실행되지 않습니다. `set -e`를 건 것과 같습니다.
파이프에서 헷갈립니다. `a | b`의 종료 코드는 `b`의 것이라 앞이 실패해도 뒤가 성공하면 통과하니, 중간 실패를 잡으려면 `set -o pipefail`을 직접 넣어야 합니다.

반대로 실패를 허용하려면 명시합니다. 명령 하나는 `|| true`로, 잡 전체는 `allow_failure: true`로 처리합니다. 층위가 다르니 섞지 않는 게 좋습니다.

### before_script 상속

`default:` 아래나 최상위에 쓴 `before_script`는 모든 잡이 물려받습니다.
그리고 잡에서 다시 쓰면 합쳐지는 게 아니라 **덮어씁니다.** 공통 로그인 절차를 넣어뒀다가 한 잡에서만 조용히 빠지는 사고가 여기서 납니다.

```yaml
default:
  image: node:22
  before_script:
    - node --version

# 이 잡은 공통 before_script 와 image 를 물려받지 않는다
check:python:
  inherit:
    default: false
  image: python:3.12
  script:
    - python --version
```

### YAML 앵커와 extends

**YAML 앵커**(`&`, `*`, `<<:`)는 순수 YAML 기능이라 GitLab이 내용을 해석하기 전에 처리됩니다. 간단하지만 **같은 파일 안에서만** 동작합니다.
**`extends`**는 GitLab의 기능이고, 점(`.`)으로 시작하는 숨김 잡을 템플릿으로 씁니다.

```yaml
.deploy-base:
  stage: deploy
  image: alpine:3.20
  before_script:
    - apk add --no-cache curl
  script:
    - ./scripts/deploy.sh "$TARGET_ENV"

deploy:staging:
  extends: .deploy-base
  variables:
    TARGET_ENV: staging
```

`extends`를 쓰는 이유는 하나입니다. **`include`로 가져온 다른 파일의 템플릿도 상속할 수 있습니다.** 앵커는 그게 안 됩니다.
저장소 하나로 끝날 일이면 앵커가 가볍고, 여러 저장소에서 공유할 거라면 `extends` 쪽입니다. 중첩 깊이에 상한이 있으니 깊게 쌓지는 않는 편이 낫습니다.

### include로 나누기

```yaml
include:
  - local: /ci/build.yml
  - local: /ci/deploy.yml
  - project: platform/ci-templates
    ref: v1
    file: /security/scan.yml
```

`project:`로 다른 저장소의 파일을 끌어올 수 있다는 게 핵심입니다. Actions의 공유 액션이 채우던 자리가 여기입니다.
**`ref:`는 반드시 고정하세요.** 비워두면 그 저장소의 기본 브랜치를 따라가서, 남이 템플릿을 고친 날 우리 배포가 같이 바뀝니다.

### 변수 우선순위

대략의 감각은 이렇습니다. 사람이 실행 시점에 직접 넣은 값이 가장 세고, 그다음이 UI에 저장해 둔 프로젝트·그룹 변수, 그다음이 YAML에 쓴 값(잡 단위가 전역보다 셈), 미리 정의된 변수가 가장 약합니다.

실제로 사람을 헷갈리게 하는 건 하나입니다. **YAML에 적은 값이 UI 변수를 이기지 못합니다.**
`.gitlab-ci.yml`에 분명히 썼는데 다른 값이 들어온다면, 누군가 프로젝트 설정에 같은 이름으로 넣어둔 것입니다.

> 우선순위 목록은 버전이 올라가며 항목이 추가돼 왔습니다. 애매하면 문서의 변수 우선순위 표를 확인하고, 잡 안에서 실제 값을 한 번 찍어보는 편이 빠릅니다.

### 파이프라인이 두 번 도는 문제

머지 리퀘스트를 열면 브랜치 파이프라인과 MR 파이프라인이 같이 떠서 같은 잡이 두 번 도는 일이 생깁니다.
`workflow:rules`로 파이프라인 생성 자체를 걸러냅니다.

```yaml
workflow:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_COMMIT_TAG
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    - when: never
```

MR 이벤트, 태그, 기본 브랜치일 때만 파이프라인을 만듭니다. 러너 사용 시간이 눈에 띄게 줄어드는 경우가 많아서, 옮기고 나서 가장 먼저 넣어볼 만한 블록입니다.

{% comment %} TODO: 옮기면서 가장 오래 걸린 지점이나, 옮긴 뒤 파이프라인 소요 시간 변화가 있다면 적어주세요 {% endcomment %}
