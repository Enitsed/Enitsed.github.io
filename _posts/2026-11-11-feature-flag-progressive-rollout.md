---
layout: post
title: "기능 하나가 문제인데 배포 전체를 되돌린다 — 피처 플래그와 점진적 공개"
date: 2026-11-11
tags: [backend, architecture, devops, typescript, cicd]
excerpt: "배포 단위와 공개 단위가 같으면 기능 하나의 문제가 그 배포의 모든 변경을 되돌리는 일이 됩니다. 런타임에 바꿀 수 있는 플래그 구조, 비율 공개에서 Math.random()이 틀리는 이유, 끌 수 없는 플래그와 플래그 부채를 정리합니다."
---

롤백은 보통 "직전 이미지로 되돌리기"입니다.
그런데 그 배포에 기능 다섯 개가 들어 있었다면, 문제가 된 하나를 끄기 위해 나머지 넷도 같이 사라집니다.

되돌리는 단위가 코드 묶음이기 때문입니다.
공개하는 단위를 코드에서 떼어내면 이 계산이 달라집니다.

## 배포와 공개가 같은 단위일 때 생기는 일

가장 먼저 나타나는 증상은 브랜치가 길어지는 것입니다.
아직 공개할 수 없는 기능은 머지할 수 없으니, 완성될 때까지 브랜치에 머물고 그동안 메인과의 차이가 쌓입니다.

두 번째는 되돌리기 비용입니다.
문제를 발견한 시점에 선택지가 "전체 롤백"과 "급하게 수정 배포" 둘뿐이면, 둘 다 몇 분에서 몇십 분이 걸리는 작업입니다.

세 번째는 일정 결합입니다. 기능을 켜는 시점이 배포 시점과 같으면, 공개 시점을 바꾸려면 배포 파이프라인을 다시 돌려야 합니다.

플래그는 이 세 가지를 **"값 하나를 바꾸는 일"로 옮기는 장치**입니다.
대신 코드에 분기가 남고, 그 분기를 관리하는 비용이 새로 생깁니다. 이 글의 절반은 그 비용에 대한 이야기입니다.

## 플래그는 한 종류가 아니다

같은 `if (flag)` 로 보여도 성질이 다릅니다. 수명과 주인이 다르고, 그래서 제거 규칙도 달라야 합니다.

| 종류 | 목적 | 수명 | 바꾸는 사람 |
| --- | --- | --- | --- |
| 릴리스 | 미완성 코드를 머지된 채로 숨김 | 짧음 (며칠~몇 주) | 개발자 |
| 운영 (kill switch) | 장애 시 특정 기능·경로를 끔 | 길다 | 당직·운영 |
| 실험 | 두 안의 지표를 비교 | 실험 기간 | 기획·데이터 |
| 엔타이틀먼트 | 플랜·계약에 따른 기능 차이 | 영구 | 제품 |

구분이 필요한 이유는 **릴리스 플래그만 "제거해야 하는" 플래그**이기 때문입니다.
운영 토글과 엔타이틀먼트는 계속 남아 있는 게 정상이고, 실험은 종료 시점에 한쪽을 코드로 굳힙니다.

이걸 구분하지 않으면 "플래그를 정리하자"는 작업이 매번 "이건 지워도 되나"에서 멈춥니다.

## 환경변수로 시작하면 어디서 막히는가

가장 단순한 구현은 환경변수입니다. 플래그가 두세 개일 때는 이게 정답에 가깝습니다.

```typescript
const enabled = process.env.FEATURE_REPORT_V2 === "true";
```

막히는 지점은 두 군데입니다.

첫째, 바꾸려면 재배포가 필요합니다. 컨테이너 환경변수를 바꾸는 건 태스크 정의를 바꿔 새로 띄우는 일이라, 끄는 데 걸리는 시간이 롤백과 크게 다르지 않습니다.
장애 상황에서 쓸 kill switch로는 쓸 수 없다는 뜻입니다.

둘째, 전부 아니면 전무입니다. 특정 사용자에게만, 또는 10%에게만 켜는 게 불가능합니다.

## 런타임에 바꿀 수 있는 최소 구조

필요한 건 세 가지입니다. 플래그를 담는 저장소, 요청 경로에 I/O를 넣지 않는 캐시, 저장소가 죽었을 때의 기본값.

플래그 정의부터 코드에 둡니다. 저장소가 아니라 코드에 두는 이유는 뒤에서 다룹니다.

```typescript
export const FLAGS = {
  "report-v2":              { type: "release", owner: "backend", expiresAt: "2026-12-31", default: false },
  "bulk-upload":            { type: "release", owner: "backend", expiresAt: "2026-12-15", default: false },
  "external-search-enable": { type: "ops",     owner: "backend", expiresAt: null,         default: true  },
} as const;

export type FlagKey = keyof typeof FLAGS;
```

저장소의 값은 상태와 비율만 담습니다.

```typescript
export type FlagState = "on" | "off" | "rollout";

export interface FlagRule {
  key: string;
  state: FlagState;
  rolloutBps: number;        // 0 ~ 10000 (bp 단위, 10% = 1000)
  allowList?: string[];      // 비율과 무관하게 항상 켜지는 대상
  updatedAt: string;
}
```

캐시는 **오래된 값을 반환하더라도 요청을 막지 않는** 쪽으로 만듭니다.
플래그 조회가 요청마다 DB를 때리면, 플래그를 넣은 대가로 모든 API에 왕복 한 번이 붙습니다.

```typescript
export class FlagCache {
  private snapshot = new Map<string, FlagRule>();
  private loadedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly load: () => Promise<FlagRule[]>,
    private readonly ttlMs = 10_000,
  ) {}

  get(key: string): FlagRule | undefined {
    if (Date.now() - this.loadedAt > this.ttlMs) {
      void this.refresh();              // 기다리지 않는다
    }
    return this.snapshot.get(key);       // 갱신 전이라면 이전 스냅샷
  }

  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.load()
      .then((rules) => {
        this.snapshot = new Map(rules.map((r) => [r.key, r]));
        this.loadedAt = Date.now();
      })
      .catch(() => {
        // 저장소 장애 시 이전 스냅샷을 그대로 쓴다
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }
}
```

`inflight`로 동시 갱신을 한 번으로 묶는 부분이 필요합니다. 없으면 TTL이 만료되는 순간 들어온 요청 수만큼 저장소 조회가 동시에 나갑니다.

> TTL이 곧 **"끄는 데 걸리는 시간"**입니다. 10초로 두면 플래그를 내린 뒤 최대 10초 동안은 켜진 서버가 남아 있습니다.
> 이 지연을 줄이려면 Pub/Sub으로 변경을 밀어주는 방법이 있지만, 그만큼 구성 요소가 늘고 전파 실패를 다시 다뤄야 합니다. TTL을 짧게 두는 쪽이 대개 먼저입니다.

프로세스 시작 시에는 한 번 기다려서 채웁니다. 그 시도가 실패하면 기본값으로 뜨는 게 맞고, 뜨지 못하게 만들면 플래그 저장소가 서비스의 새로운 단일 장애점이 됩니다.

```typescript
await cache.refresh().catch(() => {});   // 실패해도 기동은 계속한다
```

## 비율 공개에서 Math.random()이 틀리는 이유

"10%에게 켠다"를 가장 쉽게 쓰면 이렇게 됩니다.

```typescript
if (Math.random() < 0.1) { /* 새 화면 */ }
```

이건 요청마다 다시 뽑습니다. 같은 사용자가 목록에서는 새 화면을, 상세에서는 옛 화면을 보고, 새로고침하면 또 바뀝니다.
버그로 보이는 동작이 되고, 지표를 비교할 수도 없습니다.

필요한 건 **같은 대상이면 항상 같은 답**이 나오는 배정입니다. 해시를 씁니다.

```typescript
import { createHash } from "node:crypto";

const BUCKETS = 10_000;

export function bucketOf(flagKey: string, subjectId: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${subjectId}`).digest();
  return digest.readUInt32BE(0) % BUCKETS;
}

export function isEnabledFor(rule: FlagRule, subjectId: string): boolean {
  if (rule.state === "off") return false;
  if (rule.state === "on") return true;
  if (rule.allowList?.includes(subjectId)) return true;
  return bucketOf(rule.key, subjectId) < rule.rolloutBps;
}
```

해시 입력에 **플래그 키를 같이 넣는 게 중요합니다.** `subjectId`만 해시하면 모든 플래그가 같은 버킷 순서를 쓰게 됩니다.
그러면 버킷 0번에 들어간 사용자는 모든 롤아웃의 첫 10%에 항상 포함됩니다. 소수의 사용자가 모든 신기능을 먼저 받고, 문제도 전부 그 사람들에게 몰립니다.

비율을 올려도 이미 켜진 대상이 꺼지지 않는다는 점도 이 구조의 성질입니다. `rolloutBps`를 1000에서 2000으로 올리면 기존 1000 미만은 그대로 유지됩니다.
반대로 **비율을 내리면 켜져 있던 사용자가 꺼집니다.** 되돌릴 때는 비율을 줄이는 대신 `state`를 `off`로 내리는 편이 예측 가능합니다.

버킷을 나눌 때 나머지 연산에서 생기는 치우침은 2³²를 10000으로 나눈 잔차 수준이라, 롤아웃 용도로는 무시할 수 있습니다.
`subjectId`에는 로그인 사용자라면 사용자 ID, 비로그인이라면 쿠키에 심은 디바이스 ID를 씁니다. 요청마다 새로 생기는 값을 쓰면 `Math.random()`과 같아집니다.

조직 단위 제품이라면 **배정 단위를 사용자가 아니라 조직으로** 두는 편이 나을 때가 많습니다.
같은 어린이집·같은 회사 안에서 사람마다 화면이 다르면 문의가 늘고, "누구는 되는데 저는 안 된다"는 재현도 어렵습니다.

## 어느 쪽을 봤는지 기록하지 않으면 롤아웃을 읽을 수 없다

10%에 켜놓고 에러율을 보는데, 전체 에러율만 있으면 그 10%가 문제인지 알 수 없습니다.
10%의 에러율이 두 배가 되어도 전체로는 10% 증가로 희석됩니다.

그래서 평가 결과를 남깁니다. 값과 함께 **왜 그 값인지**도 남겨야 디버깅이 됩니다.

```typescript
export interface Evaluation {
  value: boolean;
  reason: "off" | "on" | "allowlist" | "rollout" | "default" | "unknown-key";
}

export function evaluate(key: FlagKey, subjectId: string): Evaluation {
  const rule = cache.get(key);
  if (!rule) {
    return { value: FLAGS[key].default, reason: "default" };
  }
  const value = isEnabledFor(rule, subjectId);
  if (rule.state !== "rollout") return { value, reason: rule.state };
  if (rule.allowList?.includes(subjectId)) return { value: true, reason: "allowlist" };
  return { value, reason: "rollout" };
}
```

평가 결과는 로그와 메트릭 양쪽에 둡니다. 로그에는 요청 단위로, 메트릭에는 집계로 붙입니다.

```typescript
logger.info({ flag: key, value, reason, requestId }, "flag.evaluated");
```

메트릭에 플래그 값을 라벨로 붙일 때는 범위를 좁혀야 합니다. 전체 HTTP 메트릭에 플래그 라벨을 전부 붙이면 플래그 수만큼 시계열이 곱해집니다.
롤아웃 중인 플래그 하나에, 그 기능이 닿는 엔드포인트에만 붙이는 정도가 적당합니다.

`subjectId`를 로그에 넣을 때는 식별자 그대로보다 해시나 내부 ID를 쓰는 편이 안전합니다.

## 클라이언트가 직접 평가하면 규칙이 두 벌이 된다

앱과 웹에서도 플래그가 필요합니다. 여기서 각자 비율과 해시를 구현하면, 같은 사용자에 대해 서버와 클라이언트가 다른 답을 낼 수 있습니다.

평가는 서버에서 한 번만 하고 결과만 내려주는 쪽이 어긋나지 않습니다.

```typescript
app.get("/me/flags", requireAuth, (req, res) => {
  const subjectId = req.user.organizationId;
  const flags = Object.fromEntries(
    CLIENT_VISIBLE_FLAGS.map((key) => [key, evaluate(key, subjectId).value]),
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ flags });
});
```

`CLIENT_VISIBLE_FLAGS`를 따로 두는 이유는, 플래그 목록 자체가 **아직 공개하지 않은 기능의 이름표**이기 때문입니다.
전부 내려주면 서버 코드를 보지 않고도 다음 기능 목록을 알 수 있습니다.

캐시 헤더도 신경 써야 합니다. 이 응답이 CDN이나 공용 캐시에 들어가면 한 사용자의 플래그가 다른 사용자에게 갑니다.
사용자별로 갈리는 응답에는 `private`을 명시하고, 플래그에 따라 내용이 달라지는 HTML·API 응답을 공용 캐시에 두는 구성은 피하는 편이 낫습니다.

## 끌 수 없는 플래그

플래그는 코드 경로를 되돌리지만, **이미 쓰인 데이터는 되돌리지 않습니다.**

새 기능이 새 컬럼이나 새 포맷으로 쓰기를 한다면, 플래그를 켠 동안 그 포맷의 데이터가 쌓입니다.
여기서 플래그를 끄면 옛 코드 경로로 돌아가는데, 그 경로가 새 포맷을 읽지 못하면 켠 시점부터 생긴 데이터가 깨져 보입니다.

그래서 순서를 나눕니다.

1. **읽기를 먼저 양쪽 호환으로 배포한다.** 플래그와 무관하게 옛 포맷과 새 포맷을 모두 읽을 수 있게 만듭니다.
2. 그다음에 쓰기 경로를 플래그로 가릅니다. 이 단계에서는 플래그를 꺼도 읽기가 깨지지 않습니다.
3. 전량 공개 후 백필을 돌립니다.
4. 옛 포맷 읽기 코드와 플래그를 함께 제거합니다.

1번을 건너뛰면 플래그는 있어도 **끌 수 없는 플래그**가 됩니다. 켜고 끌 수 있다는 전제가 사라지니, 애초에 플래그를 넣은 이유가 없어집니다.

외부로 나가는 동작도 같습니다. 발송된 알림, 호출한 결제 API, 올라간 파일은 플래그를 내려도 취소되지 않습니다.
이런 경로는 플래그를 **기능 진입 지점**에 두어야 합니다. 중간에 두면 절반만 수행된 상태가 남습니다.

## 플래그 부채

플래그 n개는 경로 2ⁿ개를 뜻합니다. 실제로 그 조합을 다 테스트하는 건 불가능하고, 하려고 할 필요도 없습니다.

현실적인 선은 이렇습니다.

- 기본 테스트는 **기본값 조합 한 벌**로 돌린다.
- 롤아웃 중인 플래그만 **켜진 조합 한 벌**을 추가로 돌린다.
- 운영 토글은 **꺼진 상태**를 테스트한다. 끌 때 동작하는지가 그 플래그의 존재 이유이기 때문입니다.

플래그를 코드의 `FLAGS`에 선언하게 만든 이유가 여기서 나옵니다. 키가 타입이면 오타가 컴파일에서 걸립니다.
저장소 조회에만 의존하면, 키를 잘못 적은 분기는 조용히 기본값으로 떨어집니다. 꺼져 있어야 할 기능이 켜지거나, 켜야 할 기능이 안 켜지는데 **오류는 아무 데도 찍히지 않습니다.**

만료일을 선언에 넣어두면 정리를 CI에 맡길 수 있습니다.

```bash
# 만료일이 지난 플래그가 남아 있으면 실패시킨다
npx tsx scripts/check-stale-flags.ts
```

```typescript
import { FLAGS } from "../src/flags";

const today = new Date().toISOString().slice(0, 10);
const stale = Object.entries(FLAGS).filter(
  ([, meta]) => meta.expiresAt !== null && meta.expiresAt < today,
);

if (stale.length > 0) {
  console.error(`만료된 플래그: ${stale.map(([key]) => key).join(", ")}`);
  process.exit(1);
}
```

처음에는 경고로 두고, 쌓이기 시작하면 실패로 올리는 순서가 무난합니다.
핵심은 **기한을 플래그를 만들 때 정하는 것**입니다. 나중에 정하려고 하면, 지울 수 있는지 판단할 사람이 이미 다른 일을 하고 있습니다.

제거는 플래그를 켠 채로 두는 것과 다릅니다. `state: "on"`으로 영구히 남은 플래그는 분기와 옛 코드 경로를 그대로 들고 있는 상태입니다.
옛 경로는 아무도 실행하지 않으니 테스트도 리팩터링도 거기까지 닿지 않고, 1년 뒤 kill switch로 그걸 내렸을 때 동작할지는 아무도 모릅니다.

## 직접 만들 것인가

위 구조는 수십 줄짜리입니다. 비율 공개와 kill switch까지는 자체 구현으로 충분히 닿습니다.

갈리는 지점은 그다음입니다.

| | 자체 구현 | 외부 서비스·전용 OSS |
| --- | --- | --- |
| 비율 공개·kill switch | 가능 | 가능 |
| 변경 이력·감사 로그 | 직접 만들어야 함 | 대개 기본 제공 |
| 비개발자 UI | 직접 만들어야 함 | 제공 |
| 실험 지표 분석 | 별도 파이프라인 필요 | 제품 영역 |
| 장애 시 영향 | 자기 DB·캐시 | 외부 의존 추가 |
| 평가 위치 | 서버 내 | 로컬 평가 또는 원격 호출 |

판단 기준은 **플래그를 바꾸는 사람이 누구인지**입니다.
개발자만 바꾼다면 자체 구현이 가볍고, 기획이나 운영이 직접 켜고 꺼야 한다면 UI와 권한, 이력이 필요해지는데 그걸 만드는 비용이 생각보다 큽니다.

전환 가능성을 남기고 싶다면, 애플리케이션 코드가 `evaluate(key, subjectId)` 같은 **자기 인터페이스만 보게** 두는 게 먼저입니다.
같은 발상을 규격으로 만든 [OpenFeature](https://openfeature.dev/)라는 CNCF 프로젝트도 있습니다. 평가 API를 표준화하고 실제 값 해석은 provider가 담당하는 구조라, 나중에 저장소나 벤더를 바꿀 때 애플리케이션 코드를 건드리지 않는 것을 목표로 합니다.
지원 언어와 SDK 성숙도는 바뀌니 도입 전에 공식 문서를 확인하세요.

{% comment %} TODO: 실제로 피처 플래그를 도입했거나 걷어낸 경험이 있다면, 어떤 상황에서 필요해졌고 어느 수준(환경변수 / 자체 구현 / 외부 서비스)에서 멈췄는지 적어주세요 {% endcomment %}

## 정리

- 되돌리는 단위를 배포에서 떼어내는 게 목적이다. 그 대가로 분기와 관리 비용이 생긴다.
- 릴리스·운영·실험·엔타이틀먼트는 수명이 다르다. 제거해야 하는 건 릴리스 플래그뿐이다.
- 환경변수는 두세 개까지. 재배포가 필요한 플래그는 kill switch가 되지 못한다.
- 캐시는 오래된 값을 반환하더라도 요청을 막지 않게. TTL이 곧 끄는 데 걸리는 시간이다.
- 저장소가 죽으면 기본값으로 뜬다. 뜨지 못하게 만들면 단일 장애점을 하나 늘린 것이다.
- 비율 공개는 `해시(플래그키 + 대상ID)`로. 플래그 키를 섞지 않으면 같은 사용자가 모든 롤아웃의 선두에 선다.
- 평가 결과를 기록하지 않으면 롤아웃 중 지표를 읽을 수 없다. 값과 이유를 함께 남긴다.
- 평가는 서버에서 하고 결과만 내려준다. 플래그 목록 자체가 미공개 기능의 정보다.
- 쓰기 경로 플래그는 읽기 양방향 호환을 먼저 배포한 뒤에 켠다. 순서를 바꾸면 끌 수 없는 플래그가 된다.
- 만료일과 담당자를 만들 때 적는다. 나중에 정하면 아무도 지우지 못한다.
