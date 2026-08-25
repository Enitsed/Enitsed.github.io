// 글 발행 — Supabase Auth 로 얻은 액세스 토큰을 Edge Function 에 넘긴다.
//
// 이 페이지는 공개 저장소에 있으므로 존재 자체를 숨길 수 없다.
// 권한 관문은 전적으로 Edge Function 의 ADMIN_USER_ID 대조(403)다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.112.4";

const root = document.getElementById("admin");
if (root && root.dataset.url) init(root);

function init(root) {
  const sb = createClient(root.dataset.url, root.dataset.key);
  const fnUrl = root.dataset.url.replace(/\/+$/, "") + "/functions/v1/publish-post";

  const $ = (id) => document.getElementById(id);
  const signinEl = $("admin-signin");
  const formEl = $("admin-form");
  const titleEl = $("admin-title");
  const slugEl = $("admin-slug");
  const msgEl = $("admin-msg");
  const submitEl = $("admin-submit");

  let session = null;
  let slugTouched = false;

  // 제목 → 슬러그 자동 생성. 사용자가 직접 고치면 그 뒤로는 건드리지 않는다.
  titleEl.addEventListener("input", () => {
    if (!slugTouched) slugEl.value = slugify(titleEl.value);
  });
  slugEl.addEventListener("input", () => {
    slugTouched = true;
  });

  function slugify(s) {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 120);
  }

  function setMsg(text, kind) {
    msgEl.textContent = text || "";
    msgEl.hidden = !text;
    msgEl.className = "admin__msg" + (kind ? ` admin__msg--${kind}` : "");
  }

  function setMsgWithLink(text, href, label) {
    msgEl.replaceChildren(document.createTextNode(text + " "));
    const a = document.createElement("a");
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = label;
    msgEl.append(a);
    msgEl.hidden = false;
    msgEl.className = "admin__msg admin__msg--ok";
  }

  async function submit(e) {
    e.preventDefault();
    setMsg(null);
    submitEl.disabled = true;
    submitEl.textContent = "발행 중…";

    const payload = {
      title: titleEl.value.trim(),
      slug: slugEl.value.trim(),
      tags: $("admin-tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      excerpt: $("admin-excerpt").value.trim(),
      body: $("admin-body").value,
    };

    try {
      const res = await fetch(fnUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(payload),
      });

      const result = await res.json().catch(() => ({}));

      if (res.ok) {
        if (result.commit_url) {
          setMsgWithLink("발행됐습니다. 사이트 반영까지 1~2분 걸립니다.", result.commit_url, "커밋 보기 ↗");
        } else {
          setMsg("발행됐습니다. 사이트 반영까지 1~2분 걸립니다.", "ok");
        }
        formEl.reset();
        slugTouched = false;
      } else {
        setMsg(result.message || errorFor(res.status), "err");
      }
    } catch {
      setMsg("네트워크 오류로 발행하지 못했습니다.", "err");
    }

    submitEl.disabled = false;
    submitEl.textContent = "발행";
  }

  function errorFor(status) {
    if (status === 401) return "로그인이 만료됐습니다. 다시 로그인해 주세요.";
    if (status === 403) return "이 계정에는 발행 권한이 없습니다.";
    if (status === 409) return "같은 날짜·슬러그의 글이 이미 있습니다. 슬러그를 바꿔 주세요.";
    if (status === 422) return "입력값을 확인해 주세요.";
    return "발행하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }

  function applySession(next) {
    session = next;
    const user = session?.user;
    signinEl.hidden = !!user;
    formEl.hidden = !user;
    if (user) {
      const meta = user.user_metadata || {};
      $("admin-me-name").textContent = meta.user_name || meta.full_name || meta.name || user.email || "";
    }
  }

  signinEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-provider]");
    if (!btn) return;
    sb.auth.signInWithOAuth({
      provider: btn.dataset.provider,
      options: { redirectTo: location.href },
    });
  });

  $("admin-signout").addEventListener("click", () => sb.auth.signOut());
  formEl.addEventListener("submit", submit);

  sb.auth.onAuthStateChange((_event, next) => applySession(next));
  (async () => {
    const { data } = await sb.auth.getSession();
    applySession(data.session);
  })();
}
