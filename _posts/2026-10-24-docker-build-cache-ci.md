---
layout: post
title: "로컬에선 30초인데 CI에선 7분 — 레이어 캐시가 깨지는 자리와 러너에서 캐시가 비는 이유"
date: 2026-10-24
tags: [devops, docker, cicd, performance]
excerpt: "같은 Dockerfile인데 CI에서만 매번 처음부터 빌드됩니다. 레이어 캐시가 무효화되는 규칙과 COPY 순서, 멀티스테이지로 설치를 떼어내는 구조, 캐시 마운트가 새로 뜬 러너에서 아무 일도 하지 않는 이유, 레지스트리 캐시의 mode와 그 비용, 캐시가 실제로 맞았는지 확인하는 법, 그리고 이미지를 줄이는 선택이 되돌려주는 것까지."
---

손에서는 두 번째 빌드가 30초에 끝납니다. 대부분 `CACHED`로 지나가니까요.

같은 Dockerfile이 CI에서는 매번 7분을 씁니다. 바꾼 건 소스 한 줄인데 의존성 설치부터 다시 돕니다.
Dockerfile이 느린 게 아니라, **캐시가 맞을 조건이 두 환경에서 다릅니다.**

## 캐시는 레이어 단위로, 체인으로 깨진다

Dockerfile의 명령 하나가 레이어 하나를 만들고, 빌더는 각 레이어마다 "이걸 전에 만든 적 있나"를 따집니다.
중요한 건 이게 **체인**이라는 점입니다. 중간 하나가 안 맞으면 그 뒤는 전부 다시 실행됩니다.

판단 기준이 명령 종류에 따라 다릅니다.

| 명령 | 캐시 적중 판단 기준 |
| --- | --- |
| `COPY`, `ADD` | 복사 대상 파일의 **내용**(체크섬)과 경로·권한 |
| `RUN`, `ENV`, `WORKDIR` 등 | **명령 문자열** 자체 (내용이 실제로 바뀌었는지는 보지 않음) |

이 두 줄이 거의 모든 문제의 출발점입니다.

`RUN`은 문자열만 보기 때문에 `RUN apt-get update`는 내용이 바뀌어도 영원히 캐시에 맞습니다.
반대로 `COPY`는 내용을 보기 때문에, 소스 한 글자만 바뀌어도 그 뒤의 모든 `RUN`이 다시 돕니다.

```dockerfile
# 소스 한 줄 바꾸면 npm ci 부터 다시 돈다
FROM node:22-slim
WORKDIR /app
COPY . .
RUN npm ci
RUN npm run build
CMD ["node", "dist/main.js"]
```

`COPY . .`이 세 번째 줄에 있으니, 그 뒤로는 캐시를 기대할 수 없습니다.
의존성은 몇 주에 한 번 바뀌는데 소스 변경에 묶여서 매번 재설치됩니다.

## 변경 빈도 순으로 쌓는다

규칙은 하나입니다. **덜 바뀌는 것을 먼저, 자주 바뀌는 것을 나중에.**

```dockerfile
FROM node:22-slim
WORKDIR /app

# 1) 의존성 목록만 먼저. 이 두 파일이 안 바뀌면 아래 설치는 캐시에 맞는다
COPY package.json package-lock.json ./
RUN npm ci

# 2) 소스는 그다음
COPY . .
RUN npm run build

CMD ["node", "dist/main.js"]
```

`npm install`이 아니라 `npm ci`를 쓰는 편이 낫습니다. 락 파일을 그대로 설치하므로 같은 입력이면 같은 결과가 나오고, 락 파일이 없으면 **조용히 다른 버전을 깔지 않고 실패합니다.**
캐시 적중률만의 문제가 아니라, 어제 통과한 이미지와 오늘 만든 이미지가 같은 의존성인지의 문제입니다.

여기서 `.dockerignore`가 생각보다 큰 역할을 합니다. `COPY . .`의 체크섬에는 컨텍스트에 포함된 파일이 전부 들어갑니다.

```text
node_modules
.git
dist
coverage
*.log
.env*
```

`.git`을 빼지 않으면 커밋만 해도 체크섬이 바뀌고, `node_modules`를 빼지 않으면 로컬에서 패키지를 한 번 깔았다는 이유로 캐시가 깨집니다.
게다가 이 파일들은 빌드 컨텍스트로 **전송**되므로, 빌드가 시작되기도 전에 시간을 씁니다.

`.env*`를 넣어둔 건 캐시와 무관한 이유입니다. 이미지 안에 들어간 파일은 레이어에 남고, [레이어에 박힌 값은 지워도 사라지지 않습니다](/blog/secret-injection-build-runtime-rotation/).

## 멀티스테이지 — 빌드 도구를 결과물에서 떼어낸다

위 Dockerfile의 최종 이미지에는 TypeScript 컴파일러와 테스트 라이브러리, 소스 전체가 들어 있습니다. 실행에는 하나도 필요 없습니다.

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
CMD ["node", "dist/main.js"]
```

스테이지를 쪼개면 두 가지를 같이 얻습니다. 최종 이미지가 작아지고, `deps` 스테이지가 **소스 변경과 완전히 분리**됩니다.

> 빌더는 최종 결과에 필요 없는 스테이지를 건너뜁니다.
> 그래서 `test` 스테이지를 만들어두고 `--target`으로 지정하지 않으면, 테스트는 빌드할 때 돌지 않습니다. 돌고 있다고 착각하기 쉬운 자리입니다.

## 캐시 마운트는 새 러너에서 아무 일도 하지 않는다

락 파일이 바뀌면 `npm ci`는 다시 돌아야 합니다. 그때 패키지를 매번 새로 받지 않도록 캐시 마운트를 씁니다.

```dockerfile
# syntax=docker/dockerfile:1
RUN --mount=type=cache,target=/root/.npm npm ci
```

로컬에서는 효과가 분명합니다. 락 파일을 고쳐도 다운로드는 거의 없습니다.

그런데 CI에 넣으면 아무것도 빨라지지 않습니다. **캐시 마운트의 내용은 이미지 레이어가 아니라 빌더의 로컬 상태**이기 때문입니다.
레지스트리 캐시나 러너 캐시로 내보내도 마운트 안의 파일은 따라가지 않고, 잡마다 새로 뜨는 러너에서는 언제나 빈 디렉터리로 시작합니다.

더 헷갈리는 건 **이게 잘 드러나지 않는다**는 점입니다.
락 파일이 안 바뀐 빌드에서는 `npm ci` 레이어 자체가 캐시에 맞아 명령이 실행되지 않습니다. 마운트가 비어 있다는 사실이 보이지 않습니다.
락 파일을 바꾼 빌드에서만 드러나고, 그때는 "오늘은 의존성을 바꿨으니 오래 걸리지"로 넘어가게 됩니다.

무엇이 어디까지 따라가는지 정리하면 이렇습니다.

| 대상 | 다음 빌드로 넘어가는가 |
| --- | --- |
| 이미지 레이어 | 넘어간다. 레지스트리 캐시로 내보내고 받을 수 있다 |
| 캐시 마운트 내용 | 같은 빌더에 남아 있을 때만. 러너가 새로 뜨면 사라진다 |
| 빌드 컨텍스트 | 매 빌드마다 다시 전송 |

그래서 선택은 둘 중 하나입니다. 빌더를 살려두거나(자체 호스팅 러너, 원격·영속 빌더), 마운트 내용을 잡 캐시로 빼내고 다시 넣어주는 별도 단계를 두는 것입니다.
후자는 외부 도구에 의존하고 지원 범위가 버전에 따라 달라지니, 도입 전에 공식 문서에서 현재 상태를 확인하세요.

**빌더가 매번 새로 뜨는 환경이라면 캐시 마운트에 기대를 걸 게 아니라 레이어 순서를 먼저 고쳐야 합니다.** 효과가 확실한 쪽이 그쪽입니다.

## CI에서 레이어 캐시를 들고 다니기

러너가 깨끗한 상태로 뜬다는 건 로컬 레이어 캐시도 없다는 뜻입니다. 캐시를 어딘가에서 받아와야 합니다.

```bash
docker buildx build \
  --cache-from "type=registry,ref=$IMAGE_REPO:buildcache" \
  --cache-to   "type=registry,ref=$IMAGE_REPO:buildcache,mode=max" \
  --tag "$IMAGE_REPO:$CI_COMMIT_SHA" \
  --push .
```

`mode`를 눈여겨봐야 합니다.

- `mode=min` — 최종 이미지에 남는 레이어만 캐시로 내보냅니다.
- `mode=max` — 중간 스테이지의 레이어까지 내보냅니다.

멀티스테이지로 쪼개놓고 `mode=min`을 쓰면, 정작 아끼고 싶었던 `deps`·`build` 스테이지가 캐시에 남지 않습니다.
스테이지를 분리한 이득을 CI에서 받으려면 `mode=max`가 필요합니다.

[GitLab CI 쪽 설정](/blog/gitlab-ci-deploy-pipeline/)이라면 빌드 잡에서 buildx 빌더를 먼저 만들어둡니다.

```yaml
build-image:
  stage: build
  image: docker:cli
  services:
    - docker:dind
  variables:
    DOCKER_TLS_CERTDIR: "/certs"
  before_script:
    - docker buildx create --use --name ci
    - echo "$CI_REGISTRY_PASSWORD" | docker login -u "$CI_REGISTRY_USER" --password-stdin "$CI_REGISTRY"
  script:
    - |
      docker buildx build \
        --cache-from "type=registry,ref=$CI_REGISTRY_IMAGE:buildcache" \
        --cache-to   "type=registry,ref=$CI_REGISTRY_IMAGE:buildcache,mode=max" \
        --tag "$CI_REGISTRY_IMAGE:$CI_COMMIT_SHA" \
        --push .
```

공짜는 아닙니다. 캐시를 레지스트리에 올리고 내리는 시간과 전송량이 생기고, `mode=max`는 그 양이 더 큽니다.
의존성이 무겁고 빌드가 긴 프로젝트라면 남는 장사지만, 빌드가 원래 1분짜리인데 캐시를 받는 데 40초를 쓰면 의미가 없습니다.
**빌드 시간을 재서 비교해보고 정하는 쪽이 맞습니다.** 그리고 캐시 태그는 계속 쌓이므로 레지스트리 정리 정책도 같이 봐야 합니다.

브랜치 전략도 걸립니다. 캐시 태그를 브랜치마다 따로 두면 신규 브랜치는 매번 빈 캐시로 시작하고, 하나로 공유하면 서로 덮어씁니다.
기본 브랜치 캐시를 읽기용으로 같이 넣어두는 절충이 무난합니다.

```bash
  --cache-from "type=registry,ref=$IMAGE_REPO:cache-$BRANCH" \
  --cache-from "type=registry,ref=$IMAGE_REPO:cache-main" \
  --cache-to   "type=registry,ref=$IMAGE_REPO:cache-$BRANCH,mode=max"
```

## 캐시가 실제로 맞았는지 확인하는 법

느낌으로 판단하지 말고 출력을 봅니다.

```bash
docker buildx build --progress=plain . 2>&1 | grep -E 'CACHED|DONE'
```

가장 확실한 검사는 **아무것도 바꾸지 않고 두 번 연속 빌드**하는 것입니다.
두 번째 빌드에서 모든 단계가 `CACHED`로 지나가야 정상입니다. 하나라도 다시 돌면 매 빌드 캐시를 깨뜨리는 레이어가 있다는 뜻입니다. 흔한 범인들입니다.

- 빌드 시각이나 커밋 해시를 `ARG`로 받아 **앞쪽 레이어**에서 쓰는 경우. 뒤쪽으로 내리면 됩니다.
- `ADD <URL>`로 원격 파일을 받는 경우.
- `.dockerignore`에 빠진 파일이 매 빌드마다 바뀌는 경우.

CI 쪽은 빌드 시간 자체를 지표로 남겨두면 회귀를 금방 잡습니다. 캐시는 조용히 깨집니다. 어느 커밋부터 7분이 됐는지 나중에 찾으려면 기록이 있어야 합니다.

## 작게 만드는 쪽의 트레이드오프

이미지 크기도 같이 손보게 되는데, 캐시와 방향이 꼭 맞지는 않습니다.

`RUN`을 `&&`로 길게 이어 붙이면 레이어 수는 줄지만 **캐시 단위도 그만큼 거칠어집니다.** 앞쪽 한 줄만 바뀌어도 전체가 다시 돕니다.
자주 바뀌는 명령은 따로 떼어두는 편이 낫습니다. 레이어 수를 줄이는 것과 캐시를 잘게 쪼개는 것은 반대 방향의 요구입니다.

베이스 이미지 선택도 공짜가 아닙니다.

| 선택 | 얻는 것 | 내주는 것 |
| --- | --- | --- |
| `-slim` 계열 | 적당한 크기, 호환성 유지 | 최소 크기는 아님 |
| alpine 계열 | 가장 작음 | libc가 달라 네이티브 모듈을 다시 빌드해야 할 수 있음 |
| distroless 계열 | 작고 공격 표면이 적음 | 셸이 없어 `exec`로 들어가 보는 디버깅이 막힘 |

크기 이야기에서 한 가지 오해를 짚어둘 만합니다. 배포할 때 노드가 받아오는 것은 **바뀐 레이어**이고, 공유하는 베이스 레이어는 이미 있으면 다시 받지 않습니다.
그래서 실제 배포 전송량을 줄이는 건 전체 크기보다 **자주 바뀌는 레이어를 작게 두는 것**입니다. 앞에서 순서를 고친 것이 여기서도 이득이 됩니다.

마지막으로 태그입니다. `node:22-slim`은 같은 문자열이어도 시점에 따라 다른 이미지를 가리킵니다.
재현성을 원하면 다이제스트로 고정하고, 대신 보안 업데이트를 자동으로 받지 못한다는 걸 받아들여야 합니다.
고정해두고 갱신을 아무도 안 하는 상태가 가장 나쁩니다. 고정한다면 올리는 주기도 같이 정해두세요.

{% comment %} TODO: 실제 프로젝트에서 어떤 베이스 이미지를 쓰고 있고 왜 그걸 골랐는지 적어주세요 {% endcomment %}

## 체크리스트

- [ ] 의존성 목록만 먼저 `COPY`하고 설치한 뒤에 소스를 복사하는가
- [ ] `.dockerignore`에 `.git`, `node_modules`, 빌드 산출물이 들어 있는가
- [ ] `npm install`이 아니라 `npm ci`(락 파일 기반)를 쓰는가
- [ ] 최종 이미지에 빌드 도구와 소스가 남아 있지 않은가
- [ ] 테스트 스테이지를 만들어두고 `--target` 없이 안 돌게 두고 있지 않은가
- [ ] 캐시 마운트의 효과를 CI에서 기대하고 있지 않은가 (빌더가 영속인지 확인)
- [ ] 멀티스테이지인데 레지스트리 캐시를 `mode=max`로 내보내는가
- [ ] 캐시를 받는 비용과 재빌드 비용을 실제로 재서 비교했는가
- [ ] 아무것도 안 바꾸고 두 번 빌드했을 때 전부 `CACHED`인가
- [ ] 변동값(`ARG`, 타임스탬프)을 앞쪽 레이어에서 쓰고 있지 않은가
- [ ] 빌드 시간을 기록해 회귀를 감지할 수 있는가

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 캐시가 깨지고 있던 원인과 고친 뒤 빌드 시간 변화
- 레지스트리 캐시 도입 전후 비교

{% endcomment %}
