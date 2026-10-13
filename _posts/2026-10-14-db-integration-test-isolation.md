---
layout: post
title: "혼자 돌리면 통과한다 — 실제 DB를 쓰는 테스트의 격리"
date: 2026-10-14
tags: [backend, testing, mysql, typescript, cicd]
excerpt: "파일 하나만 돌리면 초록인데 전체를 돌리면 손대지도 않은 테스트가 깨집니다. 상태가 새는 세 경로, 트랜잭션 롤백이 검증하지 못하는 것, 테이블 비우기가 FK에서 막히는 지점, 워커별로 DB를 나눠 병렬을 되찾는 방법, 그리고 고정값과 시계가 만드는 순서 의존까지."
---

파일 하나만 돌리면 전부 초록인데, CI에서 전체를 돌리면 이번에 손도 대지 않은 테스트가 빨개집니다.
그리고 재시도를 누르면 통과합니다.

이쯤 되면 "CI가 불안정하다"는 말이 나오고 재시도 버튼이 공식 절차가 됩니다.
깨지는 건 대개 테스트 코드가 아니라, 테스트들이 하나의 DB를 나눠 쓰는 방식입니다.

## 무엇이 샜는지부터 가른다

누수는 세 경로로 옵니다. 고치는 방법이 서로 다르니 먼저 구분해야 합니다.

- **남은 행** — 앞 테스트가 만든 데이터가 그대로 있어서 건수나 목록에 대한 단정이 깨집니다.
- **전진한 카운터** — `AUTO_INCREMENT`는 트랜잭션을 롤백해도 되돌아가지 않습니다.
- **고정값 충돌** — `test@example.com`을 두 테스트가 쓰면 유니크 제약이 둘 중 하나를 떨어뜨립니다.

두 번째가 가장 헷갈립니다. "격리를 했는데 왜 `id`가 1이 아니냐"는 질문이 여기서 나오는데, 롤백이 되돌리는 것은 행이지 시퀀스가 아닙니다.
그래서 `id`가 특정 값일 것이라는 가정은 어떤 격리 전략을 쓰든 결국 깨집니다.

순서 의존이 한번 생기면 진단이 어려워집니다. **실패한 테스트가 범인이 아니고, 실패 메시지에는 범인의 이름이 없습니다.**

증상을 재현하는 방법은 하나입니다. 실행 순서를 바꿔보는 것입니다.

```bash
# 파일 순서를 무작위로 섞어 돌린다 — 통과/실패가 갈리면 순서에 묶여 있다는 뜻
npx jest --randomize

# 한 프로세스에서 순차 실행. 병렬 때문인지 순서 때문인지 나뉜다
npx jest --runInBand
```

두 결과를 비교하면 범위가 좁혀집니다. `--runInBand`에서만 통과하면 병렬 충돌이고, 양쪽 모두 순서에 따라 갈리면 상태 누수입니다.

## 모킹으로 피하지 않기로 했다면

리포지토리를 모킹하면 이 문제가 전부 사라집니다. 대신 검증 대상도 같이 사라집니다.

모킹한 테스트가 증명하는 것은 "내가 적은 가짜가 내가 적은 대로 동작한다"입니다. 쿼리는 한 글자도 검증되지 않습니다.
유니크 제약, 외래키, `ON DUPLICATE KEY UPDATE`의 동작, 격리 수준에 따라 갈리는 읽기 — 이건 엔진만 알려줍니다.

> 기준은 이렇게 잡는 편이 깔끔합니다.
> **그 코드의 핵심이 SQL과 제약에 있으면 실제 DB로 테스트합니다.** 핵심이 분기와 계산에 있으면 모킹이 더 낫습니다.

실제 DB로 가기로 했다면, 그때부터는 격리를 어떻게 만들지가 설계 문제가 됩니다.

## 격리 전략 네 가지

| 전략 | 테스트당 비용 | 병렬 | 놓치는 것 |
| --- | --- | --- | --- |
| 트랜잭션 롤백 | 가장 낮음 | 커넥션 단위로 가능 | 커밋 이후 동작, 자체 트랜잭션 |
| 테이블 비우기 | 테이블 수에 비례 | 어려움 (같은 DB 공유) | 없음 |
| 워커별 DB | 셋업 1회 + 비우기 | 워커 수만큼 | 없음 |
| 실행마다 컨테이너 | 가장 높음 | 가능 | 없음 |

아래로 갈수록 정직해지고 느려집니다. 하나만 고르는 것보다, 대부분을 위쪽으로 처리하고 위쪽이 거짓말하는 영역만 아래쪽으로 내리는 조합이 현실적입니다.

### 트랜잭션 롤백 — 빠른 대신 거짓말을 한다

테스트를 트랜잭션으로 감싸고 끝에서 롤백하면 데이터가 남지 않습니다. 가장 빠르고, 이것만으로 되는 경우가 많습니다.

```typescript
import mysql from 'mysql2/promise';

export async function withRollback(
  pool: mysql.Pool,
  body: (conn: mysql.PoolConnection) => Promise<void>,
): Promise<void> {
  const conn = await pool.getConnection();
  await conn.beginTransaction();
  try {
    await body(conn);
  } finally {
    await conn.rollback();   // 성공해도 롤백한다
    conn.release();
  }
}
```

문제는 두 군데서 생깁니다.

첫째, **애플리케이션 코드가 풀에서 다른 커넥션을 꺼내면 테스트가 쓴 데이터를 못 봅니다.**
커밋되지 않은 변경은 그 트랜잭션 안에서만 보이기 때문입니다. 안 보이는 데서 끝나면 그나마 낫고, 같은 행을 건드리면 락을 기다리다 타임아웃까지 갑니다.

그래서 테스트 중에는 커넥션을 하나로 고정해야 합니다.

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<mysql.PoolConnection>();

// 애플리케이션 코드는 항상 이걸 거쳐 쿼리한다
export const db = (): mysql.Pool | mysql.PoolConnection =>
  store.getStore() ?? pool;

// 테스트는 자기 커넥션을 컨텍스트에 심는다
export const runPinned = <T>(conn: mysql.PoolConnection, fn: () => Promise<T>) =>
  store.run(conn, fn);
```

이 구조는 테스트만을 위한 것이 아닙니다. 운영 코드에서도 "이 요청의 트랜잭션"을 인자로 끌고 다니지 않게 해주는 쪽이라 손해는 아닙니다.

둘째, **애플리케이션이 자기 트랜잭션을 열면 테스트의 트랜잭션이 끝나버립니다.**
MySQL에서는 트랜잭션이 열려 있는 상태에서 `START TRANSACTION`을 다시 실행하면 진행 중인 트랜잭션이 암묵적으로 커밋됩니다.
테스트 끝에 롤백해도 되돌릴 것이 남아 있지 않고, 데이터는 그대로 DB에 남습니다.

중첩을 세이브포인트로 바꿔야 합니다.

```typescript
let depth = 0;   // 고정된 커넥션 하나에 대한 깊이

export async function transactional<T>(
  conn: mysql.PoolConnection,
  fn: () => Promise<T>,
): Promise<T> {
  const level = depth++;
  try {
    if (level === 0) await conn.beginTransaction();
    else await conn.query(`SAVEPOINT sp${level}`);

    const out = await fn();

    if (level === 0) await conn.commit();
    else await conn.query(`RELEASE SAVEPOINT sp${level}`);
    return out;
  } catch (err) {
    if (level === 0) await conn.rollback();
    else await conn.query(`ROLLBACK TO SAVEPOINT sp${level}`);
    throw err;
  } finally {
    depth--;
  }
}
```

테스트가 바깥에서 이미 트랜잭션을 열어둔 상태라면 `level`이 0이 아니게 되므로, 애플리케이션의 커밋이 세이브포인트 해제로 바뀝니다.
바깥 롤백 하나로 전부 되돌아갑니다.

여기까지 맞춰도 남는 한계가 있습니다. **커밋을 전제로 하는 코드는 이 방식으로 검증되지 않습니다.**

- 커밋 후에 동작하는 훅 — [아웃박스 릴레이](/blog/transactional-outbox-pattern/)나 커밋 이후 발행되는 이벤트
- 다른 커넥션에서 보이는지를 확인해야 하는 동작 — 유니크 충돌의 타이밍, [락 경쟁과 데드락](/blog/innodb-deadlock-gap-lock/)
- `TRUNCATE`나 `ALTER` 같은 암묵적 커밋을 일으키는 문장을 포함하는 경로

이 범주의 테스트는 롤백 방식에서 빼내 아래 전략으로 돌리는 편이 낫습니다. 전부 한 방식으로 묶으려다 세이브포인트 흉내가 점점 복잡해지는 쪽이 더 나쁩니다.

### 테이블 비우기 — 정직한 대신 FK에서 막힌다

실제로 커밋하고, 테스트 사이에 데이터를 지웁니다. 운영과 가장 가까운 상태로 돌아가는 방식입니다.

대상 테이블은 손으로 적지 말고 조회해서 가져옵니다. 손으로 적은 목록은 테이블이 추가될 때마다 조용히 낡습니다.

```sql
SELECT TABLE_NAME
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE()
   AND TABLE_TYPE = 'BASE TABLE';
```

문제는 지우는 순서입니다. 외래키가 걸려 있으면 자식부터 지워야 하고, 그 순서를 코드로 유지하는 것은 금방 부담이 됩니다.
그래서 세션에서 외래키 검사를 끄고 지우는 방법을 쓰게 됩니다.

```typescript
const KEEP = new Set(['migrations', '_prisma_migrations', 'schema_migrations']);

export async function resetTables(conn: mysql.PoolConnection): Promise<void> {
  const [rows] = await conn.query<mysql.RowDataPacket[]>(
    `SELECT TABLE_NAME AS name
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_TYPE = 'BASE TABLE'`,
  );

  const targets = rows
    .map((r) => String(r.name))
    .filter((name) => !KEEP.has(name));

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  try {
    for (const name of targets) {
      await conn.query(`TRUNCATE TABLE \`${name}\``);
    }
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  }
}
```

**풀이 아니라 커넥션 하나를 받는 것이 중요합니다.** `foreign_key_checks`는 세션 변수라서, 풀에 쿼리를 던지면 변수를 끈 커넥션과 `TRUNCATE`를 실행하는 커넥션이 달라질 수 있습니다.
그러면 검사를 껐는데도 실패합니다. 그리고 커넥션을 돌려주기 전에 반드시 다시 켜야 합니다. 안 켜면 그 커넥션을 물려받은 다음 테스트가 외래키 없는 DB를 보게 됩니다.

마이그레이션 이력 테이블을 제외하는 것도 빠뜨리기 쉽습니다. 이걸 비우면 다음 실행에서 마이그레이션 도구가 처음부터 다시 적용하려 듭니다.

> `TRUNCATE`와 외래키의 관계는 깔끔하지 않습니다. MySQL 문서는 다른 테이블이 참조하는 테이블에 대한 `TRUNCATE`는 실패한다고 설명하고, 실제 InnoDB에서는 검사를 끄면 통과하는 동작이 보고되어 있습니다([Bug #97501](https://bugs.mysql.com/bug.php?id=97501)).
> 문서와 구현이 어긋나는 지점에 테스트 기반을 올려두고 싶지 않다면, 자식 테이블부터 `DELETE`로 지우는 쪽이 안전합니다. 쓰는 엔진과 버전에서 한번 확인해보고 고르세요.

`DELETE`를 고르면 `AUTO_INCREMENT`가 초기화되지 않습니다. 앞에서 말한 대로 `id` 값에 단정을 걸지 않았다면 이건 문제가 아니고, 오히려 운영에 더 가깝습니다.

속도를 줄이고 싶으면 "건드린 테이블만 비우기"가 먼저 떠오르는데, 이걸 `information_schema`의 행 수 추정치로 판단하면 안 됩니다. InnoDB에서 그 값은 추정치라 0이 아니어도 비어 있을 수 있고 그 반대도 됩니다.
확실하게 하려면 테스트가 쓴 테이블을 애플리케이션 쪽에서 기록해두고 그 목록만 비우는 방식이어야 합니다. 대개는 그 복잡도를 들이기 전에 아래 방식으로 넘어가는 게 낫습니다.

### 병렬은 데이터가 아니라 공간을 나눈다

테이블 비우기는 정직하지만 병렬과 상성이 나쁩니다. 한 워커가 비우는 순간 다른 워커가 쓰던 데이터도 같이 사라집니다.
`--runInBand`로 병렬을 끄면 해결되지만, 테스트 시간이 워커 수만큼 늘어납니다.

해법은 데이터를 나누는 게 아니라 **워커마다 다른 DB를 주는 것**입니다.

```typescript
// test/setup.ts
const worker =
  process.env.JEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? '1';

process.env.DB_NAME = `app_test_${worker}`;
```

> 워커 식별자는 러너와 풀 설정에 따라 동작이 달라집니다. Jest는 `JEST_WORKER_ID`를, Vitest는 셋업 파일에서 `VITEST_POOL_ID`를 제공하지만, 격리 옵션이나 파일 병렬 설정에 따라 재사용될 수 있습니다.
> 값을 믿기 전에 **한번 로그로 찍어 워커마다 유일한지 직접 확인하세요.** 겹치면 격리가 없는 것과 같습니다.

이제 워커 수만큼 DB를 만들어야 합니다. 각 DB에 마이그레이션을 전부 돌리면 워커가 늘어날수록 셋업이 선형으로 길어지니, 한 번만 돌리고 스키마를 복사합니다.

```bash
#!/usr/bin/env bash
set -euo pipefail

WORKERS="${1:-4}"
MYSQL="mysql -h ${DB_HOST} -uroot -p${MYSQL_ROOT_PASSWORD}"

# 템플릿 DB에는 마이그레이션이 이미 적용되어 있다
mysqldump -h "${DB_HOST}" -uroot -p"${MYSQL_ROOT_PASSWORD}" \
  --no-data --skip-add-drop-table app_test_template > /tmp/schema.sql

for i in $(seq 1 "${WORKERS}"); do
  $MYSQL -e "DROP DATABASE IF EXISTS app_test_${i}; CREATE DATABASE app_test_${i};"
  $MYSQL "app_test_${i}" < /tmp/schema.sql
done
```

PostgreSQL이라면 더 깔끔합니다. 템플릿을 지정해 DB를 만들면 파일 복사로 끝나서 덤프를 거칠 필요가 없습니다.

```sql
-- 템플릿에 접속 중인 세션이 없어야 한다
CREATE DATABASE app_test_1 TEMPLATE app_test_template;
```

이 방식의 장점은 전략을 섞을 수 있다는 점입니다. 워커 안에서는 여전히 트랜잭션 롤백을 쓰고, 커밋이 필요한 테스트만 테이블 비우기로 돌리면 됩니다.
같은 DB를 보는 다른 워커가 없으므로 비우기가 남을 해치지 않습니다.

### 실행마다 컨테이너

Testcontainers처럼 테스트 실행 시점에 DB 컨테이너를 띄우는 방식도 있습니다. 로컬과 CI가 같은 절차로 돌아가고, 남은 상태가 원천적으로 없습니다.

대가는 시작 시간입니다. 매번 이미지를 올리고 스키마를 만드는 비용이 붙고, CI에서 도커 소켓을 쓸 수 있어야 합니다.
워커마다 컨테이너를 띄우면 그 비용에 워커 수가 곱해집니다.

컨테이너 하나를 띄우고 그 안에서 워커별 DB를 나누는 조합이 보통 균형이 맞습니다.

## 고정값을 쓰지 않는다

격리를 만들어도 테스트 데이터가 고정값이면 충돌은 남습니다. 팩토리에서 유일한 값을 만들어 쓰는 쪽이 간단합니다.

```typescript
let seq = 0;
const nextTag = () =>
  `${process.env.JEST_WORKER_ID ?? '1'}-${++seq}`;

export async function createUser(over: Partial<NewUser> = {}): Promise<User> {
  const tag = nextTag();
  return insertUser({
    email: `user-${tag}@test.local`,
    name: `user ${tag}`,
    status: 'active',
    ...over,
  });
}
```

워커 식별자를 접두사에 넣어두면, 혹시 DB를 공유하게 되더라도 값이 겹치지 않습니다.

그리고 **테스트가 전체를 조회해 건수를 세지 않게 만드는 것**이 더 근본적입니다.
`SELECT COUNT(*) FROM users`로 단정하는 테스트는 격리가 조금만 새도 깨지지만, 자기가 만든 사용자의 `id`로 조회하는 테스트는 남은 데이터가 있어도 통과합니다.

[멀티테넌시](/blog/multi-tenant-data-isolation/)를 쓰는 서비스라면 테스트마다 테넌트를 새로 만드는 방법이 그대로 격리가 됩니다.
덧붙여 테넌트가 하나뿐인 테스트는 격리 버그를 하나도 잡지 못하니, 어차피 두 개는 만들어야 합니다.

## 시계도 공유 상태다

시간을 고정하는 것은 격리의 일부입니다. 그런데 애플리케이션의 시계를 고정해도 DB의 시계는 고정되지 않습니다.

```typescript
jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
```

스키마에 `DEFAULT CURRENT_TIMESTAMP`가 걸려 있으면 그 값은 DB 서버가 채웁니다. 고정한 시계와 비교하는 단정은 여기서 깨집니다.
검증이 시간에 의존한다면 **생성 시각을 애플리케이션에서 명시적으로 넣어 쓰는 쪽**이 테스트하기 쉽습니다.

테스트 DB의 세션 타임존이 운영과 다르면 하루 경계 집계 같은 테스트가 로컬에서만 통과합니다. 이건 테스트 문제가 아니라 [타임존을 어디서 잃어버리는가](/blog/timezone-datetime-day-boundary/)의 문제이고, 테스트 환경에서 먼저 드러나는 쪽이 운이 좋은 경우입니다.

## CI에서 드는 비용

CI에서 DB를 붙일 때 가장 자주 밟는 것은 **서비스가 준비되기 전에 테스트가 시작되는 것**입니다.
컨테이너가 떴다는 것과 DB가 접속을 받는다는 것은 다릅니다.

```yaml
test:
  image: node:22
  services:
    - name: mysql:8.0            # 운영 엔진 버전과 맞춘다
      alias: mysql
  variables:
    MYSQL_ROOT_PASSWORD: test
    MYSQL_DATABASE: app_test_template
    DB_HOST: mysql
  script:
    - npm ci
    - ./scripts/wait-for-db.sh
    - npm run migrate            # 템플릿에 1회
    - ./scripts/clone-test-dbs.sh 4
    - npm test -- --maxWorkers=4
```

대기는 핑이 아니라 실제 쿼리로 확인해야 합니다. 서버가 응답한다는 것이 초기화 스크립트가 끝났다는 뜻은 아니기 때문입니다.

```bash
#!/usr/bin/env bash
set -uo pipefail

for _ in $(seq 1 30); do
  if mysql -h "${DB_HOST}" -uroot -p"${MYSQL_ROOT_PASSWORD}" \
      -e 'SELECT 1' app_test_template >/dev/null 2>&1; then
    exit 0
  fi
  sleep 2
done

echo "database not ready" >&2
exit 1
```

이미지 태그를 운영 엔진 버전에 맞추는 것도 그냥 깔끔함의 문제가 아닙니다.
기본 콜레이션이나 `sql_mode`가 다르면 정렬과 비교 결과가 달라져서, **운영에서 거부될 쓰기가 테스트에서 통과합니다.** 그 반대도 생깁니다.

워커 수는 러너 코어 수에 맞춰 고정하는 편이 낫습니다. 러너 사양이 바뀌면 기본값이 알아서 늘어나면서 DB가 커넥션 한도에 닿는데, 이때 나오는 실패는 격리 버그처럼 보이지 않습니다.

{% comment %} TODO: 실제로 어떤 전략을 쓰고 있는지, 전체 테스트 시간이 어떻게 변했는지 적어주세요 {% endcomment %}

## 무엇을 고를까

하나로 정하려 하지 않는 쪽이 결과가 좋습니다.

- **기본은 트랜잭션 롤백.** 가장 빠르고 대부분의 쿼리·제약 검증에 충분합니다. 커넥션 고정과 세이브포인트만 먼저 깔아둡니다.
- **커밋이 필요한 테스트는 따로 분류.** 아웃박스, 락 경쟁, 커밋 후 훅. 이쪽은 테이블 비우기로 돌립니다.
- **병렬이 필요해지면 워커별 DB.** 테스트가 느려서 아무도 로컬에서 안 돌리는 상태가 되는 것이 격리가 조금 허술한 것보다 나쁩니다.
- **`id`와 건수와 고정 문자열에는 단정을 걸지 않는다.** 전략과 무관하게 이것만으로 깨지는 테스트가 꽤 줄어듭니다.

마지막으로, 순서를 섞어 돌리는 설정을 CI에 켜두는 편이 좋습니다.
순서 의존은 한번 들어오면 쌓이는 종류의 부채이고, 들어온 날 잡는 것이 몇 달 뒤 남이 잡는 것보다 훨씬 쌉니다.

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 순서 의존 때문에 디버깅에 오래 걸렸던 사례
- 테스트 DB를 나누면서 바뀐 CI 시간

{% endcomment %}
