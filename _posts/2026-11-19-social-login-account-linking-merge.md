---
layout: post
title: "구글로 가입한 사람이 애플로 다시 로그인했다 — 소셜 계정 연결과 병합"
date: 2026-11-19
tags: [backend, auth, security, typescript, mysql]
excerpt: "소셜 로그인을 두 개 이상 붙이면 같은 사람에게 계정이 두 개 생긴다. 이메일로 자동 병합하면 해결되는 것처럼 보이지만 그게 계정 탈취 경로가 되는 이유, 공급자가 주는 이메일을 어디까지 믿을 수 있는지, 이미 쪼개진 계정을 합치는 비용."
---

소셜 로그인 버튼이 하나일 때는 아무 문제가 없습니다. 둘이 되는 순간 같은 사람이 두 사람이 됩니다.

구글로 가입했던 사용자가 다음 달에 애플 버튼을 누르면, 서버는 처음 보는 식별자를 받고 새 계정을 만듭니다.
사용자 화면에서는 "내 데이터가 사라졌다"로 보이고, 문의가 들어옵니다.

가장 먼저 떠오르는 해결책은 이메일로 묶는 것입니다. 그리고 그게 계정 탈취 경로가 됩니다.

## 테이블에 provider 컬럼을 두면 두 번째를 붙일 수 없다

처음 소셜 로그인을 붙일 때 가장 자연스러운 스키마는 이렇습니다.

```sql
CREATE TABLE users (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email        VARCHAR(255) NOT NULL,
  provider     VARCHAR(32)  NOT NULL,   -- 'google' | 'apple' | ...
  provider_uid VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_provider (provider, provider_uid)
);
```

공급자가 하나일 때는 이게 가장 읽기 쉬운 구조입니다.
문제는 한 사용자가 공급자를 **두 개 가질 수 없다**는 점입니다. `users` 한 행에 `provider`가 하나뿐이니, 두 번째 공급자는 새 행이 될 수밖에 없습니다.

사람과 로그인 수단은 수명이 다릅니다. 사람은 하나고, 로그인 수단은 늘어나고 없어집니다.
그러면 테이블도 둘이어야 합니다.

```sql
CREATE TABLE users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  display_name  VARCHAR(100) NULL,
  primary_email VARCHAR(255) NULL,       -- 표시·연락용. 식별자가 아니다
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
);

CREATE TABLE user_identities (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  issuer          VARCHAR(255) NOT NULL,   -- 'https://accounts.google.com'
  subject         VARCHAR(255) NOT NULL,   -- ID 토큰의 sub
  email           VARCHAR(255) NULL,       -- 공급자가 준 값의 사본(캐시)
  email_verified  TINYINT(1)   NOT NULL DEFAULT 0,
  linked_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_issuer_subject (issuer, subject),
  KEY ix_user (user_id),
  CONSTRAINT fk_identity_user FOREIGN KEY (user_id) REFERENCES users (id)
);
```

여기서 결정이 두 개 들어가 있습니다.

첫째, 식별자는 `(issuer, subject)`입니다. OIDC에서 `sub`는 **발급자 안에서만** 유일하기 때문에, `sub` 하나만 저장하면 공급자가 늘어난 뒤 충돌 가능성을 남깁니다.
두 공급자가 같은 문자열을 `sub`로 쓸 이유는 없지만, 그걸 보장해주는 규약도 없습니다.

둘째, `users.primary_email`에는 유니크 제약이 없습니다. 이메일을 유니크로 잡으면 이메일이 사실상 기본키가 되고, 나중에 이메일이 바뀌거나 비어 있는 사용자를 받을 수 없게 됩니다.
`user_identities.email`은 공급자가 준 값의 **사본**이지 신뢰 근거가 아닙니다. 공급자 쪽에서 이메일이 바뀌면 이 값은 조용히 낡습니다.

## 로그인 한 번에 분기가 네 개다

콜백 하나를 처리하는 동안 실제로는 서로 다른 상황 네 가지를 구분해야 합니다.

| 상황 | 판단 근거 | 해야 할 일 |
| --- | --- | --- |
| 돌아온 사용자 | `(issuer, subject)`가 이미 있다 | 그 `user_id`로 로그인 |
| 완전 신규 | identity 없고 일치하는 계정도 없다 | `users` + `user_identities` 생성 |
| 같은 사람일 가능성 | identity는 없는데 이메일이 겹친다 | **여기가 문제 지점** |
| 이미 로그인한 사용자의 추가 연결 | 세션이 있는 상태로 콜백 | 현재 `user_id`에 identity 추가 |

첫 번째와 두 번째는 고민할 게 없습니다. 네 번째는 뒤에서 따로 보겠습니다.
사고가 나는 자리는 세 번째입니다.

## 이메일이 같다고 같은 사람이 아니다

세 번째 분기를 "이메일이 같으면 그 계정에 붙인다"로 구현하면 동작은 합니다. 그리고 공격 경로가 하나 열립니다.

순서를 뒤집어보면 보입니다.

1. 공격자가 피해자의 이메일로 **먼저** 가입합니다. 비밀번호 가입이든 매직링크 요청이든, 이메일 소유 증명 없이 행이 만들어지는 경로면 됩니다.
2. 그 계정은 `email_verified = false` 상태로 남아 있습니다. 아무 일도 일어나지 않습니다.
3. 나중에 피해자가 구글 버튼으로 로그인합니다. 서버는 "이메일이 같네"라고 판단하고 구글 identity를 **공격자가 만든 행**에 붙입니다.
4. 피해자는 정상적으로 서비스를 씁니다. 공격자도 자기가 설정한 비밀번호로 같은 계정에 들어옵니다.

이건 가설이 아니라 2022년 USENIX 보안 학회에서 정리된 계정 선점(pre-hijacking) 유형이고, 2026년에도 널리 쓰이는 인증 라이브러리들에서 같은 형태의 취약점이 계속 보고되고 있습니다.
공통된 원인도 같습니다. **공급자가 보낸 `email_verified`만 확인하고, 붙이려는 로컬 계정이 검증됐는지는 보지 않는 것.**

> 더 고약한 건 연결 직후 공격자의 행이 "검증됨"으로 승격되는 구현입니다.
> "이메일 인증을 강제하면 된다"는 대응이 여기서 무력화됩니다. 피해자의 정상 로그인이 공격자의 계정을 대신 검증해주기 때문입니다.

그래서 자동 연결을 허용하려면 **양쪽**을 봐야 합니다.

```typescript
type ClaimSet = {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
};

async function canAutoLink(claims: ClaimSet, candidate: UserRow): Promise<boolean> {
  // 1) 공급자가 이메일 소유를 검증했는가
  if (!claims.email || !claims.emailVerified) return false;

  // 2) 붙이려는 로컬 계정도 그 이메일을 검증한 상태인가
  if (!candidate.emailVerified) return false;

  // 3) 그 계정에 비밀번호·매직링크 같은 다른 로그인 수단이 걸려 있다면
  //    자동으로 붙이지 않는다. 소유자가 직접 확인하게 만든다.
  if (await hasLocalCredential(candidate.id)) return false;

  return true;
}
```

세 번째 조건까지 넣으면 자동 연결이 통과하는 경우가 꽤 줄어듭니다. 그게 의도한 결과입니다.
자동 연결은 편의 기능이고, 편의를 포기해서 막을 수 있는 실패가 계정 탈취라면 포기하는 쪽이 싸게 끝납니다.

## 공급자가 주는 이메일을 어디까지 믿을 수 있는가

`email_verified`를 보라는 말에는 전제가 하나 있습니다. 그 클레임이 항상 오고, 항상 같은 모양이라는 전제입니다. 둘 다 사실이 아닙니다.

- **타입이 다릅니다.** OIDC 스펙은 boolean이지만, Apple은 문자열 `"true"`로 보낼 수 있다고 문서에 적어두었습니다. `if (claims.email_verified)`로 끝내면 문자열 `"false"`가 참이 됩니다.
- **이메일이 아예 없을 수 있습니다.** 가려진 전달 주소를 쓰는 경우가 있고, 이메일 제공이 선택 동의인 공급자도 있습니다. 동의하지 않으면 `email`은 비어서 옵니다.
- **가려진 주소는 도메인으로 판별하지 않습니다.** 전달 주소 여부를 알려주는 클레임이 따로 있고, 그 도메인은 공급자 사정으로 바뀔 수 있습니다. 도메인 접미사를 코드에 박아두면 그게 바뀌는 날 가입이 막힙니다.

그러니 콜백에서 가장 먼저 할 일은 클레임 정규화입니다.

```typescript
function toBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v.toLowerCase() === "true";
  return false;                       // 없거나 모르는 모양이면 검증 안 된 것으로
}

function normalize(raw: Record<string, unknown>): ClaimSet {
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : null;
  return {
    issuer: String(raw.iss),
    subject: String(raw.sub),
    email,
    emailVerified: email !== null && toBool(raw.email_verified),
  };
}
```

`toBool`이 모르는 값을 `false`로 떨어뜨리는 게 핵심입니다. 인증 코드에서 모호한 입력의 기본값은 항상 "권한 없음" 쪽이어야 합니다.

이메일 비교 전에 소문자로 맞추는 것도 빠뜨리기 쉽습니다. 같은 사용자가 대문자가 섞인 주소로 돌아오면 자동 연결이 안 되고, 반대로 DB 콜레이션이 대소문자를 무시하는데 애플리케이션이 구분하면 판단이 엇갈립니다.

> 이메일 정규화를 여기서 더 밀어붙이는 건 권하지 않습니다. 점을 지우거나 `+` 뒤를 자르는 정규화는 공급자별 규칙이고, 서로 다른 두 사람을 같은 사람으로 만들 수 있습니다.

## 자동 연결 대신 명시적 연결

세 번째 분기를 가장 안전하게 처리하는 방법은 자동으로 붙이지 않는 것입니다.
identity가 없고 이메일만 겹치면 새 계정을 만들거나, 로그인을 멈추고 **이미 가진 수단으로 로그인한 다음 연결하라고 안내**합니다.

연결은 로그인된 상태에서만 일어납니다.

```typescript
router.get("/auth/:provider/callback", async (req, res) => {
  const claims = normalize(await verifyIdToken(req.params.provider, req.query.code));
  const sessionUserId = req.session?.userId ?? null;

  const existing = await findIdentity(claims.issuer, claims.subject);

  // (A) 로그인 상태에서 돌아온 콜백 = 연결 의도
  if (sessionUserId) {
    if (existing && existing.userId !== sessionUserId) {
      // 그 공급자 계정은 이미 다른 사용자에게 묶여 있다. 조용히 옮기면 안 된다.
      return res.redirect("/settings/accounts?error=already_linked");
    }
    if (!existing) await linkIdentity(sessionUserId, claims);
    return res.redirect("/settings/accounts?linked=1");
  }

  // (B) 비로그인 = 로그인 의도
  if (existing) return login(res, existing.userId);

  const candidate = claims.email ? await findUserByVerifiedEmail(claims.email) : null;
  if (candidate && !(await canAutoLink(claims, candidate))) {
    return res.redirect("/login?hint=use_existing_method");
  }

  const userId = candidate ? candidate.id : await createUser(claims);
  await linkIdentity(userId, claims);
  return login(res, userId);
});
```

눈여겨볼 곳은 `existing.userId !== sessionUserId`입니다.
이미 다른 사용자에게 묶인 공급자 계정이 연결 요청으로 들어왔을 때 `user_id`를 그냥 업데이트해버리면, 그게 계정 이동 기능이 됩니다.
거절하고 사람이 판단하게 두는 게 맞습니다.

연결 시점에 **재인증**을 요구하는 것도 흔한 보강입니다. 세션을 탈취한 공격자가 자기 소셜 계정을 추가로 붙여서 영구적인 뒷문을 만드는 걸 막습니다.
비밀번호 재확인이나 OTP 한 번이면 되고, 적용 범위는 "연결"과 "해제" 두 동작입니다.

## 동시에 두 번 로그인하면 계정이 두 개 생긴다

신규 가입 경로에는 경합이 있습니다. 앱이 콜백을 두 번 보내거나 사용자가 버튼을 두 번 누르면, 두 요청이 나란히 "identity 없음"을 보고 각각 `users` 행을 만듭니다.
`user_identities`의 유니크 제약 때문에 둘 중 하나는 실패하는데, 그때 이미 만들어진 `users` 행이 고아로 남습니다.

트랜잭션으로 묶고, 유니크 제약 위반을 **정상 경로로** 처리하는 편이 간단합니다.

```typescript
async function createUserWithIdentity(claims: ClaimSet): Promise<number> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [r] = await conn.execute(
      "INSERT INTO users (primary_email) VALUES (?)",
      [claims.email],
    );
    const userId = (r as { insertId: number }).insertId;

    await conn.execute(
      `INSERT INTO user_identities (user_id, issuer, subject, email, email_verified)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, claims.issuer, claims.subject, claims.email, claims.emailVerified ? 1 : 0],
    );

    await conn.commit();
    return userId;
  } catch (e) {
    await conn.rollback();
    if ((e as { code?: string }).code === "ER_DUP_ENTRY") {
      // 다른 요청이 먼저 만들었다. 그쪽을 쓴다.
      const found = await findIdentity(claims.issuer, claims.subject);
      if (found) return found.userId;
    }
    throw e;
  } finally {
    conn.release();
  }
}
```

`ER_DUP_ENTRY`를 잡아서 조회로 돌리는 패턴입니다. 미리 조회해서 피하려는 시도는 두 요청이 같은 순간에 들어오면 똑같이 실패합니다.
**유니크 제약이 유일한 직렬화 지점**이고, 그 제약이 거절한 결과를 받아 처리하는 쪽이 확실합니다.

## 이미 두 계정이 생긴 뒤

스키마를 고치기 전에 가입한 사용자들은 이미 쪼개져 있습니다. 여기서 "병합"은 계정 통합이 아니라 **데이터 이관**입니다.

```sql
START TRANSACTION;

-- 1) 로그인 수단을 먼저 옮긴다
UPDATE user_identities SET user_id = :keep WHERE user_id = :drop;

-- 2) 자식 데이터를 옮긴다. 테이블마다 한 줄씩, 빠뜨리면 조용히 사라진다
UPDATE documents SET user_id = :keep WHERE user_id = :drop;
UPDATE comments  SET user_id = :keep WHERE user_id = :drop;

-- 3) 흔적을 남기고 원본은 지우지 않는다
INSERT INTO user_merges (kept_user_id, merged_user_id, merged_at, actor)
VALUES (:keep, :drop, NOW(3), :actor);

UPDATE users SET merged_into = :keep, deactivated_at = NOW(3) WHERE id = :drop;

COMMIT;
```

이 작업에서 실제로 발목을 잡는 건 두 가지입니다.

**유니크 제약 충돌.** 두 계정이 같은 조직에 같은 역할로 속해 있거나, 같은 항목을 각각 즐겨찾기 해뒀다면 `UPDATE`가 제약에 걸립니다.
테이블마다 "둘 다 가진 경우 어느 쪽을 남길지"를 정해야 하고, 그건 도메인 지식이라 자동화할 수 없습니다.

**되돌릴 수 없다는 점.** 옮긴 뒤에 "두 계정은 실제로 다른 사람이었다"가 밝혀지면 분리할 방법이 없습니다.
그래서 병합은 사용자가 버튼 한 번으로 실행하는 기능이 아니라, 소유 증명을 받은 뒤에 수행하는 운영 작업으로 두는 편이 안전합니다.
`merged_into`를 남겨 옛 `user_id`로 들어온 참조를 따라갈 수 있게 해두면, 캐시나 외부 시스템에 남은 식별자 문제도 줄어듭니다.

{% comment %} TODO: 실제로 병합을 운영 작업으로 돌렸다면, 소유 증명을 어떤 절차로 받았고 어떤 테이블에서 유니크 충돌이 났는지 적어주세요 {% endcomment %}

## 마지막 로그인 수단은 끊을 수 없다

연결을 만들면 해제도 만들어야 하고, 해제에는 조건이 하나 필요합니다.

```typescript
async function unlinkIdentity(userId: number, identityId: number): Promise<void> {
  const identities = await listIdentities(userId);
  const hasPassword = await hasLocalCredential(userId);

  // 이걸 끊고 나서 로그인할 수단이 남는가
  const remaining = identities.filter((i) => i.id !== identityId).length
    + (hasPassword ? 1 : 0);

  if (remaining === 0) {
    throw new ConflictError("마지막 로그인 수단은 해제할 수 없습니다");
  }
  await deleteIdentity(userId, identityId);
}
```

이 검사가 없으면 사용자가 스스로 계정에서 잠깁니다. 복구는 고객 지원 업무가 되고, 그 과정에서 본인 확인을 어떻게 할지가 또 다른 문제가 됩니다.

해제한 뒤에 같은 공급자로 다시 로그인하면 어떻게 되는지도 정해둬야 합니다.
`user_identities` 행만 지웠다면 그 로그인은 "완전 신규"로 분류돼 새 계정이 생깁니다. 사용자 입장에서는 해제했다 다시 붙이려다 계정이 하나 더 생긴 셈입니다.
해제 이력을 남겨두고, 같은 `(issuer, subject)`가 돌아오면 이전 계정으로 연결할지 묻는 쪽이 낫습니다.

## 트레이드오프를 적어두면

이 구조가 공짜는 아닙니다.

| | 공급자 1개 · 이메일이 키 | identity 분리 · 명시적 연결 |
| --- | --- | --- |
| 스키마 | 테이블 하나 | 조인 한 번 더 |
| 공급자 추가 | 불가능에 가깝다 | 행 추가 |
| 이메일 변경 | 식별자가 흔들린다 | 영향 없음 |
| 중복 계정 | 자동으로 안 생김 | 생길 수 있고, 사용자가 연결해야 함 |
| 계정 선점 공격 | 열려 있다 | 막힌다 |

마지막 두 줄이 이 선택의 본질입니다. **중복 계정이라는 불편을 받아들이는 대가로 계정 탈취를 막습니다.**
자동 병합은 그 불편을 없애주는 대신 신뢰의 근거를 공급자가 보낸 문자열 하나에 맡깁니다.

덧붙여, 공급자를 여럿 붙이면 **공격 표면이 합쳐진다**는 점도 기억해둘 만합니다.
세 개를 연결한 사용자는 그 셋 중 가장 약한 계정이 뚫리면 서비스 계정도 같이 뚫립니다. 민감한 동작 앞에 재인증을 두는 이유가 여기에도 있습니다.

## 무엇부터 할지

이미 돌아가는 서비스에 적용한다면 순서가 있습니다.

1. **지금 자동 연결이 켜져 있는지부터 확인합니다.** 이메일만 보고 붙이는 코드가 있으면 그게 가장 급한 항목입니다.
2. 클레임 정규화를 먼저 넣습니다. `email_verified`의 타입과 부재를 처리하는 것만으로 판단 근거가 달라집니다.
3. `user_identities`를 추가하고 기존 데이터를 옮깁니다. 읽기는 새 테이블로, 쓰기는 양쪽에 하는 기간을 두면 되돌릴 수 있습니다.
4. 연결·해제 UI를 만듭니다. 사용자가 스스로 묶을 수 있으면 중복 계정 문의가 지원 업무에서 설정 화면으로 내려갑니다.
5. 병합은 마지막입니다. 되돌릴 수 없는 작업이라 절차와 이력이 먼저 필요합니다.

공급자별 클레임의 정확한 목록과 타입은 버전에 따라 바뀌므로, 구현 전에 각 공급자의 공식 문서를 한 번 확인하는 편이 좋습니다.
특히 이메일 제공이 선택인지, 가려진 주소를 쓰는지, 식별자가 앱 단위로 발급되는지는 공급자마다 다릅니다.
