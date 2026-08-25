// 댓글 — Supabase Auth + Postgres.
//
// 렌더링은 전부 textContent 로만 한다. 본문·이름·아바타 어디에도 innerHTML 을 쓰지 않는다.
// 줄바꿈은 CSS 의 white-space: pre-wrap 이 처리한다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.4";

const root = document.getElementById("comments");
if (root) init(root);

function init(root) {
  const slug = root.dataset.slug;
  const adminId = root.dataset.admin || "";
  const sb = createClient(root.dataset.url, root.dataset.key);

  const $ = (id) => document.getElementById(id);
  const statusEl = $("comments-status");
  const listEl = $("comments-list");
  const signinEl = $("comments-signin");
  const formEl = $("comments-form");
  const bodyEl = $("comments-body");
  const countEl = $("comments-count");
  const errorEl = $("comments-error");
  const submitEl = $("comments-submit");
  const meNameEl = $("comments-me-name");
  const meAvatarEl = $("comments-me-avatar");

  let session = null;

  // ── 조회 · 렌더 ──────────────────────────────────────────────
  async function load() {
    const { data, error } = await sb
      .from("comments")
      .select("id, user_id, author_name, author_avatar, body, created_at")
      .eq("post_slug", slug)
      .is("deleted_at", null)
      .order("created_at", { ascending: true });

    if (error) {
      // 프로젝트 일시정지·네트워크 실패. 글 본문 읽기는 영향받지 않는다.
      statusEl.textContent = "댓글을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
      statusEl.hidden = false;
      return;
    }

    listEl.replaceChildren(...data.map(render));
    statusEl.textContent = data.length ? `댓글 ${data.length}개` : "첫 댓글을 남겨 보세요.";
    statusEl.hidden = false;
  }

  function render(c) {
    const li = document.createElement("li");
    li.className = "comments__item";

    const head = document.createElement("div");
    head.className = "comments__head";

    const avatar = safeAvatar(c.author_avatar);
    if (avatar) {
      const img = document.createElement("img");
      img.className = "comments__avatar";
      img.src = avatar;
      img.alt = "";
      img.width = 28;
      img.height = 28;
      img.loading = "lazy";
      head.append(img);
    }

    const name = document.createElement("span");
    name.className = "comments__name";
    name.textContent = c.author_name;
    head.append(name);

    const time = document.createElement("time");
    time.className = "comments__time mono-label";
    time.dateTime = c.created_at;
    time.textContent = formatDate(c.created_at);
    head.append(time);

    const uid = session?.user?.id;
    if (uid && (uid === c.user_id || (adminId && uid === adminId))) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "comments__delete";
      del.textContent = "삭제";
      del.addEventListener("click", () => remove(c.id, del));
      head.append(del);
    }

    const body = document.createElement("p");
    body.className = "comments__body";
    body.textContent = c.body;

    li.append(head, body);
    return li;
  }

  // 아바타는 https 스킴만 허용한다. javascript:·data: 로 들어오는 값을 막는다.
  function safeAvatar(url) {
    if (!url) return null;
    try {
      return new URL(url).protocol === "https:" ? url : null;
    } catch {
      return null;
    }
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ── 작성 · 삭제 ──────────────────────────────────────────────
  async function submit(e) {
    e.preventDefault();
    const body = bodyEl.value.trim();
    if (!body) return;

    setError(null);
    submitEl.disabled = true;
    submitEl.textContent = "등록 중…";

    const user = session.user;
    const meta = user.user_metadata || {};
    const { error } = await sb.from("comments").insert({
      post_slug: slug,
      user_id: user.id,
      author_name: meta.user_name || meta.full_name || meta.name || "익명",
      author_avatar: meta.avatar_url || null,
      body,
    });

    submitEl.disabled = false;
    submitEl.textContent = "등록";

    if (error) {
      setError(messageFor(error));
      return;
    }

    bodyEl.value = "";
    updateCount();
    // 낙관적 추가 대신 재조회한다 — 트리거가 거부한 경우를 사용자에게 정확히 알리기 위해.
    await load();
  }

  async function remove(id, btn) {
    if (!window.confirm("이 댓글을 삭제할까요?")) return;
    btn.disabled = true;
    const { error } = await sb
      .from("comments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", id);
    if (error) {
      btn.disabled = false;
      setError("삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      return;
    }
    await load();
  }

  function messageFor(error) {
    if (error.code === "P0001") return "너무 빠르게 여러 개를 작성했습니다. 1분 뒤에 다시 시도해 주세요.";
    if (error.code === "23514") return "댓글은 1자 이상 2000자 이하여야 합니다.";
    if (error.code === "42501") return "권한이 없습니다. 다시 로그인해 주세요.";
    return "댓글을 등록하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }

  function setError(msg) {
    errorEl.textContent = msg || "";
    errorEl.hidden = !msg;
  }

  function updateCount() {
    countEl.textContent = `${bodyEl.value.length} / 2000`;
  }

  // ── 인증 ────────────────────────────────────────────────────
  function applySession(next) {
    session = next;
    const user = session?.user;
    signinEl.hidden = !!user;
    formEl.hidden = !user;

    if (user) {
      const meta = user.user_metadata || {};
      meNameEl.textContent = meta.user_name || meta.full_name || meta.name || "익명";
      const avatar = safeAvatar(meta.avatar_url);
      meAvatarEl.hidden = !avatar;
      if (avatar) meAvatarEl.src = avatar;
    }
  }

  signinEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-provider]");
    if (!btn) return;
    // 로그인 후 읽던 글로 되돌아온다.
    sb.auth.signInWithOAuth({
      provider: btn.dataset.provider,
      options: { redirectTo: location.href },
    });
  });

  $("comments-signout").addEventListener("click", async () => {
    await sb.auth.signOut();
  });

  formEl.addEventListener("submit", submit);
  bodyEl.addEventListener("input", updateCount);

  sb.auth.onAuthStateChange((event, next) => {
    // 최초 세션은 아래 초기화 블록이 이미 처리한다. 여기서 또 부르면 조회가 두 번 나간다.
    if (event === "INITIAL_SESSION") return;
    applySession(next);
    load();
  });

  (async () => {
    const { data } = await sb.auth.getSession();
    applySession(data.session);
    updateCount();
    await load();
  })();
}
