---
layout: post
title: "TheGraph로 ERC721 온체인 이벤트 인덱싱하기"
date: 2026-08-15
tags: [blockchain, thegraph, solidity, typescript, nft]
excerpt: "NFT 멤버십 서비스에서 보유 목록·거래 내역을 조회하기 위해 subgraph를 만든 과정. 스키마 설계부터 매핑 핸들러, 운영 시 주의점까지."
---

선미야클럽은 ERC721 기반 NFT 멤버십 프로젝트입니다.
스마트컨트랙트를 만들고 판매를 운영하는 것까지는 컨트랙트 안에서 끝나지만,
서비스를 붙이는 순간부터는 이야기가 달라집니다.
"이 지갑이 지금 어떤 토큰을 갖고 있지?", "이 토큰은 지금까지 누구를 거쳐 왔지?" 같은 질문에 답해야 하기 때문입니다.
오프라인 행사장에서 NFT 보유 여부로 입장을 확인하려면 이 조회가 빠르고 정확해야 합니다.

이 글은 그 조회를 위해 TheGraph subgraph를 만든 과정을 정리한 것입니다.

## 왜 인덱서가 필요한가

먼저 인덱서 없이 해보려고 하면 어디서 막히는지 짚고 넘어가겠습니다.

ERC721 표준에는 `balanceOf(address)`는 있지만 "이 주소가 가진 토큰 ID 목록"을 돌려주는 함수는 없습니다.
`ERC721Enumerable` 확장을 붙이면 `tokenOfOwnerByIndex`로 순회할 수 있긴 한데,
민팅·전송할 때마다 인덱스 배열을 갱신하느라 가스가 눈에 띄게 늘어납니다.
판매 물량이 큰 프로젝트에서는 그 가스를 구매자가 부담하게 되므로 선택하기 어렵습니다.
거래 내역은 더합니다. 과거 이력은 애초에 컨트랙트 스토리지에 남지 않고 이벤트 로그로만 존재합니다.

그러면 RPC로 로그를 직접 긁으면 되지 않느냐 싶은데, `eth_getLogs`를 폴링하는 방식에는 몇 가지 현실적인 문제가 있습니다.

- **블록 범위 제한.** 대부분의 공개 RPC 제공자는 한 번의 `eth_getLogs`가 훑을 수 있는 블록 범위나 응답 로그 개수에 상한을 둡니다. 배포 시점부터 현재까지를 훑으려면 범위를 잘게 쪼개 수천 번 호출해야 하고, 중간에 하나라도 실패하면 어디서부터 다시 시작할지 직접 관리해야 합니다.
- **재구성(reorg) 처리.** 방금 읽은 블록이 나중에 체인에서 밀려날 수 있습니다. 그 블록의 이벤트로 갱신한 DB 상태를 되돌리는 로직을 직접 짜야 하는데, 이게 생각보다 까다롭습니다.
- **상태 조합이 안 됨.** 로그는 "누가 누구에게 몇 번 토큰을 보냈다"라는 사실의 나열일 뿐입니다. "현재 보유자"는 그 로그를 순서대로 재생해야 나오는 파생 상태입니다. 결국 로그를 받아서 상태를 만드는 코드를 어차피 짜야 합니다.

subgraph는 이 세 가지를 대신 해줍니다.
로그를 순서대로 재생하고, reorg가 나면 해당 블록까지 롤백해서 다시 재생하고,
결과를 GraphQL로 질의할 수 있는 엔티티 형태로 저장해 줍니다.
우리가 짜는 것은 "이벤트를 받아서 엔티티를 어떻게 갱신할지"뿐입니다.

## subgraph를 이루는 세 가지 파일

subgraph 프로젝트는 사실상 아래 세 개로 끝납니다. 역할이 뚜렷하게 나뉘어 있습니다.

| 파일 | 역할 |
| --- | --- |
| `subgraph.yaml` | 매니페스트. 어떤 컨트랙트의 어떤 이벤트를, 몇 번 블록부터 들을지 |
| `schema.graphql` | 저장할 엔티티의 모양. 그대로 GraphQL 질의 스키마가 됨 |
| `src/mapping.ts` | 이벤트 하나가 들어왔을 때 엔티티를 어떻게 바꿀지 (AssemblyScript) |

매니페스트가 "무엇을 들을지", 스키마가 "무엇을 저장할지", 매핑이 "어떻게 바꿀지"를 담당한다고 보면 됩니다.
`graph codegen`을 돌리면 앞의 두 파일로부터 타입이 생성되고, 매핑 코드는 그 타입 위에서 작성합니다.

## schema.graphql — 엔티티 설계

ERC721 `Transfer` 이벤트 하나만 가지고도 필요한 것은 거의 다 만들 수 있습니다.
토큰의 현재 상태(`Token`), 보유자(`Owner`), 그리고 전송 이력(`Transfer`) 세 개로 잡았습니다.

```graphql
type Token @entity {
  id: ID!                # tokenId 를 문자열로
  tokenId: BigInt!
  owner: Owner!
  burned: Boolean!
  mintedAt: BigInt!
  mintTx: Bytes!
  transfers: [Transfer!]! @derivedFrom(field: "token")
}

type Owner @entity {
  id: ID!                # 지갑 주소 (소문자 hex)
  balance: BigInt!
  tokens: [Token!]! @derivedFrom(field: "owner")
}

type Transfer @entity {
  id: ID!                # {txHash}-{logIndex}
  token: Token!
  from: Owner!
  to: Owner!
  blockNumber: BigInt!
  timestamp: BigInt!
  txHash: Bytes!
}
```

몇 가지 짚을 점이 있습니다.

`id`는 엔티티마다 유일해야 하고, 한 번 정하면 바꾸기 어렵습니다.
`Token`은 `tokenId`가 그 자체로 유일하니 그대로 쓰면 되고,
`Owner`는 주소를 소문자 hex로 통일해서 씁니다(대소문자가 섞이면 같은 지갑이 두 엔티티로 갈라집니다).
`Transfer`처럼 같은 트랜잭션 안에서 여러 건이 발생할 수 있는 이력 엔티티는
트랜잭션 해시만으로는 충돌하므로 **트랜잭션 해시 + 로그 인덱스**를 조합합니다.

`@derivedFrom`은 역방향 관계를 선언하는 지시자입니다.
`Owner.tokens`에는 `@derivedFrom(field: "owner")`가 붙어 있는데,
이는 "`Token.owner`가 나를 가리키는 것들을 모아서 보여달라"는 뜻입니다.
파생 필드이므로 매핑 코드에서 직접 채워 넣지 않습니다 — 채울 수도 없고, 채울 필요도 없습니다.
`Token.owner`만 갱신하면 반대편은 자동으로 따라옵니다.
이 지시자를 안 쓰고 `Owner`에 토큰 ID 배열을 직접 들고 있으면
전송이 일어날 때마다 배열을 로드해서 원소를 지우고 다시 저장해야 하는데, 보유량이 많아질수록 느려집니다.

한 번 쓰고 나면 절대 수정되지 않는 이력 엔티티는 `@entity(immutable: true)`로 선언해
인덱싱 성능 이점을 볼 수 있습니다. 다만 지원 여부가 매니페스트의 `specVersion`에 걸려 있으니
사용 중인 버전의 공식 문서를 확인하고 적용하시기 바랍니다.

## subgraph.yaml — 어떤 이벤트를 들을지

```yaml
specVersion: 0.0.5
schema:
  file: ./schema.graphql
dataSources:
  - kind: ethereum/contract
    name: MiyaClub
    # TODO: 실제 배포 네트워크와 컨트랙트 주소를 채워주세요
    network: mainnet
    source:
      address: "0x0000000000000000000000000000000000000000"
      abi: MiyaClub
      # TODO: 컨트랙트 배포 블록 번호를 채워주세요
      startBlock: 0
    mapping:
      kind: ethereum/events
      apiVersion: 0.0.7
      language: wasm/assemblyscript
      file: ./src/mapping.ts
      entities:
        - Token
        - Owner
        - Transfer
      abis:
        - name: MiyaClub
          file: ./abis/MiyaClub.json
      eventHandlers:
        - event: Transfer(indexed address,indexed address,indexed uint256)
          handler: handleTransfer
```

맨 위의 `specVersion`과 `mapping.apiVersion`은 설치한 graph-cli / graph-ts 버전에 따라 유효한 값이 달라집니다.
`graph init`으로 프로젝트를 스캐폴딩하면 그 시점에 맞는 값이 채워지므로 그대로 두는 편이 안전합니다.

여기서 제일 자주 실수하는 곳이 `eventHandlers`의 `event` 문자열입니다.
이건 사람이 읽으라고 쓰는 설명이 아니라 **이벤트 시그니처 그 자체**이고, 이걸로 토픽 해시를 계산합니다.
따라서 ABI에 정의된 것과 글자 하나까지 같아야 합니다.

- `indexed` 키워드를 빠뜨리면 다른 시그니처가 되어 이벤트가 하나도 잡히지 않습니다.
- 쉼표 뒤에 공백을 넣으면 안 됩니다. `(indexed address, indexed address, ...)`는 틀린 형태입니다.
- `uint`가 아니라 `uint256`처럼 정규화된 타입명을 씁니다.

핸들러가 안 불린다면 십중팔구 이 줄이거나 `startBlock`이 너무 뒤에 있는 경우입니다.

## mapping.ts — 핸들러 작성

매핑은 AssemblyScript로 작성합니다. TypeScript와 문법이 거의 같지만 별개의 언어이고,
`null` 체크나 형변환에서 TypeScript보다 엄격합니다.

```typescript
import { Address, BigInt } from "@graphprotocol/graph-ts";
import { Transfer as TransferEvent } from "../generated/MiyaClub/MiyaClub";
import { Owner, Token, Transfer } from "../generated/schema";

let ZERO_BI = BigInt.fromI32(0);
let ONE_BI = BigInt.fromI32(1);

function loadOrCreateOwner(address: Address): Owner {
  let id = address.toHexString();
  let owner = Owner.load(id);
  if (owner == null) {
    owner = new Owner(id);
    owner.balance = ZERO_BI;
    owner.save();
  }
  return owner as Owner;
}

export function handleTransfer(event: TransferEvent): void {
  let from = loadOrCreateOwner(event.params.from);
  let to = loadOrCreateOwner(event.params.to);

  // Token: 없으면 만들고, 있으면 불러와서 갱신
  let tokenId = event.params.tokenId.toString();
  let token = Token.load(tokenId);
  if (token == null) {
    token = new Token(tokenId);
    token.tokenId = event.params.tokenId;
    token.mintedAt = event.block.timestamp;
    token.mintTx = event.transaction.hash;
    token.burned = false;
  }
  token.owner = to.id;
  token.save();

  // 전송 이력은 매번 새 엔티티로 추가
  let transferId = event.transaction.hash.toHexString()
    + "-" + event.logIndex.toString();
  let transfer = new Transfer(transferId);
  transfer.token = token.id;
  transfer.from = from.id;
  transfer.to = to.id;
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp;
  transfer.txHash = event.transaction.hash;
  transfer.save();
}
```

핵심 패턴은 **load-or-create**입니다.
`Token.load(id)`는 이 subgraph가 지금까지 저장해 둔 엔티티를 찾아오고, 없으면 `null`을 반환합니다.
`Transfer` 이벤트를 처음 보는 토큰이라면 새로 만들고, 이미 본 토큰이면 소유자만 바꿔 끼우면 됩니다.

그리고 **`.save()`를 호출하지 않으면 아무것도 저장되지 않습니다.**
필드를 아무리 잘 채워 놔도 `save()`가 빠지면 조용히 사라집니다.
쿼리 결과가 비어 있을 때 제일 먼저 확인할 곳입니다.

관계 필드에는 엔티티 객체가 아니라 상대 엔티티의 **ID 문자열**을 넣습니다.
`transfer.token = token.id`이지 `transfer.token = token`이 아닙니다.

## 민팅과 소각 구분하기

ERC721은 민팅과 소각을 위한 별도 이벤트를 정의하지 않습니다.
둘 다 `Transfer`로 나오되, 한쪽 주소가 제로 어드레스(`0x000...0`)입니다.

- `from == 0x0` → 민팅
- `to == 0x0` → 소각
- 그 외 → 일반 전송

보유 수량을 정확히 유지하려면 이 분기가 반드시 필요합니다.
제로 어드레스의 `balance`까지 증감시키면 소각된 토큰이 누군가의 보유량으로 잡히기 때문입니다.
앞의 `handleTransfer`에서 **`token.save()`를 호출하기 전에** 아래 블록을 끼워 넣습니다.
`burned` 플래그를 세팅한 뒤에 저장해야 반영됩니다.

```typescript
let zero = Address.zero();
let isMint = event.params.from.equals(zero);
let isBurn = event.params.to.equals(zero);

if (!isMint) {
  from.balance = from.balance.minus(ONE_BI);
  from.save();
}
if (!isBurn) {
  to.balance = to.balance.plus(ONE_BI);
  to.save();
}

token.burned = isBurn;
```

소각된 토큰을 `store.remove()`로 지워버릴 수도 있지만,
`burned` 플래그로 남겨두는 편을 권합니다.
이력 조회에서 "언젠가 존재했던 토큰"을 봐야 하는 경우가 생기고,
`Transfer` 엔티티가 `Token`을 참조하고 있는데 대상이 사라지면 관계가 끊어집니다.

## 조회 — GraphQL 쿼리

여기까지 하면 아래처럼 질의할 수 있습니다.
특정 지갑이 보유한 토큰 목록은 이 한 번의 요청으로 끝납니다.

```graphql
query OwnedTokens($owner: ID!) {
  owner(id: $owner) {
    balance
    tokens(where: { burned: false }, orderBy: tokenId) {
      tokenId
      mintedAt
      transfers(orderBy: blockNumber, orderDirection: desc, first: 5) {
        from { id }
        to { id }
        timestamp
      }
    }
  }
}
```

`$owner`에는 소문자 hex 주소를 넣어야 합니다.
매핑에서 `toHexString()`으로 저장했으므로 체크섬 주소를 그대로 넣으면 아무것도 안 나옵니다.
프론트엔드에서 `toLowerCase()`를 한 번 태우고 보내는 편이 안전합니다.

### 페이지네이션은 id_gt 커서로

전체 홀더 목록처럼 건수가 많은 질의는 `first`/`skip` 대신 `id_gt` 커서를 권합니다.

```graphql
query AllTokens($lastId: ID!) {
  tokens(
    first: 1000
    orderBy: id
    orderDirection: asc
    where: { id_gt: $lastId }
  ) {
    id
    owner { id }
  }
}
```

`skip`은 뒤로 갈수록 느려집니다. 1만 번째 항목을 가져오려면 앞의 1만 개를 세어서 버려야 하기 때문입니다.
게다가 `skip`에는 상한이 있어서 일정 깊이를 넘어가면 아예 조회할 수 없습니다(정확한 값은 사용 중인 게이트웨이 문서를 확인하세요).
`id_gt`는 인덱스를 타고 바로 시작 위치를 찾아가므로 몇 번째 페이지든 비용이 같습니다.
직전 페이지의 마지막 `id`를 다음 요청의 `$lastId`로 넘기면서 빈 배열이 올 때까지 반복하면 됩니다.

이 방식에는 조건이 하나 붙습니다. **`orderBy`가 `id`여야 합니다.**
다른 필드로 정렬하면서 `id_gt`로 커서를 잡으면 순서와 커서가 어긋나 항목이 누락됩니다.
정렬 순서가 중요하다면 정렬 키를 `id`에 인코딩해 두는 방법을 고려하시기 바랍니다.

## 운영에서 주의할 점

### startBlock은 반드시 배포 블록으로

`startBlock`을 비워두면 0번 블록부터 훑기 시작합니다.
컨트랙트가 존재하지도 않던 수백만 개의 블록을 헛돌기 때문에 초기 동기화가 며칠 단위로 늘어납니다.
컨트랙트 배포 트랜잭션이 들어간 블록 번호를 정확히 넣으면 그만큼을 통째로 건너뜁니다.
subgraph를 새로 배포할 때마다 처음부터 다시 인덱싱하므로, 이 값 하나가 개발 사이클 전체의 속도를 좌우합니다.

<!-- TODO: 선미야클럽 subgraph의 실제 초기 동기화 소요 시간을 채워주세요 -->

### 스키마 변경은 곧 재인덱싱

`schema.graphql`을 바꾸면 기존에 인덱싱된 데이터를 그대로 쓸 수 없습니다.
새 버전을 배포하고 배포 블록부터 다시 재생해야 합니다.
필드 하나 추가하려고 전체 재인덱싱을 다시 기다리는 상황이 반복되면 꽤 답답해집니다.

그래서 스키마는 처음에 조금 여유 있게 잡는 편이 낫습니다.
지금 안 쓰더라도 나중에 필요할 것 같은 필드 — 블록 번호, 타임스탬프, 트랜잭션 해시 정도 — 는
어차피 이벤트 객체에서 공짜로 나오니 미리 저장해 두면 나중에 재인덱싱 한 번을 아낍니다.

<!-- TODO: 실제 프로젝트에서 스키마를 변경한 횟수와 그때의 재인덱싱 소요 시간을 채워주세요 -->

### 핸들러 안에서 eth_call 남발하지 않기

매핑에서 생성된 컨트랙트 바인딩으로 `tokenURI()` 같은 뷰 함수를 호출할 수 있습니다.
편리하지만 이 호출 하나하나가 아카이브 노드에 대한 `eth_call`이고, 이벤트 개수만큼 곱해집니다.
민팅 1만 건이면 `eth_call` 1만 번이 추가되고, 인덱싱 속도는 눈에 띄게 떨어집니다.

가능하면 **이벤트 파라미터 안에 있는 값만으로 처리**하는 것이 원칙입니다.
`Transfer` 이벤트에는 `from`, `to`, `tokenId`가 전부 들어 있어서 사실 컨트랙트를 부를 이유가 없습니다.
꼭 컨트랙트 상태를 읽어야 한다면 `try_` 접두사가 붙은 호출을 써서 실패를 처리하고,
호출 결과가 바뀌지 않는 값이라면 한 번만 읽어 엔티티에 저장한 뒤 재사용하시기 바랍니다.

### 인덱싱 지연은 _meta로 확인

subgraph는 체인 헤드보다 항상 조금 뒤처져 있습니다.
방금 민팅한 NFT가 조회에 안 나온다면 버그가 아니라 아직 인덱싱이 안 됐을 가능성이 큽니다.
`_meta` 필드로 지금 어디까지 처리했는지 확인할 수 있습니다.

```graphql
{
  _meta {
    block {
      number
      hash
    }
    deployment
    hasIndexingErrors
  }
}
```

`_meta.block.number`를 RPC의 `eth_blockNumber`와 비교하면 몇 블록 뒤처져 있는지 나옵니다.
서비스에서 실시간성이 중요한 화면이라면 이 차이를 헬스체크 지표로 잡아두고 임계치를 넘을 때 알림을 받는 편이 좋습니다.
`hasIndexingErrors`가 `true`면 핸들러가 어딘가에서 실패해 인덱싱이 멈춘 상태이므로 즉시 봐야 합니다.

<!-- TODO: 실제로 운영하며 설정한 인덱싱 지연 임계치와 알림 구성을 채워주세요 -->

## 정리

빌드와 배포는 CLI 세 줄이면 됩니다.

```bash
graph codegen   # schema.graphql + ABI -> 타입 생성
graph build     # AssemblyScript -> WASM 컴파일
graph deploy <subgraph-name>
```

`Transfer` 이벤트 하나만 처리했는데도 보유 목록, 거래 이력, 홀더 수까지 전부 나옵니다.
RPC 폴링으로 같은 것을 만들었다면 블록 범위를 쪼개고 reorg를 되돌리는 코드를 직접 짜야 했을 겁니다.
온체인 데이터를 읽어서 서비스에 붙여야 하는 상황이라면 먼저 subgraph를 검토해 보시길 권합니다.
