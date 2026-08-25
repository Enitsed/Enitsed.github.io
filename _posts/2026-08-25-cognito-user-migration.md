---
layout: post
title: "기존 회원을 Cognito로 옮기기 — 비밀번호를 모르는 채로"
date: 2026-08-25
tags: [aws, cognito, auth, backend, typescript]
excerpt: "자체 구현 인증을 Amazon Cognito로 옮기는 절차. 비밀번호 해시를 이전할 수 없다는 제약에서 출발해, Migration 람다로 로그인 시점에 하나씩 넘기는 방법."
---

자체 구현한 로그인을 Amazon Cognito로 옮기려고 하면, 계획을 세우기도 전에 벽 하나를 만납니다.
비밀번호 해시를 가져갈 방법이 없다는 것입니다.

신규 서비스에 Cognito를 붙이는 이야기는 문서가 잘 돼 있으니 넘어가고, 여기서는 이미 회원이 쌓여 있는 서비스를 끊기지 않게 옮기는 경우만 다룹니다.

## 그 벽이 왜 문제인가

Cognito의 사용자 일괄 임포트(`CreateUserImportJob`)는 이메일, 전화번호, 이름 같은 속성은 CSV로 받아주지만 비밀번호는 받지 않습니다.
임포트된 사용자는 `FORCE_CHANGE_PASSWORD` 상태로 들어가고, 로그인하려면 비밀번호를 새로 설정해야 합니다.

bcrypt든 argon2든 해시는 단방향이라 평문을 복원할 수 없으니 당연한 제약입니다.
다만 이걸 놓치고 "회원 테이블을 CSV로 뽑아 임포트하면 되겠다"고 계획을 세우면, 전체 회원에게 비밀번호 재설정을 요구하는 마이그레이션이 됩니다.
그 시점부터는 기술 작업이 아니라 이탈률 문제가 됩니다.

그래서 선택지는 둘입니다.

| 방식 | 사용자 경험 | 대가 |
| --- | --- | --- |
| 일괄 임포트 + 비밀번호 재설정 안내 | 전원이 재설정을 거쳐야 함 | 구현은 단순, 이탈 위험 |
| Migration 람다 (지연 이전) | 평소처럼 로그인하면 자동 이전 | 람다 하나를 더 운영, 이전 시스템을 한동안 유지 |

로그인 흐름이 이미 살아 있는 서비스라면 두 번째가 사실상 유일한 답입니다. 아래는 그쪽 이야기입니다.

<!-- TODO: 실제로 옮긴 회원 규모와, 이전 인증 시스템이 어떤 구조였는지(자체 세션인지 JWT인지, 해시 알고리즘은 무엇이었는지) 적어주세요 -->

## Migration 람다가 하는 일

Cognito에는 **User Migration 트리거**가 있습니다.
사용자 풀에 없는 아이디로 로그인이나 비밀번호 찾기가 들어오면, Cognito가 바로 실패시키지 않고 이 람다를 호출합니다.
람다가 "이 사람 맞고 비밀번호도 맞다"고 답하면서 속성을 같이 돌려주면, Cognito가 그 자리에서 사용자를 만들고 로그인을 성공시킵니다.

흐름은 이렇습니다.

```
로그인 시도
   │
   ▼
Cognito 사용자 풀에 있나?
   │                    │
  있음                  없음
   │                    ▼
   │           User Migration 람다 호출
   │                    │
   │         레거시 DB에서 조회 + 해시 검증
   │                    │
   │              성공 ─┴─ 실패 → 로그인 실패
   │                    ▼
   │           속성과 함께 반환 → Cognito가 사용자 생성
   ▼                    │
로그인 성공  ◀───────────┘
```

사용자 입장에서는 아무 일도 일어나지 않습니다. 평소 쓰던 비밀번호로 로그인했고 들어가졌습니다.
그 순간 계정이 조용히 Cognito로 옮겨졌고, 다음 로그인부터는 람다를 타지 않습니다.

**중요한 성질이 하나 있습니다.** 이 트리거는 평문 비밀번호를 람다에 넘겨줍니다(`event.request.password`).
검증 로직이 레거시 해시 알고리즘을 그대로 쓸 수 있는 이유이자, 동시에 **이 람다를 다른 코드보다 조심히 다뤄야 하는 이유**이기도 합니다. 로깅에 절대 섞이면 안 됩니다.

## 람다 구현

트리거는 두 가지 상황으로 들어옵니다. 로그인(`UserMigration_Authentication`)과 비밀번호 찾기(`UserMigration_ForgotPassword`)입니다.
후자는 비밀번호를 받지 않으므로 **존재 확인만** 하고 넘겨야 합니다.

```typescript
import type { UserMigrationTriggerEvent } from "aws-lambda";

export const handler = async (
  event: UserMigrationTriggerEvent,
): Promise<UserMigrationTriggerEvent> => {
  const email = event.userName.trim().toLowerCase();

  // 평문 비밀번호가 들어오는 핸들러다. event 를 통째로 로깅하지 않는다.
  logger.info({ trigger: event.triggerSource, email }, "user migration");

  const user = await legacy.findActiveUserByEmail(email);
  if (!user) {
    throw new Error("Bad credentials");   // 존재 여부를 노출하지 않는다
  }

  if (event.triggerSource === "UserMigration_Authentication") {
    const ok = await verifyLegacyPassword(event.request.password, user.passwordHash);
    if (!ok) throw new Error("Bad credentials");
  } else if (event.triggerSource !== "UserMigration_ForgotPassword") {
    throw new Error("Unsupported trigger");
  }

  event.response.userAttributes = {
    email,
    email_verified: user.emailVerifiedAt ? "true" : "false",
    name: user.name ?? "",
    "custom:legacy_id": String(user.id),
    "custom:signup_at": user.createdAt.toISOString(),
  };

  // 비밀번호 재설정을 요구하지 않고 바로 로그인시킨다
  event.response.finalUserStatus = "CONFIRMED";
  event.response.messageAction = "SUPPRESS";   // 환영 메일을 보내지 않는다

  return event;
};
```

빠뜨리기 쉬운 지점들입니다.

- **`finalUserStatus`를 `CONFIRMED`로 주지 않으면** 사용자가 `RESET_REQUIRED` 상태로 만들어지고, 결국 비밀번호 재설정 화면을 보게 됩니다. 이 작업을 하는 이유가 통째로 사라집니다.
- **`messageAction: "SUPPRESS"`가 없으면** 이미 몇 년 전에 가입한 사용자에게 "가입을 환영합니다" 메일이 나갑니다.
- **`email_verified`를 `"true"`로 넘기지 않으면** 비밀번호 찾기가 동작하지 않습니다. 확인 코드를 보낼 곳이 검증되지 않은 상태이기 때문입니다. 레거시에서 실제로 검증된 사용자만 `true`로 넘기고, 나머지는 `false`로 두는 편이 정직합니다.
- **`ForgotPassword` 경로에서 비밀번호를 검증하려 하면 안 됩니다.** `event.request.password`가 비어 있어서 항상 실패하고, 비밀번호를 잊은 사용자가 영원히 못 들어옵니다.
- **실패 메시지를 구분하지 않습니다.** "없는 계정"과 "비밀번호 틀림"을 다르게 던지면 가입 여부를 확인하는 통로가 됩니다.

`custom:legacy_id`를 넣어두는 건 나중에 값을 합니다. 기존 데이터의 외래 키가 전부 레거시 사용자 ID를 가리키고 있으니, 토큰에서 이 값을 꺼내 기존 데이터를 그대로 이어 쓸 수 있습니다.

## 사용자 풀 설정에서 정해야 할 것

### 커스텀 속성은 나중에 못 바꾼다

이름, 타입, 길이, 변경 가능 여부를 만들 때 정하면 끝이고, 바꾸려면 사용자 풀을 새로 만들어야 합니다.
마이그레이션 전에 필요한 속성을 미리 다 정의해두세요.

```bash
aws cognito-idp add-custom-attributes \
  --user-pool-id "$POOL_ID" \
  --custom-attributes \
    'Name=legacy_id,AttributeDataType=String,Mutable=false,StringAttributeConstraints={MinLength=1,MaxLength=32}' \
    'Name=signup_at,AttributeDataType=String,Mutable=false'
```

### 아이디 방식도 되돌릴 수 없다

이메일을 별칭(alias)으로 쓸지 사용자 이름 자체로 쓸지는 사용자 풀 생성 시점에 결정되고 이후 변경이 안 됩니다.
레거시가 이메일로 로그인했다면 그대로 이메일 기반으로 잡되, **대소문자 정규화**를 어디서 할지 정해야 합니다. 위 람다에서 `toLowerCase()`를 거는 이유이기도 한데, 클라이언트에서 보내는 값도 같이 맞춰야 `A@x.com`과 `a@x.com`이 다른 계정으로 갈라지지 않습니다.

### 비밀번호 정책이 레거시보다 엄격하면

예전 정책이 6자였는데 새 정책이 8자 이상 + 특수문자라면, 6자 비밀번호를 쓰던 사용자는 람다 검증은 통과하지만 Cognito가 사용자를 만드는 단계에서 거부합니다.
마이그레이션 기간에는 정책을 레거시에 맞춰 느슨하게 두고, 이전이 끝난 뒤 강화하면서 재설정을 유도하는 순서가 안전합니다.

## 백엔드의 토큰 검증

Cognito가 발급한 액세스 토큰은 JWKS로 검증합니다. 직접 구현하기보다 검증된 라이브러리를 쓰는 편이 안전합니다.

```typescript
import { CognitoJwtVerifier } from "aws-jwt-verify";

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID!,
  tokenUse: "access",
  clientId: process.env.COGNITO_CLIENT_ID!,
});

export async function authenticate(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer /, "");
  if (!token) return res.status(401).json({ message: "로그인이 필요합니다." });

  try {
    const payload = await verifier.verify(token);
    req.user = { sub: payload.sub, legacyId: payload["custom:legacy_id"] };
    next();
  } catch {
    res.status(401).json({ message: "로그인이 만료됐습니다." });
  }
}
```

`tokenUse`를 명시하는 게 중요합니다. Cognito는 ID 토큰과 액세스 토큰을 모두 발급하는데, 둘은 용도가 다릅니다.
API 인가에는 액세스 토큰을 쓰고, ID 토큰은 클라이언트가 사용자 정보를 읽는 데 씁니다. 검증기가 둘을 구분하지 않으면 엉뚱한 토큰으로도 API가 열립니다.

`custom:legacy_id`가 액세스 토큰에 실리게 하려면 앱 클라이언트의 읽기 권한에 그 속성이 포함돼 있어야 합니다.
안 보인다면 대부분 이 설정이 빠진 경우입니다.

## 두 시스템이 공존하는 기간

전환은 스위치가 아니라 구간입니다. 그 구간 동안 두 가지가 동시에 살아 있습니다.

**레거시 세션은 만료될 때까지 유효합니다.** 이미 로그인해 있는 사용자를 강제로 로그아웃시키지 않는 한, 기존 토큰을 들고 오는 요청이 한동안 계속됩니다.
백엔드는 두 종류의 토큰을 모두 받아들이되, 레거시 쪽은 **갱신을 막아** 자연히 소진되게 합니다. 갱신을 허용하면 그 구간이 끝나지 않습니다.

```typescript
// 전환 기간: 두 검증기를 순서대로 시도한다
async function resolveUser(token: string) {
  try {
    return await verifyCognito(token);
  } catch {
    const legacy = await verifyLegacySession(token);   // 검증만, 연장은 하지 않는다
    if (legacy) metrics.increment("auth.legacy_token_used");
    return legacy;
  }
}
```

`auth.legacy_token_used` 같은 카운터를 하나 두면 **언제 레거시 경로를 걷어내도 되는지**를 추측이 아니라 그래프로 판단할 수 있습니다. 0에 수렴하면 지우면 됩니다.

레거시 회원 DB도 마지막까지 살려둡니다. Migration 람다가 이걸 읽기 때문입니다.
한 번도 로그인하지 않은 휴면 계정은 영원히 이전되지 않으므로, 레거시 DB를 지우는 순간 그 계정들은 사라집니다.
정리 시점에는 남은 미이전 계정을 세어보고, 안내 메일을 보낼지 일괄 임포트로 넘길지 따로 결정해야 합니다.

```bash
# 이전 완료 수 확인
aws cognito-idp describe-user-pool \
  --user-pool-id "$POOL_ID" \
  --query 'UserPool.EstimatedNumberOfUsers'
```

<!-- TODO: 전환 기간을 실제로 얼마나 잡았는지, 미이전 휴면 계정을 어떻게 처리했는지 적어주세요 -->

## 되돌릴 수 있게 만들기

이 작업에서 가장 무서운 건 절반쯤 옮겨진 상태에서 문제가 발견되는 것입니다. 그래서 되돌릴 경로를 먼저 만들어둡니다.

- **레거시를 지우지 않는다.** 위에서 말한 대로 람다가 참조하기도 하고, 문제가 생겼을 때 돌아갈 곳이기도 합니다.
- **전환 스위치를 서버에 둔다.** 클라이언트 배포로 전환하면, 앱 스토어 심사를 기다려야 하는 구조에서는 롤백에 며칠이 걸립니다. 로그인 요청을 어느 쪽으로 보낼지 서버가 응답하게 해두면 되돌리는 데 배포 한 번이면 됩니다.
- **단계적으로 연다.** 내부 계정 → 소수 비율 → 전체 순서면 충분합니다. Migration 람다는 사용자별로 독립 동작하므로 비율을 나누는 데 특별한 장치가 필요 없습니다.

## 이 구조가 감추는 실패들

Migration 람다는 로그인 경로 한가운데에 있으면서, 실패해도 겉으로는 평범한 "로그인 실패"로 보입니다. 그 성질에서 나오는 문제가 몇 가지 있습니다.

레거시 DB 커넥션이 끊겨 람다가 터지는 중이라면, 정상 비밀번호를 넣은 사용자가 계속 튕깁니다.
그런데 인증 실패 로그만 봐서는 비밀번호를 틀린 사람과 구분되지 않습니다. 람다 에러와 인증 실패를 다른 지표로 분리해두지 않으면 이 상태를 며칠씩 모를 수 있습니다.

콜드 스타트도 사용자에게는 그냥 느린 로그인으로 보입니다. VPC 안에 두고 레거시 DB에 붙는 구조라면 첫 호출이 눈에 띄게 느리니, 동시성 예약이나 커넥션 재사용을 검토할 지점입니다.

속성 매핑 누락은 더 늦게 드러납니다. 이름이나 전화번호를 안 넘겨도 로그인은 성공하고, 사용자는 한참 뒤 마이페이지에서 빈칸을 봅니다.
이전된 계정 몇 개를 표본으로 뽑아 속성이 다 찼는지 확인하는 절차를 넣어두면 이건 쉽게 잡힙니다.

<!-- TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 전환 중 실제로 터진 문제와 대응
- 이전 완료율이 어떻게 올라갔는지

-->
