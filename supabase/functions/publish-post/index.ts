// publish-post — /admin 에서 받은 글을 _posts/ 에 커밋한다.
//
// 배포:  supabase functions deploy publish-post
// 시크릿: supabase secrets set GITHUB_TOKEN=... ADMIN_USER_ID=... GITHUB_REPO=Enitsed/Enitsed.github.io
//
// 권한 관문은 아래 ADMIN_USER_ID 대조 한 곳뿐이다. 페이지는 공개 저장소에 있으므로
// 존재를 숨길 수 없고, 숨길 필요도 없다.
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://enitsed.github.io",
  "http://localhost:4000",
  "http://127.0.0.1:4000",
];

const SLUG_RE = /^[a-z0-9-]{1,120}$/;
const MAX = { title: 120, excerpt: 200, body: 100_000, tags: 10, tag: 40 };

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

// YAML 이중 인용 문자열. 역슬래시와 따옴표만 이스케이프하면 안전하다.
function yamlString(s: string) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// btoa 는 문자열만 받는다. 스프레드로 넘기면 본문이 길 때 인자 수 상한에 걸리므로 나눠서 만든다.
function base64(bytes: Uint8Array) {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// 파일명에 쓸 날짜는 작성자 기준(KST)이어야 한다. UTC 를 쓰면 밤 9시 이후 글이 하루 앞선다.
function seoulDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ message: "POST 만 허용합니다." }, 405, origin);

  const adminId = Deno.env.get("ADMIN_USER_ID");
  const ghToken = Deno.env.get("GITHUB_TOKEN");
  const repo = Deno.env.get("GITHUB_REPO") ?? "Enitsed/Enitsed.github.io";
  const branch = Deno.env.get("GITHUB_BRANCH") ?? "master";
  if (!adminId || !ghToken) {
    return json({ message: "서버 설정이 완료되지 않았습니다." }, 500, origin);
  }

  // 1. 토큰 검증
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return json({ message: "로그인이 필요합니다." }, 401, origin);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
  );
  const { data: userData, error: userErr } = await sb.auth.getUser(token);
  if (userErr || !userData.user) return json({ message: "로그인이 만료됐습니다." }, 401, origin);

  // 2. 유일한 권한 관문
  if (userData.user.id !== adminId) {
    return json({ message: "이 계정에는 발행 권한이 없습니다." }, 403, origin);
  }

  // 3. 입력 검증
  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ message: "본문을 해석하지 못했습니다." }, 422, origin);
  }

  const title = String(payload.title ?? "").trim();
  const slug = String(payload.slug ?? "").trim();
  const excerpt = String(payload.excerpt ?? "").trim();
  const body = String(payload.body ?? "");
  const tags = Array.isArray(payload.tags) ? payload.tags.map((t) => String(t).trim()).filter(Boolean) : [];

  if (!title || title.length > MAX.title) return json({ message: "제목을 확인해 주세요." }, 422, origin);
  if (!SLUG_RE.test(slug)) return json({ message: "슬러그는 영문 소문자·숫자·하이픈만 쓸 수 있습니다." }, 422, origin);
  if (excerpt.length > MAX.excerpt) return json({ message: "요약이 너무 깁니다." }, 422, origin);
  if (!body.trim() || body.length > MAX.body) return json({ message: "본문을 확인해 주세요." }, 422, origin);
  if (tags.length > MAX.tags || tags.some((t) => t.length > MAX.tag)) {
    return json({ message: "태그를 확인해 주세요." }, 422, origin);
  }

  // 4. 마크다운 조립
  const date = seoulDate();
  const front = [
    "---",
    "layout: post",
    `title: ${yamlString(title)}`,
    `date: ${date}`,
    tags.length ? `tags: [${tags.map(yamlString).join(", ")}]` : null,
    excerpt ? `excerpt: ${yamlString(excerpt)}` : null,
    "---",
    "",
  ].filter(Boolean).join("\n");

  const path = `_posts/${date}-${slug}.md`;
  const gh = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "publish-post-fn",
  };

  // 5. 같은 경로가 이미 있으면 거절한다. sha 를 채워 덮어쓰는 경로는 만들지 않는다.
  const existing = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    { headers: gh },
  );
  if (existing.status === 200) {
    return json({ message: "같은 날짜·슬러그의 글이 이미 있습니다. 슬러그를 바꿔 주세요." }, 409, origin);
  }
  if (existing.status !== 404) {
    return json({ message: "저장소를 확인하지 못했습니다." }, 502, origin);
  }

  // 6. 커밋
  const content = base64(new TextEncoder().encode(front + body.trimEnd() + "\n"));
  const put = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...gh, "Content-Type": "application/json" },
    body: JSON.stringify({ message: `post: ${title}`, content, branch }),
  });

  if (!put.ok) {
    return json({ message: "커밋하지 못했습니다." }, 502, origin);
  }

  const result = await put.json();
  return json({ path, commit_url: result.commit?.html_url ?? null }, 201, origin);
});
