---
layout: post
title: "ERC-4337 계정 추상화로 소셜 로그인 지갑 만들기"
date: 2026-08-15
tags: [blockchain, solidity, erc-4337, typescript]
excerpt: "구글·애플 계정으로 로그인해서 온체인 지갑을 쓰게 만드는 구조. UserOperation부터 Paymaster 가스 대납까지 정리합니다."
---

"시드 구문 12단어를 적어 보관하세요"와 "가스비로 쓸 토큰을 먼저 충전하세요"는, 지갑을 처음 쓰는 사람에게 사실상 서비스를 쓰지 말라는 말입니다.
ERC-4337 계정 추상화는 이 두 장벽을 하드포크 없이 걷어내기 위한 표준입니다. 구글·애플 계정으로 로그인해서 온체인 지갑을 쓰게 만드는 구조를 코드 중심으로 정리합니다.

<!-- TODO: 페이버릿/페이버스테이션에서 실제로 겪었던 온보딩 이탈 구간이나 지표가 있다면 이 자리에 채워주세요 -->

## EOA 기반 지갑의 온보딩 장벽

EOA(Externally Owned Account)는 개인키 하나가 곧 계정입니다. 여기서 제약이 따라옵니다.

- **복구 수단이 시드 구문뿐입니다.** 잃어버리면 서비스가 할 수 있는 일이 없고, 대신 보관해 주면 커스터디 리스크가 생깁니다.
- **수수료를 계정 스스로 내야 합니다.** 잔고가 0인 신규 계정은 아무 트랜잭션도 보낼 수 없고, 서비스가 대신 내줄 방법도 프로토콜상 없습니다.
- **검증 로직이 secp256k1 ECDSA로 고정입니다.** 다중 서명이나 소셜 복구, 세션 키를 계정 레벨에 넣을 수 없습니다.

## ERC-4337이 바꾸는 것

ERC-4337은 합의 계층을 건드리지 않고, 컨트랙트 계정을 위한 별도의 트랜잭션 파이프라인을 애플리케이션 레이어에 만듭니다.
사용자는 트랜잭션 대신 `UserOperation` 구조체에 서명하고, 이것이 별도의 멤풀을 거쳐 최종적으로 하나의 일반 트랜잭션으로 묶여 체인에 올라갑니다.

- **EntryPoint** — 체인마다 하나씩 배포된 싱글턴. 검증·실행 루프를 돌리고 nonce 관리와 예치금 정산을 담당하는, 계정이 신뢰하는 유일한 호출자입니다.
- **Bundler** — UserOperation을 모아 `EntryPoint.handleOps()`를 호출하는 오프체인 노드. 가스를 먼저 내고 수수료로 회수합니다.
- **Paymaster** — 가스비를 대신 내주는 컨트랙트. 서비스가 부담하거나 ERC-20으로 받게 할 수 있습니다.
- **Factory** — 계정을 CREATE2로 배포하는 컨트랙트. 첫 UserOperation 처리 때 계정이 함께 생성됩니다.

### UserOperation의 필드

| 필드 | 역할 |
| --- | --- |
| `sender` | 이 작업을 수행할 계정 컨트랙트 주소 |
| `nonce` | 재전송 방지값. EntryPoint의 NonceManager가 관리 |
| `initCode` | 계정이 없을 때만 채우는 배포 데이터(팩토리 주소 + calldata) |
| `callData` | 계정이 실행할 호출 데이터 |
| `callGasLimit` | `callData` 실행 가스 한도 |
| `verificationGasLimit` | 검증 단계(배포 + `validateUserOp`) 가스 한도 |
| `preVerificationGas` | 온체인에서 계산되지 않는 오버헤드의 번들러 보상분 |
| `maxFeePerGas` / `maxPriorityFeePerGas` | EIP-1559와 같은 의미의 수수료 상한 |
| `paymasterAndData` | 대납할 Paymaster 주소 + 그 Paymaster가 해석할 데이터. 비면 계정이 부담 |
| `signature` | 계정이 검증할 서명. 형식은 계정 구현이 정함 |

중요한 건 `signature` 형식이 표준에 고정되어 있지 않다는 점입니다. 계정이 해석하기 나름이라 ECDSA든 P-256이든 멀티시그든 넣을 수 있습니다. 소셜 로그인을 붙일 여지가 여기서 생깁니다.

> EntryPoint 버전에 따라 필드 구성이 다릅니다(이후 버전에서는 `initCode`와 `paymasterAndData`가 여러 필드로 분해됩니다). 대상 체인에 배포된 버전의 스펙 문서를 먼저 확인해야 합니다.

## 계정 컨트랙트의 최소 구현

계정 컨트랙트가 반드시 구현해야 하는 건 `validateUserOp` 하나입니다.

```solidity
interface IAccount {
    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external returns (uint256 validationData);
}
```

할 일은 셋입니다. **서명 검증**, **유효 시간 구간까지 담은 `validationData` 반환**, **EntryPoint에 부족한 예치금 보전**.
nonce는 EntryPoint의 NonceManager가 이미 검사한 뒤 호출하므로 계정이 다시 볼 필요가 없습니다. 다만 nonce가 192비트 key와 64비트 sequence로 나뉘어 있어, key를 다르게 주면 독립적인 순번을 병렬로 쓸 수 있습니다.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAccount} from "@account-abstraction/contracts/interfaces/IAccount.sol";
import {UserOperation} from "@account-abstraction/contracts/interfaces/UserOperation.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

contract SocialLoginAccount is IAccount {
    uint256 private constant SIG_VALIDATION_SUCCESS = 0;
    uint256 private constant SIG_VALIDATION_FAILED = 1;

    address public immutable entryPoint;
    address public owner;

    constructor(address _entryPoint, address _owner) {
        entryPoint = _entryPoint;
        owner = _owner;
    }

    modifier onlyEntryPoint() {
        require(msg.sender == entryPoint, "account: not from EntryPoint");
        _;
    }

    function validateUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external onlyEntryPoint returns (uint256 validationData) {
        validationData = _validateSignature(userOp, userOpHash);
        _payPrefund(missingAccountFunds);
    }

    function _validateSignature(UserOperation calldata userOp, bytes32 userOpHash)
        internal
        view
        returns (uint256)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(userOpHash);
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, userOp.signature);
        if (err != ECDSA.RecoverError.NoError || recovered != owner) {
            return SIG_VALIDATION_FAILED;
        }
        return SIG_VALIDATION_SUCCESS;
    }

    function _payPrefund(uint256 missingAccountFunds) internal {
        if (missingAccountFunds == 0) return;
        (bool success, ) = payable(msg.sender).call{value: missingAccountFunds}("");
        (success); // 실패해도 revert하지 않습니다. 정산 실패 판단은 EntryPoint의 몫입니다.
    }

    function execute(address dest, uint256 value, bytes calldata func) external onlyEntryPoint {
        (bool success, bytes memory result) = dest.call{value: value}(func);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    receive() external payable {}
}
```

`tryRecover`를 쓴 건 서명이 깨졌을 때 revert 대신 실패 코드를 돌려주기 위해서입니다. `validateUserOp`이 revert하면 UserOperation 전체가 탈락하는데, "서명이 틀렸다"는 정상적인 검증 실패이므로 `validationData`로 알리는 편이 맞습니다. 해시를 감쌀 때 쓴 `toEthSignedMessageHash`는 OpenZeppelin v5에서 `MessageHashUtils`로 옮겨졌고, v4 계열이라면 `ECDSA`에 그대로 있으니 임포트 경로를 버전에 맞춰야 합니다.

그 `validationData`는 불리언이 아니라, 하위 160비트가 authorizer(0이면 성공, 1이면 서명 실패, 그 외에는 검증을 위임할 aggregator 주소), 그 위 48비트가 `validUntil`, 다시 48비트가 `validAfter`로 패킹된 값입니다. 세션 키처럼 유효 기간이 있는 권한이 이 구간을 씁니다.

## 소셜 로그인을 서명 권한으로 바꾸기

여기까지는 "owner의 ECDSA 서명이 필요하다"는 구조입니다. 그런데 구글·애플 로그인이 돌려주는 건 OIDC의 `id_token`(JWT)이지 secp256k1 서명이 아닙니다. 이 간극을 메우는 방식이 실무에서 갈립니다.

**MPC / TSS 기반 키 분산**은 개인키를 여러 조각(share)으로 나눠 서로 다른 주체가 보관합니다. 서명이 필요한 순간에만 임계값 이상의 조각이 모이고, 완성된 개인키는 어느 시점에도 한 곳에 존재하지 않습니다. OIDC 인증 결과는 "이 사용자가 자기 조각을 받아갈 자격이 있다"는 증명으로 쓰입니다. 단일 침해 지점이 없다는 게 장점이지만, 조각 분실 복구를 따로 설계해야 하고 대개 외부 SDK·노드 네트워크의 가용성이 곧 서비스 가용성이 됩니다.

**서버 커스터디 + 정책 서명**은 키를 서버 측(HSM/KMS 등)에 두고, OIDC 인증을 통과한 요청에 한해 정책 검사 후 서명해 주는 방식입니다. 구조가 단순하고 한도·화이트리스트를 서명 직전에 강제할 수 있습니다. 대신 서비스가 사실상 커스터디언이 되어, 서버가 침해되면 사용자 자산이 직접 위험해집니다.

어느 쪽이 정답이라고 말하기는 어렵습니다. 다만 계정 컨트랙트 관점에서는 **어느 쪽을 택하든 `_validateSignature`의 인터페이스가 그대로**라, 나중에 방식을 바꿔도 `owner` 교체로 마이그레이션할 수 있습니다.

<!-- TODO: 페이버릿/페이버스테이션에서 실제로 선택한 방식과 그 판단 근거를 여기에 채워주세요 -->

## Paymaster로 가스비 대납

`paymasterAndData`가 비어 있지 않으면 EntryPoint는 해당 Paymaster에게 대납 의사를 묻습니다.

```solidity
interface IPaymaster {
    function validatePaymasterUserOp(
        UserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 maxCost
    ) external returns (bytes memory context, uint256 validationData);

    function postOp(
        PostOpMode mode,
        bytes calldata context,
        uint256 actualGasCost
    ) external;
}
```

Paymaster가 요청을 받아주면 미리 넣어둔 예치금에서 `maxCost`만큼 잠깁니다. 실행이 끝나면 EntryPoint가 `postOp`을 호출하며 실제 사용된 가스 비용을 알려주고, ERC-20으로 수수료를 받는 Paymaster라면 이때 토큰을 회수합니다.

문제는 아무 조건 없이 대납하면 그 Paymaster가 곧 공짜 가스 수도꼭지가 된다는 점입니다. 누구나 무의미한 UserOperation을 대량으로 보내 예치금을 말릴 수 있습니다. 그래서 서버가 정책을 검사한 뒤 발급한 서명을 `paymasterAndData`에 실어 보내고, Paymaster가 그것을 검증하는 방식을 많이 씁니다.

```solidity
function validatePaymasterUserOp(
    UserOperation calldata userOp,
    bytes32 userOpHash,
    uint256 maxCost
) external override onlyEntryPoint returns (bytes memory context, uint256 validationData) {
    (uint48 validUntil, uint48 validAfter, bytes memory signature) =
        _parsePaymasterAndData(userOp.paymasterAndData);

    bytes32 digest = MessageHashUtils.toEthSignedMessageHash(
        _hashRequest(userOp, validUntil, validAfter)
    );
    bool sigFailed = ECDSA.recover(digest, signature) != policySigner;

    // authorizer(160bit) | validUntil(48bit) | validAfter(48bit)
    validationData =
        (sigFailed ? 1 : 0) |
        (uint256(validUntil) << 160) |
        (uint256(validAfter) << (160 + 48));

    return (abi.encode(userOp.sender, maxCost), validationData);
}
```

정책 서명에는 만료 시각을 반드시 넣습니다. 만료가 없으면 한 번 발급한 대납 허가가 영원히 재사용 가능한 쿠폰이 됩니다. 그리고 Paymaster는 EntryPoint에 예치금(deposit)과 스테이크(stake)를 둘 다 걸어야 합니다. 예치금은 실제 가스비를 내는 잔고이고, 스테이크는 번들러가 이 Paymaster를 멤풀에서 신뢰할지 판단하는 근거입니다.

## 실무에서 걸리는 지점들

### 계정 주소는 배포 전에 이미 정해져 있습니다

Factory가 CREATE2로 계정을 배포하므로, 팩토리 주소·초기화 코드·salt만 알면 배포 전에 주소를 계산할 수 있습니다. counterfactual address라고 부릅니다. 로그인만 하고 아직 아무 트랜잭션도 보내지 않은 사용자에게도 주소를 미리 보여주고 입금을 받을 수 있고, 그 자산은 계정이 배포된 뒤 그대로 그 주소에 있습니다.

직접 계산하는 대신 EntryPoint의 `getSenderAddress(initCode)`를 쓸 수도 있는데, 이 함수는 성공해도 `SenderAddressResult(address)` 에러로 revert하니 revert 데이터를 디코딩해야 합니다.

### initCode는 첫 UserOperation에만 넣습니다

`initCode`는 "이 계정을 지금 배포하라"는 지시입니다. 이미 배포된 계정에 다시 넣으면 EntryPoint가 거절합니다.

```typescript
import { concat, encodeFunctionData } from "viem";

const code = await publicClient.getCode({ address: senderAddress });
const isDeployed = code !== undefined && code !== "0x";

const initCode = isDeployed
  ? "0x"
  : concat([
      FACTORY_ADDRESS,
      encodeFunctionData({
        abi: factoryAbi,
        functionName: "createAccount",
        args: [ownerAddress, salt],
      }),
    ]);
```

배포 여부는 매번 온체인에서 확인하는 게 안전합니다. 로컬 상태로 판단하면 다른 기기에서 이미 배포된 계정에 `initCode`를 다시 실어 보내 계속 실패합니다. 반대로 첫 UserOperation의 `verificationGasLimit`은 배포 비용까지 포함하므로 이후 요청보다 훨씬 크게 잡아야 합니다.

### 번들러 시뮬레이션 실패 디버깅

검증 단계에는 번들러가 요구하는 opcode·스토리지 제약이 걸립니다. `TIMESTAMP`, `NUMBER` 같은 환경 의존 opcode나 자기 소유가 아닌 스토리지 접근은 금지되고, 어기면 번들러가 거절합니다. 그 외의 실패는 대개 `AA` 접두사가 붙은 에러 코드로 돌아옵니다.

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32500, "message": "AA23 reverted (or OOG)" }
}
```

- `AA10` — 이미 배포된 계정에 `initCode`를 넣었을 때
- `AA13` — `initCode`가 revert했거나 가스가 부족할 때. Factory 호출 인자를 먼저 의심합니다
- `AA21` — 계정 잔고와 예치금이 모두 부족해 선불금을 못 냈을 때
- `AA23` — `validateUserOp`이 revert했거나 `verificationGasLimit`이 모자랄 때
- `AA24` — 서명 검증 실패. 서명 대상 해시를 잘못 만든 경우가 대부분입니다
- `AA25` — nonce 불일치. 병렬 전송 시 같은 key로 순번이 꼬였을 때 자주 봅니다

`AA24`는 대개 `userOpHash` 계산이 원인입니다. 이 해시는 UserOperation 필드들과 **EntryPoint 주소, chainId까지 함께** 해싱한 값이라, 클라이언트가 체인이나 EntryPoint 주소를 잘못 잡으면 컨트랙트 계산값과 어긋납니다. 온체인의 `entryPoint.getUserOpHash(userOp)`와 대조해 보는 게 가장 빠릅니다.

가스 한도는 `eth_estimateUserOperationGas`로 받아오되 검증 단계 값에는 여유를 두는 편이 낫습니다. Paymaster를 붙이면 검증 로직이 하나 더 늘어나기 때문에, 계정만 있을 때 뽑은 추정치로는 모자라 `AA23`으로 떨어질 수 있습니다.

## 시드 구문을 없앤 뒤에 남는 것

ERC-4337은 "지갑을 컨트랙트로 만든다"로 요약되지만, 실제로 붙여보면 계정 컨트랙트보다 그 주변(키 관리 방식, Paymaster 정책, 번들러 인프라)에서 결정할 것이 훨씬 많습니다.
시드 구문을 없애면 그 책임이 사라지는 게 아니라 서비스 쪽으로 옮겨온다는 점은 인지하고 시작하는 게 좋습니다.

<!-- TODO: 실제 운영하며 얻은 교훈이나 모니터링 지표(Grafana/Prometheus로 무엇을 봤는지)를 이 자리에 추가해주세요 -->
