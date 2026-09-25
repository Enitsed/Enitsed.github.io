---
layout: post
title: "로그아웃시켰는데 토큰이 계속 통한다 — 리프레시 토큰 회전과 무효화"
date: 2026-09-26
tags: [backend, auth, security, redis, typescript]
excerpt: "무상태 JWT 검증은 빠른 대신 '이 세션을 지금 끊는다'를 못 합니다. 수명을 둘로 나누는 구조, 리프레시 토큰 회전과 재사용 탐지, 그 탐지가 멀쩡한 사용자를 로그아웃시키는 경쟁 조건, 그리고 즉시 무효화를 위해 어디까지 상태를 되살릴지."
---

계정이 탈취됐다는 신고를 받고 관리자 화면에서 세션을 끊었습니다.
그런데 공격자의 요청은 그 뒤로도 한동안 200을 받습니다.

서버가 토큰을 자기 힘으로 검증하도록 만든 순간, "이 토큰은 이제 무효"라고 말할 자리가 사라졌기 때문입니다.
무상태 검증으로 얻은 속도의 값을 이 지점에서 치릅니다.

## 무상태 검증이 사는 것과 포기하는 것

세션 방식은 요청마다 저장소를 조회합니다. 쿠키에 담긴 건 식별자뿐이고, 그 식별자로 서버가 세션을 찾습니다.
느려 보이지만 대신 **세션 행을 지우면 그 순간 로그아웃**입니다.

서명된 토큰은 반대입니다. 토큰 안에 사용자 식별자와 만료 시각이 들어 있고, 서버는 서명만 확인하면 됩니다.
조회가 없으니 인증 서버가 죽어도 리소스 서버는 계속 인증을 처리합니다. 그리고 바로 그 이유로 **취소를 모릅니다.**

| | 서버 세션 | 서명된 토큰(무상태) |
| --- | --- | --- |
| 요청당 저장소 조회 | 필요 | 없음 |
| 즉시 로그아웃 | 행 삭제로 즉시 | 만료까지 유효 |
| 수평 확장 | 세션 저장소 공유 필요 | 검증 키만 배포 |
| 탈취 시 피해 범위 | 끊으면 끝 | 만료까지 |

여기서 흔한 오해 하나를 정리해둘 필요가 있습니다.
클라이언트에서 토큰을 지우는 건 로그아웃이 아닙니다. 그건 **그 클라이언트가 토큰을 그만 쓰는 것**일 뿐이고, 이미 복사해 간 쪽에는 아무 영향이 없습니다.

## 그래서 수명을 두 개로 나눈다

무상태 검증을 유지하면서 피해 범위를 줄이는 표준적인 방법은 토큰을 두 종류로 쪼개는 것입니다.

- **액세스 토큰** — 모든 API 요청에 실립니다. 무상태로 검증하고, 수명을 짧게 둡니다.
- **리프레시 토큰** — 인증 서버의 토큰 갱신 엔드포인트에만 보냅니다. 수명이 길고, **저장소에 기록됩니다.**

액세스 토큰의 수명이 곧 "취소가 늦어지는 최대 시간"입니다. 5분이면 최악의 경우 5분간 공격자가 통과합니다.
그렇다고 30초로 줄이면 갱신 요청이 그만큼 잦아져 인증 서버가 사실상 세션 조회 서버가 됩니다. 무상태로 얻으려던 이득이 사라지는 지점입니다.

리프레시 토큰은 성격이 완전히 다릅니다. 이건 **조회해서 검증합니다.** 저장소에 있으니 지울 수 있고, 지우면 갱신이 막힙니다.

> 리프레시 토큰을 JWT로 만들 이유는 거의 없습니다. 어차피 매번 저장소를 조회하니 자기 기술 정보가 필요 없고,
> 형식이 불투명할수록 클라이언트가 내용을 해석해 의존하는 일을 막습니다. 충분한 엔트로피의 임의 문자열이면 됩니다.

```typescript
import { randomBytes, createHash } from 'node:crypto';

// 256비트 임의값. 원문은 클라이언트에만 주고, 저장소에는 해시만 남긴다
const raw = randomBytes(32).toString('base64url');
const hash = createHash('sha256').update(raw).digest('hex');
```

저장 전에 해시하는 이유는 비밀번호와 같습니다. DB가 유출되면 저장된 리프레시 토큰은 그대로 남의 세션이 됩니다.
다만 비밀번호와 달리 **bcrypt 같은 느린 해시가 필요 없습니다.** 256비트 임의값은 사전 공격 대상이 아니라서, SHA-256으로 충분하고 조회도 빠릅니다.

## 회전 — 훔친 것을 쓰면 드러나게 만든다

리프레시 토큰은 수명이 길어서, 한 번 새면 오래 쓰입니다. 그래서 **쓸 때마다 바꿉니다.**
갱신 요청이 오면 기존 토큰을 즉시 무효로 만들고 새 토큰을 발급합니다. 이것이 회전(rotation)입니다.

회전 자체가 탈취를 막지는 못합니다. 회전이 주는 건 **탐지**입니다.
토큰이 한 번만 유효하다면, 같은 토큰이 두 번 제출됐다는 건 사본이 존재한다는 뜻입니다.

그 판단을 하려면 쓰고 버린 토큰도 기록에 남아 있어야 합니다. 그래서 삭제하지 않고 상태를 표시합니다.

```sql
CREATE TABLE refresh_tokens (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  token_hash   CHAR(64)        NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,
  family_id    CHAR(36)        NOT NULL,   -- 최초 로그인 단위로 묶는 식별자
  used_at      DATETIME(3)     NULL,       -- 갱신에 쓰인 시각
  revoked_at   DATETIME(3)     NULL,
  expires_at   DATETIME(3)     NOT NULL,
  created_at   DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_token_hash (token_hash),
  KEY idx_family (family_id),
  KEY idx_user (user_id, expires_at)
) ENGINE=InnoDB;
```

`family_id`가 핵심입니다. 한 번의 로그인에서 파생된 토큰들이 전부 같은 값을 갖습니다.
재사용이 탐지되면 그 토큰 하나만 막아서는 소용이 없습니다. 이미 공격자 쪽에 다음 토큰이 넘어갔을 수 있으니, **계보 전체를 끊어야** 합니다.

```typescript
async function rotate(rawToken: string) {
  const hash = sha256(rawToken);

  return db.transaction(async (tx) => {
    const row = await tx.one(
      `SELECT * FROM refresh_tokens WHERE token_hash = ? FOR UPDATE`, [hash],
    );

    if (!row) throw new Unauthorized('unknown_token');
    if (row.revoked_at) throw new Unauthorized('revoked');
    if (row.expires_at <= new Date()) throw new Unauthorized('expired');

    // 이미 쓰인 토큰이 다시 왔다 = 사본이 돌아다닌다
    if (row.used_at) {
      await tx.run(
        `UPDATE refresh_tokens SET revoked_at = NOW(3)
          WHERE family_id = ? AND revoked_at IS NULL`, [row.family_id],
      );
      throw new Unauthorized('reuse_detected');
    }

    await tx.run(
      `UPDATE refresh_tokens SET used_at = NOW(3) WHERE id = ?`, [row.id],
    );
    return issue(row.user_id, row.family_id, tx);   // 같은 계보로 다음 토큰 발급
  });
}
```

`FOR UPDATE`가 빠지면 이 로직은 구멍이 납니다. 같은 토큰으로 두 요청이 동시에 들어오면 둘 다 `used_at IS NULL`을 읽고 둘 다 통과합니다.
회전의 전제인 "한 번만 유효"가 거기서 깨집니다.

> [RFC 9700](https://www.rfc-editor.org/info/rfc9700/)은 공개 클라이언트의 리프레시 토큰에 대해 **발신자 제한(sender-constrained)이나 회전 중 하나를 요구**합니다.
> 발신자 제한은 mTLS나 DPoP로 토큰을 특정 키에 묶는 방식이고, 회전보다 강하지만 클라이언트 구현 부담이 큽니다.
> 회전은 그중 도입 비용이 낮은 쪽을 고른 선택이라고 보면 됩니다.

## 탐지가 멀쩡한 사용자를 로그아웃시킬 때

여기까지 구현하고 배포하면 재현이 어려운 로그아웃 신고가 들어옵니다.
공격이 아닙니다. **정상 클라이언트가 스스로 재사용을 만들어냅니다.**

액세스 토큰이 만료된 시점에 요청 세 개가 동시에 떠 있었다고 해봅시다. 셋 다 401을 받고, 셋 다 갱신을 호출합니다.
가장 빠른 하나가 회전에 성공하고, 나머지 둘은 이미 `used_at`이 찍힌 토큰을 제출합니다. 서버는 규칙대로 계보 전체를 끊습니다.

탭을 여러 개 띄운 경우, 앱이 백그라운드에서 복귀하며 여러 요청을 한꺼번에 재개하는 경우도 같습니다.
탐지 규칙은 정확히 설계한 대로 동작했고, 결과는 무작위 로그아웃입니다.

제대로 된 해결은 클라이언트 쪽입니다. **갱신 요청을 하나로 합칩니다.**
[캐시 스탬피드](/blog/cache-stampede-swr/)에서 미스를 한 번으로 묶는 것과 같은 구조입니다.

```typescript
let inflight: Promise<string> | null = null;

async function getAccessToken(): Promise<string> {
  if (!isExpired(current)) return current.accessToken;

  // 동시에 여러 요청이 들어와도 갱신은 한 번만 나간다
  inflight ??= refresh()
    .then((res) => { current = res; return res.accessToken; })
    .finally(() => { inflight = null; });

  return inflight;
}
```

같은 프로세스 안에서는 이걸로 끝나지만, 탭이 여러 개면 프로세스가 여러 개입니다.
이쪽은 저장소 잠금이나 `BroadcastChannel`로 탭 간에 갱신 주체를 하나로 정해야 하고, 확실하게 만들기가 생각보다 까다롭습니다.

그래서 서버에도 완충을 두는 선택이 있습니다. 회전 직후 아주 짧은 창 안에 들어온 재사용은 **공격으로 보지 않고 통과시키는** 방식입니다.

```typescript
const GRACE_MS = 10_000;

if (row.used_at) {
  const withinGrace = Date.now() - row.used_at.getTime() < GRACE_MS;
  if (!withinGrace) {
    await revokeFamily(tx, row.family_id);
    throw new Unauthorized('reuse_detected');
  }
  // 창 안이면 계보를 유지한 채 다음 토큰을 하나 더 발급한다
  return issue(row.user_id, row.family_id, tx);
}
```

공짜가 아닙니다. 이 창은 그대로 공격자의 창이기도 합니다.
훔친 토큰을 10초 안에 쓰면 탐지되지 않고, 한 계보에 유효한 토큰이 둘 이상 생깁니다.

원래 발급한 토큰을 **다시 내려주는** 방법도 있습니다. 재사용 요청에 같은 결과를 돌려주면 계보가 갈라지지 않습니다.
다만 해시만 저장한다는 원칙을 깨고 토큰 원문을 잠시 보관해야 해서, 유출 시 피해가 커집니다. 저장 기간을 창 길이로 묶더라도 판단이 필요한 거래입니다.

정리하면 이렇게 갈립니다.

| 방식 | 탐지 정확도 | 비용 |
| --- | --- | --- |
| 클라이언트 단일화 | 유지 | 클라이언트 구현, 탭 간 조율 |
| 짧은 유예 창 | 창 길이만큼 약화 | 서버 몇 줄 |
| 발급 결과 재생 | 유지 | 토큰 원문을 일시 보관 |

## 액세스 토큰을 지금 끊어야 할 때

회전은 리프레시 토큰의 문제를 다룹니다. 계보를 끊어도 **이미 발급된 액세스 토큰은 만료까지 살아 있습니다.**
평소에는 그 창을 감수하고, 감수할 수 없는 사건에서만 상태를 되살립니다.

가장 싼 방법은 사용자별 기준 시각 하나를 두는 것입니다.

```typescript
// 비밀번호 변경, 전체 기기 로그아웃 등에서 이 값을 현재 시각으로 올린다
await redis.set(`revoke:user:${userId}`, Date.now().toString());

// 검증 미들웨어
const claims = verifyJwt(token);                 // 서명·만료 확인
const boundary = Number(await redis.get(`revoke:user:${claims.sub}`) ?? 0);
if (claims.iat * 1000 < boundary) throw new Unauthorized('revoked');
```

키가 사용자당 하나뿐이라 작고, 조회 결과를 짧게 캐시하면 부하도 크지 않습니다.
대신 **해상도가 사용자 단위**입니다. 기기 하나만 끊을 수 없습니다.

기기 단위로 끊어야 하면 토큰마다 식별자(`jti`)를 넣고 차단 목록을 둡니다.

```typescript
const claims = verifyJwt(token);
if (await redis.exists(`deny:jti:${claims.jti}`)) throw new Unauthorized('revoked');

// 무효화할 때: 액세스 토큰의 남은 수명만큼만 기억하면 된다
const ttl = claims.exp - Math.floor(Date.now() / 1000);
if (ttl > 0) await redis.set(`deny:jti:${claims.jti}`, '1', { EX: ttl });
```

차단 목록이 무한히 자라지 않는 건 TTL을 남은 수명에 맞추기 때문입니다. 만료된 토큰은 서명 검증에서 이미 걸리니 기억할 필요가 없습니다.
액세스 토큰 수명이 5분이면 목록의 크기는 최근 5분간 무효화된 토큰 수로 묶입니다.

여기서 무상태의 이점을 일부 되사는 셈이라는 걸 인정하는 편이 낫습니다.
요청마다 Redis 조회가 붙고, Redis가 흔들리면 인증 경로가 같이 흔들립니다. 조회 실패 시 통과시킬지 거절할지를 **미리 정해두어야** 합니다.
통과시키면 무효화가 새고, 거절하면 캐시 장애가 전면 장애가 됩니다.

> 이 판단은 서비스 성격이 결정합니다. 다만 어느 쪽이든 의식적으로 골라야 하고,
> 라이브러리 기본값에 맡겨둔 채 모르고 있는 상태가 가장 나쁩니다.

## 토큰을 어디에 두는가

구현을 마쳐도 저장 위치를 잘못 고르면 앞의 설계가 무의미해집니다. 선택지에 안전한 쪽은 없고, **어느 공격을 더 막을지**가 있습니다.

`localStorage`는 자바스크립트로 읽힙니다. XSS 한 번이면 토큰이 그대로 나갑니다.
`HttpOnly` 쿠키는 스크립트가 읽지 못하지만, 브라우저가 자동으로 실어 보내므로 CSRF를 따로 막아야 합니다.

리프레시 토큰은 쿠키에 두는 편이 낫고, 이때 범위를 최대한 좁힙니다.

```text
Set-Cookie: rt=<token>; HttpOnly; Secure; SameSite=Strict;
            Path=/auth/refresh; Max-Age=1209600
```

`Path`를 갱신 엔드포인트로 제한하면 일반 API 요청에는 리프레시 토큰이 실리지 않습니다.
매 요청에 실려 다니는 비밀은 실릴 기회만큼 샐 기회도 갖습니다.

액세스 토큰은 메모리에 두고 `Authorization` 헤더로 보내는 쪽이 단순합니다.
새로고침하면 사라지지만, 어차피 갱신 엔드포인트가 쿠키로 다시 발급해줍니다. 수명이 짧아 손해도 작습니다.

## 무엇부터 할지

전부 한 번에 도입할 필요는 없습니다. 순서가 있습니다.

1. **액세스 토큰 수명을 줄인다** — 취소 지연의 상한을 먼저 정합니다. 코드 변경이 가장 적습니다.
2. **리프레시 토큰을 해시해서 저장한다** — 이미 저장하고 있다면 원문인지 확인합니다.
3. **회전과 계보 무효화를 넣는다** — 반드시 `FOR UPDATE`와 함께.
4. **클라이언트 갱신을 단일화한다** — 3번과 같이 배포해야 합니다. 순서가 어긋나면 무작위 로그아웃이 먼저 옵니다.
5. **즉시 무효화가 필요한 사건을 나열한다** — 목록이 비어 있으면 차단 목록은 만들지 않아도 됩니다.

5번을 먼저 만들고 싶은 충동이 드는데, 실제로 필요한 사건이 무엇인지 적어보면 대개 비밀번호 변경과 관리자 강제 로그아웃 둘뿐입니다.
그 둘은 사용자 단위 기준 시각으로 해결되고, 기기 단위 차단 목록은 필요해질 때 붙이면 됩니다.

{% comment %} TODO: Cognito 같은 관리형 인증에서는 회전과 무효화를 어디까지 서비스가 해주고 어디부터 직접 구현했는지, 실제로 고른 액세스 토큰 수명과 그 근거를 적어주세요 {% endcomment %}
