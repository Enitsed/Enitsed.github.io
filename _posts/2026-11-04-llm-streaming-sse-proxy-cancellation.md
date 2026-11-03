---
layout: post
title: "로컬에선 글자가 흐르는데 배포하면 한 번에 떨어진다 — LLM 스트리밍이 깨지는 자리들"
date: 2026-11-04
tags: [backend, llm, nodejs, typescript, devops]
excerpt: "모델 응답을 토큰 단위로 내려보내는 경로에서 실제로 문제가 되는 것들. 중간 계층의 버퍼링과 유휴 타임아웃, 클라이언트가 떠났을 때 업스트림 생성을 끊는 방법, 끊긴 응답을 부분 저장하고 이어가는 설계까지."
---

로컬에서 돌릴 때는 글자가 하나씩 흐릅니다. 배포하면 10초쯤 아무것도 없다가 완성된 답이 통째로 떨어집니다.

코드는 그대로고 모델도 그대로입니다. 바뀐 건 요청이 지나는 경로뿐입니다.

스트리밍은 모델을 호출하는 방식의 문제가 아니라 **전송 경로 전체의 문제**입니다.
중간에 선 누군가가 "응답을 모아서 한 번에 보내겠다"고 결정하면, 서버가 토큰 단위로 써도 사용자는 한 번에 받습니다.

## 경로에 몇 명이 끼어 있는가

응답이 사용자 화면에 닿기까지 지나는 구간을 펼쳐보면 이렇게 됩니다.

```text
모델 API ──▶ 애플리케이션 ──▶ 압축 미들웨어 ──▶ 리버스 프록시 ──▶ 로드밸런서 ──▶ CDN ──▶ 브라우저
                              (버퍼링?)        (버퍼링?)        (유휴 타임아웃?)  (버퍼링?)
```

로컬에서는 가운데 네 칸이 전부 비어 있습니다. 그래서 로컬에서 되는 건 아무것도 증명하지 못합니다.

각 구간은 기본값이 **"모아서 보내기"**인 경우가 많습니다. 일반적인 HTTP 응답에서는 그게 맞는 선택이기 때문입니다.
응답을 모아 한 번에 압축하면 전송량이 줄고, 백엔드가 느리게 쓰는 응답을 프록시가 받아두면 백엔드 커넥션이 빨리 풀립니다.

스트리밍은 그 최적화를 전부 반대로 돌려야 합니다. 그래서 작업이 "스트리밍을 구현한다"가 아니라 **"버퍼링을 하는 주체를 하나씩 찾아 끈다"**가 됩니다.

## 무엇으로 흘려보낼 것인가

선택지는 셋입니다. 그리고 가장 익숙한 `EventSource`가 대개 가장 안 맞습니다.

| | SSE + EventSource | SSE + fetch 스트림 | WebSocket |
| --- | --- | --- | --- |
| 요청 메서드 | GET만 | 자유 | 핸드셰이크 후 양방향 |
| 커스텀 헤더 | 불가 (쿠키만) | 가능 | 브라우저 API에서 불가 |
| 자동 재연결 | 내장 (`Last-Event-ID`) | 직접 구현 | 직접 구현 |
| 중간 계층 | 평범한 HTTP | 평범한 HTTP | 업그레이드를 허용해야 |
| 양방향 | 불가 | 불가 | 가능 |

`EventSource`가 걸리는 지점은 **GET만 된다**는 것입니다.
프롬프트와 대화 이력을 보내야 하는데 본문을 쓸 수 없으니 쿼리스트링에 밀어넣게 되고, 그러면 URL 길이 제한에 걸리거나 사용자 입력이 액세스 로그와 프록시 로그에 그대로 남습니다.

`Authorization` 헤더를 붙일 수 없다는 것도 같은 무게의 제약입니다. 쿠키 인증이 아니라면 토큰을 URL에 실어야 합니다.

WebSocket은 양방향이 실제로 필요할 때 — 생성 중에 사용자가 끼어들어 지시를 바꾸거나, 한 연결로 여러 작업을 다중화할 때 — 값을 합니다.
단순히 응답을 흘려보내는 목적이라면 상태를 가진 연결을 하나 더 운영하는 비용이 남습니다([WebSocket 재연결 전략](/blog/websocket-reconnect/)).

그래서 대개 **POST + SSE 포맷 + fetch 스트림 읽기**가 균형점입니다. 프로토콜은 평범한 HTTP라 중간 계층이 특별히 허용할 게 없고, 본문과 헤더를 자유롭게 씁니다. 대신 재연결을 직접 만들어야 합니다.

## 서버 쪽 최소 구성

SSE는 규격이 작습니다. 빈 줄로 이벤트를 끊고, 각 줄은 `필드: 값` 형태입니다.

```typescript
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();
const app = express();

app.post('/api/chat/stream', async (req, res) => {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();                 // 헤더를 먼저 내보낸다

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  // ... 생성 루프 (아래)
});
```

여기서 네 줄이 각각 일을 합니다.

`res.flushHeaders()`는 본문이 나오기 전에 헤더만 먼저 보냅니다. 이게 없으면 첫 토큰이 생길 때까지 응답이 시작조차 하지 않아서, 그 사이 중간 계층이 "아직 아무 응답 없음"으로 보고 자체 타임아웃을 적용할 수 있습니다.

`no-transform`은 중간 계층에 응답을 변형하지 말라는 지시입니다. 압축이 버퍼링을 데려오는 경로를 막습니다.

`X-Accel-Buffering: no`는 nginx가 읽는 응답 헤더입니다. 설정 파일을 고치지 않고 이 응답에 대해서만 버퍼링을 끌 수 있어서, 애플리케이션이 자기 전송 방식을 스스로 선언하는 형태가 됩니다.

하트비트는 **아무 데이터도 흐르지 않는 구간**을 없앱니다. `:`로 시작하는 줄은 SSE 주석이라 클라이언트가 무시하는데, 바이트는 흐르므로 유휴 타임아웃이 리셋됩니다.
모델이 길게 생각한 뒤 첫 토큰을 내보내는 경우, 이 구간이 생각보다 깁니다.

> `data:` 값에는 줄바꿈이 들어갈 수 없습니다. 모델 출력에는 줄바꿈이 흔히 섞여 있으므로 **반드시 직렬화해서** 넣어야 합니다.
> 델타 문자열을 `data: ${text}\n\n`으로 그대로 쓰면, 마크다운 목록이 나오는 순간 이벤트가 둘로 쪼개집니다.

## 버퍼링을 하는 주체 찾기

증상이 같아도 범인은 여러 곳일 수 있습니다. 바깥에서부터 하나씩 벗겨가며 확인하는 게 빠릅니다.

```bash
# 애플리케이션에 직접 (프록시·LB 우회)
curl -N -X POST http://127.0.0.1:3000/api/chat/stream \
  -H 'Content-Type: application/json' -d '{"message":"안녕"}'

# 공개 엔드포인트로 같은 요청
curl -N -X POST https://api.example.com/api/chat/stream \
  -H 'Content-Type: application/json' -d '{"message":"안녕"}'
```

`-N`은 curl 자신의 출력 버퍼링을 끄는 옵션입니다. 이걸 빼면 **서버는 멀쩡한데 curl이 모아서 보여줘서** 버퍼링으로 오진합니다.

안쪽에서는 흐르고 바깥에서는 안 흐르면, 그 사이 계층이 범인입니다.

**압축 미들웨어.** `compression` 같은 미들웨어는 압축 블록을 채우려고 출력을 모읍니다. SSE 경로는 압축에서 제외하는 편이 단순합니다.

```typescript
app.use(compression({
  filter: (req, res) =>
    res.getHeader('Content-Type') !== 'text/event-stream; charset=utf-8'
    && compression.filter(req, res),
}));
```

**리버스 프록시.** nginx라면 응답 버퍼링을 끄고 읽기 타임아웃을 스트림 길이보다 길게 둡니다.

```nginx
location /api/chat/ {
    proxy_pass http://app_upstream;
    proxy_http_version 1.1;
    proxy_buffering off;          # 핵심
    proxy_cache off;
    proxy_read_timeout 300s;      # 생성 시간보다 길게
    proxy_set_header Connection "";
}
```

**로드밸런서와 CDN.** 여기는 끄는 게 아니라 **값을 확인하는** 쪽입니다. 유휴 타임아웃은 "데이터가 흐르지 않은 시간"을 재므로, 하트비트가 그 주기보다 짧으면 끊기지 않습니다.
CDN을 앞에 두면 캐시 대상이 아니라는 것과 응답을 모아두지 않는다는 것을 둘 다 확인해야 합니다.

> 유휴 타임아웃의 기본값과 조정 범위, 스트리밍 응답 취급은 서비스와 버전마다 다릅니다. 하트비트 주기를 정하기 전에 해당 서비스 공식 문서에서 현재 값을 확인하세요.

{% comment %} TODO: 실제 배포 환경에서 버퍼링이 어느 계층에서 걸렸는지, 하트비트 주기를 얼마로 정했는지 적어주세요 {% endcomment %}

## 사용자가 떠났는데 생성은 계속된다

사용자가 탭을 닫거나 "중지"를 누르면 브라우저는 커넥션을 끊습니다. 그런데 서버가 아무 조치도 하지 않으면, **모델은 끝까지 생성합니다.**

응답을 받을 사람이 없는 생성입니다. 출력 토큰은 그대로 발생하고, 동시 요청 한도도 그만큼 계속 점유됩니다.

연결 두 개를 묶어줘야 합니다. 아래로 나가는 HTTP 응답이 닫히면, 위로 올라가는 모델 요청도 끊는 식입니다.

```typescript
  const stream = await client.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 8192,
    messages: await buildMessages(req.body),
    stream: true,
  });

  // 클라이언트가 끊으면 업스트림 생성도 끊는다
  res.on('close', () => stream.controller.abort());
```

`res.on('close')`는 정상 종료에서도 발생합니다. 이미 끝난 스트림을 abort하는 건 아무 일도 하지 않으니, 분기를 따로 둘 필요는 없습니다.

취소에는 두 가지 방법이 있습니다. `for await` 루프를 `break`로 빠져나오거나, 위처럼 컨트롤러를 abort하는 것입니다.
핸들러 바깥의 이벤트(여기서는 커넥션 종료)로 끊어야 하니 후자를 씁니다.

> 취소 시점까지 생성된 분량의 과금과, 취소가 반영되는 정확한 경계는 모델 제공자의 공식 문서를 확인하세요.
> 여기서 확실한 것은 **끊지 않으면 끝까지 생성된다**는 것뿐입니다.

중지 버튼도 같은 장치를 씁니다. 클라이언트가 `AbortController`로 fetch를 끊으면 서버에서 `close`가 발생하고, 그게 업스트림까지 전파됩니다.
별도의 "취소 API"를 만들 필요가 없고, 만들면 오히려 요청 두 개를 짝지어야 하는 문제가 생깁니다.

## 끊기면 아무것도 남지 않는다

스트리밍의 기본 구조에는 함정이 하나 있습니다. 응답을 **흘려보내기만 하면** 서버에는 아무것도 남지 않습니다.

20초 생성이 18초쯤에서 끊기면 사용자는 글자를 보고 있었는데도 저장된 건 없습니다. 새로고침하면 대화에 질문만 있고 답이 비어 있습니다.

그래서 흘려보내면서 **동시에 모읍니다.**

```typescript
  let text = '';
  let stopReason: string | null = null;

  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text;
        send('delta', { text: event.delta.text });
      } else if (event.type === 'message_delta') {
        stopReason = event.delta.stop_reason ?? null;
        send('usage', { usage: event.usage });
      }
    }
    await saveAssistantMessage({ text, status: 'complete', stopReason });
    send('done', { stopReason });
  } catch (err) {
    // 취소·업스트림 오류·커넥션 종료가 모두 여기로 온다
    await saveAssistantMessage({ text, status: 'partial', stopReason: 'aborted' });
    if (!res.writableEnded) send('error', { message: '응답이 중단되었습니다' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
```

`catch`에서도 저장하는 게 요점입니다. 그리고 `status`를 남겨 **완성된 답과 중단된 답을 구분**합니다.
이 구분이 없으면 중단된 답이 다음 턴의 대화 이력에 완성된 답처럼 들어가고, 모델은 자기가 말을 끝냈다고 전제한 상태로 이어서 대답합니다.

델타마다 DB에 쓰는 건 피해야 합니다. 토큰 수만큼 쿼리가 나가고, 그 비용이 이벤트 루프에 그대로 얹힙니다([이벤트 루프 블로킹](/blog/nodejs-event-loop-blocking/)).
메모리에 모아 끝에서 한 번 쓰거나, 긴 생성이라면 일정 간격으로 묶어 쓰는 쪽이 맞습니다.

## 이어가기는 어디까지 가능한가

부분 저장까지 하면 자연히 다음 질문이 옵니다. 끊긴 지점부터 이어서 받을 수 있는가.

**완전한 재개는 안 됩니다.** 모델 출력은 결정적이지 않으므로, 같은 입력으로 다시 호출해도 앞부분이 똑같이 나오지 않습니다.
끊긴 자리에 정확히 이어 붙는 연속을 다시 받는다는 전제가 성립하지 않습니다.

현실적인 선택은 셋이고, 복잡도 순서대로입니다.

| | 사용자 경험 | 비용 | 구현 |
| --- | --- | --- | --- |
| 받은 만큼 남기고 끝 | 중단된 답이 그대로 남는다 | 추가 없음 | 부분 저장만 |
| 처음부터 다시 생성 | 앞부분이 달라진다 | 전체 재생성 | 재시도 버튼 |
| 생성을 요청과 분리 | 재연결해서 이어 받는다 | 저장소 추가 | 큐 + 워커 + 델타 버퍼 |

세 번째가 "진짜 재개"입니다. 생성을 HTTP 요청의 수명에서 떼어내 워커가 돌리고, 델타를 중간 저장소에 쌓고, 클라이언트는 **읽은 위치를 들고** 재연결합니다.
SSE의 `id:` 필드와 재연결 시 오는 `Last-Event-ID` 헤더가 그 위치 전달에 쓰입니다.

```typescript
  // 생성을 분리한 구조에서는 각 델타에 순번을 붙인다
  sendWithId(seq, 'delta', { text });

  // 재연결 요청에서
  const lastId = Number(req.headers['last-event-id'] ?? -1);
  for (const d of await readDeltas(generationId, lastId + 1)) { /* 재생 */ }
```

대신 들어오는 비용이 분명합니다. 큐와 워커, 델타 보관소와 그 만료 정책, 생성 상태 관리가 전부 추가됩니다([가시성 타임아웃과 DLQ](/blog/sqs-consumer-visibility-timeout-dlq/)).

여기서 꼭 필요한 장치가 **멱등**입니다. 재연결이 새 생성을 트리거하면 한 질문에 두 번 과금되고, 두 생성이 같은 대화에 답을 둘 쓰게 됩니다.
클라이언트가 재연결할 때 `generationId`를 들고 와서, 그게 이미 진행 중이면 붙기만 하고 새로 시작하지 않아야 합니다([멱등키 설계](/blog/idempotency-key-payment-api/)).

{% comment %} TODO: 어느 단계까지 구현했는지, 세 번째 방식을 택했다면 델타 보관에 무엇을 썼고 만료를 어떻게 잡았는지 적어주세요 {% endcomment %}

## 클라이언트에서 경계를 직접 자른다

fetch 스트림으로 읽으면 SSE 파싱을 직접 해야 합니다. 여기서 거의 모두가 한 번은 밟는 함정이 있습니다.

**네트워크 청크 경계는 이벤트 경계와 무관합니다.** 한 청크에 이벤트 세 개가 들어오기도 하고, `data:` 한 줄이 두 청크에 걸쳐 쪼개지기도 합니다.
받은 조각을 그때그때 파싱하면 긴 응답에서 가끔 글자가 깨지거나 이벤트가 유실됩니다.

버퍼에 모아두고 빈 줄이 나올 때만 잘라냅니다.

```typescript
export async function streamChat(
  body: unknown,
  onEvent: (event: string, data: string) => void,
  signal: AbortSignal,
) {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += value;

    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {   // 이벤트 경계는 빈 줄
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = parseBlock(block);
      if (parsed) onEvent(parsed.event, parsed.data);
    }
  }
}

function parseBlock(block: string): { event: string; data: string } | null {
  let event = 'message';
  const data: string[] = [];

  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;                      // 주석(하트비트)
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? { event, data: data.join('\n') } : null;
}
```

`TextDecoderStream`을 쓰는 이유도 같은 종류입니다. 한글은 UTF-8에서 여러 바이트라 **한 글자가 두 청크에 걸칠 수 있습니다.**
바이트를 청크 단위로 각각 디코딩하면 경계에서 글자가 깨집니다. 디코더 스트림은 걸친 바이트를 들고 있다가 다음 청크와 붙여 처리합니다.

그리고 `res.ok` 확인을 빠뜨리지 않습니다. 오류 응답은 보통 `text/event-stream`이 아니라 JSON으로 오는데, 스트림 파서는 그걸 "이벤트가 하나도 없는 스트림"으로 읽고 조용히 끝냅니다.

## 배포가 긴 스트림을 끊는다

스트리밍 응답은 수명이 깁니다. 그리고 배포는 그 수명을 모릅니다.

종료 신호를 받은 인스턴스가 처리 중인 요청을 기다려주는 시간은 보통 수십 초 단위로 잡혀 있습니다.
평범한 API에는 충분하지만, 긴 생성은 그 시간을 넘길 수 있습니다. 넘기면 강제 종료되고, 사용자 화면에서는 답이 중간에 멈춥니다([종료 신호와 커넥션 드레이닝](/blog/graceful-shutdown-deploy-5xx/)).

선택지가 셋이고, 전부 트레이드오프가 있습니다.

- **드레이닝 시간을 생성 최대 시간보다 길게.** 사용자는 안 끊기지만 배포가 그만큼 느려집니다.
- **종료 신호를 받으면 즉시 새 스트림을 거부하고, 진행 중인 것만 흘린다.** 배포 중 일부 요청이 다른 인스턴스로 가야 하니 LB 쪽 등록 해제와 맞물려야 합니다.
- **종료 전에 중단 이벤트를 보내 클라이언트가 재연결하게 한다.** 앞의 "이어가기"가 구현돼 있어야 성립합니다.

중요한 건 어느 쪽을 택하든 **클라이언트가 중단을 구분할 수 있어야** 한다는 점입니다.
정상 종료는 `done` 이벤트로 끝나고, 비정상 종료는 이벤트 없이 커넥션이 닫힙니다. 클라이언트가 이 둘을 같게 취급하면 중단된 답에 완료 표시가 붙습니다.

## 무엇을 재고 무엇을 로그에 남기는가

스트리밍은 "응답 시간" 하나로는 설명되지 않습니다. 적어도 둘로 나눠 봐야 합니다.

- **첫 토큰까지의 시간.** 사용자가 체감하는 반응 속도입니다. 버퍼링 사고는 여기서 가장 먼저 보입니다.
- **스트림 전체 수명.** 타임아웃 값과 드레이닝 시간을 정하는 근거가 됩니다. 평균보다 상위 분위수를 봐야 합니다.

그리고 **어떻게 끝났는지**를 분류해 셉니다. 정상 완료, 클라이언트 취소, 업스트림 오류, 종료로 인한 중단 — 이 비율이 움직이는 게 신호입니다.
취소율이 갑자기 오르면 응답이 느려졌거나 품질이 떨어져 사용자가 중간에 끊고 있다는 뜻일 수 있습니다.

로그는 **스트림이 끝날 때 한 줄**로 남깁니다. 델타마다 찍으면 로그량이 출력 토큰 수에 비례해 늘어납니다.

```typescript
  log().info({
    conversation_id: conversationId,
    generation_id: generationId,
    ttft_ms: firstTokenAt ? firstTokenAt - startedAt : null,
    duration_ms: Date.now() - startedAt,
    outcome,                      // complete | client_abort | upstream_error | shutdown
    stop_reason: stopReason,
    output_chars: text.length,
  }, 'chat stream finished');
```

프롬프트와 생성 결과를 로그에 그대로 넣지 않는 편이 좋습니다. 사용자가 입력한 내용이 들어오는 자리고, 로그는 DB보다 보는 사람이 많습니다([구조화 로깅과 상관관계 ID](/blog/structured-logging-correlation-id/)).

메트릭 라벨에 `conversation_id`나 `user_id`를 붙이는 것도 같은 이유로 피합니다. 대화 수만큼 시계열이 생깁니다([메트릭 카디널리티와 라벨 설계](/blog/metric-cardinality-label-design/)).

## 정리

- 스트리밍이 로컬에서만 되는 건 정상이다. 중간 계층의 기본값이 **모아서 보내기**다.
- 바깥에서부터 `curl -N`으로 좁혀 범인을 찾는다. `-N` 없이 테스트하면 curl 자신의 버퍼링을 서버 문제로 오진한다.
- 압축 미들웨어는 SSE 경로에서 제외하고, 프록시 버퍼링을 끄고, `no-transform`과 `X-Accel-Buffering: no`로 응답이 스스로 선언하게 한다.
- `flushHeaders()`로 헤더를 먼저 보내고, 하트비트로 **데이터가 흐르지 않는 구간**을 없애 유휴 타임아웃을 피한다.
- `data:`에는 줄바꿈을 넣을 수 없다. 델타는 반드시 직렬화한다.
- `EventSource`는 GET만 되고 커스텀 헤더를 못 붙인다. 프롬프트가 쿼리스트링과 로그에 남는다. POST + fetch 스트림이 대개 맞다.
- 클라이언트가 끊으면 업스트림 생성도 끊는다. 끊지 않으면 받을 사람 없는 응답이 끝까지 생성된다.
- 흘려보내면서 동시에 모아 **부분 저장**한다. 완성과 중단을 `status`로 구분하지 않으면 중단된 답이 완성된 답처럼 다음 턴 이력에 들어간다.
- 완전한 재개는 불가능하다. 이어 받기를 원하면 생성을 요청 수명에서 분리해야 하고, 그때 **멱등**이 없으면 한 질문에 두 번 과금된다.
- 청크 경계는 이벤트 경계도 글자 경계도 아니다. 버퍼에 모아 빈 줄로 자르고, 디코딩은 `TextDecoderStream`에 맡긴다.
- 재는 건 응답 시간 하나가 아니라 첫 토큰까지의 시간, 스트림 수명, 그리고 **어떻게 끝났는지**의 분포다.
