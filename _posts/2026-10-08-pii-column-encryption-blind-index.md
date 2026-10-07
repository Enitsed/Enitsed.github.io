---
layout: post
title: "암호화한 컬럼으로는 검색이 안 된다 — 개인정보 암호화와 블라인드 인덱스"
date: 2026-10-08
tags: [backend, security, mysql, database, typescript]
excerpt: "이메일을 암호화해서 저장하면 로그인 조회가 안 되고 유니크 제약도 깨집니다. 디스크 암호화가 막아주지 못하는 것, 암호문을 넣는 순간 사라지는 네 가지 쿼리, HMAC 블라인드 인덱스로 동등 검색을 되찾는 방법과 그것이 흘리는 정보, 부분 검색·범위 조회를 포기하는 지점, 봉투 암호화와 키 회전, 그리고 암호문이 평문으로 되돌아 새는 경로까지."
---

이메일을 암호화해서 저장하기로 했습니다. 컬럼 타입을 바꾸고, 저장 직전에 암호화하고, 읽을 때 복호화합니다.
배포하면 로그인이 안 됩니다. `WHERE email = ?`가 한 건도 못 찾습니다.

같은 평문을 두 번 암호화하면 암호문이 다르게 나오기 때문입니다. 그리고 그걸 같게 만드는 선택은 **다른 것을 내줍니다.**

## 디스크 암호화는 무엇을 막지 못하는가

"RDS 저장 암호화를 켰으니 됐다"가 흔한 출발점입니다. 틀린 말은 아닌데, 막아주는 범위가 좁습니다.

저장 암호화(at-rest)는 **물리 매체를 가져갔을 때**를 막습니다. 디스크나 백업 파일이 외부로 나갔을 때 그 파일만으로는 읽을 수 없게 합니다.
그 외에는 엔진이 알아서 복호화해 돌려줍니다. 정상적인 커넥션은 평문을 봅니다.

그래서 아래 경로에는 아무 효과가 없습니다.

| 유출 경로 | 저장 암호화 | 컬럼 암호화 |
| --- | --- | --- |
| 디스크·스냅샷 탈취 | 막힘 | 막힘 |
| SQL 인젝션으로 `SELECT` | 평문 노출 | 암호문만 |
| DB 계정 유출·과도한 권한 | 평문 노출 | 암호문만 |
| 운영자가 콘솔에서 조회 | 평문 노출 | 암호문만 |
| 리플리카·ETL·대시보드 | 평문 노출 | 암호문만 |
| 애플리케이션 서버 침해 | 평문 노출 | 평문 노출 |

마지막 줄이 중요합니다. 애플리케이션이 키를 쥐고 있으니, 애플리케이션이 뚫리면 컬럼 암호화도 뚫립니다.
컬럼 암호화가 하는 일은 **"DB를 읽을 수 있는 것"과 "평문을 읽을 수 있는 것"을 분리**하는 것이고, 그 이상을 기대하면 과대평가입니다.

> 국내에서 어떤 항목이 암호화 의무 대상인지, 내부망 저장에 예외가 있는지는 소관 고시와 안내서에 규정돼 있고 개정이 있었습니다.
> 조문을 기억에 의존해 적용하지 말고 국가법령정보센터(law.go.kr)와 개인정보보호위원회 자료에서 현행 원문을 확인하세요.
> 이 글은 법적 요건이 아니라 구현 방법을 다룹니다.

## 암호문을 넣는 순간 사라지는 것들

AES-GCM 같은 정상적인 대칭 암호는 매번 새로운 IV(nonce)를 씁니다. 같은 평문도 호출마다 다른 암호문이 됩니다.
이게 보안상 올바른 동작이고, 동시에 DB 기능 네 가지를 깨뜨립니다.

- **동등 비교** — `WHERE email = ?`에 암호문을 넣어도 안 맞습니다. 로그인, 중복 확인, 외부 연동 키 조회가 전부 여기 걸립니다.
- **유니크 제약** — 같은 이메일로 두 번 가입하면 암호문이 다르니 제약이 통과됩니다. DB가 강제해주던 규칙이 사라집니다.
- **정렬과 범위** — `ORDER BY name`, `WHERE birth_date BETWEEN ...`이 의미 없는 결과를 냅니다. 암호문의 바이트 순서는 평문 순서와 무관합니다.
- **부분 일치** — `LIKE '%김%'`은 애초에 성립하지 않습니다.

여기서 가장 쉬운 유혹은 **결정적 암호화**입니다. IV를 평문에서 유도해서 같은 평문이 항상 같은 암호문이 되게 만들면 동등 비교와 유니크 제약이 살아납니다.

대가는 **같다는 사실이 그대로 보인다**는 점입니다. 암호문만 봐도 어느 두 행이 같은 값인지 알 수 있고, 값의 분포와 빈도도 드러납니다.
성별이나 지역처럼 가짓수가 적은 컬럼이라면 빈도만으로 어느 암호문이 무엇인지 추측됩니다.

> MySQL의 `AES_ENCRYPT()`로 해결하려는 시도는 두 가지 이유로 피하는 편이 낫습니다.
> 첫째, 키가 SQL 문장에 실려 일반 로그·슬로우 쿼리 로그·바이너리 로그에 그대로 남을 수 있습니다.
> 둘째, `block_encryption_mode`의 기본값은 ECB 계열이고, ECB는 같은 블록이 같은 암호문이 돼서 평문 구조가 드러납니다. IV를 받는 모드로 바꿔야 쓸 만해집니다.

그래서 방향은 둘로 갈립니다. 암호화는 **랜덤**하게 하고, 검색은 **별도의 색인**으로 되찾는 것. 이게 블라인드 인덱스입니다.

## 저장 형식을 먼저 정한다

암호화 코드를 쓰기 전에 바이트 레이아웃을 정합니다. 여기서 대충 하면 나중에 키를 바꿀 수 없게 됩니다.

```text
[ver:1][keyId:1][iv:12][tag:16][ciphertext:n]
```

- `ver` — 포맷 버전. 알고리즘을 바꿀 길을 열어둡니다.
- `keyId` — 어느 키로 암호화했는지. **이게 없으면 키 회전이 불가능합니다.**
- `iv` — GCM은 12바이트 nonce가 권장값입니다. 매번 난수로 뽑습니다.
- `tag` — 인증 태그 16바이트. 위조된 암호문을 복호화 단계에서 거부합니다.

컬럼 타입은 `VARBINARY`를 씁니다. Base64로 감싸서 `VARCHAR`에 넣으면 길이가 약 1/3 늘고, 콜레이션이 끼어들어 비교가 이상해질 여지가 생깁니다.

```typescript
import crypto from "node:crypto";

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;

type Keyring = {
  currentId: number;
  encKeys: Map<number, Buffer>;   // keyId -> 32바이트 데이터 키
};

// aad: 이 암호문이 '어느 행의 어느 컬럼'인지 묶어두는 값
export function encrypt(keyring: Keyring, plaintext: string, aad: string): Buffer {
  const keyId = keyring.currentId;
  const key = keyring.encKeys.get(keyId);
  if (!key) throw new Error(`unknown key id: ${keyId}`);

  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));

  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const header = Buffer.from([VERSION, keyId]);

  return Buffer.concat([header, iv, cipher.getAuthTag(), ct]);
}

export function decrypt(keyring: Keyring, blob: Buffer, aad: string): string {
  const version = blob.readUInt8(0);
  if (version !== VERSION) throw new Error(`unsupported format version: ${version}`);

  const keyId = blob.readUInt8(1);
  const key = keyring.encKeys.get(keyId);
  if (!key) throw new Error(`key ${keyId} not available`);

  const iv = blob.subarray(2, 2 + IV_LEN);
  const tag = blob.subarray(2 + IV_LEN, 2 + IV_LEN + TAG_LEN);
  const ct = blob.subarray(2 + IV_LEN + TAG_LEN);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);

  // 태그가 안 맞으면 final()에서 예외가 난다
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
```

`aad`를 그냥 빈 값으로 두기 쉬운데, 넣어두면 하나를 더 막습니다.
AAD는 암호화되지 않고 **인증만** 되는 부가 데이터라서, `users:42:email` 같은 값을 넣어두면 그 암호문을 다른 행이나 다른 컬럼에 복사해 넣는 조작이 복호화 단계에서 실패합니다.

DB 쓰기 권한만 있는 쪽이 42번 사용자의 이메일 암호문을 7번 사용자 행에 붙여넣는 시나리오가 여기서 끊깁니다.
대신 AAD에 쓰는 값은 **행이 살아 있는 동안 변하지 않아야** 합니다.

## 동등 검색을 되찾는 블라인드 인덱스

블라인드 인덱스는 평문의 키 있는 해시를 **별도 컬럼**에 넣고 거기에 인덱스를 거는 방식입니다.
검색할 때는 입력값으로 같은 해시를 계산해서 그 컬럼을 조회합니다.

해시는 반드시 **키가 들어간** HMAC을 씁니다. 키 없는 SHA-256을 쓰면 이메일이나 전화번호처럼 도메인이 좁은 값은 사전 공격으로 그냥 복원됩니다.
그리고 HMAC 키는 **암호화 키와 다른 키**를 씁니다. 하나가 유출됐을 때 다른 하나가 같이 넘어가지 않게 하려는 분리입니다.

```sql
ALTER TABLE users
  ADD COLUMN email_enc   VARBINARY(512) NOT NULL,
  ADD COLUMN email_bidx  BINARY(32)     NOT NULL,
  ADD UNIQUE KEY uk_users_email_bidx (email_bidx);
```

```typescript
function normalizeEmail(raw: string): string {
  // 쓰기와 검색이 같은 함수를 지나야 한다. 다르면 조용히 못 찾는다.
  return raw.normalize("NFC").trim().toLowerCase();
}

function blindIndex(hmacKey: Buffer, scope: string, value: string): Buffer {
  // scope를 섞어 컬럼마다 다른 색인이 되게 한다
  return crypto.createHmac("sha256", hmacKey)
    .update(`${scope}:${value}`, "utf8")
    .digest();
}

export async function findUserByEmail(conn: Conn, keys: Keys, email: string) {
  const bidx = blindIndex(keys.hmac, "users.email", normalizeEmail(email));
  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, email_enc FROM users WHERE email_bidx = ? LIMIT 1",
    [bidx],
  );
  return rows[0] ?? null;
}
```

정규화 함수가 이 구조의 약한 고리입니다. 저장 시점과 검색 시점이 **같은 정규화**를 지나야 하는데, 한쪽만 바뀌면 에러 없이 "검색이 안 되는" 상태가 됩니다.
정규화 규칙을 바꾸면 기존 행의 색인을 전부 다시 계산해야 하니, 그 자체를 마이그레이션으로 취급해야 합니다.

`scope`를 섞는 이유도 같은 종류입니다. 이메일과 보조 이메일을 같은 키로 해시하면 두 컬럼의 색인 값이 같아져서, 두 컬럼에 같은 값이 들어 있다는 사실이 드러납니다.

### 유니크로 쓸 것인가, 버킷으로 쓸 것인가

여기서 갈림길이 하나 더 있습니다.

32바이트 전체를 저장하고 유니크 제약을 걸면 **DB가 중복 가입을 다시 막아줍니다.** 조회도 한 건으로 정확히 떨어집니다.
대신 결정적 암호화와 같은 정보를 흘립니다. 같은 이메일을 쓰는 행이 같은 색인 값을 갖는다는 사실 자체는 지워지지 않습니다.

색인을 **잘라서** 저장하면 반대쪽으로 갑니다. 앞 8바이트만 쓰면 서로 다른 평문이 같은 버킷에 떨어질 수 있어서, 조회 결과가 여러 건 나옵니다.
그 후보들을 복호화해서 평문으로 한 번 더 비교해야 합니다.

```typescript
export async function findUserByEmailBucketed(conn: Conn, keys: Keys, email: string) {
  const normalized = normalizeEmail(email);
  const bucket = blindIndex(keys.hmac, "users.email", normalized).subarray(0, 8);

  const [rows] = await conn.query<RowDataPacket[]>(
    "SELECT id, email_enc FROM users WHERE email_bidx = ?",
    [bucket],
  );

  for (const row of rows) {
    const plain = decrypt(keys.ring, row.email_enc, `users:${row.id}:email`);
    if (crypto.timingSafeEqual(
      Buffer.from(normalizeEmail(plain), "utf8"),
      Buffer.from(normalized, "utf8"),
    )) {
      return row;
    }
  }
  return null;
}
```

잘린 색인에는 **유니크 제약을 걸 수 없습니다.** 충돌이 정상 동작이기 때문입니다.
중복 가입 방지를 애플리케이션으로 올려야 하고, 그러면 동시 요청에서 유니크 제약이 해주던 일을 직접 해야 합니다.

선택 기준은 이렇게 정리됩니다.

- 로그인 식별자처럼 **중복이 데이터 무결성 문제**가 되는 컬럼 — 전체 길이 + 유니크. 동등 누출은 받아들입니다.
- 검색 편의만 필요한 컬럼 — 잘라서 버킷. 누출을 줄이는 대신 후보 복호화 비용을 냅니다.

그리고 전제가 하나 더 있습니다. **블라인드 인덱스는 도메인이 작으면 키 유출 시 전수 조회로 복원됩니다.**
생년월일이나 성별에 색인을 걸어두면, HMAC 키를 얻은 쪽은 가능한 모든 값을 해시해서 대조하면 끝입니다. 가짓수가 적은 컬럼에는 색인을 만들지 않는 편이 낫습니다.

## 부분 검색과 범위는 되찾기 어렵다

운영 화면에서 가장 먼저 요청되는 건 "이름으로 검색"과 "전화번호 뒷자리로 검색"입니다. 그리고 여기가 가장 비쌉니다.

**뒷자리 검색**은 그 조각만 따로 색인하면 됩니다. 전화번호 뒤 4자리의 HMAC을 별도 컬럼에 넣는 방식입니다.
다만 4자리는 만 가지뿐이라 위에서 말한 전수 조회가 바로 성립하고, 결과도 여러 건 나와서 후처리가 필요합니다.

**부분 일치**는 n-gram 색인으로 비슷하게 구현할 수 있습니다. 평문을 2글자씩 쪼개 각각을 HMAC해서 별도 테이블에 넣고, 검색어도 같은 방식으로 쪼개 교집합을 구하는 구조입니다.
행 하나가 색인 레코드 여러 개로 불어나고, 더 중요하게는 **조각들이 같이 등장한다는 정보**가 쌓여서 긴 값일수록 복원 가능성이 올라갑니다. 암호화의 이득을 상당 부분 되돌려주는 거래입니다.

**범위와 정렬**은 포기하는 쪽이 맞습니다. 순서를 보존하는 암호화 방식은 정의상 순서를 흘립니다.

현실적인 타협은 **민감도를 낮춘 파생 컬럼**을 따로 두는 것입니다.

```sql
ALTER TABLE users
  ADD COLUMN birth_date_enc VARBINARY(128) NOT NULL,  -- 1990-03-17
  ADD COLUMN birth_year     SMALLINT       NULL,      -- 1990
  ADD COLUMN age_band       TINYINT        NULL;      -- 집계용 버킷
```

생년월일 원본은 암호화해서 보관하고, 통계와 필터에 필요한 만큼만 평문 파생 컬럼으로 둡니다.
이러면 대시보드와 ETL은 파생 컬럼만 보면 되고, 리플리카로 나가는 데이터에서 원본이 빠집니다.

어디까지 깎아야 식별이 안 되는지는 자명하지 않습니다. 희귀한 조합(특정 지역 + 특정 연령 + 특정 성별)은 몇 개만 겹쳐도 개인을 특정합니다.
"파생 컬럼은 안전하다"고 넘기지 말고 무엇을 남기는지 의식적으로 고르세요.

{% comment %} TODO: 실제로 어떤 컬럼을 암호화 대상으로 골랐고, 운영팀의 검색 요구를 어디까지 받아들였는지 적어주세요 {% endcomment %}

## 키를 어디에 두는가

암호화를 붙이는 작업의 절반은 키 관리입니다. 그리고 여기서 틀리면 나머지가 다 무의미해집니다.

환경 변수에 32바이트를 박아두는 건 출발점으로는 되지만 회전과 감사 추적이 안 됩니다.
키를 바꾸려면 모든 암호문을 다시 암호화해야 하고, 그 작업 중에는 새 키와 옛 키가 동시에 필요합니다.

그래서 **봉투 암호화**를 씁니다. 데이터는 데이터 키로 암호화하고, 데이터 키 자체는 KMS 같은 관리형 키로 암호화해서 보관합니다.

```text
KMS 마스터 키 (내보낼 수 없음)
   └─ 암호화된 데이터 키  ← 애플리케이션이 보관
          └─ 복호화된 데이터 키  ← 메모리에만, 캐시
                 └─ 컬럼 암호문
```

행마다 데이터 키를 새로 만드는 설계도 있지만, 컬럼 암호화에는 보통 맞지 않습니다. 목록 100건을 복호화하려고 KMS를 100번 호출하게 되기 때문입니다.
데이터 키를 소수로 두고 메모리에 캐시하고, `keyId`로 어느 키인지 구분하는 쪽이 현실적입니다.

```typescript
// 프로세스 시작 시 한 번. 평문 키는 메모리에만 두고 로그에 절대 싣지 않는다.
async function loadKeyring(kms: KMSClient, stored: StoredKey[]): Promise<Keyring> {
  const encKeys = new Map<number, Buffer>();

  for (const { keyId, wrappedKey } of stored) {
    const res = await kms.send(new DecryptCommand({ CiphertextBlob: wrappedKey }));
    if (!res.Plaintext) throw new Error(`failed to unwrap key ${keyId}`);
    encKeys.set(keyId, Buffer.from(res.Plaintext));
  }

  return { currentId: Math.max(...encKeys.keys()), encKeys };
}
```

회전은 "새 키로 바꾼다"가 아니라 **"새 키를 추가하고 점진적으로 옮긴다"**입니다.

1. 새 데이터 키를 만들어 `keyId`를 하나 늘리고, 키링에 **둘 다** 올립니다.
2. 이 시점부터 쓰기는 새 키를 씁니다. 읽기는 `keyId`를 보고 알아서 고릅니다.
3. 옛 키로 된 행을 청크로 끊어 다시 저장합니다. 복제 지연을 보면서 쉬어갑니다.
4. 옛 `keyId`를 쓰는 행이 0이 되면 키링에서 내립니다.

HMAC 키 회전은 더 무겁습니다. 색인 값이 전부 바뀌니, 옮기는 동안 두 색인 컬럼을 유지하고 조회는 둘 다 보는 기간이 필요합니다.
자주 바꿀 수 있는 종류의 키가 아니라서, 처음부터 더 보수적으로 격리해두는 편이 낫습니다.

> 평문 키를 로그, 예외 메시지, 코어 덤프, APM 스냅샷에 싣지 않도록 주의하세요.
> 키를 담은 객체는 `toJSON`이나 커스텀 inspect를 막아두는 것도 방법입니다. 구조화 로거는 객체를 통째로 직렬화하는 경우가 많습니다.

## 암호문이 평문으로 되돌아 새는 경로

컬럼을 암호화해도 평문은 애플리케이션 안을 돌아다닙니다. 그래서 새는 자리는 DB가 아닌 쪽에 더 많습니다.

- **로그** — 요청 본문을 그대로 찍는 미들웨어, 쿼리 파라미터를 남기는 ORM 디버그 로그, 검증 실패 메시지에 들어간 입력값.
- **에러 리포팅** — 예외에 붙은 요청 컨텍스트가 외부 서비스로 전송됩니다. 스크러빙 규칙을 키 이름 기준으로 걸어두세요.
- **응답** — 상세 API가 전체 필드를 돌려주던 습관이 그대로면 평문이 그냥 나갑니다. 마스킹 범위를 역할별로 정하세요.
- **캐시** — 조회 결과를 Redis에 넣으면 암호화 이전 상태로 들어갑니다. 캐시 쪽 접근 통제가 DB보다 느슨한 경우가 많습니다.
- **파일** — 엑셀 내보내기, 일괄 업로드 원본, 운영자 화면 스크린샷.

반대로, 애플리케이션에서 암호화하면 **공짜로 따라오는 이득**이 있습니다.
바이너리 로그와 슬로우 쿼리 로그에 암호문만 남고, 리플리카와 백업에도 암호문이 들어가고, 리플리카를 읽는 ETL과 대시보드도 평문을 못 봅니다.
평문이 지나는 경로를 애플리케이션 한 곳으로 좁히는 것이 이 방식의 실질적인 가치입니다.

그 가치를 지키려면 암·복호화를 **데이터 접근 계층 한 곳**에 두어야 합니다. 리포지토리 바깥에서 `email_enc`를 직접 만지는 코드가 생기면 색인 갱신이 빠지고 정규화가 달라지고, 결국 조용히 못 찾는 행이 생깁니다.

## 붙이기 전에 셈해볼 비용

마지막으로, 붙이기 전에 셈해볼 것들입니다.

**복호화 횟수.** 목록 API가 한 페이지에 50건을 돌려주고 각 행에 암호화 컬럼이 3개면 호출당 150번 복호화합니다.
AES-GCM 자체는 빠르지만, 이걸 피하려고 "목록에서는 복호화 안 하기"를 고르면 목록용 필드를 별도로 두게 됩니다.

**인덱스 크기.** 블라인드 인덱스 컬럼은 전부 인덱스가 걸립니다. 32바이트 색인을 컬럼 다섯 개에 붙이면 그만큼 인덱스가 늘고 쓰기가 느려집니다.
InnoDB의 인덱스 키 길이 상한은 행 포맷에 따라 다르니, 긴 색인을 여럿 묶을 계획이라면 미리 확인하세요.

**마이그레이션.** 기존 테이블이라면 평문 컬럼과 암호화 컬럼을 같이 두고, 쓰기를 양쪽에 보내고, 백필하고, 읽기를 옮기고, 마지막에 평문 컬럼을 지우는 순서가 됩니다.
평문 컬럼을 지우는 시점부터 되돌릴 수 없으니 그 전에 복호화 경로를 충분히 검증하세요.

**장애 모드.** KMS 호출이 실패하면 키링을 못 만들어 서비스가 뜨지 못합니다. 키 캐시의 생존 시간과 재시도, 그리고 복호화 실패를 500으로 터뜨릴지 해당 필드만 비워 돌려줄지를 미리 정해두세요.

{% comment %} TODO: 적용하면서 실제로 걸린 문제나 성능 변화가 있었다면 적어주세요 {% endcomment %}

## 정리

- 컬럼 암호화는 "DB를 읽는 것"과 "평문을 읽는 것"을 분리합니다. 애플리케이션이 뚫리면 둘 다 뚫립니다.
- 랜덤 IV를 쓰면 동등 비교·유니크 제약·정렬·부분 일치가 깨집니다. 결정적으로 만들면 같다는 사실이 그대로 드러납니다.
- 저장 형식에 포맷 버전과 `keyId`를 넣으세요. `keyId`가 없으면 키 회전을 할 수 없습니다. 컬럼은 `VARBINARY`로.
- GCM의 AAD에 행·컬럼 식별자를 묶으면 암호문을 다른 행에 옮겨 붙이는 조작이 복호화에서 실패합니다.
- 블라인드 인덱스는 키 있는 HMAC으로 만들고, 암호화 키와 다른 키를 쓰고, 컬럼별 scope를 섞습니다. 정규화 함수는 저장과 검색이 공유해야 하고, 어긋나면 에러 없이 조회만 실패합니다.
- 색인 전체 길이 + 유니크는 중복을 DB가 막아주는 대신 동등 누출을 받아들이는 선택입니다. 잘라서 쓰면 누출이 줄고 후보 복호화가 생깁니다.
- 가짓수가 적은 컬럼에는 블라인드 인덱스를 만들지 마세요. 키가 유출되면 전수 조회로 복원됩니다.
- 부분 일치는 n-gram 색인으로 가능하지만 조각의 공존 정보가 쌓입니다. 범위·정렬은 포기하고 민감도 낮은 파생 컬럼으로 대체하세요.
- 봉투 암호화로 데이터 키를 감싸고, 회전은 "새 키 추가 → 점진적 재암호화 → 옛 키 제거" 순서로. HMAC 키 회전은 훨씬 무겁습니다.
- 평문은 로그·에러 리포팅·응답·캐시·내보내기 파일로 더 자주 샙니다. 암·복호화는 데이터 접근 계층 한 곳에 모으세요.
