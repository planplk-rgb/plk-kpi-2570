/* PLK KPI — runtime adapter.
   The app (index.html) talks to `window.claude.use("db" | "user" | "downloads")`.
   This file provides that interface on top of either:
     - mode "server": the Node.js server in server/server.js (REST + Server-Sent Events), or
     - mode "demo":   the browser's localStorage, for the GitHub Pages demo.
   window.PLK_CONFIG is set by config.js before this file loads. */
(function () {
  const CFG = window.PLK_CONFIG || { mode: "demo" };
  window.PLK_LIBS = window.PLK_LIBS || { h2c: "vendor/html2canvas.min.js", pdf: "vendor/jspdf.umd.min.js", xlsx: "vendor/xlsx.full.min.js", docx: "vendor/docx.umd.js" };
  const MODE = CFG.mode === "server" ? "server" : "demo";
  const rid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const err = (code, message) => Object.assign(new Error(message || code), { code });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const matchWhere = (d, filters) => filters.every(([f, op, v]) => {
    const x = d ? d[f] : undefined;
    if (op === "==") return x === v; if (op === "!=") return x !== v;
    if (op === "in") return Array.isArray(v) && v.includes(x); if (op === "not-in") return Array.isArray(v) && !v.includes(x);
    if (op === "array-contains") return Array.isArray(x) && x.includes(v);
    if (op === "<") return x < v; if (op === "<=") return x <= v; if (op === ">") return x > v; if (op === ">=") return x >= v;
    return false;
  });
  const merge = (a, b) => { const o = { ...(a || {}) }; for (const [k, v] of Object.entries(b || {})) o[k] = v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object" && !Array.isArray(o[k]) ? merge(o[k], v) : v; return o; };

  /* ---------- avatars ---------- */
  function colorOf(id) { let h = 0; for (const c of String(id || "x")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 45% 42%)`; }
  function avatar(name, id) {
    const t = (String(name || "?").trim()[0] || "?").toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="32" fill="${colorOf(id)}"/><text x="32" y="41" font-size="28" text-anchor="middle" fill="#fff" font-family="sans-serif">${esc(t)}</text></svg>`;
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  /* ================= BACKENDS ================= */
  function serverBackend() {
    const j = async (url, opt) => {
      const r = await fetch(url, { credentials: "same-origin", headers: { "content-type": "application/json" }, ...(opt || {}) });
      if (r.status === 401 || r.status === 403) { const b = await r.json().catch(() => ({})); throw err("invalid_argument", b.error || "not allowed"); }
      if (!r.ok) throw err("unavailable", "HTTP " + r.status);
      return r.json();
    };
    const listeners = new Set();
    let es = null;
    function connect() {
      try {
        es = new EventSource("api/events");
        es.onmessage = (e) => { try { const m = JSON.parse(e.data); listeners.forEach((f) => f(m.path)); } catch (x) {} };
        es.onerror = () => {};
      } catch (x) {}
      setInterval(() => listeners.forEach((f) => f("*")), 60000);
    }
    return {
      session: () => j("api/session"),
      getDoc: (p) => j("api/doc?path=" + encodeURIComponent(p)),
      query: (c, w) => j("api/query?coll=" + encodeURIComponent(c) + "&where=" + encodeURIComponent(JSON.stringify(w || []))),
      write: (op, path, data) => j("api/write", { method: "POST", body: JSON.stringify({ op, path, data }) }),
      onChange(f) { listeners.add(f); if (!es) connect(); },
      profiles: (ids) => j("api/profiles?ids=" + encodeURIComponent(ids.join(","))),
      search: (q) => j("api/search?q=" + encodeURIComponent(q)),
      login: (u, p) => j("api/login", { method: "POST", body: JSON.stringify({ username: u, password: p }) }),
      register: (b) => j("api/register", { method: "POST", body: JSON.stringify(b) }),
      logout: () => j("api/logout", { method: "POST", body: "{}" }),
      changePassword: (o, n) => j("api/me/password", { method: "POST", body: JSON.stringify({ oldPassword: o, newPassword: n }) }),
      accounts: () => j("api/accounts"),
      updateAccount: (id, patch) => j("api/accounts/" + encodeURIComponent(id), { method: "POST", body: JSON.stringify(patch) }),
      audit: (n) => j("api/audit?limit=" + (n || 200)),
      backup: () => j("api/backup"),
      restore: (data) => j("api/restore", { method: "POST", body: JSON.stringify(data) }),
    };
  }

  function demoBackend() {
    const KEY = "plk-kpi-demo-v1", RKEY = "plk-kpi-demo-role";
    const ACCOUNTS0 = [
      { id: "u_demo_admin", username: "admin", name: "ผู้ดูแลระบบ (ทดลอง)", role: "admin", status: "active" },
      { id: "u_demo_resp", username: "resp", name: "ผู้รับผิดชอบ กลุ่มงานส่งเสริมสุขภาพ (ทดลอง)", role: "user", status: "active" },
      { id: "u_demo_new", username: "newuser", name: "ผู้ใช้ใหม่ ยังไม่ได้รับสิทธิ์ (ทดลอง)", role: "user", status: "active" },
    ];
    let st = null;
    const load = () => { try { st = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { st = null; } };
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {} };
    let ready = null;
    async function init() {
      load();
      if (st && st.docs) return;
      let seed = { docs: {} };
      try { seed = await (await fetch("seed.json")).json(); } catch (e) {}
      st = { docs: seed.docs || {}, accounts: ACCOUNTS0, audit: [] };
      st.docs["members/u_demo_resp"] = { status: "approved", depts: ["กลุ่มงานส่งเสริมสุขภาพ"], approvedBy: "u_demo_admin", approvedAt: new Date().toISOString() };
      save();
    }
    const role = () => { try { return localStorage.getItem(RKEY) || "admin"; } catch (e) { return "admin"; } };
    const me = () => { const r = role(); const id = r === "admin" ? "u_demo_admin" : r === "resp" ? "u_demo_resp" : r === "new" ? "u_demo_new" : null; return id ? (st.accounts.find((a) => a.id === id) || null) : null; };
    const store = { get: (p) => (st.docs[p] ? st.docs[p] : null) };
    const listeners = new Set();
    window.addEventListener("storage", (e) => { if (e.key === KEY) { load(); listeners.forEach((f) => f("*")); } });
    const R = window.PLKRules;
    const w = (f) => async (...a) => { await (ready = ready || init()); return f(...a); };
    return {
      demo: true, role, setRole(r) { try { localStorage.setItem(RKEY, r); } catch (e) {} },
      reset() { try { localStorage.removeItem(KEY); } catch (e) {} },
      session: w(async () => ({ user: me(), publicRead: true })),
      getDoc: w(async (p) => { if (!R.canRead(me(), p, true)) return { exists: false }; const d = st.docs[p]; return d ? { exists: true, data: clone(d) } : { exists: false }; }),
      query: w(async (c, filters) => Object.entries(st.docs).filter(([p, d]) => p.startsWith(c + "/") && p.split("/").length === 2 && R.canRead(me(), p, true) && matchWhere(d, filters || [])).map(([p, d]) => ({ id: p.split("/")[1], data: clone(d) }))),
      write: w(async (op, path, data) => {
        const u = me(); const prev = st.docs[path];
        if (op === "update" && !prev) throw err("invalid_argument", "document does not exist");
        const body = op === "update" ? merge(prev, data) : data;
        const chk = R.checkWrite(u, path, body, op, store);
        if (!chk.ok) throw err("invalid_argument", chk.reason);
        if (op === "delete") delete st.docs[path]; else st.docs[path] = clone(chk.data);
        st.audit.unshift({ at: new Date().toISOString(), by: u && u.id, op, path }); st.audit = st.audit.slice(0, 300);
        save(); listeners.forEach((f) => f(path)); return { ok: true };
      }),
      onChange(f) { listeners.add(f); },
      profiles: w(async (ids) => Object.fromEntries(ids.map((id) => { const a = st.accounts.find((x) => x.id === id); return [id, { name: a ? a.name : "" }]; }))),
      search: w(async (q) => { if (!me()) return []; q = String(q || "").toLowerCase(); return st.accounts.filter((a) => !q || a.name.toLowerCase().includes(q) || a.username.includes(q)).slice(0, 8).map((a) => ({ id: a.id, name: a.name, email: null })); }),
      accounts: w(async () => st.accounts.map((a) => ({ ...a }))),
      updateAccount: w(async (id, patch) => { const a = st.accounts.find((x) => x.id === id); if (!a) throw err("invalid_argument", "no account"); if (patch.role) a.role = patch.role; if (patch.status) a.status = patch.status; if (patch.name) a.name = patch.name; save(); return { ok: true }; }),
      audit: w(async () => st.audit),
      backup: w(async () => ({ version: 1, docs: st.docs })),
      restore: w(async (data) => { if (!data || !data.docs) throw err("invalid_argument", "bad backup"); st.docs = data.docs; save(); listeners.forEach((f) => f("*")); return { ok: true }; }),
    };
  }

  const B = MODE === "server" ? serverBackend() : demoBackend();

  /* ================= db namespace ================= */
  function makeDb() {
    const subs = new Set();
    B.onChange((path) => { for (const s of subs) if (path === "*" || s.match(path)) s.schedule(); });
    const snapDoc = (path, r) => ({ id: path.split("/").pop(), exists: !!(r && r.exists), data: () => (r && r.exists ? r.data : undefined), metadata: { fromCache: false, hasPendingWrites: false } });
    const snapQ = (rows) => { const docs = rows.map((x) => ({ id: x.id, exists: true, data: () => x.data, metadata: { fromCache: false, hasPendingWrites: false } })); return { docs, size: docs.length, empty: !docs.length, docChanges: () => docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })), metadata: { fromCache: false, hasPendingWrites: false } }; };
    function sub(match, fetcher, next, onErr) {
      let t = null, alive = true;
      const s = { match, schedule() { if (t) return; t = setTimeout(async () => { t = null; if (!alive) return; try { next(await fetcher()); } catch (e) { onErr && onErr(e); } }, 40); } };
      subs.add(s); s.schedule();
      return () => { alive = false; subs.delete(s); };
    }
    const write = async (op, path, data) => { await B.write(op, path, data); };
    function docRef(path) {
      return {
        id: path.split("/").pop(), path,
        get: async () => snapDoc(path, await B.getDoc(path)),
        set: (d) => write("set", path, d), update: (d) => write("update", path, d), delete: () => write("delete", path),
        onSnapshot: (next, onErr) => sub((p) => p === path, async () => snapDoc(path, await B.getDoc(path)), next, onErr),
        collection: (c) => collRef(path + "/" + c),
        acquire: async () => ({ acquired: true }),
      };
    }
    function collRef(c, filters) {
      filters = filters || [];
      const depth = c.split("/").length + 1;
      const q = {
        path: c,
        where: (f, op, v) => collRef(c, [...filters, [f, op, v]]),
        orderBy: () => q, limit: () => q,
        get: async () => snapQ(await B.query(c, filters)),
        onSnapshot: (next, onErr) => sub((p) => p.startsWith(c + "/") && p.split("/").length === depth, async () => snapQ(await B.query(c, filters)), next, onErr),
        doc: (id) => docRef(c + "/" + (id || rid())),
        add: async (d) => { const r = docRef(c + "/" + rid()); await r.set(d); return r; },
      };
      return q;
    }
    return Object.freeze({ doc: docRef, collection: (c) => collRef(c) });
  }

  /* ================= user namespace ================= */
  let sessionP = null;
  const session = () => (sessionP = sessionP || B.session().catch(() => ({ user: null, publicRead: false })));
  function makeUser() {
    const meObj = async () => { const s = await session(); const u = s.user; return { id: u ? u.id : null, name: u ? u.name : "", avatarUrl: avatar(u ? u.name : "?", u ? u.id : "anon"), color: colorOf(u && u.id), email: u ? u.email || null : null, isOwner: !!(u && u.role === "admin"), canEdit: !!(u && u.role === "admin") }; };
    return Object.freeze({
      me: meObj,
      id: async () => (await meObj()).id,
      name: async () => (await meObj()).name,
      isOwner: async () => (await meObj()).isOwner,
      canEdit: async () => (await meObj()).canEdit,
      can: async (cap) => { const m = await meObj(); if (cap === "data.write") return !!m.id; if (cap === "files.write") return m.canEdit; return false; },
      profiles: async (ids) => { ids = [...new Set([].concat(ids || []))]; let r = {}; try { r = await B.profiles(ids); } catch (e) {} const myId = (await meObj()).id; return Object.fromEntries(ids.map((id) => { const n = (r[id] && r[id].name) || ""; return [id, { id, name: n, avatarUrl: avatar(n || "?", id), color: colorOf(id), email: null, isMe: id === myId, guest: false }]; })); },
      search: async (q) => { let r = []; try { r = await B.search(q || ""); } catch (e) {} return r.map((h) => ({ id: h.id, name: h.name, avatarUrl: avatar(h.name, h.id), color: colorOf(h.id), email: h.email || null, isMe: false, guest: false })); },
    });
  }

  /* ================= downloads ================= */
  const downloads = Object.freeze({
    save: async ({ filename, data }) => {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const url = URL.createObjectURL(blob); const a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000); return { status: "saved" };
    },
  });

  const DB = makeDb(), USER = makeUser();
  window.claude = Object.freeze({ use: async (name) => (name === "db" ? DB : name === "user" ? USER : name === "downloads" ? downloads : null) });

  /* ================= host features for the admin pages ================= */
  window.PLK_HOST = {
    mode: MODE,
    accounts: () => B.accounts(), updateAccount: (id, p) => B.updateAccount(id, p),
    audit: (n) => B.audit(n), backup: () => B.backup(), restore: (d) => B.restore(d),
  };

  /* ================= login / role UI ================= */
  function modal(html, onMount) {
    const bg = document.createElement("div");
    bg.className = "drawer-bg"; bg.style.zIndex = 70;
    const box = document.createElement("div");
    box.setAttribute("role", "dialog"); box.setAttribute("aria-modal", "true");
    box.style.cssText = "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:71;background:var(--surface);color:var(--fg);border:1px solid var(--line);border-radius:14px;padding:22px;width:min(420px,calc(100% - 32px));box-shadow:0 20px 60px rgba(0,0,0,.25)";
    box.innerHTML = html; document.body.append(bg, box);
    const close = () => { bg.remove(); box.remove(); };
    bg.onclick = close; box.querySelectorAll("[data-x]").forEach((b) => (b.onclick = close));
    onMount && onMount(box, close); const f = box.querySelector("input"); f && f.focus();
    return close;
  }
  function loginDialog(tab) {
    modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="font-size:19px;margin:0">${tab === "reg" ? "สมัครใช้งาน" : "เข้าสู่ระบบ"}</h2><button class="btn small" data-x>ปิด</button></div>
      <form id="authF" class="form" style="grid-template-columns:1fr">
        <label class="f"><span>ชื่อผู้ใช้</span><input id="aU" autocomplete="username" required></label>
        <label class="f"><span>รหัสผ่าน${tab === "reg" ? " (อย่างน้อย 8 ตัวอักษร)" : ""}</span><input id="aP" type="password" autocomplete="${tab === "reg" ? "new-password" : "current-password"}" required></label>
        ${tab === "reg" ? `<label class="f"><span>ชื่อ-สกุล</span><input id="aN" required></label><label class="f"><span>อีเมล (ไม่บังคับ)</span><input id="aE" type="email"></label>` : ""}
        <p class="note" id="aMsg" style="margin:0;color:var(--fail)"></p>
        <div class="save-row"><button type="button" class="btn small" id="aSw">${tab === "reg" ? "มีบัญชีแล้ว เข้าสู่ระบบ" : "ยังไม่มีบัญชี สมัครใช้งาน"}</button><button class="btn primary" type="submit">${tab === "reg" ? "สมัครใช้งาน" : "เข้าสู่ระบบ"}</button></div>
        ${tab === "reg" ? '<p class="note" style="margin:0">สมัครแล้วเข้าแท็บ “ลงทะเบียน/บันทึกผล” เพื่อขอสิทธิ์บันทึกผลจากผู้ดูแลระบบ</p>' : ""}
      </form>`, (box, close) => {
      box.querySelector("#aSw").onclick = () => { close(); loginDialog(tab === "reg" ? "login" : "reg"); };
      box.querySelector("#authF").onsubmit = async (e) => {
        e.preventDefault(); const m = box.querySelector("#aMsg");
        try {
          if (tab === "reg") await B.register({ username: box.querySelector("#aU").value.trim(), password: box.querySelector("#aP").value, name: box.querySelector("#aN").value.trim(), email: box.querySelector("#aE").value.trim() });
          else await B.login(box.querySelector("#aU").value.trim(), box.querySelector("#aP").value);
          location.reload();
        } catch (x) { m.textContent = x.message === "not allowed" ? "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" : x.message; }
      };
    });
  }
  function passwordDialog() {
    modal(`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><h2 style="font-size:19px;margin:0">เปลี่ยนรหัสผ่าน</h2><button class="btn small" data-x>ปิด</button></div>
      <form id="pwF" class="form" style="grid-template-columns:1fr"><label class="f"><span>รหัสผ่านเดิม</span><input id="pO" type="password" autocomplete="current-password" required></label>
      <label class="f"><span>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</span><input id="pN" type="password" autocomplete="new-password" required></label><p class="note" id="pMsg" style="margin:0"></p>
      <div class="save-row"><button class="btn primary" type="submit">บันทึก</button></div></form>`, (box, close) => {
      box.querySelector("#pwF").onsubmit = async (e) => { e.preventDefault(); try { await B.changePassword(box.querySelector("#pO").value, box.querySelector("#pN").value); close(); } catch (x) { box.querySelector("#pMsg").textContent = x.message; } };
    });
  }
  window.PLK_AUTH = {
    /** HTML for the header; the app calls this after it knows who is viewing. */
    button(me) {
      if (MODE === "demo") {
        const r = B.role();
        return `<label class="demo-role" title="โหมดทดลอง: สลับบทบาทเพื่อดูแต่ละส่วน">บทบาท <select id="demoRole">
          <option value="admin" ${r === "admin" ? "selected" : ""}>ผู้ดูแลระบบ</option><option value="resp" ${r === "resp" ? "selected" : ""}>ผู้รับผิดชอบ (ส่งเสริมสุขภาพ)</option>
          <option value="new" ${r === "new" ? "selected" : ""}>ผู้ใช้ใหม่ ยังไม่ได้รับสิทธิ์</option><option value="guest" ${r === "guest" ? "selected" : ""}>ผู้เยี่ยมชม (ไม่ล็อกอิน)</option></select></label>
          <button class="btn small" id="demoReset" title="ล้างข้อมูลที่ทดลองบันทึกในเบราว์เซอร์นี้">ล้างข้อมูลทดลอง</button>`;
      }
      return me && me.id ? `<button class="btn small" id="pwBtn">เปลี่ยนรหัสผ่าน</button><button class="btn small" id="logoutBtn">ออกจากระบบ</button>` : `<button class="btn small primary" id="loginBtn">เข้าสู่ระบบ</button>`;
    },
  };
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button,select"); if (!t) return;
    if (t.id === "loginBtn") loginDialog("login");
    if (t.id === "logoutBtn") B.logout().finally(() => location.reload());
    if (t.id === "pwBtn") passwordDialog();
    if (t.id === "demoReset") { B.reset(); location.reload(); }
  });
  document.addEventListener("change", (e) => { if (e.target.id === "demoRole") { B.setRole(e.target.value); location.reload(); } });
})();
