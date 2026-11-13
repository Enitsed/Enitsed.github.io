---
layout: post
title: "기록이 바뀌었는데 누가 바꿨는지 알 수 없다 — 감사 로그와 변경 이력"
date: 2026-11-14
tags: [backend, database, sql, typescript, security]
excerpt: "updated_at과 updated_by만으로는 어제의 내용이 무엇이었는지에 답할 수 없습니다. 감사 로그와 버전 이력이 서로 다른 요구라는 점에서 출발해, 애플리케이션·트리거·CDC 중 어디서 잡을지, append-only 테이블 설계와 변경 필드 추출, 지울 수 없게 만드는 방법과 보관 전략을 정리합니다."
---

"어제 올린 기록이 지금 다른 내용입니다"라는 문의가 들어옵니다.
테이블을 열어보면 `updated_at`은 오늘 오전이고, `updated_by`는 비어 있습니다.

바뀐 건 분명한데, 무엇에서 무엇으로 바뀌었는지도 누가 바꿨는지도 남아 있지 않습니다.
답할 수 없는 질문이 아니라, **답할 수 있게 설계하지 않은 질문**입니다.

## 마지막 상태만 남는 구조

`updated_at`과 `updated_by`를 붙여두면 뭔가 기록되는 것처럼 보이지만, 이 두 컬럼이 들고 있는 건 **가장 최근 한 번**입니다.

어제 교사가 쓰고, 오늘 아침 관리자가 고치고, 조금 전에 배치가 한 번 더 건드렸다면 남는 것은 배치의 흔적뿐입니다.
중간 두 번은 존재했던 적조차 없는 것처럼 보입니다.

행이 삭제되면 더 나빠집니다. 변경 흔적을 그 행에 붙여놓았으니 **행과 함께 흔적도 사라집니다.**
[소프트 삭제](/blog/soft-delete-unique-constraint/)로 행을 남겨도 "삭제 직전의 내용"은 복원되지 않습니다. 삭제 플래그만 켜질 뿐입니다.

그래서 변경 기록은 대상 행 안이 아니라 **밖에, 추가만 되는 형태로** 쌓아야 합니다.

## 섞으면 둘 다 못 하는 두 가지 요구

여기서 먼저 갈라야 할 게 있습니다. 비슷하게 생겼지만 목적이 다른 두 가지가 "이력"이라는 한 단어에 묶여 있습니다.

| | 감사 로그 | 버전 이력 |
| --- | --- | --- |
| 답하려는 질문 | 누가 언제 무엇을 했는가 | 그 시점의 내용이 무엇이었는가 |
| 쓰는 사람 | 관리자, 보안·규정 담당 | 작성자 본인 |
| 대상 | 로그인·권한 변경·조회까지 포함 | 특정 문서 한 건 |
| 저장 형태 | 행위 단위, 추가만 | 내용 전체 스냅샷 |
| 지우기 | 보관 기간 전에는 못 지운다 | 문서가 지워지면 같이 지울 수 있다 |

감사 로그에는 데이터가 바뀌지 않은 행위도 들어갑니다. 로그인 실패, 권한 승인, 개인정보 조회 같은 것들입니다.
반대로 버전 이력에는 "누가"보다 "내용 전체"가 중요합니다. 되돌리기 버튼을 만들려면 그 시점 문서가 통째로 필요합니다.

하나의 테이블에 둘을 다 담으면, 감사 쪽은 노이즈가 많아 못 쓰고 버전 쪽은 복원에 필요한 필드가 비어 있습니다.
이 글은 감사 로그를 중심으로 쓰고, 버전 이력은 마지막에 따로 적습니다.

## 어디서 잡을 것인가

변경을 포착할 수 있는 지점은 세 곳이고, 각자 아는 것과 모르는 것이 다릅니다.

| | 애플리케이션 계층 | DB 트리거 | binlog·WAL (CDC) |
| --- | --- | --- | --- |
| 누가·왜 했는지 | 안다 | 세션 변수로 넘겨야 안다 | 모른다 |
| 앱을 거치지 않은 변경 | 놓친다 | 잡는다 | 잡는다 |
| 기록 단위 | 행위 이름 (`기록 수정`) | 테이블·컬럼 | 테이블·컬럼 |
| 스키마 변경 대응 | 코드와 같이 움직인다 | 트리거를 따라 고쳐야 한다 | 대개 자동 |
| 운영 부담 | 낮다 | 중간 | 파이프라인이 하나 늘어난다 |

앱 계층의 결정적인 약점은 **앱을 거치지 않는 변경**입니다. 운영자가 콘솔에서 돌린 `UPDATE`, 마이그레이션 스크립트, 데이터 보정 배치.
그리고 사고가 났을 때 정말로 확인하고 싶은 건 보통 그쪽입니다.

트리거는 그걸 잡지만, 반대로 의도를 모릅니다. `status`가 `2`에서 `3`으로 바뀐 사실은 알아도 그게 "원장 승인"인지 "배치 정리"인지 구분하지 못합니다.

실무적으로는 **앱 계층을 기본으로 두고, 민감한 테이블 몇 개에만 트리거를 덧대는** 조합이 유지보수 비용 대비 효율이 좋습니다.
전부 트리거로 덮으려 하면 테이블마다 트리거를 따라다니게 되고, 스키마 변경 때 조용히 깨집니다.

## append-only 테이블

```sql
CREATE TABLE audit_events (
  id           bigserial   PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  center_id    bigint,                                  -- 테넌트. 조회 범위를 좁히는 축
  actor_type   text        NOT NULL,                     -- 'teacher' | 'admin' | 'system' | 'batch'
  actor_id     bigint,
  actor_label  text,                                     -- 그 시점의 이름/이메일 스냅샷
  action       text        NOT NULL,                     -- 'child_record.update'
  entity_type  text        NOT NULL,
  entity_id    text        NOT NULL,                     -- 숫자든 UUID든 담도록 text
  changes      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  request_id   text,                                     -- 로그·트레이스와 잇는 열쇠
  source       text        NOT NULL DEFAULT 'app',       -- 'app' | 'trigger' | 'batch'
  client_ip    inet
);

CREATE INDEX audit_events_entity_idx
  ON audit_events (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_events_actor_idx
  ON audit_events (actor_id, occurred_at DESC);
```

눈여겨볼 곳이 세 군데 있습니다.

**외래키가 없습니다.** `entity_id`에 `REFERENCES`를 걸면 대상이 삭제될 때 감사 기록도 같이 끌려갑니다.
`ON DELETE CASCADE`면 증거가 지워지고, `RESTRICT`면 이번엔 대상을 지울 수 없게 됩니다. 어느 쪽도 원하는 게 아닙니다.
감사 로그는 **대상보다 오래 살아야 하는 데이터**라서, 참조 무결성을 포기하는 쪽이 맞습니다.

**`actor_label`에 그 시점의 이름을 복사해둡니다.** `actor_id`만 두면 조회할 때 조인해야 하는데, 그 사람이 퇴사해 계정이 지워졌거나 이름을 바꿨으면 "지금의 이름"이 나옵니다.
2년 전 기록을 보는 사람에게 필요한 건 그때 그 이름입니다.

**`request_id`를 같이 넣습니다.** 감사 기록 한 줄에서 [상관관계 ID](/blog/structured-logging-correlation-id/)로 애플리케이션 로그와 트레이스까지 건너갈 수 있습니다.
"이 변경이 어떤 요청에서 나왔나"는 사후 조사에서 가장 먼저 필요한 연결입니다.

`action`을 `entity_type` + DML 종류로 쪼개지 않고 별도 문자열로 둔 것도 의도입니다. 같은 테이블의 `UPDATE`라도 `기록 수정`과 `기록 승인`은 보는 사람에게 다른 사건입니다.

## 무엇을 "바뀐 것"으로 볼 것인가

변경 전후를 통째로 넣으면 테이블이 빠르게 커지고, 정작 읽을 때 무엇이 달라졌는지 눈으로 찾아야 합니다.
**바뀐 필드만** 남기는 편이 저장 비용과 가독성 양쪽에서 낫습니다.

```typescript
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

// 매번 바뀌지만 의미가 없는 필드
const IGNORED = new Set(['updated_at', 'last_seen_at', 'search_vector']);
// 변경 사실만 남기고 값은 남기지 않을 필드
const MASKED = new Set(['phone', 'email', 'birth_date']);
// 길이가 큰 본문 필드
const TRUNCATED = new Set(['content', 'memo']);

export type FieldChange = { from: Json; to: Json };

export function diffFields(
  before: Record<string, Json>,
  after: Record<string, Json>,
): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (IGNORED.has(key)) continue;

    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;

    if (MASKED.has(key)) {
      changes[key] = { from: from === null ? null : '***', to: to === null ? null : '***' };
    } else if (TRUNCATED.has(key)) {
      changes[key] = { from: summarize(from), to: summarize(to) };
    } else {
      changes[key] = { from, to };
    }
  }
  return changes;
}

function summarize(v: Json): Json {
  if (typeof v !== 'string') return v;
  return v.length > 200 ? `${v.slice(0, 200)}… (${v.length}자)` : v;
}
```

마스킹 목록이 핵심입니다. 감사 로그를 만들다 보면 **개인정보가 평문으로 한 벌 더 쌓이는** 결과가 되기 쉽습니다.
원본 컬럼은 [암호화해 두었는데](/blog/pii-column-encryption-blind-index/) 감사 테이블에는 바뀐 값이 그대로 들어가 있는 상황이 그렇습니다.
전화번호가 바뀌었다는 사실은 기록해야 하지만, 바뀐 번호 자체가 거기 있을 이유는 없습니다.

> `JSON.stringify` 비교는 객체 키 순서에 민감합니다. JSON 컬럼처럼 중첩 구조를 담는 필드가 있으면 키를 정렬한 뒤 비교하거나, 그 필드는 별도로 다루세요.
> 값이 같아도 순서만 달라 "변경됨"으로 잡히면 감사 로그가 의미 없는 줄로 채워집니다.

## 트리거로 그물을 한 겹 더

민감한 테이블에는 앱을 우회한 변경까지 잡는 트리거를 둡니다. PostgreSQL이라면 `to_jsonb`로 행 전체를 받아 바뀐 키만 추려낼 수 있습니다.

```sql
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_before  jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  v_after   jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  v_changes jsonb;
BEGIN
  SELECT jsonb_object_agg(k, jsonb_build_object('from', v_before -> k, 'to', v_after -> k))
    INTO v_changes
    FROM jsonb_object_keys(v_before || v_after) AS keys(k)
   WHERE (v_before -> k) IS DISTINCT FROM (v_after -> k)
     AND k <> 'updated_at';

  IF v_changes IS NULL THEN
    RETURN NULL;                      -- 의미 있는 변경이 없으면 기록하지 않는다
  END IF;

  INSERT INTO audit_events (
    actor_type, actor_id, action, entity_type, entity_id, changes, request_id, source
  ) VALUES (
    COALESCE(current_setting('app.actor_type', true), 'unknown'),
    NULLIF(current_setting('app.actor_id', true), '')::bigint,
    TG_TABLE_NAME || '.' || lower(TG_OP),
    TG_TABLE_NAME,
    COALESCE(v_after ->> 'id', v_before ->> 'id'),
    v_changes,
    current_setting('app.request_id', true),
    'trigger'
  );
  RETURN NULL;
END $$;

CREATE TRIGGER child_records_audit
  AFTER INSERT OR UPDATE OR DELETE ON child_records
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
```

행위자는 애플리케이션이 트랜잭션을 열 때 넘겨줍니다.

```typescript
await db.transaction(async (tx) => {
  await tx.query(`SET LOCAL app.actor_id = $1`, [actor.id]);
  await tx.query(`SET LOCAL app.actor_type = $1`, [actor.type]);
  await tx.query(`SET LOCAL app.request_id = $1`, [requestId]);

  await tx.query(`UPDATE child_records SET content = $1 WHERE id = $2`, [content, id]);
});
```

`SET LOCAL`이어야 합니다. `SET`은 세션 범위라서 커넥션이 풀로 반납되면 다음 요청이 **앞 사람의 행위자 값을 그대로 물고** 트리거를 돌립니다.
감사 로그에 엉뚱한 사람 이름이 찍히는 건 기록이 없는 것보다 나쁩니다. 커넥션 풀에서 세션 설정이 새는 문제는 [풀이 마르는 이야기](/blog/db-connection-pool-exhaustion/)에도 같은 모양으로 나옵니다.

값이 비어 있을 때 `'unknown'`으로 남기는 것도 의도입니다. 콘솔에서 직접 돌린 `UPDATE`는 세션 변수가 없으니 `unknown` + `source='trigger'`로 들어오고, 그게 바로 "앱을 거치지 않은 변경"의 신호가 됩니다.

> 트리거가 못 잡는 경로가 있습니다. `TRUNCATE`는 행 단위 트리거를 거치지 않고, MySQL InnoDB에서는 외래키 캐스케이드로 삭제되는 행이 트리거를 깨우지 않습니다.
> 복제본에서 트리거가 도는지도 복제 방식에 따라 다릅니다. 쓰는 엔진과 버전의 트리거 제약은 공식 문서에서 확인하고, **트리거를 유일한 방어선으로 삼지 마세요.**

MySQL에는 `jsonb`와 `jsonb_object_agg`가 없어 위 함수를 그대로 옮길 수 없습니다. 바뀐 컬럼을 트리거 본문에서 하나씩 비교해 `JSON_OBJECT`로 조립하거나, diff는 앱에서 만들고 트리거는 "앱을 안 거친 변경이 있었다"는 사실만 남기는 쪽으로 단순화하는 선택지가 있습니다.

## 감사 기록이 실패하면 본 작업도 실패해야 하나

둘 중 하나를 골라야 하고, 둘 다 맞는 경우가 있습니다.

**같은 트랜잭션에 넣는다.** 기록이 안 되면 변경도 안 됩니다. 규정상 "기록 없는 변경"이 허용되지 않을 때는 이쪽뿐입니다.
비용은 쓰기 트랜잭션이 길어지는 것, 그리고 감사 테이블이 모든 쓰기 경로의 공통 병목이 되는 것입니다.

**비동기로 보낸다.** 큐에 넣고 응답합니다. 본 작업은 빠르지만, 큐가 유실되면 기록이 빕니다.
이 조합에서 "변경은 커밋됐는데 기록은 안 나갔다"를 막으려면 [트랜잭셔널 아웃박스](/blog/transactional-outbox-pattern/)가 필요합니다. 같은 트랜잭션에 아웃박스 행을 남기고, 발행은 따로 하는 방식입니다.

현실적인 선택은 성격에 따라 나누는 것입니다. 권한 변경·개인정보 조회·삭제처럼 사후 증명이 필요한 행위는 같은 트랜잭션에, 일반적인 내용 수정은 아웃박스를 거쳐 비동기로 보냅니다.

한 가지는 분명히 해두는 게 좋습니다. **감사 기록 실패를 조용히 삼키지 않는 것.** `try/catch`로 감싸고 로그만 남기면, 기록이 비어 있다는 사실을 아무도 모르는 상태가 됩니다.

## 지울 수 없게 만들기

append-only는 설계 의도일 뿐이고, 애플리케이션 계정에 `UPDATE`·`DELETE` 권한이 있으면 코드 한 줄로 깨집니다.

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM app_user;
GRANT  INSERT, SELECT                ON audit_events TO   app_user;
```

보관 기간이 지난 데이터 삭제는 다른 계정이 담당하거나, 월 단위 파티션을 통째로 떼어내는 방식으로 처리합니다.
파티션 단위 정리는 [대량 삭제와 보관](/blog/mysql-bulk-delete-partition-retention/) 쪽에 적어둔 것과 같은 방법입니다.

해시 체인(각 행에 이전 행의 해시를 넣어 변조를 탐지하는 방식)까지 가는 경우도 있지만, 대개는 과합니다.
DB에 쓰기 권한이 있는 사람이 체인을 다시 계산할 수 있으면 방어 효과가 크지 않고, 진짜로 변조 방지가 필요하면 **보관 위치를 바꾸는 쪽**(추가만 가능한 외부 저장소로 내보내기)이 더 확실합니다.
규정 요구가 명시적으로 있을 때 꺼내는 수단으로 두는 편이 좋습니다.

조회 쪽 권한도 빠뜨리기 쉽습니다. 감사 로그는 "누가 무엇을 봤는지"까지 모아놓은 테이블이라, 원본 데이터보다 민감할 수 있습니다.
[권한 모델](/blog/authorization-role-permission-resource-scope/)에서 이 테이블을 별도 리소스로 다루고, 테넌트 경계도 [원본과 같은 방식으로 강제](/blog/multi-tenant-data-isolation/)해야 합니다.

## 가장 빨리 커지는 테이블

감사 로그는 서비스에서 증가 속도가 가장 빠른 테이블이 되기 쉽습니다. 모든 쓰기에 한 줄씩 붙고, 조회 행위까지 기록하면 읽기에도 붙습니다.

통제 지점은 세 개입니다.

- **무엇을 기록하지 않을지 정한다.** 목록 조회 한 번을 기록할지 여부로 증가량이 자릿수 단위로 달라집니다. 조회는 "민감 정보가 포함된 조회"로 좁히는 편이 현실적입니다.
- **보관 기간을 행위 종류별로 다르게 둔다.** 권한 변경과 일반 내용 수정에 같은 기간을 적용할 이유는 없습니다.
- **오래된 구간은 내보낸다.** 조회 빈도가 급격히 떨어지는 데이터라, 월 파티션을 객체 스토리지로 내리고 DB에는 최근 몇 달만 두는 구성이 잘 맞습니다.

인덱스도 의식적으로 골라야 합니다. 쓰기가 많은 테이블이니 인덱스 하나하나가 쓰기 비용입니다.
실제로 쓰는 조회 패턴은 보통 "이 문서의 이력"과 "이 사람의 행적" 두 개라서, 앞에서 만든 두 인덱스면 대개 충분합니다.
`changes` 안을 검색하고 싶어지는 순간이 오면, 그건 감사 로그가 아니라 분석 요구라서 별도 저장소로 넘기는 게 맞습니다.

{% comment %} TODO: 실제 서비스에서 감사 테이블의 월 증가량과 보관 정책을 어떻게 잡았는지 적을 수 있으면 여기에 추가 {% endcomment %}

## 되돌리기는 다른 문제다

마지막으로 버전 이력입니다. "되돌리기"를 만들려면 diff가 아니라 **그 시점의 완전한 내용**이 필요합니다.

diff를 역순으로 적용해 복원할 수도 있지만, 중간에 한 줄이라도 빠지면 결과가 틀어지고 그걸 검증할 방법이 없습니다.
변경 횟수가 많지 않은 문서라면 스냅샷을 그대로 쌓는 편이 훨씬 단순합니다.

```sql
CREATE TABLE child_record_versions (
  record_id       bigint      NOT NULL,
  version         int         NOT NULL,
  content         jsonb       NOT NULL,     -- 그 시점 문서 전체
  audit_event_id  bigint,                   -- 이 버전을 만든 행위
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, version)
);
```

`version` 컬럼은 [낙관적 잠금](/blog/optimistic-locking-lost-update/)에서 쓰던 버전 번호와 같은 값을 쓰면 깔끔합니다. 충돌 감지와 이력 번호가 하나로 맞습니다.
`audit_event_id`로 감사 로그와 연결해두면 "이 버전을 누가 만들었는가"는 감사 쪽에서 가져오고, 버전 테이블은 내용만 들고 있으면 됩니다.

보관 규칙은 감사 로그와 반대로 잡아도 됩니다. 문서가 지워지면 버전도 지울 수 있고, 최근 N개만 남기는 것도 선택지입니다. 이건 복원 편의 기능이고, 증명 수단이 아니기 때문입니다.

## 정리

- `updated_at`/`updated_by`는 마지막 한 번만 남깁니다. 행과 함께 지워지기도 합니다.
- 감사 로그와 버전 이력은 목적이 다릅니다. 한 테이블에 섞으면 둘 다 제대로 못 씁니다.
- 앱 계층은 의도를 알고 트리거는 우회를 잡습니다. 민감한 테이블에만 트리거를 덧대는 조합이 현실적입니다.
- 트리거에 행위자를 넘길 때는 `SET LOCAL`로 트랜잭션 범위에 묶어야 합니다. 세션 범위로 두면 풀을 타고 다음 요청으로 샙니다.
- 외래키를 걸지 않고, 행위자 이름은 그 시점 값을 복사해둡니다. 감사 기록은 대상보다 오래 살아야 합니다.
- 바뀐 필드만 남기고 민감 필드는 값 대신 변경 사실만 남깁니다. 감사 로그가 개인정보 사본이 되지 않게.
- `UPDATE`·`DELETE` 권한을 회수해 append-only를 실제로 강제합니다.
- 가장 빨리 커지는 테이블입니다. 무엇을 기록하지 않을지와 보관 기간을 설계 단계에서 정해두세요.
