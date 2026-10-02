---
layout: post
title: "조건 하나를 빠뜨리면 남의 데이터가 보인다 — 멀티테넌시 격리를 어디서 강제하는가"
date: 2026-10-03
tags: [backend, mysql, architecture, security, typescript]
excerpt: "공유 테이블 멀티테넌시는 모든 쿼리에 붙는 WHERE 한 줄에 격리를 맡깁니다. 그 줄이 빠지는 자리들, 요청 컨텍스트와 데이터 접근 계층으로 강제하는 법, PostgreSQL RLS가 DB로 내려주는 것과 MySQL에서 대신 할 수 있는 것, 그리고 테넌트가 하나뿐인 테스트가 왜 아무것도 못 잡는지."
---

B2B 서비스의 데이터는 거의 전부 "누구 것인가"가 붙어 다닙니다. 그리고 그 구분은 대개 쿼리 조건 한 줄로만 존재합니다.

조건 하나를 빠뜨려도 에러는 안 납니다. 쿼리는 성공하고, 응답은 200이고, 화면에는 데이터가 더 많이 나올 뿐입니다.
그게 남의 데이터라는 건 아무도 모르거나, 고객이 먼저 압니다.

## 격리를 어느 층에 둘 것인가

선택지는 크게 셋입니다. 무엇을 고르든 격리는 어딘가에서 강제되어야 하고, 층이 내려갈수록 실수로 뚫릴 여지가 줄어듭니다.

| | 공유 테이블 + 식별 컬럼 | 스키마 분리 | 인스턴스 분리 |
| --- | --- | --- | --- |
| 격리 강제 지점 | 애플리케이션 쿼리 | 접속 대상 | 접속 대상 |
| 스키마 변경 | 한 번 | 테넌트 수만큼 | 테넌트 수만큼 |
| 테넌트 추가 비용 | 행 하나 | 스키마 생성 + 마이그레이션 | 프로비저닝 |
| 교차 집계 | 쉬움 | 어려움 | 사실상 불가 |
| 시끄러운 이웃 | 그대로 전파 | 대부분 전파 | 차단 |
| 전체 사고 반경 | 전체 테넌트 | 전체 테넌트 | 한 테넌트 |

대부분의 서비스는 공유 테이블로 시작하고, 그게 대체로 맞는 선택입니다.
테넌트가 수백 수천 개인데 스키마를 그만큼 두면 마이그레이션 한 번이 운영 작업이 되고, 커넥션 풀도 테넌트 수만큼 쪼개집니다.

다만 그 선택에는 명시적인 대가가 붙습니다. **격리를 DB가 아니라 코드가 책임진다**는 것, 그리고 **사고가 나면 한 테넌트가 아니라 전체가 범위**라는 것입니다.
이 글은 그 대가를 어디서 줄일 수 있는지에 대한 이야기입니다.

> 규제나 계약으로 물리적 분리가 요구되는 테넌트가 섞여 있다면 이건 설계 선택이 아니라 요구사항입니다.
> 그 경우 공유 테이블에 "아주 잘 짠 필터"를 올리는 것으로는 대체되지 않습니다.

## 그 한 줄은 어디서 빠지는가

`WHERE tenant_id = ?`를 빠뜨리는 건 게을러서가 아닙니다. 조건을 붙일 자리가 눈에 안 보이는 경우가 대부분입니다.

가장 흔한 건 조인의 반대쪽입니다.

```sql
-- 주문은 테넌트로 걸렀지만, 품목은 주문 ID로만 걸렀다
SELECT oi.*
FROM order_items oi
JOIN orders o ON o.id = oi.order_id
WHERE o.tenant_id = ?;        -- 여기까진 맞다

-- 그런데 품목을 직접 조회하는 경로가 따로 생기면
SELECT * FROM order_items WHERE order_id = ?;   -- 조건이 사라졌다
```

두 번째 쿼리는 `order_id`를 아는 사람만 부를 수 있으니 괜찮다고 생각하기 쉽습니다.
그런데 그 ID가 순차 증가하는 정수라면, 숫자 하나 바꿔보는 것으로 남의 주문 품목이 나옵니다. 전형적인 IDOR입니다.

조건이 빠지는 자리는 대체로 정해져 있습니다.

- **조인·서브쿼리의 종속 테이블** — 부모만 거르고 자식은 ID로만 거는 경우
- **백그라운드 작업** — 크론, 큐 컨슈머, 리포트 배치에는 "요청한 사람"이 없습니다
- **관리자 화면** — 전체를 봐야 하는 화면이라 처음부터 조건이 없고, 그 코드가 복사됩니다
- **집계 쿼리** — `COUNT`, `SUM`은 행을 안 돌려주니 리뷰에서 덜 의심받습니다
- **캐시** — 쿼리는 맞았는데 캐시 키에 테넌트가 없으면 결과가 섞입니다

여기서 중요한 건 **리뷰로는 이걸 막을 수 없다**는 점입니다.
쿼리 100개 중 99개를 맞춰도 1개면 사고고, 쿼리는 계속 늘어납니다. 사람의 주의력에 비례하는 방어는 코드베이스 크기에 반비례해 약해집니다.

## 요청마다 테넌트를 들고 다니기

강제의 출발점은 "지금 처리 중인 요청이 어느 테넌트인가"를 어디서든 꺼낼 수 있게 만드는 것입니다.

함수마다 `tenantId`를 인자로 넘기는 방법이 가장 명시적이지만, 호출 깊이가 조금만 깊어지면 중간 계층이 전부 그 인자를 통과시켜야 합니다.
그러다 누군가 편의상 `tenantId`를 안 받는 함수를 하나 만들면 그 아래로는 사라집니다.

Node라면 `AsyncLocalStorage`로 요청 수명 동안 암묵적으로 들고 다닐 수 있습니다.

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

type Ctx = { tenantId: string };
const store = new AsyncLocalStorage<Ctx>();

export function runInTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return store.run({ tenantId }, fn);
}

/** 컨텍스트가 없으면 조용히 넘어가지 않고 던진다 */
export function currentTenantId(): string {
  const ctx = store.getStore();
  if (!ctx) throw new Error('tenant context missing');
  return ctx.tenantId;
}
```

`currentTenantId()`가 **기본값을 돌려주지 않는 것**이 핵심입니다.
여기서 `?? null`이나 `?? 'default'`를 돌려주면, 컨텍스트를 안 연 코드가 조용히 전체 조회로 바뀝니다. 가장 위험한 실패를 가장 조용하게 만드는 선택입니다.

인증 미들웨어에서 컨텍스트를 엽니다. 이때 테넌트 ID는 **요청 본문이나 쿼리스트링이 아니라 검증된 토큰에서** 가져와야 합니다.
클라이언트가 보낸 `tenantId`를 그대로 쓰면 격리 장치 전체가 파라미터 한 줄로 우회됩니다.

```typescript
app.use(async (req, res, next) => {
  const claims = await verifyAccessToken(req);   // 서명 검증된 클레임
  runInTenant(claims.tenantId, async () => next()).catch(next);
});
```

큐 컨슈머와 크론은 요청이 없으니 컨텍스트를 **직접 열어야** 합니다. 메시지 페이로드에 테넌트를 실어 보내고, 소비할 때 그걸로 엽니다.
앞서 `currentTenantId()`가 던지도록 해둔 덕분에, 컨텍스트를 안 연 잡은 첫 실행에서 바로 터집니다. 조용히 전체를 훑는 것보다 훨씬 나은 실패입니다.

## 데이터 접근 계층에서 자동으로 붙이기

컨텍스트가 생겼으면, 쿼리를 날리는 지점에서 조건을 자동으로 붙입니다. 개발자가 기억해서 붙이는 게 아니라, 안 붙이는 게 더 어렵게 만드는 쪽입니다.

```typescript
/** 테넌트 조건이 항상 붙는 조회 */
export async function tenantSelect<T>(
  table: string,
  where: Record<string, unknown> = {},
): Promise<T[]> {
  const cond = { ...where, tenant_id: currentTenantId() };
  const keys = Object.keys(cond);
  const sql = `SELECT * FROM \`${table}\` WHERE ${keys.map((k) => `\`${k}\` = ?`).join(' AND ')}`;
  const [rows] = await pool.query(sql, Object.values(cond));
  return rows as T[];
}

/** 쓰기도 마찬가지로 테넌트를 주입한다 */
export async function tenantInsert(table: string, values: Record<string, unknown>) {
  const row = { ...values, tenant_id: currentTenantId() };
  await pool.query(`INSERT INTO \`${table}\` SET ?`, [row]);
}
```

`tenant_id`를 `where` 뒤에 전개한 것도 의도입니다. 호출자가 `where`에 `tenant_id`를 넣어 보내도 컨텍스트 값이 덮어씁니다.
직접 지정할 수 있게 열어두면 그 구멍으로 결국 다른 테넌트가 들어옵니다.

문제는 이 헬퍼로 모든 쿼리를 쓸 수 없다는 것입니다. 조인, 집계, 복잡한 리포트는 결국 손으로 쓴 SQL이 됩니다.
그 탈출구를 없앨 수는 없으니, 대신 **눈에 띄게** 만듭니다.

```typescript
/**
 * 테넌트 조건이 자동으로 붙지 않는다. 호출부에서 직접 책임진다.
 * 이름이 길고 거슬리는 것이 의도다.
 */
export async function rawQueryWithoutTenantScope<T>(sql: string, params: unknown[]): Promise<T[]> {
  const [rows] = await pool.query(sql, params);
  return rows as T[];
}
```

이렇게 해두면 리뷰에서 "여기 왜 이걸 썼나"를 물을 지점이 생기고, 코드베이스 전체에서 위험한 쿼리를 `grep` 한 번으로 셀 수 있게 됩니다.
막을 수 없는 구멍은 **세는 것이 가능한 형태**로 만들어두는 편이 낫습니다.

## DB가 강제해주는 쪽

애플리케이션 계층 강제의 한계는 분명합니다. 그 계층을 거치지 않는 경로 — 운영자의 직접 접속, 마이그레이션 스크립트, 다른 언어로 짠 배치 — 는 전부 무방비입니다.

PostgreSQL이라면 이걸 DB로 내릴 수 있습니다. Row Level Security는 테이블에 정책을 걸어서, 세션 변수에 맞는 행만 보이게 만듭니다.

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON orders
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
```

`USING`은 읽기에, `WITH CHECK`는 쓰기에 적용됩니다. 둘 다 걸어야 **남의 테넌트 ID로 INSERT 하는 것**까지 막힙니다.
`FORCE`가 필요한 이유는 테이블 소유자가 기본적으로 자기 테이블의 RLS를 우회하기 때문입니다. 애플리케이션이 소유자 계정으로 붙는 흔한 구성에서는 이게 없으면 정책이 아무 일도 하지 않습니다.

> 커넥션 풀을 쓴다면 세션 변수를 **트랜잭션 범위로** 설정해야 합니다.
> 세션 수명으로 설정하면 커넥션이 풀로 반납될 때 값이 남고, 그 커넥션을 집어간 다음 요청이 **앞사람의 테넌트를 물려받습니다.**
> 격리를 위해 넣은 장치가 가장 찾기 어려운 누수를 만드는 경우입니다.

```typescript
await client.query('BEGIN');
// 세 번째 인자 true = 트랜잭션이 끝나면 되돌아간다
await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', currentTenantId()]);
// ... 이 트랜잭션 안의 쿼리는 전부 정책이 걸린 상태로 돈다
await client.query('COMMIT');
```

공짜는 아닙니다. 조건이 쿼리문에 안 보이니 실행 계획을 읽을 때 한 겹 더 생각해야 하고, 정책 조건과 사용자 조건이 어떤 순서로 평가되는지에 따라 계획이 달라질 수 있습니다.
"왜 이 행이 안 나오지"의 원인이 코드가 아니라 정책에 있는 상황도 디버깅 난이도를 올립니다. 그래도 **빠뜨릴 수 없는 조건**이라는 성질과 바꿀 만한 값입니다.

## MySQL에는 그게 없다

MySQL에는 행 수준 보안에 해당하는 기능이 없습니다. 그래서 같은 보장을 얻으려면 우회로를 써야 하는데, 어느 쪽도 깔끔하지 않습니다.

테넌트별 뷰와 `SQL SECURITY DEFINER`를 조합하는 방법이 있습니다. 다만 뷰를 테넌트 수만큼 만들어야 하고, 접속 계정을 테넌트별로 나누면 커넥션 풀이 그만큼 쪼개집니다.
테넌트가 수십 개만 돼도 유지되지 않는 구조입니다.

프록시 계층에서 SQL을 파싱해 조건을 주입하는 방법도 있지만, 파서가 애플리케이션이 만들어내는 모든 SQL을 정확히 이해해야 한다는 전제가 붙습니다. 그 전제가 깨지는 날이 사고 나는 날입니다.

현실적인 결론은 **MySQL에서는 애플리케이션 계층 강제가 사실상 유일한 수단**이라는 것입니다.
그렇다면 남은 일은 그 계층을 더 단단하게 만드는 것과, 뚫렸을 때 빨리 아는 것입니다. 아래 두 절이 그 이야기입니다.

## 인덱스 선두를 테넌트로

공유 테이블에서는 거의 모든 쿼리에 `tenant_id`가 붙습니다. 그러면 복합 인덱스의 선두 컬럼도 거기여야 합니다.

```sql
-- 목록: 테넌트 안에서 최신순
CREATE INDEX idx_orders_tenant_created ON orders (tenant_id, created_at DESC, id DESC);

-- 상태별 조회
CREATE INDEX idx_orders_tenant_status ON orders (tenant_id, status, created_at DESC);

-- 테넌트 안에서만 유일한 값
CREATE UNIQUE INDEX uq_orders_tenant_order_no ON orders (tenant_id, order_no);
```

마지막 유니크 인덱스가 특히 중요합니다. 주문번호·사번·코드처럼 "우리 회사 안에서 유일하면 되는" 값에 전역 유니크를 걸면,
B 테넌트가 이미 쓴 번호라는 이유로 A 테넌트의 등록이 거부됩니다. 그 에러는 원인을 설명하기도 곤란합니다.

선두 컬럼을 테넌트로 두면 부수 효과가 하나 더 생깁니다. **조건을 빠뜨린 쿼리가 느려집니다.**
인덱스를 못 타고 풀 스캔으로 떨어지니 슬로우 쿼리 로그에 남고, 정확성 버그가 성능 신호로 먼저 드러납니다. 조용히 틀리는 것보다 시끄럽게 느린 쪽이 낫습니다.

한 가지 주의할 점은 테넌트 간 데이터 편차입니다. 전체 행의 대부분을 차지하는 테넌트와 수십 행뿐인 테넌트가 같은 테이블에 섞여 있으면,
옵티마이저가 평균치로 추정한 계획이 어느 한쪽에서는 틀립니다. 큰 테넌트에서만 느린 쿼리가 있다면 여기를 의심할 자리입니다.

{% comment %} TODO: 실제 운영에서 테넌트 간 데이터 편차 때문에 계획이 틀어진 사례가 있었다면 적어주세요 {% endcomment %}

## 테넌트가 하나인 테스트는 아무것도 못 잡는다

격리 버그가 운영까지 가는 가장 큰 이유는 테스트 환경에 테넌트가 하나뿐이기 때문입니다.
조건이 빠진 쿼리도 테넌트가 하나면 정확히 맞는 결과를 돌려줍니다. **버그가 있는 코드와 없는 코드가 똑같이 통과합니다.**

그래서 픽스처에 테넌트를 최소 둘 넣고, 교차 접근을 명시적으로 검증합니다.

```typescript
describe('테넌트 격리', () => {
  let a: Fixture, b: Fixture;

  beforeEach(async () => {
    a = await seedTenant({ orders: 3 });
    b = await seedTenant({ orders: 5 });
  });

  it('목록에 다른 테넌트의 행이 섞이지 않는다', async () => {
    const res = await request(app).get('/orders').set(authFor(a)).expect(200);
    expect(res.body.items).toHaveLength(3);
    expect(res.body.items.every((o) => o.tenantId === a.tenantId)).toBe(true);
  });

  it('다른 테넌트의 리소스를 ID로 직접 열 수 없다', async () => {
    await request(app).get(`/orders/${b.orders[0].id}`).set(authFor(a)).expect(404);
  });

  it('다른 테넌트의 리소스를 ID로 수정할 수 없다', async () => {
    await request(app).patch(`/orders/${b.orders[0].id}`).set(authFor(a)).send({ memo: 'x' }).expect(404);
  });
});
```

두 번째 테스트에서 `403`이 아니라 `404`를 기대한 것도 의도입니다. `403`은 "그 ID는 존재하지만 당신 것이 아니다"를 알려주는 응답이라, 식별자의 존재 여부가 샙니다.
남의 테넌트 리소스는 **없는 것처럼** 보이는 편이 맞습니다.

이 세 가지를 리소스 종류마다 반복하는 건 지루한 일이라, 라우트 목록을 돌면서 생성하는 쪽이 현실적입니다.
새 엔드포인트가 추가되면 교차 접근 테스트도 자동으로 따라붙게 만들어두면, 기억에 의존하는 지점이 하나 줄어듭니다.

## DB 밖에서 새는 자리

쿼리를 다 막아도 테넌트 구분이 사라지는 곳이 남습니다. 대개 "키"를 만드는 자리입니다.

- **캐시 키** — `user:123` 같은 키는 테넌트가 다르면 다른 사람입니다. 접두사에 테넌트를 넣습니다
- **오브젝트 스토리지 경로** — `uploads/<파일명>`은 충돌하고, 서명 URL 발급 시 소유 검증도 어려워집니다. `tenants/<tenantId>/...`로 나눕니다
- **검색 인덱스** — 색인 문서에 테넌트 필드를 넣고 질의에 필터를 강제합니다. 여기도 빠뜨리면 조용히 섞입니다
- **로그와 트레이스** — 반대 방향의 문제입니다. 테넌트 식별자가 **없으면** 사고가 났을 때 영향 범위를 못 셉니다
- **에러 메시지와 알림** — 다른 테넌트의 이름이나 식별자가 본문에 섞여 나가는 경로가 의외로 많습니다

캐시는 특히 발견이 늦습니다. 코드는 맞고, 쿼리도 맞고, 재현도 잘 안 되는데 가끔 남의 데이터가 보입니다.
캐시 키를 만드는 함수를 하나로 모으고 그 함수가 테넌트를 강제로 붙이게 하는 것이, 호출부마다 기억하는 것보다 확실합니다.

## 정리

- 공유 테이블은 대부분의 경우 맞는 선택이지만, 격리 책임이 DB에서 코드로 넘어오고 사고 반경이 전체가 된다는 대가가 붙습니다
- 조건은 리뷰가 아니라 구조로 붙입니다. 요청 컨텍스트 + 데이터 접근 계층 자동 주입, 탈출구는 이름으로 눈에 띄게
- 컨텍스트가 없을 때 기본값을 주지 않습니다. 조용한 전체 조회보다 시끄러운 예외가 낫습니다
- 테넌트 ID는 토큰에서 가져옵니다. 요청 파라미터에서 읽으면 장치 전체가 우회됩니다
- PostgreSQL이라면 RLS로 내릴 수 있고, 그 경우 세션 변수는 반드시 트랜잭션 범위로 설정합니다
- 모든 복합 인덱스 선두를 `tenant_id`로. 유니크 제약도 테넌트 복합으로
- 픽스처에 테넌트를 둘 이상 두지 않으면 격리 테스트는 전부 거짓 통과합니다
- 캐시 키·스토리지 경로·검색 인덱스처럼 DB 밖에서 키를 만드는 자리를 따로 점검합니다

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 격리 누수를 발견한 경로와 대응
- 테넌트 규모가 커지면서 바꾼 설계

{% endcomment %}
