---
layout: post
title: "목록 API가 뒤로 갈수록 느려진다 — OFFSET과 커서 페이지네이션"
date: 2026-09-21
tags: [backend, mysql, sql, api, typescript]
excerpt: "첫 페이지는 10ms인데 뒤쪽 페이지는 초 단위로 걸리고, 무한 스크롤에서는 같은 글이 두 번 보입니다. 두 증상의 공통 원인인 OFFSET을 뜯어보고 커서(keyset) 페이지네이션의 구현과 한계, 페이지 번호를 포기 못 할 때의 타협까지 정리합니다."
---

목록 첫 페이지는 10ms에 나오는데 뒤쪽 페이지는 초 단위로 걸립니다. 쿼리도 인덱스도 한 번에 가져오는 건수도 같은데 그렇습니다.

그리고 사용자는 무한 스크롤을 내리다 같은 글을 두 번 봅니다.
성능 문제와 중복 노출은 따로 올라온 이슈지만, 원인은 한 곳입니다.

## OFFSET은 건너뛰지 않는다

`OFFSET`이라는 단어는 "그 지점부터 시작하라"처럼 읽히지만, 실제로 일어나는 일은 다릅니다.

```sql
SELECT id, title, created_at
FROM posts
WHERE board_id = 7
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 100000;
```

서버는 100,020행을 정렬 순서대로 읽고 **앞의 100,000행을 버립니다.**
건너뛰는 게 아니라 읽고 나서 버리는 것이라, 비용이 페이지 깊이에 정비례합니다.

`(board_id, created_at, id)` 인덱스가 있어서 정렬을 인덱스로 해결하더라도 마찬가지입니다. 정렬 비용이 사라질 뿐 읽는 행 수는 그대로입니다.
인덱스로 정렬이 풀리지 않으면 여기에 조건에 맞는 행 전체를 정렬하는 비용까지 더해집니다.

```sql
EXPLAIN SELECT id, title, created_at
FROM posts
WHERE board_id = 7
ORDER BY created_at DESC, id DESC
LIMIT 20 OFFSET 100000;
```

`rows` 추정치가 페이지를 넘길수록 커지는지, `Extra`에 `Using filesort`가 있는지를 봅니다.
둘 중 하나라도 걸리면 깊은 페이지는 언젠가 문제가 됩니다.

> 실행 시간을 실측하려면 `EXPLAIN ANALYZE`가 편하지만 지원 여부가 엔진·버전에 따라 다릅니다. 쓰는 DB의 현행 문서를 확인하세요.

이 문제가 늦게 발견되는 이유가 있습니다. 깊은 페이지를 보는 사람은 소수라 **평균 응답 시간에 거의 잡히지 않습니다.**
그러다 크롤러나 배치가 목록을 끝까지 순회하면, 그때 DB가 한 번에 탑니다.

## 더 조용한 문제 — 창이 움직인다

성능보다 먼저 사용자에게 보이는 건 이쪽입니다.

`OFFSET`은 "몇 개를 건너뛸지"를 말할 뿐 **"어디까지 봤는지"는 말하지 않습니다.**
그래서 페이지 사이에 목록이 바뀌면 기준점이 통째로 밀립니다.

1페이지(최신 20건)를 본 뒤, 다음 요청 전에 새 글 3건이 올라왔다고 해봅시다.
`OFFSET 20`이 가리키는 자리는 3칸 뒤로 밀려서, **2페이지의 앞 3건은 이미 1페이지에서 본 글**입니다.

반대로 그 사이에 글이 지워지면 창이 앞으로 당겨지면서 **아무도 보지 못한 글이 생깁니다.**
사용자 눈에는 중복만 보이고 누락은 안 보인다는 점이 더 고약합니다.

목록이 정적인 관리자 화면에서는 드러나지 않다가, 쓰기가 잦은 피드에서 무한 스크롤로 붙이는 순간 터집니다.

## 커서는 위치를 값으로 들고 다닌다

해결 방향은 하나입니다. 순서상의 **개수**가 아니라 마지막으로 본 **값**을 기준으로 다음을 요청합니다.

```sql
SELECT id, title, created_at
FROM posts
WHERE board_id = 7
  AND (created_at < ? OR (created_at = ? AND id < ?))
ORDER BY created_at DESC, id DESC
LIMIT 21;
```

읽는 행 수가 페이지 깊이와 무관해집니다. 인덱스에서 시작 지점을 찾아 거기서부터 21행만 읽습니다.
1페이지든 5000페이지든 비용이 같다는 뜻입니다.

전제는 **정렬 키 순서 그대로의 인덱스**입니다. 위 쿼리라면 `(board_id, created_at, id)`.
이 인덱스가 없으면 커서로 바꿔도 느린 건 그대로입니다. 구조를 바꾸기 전에 인덱스부터 확인하는 게 순서입니다.

### 동점 처리가 빠지면 조용히 누락된다

`created_at`만 커서로 쓰면 같은 시각에 들어온 행에서 어긋납니다.

같은 `created_at`을 가진 행이 3건이고 그중 2건이 이번 페이지 끝에 걸렸다고 해봅시다.
다음 요청을 `created_at < ?`로 보내면 남은 1건이 **영영 안 나옵니다.** `<=`로 보내면 이미 본 2건이 **또 나옵니다.**

그래서 정렬 키만으로는 부족하고 **유일한 값을 마지막 정렬 키로 덧붙여야** 합니다. 대개 PK입니다.
`ORDER BY`와 `WHERE`의 비교식에 같은 컬럼이 같은 순서·같은 방향으로 들어가야 한다는 점이 핵심입니다. 한쪽만 고치면 경계에서 어긋납니다.

초 단위 `DATETIME`을 정렬 키로 쓰면서 이 문제를 안 겪는 서비스는, 아직 같은 초에 두 건이 안 들어온 것뿐입니다.

### 행 생성자 비교

조건을 이렇게 짧게 쓸 수도 있습니다.

```sql
WHERE (created_at, id) < (?, ?)
```

의미는 위의 `OR` 형태와 같고 읽기도 좋습니다.

> 다만 옵티마이저가 이 형태를 인덱스 범위 스캔으로 풀어주는지는 엔진과 버전에 따라 다릅니다.
> 반드시 `EXPLAIN`으로 확인하고, 풀스캔으로 떨어지면 `OR`로 펼친 형태를 쓰세요. 결과는 같고 계획만 달라집니다.

## 구현

커서는 클라이언트가 그대로 되돌려주는 문자열이어야 합니다. 안에 뭐가 들었는지는 서버만 알면 됩니다.

```typescript
type Cursor = { t: string; id: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof c.t !== "string" || !Number.isInteger(c.id)) throw new Error();
    return c;
  } catch {
    throw new BadRequestError("잘못된 커서입니다");
  }
}
```

커서는 **외부에서 오는 입력**입니다. 파싱 실패와 타입 불일치를 400으로 끊지 않으면, 깨진 커서가 쿼리까지 내려가 500이 됩니다.

조회 쪽입니다. 다음 페이지가 있는지는 `limit + 1`건을 읽어서 판단합니다. 별도 `COUNT`가 필요 없습니다.

```typescript
async function listPosts(boardId: number, limit: number, cursor?: string) {
  const take = Math.min(Math.max(limit | 0, 1), 100);   // 상한을 서버가 정한다
  const c = cursor ? decodeCursor(cursor) : null;

  const rows = await db.query(
    `SELECT id, title, created_at,
            DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s.%f') AS cursor_t
       FROM posts
      WHERE board_id = ?
        ${c ? "AND (created_at < ? OR (created_at = ? AND id < ?))" : ""}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    c ? [boardId, c.t, c.t, c.id, take + 1] : [boardId, take + 1],
  );

  const hasNext = rows.length > take;
  const items = hasNext ? rows.slice(0, take) : rows;
  const last = items.at(-1);

  return {
    items: items.map(({ cursor_t, ...rest }) => rest),
    nextCursor: hasNext && last ? encodeCursor({ t: last.cursor_t, id: last.id }) : null,
  };
}
```

`DATE_FORMAT`으로 커서용 값을 따로 뽑은 이유가 있습니다.

`DATETIME(3)` 컬럼을 드라이버가 `Date` 객체로 바꾸고, 그걸 다시 문자열로 만드는 과정에서 **소수점 이하가 잘리거나 타임존이 끼어들면** 커서가 원래 값과 달라집니다.
그러면 경계에 있는 행이 누락되는데, 재현이 어려워서 원인을 찾기까지 오래 걸립니다.

DB가 만든 문자열을 그대로 왕복시키면 이 변환 구간이 없어집니다.
더 단순한 방법은 **정렬 키를 단조 증가하는 PK 하나로 두는 것**입니다. 가능하다면 이쪽이 항상 낫습니다.

## 커서에 무엇을 담고, 무엇을 담지 않을까

base64는 인코딩이지 암호화가 아닙니다. **안에 넣은 값은 노출된다고 보고** 설계합니다.
순번 PK를 담으면 전체 규모가 드러납니다. 그게 곤란한 서비스라면 정렬 키 자체를 추측 불가능한 값으로 두는 편이 낫습니다.

정렬 기준이나 필터가 바뀌면 이전 커서는 의미가 없어집니다.
커서에 정렬 키 이름을 같이 넣어두고, 요청의 정렬과 다르면 400으로 끊는 편이 낫습니다. 조용히 무시하면 결과가 뒤죽박죽 섞여 나오고 원인도 안 보입니다.

변조 방지가 필요하면 HMAC 서명을 붙일 수 있지만, 대부분은 과합니다.
**권한 검사는 커서가 아니라 쿼리 조건에서** 해야 합니다. 커서를 고쳐서 남의 데이터가 보인다면 그건 커서 문제가 아니라 권한 문제입니다.

## 뒤로 가기는 공짜가 아니다

앞으로만 가는 무한 스크롤이면 `nextCursor` 하나로 끝나지만, 이전 페이지 버튼이 있다면 반대 방향 조회가 필요합니다.

방향을 뒤집으려면 **비교 부호와 정렬을 같이 뒤집고, 받은 결과를 애플리케이션에서 되뒤집습니다.**

```sql
-- 이전 페이지: 부호와 ORDER BY를 모두 반대로
SELECT id, title, created_at
FROM posts
WHERE board_id = 7
  AND (created_at > ? OR (created_at = ? AND id > ?))
ORDER BY created_at ASC, id ASC
LIMIT 21;
```

이렇게 가져온 21건은 화면에 보여줄 순서의 역순이라, 응답을 만들기 전에 뒤집어야 합니다.
부호만 바꾸고 `ORDER BY`를 그대로 두면 **커서 바로 다음 것이 아니라 목록의 맨 끝**이 나옵니다. 조용히 엉뚱한 페이지가 나오는 실수라 테스트로 잡아두는 편이 좋습니다.

커서를 앞뒤 양쪽으로 내보내려면 페이지의 첫 행과 마지막 행에서 각각 만들어야 하고, 이전 페이지가 있는지도 따로 알아야 합니다.
여기까지 필요하다면 Relay 커넥션 명세처럼 이미 정리된 응답 형식을 참고하는 쪽이 빠릅니다. `hasNextPage`·`hasPreviousPage`를 어디서 채우는지에 대한 답이 이미 들어 있습니다.

## 커서가 못 하는 것들

바꾸면 잃는 것이 분명히 있습니다.

| | OFFSET | 커서 |
| --- | --- | --- |
| 임의 페이지 점프 (7페이지로) | 가능 | 불가 |
| 전체 페이지 수 표시 | 총 건수만 알면 가능 | 사실상 포기 |
| 깊은 페이지 비용 | 깊이에 비례 | 일정 |
| 목록 변동 중 중복·누락 | 발생 | 없음 (정렬 키가 불변일 때) |
| 구현 난이도 | 낮음 | 중간 |

총 건수는 어느 쪽이든 별도 `COUNT`가 필요하고, 조건이 붙으면 결국 세야 합니다. 현실적인 타협은 셋 중 하나입니다.

상한을 두고 세는 방법. "999+"까지만 보여주면 되는 화면이라면 충분합니다.

```sql
SELECT COUNT(*) AS cnt
FROM (SELECT 1 FROM posts WHERE board_id = 7 LIMIT 1000) AS t;
```

조건 없는 전체 건수이고 근사치로 족하다면 통계를 씁니다. InnoDB에서 `TABLE_ROWS`는 **추정값**이라 정확한 숫자가 필요한 곳에는 쓸 수 없습니다.

```sql
SELECT TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'posts';
```

그것도 안 되면 집계 테이블을 따로 두고 주기적으로 갱신합니다. 정확도와 비용을 바꾸는 선택입니다.

## 페이지 번호를 못 버릴 때

관리자 화면처럼 페이지 번호가 요구사항인 경우가 있습니다. 이때는 읽고 버리는 행을 **가볍게** 만드는 쪽으로 갑니다.

```sql
SELECT p.*
FROM posts AS p
JOIN (
  SELECT id
  FROM posts
  WHERE board_id = 7
  ORDER BY created_at DESC, id DESC
  LIMIT 20 OFFSET 100000
) AS x ON x.id = p.id
ORDER BY p.created_at DESC, p.id DESC;
```

안쪽 서브쿼리가 `(board_id, created_at, id)` 인덱스만으로 끝나면, 버려지는 10만 행에 대해 **테이블 행을 읽지 않습니다.**
비용은 여전히 깊이에 비례하지만 한 행당 상수가 훨씬 작아집니다.

근본 해결이 아니라 시간을 버는 선택입니다. 같이 두면 좋은 장치가 있습니다.

- 페이지 깊이에 상한을 둡니다. 검색 결과가 일정 페이지 이후로 안 넘어가는 서비스들이 이렇게 합니다.
- 기간·상태 같은 필터를 먼저 좁히게 만듭니다. 10만 페이지를 넘기는 사람은 대개 **찾는 방법이 없어서** 그러는 것입니다.

## 정렬 키가 변하면 커서는 깨진다

커서 페이지네이션의 안정성은 **정렬 키가 변하지 않는다**는 가정 위에 있습니다.

`updated_at DESC`로 정렬해놓고 커서를 쓰면, 스크롤하는 사이에 갱신된 항목이 목록 맨 앞으로 이동합니다.
이미 지나온 자리에서 앞으로 튀어나오니 **다시 보이고**, 반대 방향으로 밀린 항목은 **건너뜁니다.**

피하는 방법은 둘입니다. 정렬을 `created_at`이나 PK처럼 불변인 키로 두거나, 기준 시각을 커서에 함께 담아 `updated_at <= ?`로 목록을 그 시점에 고정하는 것입니다.
후자는 동작하지만 커서의 수명 관리가 따라붙습니다. 굳이 필요한 화면인지 먼저 보는 게 낫습니다.

`NULL`도 같은 종류의 함정입니다. `NULL`이 들어갈 수 있는 컬럼으로 정렬하면 비교식이 `NULL`을 만나 **그 행들이 통째로 빠집니다.**
게다가 `NULL`의 정렬 위치는 엔진마다 달라서 — MySQL은 오름차순에서 앞, PostgreSQL은 오름차순 기본이 뒤 — 옮기는 순간 순서가 바뀝니다.
정렬 키는 `NOT NULL` 컬럼으로 두는 편이 안전하고, 불가피하면 `COALESCE`로 정규화한 표현식을 기준으로 삼되 인덱스도 거기에 맞춰야 합니다.

## 무엇을 언제 쓸까

- **사용자 피드·무한 스크롤** — 커서. 중복 노출이 바로 보이는 화면이라 다른 선택지가 마땅치 않습니다.
- **배치·전량 순회, 외부에 제공하는 목록 API** — 커서. 깊은 `OFFSET`으로 끝까지 도는 순회가 DB를 태웁니다. 재실행 지점이 커서 하나로 남는다는 이점도 큽니다.
- **관리자 목록** — 건수가 적고 페이지 번호가 필요하면 `OFFSET`으로 둬도 됩니다. 대신 깊이 상한과 필터를 같이 겁니다.
- **인기순·개인화 점수·랜덤 정렬** — 커서가 성립하지 않습니다. 정렬 결과를 id 목록으로 한 번 실체화해 캐시하고, 그 목록 위에서 자르는 쪽으로 풉니다.

정리하면 `OFFSET`은 목록이 멈춰 있고 얕을 때만 맞습니다.
그 두 조건 중 하나라도 깨지는 화면이라면, 커서로 옮기는 비용은 인덱스 하나와 응답 형식 한 번 바꾸는 정도입니다.

{% comment %} TODO: 실제 테이블에서 페이지 깊이별 응답 시간을 재본 수치가 있으면 넣어주세요. 커서로 전환하면서 API 응답 형식을 어떻게 바꿨는지, 클라이언트 호환은 어떻게 유지했는지도 적으면 좋습니다 {% endcomment %}
