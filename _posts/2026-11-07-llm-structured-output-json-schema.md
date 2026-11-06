---
layout: post
title: "스무 번은 되고 한 번은 JSON.parse가 터진다 — LLM 응답을 스키마에 묶기"
date: 2026-11-07
tags: [llm, backend, typescript, api, architecture]
excerpt: "프롬프트에 \"JSON만 출력하라\"고 적어두고 파싱을 믿는 코드가 어디서 깨지는지. 파싱 실패와 스키마 불일치와 출력 절단을 구분하는 법, 스키마 강제가 보장하는 범위, 복구 루프의 상한, 스트리밍과 부분 JSON의 트레이드오프."
---

시스템 프롬프트 마지막 줄에 "다른 설명 없이 JSON만 출력하라"라고 적고, 응답을 `JSON.parse`에 바로 넣는 코드가 있습니다.
개발 중에는 스무 번을 돌려도 통과합니다.

모델 출력은 자유 텍스트이고, "JSON으로 줘"는 **요청이지 제약이 아닙니다.** 그 간격을 어디서 메울지의 문제입니다.

## 깨지는 방식은 한 가지가 아니다

"JSON 파싱 실패"로 묶이는 증상이 실제로는 성질이 다른 세 가지입니다. 대응하는 위치도 다릅니다.

**첫째, 텍스트가 JSON이 아닌 경우.** 코드펜스로 감싸져 오거나, 앞에 "요청하신 내용입니다:"가 붙거나, 뒤에 설명 한 문단이 따라옵니다.
드물게는 홑따옴표나 트레일링 콤마가 섞입니다. 이건 **문법 문제**이고, 애초에 문법을 보장받는 쪽으로 옮기면 사라집니다.

**둘째, 파싱은 되는데 모양이 다른 경우.** 더 고약합니다. `JSON.parse`가 통과하니까 코드는 그대로 진행하고, 몇 단계 뒤에서 엉뚱한 에러가 납니다.

- 숫자를 문자열로 (`"count": "3"`)
- enum에 없는 비슷한 값 (`"high"` 대신 `"매우 높음"`)
- 원소가 하나일 때 배열이 아니라 객체로
- 선택 필드를 생략하지 않고 `null`이나 빈 문자열로 채움

**셋째, 중간에 끊긴 경우.** 출력 토큰 상한에 걸려 JSON이 완결되지 않은 채로 옵니다.
이건 **재시도해도 같은 결과**가 나오기 때문에 앞의 두 가지와 반드시 구분해야 합니다.

| 증상 | 성질 | 대응 위치 |
| --- | --- | --- |
| 텍스트가 JSON이 아니다 | 문법 | 스키마 강제로 애초에 막는다 |
| 모양이 스키마와 다르다 | 의미 | 서버 검증 + 제한된 재시도 |
| JSON이 중간에 끊겼다 | 절단 | 출력 상한을 늘리거나 작업을 쪼갠다 |

세 가지를 한 `try/catch`로 받아놓으면, 재시도해도 소용없는 절단을 토큰을 태우며 세 번 반복하게 됩니다.

## 받는 방법은 세 가지고, 보장 수준이 다르다

| 방식 | 보장 | 비용·제약 |
| --- | --- | --- |
| 프롬프트로 부탁하기 | 없음 | 모델·제공자 무관하게 동작. 후처리가 필요하다 |
| 구조화 출력 (스키마 강제) | 문법과 스키마 모양 | 지원 모델이 정해져 있고, 쓸 수 있는 JSON Schema 범위가 좁다 |
| 도구 입력 스키마 (strict) | 도구 인자의 모양 | 도구 호출 흐름을 타야 한다 |

프롬프트로 부탁하는 방식은 "대체로 되는" 수준이고, 트래픽이 커지면 실패 비율이 그대로 드러납니다.
반대로 스키마 강제는 디코딩 단계에서 형식을 제약하므로 첫 번째 범주가 거의 사라집니다.

> 예전에 흔히 쓰던 두 가지 우회법은 최신 모델에서 막혔습니다.
> 어시스턴트 턴을 `{`로 선채움(prefill)하는 방법과, 도구 호출을 `tool_choice`로 강제해서 JSON을 받아내는 방법은 최신 세대 모델에서 400을 돌려줍니다.
> JSON을 받으려고 도구를 강제했던 코드라면 구조화 출력으로 옮기는 쪽이 맞습니다. 파라미터 이름과 지원 범위는 제공자·모델마다 다르니 쓰는 SDK의 공식 문서를 확인하세요.

## 강제를 쓸 수 없는 경로가 남는다

모든 호출에 스키마 강제를 걸 수 있는 건 아닙니다. 지원하지 않는 모델을 쓰는 경로가 있고, 인용(citation)처럼 함께 쓸 수 없는 기능과 조합해야 하는 경우도 있습니다.
그런 경로에서는 결국 텍스트를 받아 다듬게 되는데, 이때 **어디까지 다듬을지**를 정해두는 편이 좋습니다.

```typescript
// 마지막 수단. 복구할 수 있는 범위를 좁게 정해둔다.
function extractJsonBlock(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();

  const start = candidate.search(/[[{]/);
  if (start === -1) return null;

  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (end <= start) return null;        // 여는 괄호만 있다 = 잘렸다

  return candidate.slice(start, end + 1);
}
```

여기서 멈춰야 합니다. 트레일링 콤마를 지우고 홑따옴표를 바꾸고 따옴표 없는 키를 보정하는 "관용 파서"까지 가면,
**깨진 출력을 조용히 그럴듯한 값으로 바꿔놓는** 코드가 됩니다. 그 지점부터는 실패가 로그에 남지 않고 데이터로 남습니다.

괄호 균형이 맞지 않으면 복구하지 말고 절단으로 분류하는 게 맞습니다. 복구된 JSON은 앞부분만 맞고 뒷부분은 비어 있는 객체인데, 스키마 검증이 그걸 통과시킬 수도 있습니다.

## 스키마를 코드로 한 번만 쓴다

스키마를 JSON Schema로 쓰고 타입을 따로 선언하면 둘이 어긋납니다. 한쪽에서 선언하고 양쪽으로 쓰는 편이 낫습니다.

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const TicketSchema = z.object({
  category: z.enum(["billing", "bug", "feature_request", "other"]),
  urgency: z.enum(["low", "medium", "high"]),
  summary: z.string(),
  mentioned_features: z.array(z.string()),
});

type Ticket = z.infer<typeof TicketSchema>;

const client = new Anthropic();

const res = await client.messages.parse({
  model: "claude-opus-5-5",
  max_tokens: 4096,
  messages: [{ role: "user", content: ticketBody }],
  output_config: { format: zodOutputFormat(TicketSchema) },
});

// 파싱에 실패하면 null이 온다. 단정하지 말고 분기한다.
const ticket: Ticket | null = res.parsed_output;
```

`parsed_output`이 `null`일 수 있다는 점이 중요합니다. 여기에 `!`를 붙여 넘기면 런타임에서 터집니다.

## 스키마가 다 막아주지는 않는다

쓸 수 있는 JSON Schema가 전부는 아닙니다. 타입·`enum`·`anyOf`·`$ref` 같은 구조는 되지만, **수치 범위(`minimum`/`maximum`)와 문자열 길이(`minLength`/`maxLength`), 재귀 스키마는 지원되지 않습니다.**
모든 객체에 `additionalProperties: false`가 필요하다는 조건도 붙습니다.

SDK는 지원되지 않는 제약을 **스키마에서 떼어내 보내고, 받은 뒤 클라이언트에서 검증**합니다.
즉 "요약은 200자 이하"는 디코딩 제약이 아니라 사후 검증입니다. 어기면 생성이 막히는 게 아니라 검증에서 걸립니다.

그리고 더 중요한 한 가지.

> 스키마는 **모양**을 보장하고 **의미**는 보장하지 않습니다.
> `category`가 네 값 중 하나라는 건 보장되지만, 그게 **맞는** 값이라는 보장은 어디에도 없습니다.

그래서 서버 쪽 검증은 스키마 통과 이후에도 남습니다. 참조 ID가 실제로 존재하는지, 금액이 허용 범위인지, 상태 전이가 가능한지 — 이건 전부 내 도메인 코드의 몫입니다.
스키마 강제를 켠 뒤에 이 검증을 걷어내는 게 흔한 실수입니다.

## 재시도 전에 종료 이유를 먼저 본다

응답에는 왜 생성이 끝났는지가 들어옵니다. 여기서 분기하지 않으면 복구 루프가 헛돕니다.

```typescript
switch (res.stop_reason) {
  case "max_tokens":
    // 출력이 잘렸다. 같은 요청을 다시 보내도 같은 지점에서 잘린다.
    throw new OutputTruncatedError({ requested: 4096 });

  case "refusal":
    // 안전상 거부. 이 경우 출력이 스키마를 만족하지 않을 수 있다.
    // stop_details는 refusal일 때만 채워지므로 다른 경우엔 접근하지 않는다.
    throw new RefusedError(res.stop_details?.category);

  case "end_turn":
    break;
}
```

`max_tokens`는 재시도가 아니라 **설계를 바꿔야 하는** 신호입니다. 상한을 올리거나, 한 번에 뽑는 항목 수를 줄이거나, 긴 자유 서술 필드를 스키마에서 빼는 쪽입니다.
배열을 반환하는 작업이라면 입력을 쪼개 여러 번 호출하는 편이 예측 가능합니다.

`stop_details`는 거부일 때만 값이 있고 나머지는 비어 있으니, 읽기 전에 가드를 둬야 합니다.

## 복구 루프에는 상한을 둔다

검증 실패를 한 번은 모델에게 되돌려줄 수 있습니다. 어디가 틀렸는지 알려주면 두 번째 시도의 성공률이 올라갑니다.
다만 **상한이 없는 복구 루프는 장애가 됩니다.**

```typescript
const MAX_REPAIR = 1;

async function extract(body: string): Promise<Ticket> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: body }];

  for (let attempt = 0; attempt <= MAX_REPAIR; attempt++) {
    const res = await client.messages.parse({ /* ... */ messages });
    assertStopReason(res);           // 위의 switch

    const parsed = TicketSchema.safeParse(res.parsed_output);
    if (parsed.success) return parsed.data;

    // 원문을 반드시 남긴다. 스키마를 고칠 근거가 여기서 나온다.
    logger.warn({ attempt, raw: textOf(res), issues: parsed.error.issues },
                "structured output validation failed");

    if (attempt === MAX_REPAIR) throw new ValidationFailedError(parsed.error);

    messages.push(
      { role: "assistant", content: textOf(res) },
      { role: "user", content:
        `위 응답이 스키마 검증에 실패했습니다. 다음 항목만 고쳐 다시 출력하세요.\n` +
        parsed.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n") },
    );
  }

  throw new Error("unreachable");
}
```

재시도 한 번의 비용은 생각보다 큽니다. 출력 토큰만 두 배가 아니라, **입력 전체를 다시 보냅니다.**
이력에 실패한 응답과 오류 목록까지 더해지니 두 번째 요청이 첫 번째보다 비쌉니다.

그래서 상한은 1~2회로 두고, 그 뒤는 실패로 처리하는 편이 낫습니다.
사용자에게 보이는 흐름이라면 "다시 시도" 버튼을 주는 쪽이, 뒤에서 조용히 다섯 번 재시도하고 응답이 20초 뒤에 오는 것보다 낫습니다.

{% comment %} TODO: 운영에서 1차 시도 통과율이 실제로 어느 정도였는지, 재시도를 몇 회로 두었는지 적을 수 있으면 여기에 {% endcomment %}

## 스키마 설계가 통과율을 바꾼다

같은 모델에서도 스키마 모양에 따라 1차 통과율이 달라집니다. 몇 가지는 규칙으로 둘 만합니다.

**얕고 평평하게.** 3단 이상 중첩된 객체는 실패가 늘고, 잘렸을 때 복구도 어렵습니다. 중첩을 줄이고 참조 ID로 연결하는 편이 안정적입니다.

**enum 값은 짧은 코드값으로.** 사람이 읽을 라벨은 enum 값이 아니라 설명에 둡니다. 한국어 라벨을 enum 값으로 쓰면 유의어로 변형될 여지가 생깁니다.

**설명은 프롬프트가 아니라 스키마에.** 필드별 `describe()`에 쓴 설명은 스키마와 함께 모델에게 전달되므로, 프롬프트에 또 적어 중복시키지 않아도 됩니다.

```typescript
const TicketSchema = z.object({
  category: z.enum(["billing", "bug", "feature_request", "other"])
    .describe("문의의 주된 성격. 둘 이상 해당하면 사용자가 요청한 조치를 기준으로 고른다."),
  urgency: z.enum(["low", "medium", "high"])
    .describe("high는 결제 불가·로그인 불가처럼 현재 서비스를 쓸 수 없는 경우에만."),
  summary: z.string().describe("한 문장. 원문 표현을 그대로 쓰지 말고 요약한다."),
  mentioned_features: z.array(z.string())
    .describe("본문에 명시된 기능 이름만. 추측해서 채우지 않는다. 없으면 빈 배열."),
});
```

**"없음"을 표현할 길을 열어둔다.** 선택 필드를 그냥 optional로 두면 생략과 `null` 사이에서 흔들립니다.
필수로 두고 빈 배열이나 `"unknown"` 같은 명시적 값을 받는 쪽이 코드에서 다루기 쉽습니다. 분류를 강제하면 모델은 어떻게든 하나를 고른다는 것도 같이 기억해야 합니다.

**연속적인 점수보다 구간.** `0~100` 점수는 재현성이 낮습니다. 세 단계 구간 enum이 훨씬 안정적이고, 대개 그 해상도로 충분합니다.

## 스트리밍과 부분 JSON

JSON은 끝까지 와야 유효합니다. 그래서 스키마 강제와 스트리밍 UI는 서로 당깁니다.

선택지는 대략 세 가지입니다.

1. **구조화 출력 + 비스트리밍.** 가장 단순합니다. 대신 전체 생성 시간이 그대로 대기 시간으로 노출됩니다.
2. **사람이 읽을 본문과 구조화 데이터를 분리.** 본문은 스트리밍으로 흘리고, 구조화된 필드는 별도 호출이나 도구 호출로 받습니다. 호출이 늘지만 UI가 가장 자연스럽습니다.
3. **부분 JSON을 중간 렌더.** 필드가 완성될 때마다 화면에 반영합니다. 중간 상태는 당연히 스키마를 만족하지 않으니, **검증은 최종본에만** 적용하고 중간값은 화면 전용으로 다룹니다.

> 큰 `max_tokens`를 쓰는 요청은 스트리밍 쪽이 안전합니다. 비스트리밍으로 긴 생성을 기다리면 SDK나 중간 프록시의 HTTP 타임아웃에 먼저 걸립니다.
> 도구 입력을 조기 스트리밍으로 받는 옵션을 켠 경우에는 주의가 하나 더 붙습니다. 그 모드에서는 API가 입력을 검증하거나 보정하지 않고, 관용적인 파서는 **조용히 잘린 입력**을 예외 없이 돌려줄 수 있습니다.
> 누적한 조각을 파싱한 뒤 반드시 스키마로 검증하고, 실패는 잘못된 JSON과 같게 취급하세요.

## 무엇을 남기는가

구조화 출력은 조용히 나빠지는 종류의 기능입니다. 스키마를 한 줄 고치거나 모델을 바꾸면 통과율이 달라지는데, 로그가 없으면 알 수 없습니다.

남길 것은 네 가지입니다.

- **검증 실패한 원문 전체.** 가장 중요합니다. 스키마를 어떻게 고칠지는 실패한 출력에서만 나옵니다.
- **1차 시도 통과율과 재시도율.** 이게 올라가면 비용과 지연이 같이 올라갑니다.
- **`stop_reason` 분포.** `max_tokens` 비율이 늘고 있다면 입력이 길어지고 있다는 신호입니다.
- **스키마 버전.** 통과율 변화를 스키마 변경과 맞춰 보려면 필요합니다.

운영에서 하나 더. 새 스키마는 첫 요청에 일회성 컴파일 비용이 붙고, 이후 한동안 캐시됩니다.
스키마를 자주 바꾸면 그 비용을 매번 내게 되니, 배포마다 미세하게 손보는 것보다 모아서 바꾸는 편이 낫습니다. 캐시 유효 기간은 공식 문서에서 확인하세요.

{% comment %} TODO: 실제로 통과율을 떨어뜨렸던 스키마 변경이 있었다면 사례로 적어주세요 {% endcomment %}

## 정리

- "JSON 파싱 실패"를 문법·스키마·절단 세 가지로 쪼개야 대응이 갈린다. 절단은 재시도해도 같다.
- 스키마 강제는 문법과 모양까지만 보장한다. 의미 검증은 걷어내지 말 것.
- 쓸 수 있는 JSON Schema 범위는 좁다. 수치·길이 제약은 사후 검증으로 넘어간다.
- 재시도 전에 종료 이유를 보고, 복구 루프에는 1~2회 상한을 둔다.
- 스키마는 얕게, enum은 코드값으로, 설명은 필드에 붙인다.
- 검증 실패한 원문을 남기지 않으면 스키마를 고칠 근거가 없다.
