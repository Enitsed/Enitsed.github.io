---
layout: post
title: "비밀번호 뒷부분을 틀리게 넣었는데 로그인이 된다 — 비밀번호 해시의 길이 제한·비용·교체"
date: 2026-11-27
tags: [backend, security, auth, typescript, nodejs]
excerpt: "bcrypt가 72바이트 뒤를 조용히 버리는 문제와 한글 비밀번호에서 그 한계가 24자라는 점, 알고리즘과 파라미터를 해시 문자열에 함께 저장하는 형식, Node.js crypto.scrypt의 maxmem 함정, 로그인할 때 재해시로 옮겨가는 코드, 없는 계정의 응답 시간 차이, 동시 해시 수를 제한해야 하는 이유."
---

비밀번호를 해시로 저장하는 것까지는 다들 합니다. 문제는 그다음입니다. 어떤 알고리즘을 골랐는지, 비용을 얼마로 잡았는지, 나중에 그 값을 어떻게 올릴지는 처음 정한 뒤로 잘 다시 보지 않습니다.
그러다 보면 긴 비밀번호의 뒷부분이 검증되지 않거나, 로그인 몇 번에 서버 메모리가 바닥나거나, 응답 시간만 보고 가입 여부를 알아낼 수 있는 상태가 됩니다.

## bcrypt는 72바이트 뒤를 보지 않는다

bcrypt는 입력의 **앞 72바이트만** 씁니다. 대부분의 구현은 그보다 긴 입력을 거부하지 않고 조용히 잘라냅니다.
영문 비밀번호라면 72자는 꽤 길어서 잘 드러나지 않습니다. 한글은 다릅니다.

```typescript
import bcrypt from "bcrypt";

const password = "가".repeat(24);           // UTF-8로 72바이트
const hash = bcrypt.hashSync(password, 10);

bcrypt.compareSync(password + "틀린뒤쪽", hash); // true
```

한글 한 글자는 UTF-8에서 3바이트라서, **한글 24자가 이미 한계**입니다. 25번째 글자부터는 무엇을 넣어도 통과합니다.
네이티브 `bcrypt`와 순수 JS 구현인 `bcryptjs` 패키지에서 위 코드를 돌려보면 둘 다 `true`를 돌려줍니다.

한글 문장형 비밀번호는 흔하지 않지만, 길게 쓰라고 권하는 정책과는 정면으로 부딪힙니다. 사용자는 30자를 정했는데 시스템은 24자만 지키고 있는 셈입니다.

> 일부 bcrypt 구현은 72바이트를 넘는 입력에 오류를 내도록 바뀌기도 했습니다. 쓰는 라이브러리의 동작은 버전별 릴리스 노트에서 직접 확인하세요.

선택지는 셋입니다.

- **입력 길이를 72바이트로 제한한다.** 글자 수가 아니라 바이트 수로 검사해야 합니다. 한글 24자 제한은 사용자에게 설명하기 어렵습니다.
- **먼저 빠른 해시로 줄이고 bcrypt에 넣는다.** OWASP Password Storage Cheat Sheet는 이 경우 페퍼를 키로 쓴 HMAC 결과를 base64로 인코딩해 bcrypt에 넣는 방식을 적어두었습니다. 다른 곳에서 유출된 평문 해시를 그대로 대입해보는 공격을 막으려면 키 없는 단순 해시로는 부족하다는 이유입니다.
- **길이 제한이 없는 알고리즘으로 옮긴다.** 새로 만든다면 이쪽이 단순합니다.

## 무엇을 고를 것인가

OWASP 치트 시트의 권장 순서는 Argon2id, 그다음 scrypt이고, bcrypt는 레거시 시스템용, PBKDF2는 FIPS-140 준수가 필요할 때입니다. 최소 파라미터도 함께 적혀 있습니다.

| 알고리즘 | 치트 시트의 최소 설정 예 | 메모 |
| --- | --- | --- |
| Argon2id | m=19 MiB, t=2, p=1 | 메모리 하드. Node에서는 보통 네이티브 패키지 필요 |
| scrypt | N=2^17, r=8, p=1 (약 128 MiB) | 메모리 하드. Node `crypto`에 내장 |
| bcrypt | 작업 계수 10 이상 | 72바이트 제한 |
| PBKDF2-HMAC-SHA256 | 600,000회 | 메모리를 거의 쓰지 않음 |

> 권장 수치는 하드웨어가 빨라지면서 계속 올라갑니다. 위 값은 글을 쓰는 시점의 치트 시트 기준이니, 적용하기 전에 원문을 다시 확인하세요.

이 글의 예제는 추가 의존성이 없는 Node 내장 `crypto.scrypt`로 씁니다. Argon2id를 쓰더라도 아래의 저장 형식, 재해시, 동시성 제한은 그대로 적용됩니다.

## 해시에 알고리즘과 파라미터를 같이 적는다

해시 값만 저장해두면 나중에 비용을 올릴 수 없습니다. 어떤 행이 어떤 설정으로 만들어졌는지 모르기 때문입니다.
bcrypt 해시가 `$2b$10$...`처럼 비용을 문자열 안에 담고 있는 것과 같은 방식으로, scrypt 결과에도 파라미터를 붙여 저장합니다.

```text
$scrypt$ln=17,r=8,p=1$<salt base64>$<hash base64>
```

`ln`은 N의 로그 값입니다(N = 2^17). PHC 문자열 형식을 본뜬 모양이지만, 여기서 중요한 건 형식 이름이 아니라 **한 컬럼만 보고도 검증에 필요한 모든 값이 나온다**는 점입니다.

```typescript
import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from "node:crypto";
import bcrypt from "bcrypt";

type ScryptParams = { ln: number; r: number; p: number };

const CURRENT: ScryptParams = { ln: 17, r: 8, p: 1 }; // N = 2^17
const KEY_LEN = 32;
const SALT_LEN = 16;

function toOptions({ ln, r, p }: ScryptParams): ScryptOptions {
  const N = 2 ** ln;
  // 필요한 메모리는 대략 128 * N * r 바이트. 기본 maxmem(32MiB)으로는 N=2^17이 실패한다
  return { N, r, p, maxmem: 256 * N * r };
}

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, toOptions(params), (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

const b64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await derive(password, salt, CURRENT);
  const { ln, r, p } = CURRENT;
  return `$scrypt$ln=${ln},r=${r},p=${p}$${b64(salt)}$${b64(key)}`;
}
```

### maxmem을 안 주면 권장값이 그냥 실패한다

`crypto.scrypt`에는 `maxmem` 옵션이 있고 기본값은 32 MiB입니다. scrypt가 쓰는 메모리는 대략 `128 × N × r` 바이트라서, r=8일 때 N=2^14(16 MiB)까지만 기본값 안에 들어갑니다.
N=2^15(32 MiB)만 돼도 오버헤드 때문에 한도를 넘고, 권장값인 N=2^17은 당연히 실패합니다.

```text
RangeError: Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded
```

이 오류를 보고 N을 2^14로 낮춰서 "해결"하기 쉽습니다. 그러면 메모리 하드 함수를 고른 의미가 상당 부분 사라집니다. 낮출 게 아니라 `maxmem`을 올려야 합니다.

## 검증하고, 필요하면 그 자리에서 다시 해시한다

비밀번호 해시는 평문 없이 다시 만들 수 없습니다. 평문을 볼 수 있는 유일한 순간은 사용자가 로그인할 때입니다.
그래서 비용을 올리거나 알고리즘을 바꿀 때는, 검증에 성공한 순간 새 설정으로 다시 해시해서 덮어씁니다. 검증 함수가 "통과 여부"와 함께 "다시 해시할 필요가 있는가"를 돌려주게 만듭니다.

```typescript
function parseScrypt(stored: string) {
  const m = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(stored);
  if (!m) return null;
  return {
    params: { ln: Number(m[1]), r: Number(m[2]), p: Number(m[3]) },
    salt: Buffer.from(m[4], "base64"),
    key: Buffer.from(m[5], "base64"),
  };
}

const isCurrent = (p: ScryptParams) =>
  p.ln === CURRENT.ln && p.r === CURRENT.r && p.p === CURRENT.p;

export type VerifyResult = { ok: boolean; needsRehash: boolean };

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  if (stored.startsWith("$2")) {
    // 이전 시스템이 남긴 bcrypt 해시 ($2a$, $2b$, $2y$)
    const ok = await bcrypt.compare(password, stored);
    // 72바이트를 넘는 입력은 앞부분만 검증된 것이다. 검증 안 된 뒷부분까지 새 해시에 굳히지 않는다
    const fullyVerified = Buffer.byteLength(password, "utf8") <= 72;
    return { ok, needsRehash: ok && fullyVerified };
  }

  const parsed = parseScrypt(stored);
  if (!parsed) throw new Error("unknown password hash format");

  const key = await derive(password, parsed.salt, parsed.params);
  const ok = key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  return { ok, needsRehash: ok && !isCurrent(parsed.params) };
}
```

비교에는 `===` 대신 `timingSafeEqual`을 씁니다. 길이가 다르면 예외를 던지므로 길이를 먼저 확인합니다.

### bcrypt에서 옮길 때의 72바이트 함정

bcrypt 해시를 scrypt로 옮길 때 그냥 "통과했으면 지금 입력으로 다시 해시"하면 문제가 생깁니다.
72바이트를 넘는 입력은 **앞부분만 검증된 상태**입니다. 사용자가 이번에 뒷부분을 오타 낸 채 로그인했다면, 그 오타가 새 비밀번호로 굳어집니다. 다음 로그인부터는 원래 비밀번호가 맞지 않습니다.

위 코드는 이 경우 재해시를 건너뜁니다. 대가는 그 사용자가 계속 bcrypt에 남는다는 점입니다.
이 사용자들에게는 다음 로그인 때 비밀번호 재설정을 권하거나, 일정 기간 후 재설정을 강제하는 식으로 따로 정리해야 합니다.

{% comment %} TODO: 이전 시스템에서 bcrypt 해시를 쓰고 있었는지, 실제 72바이트 초과 비밀번호가 있었는지 확인해서 경험이 있다면 덧붙이기 {% endcomment %}

### 오래 로그인하지 않는 사용자

로그인할 때만 옮겨가므로, 몇 년째 접속하지 않은 계정은 영원히 옛 해시로 남습니다.
옛 해시가 아주 약한 경우(무염 MD5, SHA-1 등)라면 기다리지 말고 다른 방법을 써야 합니다. 옛 해시 값을 입력으로 새 알고리즘을 한 겹 더 씌워 즉시 전부 바꾸고, 검증할 때도 같은 순서로 계산하는 방식이 있습니다. 구조가 복잡해지니, 휴면 계정이면 비밀번호를 지우고 재설정을 요구하는 쪽이 나을 때도 많습니다.

비밀번호 원문을 모르는 채로 사용자를 다른 인증 시스템으로 옮기는 문제는 [Cognito 이전 글](/blog/cognito-user-migration/)에서 다뤘습니다. 로그인 시점에 옮긴다는 원리는 같습니다.

## 로그인 흐름에 넣기

검증 함수를 그대로 로그인에 붙이면 두 가지가 새어 나갑니다. 계정 존재 여부와 서버 자원입니다.

### 없는 계정은 응답이 빠르다

가장 흔한 로그인 코드는 사용자를 못 찾으면 바로 실패를 돌려줍니다.
존재하는 계정은 해시 계산에 수백 밀리초가 걸리고 없는 계정은 몇 밀리초 만에 끝나니, 응답 메시지를 아무리 똑같이 만들어도 **응답 시간이 가입 여부를 알려줍니다.**

없는 계정일 때도 미리 만들어둔 가짜 해시로 같은 계산을 한 번 합니다.

```typescript
const DUMMY_HASH = await hashPassword(randomBytes(32).toString("hex"));

export async function login(email: string, password: string): Promise<User | null> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) return null;

  const user = await findUserByEmail(email);
  const { ok, needsRehash } = await withHashSlot(() =>
    verifyPassword(password, user?.passwordHash ?? DUMMY_HASH),
  );
  if (!user || !ok) return null;

  if (needsRehash) {
    const next = await withHashSlot(() => hashPassword(password));
    await db.execute(
      `UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?`,
      [next, user.id, user.passwordHash],
    );
  }
  return user;
}
```

최상위 `await`는 ES 모듈에서만 됩니다. CommonJS라면 서버 시작 시점에 한 번 만들어두면 됩니다.

재해시의 `UPDATE`에 옛 해시 값을 조건으로 넣은 건, 같은 사용자의 로그인 두 건이 동시에 들어오거나 그 사이 비밀번호가 바뀌었을 때 엉뚱한 값으로 덮어쓰지 않기 위해서입니다. [낙관적 잠금 글](/blog/optimistic-locking-lost-update/)과 같은 발상입니다.

> 가짜 해시로 맞춰도 시간이 완전히 같아지지는 않습니다. 옛 bcrypt 해시가 남은 사용자, DB 조회 시간 차이 같은 잡음이 남습니다. 목표는 "쉽게 구분되지 않게"이고, 가입 화면이나 비밀번호 찾기에서 계정 존재를 따로 알려주고 있다면 여기만 막는 건 의미가 적습니다.

### 입력 길이에 상한을 둔다

scrypt와 Argon2는 bcrypt 같은 72바이트 제한이 없습니다. 그래도 상한은 둡니다. 수 메가바이트짜리 비밀번호를 받아줄 이유가 없고, 일부 구현에서는 입력이 길수록 비용이 커지기 때문입니다.
OWASP 치트 시트도 PBKDF2 구현에 따라 긴 비밀번호가 서비스 거부로 이어질 수 있다고 적고 있습니다. 상한은 글자 수가 아니라 바이트 수로 검사합니다.

### 정규화는 처음 정한 대로 계속

같은 한글 비밀번호도 입력 환경에 따라 다른 유니코드 바이트로 들어올 수 있습니다. 이 문제는 [유니코드 정규화 글](/blog/unicode-normalization-korean-nfc-nfd/)에서 다뤘습니다.
비밀번호에 정규화를 적용하기로 했다면 해시 전에 항상 같은 형식으로 바꿔야 하고, **도중에 도입하면 기존 해시가 맞지 않을 수 있습니다.** 도입 시점에는 정규화한 값으로 먼저 검증하고, 실패하면 원래 입력으로 한 번 더 검증한 뒤 재해시하는 식의 이행 기간이 필요합니다.

## 동시 해시 수를 제한한다

느린 해시는 공격자에게만 느린 게 아니라 우리 서버에게도 느립니다.
N=2^17, r=8인 scrypt는 해시 한 번에 128 MiB 정도를 잡습니다. 로그인 요청 20건이 동시에 들어오면 그 순간 2.5 GiB가 필요합니다.

### 스레드풀과 메모리

`crypto.scrypt`의 비동기 버전은 이벤트 루프를 막지는 않지만, libuv 스레드풀에서 돌아갑니다. 스레드풀 기본 크기는 4이고, 파일 시스템 작업, `dns.lookup`, zlib 압축과 같은 풀을 씁니다.
로그인이 몰리면 이 네 자리를 해시가 차지하고, 그동안 파일 읽기나 DNS 조회까지 줄을 섭니다. 동기 버전을 쓰면 아예 루프 전체가 멈춥니다. [이벤트 루프 블로킹 글](/blog/nodejs-event-loop-blocking/)에서 정리했던 표의 bcrypt 항목이 바로 이 이야기입니다.

메모리는 V8 힙 바깥의 네이티브 메모리로 잡히기 때문에 `--max-old-space-size`로는 제한되지 않습니다. 컨테이너 메모리 한도에 그대로 부딪혀 [OOMKill](/blog/nodejs-memory-leak-heap-oomkill/)로 끝날 수 있습니다.

### 세마포어로 상한 걸기

동시에 계산하는 해시 수를 프로세스 안에서 제한하고, 대기열도 상한을 둡니다. 대기열이 넘치면 기다리게 하지 않고 바로 거절하는 편이 낫습니다.

```typescript
const MAX_CONCURRENT_HASHES = 4;
const MAX_WAITING = 100;

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT_HASHES) {
    active++;
    return;
  }
  if (waiters.length >= MAX_WAITING) throw new Error("password hashing overloaded");
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next(); // 슬롯을 그대로 넘긴다. active는 줄이지 않는다
  else active--;
}

export async function withHashSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
```

`release`에서 `active`를 먼저 줄이고 대기자를 깨우면, 대기자가 실제로 재개되기 전에 새로 들어온 요청이 빈자리를 가로채서 잠깐 상한을 넘을 수 있습니다. 그래서 대기자가 있으면 슬롯을 **줄이지 않고 그대로 넘깁니다.**
과부하 예외는 HTTP 503으로 바꿔 돌려주면 됩니다. 로그인 실패(401)와 섞으면 클라이언트가 비밀번호가 틀린 줄 압니다.

메모리 예산은 `동시 해시 수 × 해시 한 번의 메모리`로 계산됩니다. 128 MiB × 4라면 해시만으로 512 MiB이니, 컨테이너 메모리 한도와 같이 정해야 합니다.
작은 컨테이너에서 이 예산이 안 나오면 OWASP 표의 다른 조합(N을 낮추고 p를 올리는 식)을 고르거나 Argon2id의 적은 메모리 설정을 고르는 것이 동시 수를 1로 줄이는 것보다 나을 수 있습니다.

> 세마포어는 프로세스 하나를 보호할 뿐, 공격 자체를 막지 않습니다. 계정·IP 단위의 시도 횟수 제한은 앞단에 따로 둬야 합니다. [레이트 리밋 글](/blog/rate-limiting-token-bucket-redis/)을 참고하세요.

## 비용 값은 어떻게 정하는가

OWASP 치트 시트는 해시 한 번이 1초를 넘지 않도록 하라는 정도의 일반 원칙만 주고, 정확한 값은 서버에서 직접 재보라고 합니다.
재볼 때는 해시 한 번의 시간만 보지 말고, **목표로 하는 동시 로그인 수에서의 지연과 메모리**를 같이 봐야 합니다. 개발 노트북에서 한 번에 0.3초는 운영 컨테이너에서 CPU 리밋에 걸려 훨씬 길어질 수 있습니다.

{% comment %} TODO: 운영 컨테이너 사양에서 직접 잰 scrypt/Argon2id 소요 시간과 선택한 파라미터가 있다면 표로 추가 {% endcomment %}

값을 올리는 건 쉽습니다. `CURRENT`만 바꾸고 배포하면, 다음 로그인부터 하나씩 새 설정으로 옮겨갑니다.
처음부터 파라미터를 해시 문자열에 같이 적어두는 이유가 이것입니다. 알고리즘을 고르는 일은 한 번이지만, 비용을 올리는 일은 계속 돌아옵니다.

