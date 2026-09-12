---
layout: post
title: "GitHub 이슈 상태를 Slack에 동기화하기"
date: 2026-09-12
tags: [automation, slack, github, typescript]
excerpt: "GitHub App 인증부터 웹훅 서명 검증, 이벤트 해석, chat.update로 원본 메시지를 갱신하는 방식까지. 알림만 쏘는 봇과 상태를 맞추는 연동은 만드는 법이 다릅니다."
---

이슈가 닫혀도 Slack에 올라간 논의 스레드는 그대로 열려 있습니다.
누군가 옮겨 적어야 하는데, 그 일은 언제나 더 급한 일에 밀립니다.

그래서 봇을 붙입니다. 그런데 대부분의 봇은 이벤트가 생길 때마다 새 메시지를 하나씩 쌓고, 채널은 금방 아무도 읽지 않는 로그가 됩니다.
읽히지 않는 알림은 아무도 옮겨 적지 않는 것과 결과가 같습니다.

## 무엇을 연결할 것인가

흐름 자체는 단순합니다. **GitHub에서 일이 일어나고 → 우리 서버가 그 사실을 받고 → 무슨 일인지 해석하고 → Slack의 무엇을 어떻게 바꿀지 정해 반영합니다.**
네 단계가 전부인데, 단계마다 빠뜨리면 나중에 반드시 물어뜯기는 지점이 하나씩 있습니다.

알림만 쏘는 봇과 상태를 맞추는 연동은 마지막 단계에서 갈립니다.
전자는 "무슨 일이 있었다"를 계속 덧붙이고, 후자는 **"지금 어떤 상태다"를 한 곳에 유지**합니다.

차이는 읽는 사람의 동작에서 드러납니다. 덧붙이는 방식에서는 채널을 거슬러 올라가며 최신 상태를 스스로 재구성해야 합니다.
유지하는 방식에서는 메시지 하나만 보면 됩니다. 그 메시지가 항상 지금을 가리키니까요.

그래서 이 글의 목표는 "이슈가 닫혔습니다"를 잘 보내는 것이 아닙니다.
**이슈 하나에 대응하는 Slack 메시지를 정해두고, 그것을 계속 고쳐 쓰는 것**입니다.

## GitHub App으로 인증하기

먼저 GitHub에 접근할 자격이 필요합니다. 개인 액세스 토큰(PAT)이 제일 빠른 길이지만, 팀에서 쓸 자동화에는 맞지 않습니다.

PAT는 **발급한 사람의 권한을 그대로 물려받습니다.** 그 사람이 접근할 수 있는 저장소 전부에 봇도 접근할 수 있고, 봇이 남긴 코멘트는 그 사람 이름으로 달립니다.
그리고 그 사람이 팀을 떠나거나 권한이 바뀌면 자동화가 조용히 멈춥니다.

GitHub App은 세 가지가 다릅니다.

- **권한을 기능 단위로 좁게 잡습니다.** 이슈 읽기·쓰기만 필요하면 그것만 줍니다.
- **설치 단위로 붙습니다.** 어떤 저장소에 설치했는지가 곧 접근 범위이고, 조직 관리자가 그 목록을 볼 수 있습니다.
- **봇 아이덴티티를 가집니다.** 누가 코멘트를 달았는지가 사람 계정이 아니라 앱 이름으로 남습니다.

인증은 두 단계입니다. 앱의 개인키로 서명한 JWT를 만들어 "나는 이 앱이다"를 증명하고, 그 JWT로 특정 설치에 대한 **installation access token**을 받아옵니다.
실제 API 호출은 이 설치 토큰으로 합니다.

```typescript
import { createAppAuth } from "@octokit/auth-app";

const auth = createAppAuth({
  appId: process.env.GITHUB_APP_ID!,
  privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
});

// 1단계 — 앱 자신을 증명하는 JWT
const appAuth = await auth({ type: "app" });

// 2단계 — 설치 단위 액세스 토큰으로 교환
const installationAuth = await auth({
  type: "installation",
  installationId: Number(process.env.GITHUB_INSTALLATION_ID),
});
```

`privateKey`에 `.replace()`가 붙은 이유는 환경변수 때문입니다. PEM은 여러 줄인데 환경변수는 한 줄이라, 줄바꿈을 `\n` 두 글자로 넣어두고 읽을 때 되돌립니다.
여기서 넘어지는 경우가 의외로 많고, 증상은 "서명이 안 된다"는 불친절한 오류로 나타납니다.

설치 토큰은 만료됩니다. 직접 들고 다니면 만료 시점을 신경 써야 하니, 실제 코드에서는 Octokit에 인증 전략으로 넘기고 갱신을 맡기는 편이 낫습니다.

```typescript
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";

const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: process.env.GITHUB_APP_ID!,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY!.replace(/\\n/g, "\n"),
    installationId: Number(process.env.GITHUB_INSTALLATION_ID),
  },
});
```

이렇게 두면 첫 호출 때 토큰을 만들고 만료되면 알아서 다시 받아옵니다. 유효 기간과 권한 이름의 정확한 값은 GitHub 공식 문서에서 확인하세요.

## Webhook 수신과 검증

다음은 GitHub이 보내는 이벤트를 받는 자리입니다.
이 엔드포인트는 인터넷에 열려 있어야 하므로, **누가 보냈는지 확인하지 않으면 아무나 우리 Slack에 글을 쓸 수 있습니다.**

GitHub은 요청마다 `X-Hub-Signature-256` 헤더를 붙입니다.
값은 `sha256=` 접두사에 이어, **웹훅 시크릿을 키로 요청 본문에 HMAC-SHA256을 건 결과**의 16진수 표현입니다.

여기에 함정이 하나 있습니다.

> 서명은 반드시 **받은 원문 바이트 그대로** 계산해야 합니다.
> JSON으로 파싱했다가 다시 문자열로 만들면 키 순서·공백·유니코드 이스케이프가 달라져 서명이 깨집니다.

그래서 이 라우트만큼은 JSON 파서를 태우지 않고 원문 버퍼를 받습니다.

```typescript
import express from "express";
import crypto from "node:crypto";

function verifySignature(rawBody: Buffer, header: string | undefined): boolean {
  if (!header) return false;

  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", process.env.GITHUB_WEBHOOK_SECRET!)
      .update(rawBody)
      .digest("hex");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(header, "utf8");

  // 길이가 다르면 timingSafeEqual이 예외를 던지므로 먼저 거른다
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

router.post(
  "/github/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    if (!verifySignature(req.body, req.header("x-hub-signature-256"))) {
      res.status(401).send("invalid signature");
      return;
    }

    const event = req.header("x-github-event")!;
    const delivery = req.header("x-github-delivery")!;
    const payload = JSON.parse(req.body.toString("utf8"));

    res.status(202).send("ok");            // 먼저 받았다고 답하고
    void handle(event, delivery, payload); // 처리는 뒤에서
  },
);
```

비교에 `===`가 아니라 `crypto.timingSafeEqual`을 쓰는 이유는 타이밍 공격 때문입니다.
일반 문자열 비교는 다른 문자가 나오는 즉시 멈추기 때문에, 걸린 시간이 "앞에서 몇 글자가 맞았는지"를 흘립니다.

응답을 먼저 보내고 처리를 뒤로 넘기는 것도 의도된 구조입니다.
수신부가 Slack API 호출까지 기다리면 GitHub 쪽에서는 느린 엔드포인트가 되고, 타임아웃으로 전달 실패가 기록됩니다.

## 이벤트 해석

검증을 통과했으면 이제 무슨 일이 일어났는지 읽습니다.
이벤트 종류는 `X-GitHub-Event` 헤더에, 세부 동작은 본문의 `action` 필드에 들어 있습니다.

여기서 가장 먼저 할 일은 **관심 없는 것을 빨리 버리는 것**입니다.
구독을 넉넉히 켜두면 푸시, 체크런, 브랜치 생성까지 전부 들어옵니다. 이걸 다 뒤진 뒤에 버리면 로그와 비용만 늘어납니다.

```typescript
type Interest = { kind: "issue" | "pr" | "review"; number: number };

function interpret(event: string, payload: any): Interest | null {
  switch (event) {
    case "issues":
      if (!["opened", "closed", "reopened", "assigned"].includes(payload.action)) return null;
      return { kind: "issue", number: payload.issue.number };

    case "pull_request":
      if (!["opened", "closed", "ready_for_review"].includes(payload.action)) return null;
      return { kind: "pr", number: payload.pull_request.number };

    case "pull_request_review":
      if (payload.action !== "submitted") return null;
      // payload.review.state: approved | changes_requested | commented
      return { kind: "review", number: payload.pull_request.number };

    default:
      return null;
  }
}
```

`pull_request`의 `closed`는 한 번 더 봐야 합니다.
병합된 것과 그냥 닫힌 것이 같은 action으로 오고, 구분은 `payload.pull_request.merged` 불리언에 있습니다. 이걸 놓치면 머지된 PR이 "닫힘"으로만 표시됩니다.

중복 처리는 별개의 문제입니다. 요청마다 붙는 `X-GitHub-Delivery`를 키로 이미 본 것을 걸러냅니다.

```typescript
async function seenBefore(deliveryId: string): Promise<boolean> {
  // 짧은 TTL을 가진 저장소면 충분하다
  const first = await redis.set(`gh:delivery:${deliveryId}`, "1", { NX: true, EX: 86400 });
  return first === null;
}
```

다만 재전송이 언제나 같은 delivery ID로 온다고 가정하지는 마세요.
그래서 ID 기준 중복 제거 **위에 한 겹 더** 둡니다. "이미 그 상태면 아무것도 하지 않는다"를 반영 단계에서 지키면, 같은 이벤트가 몇 번 들어와도 결과가 같습니다.

## Slack에 반영하기

이제 본론입니다. 새 메시지를 쌓지 않고 **원본 메시지 하나를 계속 고쳐 쓰려면**, 그 메시지를 다시 찾을 수 있어야 합니다.

Slack에서 메시지를 가리키는 값은 `ts`(타임스탬프)입니다. 채널 ID와 `ts` 한 쌍이 메시지 하나를 특정합니다.
그러니 이슈를 처음 알릴 때 받은 `ts`를 이슈 번호에 붙여 저장해둡니다.

```typescript
import { App } from "@slack/bolt";

interface MessageRef { channel: string; ts: string }

// key 예시: "owner/repo#123"
async function ensureMessage(key: string, blocks: unknown[], fallback: string): Promise<MessageRef> {
  const existing = await store.get(key);

  if (existing) {
    await app.client.chat.update({
      channel: existing.channel,
      ts: existing.ts,
      text: fallback,
      blocks,
    });
    return existing;
  }

  const posted = await app.client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    text: fallback,
    blocks,
  });

  const ref = { channel: posted.channel as string, ts: posted.ts as string };
  await store.set(key, ref);
  return ref;
}
```

`text`를 항상 같이 넘기는 데는 이유가 있습니다.
`blocks`는 Slack 화면에서만 렌더되고, **푸시 알림과 알림 목록에 나오는 것은 `text`입니다.** 이걸 비워두면 모바일 알림에 아무 내용도 뜨지 않습니다.

상태 자체는 Block Kit으로 그립니다. 한 메시지 안에서 제목, 현재 상태, 담당자, 링크가 한눈에 보이게 두는 편이 읽기 좋습니다.

```typescript
function issueBlocks(i: {
  number: number; title: string; state: string; assignee?: string; url: string;
}) {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${i.url}|#${i.number} ${i.title}>*` },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `상태: *${i.state}*` },
        { type: "mrkdwn", text: `담당: ${i.assignee ?? "미지정"}` },
      ],
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "이슈 닫기" },
          action_id: "close_issue",
          value: String(i.number),
        },
      ],
    },
  ];
}
```

논의는 그 메시지의 스레드에 쌓이게 둡니다. 본문은 항상 현재 상태를 보여주고, 스레드에는 그동안의 대화가 남습니다.
채널 타임라인에는 이슈 하나당 줄 하나만 생기니, 채널이 로그로 변하지 않습니다.

{% comment %} TODO: 실제로 어떤 단위로 메시지를 묶었는지(이슈 단위 / PR 단위 / 스프린트 단위)와 채널 구성을 어떻게 나눴는지 적어주세요 {% endcomment %}

## 반대 방향 — Slack에서 GitHub으로

여기까지는 한 방향입니다. 실제로 편해지는 순간은 **Slack에서 바로 이슈를 움직일 수 있을 때** 옵니다.
논의가 끝났는데 이슈를 닫으러 브라우저를 여는 일이 사라지기 때문입니다.

Slack 쪽에는 지켜야 할 제약이 하나 있습니다.

> 슬래시 커맨드와 버튼 같은 상호작용 요청은 **3초 안에 응답을 돌려줘야 합니다.**
> 넘기면 사용자 화면에 타임아웃 오류가 뜹니다. GitHub API를 호출하고 나서 응답하면 아슬아슬하거나 이미 늦습니다.

그래서 순서를 뒤집습니다. 먼저 `ack()`로 받았다는 사실만 알리고, 실제 작업은 그 뒤에 이어서 합니다.

```typescript
app.command("/issue-close", async ({ command, ack, respond, logger }) => {
  await ack();  // 먼저 3초 제한을 벗어난다

  const number = Number(command.text.trim().replace(/^#/, ""));
  if (!Number.isInteger(number)) {
    await respond("이슈 번호를 숫자로 적어주세요. 예) /issue-close 123");
    return;
  }

  try {
    await octokit.rest.issues.update({
      owner: process.env.GH_OWNER!,
      repo: process.env.GH_REPO!,
      issue_number: number,
      state: "closed",
    });
    await respond(`#${number} 를 닫았습니다.`);
  } catch (error) {
    logger.error(error);
    await respond("닫지 못했습니다. 이슈 번호와 앱 권한을 확인해주세요.");
  }
});
```

버튼도 구조가 같습니다. Block Kit에 넣어둔 `action_id`로 받아서 `ack()`를 먼저 하고, 나머지를 처리합니다.

```typescript
app.action("close_issue", async ({ ack, action, logger }) => {
  await ack();
  // action.value 에 실어 보낸 이슈 번호로 위와 같은 처리를 한다
});
```

`ack()` 이후의 응답은 `respond()`나 `client.chat.update()`로 보냅니다.
`respond()`가 쓰는 `response_url`에는 유효 시간과 사용 횟수 제한이 있으니, 오래 걸리는 작업이라면 그 값을 공식 문서에서 확인하고 설계하세요.

그리고 이슈를 닫으면 GitHub이 다시 `issues` 이벤트를 보냅니다. 그러면 앞의 반영 경로가 돌아 원본 메시지가 갱신됩니다.
**닫는 코드에서 메시지를 직접 고칠 필요가 없습니다.** 상태 변경은 GitHub에만 하고 표시는 언제나 웹훅이 책임지게 두면, 경로가 하나로 유지됩니다.

## 운영하면서 손보게 되는 것들

올리고 나면 그다음부터가 진짜입니다. 대부분 아래 네 가지에서 걸립니다.

### 봇이 자기 이벤트에 반응하는 루프

가장 먼저, 가장 시끄럽게 터지는 문제입니다.
봇이 GitHub에 무언가를 쓰면 GitHub이 웹훅을 보내고, 그걸 받아 또 쓰면 끝없이 돕니다.

양쪽 다 막아둡니다. GitHub 쪽은 `payload.sender`가 봇이면 버리고, Slack 쪽은 이벤트에 `bot_id`가 붙어 있으면 무시합니다.

```typescript
if (payload.sender?.type === "Bot") return;
```

이 한 줄을 이벤트 해석의 **가장 앞**에 두세요. 뒤에 두면 이미 여러 갈래로 나뉜 뒤라 빠뜨린 경로가 생깁니다.

### 재시도와 멱등성

외부 API 호출은 실패합니다. 그래서 재시도를 넣게 되는데, 재시도는 같은 작업이 두 번 실행될 수 있다는 뜻입니다.

메시지 생성처럼 되돌리기 어려운 동작이 두 번 실행되면 중복 메시지가 남습니다.
앞의 `ensureMessage()`를 "있으면 고치고 없으면 만든다"로 짠 게 그래서입니다. 몇 번 실행해도 결과가 하나로 수렴하면 재시도를 마음 편히 넣을 수 있습니다.

### 비밀값 관리

이 연동 하나에 최소 네 개의 비밀값이 붙습니다. GitHub App 개인키, 웹훅 시크릿, Slack 봇 토큰, Slack 시그닝 시크릿입니다.

- 개인키는 재발급이 됩니다. 유출이 의심되면 새로 만들고 옛것을 지우는 게 정석입니다.
- 웹훅 시크릿을 바꿀 때는 GitHub 설정과 서버 환경변수를 같이 바꿔야 합니다. 한쪽만 바꾸면 모든 이벤트가 401로 떨어지는데, 증상이 "봇이 조용해짐"이라 알아채는 데 시간이 걸립니다.
- 로그에 페이로드를 통째로 찍지 않습니다. 토큰이나 개인 정보가 섞여 들어가는 경로가 생각보다 많습니다.

### 레이트 리밋

GitHub App 설치 토큰과 Slack Web API 모두 호출량 제한이 있습니다. 평소에는 닿을 일이 없지만, 대량 작업 한 번에 쉽게 넘깁니다.

- 라벨을 일괄 정리하거나 저장소를 옮기면 웹훅이 한꺼번에 쏟아집니다.
- 재전송을 손으로 여러 번 누르면 그만큼 곱해집니다.

대비는 두 가지면 충분합니다. 수신과 실제 처리 사이에 **큐를 하나 두어** 처리 속도를 우리가 정하고, 429가 오면 `Retry-After`를 보고 기다렸다 다시 보냅니다.
구체적인 한도와 계산 방식은 서비스마다 다르고 바뀌니 각 공식 문서에서 확인하세요.

{% comment %} TODO: 운영하면서 실제로 걸린 문제(루프, 레이트 리밋, 중복 등)와 하루 처리량 규모를 적어주세요 {% endcomment %}

## 정리

만들 때 순서대로 챙길 것들입니다.

- [ ] PAT가 아니라 GitHub App으로 인증하는가
- [ ] 웹훅 서명을 **원문 바이트로** 검증하는가
- [ ] 서명 비교에 타이밍 세이프 함수를 쓰는가
- [ ] 관심 없는 이벤트를 앞에서 버리는가
- [ ] 새 메시지를 쌓는 대신 `chat.update`로 상태를 유지하는가
- [ ] `blocks`와 함께 `text`를 채우는가
- [ ] Slack 상호작용에서 `ack()`를 먼저 호출하는가
- [ ] 봇 자신의 이벤트를 가장 앞에서 걸러내는가
- [ ] 같은 이벤트가 두 번 와도 결과가 같은가
