---
layout: post
title: "메일은 보냈다고 나오는데 받은 사람이 없다 — 발신 인증과 반송 처리"
date: 2026-11-03
tags: [backend, aws, ses, email, typescript]
excerpt: "발송 API가 성공을 돌려줬는데 수신자에게 도달하지 않는 문제. SPF가 검사하는 도메인이 From이 아니라는 점, DMARC 정렬이 깨지는 자리, 반송·불만 이벤트를 애플리케이션에서 받아 억제 목록으로 만드는 구조까지."
---

비밀번호 재설정 메일이 안 온다는 문의가 들어옵니다.
발송 로그에는 성공으로 찍혀 있고 메시지 ID까지 남아 있습니다. 스팸함에도 없습니다.

발송 API가 돌려준 200은 "보냈다"가 아니라 **"접수했다"**입니다.
그 뒤에 일어나는 일은 애플리케이션이 모르고, 모르는 채로도 몇 달은 아무 문제 없이 돌아갑니다.

## 성공은 어디까지의 성공인가

메일 전송은 두 단계로 나뉩니다. 내가 발송 서비스에 **제출**하는 단계, 발송 서비스가 수신 측 메일 서버에 **전달**하는 단계입니다.

```text
애플리케이션 ──제출──▶ 발송 서비스 ──전달──▶ 수신 메일 서버 ──▶ 받은 편지함
     (여기서 messageId를 받는다)        (여기서 거부/지연/스팸 분류가 일어난다)
```

API 응답은 첫 번째 단계의 결과입니다. 수신 측이 거부했는지, 스팸으로 분류했는지, 받은 편지함에 들어갔는지는 그 응답에 들어 있지 않습니다.

그래서 "메일이 갔는가"는 애플리케이션 DB로 답할 수 없는 질문입니다.
두 번째 단계의 결과는 **비동기 이벤트로만** 돌아옵니다. 그 이벤트를 받지 않고 있으면, 전달 실패는 영원히 사용자 문의로만 알게 됩니다.

여기서 실패는 크게 두 종류입니다. 수신 서버가 **거부**하는 경우(반송)와, 받아들인 다음 **스팸으로 치우는** 경우입니다.
두 번째는 반송 이벤트조차 남지 않습니다. 발신 인증을 먼저 보는 이유가 여기 있습니다.

## From 헤더는 아무나 쓸 수 있다

SMTP에는 도메인 소유를 증명하는 장치가 원래 없습니다. `From: noreply@example.com`은 그냥 쓰면 써집니다.
그래서 수신 서버는 **별도의 세 장치**로 발신자를 검증합니다.

먼저 알아야 할 건 메일에 도메인이 **두 군데** 있다는 사실입니다.

```text
MAIL FROM: <bounce@mail.example.com>      ← 엔벌로프. 반송이 돌아갈 주소(Return-Path)
From: 킨더보드 <noreply@example.com>       ← 헤더. 사용자가 화면에서 보는 주소
```

사용자는 아래만 보고, **SPF는 위만 검사합니다.** 이 어긋남이 뒤에 나오는 거의 모든 혼란의 출처입니다.

| | 검사 대상 | 전달(forwarding) 후 | DMARC 정렬 |
| --- | --- | --- | --- |
| SPF | 엔벌로프 도메인 + 보내는 IP | 대개 깨진다 | 엔벌로프 도메인이 `From`과 맞아야 |
| DKIM | 본문·헤더 서명과 `d=` 도메인 | 본문이 변형되지 않으면 살아남는다 | `d=`가 `From`과 맞아야 |
| DMARC | 위 둘의 결과 + 정렬 | — | — |

SPF는 DNS에 "이 도메인의 메일은 이 IP들에서만 나간다"를 적어두는 것입니다.

```text
example.com.  IN TXT  "v=spf1 include:amazonses.com ~all"
```

DKIM은 발신 측이 개인키로 헤더를 서명하고, 공개키를 DNS에 올려두는 방식입니다.
발송 서비스가 CNAME 레코드를 주고 키 관리를 대신 하는 구성(SES의 Easy DKIM 같은)이 운영 부담이 가장 적습니다. 직접 키를 들고 있으면 회전 책임도 같이 집니다.

DMARC는 앞의 두 결과를 받아 "그래서 이 메일을 어떻게 할 것인가"를 정하는 정책입니다.

```text
_dmarc.example.com.  IN TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; adkim=r; aspf=r"
```

## DMARC가 요구하는 건 통과가 아니라 정렬

여기가 가장 많이 걸리는 지점입니다. **SPF가 pass인데 DMARC가 fail**인 상황이 흔하게 생깁니다.

DMARC는 SPF나 DKIM이 통과하는 것만으로는 만족하지 않습니다. 통과한 도메인이 사용자가 보는 `From` 도메인과 **정렬**되어야 합니다.

발송 서비스를 붙이면 기본 엔벌로프 도메인은 그 서비스가 소유한 도메인입니다.
SPF는 그 도메인 기준으로 멀쩡히 통과하지만, `From`은 내 도메인이니 정렬이 깨집니다. 결과적으로 **DMARC는 DKIM 하나에만 의지**하게 됩니다.

SPF 쪽도 살리려면 엔벌로프 도메인을 내 서브도메인으로 바꿉니다. 발송 서비스가 요구하는 MX와 TXT 레코드를 그 서브도메인에 올리는 설정입니다.
`mail.example.com`과 `example.com`은 조직 도메인이 같으므로 기본값인 완화(relaxed) 정렬에서는 맞는 것으로 봅니다.

> `aspf=s`나 `adkim=s`로 엄격 정렬을 켜면 서브도메인 발송이 전부 실패합니다.
> 발송 경로를 전부 파악하기 전에는 완화 정렬(기본값)을 두는 편이 안전합니다.

경로를 둘 다 세워두는 이유는 중복 때문입니다. 메일이 전달(forwarding)되면 엔벌로프 발신자가 바뀌어 **SPF가 깨집니다.**
반대로 메일링 리스트가 제목이나 본문에 꼬리말을 붙이면 **DKIM 서명이 깨집니다.** 하나만 세워두면 그 경로에서 DMARC가 통째로 실패합니다.

정책은 단계적으로 올립니다.

- `p=none` — 아무것도 하지 않고 리포트만 받습니다. 여기서 내가 모르던 발송원을 찾습니다.
- `p=quarantine` — 실패한 메일을 스팸함으로 보냅니다.
- `p=reject` — 실패한 메일을 거부합니다.

처음부터 `p=reject`를 박으면, 잊고 있던 발송 경로가 조용히 전부 죽습니다.
결제 대행사의 영수증 메일, 마케팅 도구, 사내 그룹웨어, 예전에 만든 배치 스크립트 — 이 중 하나는 내 도메인으로 메일을 보내고 있을 가능성이 높습니다.

`rua`로 받는 집계 리포트가 그 목록을 알려줍니다. 며칠 받아보고 정렬 실패하는 발송원이 없어진 뒤에 정책을 올리는 순서입니다.

{% comment %} TODO: 실제로 DMARC 리포트에서 예상하지 못한 발송원을 발견한 경험이 있다면 이 자리에 사례로 적어주세요 {% endcomment %}

## 설정이 맞았는지 확인하는 법

세 가지를 봅니다. DNS에 뭐가 올라가 있는지, 수신 측이 어떻게 판정했는지, SPF 레코드 자체가 유효한지입니다.

```bash
dig +short TXT example.com                              # SPF
dig +short TXT _dmarc.example.com                       # DMARC
dig +short CNAME <selector>._domainkey.example.com      # DKIM (위임형)
dig +short TXT mail.example.com                         # 커스텀 엔벌로프 도메인의 SPF
dig +short MX  mail.example.com
```

그다음 실제로 메일을 받아 원본 헤더를 봅니다. 수신 서버가 판정 결과를 헤더에 적어줍니다.

```text
Authentication-Results: mx.example.net;
       dkim=pass header.d=example.com;
       spf=pass (domain of bounce@mail.example.com designates ... as permitted sender)
              smtp.mailfrom=mail.example.com;
       dmarc=pass (p=NONE) header.from=example.com
```

`spf=pass` 옆의 `smtp.mailfrom`과 `dmarc=...` 옆의 `header.from`을 **비교해서 보는 게 요점**입니다.
두 도메인이 조직 도메인 단위로 맞지 않으면, SPF는 pass여도 DMARC 입장에서는 쓸 수 없는 pass입니다.

SPF 레코드에는 조용히 깨지는 함정이 둘 있습니다.

**레코드가 두 개면 전체가 무효입니다.** 발송 서비스를 추가하면서 `v=spf1`로 시작하는 TXT를 하나 더 올리면, 기존 것과 합쳐지지 않고 permerror가 됩니다. 기존 레코드 안에 `include`를 추가해야 합니다.

**DNS 조회 횟수에 상한이 있습니다.** `include`, `a`, `mx` 같은 메커니즘은 조회를 유발하고, 그 총합이 10회를 넘으면 역시 permerror입니다.
발송 서비스를 셋 넷 붙이다 보면 넘깁니다. 넘긴 순간 SPF는 pass가 아니라 **평가 불가**가 되고, DKIM만 남습니다.

DKIM 쪽에서 자주 보는 실패는 키 길이 문제입니다.
2048비트 공개키는 TXT 레코드의 문자열 하나가 가질 수 있는 길이(255바이트)를 넘어서, 여러 문자열로 쪼개 넣어야 합니다.
DNS 제공자가 이걸 알아서 처리하지 않으면 레코드가 잘린 상태로 올라가고, 서명 검증만 실패합니다. 조회해서 눈으로 확인하는 편이 빠릅니다.

## 반송은 애플리케이션 이벤트다

인증이 맞아도 주소가 틀렸거나 메일함이 꽉 찬 수신자는 있습니다. 그 결과가 반송(bounce)과 불만(complaint) 이벤트로 돌아옵니다.

이걸 받지 않으면 두 가지가 벌어집니다. 사용자는 계속 메일을 못 받고, 존재하지 않는 주소로 반복 발송하는 발신자로 평판이 쌓입니다.
평판이 떨어지면 **멀쩡한 주소로 가는 메일까지 스팸으로 분류**됩니다. 여기서부터는 코드를 고쳐도 당장 돌아오지 않습니다.

반송은 두 종류를 구분해야 합니다.

| | SMTP 응답 | 의미 | 처리 |
| --- | --- | --- | --- |
| 영구(permanent) | `5.x.x` | 주소가 없거나 도메인이 없다 | 즉시 차단. 재시도 금지 |
| 일시(transient) | `4.x.x` | 메일함 꽉 찼거나 일시 거부 | 백오프 재시도, 반복되면 차단 |
| 불만(complaint) | — | 수신자가 스팸으로 신고 | 즉시 차단. 가장 비싼 신호 |

영구 반송에 재시도를 거는 건 아무 이득이 없으면서 평판만 깎는 동작입니다.

이벤트는 알림 주제(SNS)나 이벤트 버스로 받습니다. HTTPS 엔드포인트로 받는다면 서명 검증과 중복 처리가 필수입니다.
적어도 한 번(at-least-once) 전달이라 같은 이벤트가 두 번 올 수 있고, 엔드포인트는 외부에 열려 있습니다([웹훅 수신기가 조용히 흘리는 것들](/blog/webhook-receiver-signature-replay-ordering/)).

```sql
CREATE TABLE email_suppressions (
  email        VARCHAR(320) NOT NULL,
  reason       ENUM('permanent_bounce','complaint','transient_repeat','manual') NOT NULL,
  detail       VARCHAR(255) NULL,          -- 진단 코드 등
  suppressed_at DATETIME     NOT NULL,
  released_at   DATETIME     NULL,         -- 해제되면 채운다
  PRIMARY KEY (email)
);

-- 이벤트 멱등 처리용. 같은 메시지의 같은 이벤트는 한 번만.
CREATE TABLE email_events (
  message_id   VARCHAR(255) NOT NULL,
  event_type   VARCHAR(32)  NOT NULL,
  recipient    VARCHAR(320) NOT NULL,
  payload      JSON         NOT NULL,
  received_at  DATETIME     NOT NULL,
  PRIMARY KEY (message_id, event_type, recipient)
);
```

기본키를 `(message_id, event_type, recipient)`로 잡은 게 멱등 장치입니다.
한 발송에 수신자가 여럿일 수 있고, 같은 메시지에 `Delivery`와 `Complaint`가 **둘 다** 올 수 있습니다. 전달된 다음 사용자가 신고하면 그렇게 됩니다.

핸들러는 이렇게 됩니다.

```typescript
type SesEvent = {
  eventType: string;                       // 'Bounce' | 'Complaint' | 'Delivery' | ...
  mail: { messageId: string; destination: string[] };
  bounce?: {
    bounceType: 'Permanent' | 'Transient' | 'Undetermined';
    bounceSubType: string;
    bouncedRecipients: Array<{ emailAddress: string; diagnosticCode?: string }>;
  };
  complaint?: {
    complainedRecipients: Array<{ emailAddress: string }>;
    complaintFeedbackType?: string;
  };
};

export async function handleEvent(ev: SesEvent) {
  const targets =
    ev.bounce?.bouncedRecipients.map((r) => ({ email: r.emailAddress, detail: r.diagnosticCode })) ??
    ev.complaint?.complainedRecipients.map((r) => ({ email: r.emailAddress, detail: undefined })) ??
    ev.mail.destination.map((email) => ({ email, detail: undefined }));

  for (const t of targets) {
    const inserted = await recordEventOnce(ev.mail.messageId, ev.eventType, t.email, ev);
    if (!inserted) continue;                       // 이미 처리한 이벤트

    if (ev.eventType === 'Complaint') {
      await suppress(t.email, 'complaint', t.detail);
    } else if (ev.eventType === 'Bounce') {
      if (ev.bounce?.bounceType === 'Permanent') {
        await suppress(t.email, 'permanent_bounce', t.detail);
      } else {
        await countTransient(t.email);              // 임계치 넘으면 suppress
      }
    }
  }
}
```

`Undetermined`를 영구로 취급하지 않는 게 중요합니다. 판정이 불확실하다는 뜻이라, 여기서 바로 차단하면 멀쩡한 주소가 차단됩니다.

> 이벤트 페이로드의 최상위 식별자 필드는 설정 경로에 따라 이름이 다를 수 있습니다(설정 세트 이벤트 발행과 아이덴티티 알림).
> 타입을 손으로 쓰기 전에 실제 페이로드를 한 번 찍어서 확인하고, 필드 목록은 공식 문서를 보세요.

## 억제 목록을 내 DB에도 두는 이유

발송 서비스 대부분이 계정 수준 억제 목록을 들고 있습니다. 그럼 왜 같은 걸 또 만드는가.

**발송 전에 끊을 수 있습니다.** 서비스 쪽 억제는 제출을 받고 나서 버립니다. 내 쪽에 있으면 호출 자체를 안 합니다.

**사용자에게 보여줄 수 있습니다.** "이 주소로 메일이 반송되고 있습니다"를 화면에 띄우려면 그 사실을 내 DB에서 조회할 수 있어야 합니다.
이게 없으면 사용자는 자기 주소에 오타가 있다는 걸 알 방법이 없습니다.

**발송 서비스를 바꿀 때 가져갑니다.** 억제 목록은 수년간 쌓인 자산이고, 새 서비스로 옮기면서 버리면 처음부터 다시 평판을 깎습니다.

```typescript
export async function sendTransactional(to: string, template: Template) {
  const blocked = await findActiveSuppression(to);
  if (blocked) {
    // 조용히 버리지 않는다. 왜 안 보냈는지 남아야 문의에 답할 수 있다.
    log().warn({ to_hash: hash(to), reason: blocked.reason }, 'suppressed, not sending');
    return { sent: false, reason: blocked.reason };
  }
  return doSend(to, template);
}
```

수신자 주소를 로그에 평문으로 남기지 않는 쪽이 좋습니다. 로그는 DB보다 보는 사람이 많습니다([구조화 로깅과 상관관계 ID](/blog/structured-logging-correlation-id/)).

차단에는 **해제 경로**가 반드시 같이 있어야 합니다. 이게 없으면 오타 한 번이 계정 영구 잠금이 됩니다.

- 사용자가 주소를 **변경**하면 새 주소는 당연히 깨끗한 상태로 시작합니다.
- 같은 주소를 다시 쓰겠다고 하면, 확인 메일 한 통을 보내 **클릭을 받은 뒤에** 해제합니다.
- 불만(스팸 신고)으로 차단된 주소는 사용자의 명시적 재구독 없이 해제하지 않습니다. 신고를 무시하는 발신자가 되는 가장 빠른 길입니다.

여기에 트레이드오프가 하나 있습니다. 해제를 쉽게 만들면 "메일 안 와요" 문의가 줄지만, 반송 주소로 재발송하는 비율이 올라갑니다.
확인 클릭을 요구하는 절충이 대개 맞습니다. 사람이 한 번 개입하므로 자동 재발송 루프가 생기지 않습니다.

## 트랜잭션 메일과 마케팅 메일을 섞지 않는다

평판은 발신 도메인과 IP 단위로 쌓입니다. 그래서 둘을 같은 도메인으로 보내면 **뉴스레터의 스팸 신고가 비밀번호 재설정 메일을 막습니다.**

메일 성격이 다르기 때문입니다. 마케팅 메일은 신고율이 구조적으로 높고, 트랜잭션 메일은 반드시 도착해야 합니다.

분리는 서브도메인으로 합니다.

```text
noreply@tx.example.com       ← 인증, 영수증, 알림. 반드시 도착해야 하는 것
news@marketing.example.com   ← 발송 거부 가능한 것
```

발송 서비스의 구성 세트(또는 그에 해당하는 단위)도 나눠서 이벤트와 억제 목록을 따로 관리합니다.
그러면 마케팅 쪽에서 신고가 몰려도 트랜잭션 쪽 억제 목록과 평판이 영향을 받지 않습니다.

대신 운영할 DNS 레코드와 모니터링 대상이 두 배가 됩니다. 그리고 새 서브도메인은 평판이 **아무것도 없는 상태**로 시작하므로, 처음 며칠은 발송량을 서서히 늘리는 편이 안전합니다.

전용 IP와 공용 IP도 같은 성격의 선택입니다.

| | 공용 IP | 전용 IP |
| --- | --- | --- |
| 초기 평판 | 다른 발신자들의 평판에 얹힌다 | 없음. 직접 쌓아야 한다 |
| 발송량 | 적어도 괜찮다 | 꾸준히 보내야 유지된다 |
| 남의 영향 | 받는다 | 받지 않는다 |

발송량이 적으면 공용이 유리합니다. 전용 IP는 꾸준한 발송량이 뒷받침되지 않으면 오히려 평판이 안 쌓입니다.

> 발송 한도, 평판 지표의 허용 범위, IP 워밍업 권장 절차는 서비스마다 다르고 바뀝니다. 수치는 해당 서비스의 공식 문서에서 확인하세요.

## 수신 거부는 본문 링크가 아니라 헤더로

주요 메일 사업자들은 대량 발송자에게 인증 설정과 **원클릭 수신 거부**를 요구합니다. 본문의 "수신거부" 링크로는 충족되지 않습니다.
헤더 두 줄이 그 규격(RFC 8058)입니다.

```typescript
const token = signUnsubToken({ email: to, listId: 'newsletter' });

const headers = {
  'List-Unsubscribe': `<https://example.com/unsub?t=${token}>, <mailto:unsub@example.com?subject=${token}>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
};
```

`List-Unsubscribe-Post`를 넣었다면 그 URL은 **로그인 없이 POST만으로** 수신 거부가 완료되어야 합니다. 확인 화면을 띄우면 규격 위반입니다.

로그인이 없으니 토큰이 유일한 인증 수단입니다. 서명과 범위를 담아둡니다.

```typescript
import { createHmac, timingSafeEqual } from 'node:crypto';

type UnsubClaim = { email: string; listId: string };

const sign = (c: UnsubClaim) => {
  const body = Buffer.from(JSON.stringify(c)).toString('base64url');
  const mac = createHmac('sha256', process.env.UNSUB_SECRET!).update(body).digest('base64url');
  return `${body}.${mac}`;
};

const verify = (token: string): UnsubClaim | null => {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', process.env.UNSUB_SECRET!).update(body).digest('base64url');
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return JSON.parse(Buffer.from(body, 'base64url').toString()) as UnsubClaim;
};
```

`listId`를 claim에 넣은 이유가 있습니다. 뉴스레터 수신 거부가 **비밀번호 재설정 메일까지 끊으면 안 됩니다.**
수신 거부는 목록 단위고, 반송·불만 차단은 주소 단위입니다. 두 개를 같은 테이블에 섞으면 구분이 사라집니다.

그리고 **GET으로는 수신 거부를 처리하지 않습니다.** 메일 클라이언트와 보안 장비가 본문의 링크를 미리 긁어가는 경우가 있어서, GET으로 상태를 바꾸면 사용자가 누르지 않아도 해지됩니다.

## 발송은 요청 경로에서 떼어낸다

마지막으로 구조 하나. 회원가입 핸들러 안에서 메일 발송을 `await`하면 문제가 셋 생깁니다.

발송 서비스가 느릴 때 **가입 API가 같이 느려집니다.** 발송이 실패하면 가입까지 실패로 돌려주게 됩니다.
그리고 발송 속도 한도에 걸렸을 때 재시도할 자리가 없습니다.

큐를 하나 두고 넘깁니다. 수신자별 메시지로 나눠 넣으면 부분 실패가 격리되고, 재시도도 그 단위로 됩니다([가시성 타임아웃과 DLQ](/blog/sqs-consumer-visibility-timeout-dlq/)).

그때 중복 발송을 막는 건 큐가 아니라 **발송 측 멱등키**입니다. 같은 이벤트로 두 번 깨어나도 메일은 한 통이어야 합니다([멱등키 설계](/blog/idempotency-key-payment-api/)).

```typescript
// (user_id, template, dedupe_window) 로 유니크 제약을 걸어 한 번만 보낸다
const key = `welcome:${userId}`;
if (!(await claimSendOnce(key))) return;
await enqueueEmail({ to, template: 'welcome', key });
```

{% comment %} TODO: 실제로 운영에서 반송·불만 처리를 붙인 뒤 달라진 점이나 겪은 문제가 있다면 이 자리에 적어주세요 {% endcomment %}

## 정리

- 발송 API의 성공은 **접수 성공**이다. 전달 결과는 비동기 이벤트로만 오고, 받지 않으면 사용자 문의로 알게 된다.
- SPF는 `From`이 아니라 **엔벌로프 도메인**을 본다. DMARC는 통과가 아니라 **`From`과의 정렬**을 요구한다.
- 발송 서비스 기본 설정에서는 SPF가 정렬되지 않아 DKIM 하나에 의지하게 된다. 커스텀 엔벌로프 도메인으로 경로를 둘 다 세운다.
- SPF는 레코드가 두 개거나 DNS 조회가 10회를 넘으면 **pass가 아니라 평가 불가**가 된다. `dig`로 확인한다.
- `p=none`으로 리포트를 먼저 받아 모르던 발송원을 찾고 나서 정책을 올린다.
- 영구 반송과 불만은 즉시 차단, 일시 반송은 누적 후 차단, `Undetermined`는 차단하지 않는다.
- 억제 목록은 발송 서비스에만 맡기지 않고 내 DB에도 둔다. 단, **해제 경로**를 같이 만든다.
- 트랜잭션 메일과 마케팅 메일은 서브도메인부터 분리한다. 평판은 도메인 단위로 쌓인다.
- 수신 거부는 목록 단위, 반송 차단은 주소 단위. 원클릭 수신 거부 URL은 POST로만 받는다.
