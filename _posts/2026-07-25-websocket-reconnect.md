---
layout: post
title: "WebSocket 재연결 전략 정리"
date: 2026-07-25
tags: [backend, websocket, typescript]
excerpt: "실시간 서비스에서 안정적인 WebSocket 재연결을 위한 지수 백오프 구현 메모."
---

실시간 서비스에서 연결이 끊겼을 때 무작정 즉시 재연결하면 서버에 부하가 몰립니다.
지수 백오프(exponential backoff)로 간격을 늘려가며 재시도하는 편이 안전합니다.

```typescript
function reconnect(attempt = 0) {
  const delay = Math.min(1000 * 2 ** attempt, 30_000);
  setTimeout(() => {
    const ws = new WebSocket(URL);
    ws.onopen = () => { attempt = 0; };
    ws.onclose = () => reconnect(attempt + 1);
  }, delay);
}
```

지터(jitter)를 추가하면 다수 클라이언트가 동시에 재연결하는 것을 분산할 수 있습니다.
