---
layout: post
title: "역할이 하나 늘 때마다 if문 서른 군데를 고친다 — 역할·권한·리소스 범위"
date: 2026-11-08
tags: [backend, auth, security, typescript, api]
excerpt: "role === 'ADMIN' 비교가 코드 전체에 퍼진 뒤에 역할을 하나 추가하면 무엇이 깨지는지. 역할과 권한을 끊는 지점, 기본 거부를 어디서 강제하는가, 단건 권한 체크가 목록 조회에서 통하지 않는 이유, 토큰에 담은 권한을 되돌리는 비용."
---

권한 코드는 처음에 한 줄로 시작합니다. `if (user.role !== "ADMIN") throw forbidden()`.

역할이 둘일 때는 이게 가장 읽기 쉬운 코드입니다.
문제는 세 번째 역할이 들어올 때 드러납니다. 그 역할이 할 수 있는 일을 정하려면, 이미 `ADMIN`을 비교하고 있는 모든 자리를 찾아 하나씩 판단해야 합니다.

## 세 가지 질문이 한 줄에 섞여 있다

권한 처리가 지저분해지는 첫 번째 이유는 성질이 다른 질문을 같은 조건문에서 답하기 때문입니다.

| 질문 | 무엇으로 답하는가 | 틀렸을 때 |
| --- | --- | --- |
| 누구인가 | 토큰·세션 검증 | 401 |
| 이 행위를 할 수 있는가 | 권한(permission) | 403 |
| 이 리소스에 대해서인가 | 리소스 범위(scope)·소유 관계 | 403 또는 404 |

두 번째는 행위 단위라서 요청만 보면 판단할 수 있습니다. "문서를 수정할 수 있는 사람인가"는 DB에 가지 않고도 알 수 있습니다.

세 번째는 대상을 봐야 합니다. "문서를 수정할 수 있는 사람"이라는 사실이 "이 문서를 수정할 수 있다"를 뜻하지는 않기 때문입니다.
역할 비교만으로 끝낸 코드가 조용히 실패하는 자리는 거의 항상 세 번째입니다.

## 역할을 직접 비교하면 역할이 코드가 된다

`role === "ADMIN"`이 코드 전체에 퍼지면, 역할 목록이 곧 분기 목록이 됩니다.
역할을 추가하는 작업이 "모든 비교 지점을 찾아 다시 판단하는 작업"이 되고, 빠뜨린 자리는 배포 후에 발견됩니다.

한 단 내려서 **행위**를 기준으로 비교하면 추가 지점이 한 곳으로 모입니다.

```typescript
export const PERMISSIONS = [
  "document:read",          // 본인 것과 공유받은 것
  "document:read:all",      // 조직 전체
  "document:write",
  "document:delete",
  "member:invite",
  "billing:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export type Role = "OWNER" | "MANAGER" | "MEMBER" | "VIEWER";

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER:   PERMISSIONS,
  MANAGER: ["document:read", "document:read:all", "document:write",
            "document:delete", "member:invite"],
  MEMBER:  ["document:read", "document:write"],
  VIEWER:  ["document:read"],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
```

`Record<Role, ...>`로 선언한 덕에 역할을 추가하면 **매핑을 채우지 않는 한 컴파일이 안 됩니다.** 빠뜨릴 수 있는 자리를 타입으로 막는 게 이 구조의 실질적인 이득입니다.

역할→권한 매핑을 코드에 둘지 DB에 둘지는 갈립니다.

- **코드**: 변경이 배포를 거치므로 리뷰와 이력이 남습니다. 역할이 제품 사양으로 고정돼 있을 때 적합합니다.
- **DB**: 운영 중에 바꿀 수 있고 고객사별로 다르게 줄 수 있습니다. 대신 "지금 이 역할이 뭘 할 수 있는지"가 환경마다 달라져서, 재현이 어려운 버그가 생깁니다.

둘 다 필요해지면 보통 **권한 목록은 코드, 역할 구성은 DB**로 나눕니다. 권한 이름은 코드가 참조하는 식별자라서 운영자가 만들 수 있게 열어두면 오타 하나가 권한 누락이 됩니다.

## 선언하지 않은 라우트는 열려 있다

권한 체크를 핸들러 안에서 하면, 체크를 안 쓴 핸들러와 쓴 핸들러가 겉보기에 똑같습니다.
새 엔드포인트를 추가하면서 한 줄을 빠뜨렸는지 코드를 열어보지 않고는 알 수 없습니다.

라우트 정의에 필요한 권한을 **선언**으로 올려두면 이게 눈에 보입니다.

```typescript
import { RequestHandler } from "express";

export function requirePermission(permission: Permission): RequestHandler {
  return (req, res, next) => {
    const actor = req.actor;                       // 인증 미들웨어가 채운다
    if (!actor) return res.status(401).end();
    if (!can(actor.role, permission)) return res.status(403).end();
    next();
  };
}

router.get("/documents",        requirePermission("document:read"),   listDocuments);
router.patch("/documents/:id",  requirePermission("document:write"),  updateDocument);
router.delete("/documents/:id", requirePermission("document:delete"), deleteDocument);
```

여기서 한 걸음 더 나가면 **기본 거부**를 만들 수 있습니다. 미들웨어가 통과시킬 때 요청에 흔적을 남기고, 응답을 내보내기 전에 그 흔적이 없으면 막는 방식입니다.

```typescript
// requirePermission 안에서: next() 직전에 표시를 남긴다
(req as AuthzRequest).authzChecked = true;

// 라우터 뒤에 둔다. 권한 선언 없이 처리된 요청을 잡는다.
app.use((req, res, next) => {
  if (!(req as AuthzRequest).authzChecked && !PUBLIC_PATHS.has(req.path)) {
    logger.error({ method: req.method, path: req.path }, "authz_missing");
    if (process.env.NODE_ENV !== "production") return res.status(500).end();
  }
  next();
});
```

> 운영에서 곧바로 500을 내보내는 선택은 신중해야 합니다. 선언을 빠뜨린 라우트가 하나 있으면 그 경로가 즉시 장애가 됩니다.
> 먼저 로그와 알람으로 돌려서 누락을 0으로 만든 뒤에 차단으로 올리는 순서가 안전합니다.

더 확실한 방법은 테스트에서 라우트 목록을 훑어, 권한 선언이 없는 경로를 공개 목록과 대조하는 것입니다. 런타임이 아니라 CI에서 걸립니다.

## 권한이 있어도 그 리소스에 대해서는 아니다

`document:write`를 가진 사용자가 남의 문서 ID를 넣어 호출하면 어떻게 되는지가 실제 문제입니다.
미들웨어는 통과합니다. 행위 권한은 맞으니까요.

흔히 쓰는 모양은 조회 후 비교입니다.

```typescript
const doc = await repo.findById(id);
if (!doc) return res.status(404).end();
if (doc.orgId !== actor.orgId) return res.status(403).end();
await repo.update(id, body);                        // 여기서 한 번 더 간다
```

읽기에는 충분하지만 쓰기에서는 두 가지가 걸립니다. 체크와 갱신 사이에 상태가 바뀔 수 있고, 체크를 빠뜨린 다른 경로가 있으면 저장소가 막아주지 않습니다.
쓰기는 **조건을 갱신문에 넣는 쪽**이 안전합니다.

```sql
UPDATE documents
   SET title = ?, body = ?, updated_at = NOW()
 WHERE id = ? AND org_id = ? AND deleted_at IS NULL;
```

조건이 안 맞으면 갱신되는 행이 없습니다. 권한 체크를 잊은 경로가 있어도 데이터가 바뀌지는 않습니다.

> 갱신된 행 수로 성공을 판정할 때 한 가지 함정이 있습니다. MySQL은 `affectedRows`를 "조건에 맞은 행"으로도 "값이 실제로 바뀐 행"으로도 보고할 수 있고, 어느 쪽인지는 드라이버가 켜는 클라이언트 플래그에 달려 있습니다.
> 같은 값으로 저장하는 요청이 0으로 돌아오면 멀쩡한 수정이 404가 됩니다. 쓰는 드라이버의 문서에서 이 동작을 확인하고, 애매하면 갱신 후 별도 조회로 존재 여부를 갈라내세요.

403과 404 중 무엇을 줄지도 정해야 합니다. 403은 "그 리소스가 있다"는 사실을 알려주고, 404는 숨깁니다.
ID가 순차 증가라면 403을 돌려주는 것만으로 남의 리소스 개수를 셀 수 있습니다. 조직 경계를 넘는 접근은 404로 묶고, 조직 안에서 권한이 부족한 경우만 403으로 구분하는 쪽이 무난합니다.

데이터 층에서 테넌트 조건을 강제하는 이야기는 [멀티테넌시 격리](/blog/multi-tenant-data-isolation/) 쪽에 따로 적어뒀습니다.

## 목록 조회에서는 권한이 조건이 된다

단건 체크 패턴은 목록에서 통하지 않습니다. 100건을 읽어 걸러내면 페이지 크기가 요청마다 달라지고, 전체 개수도 맞지 않습니다.
페이지네이션이 깨진다는 뜻입니다.

목록에서는 권한이 분기가 아니라 **`WHERE` 조건**입니다.

```typescript
type Scope = { sql: string; params: unknown[] };

function documentScope(actor: Actor): Scope {
  if (can(actor.role, "document:read:all")) {
    return { sql: "d.org_id = ?", params: [actor.orgId] };
  }
  // 권한이 좁으면 본인이 만든 것과 명시적으로 공유된 것만
  return {
    sql: `d.org_id = ?
          AND (d.created_by = ?
               OR EXISTS (SELECT 1 FROM document_shares s
                           WHERE s.document_id = d.id AND s.user_id = ?))`,
    params: [actor.orgId, actor.id, actor.id],
  };
}
```

조회와 카운트가 같은 조건을 쓰게 만드는 게 핵심입니다. 두 쿼리가 각자 조건을 들고 있으면 언젠가 한쪽만 고쳐집니다.

이 조건은 성능 문제로도 돌아옵니다. `EXISTS`가 붙은 목록 쿼리는 공유 테이블에 `(user_id, document_id)` 인덱스가 없으면 느려지고,
정렬과 함께 쓰면 인덱스를 못 타는 조합이 나옵니다. 권한 조건도 [복합 인덱스 컬럼 순서](/blog/mysql-composite-index-column-order/) 관점에서 같이 봐야 합니다.

## 권한 이름을 얼마나 쪼갤 것인가

`document:read`와 `document:read:all`처럼 범위를 이름에 담기 시작하면, 어디까지 쪼개야 하는지가 다음 질문이 됩니다.

너무 굵으면 역할을 추가해도 표현하지 못하는 요구가 남습니다. 너무 잘게 쪼개면 권한이 수십 개가 되고, 역할마다 그 목록을 관리하는 일이 생깁니다.
목록이 길어지면 "이 역할에 왜 이 권한이 있는지" 아는 사람이 없어지고, 의심스러울 때 지우지 못해 계속 쌓입니다.

실용적인 기준은 **화면이나 기능 단위로 쪼개고, 그보다 더 잘게는 리소스 범위로 넘기는 것**입니다.
"다른 사람의 문서를 수정할 수 있는가"는 권한 이름을 하나 더 만드는 대신 범위 조건에서 다루는 쪽이 관리하기 쉽습니다. 권한 개수는 늘지 않고, 조건은 한 함수에 모입니다.

와일드카드(`document:*`)를 지원하는 선택도 있는데, 편한 대신 **권한을 새로 추가할 때 기존 역할이 조용히 그 권한을 얻습니다.**
새 권한이 위험한 행위라면 이게 사고가 됩니다. 와일드카드는 `OWNER`처럼 "앞으로 생기는 것까지 포함"이 의도인 역할에만 두는 편이 안전합니다.

## 거절을 디버깅할 수 있게 남긴다

403은 사용자에게 자세히 알려줄 수 없는 응답입니다. 어떤 권한이 없어서 막혔는지 본문에 적으면 권한 구조를 그대로 노출하게 됩니다.

그래서 **응답은 비우고 로그에는 남기는** 쪽으로 갑니다.

```typescript
logger.warn({
  actorId: actor.id,
  role: actor.role,
  required: permission,
  method: req.method,
  route: req.route?.path,          // :id 치환 전 패턴
  requestId: req.requestId,
}, "authz_denied");
```

이게 없으면 "권한이 없다고 나온다"는 문의가 왔을 때 재현부터 시작해야 합니다.
`required`를 남겨두면 역할 구성만 보고 바로 답할 수 있습니다. 상관관계 ID를 같이 넣는 이유는 [구조화 로깅](/blog/structured-logging-correlation-id/) 쪽에 적어뒀습니다.

거절 비율을 지표로 보는 것도 쓸모가 있습니다. 배포 직후 특정 경로의 403이 갑자기 늘면 권한 매핑을 잘못 건드렸다는 신호고, 반대로 0이 계속되면 그 권한이 실제로는 아무것도 막고 있지 않다는 뜻입니다.

## 권한을 토큰에 담으면 되돌리는 데 시간이 걸린다

권한을 매 요청 DB에서 읽으면 변경이 즉시 반영되지만 모든 요청에 조회가 붙습니다.
그래서 토큰 클레임에 역할을 넣는 선택을 하는데, 그 순간 **권한 회수에 지연이 생깁니다.**

| 방식 | 반영 시점 | 비용 |
| --- | --- | --- |
| 매 요청 조회 | 즉시 | 요청마다 쿼리 1회 |
| 짧은 TTL 캐시 | TTL 이내 | 캐시 운영, TTL만큼의 창 |
| 토큰 클레임 | 토큰 만료까지 | 조회 없음, 회수가 늦다 |

권한 변경이 드물고 회수가 급한 경우라면 **권한 버전**을 끼워 넣는 방법이 중간쯤입니다.
토큰에 `perm_v`를 담고, 조직의 권한 구성이 바뀔 때 저장된 버전을 올립니다. 액세스 토큰 검증은 그대로 두고, 재발급 시점에만 버전을 비교해 다른 값이면 거절합니다.

이러면 조회 비용은 재발급 때만 들고, 회수는 액세스 토큰 수명 안에 반영됩니다.
즉시 끊어야 하는 경우(퇴사·계정 정지)는 권한 체계가 아니라 세션 무효화로 다루는 문제고, 그건 [리프레시 토큰 회전](/blog/refresh-token-rotation-revocation/) 쪽 이야기입니다.

## 역할로 풀리지 않는 요구가 온다

어느 시점에 역할 표로 표현되지 않는 요구가 들어옵니다.

- 특정 문서만 외부 사용자에게 공유
- 담당자가 휴가인 동안만 권한 위임
- 조직이 계층을 가지고 상위가 하위를 들여다보는 구조

이걸 역할로 풀려고 하면 역할이 조합 폭발을 일으킵니다. `MANAGER_READONLY`, `MANAGER_BRANCH_A` 같은 이름이 생기기 시작하면 모델이 안 맞는 신호입니다.

이때 선택지는 둘입니다. **관계를 데이터로 저장**하고 권한 판정에서 그 관계를 참조하거나, 외부 권한 서비스를 도입하는 것입니다.
전자는 위의 `document_shares`처럼 작게 시작할 수 있습니다. 후자는 Google의 Zanzibar 논문 계열 오픈소스들이 있고, 관계 기반 권한을 중앙에서 관리합니다.

중앙 권한 서비스는 공짜가 아닙니다. 판정이 네트워크 호출이 되고, 그 호출이 실패할 때 무엇을 할지 정해야 하고, 무엇보다 **목록 조회 문제가 다시 돌아옵니다.**
단건 판정은 깔끔해지지만, "이 사용자가 볼 수 있는 문서 목록"을 DB 쿼리의 `WHERE`로 만들려면 권한 데이터를 다시 가져와야 합니다.

조직 수가 적고 공유 규칙이 몇 가지로 끝난다면 관계 테이블로 버티는 편이 낫습니다.
공유·위임 규칙이 제품의 핵심 기능이 되는 단계에서 전환을 검토하는 순서가 무난합니다.

## 권한은 매트릭스로 테스트한다

권한 테스트는 성격상 조합이라서, 한 건씩 쓰면 금방 빠뜨립니다. 표로 적고 돌리는 편이 낫습니다.

```typescript
const matrix: Array<[Role, string, string, number]> = [
  ["OWNER",   "DELETE", "/documents/own",   204],
  ["MANAGER", "DELETE", "/documents/own",   204],
  ["MEMBER",  "DELETE", "/documents/own",   403],
  ["MEMBER",  "PATCH",  "/documents/own",   200],
  ["MEMBER",  "PATCH",  "/documents/other", 404],   // 다른 조직 = 존재를 숨긴다
  ["VIEWER",  "PATCH",  "/documents/own",   403],
];

test.each(matrix)("%s %s %s -> %i", async (role, method, path, expected) => {
  const res = await request(app)[method.toLowerCase()](resolve(path))
    .set("Authorization", bearerFor(role));
  expect(res.status).toBe(expected);
});
```

여기서 **거절되어야 하는 조합을 빼놓지 않는 게** 핵심입니다. 통과 케이스만 쓴 테스트는 권한이 전부 열려 있어도 초록색입니다.

{% comment %} TODO: 실제로 권한 모델을 바꿔본 경험이 있다면, 어떤 요구에서 역할만으로 부족해졌고 무엇으로 옮겼는지 적어주세요 {% endcomment %}

## 정리

- 행위 권한과 리소스 범위는 다른 질문이다. 미들웨어로 끝나는 건 앞쪽뿐이다.
- 역할을 직접 비교하지 말고 권한 이름으로 한 단 내린다. 매핑을 타입으로 묶으면 역할 추가 때 빠뜨릴 수 없다.
- 권한 선언이 없는 라우트를 찾아내는 장치를 둔다. 없으면 누락과 정상이 똑같이 보인다.
- 쓰기는 소유 조건을 갱신문에 넣는다. 조회 후 비교는 읽기까지만.
- 목록은 분기가 아니라 `WHERE` 조건이다. 조회와 카운트가 같은 조건을 공유하게 만든다.
- 토큰에 권한을 담으면 회수가 늦어진다. 지연을 감수할지, 매 요청 조회 비용을 낼지 먼저 정한다.
- 테스트는 매트릭스로, 거절 케이스까지.
