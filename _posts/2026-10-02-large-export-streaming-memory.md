---
layout: post
title: "엑셀 받기를 눌렀더니 서버가 죽었다 — 대용량 내보내기의 메모리와 타임아웃"
date: 2026-10-02
tags: [backend, typescript, mysql, aws, api]
excerpt: "다운로드 버튼 하나가 왜 프로세스 전체를 멈추는가. 결과 집합을 통째로 메모리에 담는 경로, 스트리밍이 커넥션 점유로 문제를 옮기는 지점, 청크로 쪼개면 깨지는 일관성, 동기 응답이 실패를 숨기는 구조와 비동기 작업으로 떼어내는 선택까지."
---

목록 화면은 한 페이지씩 보여주니 잘 돕니다. 그런데 같은 데이터에 "전체 내보내기"가 붙으면 한 번의 요청이 프로세스를 멈춰 세웁니다.

더 곤란한 건 이게 그 요청만의 문제가 아니라는 점입니다. 관계없는 API까지 같이 느려지고, 운이 나쁘면 프로세스가 재시작됩니다.

## 한 번의 요청이 어디서 터지는가

내보내기는 세 자원을 동시에 오래 씁니다. 그래서 고치는 순서도 이 세 군데를 따라갑니다.

- **메모리** — 결과 집합과 직렬화된 파일이 동시에 힙에 올라갑니다.
- **시간** — 요청 하나가 수십 초에서 분 단위로 살아 있습니다. 그 사이 중간 경로의 타임아웃들을 전부 통과해야 합니다.
- **커넥션** — DB 커넥션 한 개를 그 시간 내내 쥐고 있습니다.

보통 메모리부터 손대는데, 메모리를 고치면 문제가 사라지는 게 아니라 **커넥션 점유로 옮겨갑니다.** 그래서 한 단계씩 보는 편이 낫습니다.

## 메모리: 전체를 배열에 담는 순간

대부분의 드라이버는 쿼리 결과를 **전부 받아서 배열로 돌려줍니다.** 편하지만, 행 수가 커지면 그 배열이 그대로 힙입니다.

```typescript
// 행 수가 커지면 여기서 끝난다
const [rows] = await pool.query('SELECT * FROM orders WHERE created_at >= ?', [from]);
const csv = rows.map(toCsvLine).join('\n');   // 같은 데이터를 한 벌 더 만든다
res.send(csv);
```

문제는 두 겹입니다. 행 객체 배열이 하나, 그걸 문자열로 이어붙인 결과가 또 하나. **피크 메모리는 데이터 크기의 두 배 이상**이 됩니다.

여기서 흔한 오해가 있습니다. "행 하나가 1KB니까 10만 건이면 100MB"라는 계산은 거의 항상 낮게 나옵니다.
JS 객체는 키 이름과 프로퍼티 메타데이터를 행마다 들고 있어서, 디스크에서 100MB인 데이터가 힙에서는 몇 배가 됩니다.

> 이 경로가 위험한 건 메모리를 많이 쓴다는 것보다 **실패 방식** 때문입니다.
> 힙이 한계에 닿으면 그 요청만 실패하는 게 아니라 프로세스가 죽습니다. 같은 프로세스에 붙어 있던 다른 요청도 전부 같이 끊깁니다.

그래서 내보내기는 **"행 전체를 한 번에 들고 있지 않는다"**를 먼저 만들어야 합니다.

### 행 단위로 흘려보내기

mysql2는 결과를 버퍼링하지 않고 읽는 스트림을 제공합니다.

```typescript
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const conn = await pool.getConnection();
try {
  const rowStream = conn.connection
    .query('SELECT id, created_at, amount, buyer_name FROM orders WHERE created_at >= ?', [from])
    .stream();

  const toCsv = new Transform({
    objectMode: true,
    transform(row, _enc, cb) {
      cb(null, `${row.id},${row.created_at.toISOString()},${row.amount},${csvCell(row.buyer_name)}\n`);
    },
  });

  await pipeline(rowStream, toCsv, res);
} finally {
  conn.release();
}
```

`pipeline`을 쓰는 이유가 두 가지 있습니다.

첫째, **백프레셔**. 클라이언트가 느리게 받으면 `res`가 가득 차고, `pipeline`이 그 신호를 거슬러 올라가 행 읽기를 멈춰줍니다.
직접 `rowStream.on('data', ...)` 안에서 `res.write()`를 호출하면 이 신호를 무시하게 되고, 안 나간 데이터가 버퍼에 쌓여서 결국 똑같이 메모리로 터집니다.

둘째, **정리**. 중간에 하나가 실패하거나 클라이언트가 연결을 끊으면 나머지 스트림도 같이 파괴됩니다. 이걸 손으로 하면 빠뜨리는 쪽이 생깁니다.

`SELECT *`를 쓰지 않은 것도 의도입니다. 내보내기에 쓰지 않는 컬럼은 읽지 않는 게 메모리와 전송량 양쪽에 바로 듣습니다. 특히 긴 TEXT나 JSON 컬럼이 섞여 있으면 차이가 큽니다.

## 스트리밍이 옮겨놓는 문제

메모리는 해결됐습니다. 대신 **DB 커넥션 하나를 내보내기가 끝날 때까지 쥐고 있습니다.**

[커넥션 풀이 마르는 순간](/blog/db-connection-pool-exhaustion/)에서 본 구조가 그대로 재현됩니다. 풀 크기가 20인데 내보내기 요청 20개가 동시에 들어오면, DB는 한가한데 모든 API가 커넥션을 기다립니다.

그리고 서버 쪽에서 조용히 끊기는 경로가 하나 더 있습니다.

> MySQL은 클라이언트가 결과를 충분히 빨리 받아가지 않으면 그 커넥션을 **클라이언트가 죽은 것으로 판단**합니다.
> `net_write_timeout`이 그 기준이고, 넘기면 전송이 중단됩니다.

이게 성가신 이유는 증상이 오류가 아닌 경우가 있다는 점입니다. 중간에 끊긴 결과가 **정상 종료처럼 보이면서** 잘린 파일이 만들어집니다.
"어제 받은 파일은 12만 건인데 오늘 받은 건 7만 건"처럼, 데이터가 틀렸다는 신고로 돌아옵니다.

느린 클라이언트와 느린 직렬화가 둘 다 이 타임아웃을 건드릴 수 있습니다. 그래서 내보내기는 **행 수를 세어 검증**해두는 게 좋습니다. 마지막에 쓴 행 수와 `COUNT(*)`를 비교해 어긋나면 실패로 처리하는 쪽이, 조용히 잘린 파일을 주는 것보다 낫습니다.

## 청크로 쪼개 읽기

커넥션을 오래 쥐지 않으려면 한 번에 다 읽지 말고 **끊어서 읽고 그때마다 반납**합니다.

페이지를 `OFFSET`으로 넘기면 뒤로 갈수록 느려집니다. [커서 페이지네이션](/blog/cursor-pagination-keyset/)과 같은 이유이고, 같은 방식으로 풉니다.

```typescript
async function* exportChunks(from: Date, chunkSize = 5000) {
  let cursor = 0;
  for (;;) {
    const [rows] = await pool.query(
      `SELECT id, created_at, amount, buyer_name
         FROM orders
        WHERE created_at >= ? AND id > ?
        ORDER BY id
        LIMIT ?`,
      [from, cursor, chunkSize],
    );
    if (rows.length === 0) return;
    yield rows;
    cursor = rows[rows.length - 1].id;
  }
}
```

커넥션은 청크 하나를 읽는 동안만 쓰이고 바로 풀로 돌아갑니다. 메모리도 청크 크기만큼만 올라갑니다.

`ORDER BY id`로 고정한 게 중요합니다. 정렬이 없으면 두 청크 사이에 같은 행이 다시 나오거나 아예 빠질 수 있습니다. 커서로 쓸 컬럼은 **유일하고 단조로워야** 하고, 그 순서로 인덱스를 탈 수 있어야 합니다.

### 대신 일관성을 내준다

청크로 쪼개면 각 쿼리가 별개 트랜잭션입니다. 내보내는 몇 분 사이에 들어온 변경이 **일부만 반영된 파일**이 나옵니다.

| | 단일 스트리밍 쿼리 | 청크 반복 |
| --- | --- | --- |
| 스냅샷 일관성 | 한 시점 기준으로 일관 | 청크마다 다른 시점 |
| 커넥션 점유 | 전 구간 | 청크 단위 |
| 메모리 | 행 단위 | 청크 크기만큼 |
| 중간 재시도 | 처음부터 | 커서부터 이어서 |

어느 쪽이 맞는지는 **그 파일을 무엇에 쓰는지**에 달려 있습니다.

정산이나 감사 자료라면 일관성을 포기할 수 없습니다. 이때는 범위를 시간으로 닫아버리는 방법이 가장 단순합니다.
"어제까지의 주문"처럼 **이미 변하지 않는 구간**을 대상으로 하면, 청크로 쪼개도 결과가 같습니다. 일관성 문제를 기술로 풀지 않고 요구사항 쪽에서 치우는 선택입니다.

마감 구간을 쓸 수 없고 지금 이 순간이 필요하다면 단일 스트리밍 쿼리를 쓰되, 그 커넥션을 운영 풀에서 떼어놓는 편이 안전합니다.
내보내기 전용 풀을 작게(예: 2~3) 따로 두면, 내보내기가 몰려도 일반 API가 쓸 커넥션은 남습니다.
리플리카가 있다면 읽기 대상을 거기로 돌리는 선택도 같이 생각해볼 수 있습니다. 복제 지연만큼 과거를 본다는 점은 감수해야 합니다.

## 포맷: CSV와 XLSX는 다른 문제를 가진다

### CSV는 쓰기 쉽고 열 때 깨진다

CSV 생성 자체는 한 줄씩 이어붙이면 되니 스트리밍과 궁합이 좋습니다. 문제는 받는 쪽에서 생깁니다.

가장 자주 들어오는 신고가 **한글이 깨진다**는 것입니다. Excel은 CSV를 열 때 인코딩을 선언받지 못하면 OS 기본 인코딩으로 해석합니다. UTF-8로 쓴 파일이 그래서 깨집니다.
파일 맨 앞에 UTF-8 BOM을 붙여주면 Excel이 UTF-8로 알아봅니다.

```typescript
res.setHeader('Content-Type', 'text/csv; charset=utf-8');
res.setHeader('Content-Disposition', 'attachment; filename="orders.csv"');
res.write('﻿');   // UTF-8 BOM — Excel이 인코딩을 알아보게
```

BOM은 Excel을 위한 타협입니다. 그 파일을 다른 프로그램이 파싱한다면 **첫 컬럼명 앞에 보이지 않는 문자가 붙어** 헤더 비교가 실패합니다.
사람이 Excel로 열 파일과 시스템이 읽을 파일을 같은 엔드포인트로 주고 있다면, 여기서 한쪽은 반드시 불편해집니다.

그다음은 셀 이스케이프입니다. 쉼표·따옴표·개행이 값에 들어 있으면 열이 밀립니다.

```typescript
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // 수식으로 해석될 수 있는 선행 문자는 무력화한다
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
```

따옴표를 두 번 쓰는 것으로 이스케이프하는 건 CSV 규약이고, 값 전체를 따옴표로 감싸야 유효합니다.

선행 문자를 걸러내는 부분은 보안 쪽입니다. `=`나 `+`로 시작하는 값은 스프레드시트에서 **수식으로 해석**됩니다.
사용자가 입력한 이름이나 메모가 그대로 셀에 들어가는 내보내기라면, 공격자가 수식을 심어두고 운영자가 그 파일을 여는 순간을 노릴 수 있습니다.
서버에서는 평범한 문자열이라 입력 검증을 통과하고, 내보내기를 거쳐 다른 프로그램의 실행 컨텍스트로 들어가는 경로입니다. 내보내는 시점에 막는 게 맞습니다.

### XLSX는 열기 쉽고 쓸 때 메모리를 먹는다

요청이 "엑셀로 주세요"라면 대개 진짜 `.xlsx`를 뜻합니다. 서식과 시트를 쓸 수 있고 인코딩 사고가 없습니다.

대신 XLSX는 압축된 XML 묶음이라, 라이브러리 기본 동작은 **워크북 전체를 메모리에 만들어놓고 마지막에 직렬화**합니다. 스트리밍으로 DB를 읽어도 여기서 다시 전부 쌓입니다.

`exceljs`에는 커밋한 행을 바로 내려보내는 스트리밍 작성기가 있습니다.

```typescript
import ExcelJS from 'exceljs';

const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
  stream: res,
  useSharedStrings: false,   // 켜면 문자열 테이블을 메모리에 누적한다
  useStyles: false,
});

const sheet = workbook.addWorksheet('orders');
sheet.addRow(['주문번호', '주문일시', '금액', '구매자']).commit();

for await (const rows of exportChunks(from)) {
  for (const row of rows) {
    sheet.addRow([row.id, row.created_at, row.amount, row.buyer_name]).commit();
  }
}

sheet.commit();
await workbook.commit();   // 이걸 호출해야 유효한 파일이 된다
```

`useSharedStrings`를 끈 게 핵심입니다. 공유 문자열 테이블은 중복 문자열을 한 번만 저장해 파일을 작게 만들지만, 그러려면 **등장한 모든 문자열을 끝까지 들고 있어야** 합니다. 스트리밍으로 메모리를 줄이려는 목적과 정면으로 충돌합니다.

`workbook.commit()`을 빠뜨리면 마무리 메타데이터가 안 써져서 **열리지 않는 파일**이 나갑니다. 에러 경로에서 특히 조심해야 합니다.

그리고 형식 자체의 상한이 있습니다.

> XLSX는 **시트 하나에 1,048,576행, 16,384열**이 한계입니다. 넘는 데이터는 시트를 나눠야 합니다.
> 이 수를 넘길 규모라면 애초에 사람이 열어볼 파일이 아닙니다. CSV나 압축 파일로 주고, 분석은 쿼리로 하도록 유도하는 편이 낫습니다.

## 동기 응답이 숨기는 것

여기까지 오면 메모리는 상수고 커넥션도 짧습니다. 그래도 한 요청 안에서 끝내는 구조에는 고치기 어려운 성질이 남습니다.

**이미 보낸 200은 되돌릴 수 없습니다.** 응답 헤더는 첫 바이트를 쓸 때 나가는데, 그 시점에는 쿼리가 끝까지 성공할지 알 수 없습니다.
중간에 DB가 끊기면 클라이언트는 `200 OK`와 함께 **절반짜리 파일**을 받습니다. 브라우저는 다운로드 성공으로 표시합니다.

그 위에 중간 경로가 있습니다.

- 로드밸런서와 리버스 프록시의 유휴 타임아웃. 기본값이 분 단위로 짧게 잡혀 있는 경우가 많으니 쓰는 제품의 현행 기본값을 확인하세요. 응답이 흐르는 동안에는 유휴가 아니지만, 첫 바이트가 나가기까지 오래 걸리면 거기서 끊깁니다.
- 프록시의 응답 버퍼링. 켜져 있으면 응답 전체를 프록시가 받아 모은 뒤 전달합니다. 서버의 스트리밍이 프록시 메모리와 디스크에서 무력화됩니다.
- 서버리스 런타임의 실행 시간 상한과 응답 크기 제한. 플랫폼마다 다르니 쓰는 쪽 문서를 확인해야 합니다.

**첫 바이트를 빨리 내보내는 게** 이 구간에서는 생각보다 효과적입니다. 헤더 행을 먼저 쓰고 나면 그다음부터는 데이터가 흐르는 연결이 됩니다.

진행률도 줄 수 없습니다. 전체 크기를 미리 모르니 `Content-Length`가 없고, 브라우저는 몇 퍼센트인지 표시하지 못합니다.
수십 초가 걸리는 다운로드에서 진행률이 없으면 사용자는 버튼을 다시 누릅니다. 그러면 같은 작업이 한 벌 더 돕니다.

## 작업으로 떼어내기

동기 응답의 한계가 걸리는 지점이 분명해지면, 내보내기를 요청-응답에서 떼어냅니다.

구조는 셋입니다. 요청을 받아 작업을 등록하고, 워커가 파일을 만들어 오브젝트 스토리지에 올리고, 완료되면 다운로드 링크를 줍니다.

```typescript
// 1) 요청: 바로 반환한다
app.post('/exports', async (req, res) => {
  const jobId = await createExportJob({
    userId: req.user.id,
    params: req.body,
    requestKey: req.header('Idempotency-Key'),   // 두 번 눌러도 한 번만
  });
  res.status(202).json({ jobId, status: 'queued' });
});

// 2) 워커: 스트림을 그대로 S3 멀티파트로 올린다
import { Upload } from '@aws-sdk/lib-storage';
import { PassThrough } from 'node:stream';

async function runExportJob(job: ExportJob) {
  const body = new PassThrough();
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: process.env.EXPORT_BUCKET,
      Key: `exports/${job.id}.csv`,            // 사용자 입력을 키에 쓰지 않는다
      ContentType: 'text/csv; charset=utf-8',
    },
    queueSize: 4,
    leavePartsOnError: false,                   // 실패 시 올라간 파트를 남기지 않는다
  });

  const done = upload.done();
  body.write('﻿');
  for await (const rows of exportChunks(job.params.from)) {
    for (const row of rows) body.write(toCsvLine(row));
  }
  body.end();
  await done;

  await markExportReady(job.id);
}
```

`PassThrough`로 넘기면 파일을 디스크에 떨어뜨리지 않고 바로 올라갑니다. `Upload`가 파트 단위로 나눠 병렬 전송하는데, **메모리는 파트 크기 × 동시 전송 수 정도**로 유지됩니다. 파트 크기 하한이 있어서 이보다 더 줄일 수는 없습니다.

`leavePartsOnError`를 끄는 건 비용 문제입니다. 실패한 멀티파트 업로드의 파트들은 지워지지 않으면 보이지 않는 채로 과금됩니다. 수명 주기 규칙으로 미완료 업로드를 정리하도록 걸어두면 한 겹 더 안전합니다.

다운로드는 프리사인 URL로 줍니다. 파일이 서버를 거치지 않으니 내보내기 트래픽이 애플리케이션에서 완전히 빠집니다.

```typescript
app.get('/exports/:id', async (req, res) => {
  const job = await getExportJob(req.params.id);
  if (job.userId !== req.user.id) return res.sendStatus(404);
  if (job.status !== 'ready') return res.json({ status: job.status });

  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: process.env.EXPORT_BUCKET,
    Key: job.objectKey,
  }), { expiresIn: 300 });

  res.json({ status: 'ready', url });
});
```

권한 검사를 여기서 한다는 게 중요합니다. **프리사인 URL 자체는 가진 사람이 곧 권한**이라, 한 번 새어나가면 유효 기간 동안 누구나 받을 수 있습니다.
[프리사인 업로드](/blog/s3-presigned-upload-validation/)에서 본 성질이 그대로 적용됩니다. 그래서 수명을 길게 주지 말고, 발급 직전에 소유자를 확인하고, 객체 키에 이메일 같은 식별자를 넣지 않습니다.

내보낸 파일은 **원본보다 보호가 약한 복사본**입니다. DB에는 접근 제어가 걸려 있지만 버킷에 떨어진 CSV는 그렇지 않습니다. 보존 기간을 정해 수명 주기 규칙으로 지우는 것까지 설계에 들어가야 합니다.

## 무엇을 고를지

세 구조의 성질을 정리하면 이렇습니다.

| | 동기 전체 적재 | 동기 스트리밍 | 비동기 작업 |
| --- | --- | --- | --- |
| 구현 비용 | 가장 낮음 | 중간 | 높음 (큐·상태·정리) |
| 메모리 | 데이터에 비례 | 상수 | 상수 |
| 실패 처리 | 요청 실패 | 반쯤 받은 파일 | 작업 상태로 표현 |
| 재시도 | 처음부터 | 처음부터 | 커서부터 이어서 |
| 진행률 | 없음 | 없음 | 줄 수 있음 |
| 큰 데이터 | 불가 | 타임아웃에 걸림 | 가능 |

시작은 **동기 스트리밍**이 합리적입니다. 전체 적재보다 확실히 낫고, 비동기 작업만큼 복잡하지 않습니다. 내보내기 수요가 가끔 있는 수준이라면 여기서 충분히 오래 버팁니다.

비동기로 넘어가는 신호는 규모가 아니라 **요구사항의 종류**입니다. 진행률을 보여줘야 하거나, 실패를 사용자에게 설명해야 하거나, 이어받기가 필요해지면 그때는 상태를 가진 작업이 맞습니다. 그 전에 옮기면 큐와 작업 테이블과 정리 배치를 공짜로 얻지 못합니다.

어느 쪽을 쓰든 먼저 할 일은 같습니다. **내보내기를 일반 API와 격리하는 것.** 전용 커넥션 풀이든 별도 프로세스든, 내보내기 하나가 다른 요청의 자원을 먹지 않게 하는 게 순서상 가장 앞입니다.

{% comment %} TODO: 실제로 내보내기를 다룬 경험이 있으면 당시의 데이터 규모와 어떤 구조를 골랐는지, 왜 그렇게 결정했는지 적어주세요 {% endcomment %}

{% comment %} TODO: 아래 섹션은 내용을 채운 뒤 주석을 풀어주세요. 지금 풀면 빈 제목만 렌더됩니다.

## 실제로 겪은 문제

- 내보내기 때문에 생긴 장애나 민원이 있었다면 그 경로와 대응
- 포맷 선택을 두고 실제로 어떤 요구가 있었는지

{% endcomment %}
