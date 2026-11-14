---
layout: post
title: "열 건을 요청했는데 세 건이 돌아온다 — 필터를 붙인 벡터 검색의 재현율"
date: 2026-11-15
tags: [backend, database, llm, search, performance]
excerpt: "WHERE 한 줄을 붙인 순간부터 LIMIT 10이 10건을 보장하지 않습니다. 근사 인덱스가 필터보다 먼저 끝난다는 구조에서 출발해, pgvector의 반복 스캔과 ordering 모드, 선택도에 따라 정확 검색·부분 인덱스·파티셔닝 중 무엇을 고를지, 재현율을 실제로 재는 방법까지 정리합니다."
---

유사 문서를 뽑는 쿼리에 `LIMIT 10`을 걸었는데 세 건이 돌아옵니다.
조건에 맞는 문서는 수백 건이 있고, 인덱스를 지우고 같은 쿼리를 돌리면 열 건이 제대로 나옵니다.

버그가 아니라 근사 인덱스가 원래 그렇게 동작합니다.
그리고 이 증상은 `WHERE` 한 줄이 붙은 순간부터 시작됩니다.

## 인덱스를 먼저 지나고, 걸러지는 건 그 다음이다

RAG 검색용 청크 테이블을 이렇게 두었다고 하겠습니다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE doc_chunks (
  id          bigserial   PRIMARY KEY,
  center_id   bigint      NOT NULL,            -- 테넌트
  doc_id      bigint      NOT NULL,
  chunk_no    int         NOT NULL,
  content     text        NOT NULL,
  embedding   vector(1536),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX doc_chunks_embedding_idx
  ON doc_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

그리고 테넌트 조건을 붙여 검색합니다. 당연히 붙여야 하는 조건입니다.

```sql
SELECT id, content, embedding <=> $1 AS distance
FROM doc_chunks
WHERE center_id = $2
ORDER BY embedding <=> $1
LIMIT 10;
```

이 쿼리를 읽을 때 머릿속에 그려지는 순서는 "`center_id`로 좁히고, 그 안에서 가까운 10건"입니다.
실제 실행 순서는 반대입니다.

HNSW 인덱스 스캔이 **전체 벡터 공간에서** 후보를 뽑고, `center_id` 조건은 그 후보 목록에 **나중에** 적용됩니다.
후보 개수는 `hnsw.ef_search`가 정하고 기본값은 40입니다.

그래서 조건이 전체의 10%를 걸러낸다면, 후보 40건 중 평균 4건만 살아남습니다.
공식 문서가 바로 이 숫자를 예로 들어 설명합니다. `LIMIT 10`은 "최대 10건"일 뿐이고, 하한을 약속한 적이 없습니다.

전체 10%가 아니라 100분의 1인 작은 테넌트라면 평균 0.4건입니다. 거의 매번 빈 결과를 받습니다.

## ef_search를 올리는 것으로 끝나지 않는 이유

가장 먼저 떠오르는 대응은 후보를 늘리는 것입니다.

```sql
SET hnsw.ef_search = 200;
```

재현율은 올라갑니다. 대신 후보를 더 많이 탐색하니 지연 시간도 같이 올라갑니다.
그리고 `ef_search`보다 큰 `LIMIT`은 애초에 채워질 수 없으니, 최소한 `LIMIT` 이상은 되어야 합니다.

근본적인 문제는 **필요한 값이 쿼리마다 다르다**는 점입니다.
필터가 걸러내는 비율에 반비례해서 커져야 하는데, 그 비율은 테넌트마다 다르고 같은 테넌트도 데이터가 쌓이면서 변합니다.

큰 테넌트에 맞춰 40을 쓰면 작은 테넌트가 빈 결과를 받고, 작은 테넌트에 맞춰 1000을 쓰면 큰 테넌트의 모든 질의가 그 비용을 냅니다.
고정값 하나로 맞출 수 있는 종류의 문제가 아닙니다.

## 반복 스캔 — 모자라면 더 훑게 만들기

pgvector 0.8.0부터 **반복 스캔(iterative index scan)** 이 들어왔습니다.
결과가 `LIMIT`을 채우지 못하면 인덱스를 더 훑어서 채우는 동작이고, 기본적으로 꺼져 있습니다.

```sql
SET hnsw.iterative_scan = strict_order;
```

ordering 모드가 두 가지입니다.

| | `strict_order` | `relaxed_order` |
| --- | --- | --- |
| 거리 정렬 | 정확하게 보장 | 약간 어긋날 수 있다 |
| 재현율 | 상대적으로 낮다 | 더 좋다 |
| IVFFlat 지원 | 없음 | 있음 |
| 쓰는 자리 | 정렬 순서를 그대로 쓰는 경우 | 재순위(rerank)를 뒤에 붙이는 경우 |

LLM 컨텍스트에 넣기 전에 리랭커를 한 번 더 통과시킨다면 `relaxed_order`가 합리적입니다. 어차피 순서는 다시 정해집니다.
순서를 그대로 화면에 쓰거나 "가장 비슷한 한 건"을 뽑는 용도라면 `strict_order` 쪽이 안전합니다.

`relaxed_order`를 쓰면서 순서까지 맞추고 싶으면 materialized CTE로 감싸고 바깥에서 다시 정렬합니다.

```sql
WITH relaxed AS MATERIALIZED (
  SELECT id, content, embedding <=> $1 AS distance
  FROM doc_chunks
  WHERE center_id = $2
  ORDER BY embedding <=> $1
  LIMIT 10
)
SELECT * FROM relaxed ORDER BY distance + 0;
```

> `+ 0`이 붙은 건 오타가 아닙니다. Postgres 17 이상에서는 이게 없으면 바깥 정렬이 그대로 유지되지 않습니다. 공식 문서가 명시하고 있는 요구사항입니다.

### 어디까지 훑고 멈추는가

근사 인덱스를 끝까지 훑으면 근사 인덱스를 쓰는 이유가 없어지므로, 멈추는 지점이 설정으로 있습니다.

```sql
SET hnsw.max_scan_tuples = 20000;      -- 방문할 튜플 상한, 기본 20000
SET hnsw.scan_mem_multiplier = 2;      -- work_mem의 배수로 메모리 상한, 기본 1
```

`max_scan_tuples`는 **근사값이고 최초 스캔에는 영향을 주지 않습니다.**
그리고 상한까지 훑고도 못 채웠으면 그냥 `LIMIT`보다 적게 돌려줍니다. 반복 스캔을 켜도 결과 개수가 보장되지는 않는다는 뜻입니다.

상한을 올렸는데 재현율이 나아지지 않으면 `scan_mem_multiplier`를 올려보라고 문서가 안내합니다. 메모리 쪽에서 먼저 걸리고 있는 경우입니다.

IVFFlat은 설정 이름이 다릅니다.

```sql
SET ivfflat.iterative_scan = relaxed_order;
SET ivfflat.max_probes = 100;          -- ivfflat.probes보다 작으면 probes 값이 쓰인다
```

### 풀을 쓸 때는 SET LOCAL

`SET`은 세션에 남습니다. 커넥션 풀 환경에서는 그 커넥션을 다음에 받은 요청이 남은 설정을 그대로 물려받습니다.

```sql
BEGIN;
SET LOCAL hnsw.iterative_scan = strict_order;
SET LOCAL hnsw.ef_search = 100;
SELECT id, content, embedding <=> $1 AS distance
FROM doc_chunks
WHERE center_id = $2
ORDER BY embedding <=> $1
LIMIT 10;
COMMIT;
```

`SET LOCAL`은 트랜잭션이 끝나면 되돌아갑니다.
검색 한 번을 위해 트랜잭션을 여는 게 과해 보이지만, [커넥션 풀](/blog/db-connection-pool-exhaustion/)을 쓰는 서버에서 설정 누수를 막는 가장 확실한 방법입니다.

## 거리로 자를 때는 조건을 CTE 밖에 둔다

"유사도가 일정 수준 이상인 것만 컨텍스트에 넣는다"는 요구는 거리 조건으로 표현됩니다.
이때 조건을 안쪽 `WHERE`에 넣으면 실행 계획이 나빠집니다. 문서는 materialized CTE 바깥에 두라고 권합니다.

```sql
WITH nearest AS MATERIALIZED (
  SELECT id, content, embedding <=> $1 AS distance
  FROM doc_chunks
  WHERE center_id = $2          -- 그 외 필터는 안쪽에
  ORDER BY embedding <=> $1
  LIMIT 20
)
SELECT * FROM nearest
WHERE distance < 0.35           -- 거리 조건만 바깥에
ORDER BY distance;
```

규칙이 둘로 갈립니다. **거리 조건은 바깥, 나머지 필터는 안쪽.**

반복 스캔과 거리 조건을 섞을 때는 한 가지를 더 의식해야 합니다.
조건을 만족하는 행이 애초에 거의 없는 질의가 들어오면, 채우려는 쪽은 상한까지 계속 훑습니다. 결과가 0건인 질의가 가장 비싼 질의가 됩니다.

## 선택도에 따라 답이 달라진다

반복 스캔은 만능 해결책이 아니라 선택지 하나입니다. 필터가 얼마나 걸러내는지에 따라 더 나은 답이 있습니다.

| 필터가 남기는 비율 | 권장 | 이유 |
| --- | --- | --- |
| 매우 낮다 (조건에 맞는 행이 적다) | B-tree 정확 검색 | 전부 거리 계산해도 싸고, 재현율이 100% |
| 구분값이 몇 개뿐이다 | 부분 인덱스 | 값마다 독립된 그래프 |
| 구분값이 많다 | 파티셔닝 | 파티션별 인덱스로 분리 |
| 그 외 | 반복 스캔 + `ef_search` 조정 | 범용, 대신 지연 시간 변동 |

조건에 맞는 행이 수백 건 수준이라면 벡터 인덱스를 아예 타지 않는 쪽이 낫습니다.

```sql
CREATE INDEX doc_chunks_center_idx ON doc_chunks (center_id);
```

이러면 `center_id`로 좁힌 행만 전부 거리 계산을 하고 정렬합니다.
근사가 아니라 정확한 kNN이고, 좁혀진 집합이 작으면 HNSW보다 빠릅니다. 문서도 "낮은 비율을 매칭하는 조건에는 정확 인덱스가 잘 맞는다"고 적고 있습니다.

구분값이 적을 때는 조건을 인덱스에 박아버릴 수 있습니다.

```sql
CREATE INDEX doc_chunks_notice_idx
  ON doc_chunks USING hnsw (embedding vector_cosine_ops)
  WHERE (doc_type = 'notice');
```

이 인덱스 안에는 해당 조건을 만족하는 벡터만 들어갑니다. 스캔 결과가 나중에 걸러질 일이 없으니 재현율 문제가 사라집니다.
대신 조건 조합이 늘어날 때마다 인덱스가 하나씩 늘어나므로, 값이 몇 개로 고정된 경우에만 쓸 수 있습니다.

어느 계획이 선택됐는지는 추측하지 말고 확인합니다.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM doc_chunks
WHERE center_id = 42
ORDER BY embedding <=> '[...]'
LIMIT 10;
```

벡터 인덱스 이름이 계획에 나오는지, 아니면 B-tree로 좁힌 뒤 정렬하고 있는지를 봅니다.
[복합 인덱스를 읽을 때](/blog/mysql-composite-index-column-order/)와 마찬가지로, 여기서도 "인덱스가 있다"와 "인덱스를 쓴다"는 다른 얘기입니다.

## 테넌트가 한 인덱스에 섞여 있을 때

하나의 근사 인덱스를 여러 테넌트가 공유하면, **한 테넌트의 벡터가 다른 테넌트의 재현율과 속도에 영향을 줍니다.**
문서가 멀티테넌시 항목을 따로 두고 경고하는 내용입니다.

문서가 수십만 건인 테넌트 하나가 들어오면, 그 벡터들이 후보 목록을 선점해서 작은 테넌트의 결과가 더 비어 갑니다.
테넌트별 격리가 필요하면 리스트 파티셔닝이나 별도 테이블을 씁니다.

```sql
CREATE TABLE doc_chunks (
  id        bigserial,
  center_id bigint NOT NULL,
  embedding vector(1536),
  content   text   NOT NULL
) PARTITION BY LIST (center_id);
```

트레이드오프가 분명합니다. 파티션마다 인덱스를 따로 만들고 유지해야 하고, 테넌트가 늘어나는 만큼 파티션과 인덱스가 늘어납니다.
파티션 수가 많아지면 계획 수립 자체가 비용이 되고, 새 테넌트를 받는 절차에 DDL이 끼어듭니다.

테넌트 수가 수십 수준이고 규모 차이가 크다면 격리가 낫습니다.
테넌트가 계속 늘어나는 구조라면 공유 인덱스 + 반복 스캔으로 가고, 거대 테넌트만 따로 떼는 쪽이 현실적입니다.
[멀티테넌시 격리](/blog/multi-tenant-data-isolation/)에서 조건 누락을 막는 문제와는 또 다른 층위의 결정입니다.

## 재현율을 실제로 재는 방법

지금까지의 설정은 전부 재현율과 지연 시간을 교환하는 것인데, 재현율을 재지 않으면 어느 쪽으로 교환했는지 알 수 없습니다.

정답은 정확 검색으로 만듭니다. 인덱스 스캔을 끄면 근사 없이 전수 계산을 합니다.

```sql
BEGIN;
SET LOCAL enable_indexscan = off;
SET LOCAL enable_bitmapscan = off;
SELECT id FROM doc_chunks
WHERE center_id = 42
ORDER BY embedding <=> '[...]'
LIMIT 10;
COMMIT;
```

이 결과와 운영 설정으로 돌린 결과를 겹쳐서 봅니다.

```typescript
type Row = { id: string };

/** recall@k = (정확 상위 k와 겹친 개수) / k 의 질의 평균 */
export async function measureRecall(
  queries: number[][],
  centerId: number,
  k: number,
): Promise<number> {
  let hits = 0;

  for (const q of queries) {
    const truth: Row[] = await exactTopK(q, centerId, k);  // 인덱스 끈 전수 검색
    const got: Row[] = await annTopK(q, centerId, k);      // 운영과 동일한 설정

    const truthIds = new Set(truth.map((r) => r.id));
    hits += got.filter((r) => truthIds.has(r.id)).length;
  }

  return hits / (queries.length * k);
}
```

표본은 합성 벡터가 아니라 **실제 사용자 질의 로그**에서 뽑는 편이 낫습니다.
질의 분포가 재현율을 좌우하고, 사용자가 실제로 묻는 질문은 균일 분포와 거리가 멉니다.

테넌트 규모별로 나눠서 재는 것도 중요합니다. 전체 평균이 0.95여도 작은 테넌트만 0.4일 수 있고, 그쪽이 바로 민원이 들어오는 쪽입니다.

{% comment %} TODO: 실제 데이터로 ef_search·반복 스캔 조합별 recall@10과 p95 지연 시간을 재서 표로 넣으면 좋습니다 {% endcomment %}

## 결과가 비는 다른 이유들

필터와 무관하게 결과가 적어지는 경우도 있어서, 원인을 섞지 않으려면 같이 알아둘 필요가 있습니다.

**인덱스에 안 들어간 벡터.** `NULL` 벡터는 인덱스에 들어가지 않고, 코사인 거리에서는 영벡터도 마찬가지입니다.
임베딩 생성이 실패해 `NULL`로 남은 행이 있으면 그 문서는 검색에 걸리지 않습니다. 적재 파이프라인에서 세어볼 만합니다.

```sql
SELECT count(*) FROM doc_chunks WHERE embedding IS NULL;
```

**죽은 튜플.** 후보 중 죽은 튜플이 섞이면 그만큼 버려지고 결과가 줄어듭니다.
재색인·대량 갱신이 잦은 테이블에서 특히 두드러집니다.

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE relname = 'doc_chunks';
```

`n_dead_tup`이 꾸준히 쌓인다면 이 테이블의 autovacuum을 더 공격적으로 잡거나, 필요하면 인덱스를 다시 만듭니다.

```sql
REINDEX INDEX CONCURRENTLY doc_chunks_embedding_idx;
```

**인덱스가 메모리에 안 들어가는 경우.** 재현율이 아니라 지연 시간 쪽 문제지만 증상이 비슷하게 보입니다.
차원이 크면 `halfvec`으로 절반 정밀도 저장을 고려할 수 있습니다. 저장 크기는 `2 * 차원 + 8` 바이트이고, 절반 정밀도 인덱싱은 4000차원까지 지원합니다.

> 반복 스캔은 pgvector 0.8.0에서 들어온 기능입니다. 관리형 Postgres는 확장 버전이 엔진 버전과 별개로 움직이니, 설정이 없다는 오류가 나면 먼저 버전을 확인하세요.

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
```

## 벡터만으로 안 되는 질의

마지막으로, 재현율을 끝까지 끌어올려도 벡터 검색이 못 잡는 질의가 있습니다.
사람 이름, 문서 번호, 날짜처럼 **철자가 정확히 일치해야 하는** 것들입니다.

임베딩은 의미가 비슷한 것을 찾는 도구라서, 비슷한 이름의 다른 사람을 가까운 거리로 돌려줍니다.
이 영역은 키워드 검색이 맡는 편이 낫고, [한국어 전문 검색](/blog/mysql-korean-fulltext-ngram/)과 벡터 검색의 결과를 합쳐 재순위를 매기는 구성으로 갑니다.

## 정리

- `LIMIT n`은 하한이 아니다. 필터가 붙은 근사 검색에서는 더 적게 온다
- 필터는 인덱스 스캔 **뒤에** 적용된다. 이 순서가 모든 증상의 원인
- `ef_search`만 올리는 건 고정값으로 변동하는 선택도를 맞추려는 시도
- 반복 스캔은 범용 대응. `strict_order`와 `relaxed_order`는 뒤에 리랭커가 있는지로 고른다
- 거리 조건은 materialized CTE 바깥, 나머지 필터는 안쪽
- 조건이 매우 선택적이면 근사 인덱스를 버리고 정확 검색이 낫다
- 테넌트 격리는 파티셔닝으로 가능하지만 파티션 수가 비용이 된다
- 설정을 바꿨으면 recall을 재고, 테넌트 규모별로 나눠서 본다

설정값 하나를 정답으로 고정하려는 시도가 이 문제에서는 거의 실패합니다.
재현율을 측정 가능한 지표로 만들어두고, 질의 분포가 바뀔 때 다시 보는 쪽이 오래 갑니다.
