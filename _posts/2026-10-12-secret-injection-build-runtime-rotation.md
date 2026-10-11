---
layout: post
title: "시크릿은 지웠는데 이미지에는 남아 있다 — 빌드·런타임 주입과 회전"
date: 2026-10-12
tags: [devops, aws, security, ecs, typescript]
excerpt: ".env를 커밋하지 않는 것으로 시크릿 관리가 끝나지 않습니다. 빌드 인자가 이미지 레이어에 박히는 경로, ECS secrets로 런타임에 주입할 때 실행 역할과 태스크 역할이 갈리는 지점, 주입이 막아주지 못하는 프로세스 내부, 회전된 자격증명을 재시작 없이 다시 읽는 구조, 그리고 로그와 에러 리포터로 값이 되돌아 새는 자리까지."
---

`.env`를 `.gitignore`에 넣고 커밋 이력을 확인하면 할 일이 끝난 것 같습니다.
그런데 값은 거기서부터 이미지 레이어로, 태스크 정의로, CI 로그로, 에러 리포트로 계속 복사됩니다.

한 번 새면 회수할 수 없는 종류의 데이터인데, 복사되는 지점은 대부분 코드 리뷰에 걸리지 않습니다.

## 환경변수는 어디까지 비밀인가

설정을 환경변수에 두라는 권고는 **배포 환경과 코드를 분리하라**는 뜻입니다. 환경변수가 안전한 저장소라는 뜻이 아닙니다.
이 둘을 같은 말로 읽으면, 값을 환경변수에 넣은 시점에 보안 작업이 끝났다고 착각하게 됩니다.

실제로 값이 복사되는 자리는 이렇습니다.

| 자리 | 볼 수 있는 사람 |
| --- | --- |
| 이미지 레이어와 빌드 히스토리 | 레지스트리에서 이미지를 받을 수 있는 누구나 |
| 태스크 정의·매니페스트의 평문 항목 | 해당 리소스에 `describe` 권한이 있는 계정 |
| CI 작업 로그 | 파이프라인 로그를 볼 수 있는 모든 구성원 |
| 프로세스 환경 (`/proc/<pid>/environ`) | 같은 컨테이너에 들어올 수 있는 사람, 그리고 그 프로세스가 띄운 자식 프로세스 전부 |
| 에러 리포터가 수집한 컨텍스트 | 외부 SaaS에 저장된 사본 |

마지막 두 줄이 특히 잘 잊힙니다. 앞의 세 줄은 "저장소를 옮기면" 해결되지만, 뒤의 두 줄은 **주입 방식을 아무리 바꿔도 그대로 남습니다.**

그래서 이 글은 두 가지를 따로 다룹니다. 값이 어디에 **쓰여지는가**(빌드·런타임 주입), 그리고 값이 거기서 어디로 **흘러나가는가**(프로세스·로그).

## 빌드 시점에 넣으면 이미지에 박힌다

사설 레지스트리에서 패키지를 받아야 해서 빌드 중에 토큰이 필요한 경우가 있습니다. 가장 먼저 떠오르는 형태는 이렇습니다.

```dockerfile
FROM node:lts-alpine
WORKDIR /app
COPY package*.json ./

ARG NPM_TOKEN
RUN echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > .npmrc \
 && npm ci \
 && rm .npmrc
```

`rm`까지 했으니 괜찮아 보입니다. 두 군데에 남습니다.

첫째, **레이어는 누적됩니다.** `rm`은 그 뒤의 상태에서 파일이 안 보이게 만들 뿐이고, 파일을 만든 레이어는 이미지에 그대로 포함됩니다.
위 예시는 생성과 삭제가 한 `RUN`에 묶여 있어 이 함정은 피했습니다. `RUN`을 세 줄로 나눠 쓰면 바로 걸립니다. **`rm`을 별도 `RUN`에 두면 파일은 앞 레이어에 남아 있습니다.**

둘째, 그래서 위 예시가 실제로 새는 곳은 다른 쪽입니다. **빌드 인자 값이 이미지 히스토리에 기록됩니다.**
`ARG`로 받은 값은 그 값을 참조한 명령과 함께 남고, `ENV`로 선언했다면 최종 이미지 설정에 들어가 그 컨테이너의 모든 프로세스가 물려받습니다.
레이어를 아무리 잘 정리해도 이쪽은 그대로입니다.

BuildKit의 시크릿 마운트는 이 기록을 남기지 않습니다. 값은 **하나의 `RUN` 동안만** 파일로 보이고, 레이어에도 히스토리에도 들어가지 않습니다.

```dockerfile
# syntax=docker/dockerfile:1
FROM node:lts-alpine AS build
WORKDIR /app
COPY package*.json ./

RUN --mount=type=secret,id=npmrc,target=/root/.npmrc \
    npm ci

COPY . .
RUN npm run build
```

```bash
docker build --secret id=npmrc,src="$HOME/.npmrc" -t api:build .
```

주의할 점은 이게 **지속을 막아줄 뿐 유출을 막아주지 않는다**는 것입니다.
마운트된 값을 `RUN` 안에서 다른 경로로 복사하거나 로그로 출력하면, 그 복사본은 평범하게 레이어와 로그에 남습니다. 마운트는 보관만 책임집니다.

멀티스테이지 빌드도 자동 해결책이 아닙니다. 빌드 스테이지에 남은 값은 최종 이미지로 `COPY`되지 않으면 안전하지만,
`node_modules`나 빌드 산출물을 통째로 복사하는 구성이라면 그 안에 설정 파일이 끼어 들어올 수 있습니다.

그래서 확인은 눈이 아니라 명령으로 합니다. 푸시 전에 한 번 돌려보면 됩니다.

```bash
IMAGE=api:build

# 빌드 히스토리에 값이 섞여 들어갔는지
docker history --no-trunc "$IMAGE" | grep -i -E 'token|secret|password|_auth'

# 최종 이미지 설정에 환경변수로 박혔는지
docker inspect "$IMAGE" | grep -A 30 '"Env"'

# 레이어 안에 설정 파일이 따라왔는지
docker run --rm --entrypoint sh "$IMAGE" -c 'ls -la /root/.npmrc /app/.npmrc 2>&1'
```

이 세 줄을 CI에 넣어두면 사람이 잊어도 걸립니다. **시크릿 검사는 리뷰보다 파이프라인에 두는 편이 안정적입니다.**

{% comment %} TODO: 빌드 과정에서 실제로 시크릿이 이미지에 들어간 사례를 겪었다면, 어떻게 발견했는지 적어주세요 {% endcomment %}

## 런타임에 주입하기

이미지에서 값을 빼면 실행 시점에 넣어야 합니다. ECS 태스크 정의에는 성격이 다른 두 배열이 있습니다.

```json
{
  "containerDefinitions": [
    {
      "name": "api",
      "environment": [
        { "name": "NODE_ENV", "value": "production" },
        { "name": "DB_HOST", "value": "prod-mysql.example.ap-northeast-2.rds.amazonaws.com" }
      ],
      "secrets": [
        {
          "name": "DB_PASSWORD",
          "valueFrom": "arn:aws:secretsmanager:ap-northeast-2:<account-id>:secret:prod/mysql-AbCdEf:password::"
        },
        {
          "name": "JWT_SECRET",
          "valueFrom": "arn:aws:ssm:ap-northeast-2:<account-id>:parameter/prod/api/jwt-secret"
        }
      ]
    }
  ],
  "executionRoleArn": "arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
  "taskRoleArn": "arn:aws:iam::<account-id>:role/apiTaskRole"
}
```

`environment`에 넣은 값은 **태스크 정의에 평문으로 저장됩니다.** 태스크 정의를 조회할 수 있는 사람은 전부 볼 수 있고, 리비전마다 사본이 남습니다.
`secrets`에 넣으면 정의에는 참조(ARN)만 남고, 실제 값은 태스크가 시작될 때 해석됩니다.

`valueFrom` 끝의 `:password::`가 눈에 걸릴 수 있습니다. Secrets Manager 참조는 ARN 뒤에 **JSON 키, 버전 단계, 버전 ID**를 콜론으로 이어 붙이는 형식입니다.
여기서는 JSON 시크릿 중 `password` 키만 꺼내고 나머지는 비워서 기본값(현재 버전)을 쓰는 형태입니다. 키를 지정하지 않으면 JSON 문서 전체가 문자열로 주입됩니다.

### 실행 역할과 태스크 역할

여기서 가장 자주 막히는 지점입니다.

> 시크릿을 가져오는 주체는 **실행 역할(execution role)**입니다. 애플리케이션 코드가 쓰는 **태스크 역할(task role)**이 아닙니다.

컨테이너 에이전트가 태스크를 띄우기 **전에** 값을 해석해서 환경변수로 넣어주기 때문입니다. 그 시점에는 애플리케이션이 아직 없습니다.
태스크 역할에만 권한을 주면 태스크가 아예 시작되지 않고, 권한 오류가 애플리케이션 로그가 아니라 **태스크 중지 사유**에 찍힙니다. 로그만 보고 있으면 원인을 못 찾습니다.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": ["arn:aws:secretsmanager:ap-northeast-2:<account-id>:secret:prod/mysql-*"]
    },
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameters"],
      "Resource": ["arn:aws:ssm:ap-northeast-2:<account-id>:parameter/prod/api/*"]
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": ["arn:aws:kms:ap-northeast-2:<account-id>:key/<key-id>"]
    }
  ]
}
```

`kms:Decrypt`는 고객 관리 키로 암호화한 경우에 필요합니다. 기본 키를 쓰면 없어도 동작하는데, 나중에 키를 교체하는 순간 조용히 깨지는 자리라 처음부터 명시해두는 편이 낫습니다.

리소스를 와일드카드로 열지 않는 것도 여기서 의미가 있습니다. 실행 역할에 계정 전체 시크릿 읽기를 주면, **그 클러스터의 아무 태스크나 다른 서비스의 자격증명을 가져올 수 있게** 됩니다.
서비스별로 경로 접두사를 나눠두면 정책을 접두사 단위로 쓸 수 있습니다.

### 파라미터 스토어와 시크릿 매니저

둘 다 주입원으로 쓸 수 있고 성격이 다릅니다.

| | SSM Parameter Store | Secrets Manager |
| --- | --- | --- |
| 주 용도 | 설정값, 가끔 바뀌는 비밀 | 회전이 필요한 자격증명 |
| 회전 | 직접 구현 | 회전 기능과 버전 단계 제공 |
| 값 구조 | 문자열 하나 | JSON 문서에서 키 단위 참조 가능 |
| 비용 | 상대적으로 저렴 | 시크릿 단위 과금 |

> 파라미터 크기 상한, 등급별 제약, 과금 단위는 서비스 업데이트로 바뀝니다. 설계에 숫자를 박아야 한다면 각 서비스의 공식 요금·제한 문서에서 확인하세요.

실무적인 기준은 단순합니다. **회전을 자동으로 돌릴 생각이 있으면 Secrets Manager, 아니면 Parameter Store**입니다.
DB 비밀번호 하나를 1년에 한 번 손으로 바꾸는 운영이라면 후자로 충분하고, 그 선택을 나중에 뒤집는 비용도 크지 않습니다.

## 주입을 바꿔도 남는 것

`secrets`로 옮기면 저장소와 전달 경로는 정리됩니다. 그런데 컨테이너 안에서 값은 여전히 **환경변수**입니다.

```bash
# 컨테이너에 들어올 수 있으면 그대로 읽힌다
tr '\0' '\n' < /proc/self/environ | grep -i password
```

이게 뜻하는 것은 세 가지입니다.

하나, 컨테이너 셸 접근 권한은 시크릿 열람 권한과 같습니다. 디버깅용으로 `exec`를 열어둔 범위가 곧 시크릿 접근 범위입니다.

둘, **자식 프로세스가 전부 물려받습니다.** 이미지 변환을 위해 외부 바이너리를 띄우거나 빌드 스크립트를 실행하면, 그 프로세스도 DB 비밀번호를 환경에 들고 있습니다.
외부 명령을 실행하는 자리에서는 환경을 좁혀서 넘기는 편이 안전합니다.

```typescript
import { execFile } from "node:child_process";

execFile("ffmpeg", args, {
  // 상속이 기본값이다. 필요한 것만 추려 넘긴다.
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
}, callback);
```

셋, 프로세스 메모리에 올라온 뒤로는 애플리케이션 코드의 책임입니다. 다음 절이 그 이야기입니다.

## 로그와 에러 리포터로 되돌아 새는 경로

유출 사고에서 흔한 형태는 외부 침입이 아니라 **우리가 우리 로그에 적어놓은 것**입니다.

가장 직접적인 건 환경 전체를 덤프하는 코드입니다. 디버깅용으로 넣고 잊히는 한 줄입니다.

```typescript
// 이 한 줄이 시크릿을 로그 수집기와 그 보관 기간 전체로 복사한다
console.log("boot env", process.env);
```

에러 리포터는 더 조용합니다. 많은 SDK가 요청 헤더나 프로세스 환경 같은 컨텍스트를 **자동으로** 붙여 보냅니다.
이 경우 값은 우리 인프라 밖 외부 서비스에 저장되고, 보관 기간과 접근 권한은 그쪽 설정을 따릅니다. 자동 수집 범위는 도입 시점에 한 번 확인해둘 항목입니다.

드라이버와 라이브러리의 오류 메시지도 봅니다. 접속 실패 시 접속 문자열을 그대로 메시지에 담는 구현이 있어서, 비밀번호가 스택 트레이스에 섞여 들어갑니다.
오류를 통째로 직렬화해 로그에 넘기는 구조라면 여기서 새어나갑니다.

그래서 로거 앞에 마스킹을 한 겹 둡니다.

```typescript
const SENSITIVE_KEY = /(pass|secret|token|credential|authorization|api[-_]?key)/i;

export function redactKeys(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactKeys(v, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) =>
      SENSITIVE_KEY.test(k) ? [k, "[REDACTED]"] : [k, redactKeys(v, depth + 1)],
    ),
  );
}
```

이 방식의 한계를 분명히 알고 쓰는 게 중요합니다. **키 이름 기반 마스킹은 키 이름이 예상과 다르면 못 잡습니다.**
`dbUrl`, `conn`, `auth_header` 같은 이름은 위 정규식에 걸리지 않고, 값이 긴 문자열 안에 섞여 있으면 키 단위로는 손을 쓸 수 없습니다.

보완책은 **값 기반 치환**입니다. 부팅 시점에 알고 있는 시크릿 값들을 모아두고, 로그를 내보내기 전에 그 문자열이 포함돼 있으면 치환합니다.
모든 로그 라인에 문자열 검색이 붙으니 비용이 들고, 짧은 값은 오탐이 생깁니다. 그래서 보통 **일정 길이 이상의 값만** 대상으로 잡습니다.

CI 로그도 같은 문제를 가집니다. GitLab의 변수 마스킹은 **작업 로그에서 값을 가려주는 기능**이고, 스크립트가 값을 파일로 쓰거나 외부로 보내는 것은 막지 못합니다.
마스킹이 적용되는 값의 형식에도 제약이 있어서, 조건을 만족하지 않는 값은 마스킹되지 않습니다. 이 조건은 버전에 따라 달라져 왔으니 쓰는 버전의 공식 문서에서 확인하는 편이 정확합니다.
그리고 파이프라인에서 `set -x`를 켜두면 마스킹과 무관하게 명령 인자가 그대로 찍히는 경로가 생깁니다.

## 회전이 어려운 이유

회전은 "값을 바꾸는 일"이 아니라 **"바꾸는 동안 아무도 실패하지 않게 만드는 일"**입니다. 여기서 환경변수 주입의 구조적 한계가 드러납니다.

> `secrets`로 주입된 값은 **태스크가 시작될 때 한 번** 해석됩니다. 시크릿을 바꿔도 이미 돌고 있는 태스크의 환경변수는 그대로입니다.

즉 환경변수 주입만 쓴다면, 회전은 반드시 **재배포나 재시작을 동반합니다.** 자동 회전을 걸어두고 재시작을 안 걸면, 어느 시점부터 조용히 옛 값으로 인증을 시도하게 됩니다.

Secrets Manager는 이 전환 구간을 **버전 단계(staging label)**로 다룹니다.

| 단계 | 의미 |
| --- | --- |
| `AWSCURRENT` | 지금 쓰라고 지정된 버전 |
| `AWSPENDING` | 회전 중에 만들어진, 아직 승격되지 않은 버전 |
| `AWSPREVIOUS` | 직전까지 `AWSCURRENT`였던 버전 |

회전 함수는 새 자격증명을 만들어 `AWSPENDING`에 두고, 대상 시스템에 적용하고, 그 값으로 접속을 시험한 뒤 `AWSCURRENT`로 승격합니다.
이때 **예전 값이 `AWSPREVIOUS`로 남는 것**이 핵심입니다. 승격 직후에도 옛 값을 들고 있는 인스턴스가 바로 죽지 않도록 하는 완충 구간입니다.

DB 자격증명이라면 사용자를 둘로 두고 번갈아 회전하는 전략이 이 완충을 더 넓혀줍니다. 한쪽을 바꾸는 동안 다른 쪽이 계속 유효하니, 두 자격증명이 동시에 통하는 구간이 생깁니다.

> 어느 전략이든 전제가 있습니다. **회전 대상 시스템에서 두 자격증명이 겹쳐 유효한 구간을 만들 수 있어야** 합니다.
> 비밀번호가 하나뿐이고 바꾸는 순간 옛 값이 즉시 무효가 되는 대상이라면, 완충 구간 자체가 없어서 짧은 실패를 피할 수 없습니다.

### 재시작 없이 새 값을 쓰려면

애플리케이션이 환경변수가 아니라 **API로 직접 조회**하면 회전과 재시작을 분리할 수 있습니다. 대신 매 사용마다 조회하면 지연과 호출량이 늘어나니 캐시가 필요합니다.

```typescript
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
const TTL_MS = 5 * 60_000;

const cache = new Map<string, { value: string; fetchedAt: number }>();

export async function getSecret(id: string, force = false): Promise<string> {
  const hit = cache.get(id);
  if (!force && hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.value;

  const res = await client.send(
    new GetSecretValueCommand({ SecretId: id, VersionStage: "AWSCURRENT" }),
  );
  if (!res.SecretString) throw new Error(`secret ${id} has no string value`);

  cache.set(id, { value: res.SecretString, fetchedAt: Date.now() });
  return res.SecretString;
}
```

캐시가 있으면 회전 직후 최대 TTL만큼은 옛 값을 씁니다. 이 구간을 `AWSPREVIOUS` 완충으로 넘기는 게 위 구조의 전제입니다.
**TTL은 완충 구간보다 짧아야 합니다.** 이 부등식이 깨지면 캐시가 만료되기 전에 옛 값이 무효가 되어 인증 실패가 납니다.

그리고 인증 오류를 신호로 받아 한 번 다시 읽습니다. TTL만 믿는 것보다 회복이 빠릅니다.

```typescript
export async function createPoolWithRotation() {
  try {
    return createPool(JSON.parse(await getSecret(SECRET_ID)));
  } catch (err) {
    if (!isAuthError(err)) throw err;

    // 회전 직후일 수 있다. 캐시를 버리고 한 번만 다시 읽는다.
    return createPool(JSON.parse(await getSecret(SECRET_ID, true)));
  }
}
```

재시도는 **한 번으로 제한하고 인증 오류에만** 걸어야 합니다. 조건을 넓히면 네트워크 장애 때 모든 인스턴스가 시크릿 조회를 반복하면서 호출량이 폭증합니다.
인스턴스가 많다면 여기에 지터를 더하는 편이 안전합니다. 회전 시점에 전체 인스턴스가 동시에 인증 실패하고 동시에 조회하는 모양이 되기 쉽습니다.

트레이드오프는 분명합니다.

| | 환경변수 주입 | 런타임 조회 |
| --- | --- | --- |
| 애플리케이션 복잡도 | 없음 | 캐시·재조회 경로를 직접 관리 |
| 회전 반영 | 재시작 필요 | 캐시 TTL 안에 반영 |
| 기동 시 외부 의존 | 없음 (에이전트가 처리) | 조회 실패가 기동 실패로 |
| 호출량 | 태스크 시작당 한 번 | 캐시 설계에 따라 달라짐 |

정리하면, **회전 주기가 재배포 주기보다 짧을 때만** 런타임 조회가 값을 합니다.
하루에 몇 번씩 배포하는 서비스가 분기마다 회전하는 자격증명을 쓴다면, 환경변수 주입으로 두고 회전 시 재배포하는 쪽이 코드가 적고 실패 지점도 적습니다.

{% comment %} TODO: 실제로 운영에서 회전을 어떻게 돌리고 있는지(수동/자동, 주기), 회전 때문에 겪은 문제가 있다면 적어주세요 {% endcomment %}

## 어디서부터 손댈지

전부 한 번에 바꾸는 작업이 아닙니다. 되돌릴 수 없는 피해 순서로 하면 이 순서가 됩니다.

1. **이미 새어 있는 값을 찾는다.** 커밋 이력과 이미지 히스토리를 훑습니다. 새어 있던 값은 저장소를 옮기는 것으로 해결되지 않고, **교체해야** 끝납니다.
2. **빌드에서 걷어낸다.** `ARG`·`ENV`로 넘기던 것을 시크릿 마운트로 바꾸고, 검사 명령을 CI에 넣습니다.
3. **평문 항목을 참조로 바꾼다.** 태스크 정의의 `environment`에 있던 비밀을 `secrets`로 옮기고 실행 역할 권한을 좁힙니다.
4. **로그 경로를 막는다.** 환경 덤프를 제거하고, 마스킹을 로거 앞에 두고, 에러 리포터의 자동 수집 범위를 확인합니다.
5. **그다음에 회전을 생각한다.** 앞의 네 단계가 안 된 상태에서 회전을 자동화하면, 새는 구멍으로 새 값이 계속 흘러갈 뿐입니다.

## 체크리스트

- [ ] 이미지 히스토리와 최종 설정에 시크릿이 없는지 **CI에서** 확인하는가
- [ ] 빌드 중 필요한 시크릿을 `ARG`가 아니라 시크릿 마운트로 넘기는가
- [ ] 태스크 정의의 `environment`에 비밀이 남아 있지 않은가
- [ ] 시크릿 조회 권한이 실행 역할에 있고, 리소스 범위가 서비스별로 좁혀져 있는가
- [ ] 외부 명령을 실행할 때 환경을 추려서 넘기는가
- [ ] `process.env`를 통째로 로깅하는 코드가 없는가
- [ ] 에러 리포터가 환경·헤더를 자동 수집하는지 확인했는가
- [ ] 회전이 재시작을 동반해야 하는 구조인지, 아닌지 정해져 있는가
- [ ] 런타임 조회를 쓴다면 캐시 TTL이 회전 완충 구간보다 짧은가
- [ ] 과거에 새어 있던 값이 **교체**됐는가 (숨긴 것으로 끝내지 않았는가)

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 시크릿 관리 방식을 옮기면서 실제로 걸린 문제
- 회전 자동화를 어디까지 적용했는지

{% endcomment %}
