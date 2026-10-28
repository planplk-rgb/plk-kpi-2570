/* PLK KPI — access rules shared by the server (server/server.js) and the GitHub Pages demo (public/shim.js).
   A "user" is {id, role:"admin"|"user", status:"active"|"disabled"} or null for an anonymous visitor.
   "store" is an object with get(path) → data|null, used to look up KPI and member documents. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PLKRules = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PUBLIC_COLLS = ["kpis", "settings", "results", "hdc"];
  const ADMIN_WRITE = ["kpis", "settings", "hdc", "members"];
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;

  function split(path) {
    const s = String(path || "").split("/");
    if (!s.length || s.some((x) => !SEG.test(x) || x === "." || x === "..")) throw new Error("bad path");
    return s;
  }
  const isAdmin = (u) => !!u && u.role === "admin" && u.status !== "disabled";
  const isActive = (u) => !!u && u.status !== "disabled";

  /** Can this user edit results of this KPI? Admins always; others when approved for the KPI's group (or the parent KPI's group), or named as owner. */
  function canEnterKpi(u, kpiId, store) {
    if (isAdmin(u)) return true;
    if (!isActive(u)) return false;
    const k = store.get("kpis/" + kpiId);
    if (!k) return false;
    const par = k.parent ? store.get("kpis/" + k.parent) : null;
    if ((k.owners || []).includes(u.id) || (par && (par.owners || []).includes(u.id))) return true;
    const m = store.get("members/" + u.id);
    if (!m || m.status !== "approved") return false;
    const d = m.depts || [];
    return d.includes(k.dept) || !!(par && d.includes(par.dept));
  }

  function canRead(u, path, publicRead) {
    const [c, id] = split(path);
    if (PUBLIC_COLLS.includes(c)) return publicRead || isActive(u);
    if (c === "members") return isActive(u);
    if (c === "requests") return isAdmin(u) || (isActive(u) && (id === undefined ? false : id === u.id));
    return isAdmin(u);
  }

  /** Returns {ok:true, data} with server-controlled fields applied, or {ok:false, reason}. op is "set" | "update" | "delete". */
  function checkWrite(u, path, data, op, store) {
    const s = split(path);
    if (s.length !== 2) return { ok: false, reason: "path must be collection/document" };
    const [c, id] = s;
    if (!isActive(u)) return { ok: false, reason: "login required" };
    const now = new Date().toISOString();
    if (ADMIN_WRITE.includes(c)) return isAdmin(u) ? { ok: true, data } : { ok: false, reason: "admin only" };
    if (c === "requests") {
      if (isAdmin(u)) return { ok: true, data };
      if (id !== u.id) return { ok: false, reason: "own request only" };
      if (op === "delete") return { ok: true, data };
      return { ok: true, data: { ...(data || {}), uid: u.id, status: "pending", requestedAt: now } };
    }
    if (c === "results") {
      const kpiId = id.split("~")[0];
      if (!canEnterKpi(u, kpiId, store)) return { ok: false, reason: "no permission for this KPI" };
      if (op === "delete") return { ok: true, data };
      return { ok: true, data: { ...(data || {}), updatedBy: u.id, updatedAt: now } };
    }
    return isAdmin(u) ? { ok: true, data } : { ok: false, reason: "admin only" };
  }

  return { canRead, checkWrite, canEnterKpi, split, isAdmin };
});
