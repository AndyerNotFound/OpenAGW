'use strict';
/* ================= Secret admin surface =================
 * The admin panel listens at one secret shape on every port:
 *
 *   /<sid>/admin/<token>   one-time link; afterwards /<sid>/admin/... with the session cookie
 *
 * <sid> is the per-instance panel session id; the user-facing API keeps its old bare paths
 * (/v1, /v1beta, /api/app, /plugins), so standard OpenAI clients need no URL changes.
 * A path shaped like /<sid>/admin that no instance owns answers 404 -- the panel cannot be
 * found by probing /admin or /auth.
 */
const panelAuth = require('./panel-auth');

const ADMIN_RE = /^\/([A-Za-z0-9_-]{16,128})\/admin(?=\/|$)/;

function nameOf(cfg) {
  if (cfg && cfg._name) return String(cfg._name);
  return panelAuth.instName(cfg);
}

/* Returns one of:
 *   null                     not an admin path -- the caller keeps its normal routing
 *   { unknown: true }        admin shape but no instance owns this sid -> 404
 *   { cfg, name, sid, path } matched; `path` is /admin/... with the sid segment stripped */
function surfaceMatch(instances, p) {
  const m = ADMIN_RE.exec(p);
  if (!m) return null;
  const sid = m[1];
  for (const c of instances) {
    const st = panelAuth.readCached(c, nameOf(c));
    if (st && panelAuth.safeEqual(st.sid, sid)) {
      return { cfg: c, name: nameOf(c), kind: 'admin', sid, path: p.slice(sid.length + 1) || '/' };
    }
  }
  return { unknown: true };
}

module.exports = { surfaceMatch, ADMIN_RE };
