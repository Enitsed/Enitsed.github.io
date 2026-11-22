---
layout: post
title: "폰에 뜬 코드를 그대로 넣었는데 틀렸다고 한다 — TOTP 2단계 인증의 시계와 복구"
date: 2026-11-23
tags: [backend, auth, security, typescript, mysql]
excerpt: "TOTP 2단계 인증에서 실제로 어려운 것들. 코드 계산이 아니라 허용 시간창의 트레이드오프, 같은 코드의 재사용 차단, 6자리를 무차별 대입으로 뚫는 데 걸리는 시간, 등록 도중 사용자를 잠그지 않는 상태 전이, 그리고 복구 경로가 2단계 인증의 실제 보안 수준을 정해버리는 구조."
---

비밀번호 하나로 버티는 구조는 비밀번호가 새는 순간 끝납니다. 다른 사이트에서 새어 나온 조합이 그대로 통하는 경우도 적지 않습니다.

그래서 두 번째 요소를 붙입니다. 라이브러리 몇 줄이면 될 것 같은데, 붙여놓고 나면 **코드 계산과 상관없는 곳에서 문제가 생깁니다.**
사용자가 폰에 뜬 숫자를 그대로 넣었는데 거부되고, 폰을 바꾼 사용자가 로그인할 길이 없어집니다.

## 6자리를 계산하는 부분은 어렵지 않다

TOTP는 HOTP(RFC 4226)의 카운터 자리에 시간을 넣은 것입니다(RFC 6238). 서버와 사용자 기기가 공유하는 것은 **비밀키 하나와 시계**뿐입니다.

```text
step   = floor(현재 유닉스 시각 / 30)
code   = HOTP(비밀키, step)
```

구현은 짧습니다. 표준 라이브러리만으로 충분합니다.

```typescript
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_SECONDS = 30;
const DIGITS = 6;

export function hotp(secret: Buffer, counter: number, digits = DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));

  const mac = createHmac("sha1", secret).update(msg).digest();

  // RFC 4226 동적 절단: 마지막 바이트 하위 4비트를 오프셋으로 쓴다
  const offset = mac[mac.length - 1] & 0x0f;
  const bin =
    ((mac[offset] & 0x7f) << 24) |   // 최상위 비트를 버려 부호 문제를 피한다
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];

  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function currentStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}
```

> HMAC-SHA1, 6자리, 30초가 사실상의 기본값입니다. 알고리즘이나 자릿수를 바꿀 수는 있지만, **인증 앱에 따라 그 파라미터를 무시하는 경우가 있습니다.**
> 기본값을 벗어나려면 지원 대상으로 삼는 앱에서 직접 확인하세요. 여기서 어긋나면 "앱에 뜨는 숫자가 서버 계산과 다르다"가 됩니다.

비교할 때는 길이를 맞춘 뒤 상수 시간 비교를 씁니다. `timingSafeEqual`은 길이가 다르면 예외를 던집니다.

```typescript
function codesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
```

여기까지는 명세대로 쓰면 끝나는 부분입니다. 운영에서 손이 가는 곳은 아래부터입니다.

## 시계가 어긋나면 전부 틀린다

사용자 폰과 서버의 시계는 정확히 같지 않습니다. 코드 입력에도 몇 초가 걸리고, 그 사이에 창이 넘어가기도 합니다.
그래서 현재 step만 비교하면 멀쩡한 사용자가 주기적으로 거부됩니다.

앞뒤 step을 함께 허용합니다. 다만 넓힐수록 유효한 코드 수가 늘어납니다.

| 허용 범위 | 받아주는 시간 폭 | 동시에 유효한 코드 |
| --- | --- | --- |
| 현재 step만 | 0~30초 | 1개 |
| ±1 step | 약 90초 | 3개 |
| ±2 step | 약 150초 | 5개 |
| ±5 step | 약 330초 | 11개 |

**±1이 기본 선택지입니다.** 넉넉하게 ±5까지 열어두면 사용자 문의는 줄지만, 다음 절에서 볼 무차별 대입 성공률이 그만큼 올라갑니다.

```typescript
const WINDOW = 1;

export function verifyTotp(secret: Buffer, code: string, now = Date.now()) {
  const step = currentStep(now);
  for (let drift = -WINDOW; drift <= WINDOW; drift++) {
    if (codesEqual(hotp(secret, step + drift), code)) {
      return { ok: true as const, usedStep: step + drift };
    }
  }
  return { ok: false as const };
}
```

실패가 늘었을 때 원인을 가르는 기준은 **범위**입니다.

- 특정 사용자만 실패한다 → 그 기기의 시계 또는 비밀키 문제
- 모든 사용자가 동시에 실패한다 → **서버 시계** 문제

후자는 TOTP를 붙인 뒤 생기는 새로운 단일 장애점입니다. 서버 시각이 몇십 초 밀리면 아무도 로그인하지 못합니다.
시각 동기화가 살아 있는지 모니터링하고, 2단계 인증 실패율을 사용자 단위가 아니라 전체 지표로도 보세요.
`verifyTotp`에서 성공한 `drift` 값을 기록해두면 쏠림이 보입니다. 전체 성공이 한쪽 drift에 몰려 있다면 서버 시계가 이미 밀려 있다는 뜻입니다.

## 같은 코드를 두 번 받으면 두 번째 요소가 아니다

코드는 30초 동안 유효합니다. 그 사이에 같은 코드를 다시 쓸 수 있다면, 한 번 가로챈 코드로 두 번째 로그인이 됩니다.
피싱 페이지에 코드를 입력하게 만든 뒤 공격자가 같은 코드를 서버에 넣는 흐름이 전형적입니다.

그래서 한 번 쓴 step은 소비 처리합니다. 사용자별로 **마지막으로 사용한 step**을 저장하고, 그보다 작거나 같은 step은 거부합니다.

```sql
CREATE TABLE user_totp (
  user_id        BIGINT       NOT NULL PRIMARY KEY,
  secret_enc     VARBINARY(255) NOT NULL,
  status         ENUM('pending','enabled') NOT NULL,
  last_used_step BIGINT       NOT NULL DEFAULT 0,
  confirmed_at   DATETIME     NULL,
  created_at     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

검사와 기록이 분리되어 있으면 동시에 들어온 두 요청이 모두 통과합니다. 조건을 `UPDATE`에 넣어 한 번에 처리해야 합니다.

```typescript
// 영향받은 행이 0이면 다른 요청이 이미 그 step을 썼다는 뜻
const [res] = await conn.execute(
  `UPDATE user_totp
      SET last_used_step = ?
    WHERE user_id = ? AND status = 'enabled' AND last_used_step < ?`,
  [usedStep, userId, usedStep],
);

if ((res as { affectedRows: number }).affectedRows === 0) {
  throw new TotpReplayError();
}
```

조건을 담은 갱신으로 경합을 끝내는 방식은 [낙관적 잠금 글](/blog/optimistic-locking-lost-update/)과 같은 패턴입니다.

> `last_used_step`을 쓰면 **앞선 step으로 성공한 직후 더 작은 step의 코드는 거부됩니다.**
> ±1 창을 열어둔 상태에서 사용자가 연달아 두 번 로그인하면 두 번째가 실패할 수 있습니다.
> 이건 의도된 동작이고, 오류 메시지를 "코드가 틀렸습니다"가 아니라 "다음 코드가 나올 때까지 기다려 주세요"로 구분해주면 문의가 줄어듭니다.

## 6자리는 생각보다 작다

경우의 수는 100만입니다. ±1 창이면 동시에 3개가 유효하므로, 한 번 찍어서 맞을 확률은 `3 / 1,000,000`입니다.
작아 보이지만 시도 횟수를 제한하지 않으면 다른 이야기가 됩니다.

| 시도 횟수 | 성공 확률 |
| --- | --- |
| 5회 | 약 0.0015% |
| 1,440회 (분당 1회로 하루) | 약 0.43% |
| 14,400회 (분당 10회로 하루) | 약 4.2% |
| 100,000회 | 약 26% |

비밀번호가 이미 유출된 계정을 노린다면 **하루 두드려서 4%**는 충분히 해볼 만한 수치입니다. 대상 계정이 많으면 그중 몇 개는 뚫립니다.

그래서 제한은 선택이 아닙니다. 기준은 IP가 아니라 **계정**입니다. IP 기준으로만 막으면 분산된 요청에 그대로 통과합니다.

```typescript
const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

export async function verifyWithThrottle(userId: number, code: string) {
  const state = await loadTotpState(userId);
  if (state.lockedUntil && state.lockedUntil > new Date()) {
    throw new TotpLockedError(state.lockedUntil);
  }

  const result = verifyTotp(state.secret, code);
  if (!result.ok) {
    const failures = await incrementFailure(userId);
    if (failures >= MAX_FAILURES) {
      await lockFor(userId, LOCK_MINUTES);
      await notifyUser(userId, "two_factor_locked"); // 본인이 아니라면 알아야 한다
    }
    throw new TotpInvalidError();
  }

  await consumeStep(userId, result.usedStep); // 위의 조건부 UPDATE
  await resetFailures(userId);
  return state;
}
```

실패 카운터는 **성공할 때 초기화**합니다. 이걸 빼먹으면 오래 쓴 계정이 어느 날 갑자기 잠깁니다.
잠금은 영구가 아니라 시간 기반으로 두는 편이 낫습니다. 영구 잠금은 공격자가 남의 계정을 잠가버리는 수단이 됩니다.
속도 제한 자체의 구현은 [레이트 리밋 글](/blog/rate-limiting-token-bucket-redis/)에서 다룬 방식을 그대로 쓸 수 있습니다.

## 등록에서 사용자를 잠그는 실수

가장 흔한 사고는 공격이 아니라 등록 절차에서 납니다. 비밀키를 만들어 저장하고 바로 "2단계 인증 켜짐"으로 바꾸면, QR을 제대로 스캔하지 못한 사용자는 **그 즉시 로그인할 수 없게 됩니다.**

상태를 하나 더 둬서 막습니다.

```text
disabled ──비밀키 발급──> pending ──코드 1회 검증──> enabled
                            │
                            └── 만료/취소 ──> disabled (비밀키 폐기)
```

`pending` 상태에서는 로그인에 2단계 인증을 요구하지 않습니다. 사용자가 코드를 한 번 맞혀야 `enabled`로 올립니다.
`pending`에는 만료를 둬서, 중간에 이탈한 비밀키가 계정에 계속 남지 않게 합니다.

QR에 담는 값은 `otpauth` URI입니다. 라벨과 발급자 값은 URI 인코딩이 필요합니다.

```typescript
export function otpauthUri(params: {
  issuer: string;      // 서비스 이름
  account: string;     // 보통 이메일
  secretBase32: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.account}`);
  const query = new URLSearchParams({
    secret: params.secretBase32,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}
```

비밀키는 QR용으로 base32(RFC 4648)로 인코딩합니다. 16진수나 base64로 주면 앱이 읽지 못합니다.

```typescript
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// 비밀키는 20바이트(160비트) 이상 난수로 만든다
const secret = randomBytes(20);
const uri = otpauthUri({ issuer: "Example", account: "me@example.com", secretBase32: base32Encode(secret) });
```

저장에서 지켜야 할 것은 세 가지입니다.

- **암호화해서 저장합니다.** 비밀키는 비밀번호와 달리 복호화가 필요하므로 해시가 아니라 암호화입니다. 키 관리는 [개인정보 암호화 글](/blog/pii-column-encryption-blind-index/)과 같은 문제가 됩니다.
- **활성화 이후에는 다시 보여주지 않습니다.** "비밀키 다시 보기"는 비밀번호만 알면 두 번째 요소를 복제할 수 있는 창구입니다.
- **로그에 남기지 않습니다.** 요청 본문을 통째로 찍는 로깅이 켜져 있으면 등록 요청에서 비밀키가 그대로 남습니다.

{% comment %} TODO: 실제로 등록 흐름을 어떻게 구성했는지, pending 만료 시간을 얼마로 뒀는지 적어주세요 {% endcomment %}

## 로그인 흐름이 두 단계로 갈라진다

1단계를 통과한 사용자에게 무엇을 줄지가 설계 지점입니다. 여기서 평소의 세션을 발급해버리면 2단계 인증은 장식이 됩니다.

용도가 한정된 짧은 수명의 중간 토큰을 발급합니다.

```typescript
type PendingMfaToken = {
  sub: number;
  purpose: "mfa_challenge";  // 이 토큰으로는 다른 API를 쓸 수 없다
  exp: number;               // 5분 내외
  jti: string;               // 1회 사용 후 폐기
};
```

인증 미들웨어가 `purpose`를 확인해야 합니다. 서명만 검증하고 통과시키면 중간 토큰이 액세스 토큰과 같은 권한을 갖습니다.
2단계까지 통과한 뒤에 실제 세션을 발급하고, 그 수명과 폐기는 [리프레시 토큰 글](/blog/refresh-token-rotation-revocation/)의 구조를 따릅니다.

로그인뿐 아니라 **민감한 작업 앞에서도 다시 물어야** 합니다. 2단계 인증 해제, 이메일·비밀번호 변경, 복구 코드 재발급이 대표적입니다.
세션을 탈취한 공격자가 가장 먼저 하는 일이 두 번째 요소를 끄는 것이기 때문입니다.

"이 기기에서 30일간 묻지 않기"를 넣는다면 신뢰 기기 토큰은 사용자·기기에 묶고, 비밀번호 변경이나 2단계 인증 설정 변경 시 **전부 폐기**합니다.
쿠키로 둘 때의 속성 선택은 [쿠키 글](/blog/cookie-samesite-domain-secure/)에 적어둔 것과 같습니다.

## 복구 수단이 실제 보안 수준을 정한다

폰을 잃어버린 사용자는 반드시 생깁니다. 복구 경로가 없으면 계정 복구는 고객 응대로 넘어가고, 급하게 만든 예외 처리가 결국 우회로가 됩니다.

**복구 경로는 2단계 인증과 같은 강도여야 합니다.** 가장 약한 경로가 전체 강도를 정합니다.

| 수단 | 사용자 부담 | 약한 지점 |
| --- | --- | --- |
| 복구 코드 | 보관해야 함 | 캡처해서 방치하면 그대로 노출 |
| 백업 이메일 | 낮음 | 메일 계정이 뚫리면 같이 뚫림 |
| SMS | 낮음 | 번호 이전·가로채기 |
| 기기 여러 대 등록 | 등록 시 수고 | 기기를 한꺼번에 잃는 경우 |
| 관리자 해제 | 없음 | 사칭 요청. 운영 절차가 곧 보안 |

복구 코드는 고엔트로피 난수로 만들고, 저장은 해시로, 사용은 1회로 제한합니다.

```typescript
// 사용자에게는 생성 직후 한 번만 보여준다
function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () =>
    base32Encode(randomBytes(10)).toLowerCase(), // 10바이트 = base32 16글자
  );
}
```

> 복구 코드는 사용자가 만든 비밀번호가 아니라 충분한 엔트로피를 가진 난수라, 비밀번호 해시만큼 느린 함수가 꼭 필요하지는 않습니다.
> 다만 코드 길이를 짧게 줄였다면 그 전제가 깨집니다. 판단이 애매하면 **기존 비밀번호 해시와 같은 방식을 쓰는 편**이 안전합니다.

소비는 TOTP step과 마찬가지로 조건부 갱신으로 처리하고, 사용되면 사용자에게 알립니다.

```sql
UPDATE user_recovery_code
   SET used_at = NOW()
 WHERE user_id = ? AND code_hash = ? AND used_at IS NULL;
```

남은 개수를 화면에 보여주고, 다 쓰기 전에 재발급을 유도합니다. 재발급은 **기존 코드 전체를 무효화**해야 합니다.

놓치기 쉬운 우회로가 하나 더 있습니다. **비밀번호 재설정으로 2단계 인증이 함께 풀리는 구조**입니다.
메일로 재설정 링크를 받아 비밀번호를 바꾸면 로그인되는 흐름이라면, 메일 계정 하나로 두 번째 요소가 무력화됩니다.
재설정 이후에도 2단계 인증을 그대로 요구하거나, 재설정 흐름 안에서 복구 코드를 받아야 합니다.

관리자 해제 경로를 만든다면 그 자체가 공격 대상이라고 보고 설계하세요. 요청자 확인 절차를 문서로 정하고, 누가 누구의 2단계 인증을 언제 해제했는지 전부 남깁니다.
이 기록은 [감사 로그](/blog/audit-log-change-history/)에 들어가야 하는 전형적인 사건입니다.

{% comment %} TODO: 복구 코드 개수와 재발급 정책, 관리자 해제 절차를 실제로 어떻게 정했는지 적어주세요 {% endcomment %}

## 두 번째 요소를 무엇으로 할지

TOTP는 추가 비용이 들지 않고 외부 의존이 없다는 점에서 기본값으로 쓸 만합니다. 하지만 **피싱에 강하지는 않습니다.**
사용자가 가짜 페이지에 코드를 넣으면 공격자가 30초 안에 그대로 중계할 수 있습니다. 앞에서 재사용을 막은 것은 같은 코드의 두 번째 사용을 막는 것이지, 첫 번째 사용이 공격자 쪽에서 일어나는 것을 막지는 못합니다.

| 수단 | 피싱 저항 | 도입 비용 | 걸리는 지점 |
| --- | --- | --- | --- |
| SMS·이메일 코드 | 없음 | 발송 비용·도달률 | 번호 이전, 메일 계정 탈취 |
| TOTP | 없음 | 낮음 | 기기 분실, 시계 |
| 푸시 승인 | 낮음 | 앱 필요 | 습관적 승인 |
| 패스키(WebAuthn) | 있음 | 구현·기기 요건 | 기기 간 이동, 복구 설계 |

출발점으로는 TOTP, 민감한 권한을 가진 계정에는 피싱 저항이 있는 수단을 요구하는 조합이 현실적입니다.
WebAuthn 쪽은 브라우저·플랫폼 지원과 등록 흐름이 계속 바뀌는 영역이라, 도입을 검토한다면 현행 공식 문서를 기준으로 삼으세요.

공용 단말을 쓰는 환경이라면 선택이 또 달라집니다. 한 기기를 여러 사람이 번갈아 쓰는 자리에서는 "이 기기를 기억하기"가 위험해지고,
개인 폰을 업무에 쓰지 않는 사용자에게 TOTP 앱 설치를 요구하는 것이 그대로 도입 장벽이 됩니다. 사용자층을 보고 정할 문제입니다.

## 정리

1. 코드 계산은 명세대로 쓰면 끝난다. 어려운 곳은 시계, 재사용, 등록, 복구다.
2. 허용 창은 ±1에서 시작한다. 넓히면 무차별 대입 성공률이 같이 올라간다.
3. 전체 사용자가 동시에 실패하면 서버 시계를 먼저 본다. 성공한 drift의 분포를 기록해두면 미리 보인다.
4. 사용한 step을 조건부 갱신으로 소비해 같은 코드의 재사용을 막는다.
5. 6자리는 100만이다. 시도 제한이 없으면 하루 두드려서 뚫린다. 제한은 계정 기준으로 건다.
6. `pending` 상태를 거치지 않고 활성화하면 사용자를 잠근다. 코드 1회 검증을 반드시 요구한다.
7. 1단계 통과 후에는 용도가 한정된 짧은 토큰만 준다. 민감한 작업 앞에서는 다시 묻는다.
8. 복구 경로가 가장 약한 지점이다. 비밀번호 재설정이 2단계 인증을 함께 풀어버리지 않는지 확인한다.

두 번째 요소를 붙이는 비용은 대부분 로그인 화면이 아니라 **복구와 운영 절차**에 들어갑니다.
그 부분을 먼저 정하지 않으면, 켜고 나서 예외 처리를 만드는 쪽으로 밀려가고 결국 우회로가 남습니다.
