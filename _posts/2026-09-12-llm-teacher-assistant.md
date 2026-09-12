---
layout: post
title: "교사 업무를 돕는 LLM 어시스턴트 설계"
date: 2026-09-12
tags: [llm, ai, backend, typescript]
excerpt: "알림장·관찰기록 같은 교사 행정 문서를 LLM으로 돕는 서비스의 설계 결정들. 프롬프트를 코드처럼 관리하는 방법, RAG, SSE 스트리밍, 할루시네이션 방지 장치, 토큰 비용이 새는 지점."
---

교사는 아이를 보는 시간보다 아이에 대해 쓰는 시간이 길어지기 쉽습니다.
알림장, 관찰기록, 공지 — 매일 반복되고 형식이 정해져 있고, 그런데도 한 줄 한 줄 사람이 써야 하는 글입니다.

LLM이 잘하는 모양의 일입니다. 그래서 API 키만 발급받아 붙이면 될 것 같은데, 실제로 해보면 그 지점부터 문제가 시작됩니다.
**이 도메인에서 틀린 문장의 비용은 검색 결과가 틀린 것과 다릅니다.** 아이 이름이 바뀐 관찰기록은 그냥 오류가 아니라 사고입니다.

{% comment %} TODO: 킨더보드에서 실제로 담당한 범위와 기간을 적어주세요. 회사 내부 정보(고객사·규모·구현 세부)는 공개 가능한 범위만. {% endcomment %}

## 무엇을 자동화하고 무엇을 남길 것인가

기능을 고르는 기준을 먼저 정해야 합니다. 그러지 않으면 "LLM으로 할 수 있는 것"을 전부 만들게 되고, 그중 몇 개는 만들면 안 되는 것입니다.

판단은 한 가지 질문으로 좁혀집니다. **이 출력이 틀렸을 때 누가 언제 알아차리는가.**

| 일 | 틀렸을 때 | 결론 |
| --- | --- | --- |
| 교사가 쓴 메모를 알림장 문체로 다듬기 | 교사가 발송 전에 읽는다 | 맡겨도 된다 |
| 공지문 초안 잡기 | 발송 전에 읽는다 | 맡겨도 된다 |
| 관찰 메모를 영역별로 분류·요약 | 교사가 검토한다 | 초안까지만 |
| 아이의 발달 상태를 판단·평가 | 아무도 즉시 모른다 | 맡기지 않는다 |
| 원아 개인정보가 섞인 기록 대조 | 틀려도 그럴듯하다 | 맡기지 않는다 |

표의 위쪽과 아래쪽을 가르는 건 모델 성능이 아닙니다. **사람이 발송 직전에 반드시 읽는 구조인지 여부**입니다.

그래서 설계 원칙을 이렇게 잡습니다. LLM은 **초안을 만드는 역할까지**만 하고, 밖으로 나가는 모든 글에는 사람의 확인 단계가 하나 있습니다.
그리고 이 확인 단계는 권고가 아니라 **구현상 건너뛸 수 없어야** 합니다. "검토 권장" 문구는 세 번째 날부터 아무도 읽지 않습니다.

## 프롬프트를 코드처럼 다루기

처음 붙일 때 프롬프트는 보통 핸들러 안의 문자열 리터럴로 들어갑니다. 그리고 그 상태로는 **바꿀 수가 없습니다.**
어느 파일에 몇 개가 흩어져 있는지 모르고, 고쳤을 때 무엇이 나빠졌는지 비교할 방법이 없습니다.

프롬프트는 사실 **동작을 결정하는 코드**입니다. 그러면 코드에 적용하는 것들 — 버전, 리뷰, 테스트 — 을 똑같이 적용할 수 있어야 합니다.

### 시스템 프롬프트와 사용자 입력을 섞지 않기

가장 먼저 분리할 것은 "역할·규칙"과 "이번 요청의 데이터"입니다.
두 개를 한 문자열로 이어 붙이면, 사용자가 입력한 메모 안의 문장이 규칙처럼 읽힐 여지가 생깁니다.

```typescript
// prompts/alrimjang.ts
export const ALRIMJANG_V3 = {
  id: 'alrimjang',
  version: 3,
  system: [
    '당신은 어린이집 교사의 알림장 작성을 돕는 보조 도구입니다.',
    '교사가 준 메모에 없는 사실을 추가하지 않습니다.',
    '메모에 없는 아이 이름, 날짜, 활동은 만들어내지 않습니다.',
    '판단이나 평가("또래보다 느립니다" 등)를 쓰지 않습니다. 관찰된 행동만 씁니다.',
    '보호자가 읽는 글이므로 존댓말로, 3~5문장으로 씁니다.',
    '메모가 너무 짧아 글을 만들 수 없으면 무엇이 더 필요한지만 되묻습니다.',
  ].join('\n'),
} as const;
```

버전 번호를 붙여두면 **이 출력이 어느 프롬프트에서 나왔는지** 로그로 추적할 수 있습니다.
이게 없으면 "지난주엔 괜찮았는데"를 확인할 방법이 없습니다.

### 입력은 구조화해서 넣기

사용자 입력을 본문에 그대로 이어 붙이는 대신, 경계가 분명한 구분자로 감쌉니다.
모델이 "여기부터 여기까지는 데이터"라고 읽을 수 있어야 합니다.

```typescript
type AlrimjangInput = {
  childNickname: string;   // 실명 대신 원 내부 식별용 호칭
  date: string;            // YYYY-MM-DD
  memo: string;            // 교사가 쓴 원문 메모
};

function buildUserMessage(input: AlrimjangInput): string {
  return [
    '<context>',
    `<date>${input.date}</date>`,
    `<child>${input.childNickname}</child>`,
    '</context>',
    '<teacher_memo>',
    input.memo,
    '</teacher_memo>',
    '위 <teacher_memo> 내용만 근거로 알림장 초안을 작성하세요.',
  ].join('\n');
}
```

XML 스타일 태그를 쓰는 이유는 **닫는 태그가 있어서**입니다.
`---` 같은 구분자는 사용자가 메모에 똑같이 적으면 경계가 무너집니다.
입력에 `</teacher_memo>`가 들어올 가능성까지 막으려면 태그 문자열을 이스케이프하거나 거부하는 처리를 넣습니다.

> 구분자는 프롬프트 인젝션에 대한 **완화책이지 차단책이 아닙니다.**
> 모델 출력이 DB 수정이나 메일 발송 같은 부수효과로 이어지는 경로라면, 구분자를 믿지 말고 권한 자체를 좁혀야 합니다.

### few-shot 예시는 프롬프트 바깥에 두기

"이런 톤으로 써달라"를 말로 설명하는 것보다 예시 두세 개를 보여주는 게 훨씬 잘 먹힙니다.
다만 예시를 시스템 프롬프트 안에 문자열로 박으면 늘릴 때마다 프롬프트 전체를 건드려야 합니다.

예시는 데이터로 분리해서 대화 턴처럼 넣습니다.

```typescript
// prompts/alrimjang.examples.ts
export const EXAMPLES: Array<{ input: AlrimjangInput; output: string }> = [
  {
    input: {
      childNickname: '햇살반 A',
      date: '2026-09-01',
      memo: '블록 쌓기 30분. 친구랑 같이. 점심 다 먹음',
    },
    output: '오늘 아이는 친구와 함께 블록 쌓기를 30분 정도 이어서 했습니다. ...',
  },
];

function toMessages(input: AlrimjangInput) {
  return [
    ...EXAMPLES.flatMap((ex) => [
      { role: 'user' as const, content: buildUserMessage(ex.input) },
      { role: 'assistant' as const, content: ex.output },
    ]),
    { role: 'user' as const, content: buildUserMessage(input) },
  ];
}
```

이렇게 빼두면 예시를 바꿨을 때 **회귀 테스트를 돌릴 수 있습니다.**
입력 여러 개와 "이건 반드시 들어가야 / 절대 없어야" 규칙을 묶어두고, 프롬프트를 고칠 때마다 돌립니다.
출력이 매번 달라지니 문장 일치로는 못 보고, 대신 이런 것들을 봅니다.

- 메모에 없는 고유명사가 등장하지 않는가
- 길이와 문체 제약을 지켰는가
- 판단·평가 표현이 섞이지 않았는가
- 구조화 출력이 스키마를 통과하는가

{% comment %} TODO: 실제로 구축한 프롬프트 평가 방식과 규모(케이스 수, CI 연동 여부)를 적어주세요. {% endcomment %}

## 원장 자료를 답변에 넣기 (RAG)

"우리 원 운영 방침에 맞게 써줘"가 되려면 모델이 그 원의 문서를 알아야 합니다.
여기서 파인튜닝을 떠올리기 쉽지만, 이 용도에는 맞지 않습니다.

- 원마다 문서가 다릅니다. 원 단위로 모델을 만들 수는 없습니다.
- 문서는 수시로 바뀝니다. 바뀔 때마다 재학습은 현실적이지 않습니다.
- 가장 결정적으로, 학습시킨 지식은 **출처를 댈 수 없습니다.** 검토하는 사람이 "어디에 그렇게 쓰여 있나"를 확인할 방법이 없습니다.

파인튜닝은 문체와 형식을 고정하는 데 쓰는 도구고, 사실을 넣는 도구가 아닙니다. 사실은 검색해서 프롬프트에 넣습니다.

### 청킹 기준

문서를 쪼개는 기준은 토큰 수가 아니라 **의미 단위**입니다.
"500자마다 자르기"는 구현이 쉽지만, 한 규정의 조건절과 결론이 다른 덩어리로 갈라지면 검색으로 한쪽만 건져 와서 절반만 맞는 답이 나옵니다.

실무적으로는 이 순서로 내려갑니다.

1. 문서의 제목 구조(장·절·항)로 먼저 자른다
2. 그래도 너무 긴 덩어리만 단락 경계에서 추가로 자른다
3. 각 덩어리 앞에 **출처 경로를 붙여둔다** — `운영지침 > 3장 등·하원 > 3.2 지각`

3번이 중요합니다. 덩어리만 떼어놓으면 "이것"이 무엇인지 모르는 문장이 되는데, 제목 경로를 붙여두면 검색 정확도와 출처 표기가 동시에 해결됩니다.

### 저장과 검색

이미 PostgreSQL을 쓰고 있다면 `pgvector`로 시작하는 편이 합리적입니다.
원 단위 격리(테넌시)를 기존 행 단위 권한과 같은 방식으로 처리할 수 있는 게 전용 벡터 DB보다 확실한 장점입니다.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE doc_chunks (
  id          bigserial PRIMARY KEY,
  center_id   bigint NOT NULL REFERENCES centers(id),
  source_path text   NOT NULL,          -- '운영지침 > 3장 등·하원 > 3.2 지각'
  content     text   NOT NULL,
  embedding   vector(1536) NOT NULL,    -- 차원은 사용하는 임베딩 모델에 맞춘다
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- 코사인 거리 기준 ANN 인덱스
CREATE INDEX doc_chunks_embedding_idx
  ON doc_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX doc_chunks_center_idx ON doc_chunks (center_id);
```

`<=>`가 코사인 거리 연산자입니다. 인덱스의 연산자 클래스(`vector_cosine_ops`)와 쿼리에 쓰는 연산자가 **짝이 맞아야** 인덱스를 탑니다.
`<->`(L2 거리)로 조회하면서 코사인 인덱스를 만들어두면 조용히 순차 스캔이 됩니다.

```sql
SELECT source_path, content, embedding <=> $2 AS distance
FROM doc_chunks
WHERE center_id = $1
ORDER BY embedding <=> $2
LIMIT 5;
```

거리 임계값을 둬서 **너무 먼 결과는 아예 버립니다.** 임계값 없이 항상 상위 5건을 넘기면, 관련 없는 덩어리가 근거처럼 프롬프트에 들어갑니다.
임계값은 데이터에 따라 달라지니 실제 질의 로그를 보고 정해야 합니다.

> 벡터 차원 수는 쓰는 임베딩 모델에 따라 다릅니다. `hnsw` 인덱스를 지원하는 `pgvector` 버전과 인덱스 파라미터(`m`, `ef_construction`)는 공식 문서에서 확인하세요.
> 관리형 DB라면 쓸 수 있는 확장 버전이 제한될 수 있습니다.

### 검색 결과를 프롬프트에 넣는 형태

검색 결과는 "참고 자료"라는 경계 안에 넣고, **빗나갔을 때 어떻게 행동할지를 함께 지시**합니다.
이 지시가 없으면 모델은 관련 없는 자료를 받고도 답을 만들어냅니다.

```typescript
type Chunk = { sourcePath: string; content: string };

function buildRagBlock(chunks: Chunk[]): string {
  if (chunks.length === 0) {
    return [
      '<references/>',
      '참고 자료가 없습니다. 원 운영 방침에 관한 내용은 답하지 말고,',
      '담당자 확인이 필요하다고만 안내하세요.',
    ].join('\n');
  }
  return [
    '<references>',
    ...chunks.map((c, i) => `<ref id="${i + 1}" path="${c.sourcePath}">\n${c.content}\n</ref>`),
    '</references>',
    '규칙:',
    '- 원 운영 방침에 관한 내용은 <references> 안에 있는 것만 사용합니다.',
    '- 사용한 문장마다 [ref:N] 형식으로 출처를 표기합니다.',
    '- <references>에 근거가 없으면 "원 자료에서 확인하지 못했습니다"라고 쓰고 추측하지 않습니다.',
  ].join('\n');
}
```

빈 결과일 때 프롬프트를 다르게 보내는 게 핵심입니다.
빈 `<references>`만 보내면 모델은 그걸 "자료가 없으니 알아서 쓰라"로 읽습니다.

## 스트리밍 응답

문서 생성은 출력이 깁니다. 다 만들어서 한 번에 주면 사용자는 몇 초 동안 빈 화면을 봅니다.
같은 총 소요 시간이라도 **첫 글자가 언제 나오는지**가 체감을 거의 결정합니다.

서버에서 SSE로 흘려보냅니다. 형식은 단순합니다. `data: `로 시작하는 줄, 그리고 **빈 줄 하나**로 이벤트가 끝납니다.

```typescript
// Express 예시. streamModel 은 프로바이더 SDK를 감싼 자체 함수
app.post('/api/alrimjang/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',      // nginx 버퍼링 방지
  });

  const ac = new AbortController();
  req.on('close', () => ac.abort());   // 클라이언트가 끊으면 모델 호출도 중단

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    for await (const delta of streamModel(toMessages(req.body), { signal: ac.signal })) {
      send('delta', { text: delta });
    }
    send('done', { promptVersion: ALRIMJANG_V3.version });
  } catch (err) {
    if (!ac.signal.aborted) send('error', { message: '생성에 실패했습니다' });
  } finally {
    res.end();
  }
});
```

주의할 점 몇 가지입니다.

`data:` 줄 안에는 개행이 들어갈 수 없습니다. 그래서 텍스트를 그대로 쓰지 않고 `JSON.stringify`로 감쌉니다.
줄바꿈이 포함된 조각을 그대로 내보내면 이벤트가 중간에 끊겨 파싱이 깨집니다.

프록시 버퍼링도 자주 걸리는 지점입니다. 로컬에서는 잘 되는데 배포하면 응답이 한 번에 몰려 오는 경우, 대개 앞단 프록시가 모아서 보내고 있습니다.

그리고 **중간 취소를 처리해야 합니다.** 사용자가 탭을 닫거나 다시 생성을 누르면, 서버가 모델 호출을 계속 붙들고 있을 이유가 없습니다.
`req.on('close')`에서 `AbortController`를 끊어주면 토큰을 더 태우지 않습니다. 이건 기능이 아니라 비용 문제입니다.

클라이언트는 `POST`로 보내야 하니 `EventSource` 대신 `fetch`로 받습니다.

```typescript
async function streamAlrimjang(
  input: AlrimjangInput,
  onDelta: (t: string) => void,
  signal: AbortSignal,
) {
  const res = await fetch('/api/alrimjang/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.body) throw new Error('no stream');

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    // 이벤트 경계는 빈 줄
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice('data: '.length));
      if (payload.text) onDelta(payload.text);
    }
  }
}
```

버퍼를 두는 이유는 **청크 경계가 이벤트 경계와 일치하지 않기** 때문입니다.
네트워크가 준 한 덩어리 안에 이벤트가 세 개 들어 있거나, 하나가 반만 들어 있을 수 있습니다.
이걸 고려하지 않은 파서는 평소엔 잘 돌다가 응답이 길어질 때 깨집니다.

취소는 호출하는 쪽의 `AbortController`를 `abort()`하면 됩니다. `fetch`가 끊기고 서버의 `req.on('close')`가 이어서 돌면서 모델 호출까지 같이 멈춥니다.

## 할루시네이션을 줄이는 장치

"모델이 더 좋아지면 해결된다"고 두면 안 됩니다. 장치를 구조로 박아야 합니다.

**출처 표기를 강제합니다.** RAG 근거를 쓴 문장에는 `[ref:N]`을 붙이게 하고, 서버에서 응답을 검사해 실제로 넘긴 `id` 범위를 벗어난 참조가 있으면 거부합니다.
모델에게 시키는 것과 별개로 **검증은 코드가 합니다.** 지시만으로는 지켜지지 않는 날이 옵니다.

**모른다고 말할 길을 열어둡니다.** 모델이 빈 답을 내놓을 수 없으면 무언가를 채웁니다.
"근거가 없으면 이렇게 답하라"는 **구체적인 출구 문구**를 주면 그쪽으로 갑니다. "모르면 모른다고 하라"보다 훨씬 잘 먹힙니다.

**구조화 출력으로 형식을 고정합니다.** 자유 텍스트를 파싱하는 대신 JSON 스키마로 받으면 검증할 대상이 명확해집니다.

```json
{
  "type": "object",
  "properties": {
    "status":    { "type": "string", "enum": ["ok", "need_more_info"] },
    "draft":     { "type": "string" },
    "missing":   { "type": "array", "items": { "type": "string" } },
    "used_refs": { "type": "array", "items": { "type": "integer" } }
  },
  "required": ["status"],
  "additionalProperties": false
}
```

`status`를 따로 둔 게 핵심입니다. 메모가 부족한 경우 모델이 **빈 초안 대신 "무엇이 더 필요한지"를 반환**할 수 있고, UI는 그 분기를 다르게 그릴 수 있습니다.
이 분기가 없으면 모델은 부족한 메모로도 그럴듯한 글을 만들어냅니다.

> 구조화 출력의 스키마 지원 범위와 파라미터 이름은 프로바이더마다 다릅니다. 쓰는 SDK의 공식 문서를 확인하세요.
> 그리고 어느 쪽이든 **받은 JSON은 서버에서 다시 검증**해야 합니다. 스키마를 보장한다는 기능도 길이 초과나 연결 중단으로 깨질 수 있습니다.

**검토 단계를 UI에 박아둡니다.** 생성 결과는 항상 초안 상태로 놓이고, 교사가 읽고 저장하거나 발송해야 확정됩니다.
"자동 발송" 옵션을 만들지 않는 것이 가장 단순하고 확실한 안전장치입니다.
기능 요청이 들어와도, 이 도메인에서는 안 만드는 쪽에 설명할 논거가 있습니다.

## 토큰 비용이 새는 곳

비용은 대개 모델 가격이 아니라 **같은 것을 반복해서 보내는 구조**에서 샙니다.

가장 흔한 건 긴 시스템 프롬프트입니다. few-shot 예시까지 붙으면 수천 토큰이 되고, 그게 매 요청마다 다시 올라갑니다.
프롬프트 캐싱을 쓰면 줄어들지만, 쓰려면 프롬프트 구조를 거기에 맞춰야 합니다.

- 변하지 않는 부분(시스템 프롬프트, few-shot 예시)을 **앞쪽에** 모읍니다.
- 매번 달라지는 부분(사용자 메모, RAG 결과)을 뒤로 보냅니다.
- 앞쪽에 타임스탬프나 요청 ID 같은 걸 섞지 않습니다. 한 글자만 달라도 캐시가 빗나갑니다.

앞쪽 고정 / 뒤쪽 가변 구조는 캐싱을 쓰지 않더라도 지킬 가치가 있습니다. 나중에 켜기만 하면 되니까요.

> 캐시 적용 단위, 유효 시간, 최소 토큰 수, 과금 방식은 프로바이더와 모델마다 다르고 자주 바뀝니다. 반드시 공식 문서에서 확인하세요.

두 번째는 대화 이력입니다. 턴이 누적되면 매 요청의 입력이 선형으로 늘고, 긴 대화의 마지막 한 마디가 첫 마디보다 몇 배 비싸집니다.
전체를 다시 넣는 대신 오래된 구간을 요약으로 접습니다. 최근 몇 턴은 원문으로 두고, 그 앞은 한 단락 요약으로 대체하는 방식입니다.
요약 자체도 모델 호출이라 비용이 들지만, **한 번 만들어 여러 요청에서 재사용**하므로 대개 남습니다.

세 번째는 모델 티어를 하나로 쓰는 것입니다. 한 요청 안에도 난이도가 다른 단계가 섞여 있습니다.

| 단계 | 필요한 능력 | 선택 |
| --- | --- | --- |
| 입력이 어떤 종류의 요청인지 분류 | 짧은 판단 | 작은 모델 |
| 검색 질의로 다시 쓰기 | 짧은 변환 | 작은 모델 |
| 알림장 본문 생성 | 문체·맥락 유지 | 큰 모델 |
| 생성된 초안의 규칙 위반 검사 | 짧은 판정 | 작은 모델 |

전부 큰 모델로 돌리면 분류 한 번에 생성과 같은 단가를 냅니다.
단계를 쪼개두면 나중에 모델을 바꿀 때도 한 단계만 갈아끼울 수 있습니다.

마지막으로, 출력 토큰에 상한을 둡니다. 알림장 초안이 스무 문장일 이유가 없습니다.
길이 제약은 프롬프트로만 걸지 말고 **요청 파라미터로도** 걸어두는 편이 안전합니다.

{% comment %} TODO: 실제 비용 구조나 측정치를 쓸 수 있다면 여기에. 공개할 수 없으면 이 주석째로 지우세요. {% endcomment %}

## 정리

LLM을 붙이는 일의 대부분은 모델을 고르는 일이 아니었습니다.

- 무엇을 맡기지 **않을지** 먼저 정합니다. 기준은 "틀렸을 때 누가 언제 알아차리는가"입니다.
- 프롬프트를 코드로 다룹니다. 버전, 분리, 회귀 테스트.
- 사실은 파인튜닝이 아니라 검색으로 넣고, **검색이 빈손일 때의 행동까지** 지시합니다.
- 긴 응답은 스트리밍하고, 끊어진 연결에서 모델 호출도 같이 끊습니다.
- 할루시네이션 대책은 지시문이 아니라 **코드의 검증과 UI의 구조**로 둡니다.
- 비용은 반복 전송·이력 누적·티어 단일화에서 샙니다.

아이에 대한 기록을 다루는 서비스라서, 마지막 판단은 사람이 한다는 전제를 설계에서 내려놓지 않는 게 가장 중요했습니다.
