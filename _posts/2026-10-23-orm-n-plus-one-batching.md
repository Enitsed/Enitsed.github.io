---
layout: post
title: "목록 하나 그리는 데 쿼리가 200번 나간다 — 지연 로딩과 N+1을 어디서 끊는가"
date: 2026-10-23
tags: [backend, typescript, mysql, performance, api]
excerpt: "슬로우 쿼리 로그는 깨끗한데 목록 API만 느립니다. 쿼리 수가 데이터 수에 비례하는 구조와 그 흔적을 찾는 법, 조인으로 합칠 때 생기는 행 중복과 LIMIT의 함정, IN 배치로 묶는 구현과 드라이버가 걸리는 지점, DataLoader가 배치되지 않는 경우, 쿼리 수를 테스트로 고정하는 방법, 그리고 N+1을 그냥 두는 편이 나은 경우까지."
---

슬로우 쿼리 로그에는 아무것도 안 걸립니다. 모든 쿼리가 1ms 안에 끝나니까요.
그런데 목록 API 하나만 800ms가 나오고, 글 개수를 늘리면 비례해서 같이 느려집니다.

느린 쿼리가 하나도 없는데 응답이 느린 상태입니다.
문제는 쿼리의 속도가 아니라 **개수가 데이터 수에 묶여 있다**는 구조입니다.

## 쿼리 수가 데이터 수에 비례한다

목록을 가져오는 쿼리 한 번, 그리고 그 결과의 각 행마다 연관 데이터를 가져오는 쿼리 N번.
합이 1 + N이라 N+1이라고 부릅니다.

```typescript
const posts = await postRepo.find({ take: 20, order: { id: 'DESC' } });

for (const post of posts) {
  post.author       = await userRepo.findOneBy({ id: post.authorId });     // 20번
  post.tags         = await tagRepo.findBy({ postId: post.id });           // 20번
  post.commentCount = await commentRepo.countBy({ postId: post.id });      // 20번
}
```

쿼리 61번입니다. 각각은 기본키나 인덱스를 타는 가벼운 조회라서 **어느 하나도 느린 쿼리가 아닙니다.**

중첩되면 곱으로 갑니다. 댓글을 10개씩 붙이고 댓글마다 작성자를 가져오면 20 × 10이 더 붙습니다.

```text
글 목록            1
 └ 글마다 작성자    20
 └ 글마다 댓글      20
    └ 댓글마다 작성자 200
합계              241
```

여기서 실제로 시간을 먹는 건 DB가 일하는 시간이 아니라 **왕복 횟수**입니다.
쿼리 실행이 0.3ms라도 애플리케이션과 DB 사이 왕복이 1ms라면, 241번은 그 자체로 300ms에 가깝습니다.
DB CPU는 한가하고 애플리케이션도 한가한데 응답만 느린, 지표상으로는 범인이 안 보이는 모양이 됩니다.

> 지연이 왕복 수에 비례하므로, DB를 더 키워도 이 문제는 거의 개선되지 않습니다.
> 반대로 애플리케이션과 DB가 다른 가용영역·리전에 있으면 같은 코드가 몇 배로 느려집니다.

그리고 이게 트랜잭션 안에서 벌어지면 커넥션을 쥐고 있는 시간이 그만큼 늘어납니다.
동시 요청이 몇 개만 겹쳐도 [커넥션 풀이 마르는 쪽](/blog/db-connection-pool-exhaustion/)으로 번집니다.

## 흔적을 찾는 법

슬로우 쿼리 로그로는 안 보입니다. 기준은 "느린 쿼리"가 아니라 **"짧은데 많이 불린 쿼리"**입니다.

```sql
-- 호출 횟수 상위. 평균이 아주 짧으면서 COUNT_STAR가 큰 것이 N+1의 흔적이다
SELECT DIGEST_TEXT,
       COUNT_STAR,
       SUM_TIMER_WAIT / 1e12                AS total_sec,
       AVG_TIMER_WAIT / 1e9                 AS avg_ms
FROM performance_schema.events_statements_summary_by_digest
ORDER BY COUNT_STAR DESC
LIMIT 10;
```

누적값이라 재현 구간만 보려면 비우고 한 번 재현한 뒤 다시 조회합니다.

```sql
TRUNCATE performance_schema.events_statements_summary_by_digest;
```

`WHERE id = ?` 형태의 digest 하나가 수만 번씩 올라와 있으면 거기부터 봅니다.
다만 이건 서버 전체 기준이라 어느 엔드포인트가 범인인지는 알려주지 않습니다. 요청 단위로 묶어 보려면 애플리케이션 쪽 계측이 필요하고, 쿼리 스팬이 트레이스에 들어가 있으면 [트레이스 하나](/blog/opentelemetry-trace-context-sampling/)에서 같은 쿼리가 줄줄이 나오는 모양으로 바로 드러납니다.

## 조인 하나로 합칠 때 생기는 것

가장 먼저 떠오르는 해법은 조인입니다. 쿼리 한 번으로 끝나니까요.
1:N 관계에서는 **결과 행이 중복됩니다.** 글 하나에 댓글이 100개면 글 제목이 100번 실려 옵니다.

to-many 관계를 둘 이상 같이 조인하면 중복이 곱해집니다.

```sql
-- 태그 5개 × 댓글 100개 = 글 하나당 500행
SELECT p.id, p.title, t.name, c.body
FROM posts p
LEFT JOIN post_tags t ON t.post_id = p.id
LEFT JOIN comments  c ON c.post_id = p.id;
```

쿼리는 한 번이지만 전송량과 애플리케이션의 중복 제거 비용이 폭발합니다. **to-many는 한 쿼리에 하나까지**가 안전한 선입니다.

더 조용한 함정은 `LIMIT`입니다. 조인 결과에 `LIMIT 20`을 걸면 글 20개가 아니라 **조인된 행 20개**가 잘립니다.

```sql
-- 글 20개를 원했지만 댓글이 많은 글 몇 개로 20행이 채워진다
SELECT p.id, p.title, c.body
FROM posts p
LEFT JOIN comments c ON c.post_id = p.id
ORDER BY p.id DESC
LIMIT 20;
```

페이지네이션이 조용히 틀어지는 지점입니다. 다음 페이지에서 같은 글이 또 나오거나 중간 글이 사라지는데, [커서 페이지네이션](/blog/cursor-pagination-keyset/)으로 바꿔도 조인 쪽을 그대로 두면 증상은 남습니다.

해결은 **대상 행을 먼저 확정하고 나서 조인**하는 것입니다.

```sql
SELECT p.id, p.title, c.id AS comment_id, c.body
FROM (
  SELECT id, title
  FROM posts
  WHERE board_id = ?
  ORDER BY id DESC
  LIMIT 20
) AS p
LEFT JOIN comments c ON c.post_id = p.id
ORDER BY p.id DESC, c.id ASC;
```

안쪽 쿼리가 20행을 확정하고, 조인은 그 20개에 대해서만 일어납니다. 페이지 경계도 안쪽에서만 결정되니 어긋나지 않습니다.

## 배치 조회가 기본값이 되는 이유

조인보다 먼저 잡아야 할 기본형은 **관계별로 한 번씩, 키를 모아서 조회**하는 방식입니다.
쿼리 수가 관계 개수에 비례하고 데이터 수와는 무관해집니다. 241번이 3~4번이 됩니다.

```typescript
const [posts] = await pool.query<PostRow[]>(
  `SELECT id, author_id, title
     FROM posts
    WHERE board_id = ?
    ORDER BY id DESC
    LIMIT 20`,
  [boardId],
);

// 1) 키를 모은다. 중복은 반드시 제거한다
const authorIds = [...new Set(posts.map(p => p.author_id))];

// 2) 빈 배열 가드. IN () 은 문법 오류다
const authors = authorIds.length
  ? await loadAuthors(authorIds)
  : new Map<number, AuthorRow>();

// 3) 메모리에서 붙인다
const result = posts.map(p => ({
  id: p.id,
  title: p.title,
  author: authors.get(p.author_id) ?? null,
}));
```

빈 배열 가드를 빼먹으면 목록이 0건인 경우에만 터지는 버그가 됩니다. 테스트 데이터가 항상 있어서 개발 중에는 안 보입니다.

조회 함수는 키로 바로 찾을 수 있는 형태로 돌려주는 게 편합니다.

```typescript
async function loadAuthors(ids: number[]): Promise<Map<number, AuthorRow>> {
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.query<AuthorRow[]>(
    `SELECT id, nickname FROM users WHERE id IN (${placeholders})`,
    ids,
  );
  return new Map(rows.map(r => [r.id, r]));
}
```

플레이스홀더를 개수만큼 직접 만드는 이유가 있습니다.
mysql2는 `query()`에 배열을 넘기면 콤마 목록으로 펼쳐주지만, 프리페어드 경로인 `execute()`에서는 같은 식이 그대로 통하지 않습니다.
드라이버마다 다른 지점이라, 개수만큼 만들어 넘기면 양쪽에서 같게 동작합니다.

집계도 같은 방식으로 한 번에 가져옵니다. 글마다 `COUNT(*)`를 돌리는 코드가 N+1에서 가장 자주 남는 부분입니다.

```sql
SELECT post_id, COUNT(*) AS cnt
FROM comments
WHERE post_id IN (?, ?, ?)
GROUP BY post_id;
```

여기서 **댓글이 0개인 글은 결과에 아예 없습니다.** `Map`에서 못 찾은 키를 0으로 채우는 처리를 넣지 않으면 화면에 `undefined`가 나갑니다.

키 목록이 길어지면 쪼갭니다. `IN` 목록이 수만 개가 되면 쿼리 문장 자체가 커져 `max_allowed_packet`에 걸리고, 옵티마이저가 범위 분석에 쓰는 시간과 메모리도 같이 늘어납니다.

```typescript
const CHUNK = 500;

async function loadInChunks<K, V>(
  keys: K[],
  fetch: (slice: K[]) => Promise<Map<K, V>>,
): Promise<Map<K, V>> {
  const out = new Map<K, V>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = await fetch(keys.slice(i, i + CHUNK));
    for (const [k, v] of part) out.set(k, v);
  }
  return out;
}
```

청크 크기를 고정하는 데는 부수 효과가 하나 더 있습니다. 플레이스홀더 개수가 매번 달라지면 쿼리 문장이 매번 달라져서, 프리페어드 문장 캐시와 digest 통계가 흩어집니다.
개수가 몇 가지로 고정되면 위의 `COUNT_STAR` 상위 목록에서도 한 줄로 모여 보입니다.

{% comment %} TODO: 실제로 N+1을 잡은 엔드포인트가 있다면 — 쿼리 수가 몇 번에서 몇 번으로 줄었고 응답 시간이 어떻게 변했는지 적어주세요 {% endcomment %}

## 호출 지점을 모을 수 없을 때

위 방식은 "목록을 먼저 다 알고 있다"를 전제합니다. 코드 구조상 그게 안 되는 경우가 있습니다.
응답을 조립하는 자리가 여러 계층에 흩어져 있거나, 필드를 요청받은 만큼만 채우는 구조라면 키를 미리 모을 수 없습니다.

이럴 때 쓰는 것이 DataLoader 류의 배치 로더입니다. 개별 호출을 받아두고 같은 틱 안의 요청을 모아 한 번에 조회합니다.

```typescript
import DataLoader from 'dataloader';

function createAuthorLoader() {
  return new DataLoader<number, AuthorRow | null>(async (ids) => {
    const placeholders = ids.map(() => '?').join(',');
    const [rows] = await pool.query<AuthorRow[]>(
      `SELECT id, nickname FROM users WHERE id IN (${placeholders})`,
      [...ids],
    );
    const byId = new Map(rows.map(r => [r.id, r]));

    // 반환 배열은 키와 길이·순서가 같아야 한다
    return ids.map(id => byId.get(id) ?? null);
  });
}
```

마지막 줄이 이 도구에서 가장 중요합니다. 반환 배열의 길이나 순서가 키와 어긋나면 **다른 사람의 데이터가 섞여 나갑니다.**
에러가 아니라 조용히 틀린 응답이라 테스트가 없으면 오래 남습니다. DB가 `IN` 조회 결과의 순서를 보장하지 않는다는 점이 함정의 출발점입니다.

로더는 **요청마다 새로 만듭니다.**

```typescript
app.use((req, _res, next) => {
  req.loaders = { author: createAuthorLoader() };
  next();
});
```

DataLoader는 배치와 함께 캐시도 합니다. 인스턴스를 프로세스 전역으로 두면 그 캐시가 요청 경계를 넘어, 수정된 값이 오래 반영되지 않고 [테넌트 경계](/blog/multi-tenant-data-isolation/)도 같이 넘어갑니다.
요청 단위 캐시는 같은 요청 안에서 같은 값을 두 번 읽지 않게 해주는 용도까지가 적정선입니다.

그리고 배치가 안 되는 경우를 알아둬야 합니다. 배치는 **같은 틱에 쌓인 호출**을 모으는 것이라, `await`로 하나씩 기다리면 아무것도 모이지 않습니다.

```typescript
// 배치되지 않는다 — 호출이 서로 다른 틱에 흩어진다
for (const post of posts) {
  post.author = await loaders.author.load(post.authorId);
}

// 배치된다
const authors = await Promise.all(posts.map(p => loaders.author.load(p.authorId)));
```

위와 아래는 쿼리 수가 20번과 1번으로 갈립니다. 로더를 붙였는데 쿼리 수가 그대로라면 여기를 봅니다.

## ORM 기본값을 알고 쓰기

ORM의 지연 로딩은 N+1을 만들기 쉬운 쪽이 기본값인 경우가 많습니다. 관계 속성에 접근하는 순간 쿼리가 나가고, 그게 반복문 안이면 N번이 됩니다.

TypeORM이라면 `find`의 `relations`로 미리 지정하거나 쿼리 빌더로 명시적으로 조인합니다. 관계에 `eager: true`를 걸면 항상 같이 불러오는데, 이건 반대 방향의 문제를 만듭니다.
그 관계가 필요 없는 조회에서도 매번 따라붙어서, 목록 API 전체가 쓰지 않는 데이터를 실어 오게 됩니다.

Prisma라면 `include`와 `select`로 가져올 범위를 지정합니다. 관계를 별도 쿼리로 가져오는 전략과 조인으로 가져오는 전략을 고르는 옵션이 있는데, **지원 범위와 기본값이 버전과 DB에 따라 다르니 쓰는 버전의 공식 문서에서 확인**하세요.

공통으로 확인할 것은 두 가지입니다.

- 이 호출이 실제로 **몇 개의 쿼리**로 나가는가 — 로그를 켜서 눈으로 본다
- 조인 전략일 때 to-many가 몇 개나 걸려 있는가 — 위의 행 중복이 여기서 생긴다

어느 쪽이든 추측하지 말고 로그를 켜서 세는 게 빠릅니다.

| 방식 | 쿼리 수 | 전송량 | 페이지네이션 | 쓰기 좋은 때 |
| --- | --- | --- | --- | --- |
| 지연 로딩 그대로 | 1 + N (중첩 시 곱) | 최소 | 영향 없음 | 목록 상한이 작고 중첩이 없을 때 |
| 조인 한 번 | 1 | 행 중복만큼 증가 | 안쪽에서 확정해야 함 | to-one 관계, 한 건 상세 조회 |
| 키 모아 배치 | 관계 수만큼 | 최소 | 영향 없음 | 목록 조회의 기본값 |
| 배치 로더 | 관계 수만큼 | 최소 | 영향 없음 | 호출 지점이 흩어져 있을 때 |

## 쿼리 수를 테스트로 고정하기

N+1은 한 번 고쳐도 다시 들어옵니다. 리뷰에서 "여기 반복문 안에 조회가 있네요"를 매번 잡아내는 건 사람이 할 일이 아닙니다.
자동으로 막는 방법은 하나뿐입니다. **쿼리 수를 세서 단정하는 테스트.**

쿼리 이벤트 훅을 제공하는 ORM이면 그걸 쓰고, 없으면 테스트 환경에서만 얇게 감쌉니다.

```typescript
function createQueryCounter(pool: Pool) {
  let count = 0;
  const original = pool.query.bind(pool);

  (pool as unknown as { query: typeof original }).query = ((...args: Parameters<typeof original>) => {
    count += 1;
    return original(...args);
  }) as typeof original;

  return {
    get count() { return count; },
    reset() { count = 0; },
  };
}
```

단정은 **"쿼리 몇 번"이 아니라 "데이터가 늘어도 쿼리 수가 그대로"** 로 쓰는 편이 낫습니다.
절대 숫자로 적으면 정당한 리팩터링마다 테스트를 고치게 되고, 그러다 숫자를 올리는 커밋으로 N+1이 들어옵니다.

```typescript
it('목록 조회의 쿼리 수는 글 개수와 무관하다', async () => {
  await seedPosts(3);
  counter.reset();
  await listPosts({ boardId: 1, limit: 20 });
  const withThree = counter.count;

  await seedPosts(30);
  counter.reset();
  await listPosts({ boardId: 1, limit: 20 });

  expect(counter.count).toBe(withThree);
});
```

이 테스트가 통과하려면 실제 DB가 필요합니다. 데이터를 두 번 심는 구조라 [테스트 간 격리](/blog/db-integration-test-isolation/)가 되어 있지 않으면 순서에 따라 깨집니다.

## 그냥 두는 편이 나은 경우

N+1이 항상 고칠 문제는 아닙니다. 판단 기준은 두 가지입니다.

**목록 크기에 확실한 상한이 있는가.** 한 페이지 20개가 최대이고 관계가 기본키 단건 조회 하나뿐이라면, 추가 왕복 20번은 수 ms입니다.
그 왕복을 줄이려고 조립 코드를 세 겹으로 만드는 건 대개 남는 장사가 아닙니다.

**그 상한이 모든 호출 경로에 있는가.** 같은 함수가 배치나 내보내기에서 전체 건을 대상으로 다시 불리면, 20이 20만이 됩니다.
[대용량 내보내기](/blog/large-export-streaming-memory/)에서 터지는 코드가 화면에서는 멀쩡했던 이유가 대개 이것입니다. 상한은 함수가 아니라 호출 경로에 걸려 있습니다.

반대 방향으로 과하게 교정하는 경우도 있습니다. 조인 하나로 합치려다 전송량이 몇 배가 되거나, 조인 순서 때문에 인덱스를 못 타는 계획으로 떨어지는 경우입니다.
[복합 인덱스와 실행 계획](/blog/mysql-composite-index-column-order/) 쪽 확인 없이 조인으로 몰면, 쿼리 61번이 느린 쿼리 1번으로 바뀌기만 합니다.

쿼리 수는 줄일 대상이지 0으로 만들 대상이 아닙니다. **"데이터가 늘어도 늘지 않는가"** 가 기준이고, 3번이 4번이 되는 건 보통 문제가 아닙니다.

## DB 밖에서도 같은 모양이 나온다

같은 구조는 DB 바깥에서도 반복됩니다.

- 캐시 조회 — 키마다 `GET`을 돌리면 Redis 왕복이 N번입니다. `MGET`이나 파이프라인으로 묶습니다. 단일 스레드 서버라 왕복 N번은 [그 인스턴스의 처리량](/blog/redis-maxmemory-eviction-policy/)을 그만큼 먹습니다.
- 외부 API — 상대가 배치 조회를 제공하면 그걸 쓰고, 없으면 동시 실행 수를 제한해 묶습니다. 여기서는 [커넥션 재사용](/blog/http-client-keepalive-socket-exhaustion/) 쪽 비용도 같이 붙습니다.
- 객체 스토리지 — 목록의 각 항목마다 서명 URL을 만드는 건 네트워크 호출이 아니라 로컬 연산이지만, 메타데이터 조회가 끼면 같은 문제가 됩니다.

판단은 한 문장으로 줄어듭니다. **반복문 안에 네트워크 왕복이 있는가.**

## 체크리스트

- [ ] 반복문 안에서 DB·캐시·외부 API를 호출하는 자리가 있는가
- [ ] 목록 조회의 쿼리 수가 **결과 개수와 무관**한가
- [ ] `IN` 조회 전에 키 중복을 제거하고 **빈 배열을 가드**했는가
- [ ] 집계 결과에 없는 키를 기본값으로 채우는가
- [ ] to-many 관계를 한 쿼리에 둘 이상 조인하고 있지 않은가
- [ ] 조인에 `LIMIT`을 걸 때 대상 행을 안쪽에서 먼저 확정했는가
- [ ] 배치 로더의 반환 배열이 키와 길이·순서가 같은가
- [ ] 배치 로더 인스턴스가 요청 단위인가
- [ ] 로더를 쓰면서 `await`로 순차 호출해 배치를 무력화하고 있지 않은가
- [ ] 쿼리 수 불변을 단정하는 테스트가 있는가
- [ ] 같은 조립 함수가 상한 없는 경로(배치·내보내기)에서도 불리는지 확인했는가

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- N+1으로 느려진 엔드포인트와 원인이 된 코드 패턴
- 고친 뒤 쿼리 수·응답 시간 변화

{% endcomment %}
