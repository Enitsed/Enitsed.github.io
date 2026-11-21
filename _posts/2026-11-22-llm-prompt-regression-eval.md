---
layout: post
title: "프롬프트를 고쳤는데 좋아졌는지 알 수 없다 — 회귀 평가셋을 CI에 넣기"
date: 2026-11-22
tags: [llm, testing, typescript, cicd, backend]
excerpt: "출력이 매번 달라지는 기능에 회귀 테스트를 붙이는 방법. 평가셋을 운영 로그에서 만드는 기준, 결정적 검사·참조 비교·판정 모델로 채점을 층으로 나누는 이유, 판정 모델을 믿기 전에 사람 라벨과 대조하는 절차, 30건짜리 평가셋에서 1건 차이를 읽으면 안 되는 이유, 그리고 CI의 어느 단계에 무엇을 돌릴지까지."
---

프롬프트에서 한 줄을 고치고 예시 세 개를 돌려봅니다. 셋 다 그럴듯해서 배포합니다.

며칠 뒤 특정 유형의 요청에서 답이 나빠졌다는 제보가 들어옵니다. 고친 한 줄 때문인지, 원래부터 그랬는지 확인할 방법이 없습니다.
"좋아졌다"를 측정할 수 있는 문장으로 바꿔두지 않으면, 프롬프트 변경은 매번 도박이 됩니다.

## 단위 테스트를 놓는 자리에 그대로 놓을 수 없다

같은 리포지터리 안에 있지만 성질이 다릅니다.

| | 단위 테스트 | LLM 회귀 평가 |
| --- | --- | --- |
| 같은 입력의 출력 | 항상 같다 | 호출마다 달라질 수 있다 |
| 정답 | 하나 | 여러 답이 모두 정답 |
| 실패 신호 | 예외 또는 불일치 | 점수 분포의 이동 |
| 한 번 돌리는 비용 | 0에 가깝다 | 건수 × 반복 × 토큰 |
| 깨지는 방식 | 즉시 빨간 줄 | 조용한 품질 저하 |

그래서 평가는 통과/실패가 아니라 **측정**입니다. 측정값은 혼자서는 의미가 없고 **기준선과 비교할 때만** 뜻이 생깁니다.
이 글의 설계 대부분은 "비교 가능한 숫자를 만든다"는 한 가지 목적에서 나옵니다.

> 모델 버전이 바뀌면 점수도 바뀝니다. 기준선에는 평가셋 버전, 프롬프트 커밋, **모델 식별자와 호출 설정**을 함께 기록해두세요.
> 모델 이름·가격·설정 가능한 파라미터는 빠르게 변하므로, 그 값 자체는 쓰는 시점에 공급자 공식 문서에서 확인하는 편이 안전합니다.

## 평가셋은 머리에서 짜내지 않는다

손으로 만든 입력은 실제 요청 분포를 닮지 않습니다. 개발자가 상상하는 입력은 대체로 너무 정갈합니다.

출발점은 운영 로그입니다. 유형 라벨을 붙여 **층화 추출**합니다. 전체에서 무작위로 뽑으면 드문 유형이 통째로 빠지고, 그 유형이 다음 회귀가 숨는 자리입니다.

```sql
-- 예시 스키마. 유형별로 같은 수를 뽑는다.
WITH ranked AS (
  SELECT id, request_type, input_json, created_at,
         ROW_NUMBER() OVER (PARTITION BY request_type ORDER BY RAND()) AS rn
  FROM assistant_requests
  WHERE created_at >= NOW() - INTERVAL 30 DAY
)
SELECT id, request_type, input_json
FROM ranked
WHERE rn <= 10;
```

더 비싼 데이터는 따로 있습니다. **사용자가 결과를 받아들이지 않은 요청**입니다.
재생성을 눌렀거나, 복사해서 손으로 고쳤거나, 중간에 이탈한 요청은 "이 입력에서 우리가 못했다"는 라벨이 이미 붙은 샘플입니다.

```sql
SELECT r.id, r.request_type, r.input_json, f.action
FROM assistant_requests r
JOIN assistant_feedback f ON f.request_id = r.id
WHERE f.action IN ('regenerate', 'manual_edit')
  AND r.created_at >= NOW() - INTERVAL 30 DAY
ORDER BY r.created_at DESC
LIMIT 50;
```

규모는 20~50건에서 시작해도 됩니다. 중요한 건 총량보다 **유형별 최소 건수**입니다. 한 유형에 두 건만 있으면 그 유형의 점수는 읽을 수 없습니다.

로그를 평가셋으로 옮기는 순간 개인정보 복제본이 하나 늘어난다는 점은 짚어둘 만합니다.
평가에 필요한 필드만 남기고, 이름·연락처처럼 답의 품질과 무관한 값은 가명으로 바꿔 넣습니다. 암호화한 컬럼을 그대로 꺼내 쓰는 문제는 [개인정보 암호화 글](/blog/pii-column-encryption-blind-index/)에서 다뤘습니다.

{% comment %} TODO: 실제로 평가셋을 몇 건으로 시작했고, 유형을 어떻게 나눴는지 적어주세요 {% endcomment %}

## 채점을 세 층으로 나눈다

전부를 판정 모델에 맡기면 비싸고, 점수에 노이즈가 섞이고, 무엇이 틀렸는지 알 수 없게 됩니다. 층을 나누면 세 문제가 같이 줄어듭니다.

**1층 — 결정적 검사.** 모델 호출이 없습니다. 스키마, 필수 필드, 금지 표현, 길이 상한, 인용한 문서 ID가 실제 검색 결과 안에 있는지.
의외로 여기서 걸리는 회귀가 많고, 가장 싸고 가장 안정적입니다.

**2층 — 참조 비교.** 정답이 하나로 수렴하는 과제에만 씁니다. 추출한 날짜·금액·분류 라벨이 맞는지.
서술형 답변에 참조 문장을 놓고 문자열을 비교하는 건 의미가 없습니다.

**3층 — 판정 모델.** 위 둘로 표현할 수 없는 것만 남깁니다.

```typescript
export interface EvalCase {
  id: string;                       // 순서가 바뀌어도 추적되는 고정 식별자
  type: string;                      // 층화 추출과 유형별 집계의 기준
  input: Record<string, unknown>;    // 프롬프트에 끼울 구조화 입력
  checks: Check[];                   // 1층
  reference?: string;                // 2층. 정답이 명확할 때만
  rubric?: string[];                 // 3층. 이진 질문의 목록
}

export type Check =
  | { kind: "json_schema"; schema: object }
  | { kind: "must_include"; values: string[] }
  | { kind: "must_not_include"; values: string[] }
  | { kind: "max_chars"; value: number }
  | { kind: "cites_allowed_doc"; allowed: string[] };
```

순서가 중요합니다. **1층에서 걸린 답은 판정 모델로 보내지 않습니다.**

```typescript
export async function gradeCase(c: EvalCase, output: string): Promise<CaseResult> {
  const failedChecks = runChecks(c.checks, output);
  const base = {
    caseId: c.id,
    type: c.type,
    output,
    failedChecks,
    formatOk: failedChecks.length === 0,
  };

  // 형식부터 틀린 답을 판정에 넣으면 "형식 위반"과 "내용 부실"이
  // 한 점수에 섞여서, 점수가 떨어진 이유를 되짚을 수 없게 된다.
  if (!base.formatOk || !c.rubric) return base;

  const judged = await judge(c, output);
  return { ...base, rubricScore: judged.passed / judged.total, judgeNotes: judged.notes };
}
```

JSON 형식 자체를 안정적으로 받는 방법은 [구조화 출력 글](/blog/llm-structured-output-json-schema/)에 적어뒀습니다. 평가 러너와 판정 모델 양쪽에 같은 장치가 필요합니다.

## 판정 모델은 검증한 다음에 쓴다

판정 모델은 또 하나의 LLM 기능입니다. 검증 없이 쓰면, 측정하려던 불확실성을 측정 도구 쪽으로 옮긴 것에 불과합니다.

**기준을 쪼갭니다.** "좋은 답인가"는 채점할 수 없습니다. 독립적으로 판단 가능한 이진 질문의 목록으로 바꿉니다.

```typescript
const rubric = [
  "답변이 주어진 참고 자료 안의 내용만 사용했는가",
  "요청한 세 항목이 모두 포함됐는가",
  "보호자에게 그대로 보낼 수 있는 어조인가",
  "아이의 이름을 임의로 만들어 쓰지 않았는가",
];
```

**근거를 먼저 쓰게 합니다.** 기준마다 한 문장 근거를 쓰고 그다음 통과 여부를 적게 하면, 사람이 판정을 반박할 수 있습니다.
점수만 돌려받으면 판정이 틀렸을 때 알아낼 방법이 없습니다.

```typescript
const JUDGE_INSTRUCTION = `
당신은 채점자입니다. 아래 답변이 각 기준을 만족하는지 기준별로 독립 판단하세요.
기준마다 먼저 근거를 한 문장으로 쓰고, 그다음 통과 여부를 적습니다.
기준에 없는 것(문체 취향, 길이, 친절함)은 채점하지 마세요.
확신할 수 없으면 통과로 처리하지 말고 그대로 적으세요.
`;
```

**사람 라벨과 대조합니다.** 30~50건을 직접 채점해 판정 모델과 얼마나 일치하는지 봅니다.
단순 일치율은 한쪽 라벨이 몰려 있으면 과대평가되므로, 우연에 의한 일치를 보정한 값도 같이 봅니다. 코헨 카파는 `(관측 일치율 − 기대 일치율) / (1 − 기대 일치율)`입니다.

일치율이 낮을 때 먼저 손댈 것은 판정 모델이 아니라 **기준 문장**입니다. 사람 둘이서도 다르게 읽히는 기준이라면 모델이 흔들리는 게 당연합니다.

**편향을 직접 재봅니다.** 두 버전을 비교하게 할 때는 제시 순서를 바꿔 두 번 돌려서, 결과가 뒤집히는 비율을 셉니다. 뒤집힘이 잦으면 그 비교는 쓸 수 없습니다.
길이와 점수의 상관도 한 번 계산해볼 가치가 있습니다. 길게 쓰면 점수가 오르는 판정자라면, 프롬프트를 "더 길게"로 깎는 방향으로 평가가 유도됩니다.

{% comment %} TODO: 판정 모델과 사람 라벨의 일치율을 실제로 재봤다면 그 수치와, 기준 문장을 어떻게 고쳤는지 적어주세요 {% endcomment %}

판정 모델과 그 프롬프트는 기준선과 **같은 버전으로 고정**합니다. 판정자를 바꾼 뒤의 점수는 이전 점수와 비교할 수 없습니다. 결과 파일에 판정자 버전을 같이 남겨두면 나중에 혼동이 없습니다.

## 한 번 돌린 결과로 비교하지 않는다

같은 입력을 같은 설정으로 두 번 호출해도 글자가 달라질 수 있습니다. 재현을 보장하는지는 공급자와 설정에 따라 다르니 공식 문서를 확인하는 쪽이 안전하고, **보장되지 않는다고 가정하고 설계하는 편**이 안전합니다.

여기에 소표본 문제가 겹칩니다. 통과율이 0.8인 30건 평가셋에서 표준오차는 `√(0.8 × 0.2 / 30) ≈ 0.073`입니다. **±7%p, 건수로는 두 건 남짓입니다.**
30건 중 24건에서 25건으로 올랐다고 좋아졌다고 말할 수 없습니다.

그래서 세 가지를 합니다.

- **반복.** 케이스마다 k회 돌려 케이스별 통과율을 냅니다. 항상 실패하는 케이스와 절반만 실패하는 케이스는 다른 문제입니다.
- **같은 시점 비교.** 기존 버전과 새 버전을 같은 실행에서 번갈아 돌립니다. 어제 점수와 오늘 점수를 비교하면 우리 변경과 모델 쪽 변화가 섞입니다.
- **쌍대 비교.** 절대 점수가 둔할 때는 두 출력을 나란히 놓고 어느 쪽이 나은지만 묻습니다. 작은 차이를 더 잘 잡아냅니다.

```typescript
function summarize(results: CaseResult[]) {
  const byType = new Map<string, CaseResult[]>();
  for (const r of results) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  return [...byType].map(([type, rs]) => {
    const n = rs.length;
    const p = rs.filter((r) => r.formatOk).length / n;
    // 이 값보다 작은 차이는 읽지 않는다.
    return { type, n, pass: p, stderr: Math.sqrt((p * (1 - p)) / n) };
  });
}
```

## 러너는 테스트 러너와 요구가 다르다

평가 러너가 해야 할 일은 네 가지입니다.

**동시성 상한.** 평가셋 전체를 한 번에 던지면 레이트 리밋에 걸립니다. 백오프와 재시도는 넣되, 재시도 때문에 평가가 몇 배 느려지는 구조는 피해야 합니다. 이 균형은 [재시도와 타임아웃 예산 글](/blog/retry-timeout-budget-circuit-breaker/)과 같은 이야기입니다.

```typescript
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });

  await Promise.all(workers);
  return out;
}
```

**애플리케이션과 같은 경로.** 프롬프트 문자열만 따로 호출하면 실제 회귀를 놓칩니다.
입력 구조화, 검색, 후처리, 파싱까지 운영과 같은 함수를 타야 합니다. 회귀는 프롬프트가 아니라 그 주변 코드에서 더 자주 생깁니다.

```typescript
const results = await mapLimit(expand(cases, REPEAT), 8, ({ c }) =>
  // 프롬프트를 직접 조립하지 않고, 운영이 쓰는 입구를 그대로 호출한다
  generateAssistantReply(c.input).then((out) => gradeCase(c, out.text)),
);
```

**실패 케이스 보존.** 점수만 남기면 디버깅이 불가능합니다. 입력, 출력, 실패한 검사 이름, 판정 근거를 파일로 떨어뜨리고 CI 아티팩트로 올립니다. 다음 날 보게 되는 건 숫자가 아니라 이 파일입니다.

**비용 상한.** 시작 전에 `건수 × 반복 × (본 호출 + 판정 호출)`을 계산해 출력하고, 미리 정한 상한을 넘으면 멈춥니다.

> 평가 한 번이 운영 트래픽보다 비싸지는 일은 생각보다 쉽게 일어납니다.
> 입력 해시를 키로 결과를 캐시해두면 반복 실행이 싸지지만, **변동성을 측정하는 실행에서는 캐시를 반드시 꺼야** 합니다. 캐시된 결과로 재현성을 재면 항상 완벽해 보입니다.

## CI의 어느 단계에 무엇을 둘 것인가

전체 평가셋을 모든 PR에서 돌리면 느리고 비쌉니다. 두 단계로 나눕니다.

```yaml
eval:smoke:
  stage: test
  rules:
    - changes:
        - "prompts/**/*"
        - "src/assistant/**/*"
  script:
    - npm run eval -- --suite smoke --repeat 1
  artifacts:
    when: always
    paths: ["eval-report/"]
    expire_in: 2 weeks

eval:full:
  stage: test
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
  script:
    - npm run eval -- --suite full --repeat 3 --baseline baselines/latest.json
  artifacts:
    when: always
    paths: ["eval-report/"]
```

PR에서는 결정적 검사 중심의 작은 셋만 돌립니다. 몇 분 안에 끝나고, 형식이 깨지는 변경은 여기서 대부분 잡힙니다.
전체 셋과 반복 실행은 예약 파이프라인이나 머지 후로 미룹니다.

게이트는 절대 점수가 아니라 **기준선 대비 하락폭**으로 잡습니다. 그리고 전체 평균만 보면 안 됩니다.

```bash
npm run eval -- --suite full \
  --baseline baselines/2026-11-01.json \
  --fail-if-drop 0.05 \
  --fail-if-type-drop 0.10
```

전체 평균은 유지되는데 한 유형만 무너지는 경우가 실제로 위험한 쪽입니다. 평균은 다른 유형의 상승으로 가려지고, 무너진 유형을 쓰는 사용자에게만 장애로 보입니다.

임계값은 앞에서 구한 표준오차보다 커야 합니다. 노이즈보다 작은 임계값을 걸면 파이프라인이 무작위로 빨개지고, 그러면 사람들이 재실행 버튼을 누르는 걸로 대응하기 시작합니다.

## 평가셋에 과적합된다

같은 평가셋을 보면서 프롬프트를 깎으면 점수는 계속 오릅니다. 사용자 체감은 따라 오르지 않습니다.

두 가지로 늦출 수 있습니다. 하나는 **홀드아웃**입니다. 개선 중에 보는 셋과, 배포 판단에만 쓰는 셋을 나눠두고 후자는 보는 횟수를 제한합니다.
다른 하나는 **교체**입니다. 분기마다 로그에서 새로 샘플링해 일부를 바꿉니다. 늙은 평가셋은 지난달 문제를 계속 다시 풀게 합니다.

그리고 평가셋이 잡지 못하는 건 결국 배포 뒤에 잡힙니다. 프롬프트 변경도 코드 변경과 같은 방식으로 일부 사용자에게 먼저 내보내는 편이 안전합니다 — [피처 플래그와 점진적 공개](/blog/feature-flag-progressive-rollout/)에서 다룬 구조가 그대로 적용됩니다.

## 정리

1. 평가는 통과/실패가 아니라 측정이다. 기준선 없이는 숫자를 읽을 수 없다.
2. 평가셋은 운영 로그에서, 유형별로 뽑는다. 사용자가 고쳐 쓴 요청이 가장 비싼 샘플이다.
3. 결정적 검사 → 참조 비교 → 판정 모델 순으로 층을 나누고, 앞 층에서 걸린 건 뒤로 넘기지 않는다.
4. 판정 모델은 기준을 이진 질문으로 쪼개고, 사람 라벨과의 일치율을 재고 나서 쓴다.
5. 한 번 돌린 점수로 비교하지 않는다. 30건에서 한두 건 차이는 노이즈다.
6. 러너는 운영과 같은 코드 경로를 타고, 실패 케이스를 파일로 남기고, 비용 상한을 갖는다.
7. PR에는 작은 셋, 예약 실행에는 전체 셋. 게이트는 하락폭으로, 유형별로 본다.
8. 평가셋은 늙는다. 홀드아웃과 주기적 교체로 과적합을 늦춘다.

평가셋을 만드는 비용은 선불이고, 돌아오는 것은 "이 변경이 무엇을 바꿨는지 말할 수 있는 상태"입니다.
프롬프트를 자주 고치는 팀일수록 이 비용이 먼저 회수됩니다.
