---
layout: post
title: "작업은 끝났는데 같은 메시지가 또 왔다 — 가시성 타임아웃과 DLQ"
date: 2026-10-06
tags: [backend, aws, sqs, architecture, typescript]
excerpt: "큐 소비자는 한 번 돌기 시작하면 잘 도는 것처럼 보입니다. 처리 시간이 가시성 타임아웃을 넘는 순간 같은 메시지가 두 번 처리되는 구조, 하트비트로 연장할 때 생기는 새 문제, maxReceiveCount와 DLQ가 없을 때 독성 메시지가 처리량을 먹는 경로, 배치 한 건의 실패가 아홉 건을 되돌리는 지점, 그리고 순서를 얻으려 FIFO로 갈 때 내주는 것까지."
---

큐를 붙이는 쪽은 대체로 쉽게 끝납니다. 메시지를 보내고, 받아서 처리하고, 지우면 됩니다.

문제는 그다음입니다. 어느 날 처리 완료 로그가 같은 작업 ID로 두 번 찍혀 있고, 로그만 두 번이 아니라 알림도 두 번 갔습니다.
코드는 안 바꿨고 예외도 안 났습니다.

큐 소비자에서 이런 일이 생기는 자리는 몇 개로 정해져 있습니다. 거의 전부 **"언제 메시지를 지우는가"**와 **"그 사이에 얼마나 걸리는가"** 사이의 간격에서 나옵니다.

## 메시지는 받는 순간 사라지지 않는다

SQS에서 `ReceiveMessage`는 메시지를 큐에서 꺼내는 게 아닙니다. 다른 소비자에게 **안 보이게 만들어 놓고** 사본을 건네줍니다.
지우는 건 별도 호출입니다.

```text
ReceiveMessage  ──▶  메시지가 "처리 중"(in-flight) 상태로 숨는다
                      │
                      │  가시성 타임아웃 동안
                      ▼
DeleteMessage   ──▶  큐에서 제거된다
```

이 둘을 쪼개 놓은 이유가 있습니다. 소비자가 메시지를 받고 처리 도중에 죽으면, 타임아웃이 지나면서 메시지가 다시 보이게 되고 다른 소비자가 집어갑니다.
**소비자가 죽어도 작업이 유실되지 않는다**는 보장은 여기서 나옵니다.

그 대가가 중복입니다. 메시지가 다시 보이는 조건은 "소비자가 죽었다"가 아니라 "타임아웃 안에 안 지웠다"뿐이니까요.
소비자가 멀쩡히 일하고 있어도 조건은 똑같이 성립합니다.

폴링 루프는 대략 이렇게 생깁니다.

```typescript
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

const sqs = new SQSClient({});

async function poll(queueUrl: string) {
  const res = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,   // 한 번에 받을 수 있는 최대치
      WaitTimeSeconds: 20,       // 롱 폴링 최대 대기
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    }),
  );

  for (const msg of res.Messages ?? []) {
    await handle(msg);
    await sqs.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: msg.ReceiptHandle!,
      }),
    );
  }
}
```

`WaitTimeSeconds`를 0으로 두면 짧은 폴링이 됩니다. 메시지가 없어도 즉시 응답이 오고, 빈 응답에도 요청 수는 올라갑니다.
큐가 비어 있는 시간이 긴 서비스라면 대기 시간을 최대로 올려두는 쪽이 요청 수와 지연 양쪽에 유리합니다.

> SDK v3의 `ReceiveMessageCommand`에서 시스템 속성을 요청하는 파라미터는 `MessageSystemAttributeNames`입니다. 예전 이름인 `AttributeNames`는 더 이상 권장되지 않으니, 오래된 예제를 옮겨 쓸 때 확인하세요.

## 처리 시간이 타임아웃을 넘는 순간

중복의 가장 흔한 원인은 장애가 아니라 **그냥 느려진 것**입니다.

가시성 타임아웃 기본값은 30초이고, 설정 범위는 0초에서 12시간입니다.
첨부 파일을 변환하거나 외부 API를 몇 번 호출하는 작업이 30초를 넘기는 건 드문 일이 아닙니다.

```text
t=0    소비자 A가 메시지를 받는다 (30초간 숨김)
t=30   아직 처리 중. 하지만 메시지가 다시 보이기 시작한다
t=31   소비자 B가 같은 메시지를 받는다  ← 여기서 두 번 처리
t=45   A가 처리를 끝내고 DeleteMessage 호출
t=60   B도 처리를 끝내고 DeleteMessage 호출 (이미 없는 메시지)
```

두 소비자 모두 예외 없이 성공합니다. 지우기도 성공합니다. 이미 지워진 메시지를 다시 지우는 건 SQS에서 오류가 아니기 때문입니다.
**어느 쪽 로그에도 "중복"이라고 적히지 않는다**는 게 이 버그의 성질입니다. 결과물을 보고 나서야 알게 됩니다.

고치는 방향은 두 가지입니다.

**타임아웃을 작업 최대 소요 시간보다 넉넉하게 잡는다.** 가장 단순하고, 보통 먼저 해야 하는 일입니다.
대가는 실패 감지가 늦어진다는 점입니다. 타임아웃을 10분으로 잡으면, 소비자가 즉시 죽은 메시지도 10분 뒤에야 다시 보입니다.
처리 중인 메시지는 in-flight 한도를 차지하므로, 긴 타임아웃과 높은 동시성이 겹치면 한도에 먼저 걸립니다.

**처리 중에 타임아웃을 연장한다.** 작업 시간의 분포가 넓어서 상한을 정하기 어려울 때 쓰는 방법입니다.

```typescript
import { ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";

async function withHeartbeat<T>(
  queueUrl: string,
  receiptHandle: string,
  work: () => Promise<T>,
  opts = { extendTo: 60, intervalMs: 20_000, maxExtensions: 30 },
): Promise<T> {
  let count = 0;

  const timer = setInterval(async () => {
    if (count++ >= opts.maxExtensions) return;   // 무한 연장 금지
    try {
      await sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: queueUrl,
          ReceiptHandle: receiptHandle,
          VisibilityTimeout: opts.extendTo,
        }),
      );
    } catch {
      // 이미 가시성이 만료되었거나 핸들이 무효해진 경우. 작업은 계속 두고
      // 중복 처리는 아래의 멱등성 장치로 막는다.
    }
  }, opts.intervalMs);

  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}
```

`ChangeMessageVisibility`로 지정하는 값은 **호출 시점부터** 다시 세는 시간입니다. 기존 값에 더해지는 게 아닙니다.
그래서 연장 주기는 설정하는 타임아웃보다 충분히 짧아야 합니다. 위 코드에서 60초로 연장하면서 20초마다 호출하는 이유입니다.

연장에는 상한이 있습니다. 최초 수신 시점부터 세어 12시간을 넘길 수 없습니다.

> 하트비트는 **작업이 멈춘 것도 같이 숨깁니다.** 외부 API 호출에서 영원히 블로킹된 소비자는 메시지를 계속 연장하면서 아무 일도 하지 않습니다.
> 그래서 연장 횟수에 상한을 두고, 상한에 닿으면 멈추고 메시지를 놓아주는 쪽이 낫습니다. 작업 자체에 타임아웃이 걸려 있어야 한다는 뜻이기도 합니다.

반대 방향도 쓸 수 있습니다. 처리할 수 없다고 판단되면 `VisibilityTimeout: 0`으로 호출해 **즉시 다시 보이게** 만들 수 있습니다.
하류가 잠시 죽어서 지금은 못 하는 작업이라면, 타임아웃이 다 지나기를 기다리는 대신 바로 반납하는 편이 빠릅니다.

## Lambda로 받을 때

이벤트 소스 매핑을 쓰면 폴링 루프와 `DeleteMessage`를 직접 쓰지 않습니다. 대신 타임아웃 계산이 조금 달라집니다.

AWS가 권장하는 값은 **함수 타임아웃의 6배에 배칭 윈도우를 더한 값**입니다.
6배인 이유는 함수 실행 시간만이 아니라 스로틀링으로 인한 재시도까지 같은 가시성 구간 안에서 일어나기 때문입니다.

```typescript
// AWS CDK
const queue = new sqs.Queue(this, "JobQueue", {
  visibilityTimeout: cdk.Duration.minutes(6),  // 함수 타임아웃 1분 × 6
});

fn.addEventSource(
  new SqsEventSource(queue, {
    batchSize: 10,
    maxBatchingWindow: cdk.Duration.seconds(0),
    reportBatchItemFailures: true,
  }),
);
```

함수 타임아웃이 가시성 타임아웃보다 길면 앞 절의 중복이 그대로 재현됩니다. 이 부등식은 배포할 때마다 깨질 수 있으니 코드로 고정해두는 편이 안전합니다.

배치 크기는 표준 큐에서 10보다 크게 잡을 수 있고, 그 경우 배칭 윈도우를 최소 1초 이상 지정해야 합니다. FIFO 큐는 10이 상한입니다.
배치를 키우면 호출 수는 줄지만 한 번의 실패가 되돌리는 범위도 같이 커집니다. 뒤에서 다룰 부분 실패 처리가 그때 필요해집니다.

## 죽지도 않고 성공하지도 않는 메시지

스키마가 안 맞는 메시지, 이미 삭제된 리소스를 가리키는 메시지, 코드 버그로 항상 같은 지점에서 터지는 메시지가 있습니다.
이런 메시지는 재시도해도 결과가 같습니다.

DLQ를 걸어두지 않으면 이 메시지는 **보존 기간이 끝날 때까지 계속 돌아옵니다.** 보존 기간 기본값은 4일이고 최대 14일까지 늘릴 수 있습니다.
4일 동안 30초마다 돌아오는 메시지 하나는 그 자체로는 부하가 아닙니다. 문제는 이게 혼자 오지 않는다는 점입니다.
배포 한 번으로 생긴 깨진 메시지 수천 건이 계속 순환하면서, 정상 메시지가 처리되기까지의 시간을 밀어냅니다.

```json
{
  "deadLetterTargetArn": "arn:aws:sqs:ap-northeast-2:<account-id>:job-queue-dlq",
  "maxReceiveCount": 5
}
```

`maxReceiveCount`는 **수신 횟수** 기준입니다. 실패 횟수가 아닙니다.
앞 절의 가시성 타임아웃 초과도 수신 횟수를 올리므로, 느린 작업에 이 값을 작게 잡아두면 성공할 수 있었던 메시지가 DLQ로 갑니다.

값을 정하는 감각은 이렇게 잡으면 대개 맞습니다.

- 일시적 실패(하류 타임아웃, 커넥션 리셋)를 넘기려면 최소 3회는 필요합니다.
- 결정적 실패를 빨리 격리하고 싶으면 작게. 크게 잡을수록 깨진 메시지가 오래 순환합니다.
- 소비자 쪽에서 이미 지수 백오프 재시도를 하고 있다면, 큐 수준 재시도까지 곱해지지 않는지 확인하세요. 안쪽에서 5번, 밖에서 5번이면 25번입니다.

현재 수신 횟수는 메시지 속성으로 읽을 수 있어서, 마지막 시도인지에 따라 다르게 동작시킬 수 있습니다.

```typescript
const receiveCount = Number(
  msg.Attributes?.ApproximateReceiveCount ?? "1",
);

if (receiveCount >= 5) {
  // 다음 실패면 DLQ로 간다. 조사에 필요한 맥락을 미리 남긴다
  logger.error({ messageId: msg.MessageId, receiveCount }, "last attempt");
}
```

> DLQ는 원본 큐와 **같은 종류**여야 합니다. FIFO 큐의 DLQ는 FIFO 큐로, 표준 큐의 DLQ는 표준 큐로 만들어야 합니다.
> 그리고 DLQ도 그냥 큐라서 보존 기간이 있습니다. 조사할 시간을 확보하려면 원본보다 길게 잡아두세요. 여기서 기본값을 그대로 두면, 조사하려고 열었을 때 증거가 이미 지워져 있습니다.

## 배치 한 건이 아홉 건을 되돌린다

열 건을 받아서 세 번째에서 예외가 나면, 앞의 두 건은 이미 처리가 끝난 상태입니다.
배치 전체를 실패로 돌리면 그 두 건은 다시 처리됩니다.

직접 폴링하는 코드라면 성공한 것만 골라 지우면 됩니다.

```typescript
import { DeleteMessageBatchCommand } from "@aws-sdk/client-sqs";

const succeeded: string[] = [];

for (const msg of res.Messages ?? []) {
  try {
    await handle(msg);
    succeeded.push(msg.MessageId!);
  } catch (err) {
    logger.warn({ messageId: msg.MessageId, err }, "handler failed");
    // 지우지 않는다 → 타임아웃 후 다시 보인다
  }
}

if (succeeded.length > 0) {
  await sqs.send(
    new DeleteMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: (res.Messages ?? [])
        .filter((m) => succeeded.includes(m.MessageId!))
        .map((m) => ({ Id: m.MessageId!, ReceiptHandle: m.ReceiptHandle! })),
    }),
  );
}
```

여기서 놓치기 쉬운 게 `DeleteMessageBatch`의 응답입니다. 이 API는 **일부만 실패할 수 있고**, 그래도 HTTP 레벨에서는 성공으로 옵니다.
응답의 `Failed` 배열을 보지 않으면 "지웠다고 생각했지만 안 지워진" 메시지가 조용히 다시 돌아옵니다.

Lambda라면 실패한 메시지의 ID만 반환합니다.

```typescript
export const handler = async (event: SQSEvent) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      await handle(record);
    } catch {
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
```

이게 동작하려면 이벤트 소스 매핑에서 `ReportBatchItemFailures`를 켜 두어야 합니다. 안 켜두면 반환값은 무시되고, 예외가 없었으니 배치 전체가 성공으로 처리됩니다.
**실패한 메시지가 조용히 사라지는 쪽**이라 더 위험한 설정 실수입니다.

반대로 켜둔 상태에서 응답 형식이 틀리면 배치 전체가 재시도됩니다. 함수가 예외를 던져도 같습니다.
그래서 핸들러 안에서 건별로 잡아 목록에 담는 형태를 벗어나지 않는 게 좋습니다.

FIFO 큐는 동작이 다릅니다. 한 건이 실패하면 같은 메시지 그룹의 뒤쪽은 더 처리하지 않고 실패로 돌려줍니다.
순서를 보장하려면 그래야 하니까요. 구체적인 처리 순서는 서비스 문서를 확인하세요.

## 중복은 막는 게 아니라 흡수한다

여기까지 맞춰도 표준 큐는 **최소 한 번(at-least-once)** 전달입니다. 중복을 0으로 만드는 설정은 없습니다.
타임아웃을 늘려도, 하트비트를 걸어도, 네트워크가 `DeleteMessage` 응답을 한 번 잃어버리면 같은 일이 일어납니다.

그래서 소비자가 같은 메시지를 두 번 받아도 결과가 한 번과 같아야 합니다. 처리 기록을 유니크 제약으로 남기는 게 가장 확실합니다.

```sql
CREATE TABLE processed_messages (
  dedup_key   VARCHAR(191) NOT NULL,
  processed_at DATETIME     NOT NULL,
  PRIMARY KEY (dedup_key)
);
```

```typescript
async function handleOnce(dedupKey: string, work: () => Promise<void>) {
  try {
    await db.query(
      "INSERT INTO processed_messages (dedup_key, processed_at) VALUES (?, NOW())",
      [dedupKey],
    );
  } catch (err) {
    if (isDuplicateKey(err)) return;   // 이미 처리됨
    throw err;
  }
  await work();
}
```

이 코드에는 구멍이 있습니다. 기록을 먼저 넣고 작업 중에 프로세스가 죽으면, 재시도가 "이미 처리됨"으로 건너뜁니다.
작업과 기록이 **같은 트랜잭션**에 들어갈 수 있다면 그렇게 하는 게 가장 깔끔합니다. 작업이 외부 호출이라 트랜잭션에 못 묶이면, 기록에 상태 컬럼을 두고 `시작 → 완료`로 나눠 적은 뒤 "시작했지만 완료되지 않은" 건을 다시 시도하게 만들어야 합니다.

더 중요한 건 **무엇을 중복 제거 키로 쓰는가**입니다. `MessageId`는 적절하지 않습니다.
재전달된 메시지는 같은 ID를 갖지만, 생산자가 같은 작업을 두 번 보내면 ID가 다릅니다. ID로 거르면 전자만 막고 후자는 통과합니다.
막아야 할 쪽은 "같은 작업이 두 번 실행되는 것"이니, 키는 **작업을 식별하는 값**이어야 합니다. 주문 ID와 작업 종류의 조합 같은 것입니다.

{% comment %} TODO: 실제로 큐 소비자에서 중복 처리 문제를 겪은 적이 있다면 어떤 작업이었는지, 중복 제거 키를 무엇으로 잡았는지, 가시성 타임아웃을 얼마로 조정했는지 적어주세요 {% endcomment %}

## 순서가 필요하면, 그 대가

표준 큐는 순서를 보장하지 않습니다. "최선 노력"이라, 대체로 들어온 순서로 나오지만 어긋나는 경우가 있습니다.

FIFO 큐는 순서를 보장하는데, 범위가 큐 전체가 아니라 **메시지 그룹 단위**입니다.
생산자가 `MessageGroupId`를 지정하고, 같은 그룹 안에서만 순서가 지켜집니다.

```typescript
await sqs.send(
  new SendMessageCommand({
    QueueUrl: fifoQueueUrl,
    MessageBody: JSON.stringify(payload),
    MessageGroupId: `tenant-${tenantId}`,       // 이 단위로 순서 보장
    MessageDeduplicationId: `${jobType}:${jobId}`,
  }),
);
```

그룹 선택이 그대로 병렬성의 상한이 됩니다. 그룹을 하나만 쓰면 소비자를 몇 대로 늘려도 한 번에 한 건씩 처리됩니다.
반대로 그룹을 너무 세분하면 순서 보장이 필요했던 범위를 벗어납니다. 테넌트별, 집계 대상별처럼 **순서가 실제로 의미 있는 경계**로 잡는 게 맞습니다.

그리고 한 건이 막히면 같은 그룹의 뒤쪽이 전부 막힙니다. 순서 보장의 정의상 당연한데, 운영에서는 이게 "큐가 쌓이는데 다른 그룹은 멀쩡하다"는 모양으로 나타나서 원인을 찾기 어렵습니다.

`MessageDeduplicationId`를 지정하면 SQS가 5분 동안 같은 ID의 메시지를 받아들이되 전달하지 않습니다. 이 간격은 고정값입니다.
생산자 쪽 재시도로 생기는 중복에는 유용하지만, **5분을 넘어선 재전송은 걸러지지 않습니다.** 소비자 멱등성을 대체하지는 못한다는 뜻입니다.

> FIFO 큐에는 처리량 상한이 있고, 그룹 단위로 병렬 처리하는 고처리량 모드가 별도로 있습니다. 현재 상한 값과 모드 설정은 서비스 문서와 콘솔에서 확인하세요.

## 무엇을 보고 알 수 있나

큐 소비자의 문제는 에러율로 잘 안 드러납니다. 중복은 성공으로 찍히고, 밀림은 지연으로만 보입니다.

- `ApproximateAgeOfOldestMessage` — 가장 유용한 하나입니다. 큐 길이는 처리량이 받쳐주면 길어도 괜찮지만, 가장 오래된 메시지의 나이가 계속 오르면 소비가 생산을 못 따라가고 있다는 뜻입니다. 알람은 길이보다 이쪽에 거는 게 정확합니다.
- `ApproximateNumberOfMessagesNotVisible` — 처리 중인 메시지 수입니다. 이게 비정상적으로 높고 줄지 않으면 가시성 타임아웃이 길게 잡힌 채 작업이 멈춰 있는 상태를 의심합니다.
- `NumberOfMessagesReceived`와 `NumberOfMessagesDeleted`의 비율 — 수신이 삭제보다 꾸준히 많으면 재전달이 일어나고 있습니다. 중복 처리를 간접적으로 재는 방법입니다.
- DLQ의 메시지 수 — **0보다 크면 알람**으로 두는 게 맞습니다. DLQ는 평소에 비어 있어야 하는 큐이고, 쌓이고 있다는 걸 나중에 알게 되면 보존 기간이 먼저 지나갑니다.

DLQ에 쌓인 메시지를 고친 뒤 되돌리는 경로도 미리 정해두세요. SQS는 DLQ에서 원본 큐로 메시지를 옮기는 재구동(redrive) 기능을 제공합니다.
다만 되돌리기 전에 원인이 고쳐져 있어야 합니다. 안 고친 상태로 재구동하면 같은 메시지가 다시 DLQ로 오고, 수신 횟수만 올라갑니다.

## 정리

- `ReceiveMessage`는 메시지를 지우지 않습니다. 삭제는 별도 호출이고, 그 사이 간격이 중복의 원인입니다.
- 중복의 가장 흔한 원인은 소비자 장애가 아니라 처리 시간이 가시성 타임아웃을 넘긴 것입니다. 양쪽 로그 모두 성공으로 찍혀서 늦게 발견됩니다.
- 가시성 타임아웃 기본값은 30초, 설정 범위는 0초에서 12시간입니다. 작업 시간 분포가 넓으면 하트비트로 연장하되 연장 횟수에 상한을 두세요.
- Lambda로 받으면 가시성 타임아웃을 함수 타임아웃의 6배 + 배칭 윈도우로 잡는 게 권장값입니다. 이 부등식은 코드로 고정해두세요.
- DLQ가 없으면 결정적으로 실패하는 메시지가 보존 기간(기본 4일) 동안 순환하면서 정상 메시지의 처리를 밀어냅니다.
- `maxReceiveCount`는 수신 횟수 기준이라, 타임아웃 초과도 횟수를 올립니다. 소비자 내부 재시도와 곱해지지 않는지 확인하세요.
- `ReportBatchItemFailures`를 안 켜고 실패 목록만 반환하면 실패한 메시지가 조용히 삭제됩니다. 켠 상태에서 예외를 던지면 배치 전체가 재시도됩니다.
- 표준 큐는 최소 한 번 전달입니다. 중복 제거 키는 `MessageId`가 아니라 작업을 식별하는 값으로 잡고, 처리 기록을 유니크 제약으로 남기세요.
- FIFO의 순서 보장 범위는 메시지 그룹이고, 그 선택이 병렬성의 상한이 됩니다. 5분 중복 제거 창은 소비자 멱등성을 대체하지 않습니다.
- 알람은 큐 길이보다 `ApproximateAgeOfOldestMessage`에, 그리고 DLQ가 비어 있지 않은 상태에 거세요.
