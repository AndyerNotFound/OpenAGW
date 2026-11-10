'use strict';
/* ================= Shared path / instance-name vocabulary =================
 * One copy, imported by both pool.js (request routing) and admin.js (create / rename).
 * They used to keep two hand-synced sets, and the copies had drifted: pool.js reserved
 * api / credits / auth / plugins / user / profile, admin.js did not — so the panel happily
 * created an instance named "credits" that the main port can never route to.
 */
const INST_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
// First path segments that belong to the gateway itself: never an instance name
const RESERVED_PATHS = new Set([
  'v1', 'v1beta', 'v1alpha',
  'admin', 'api', 'auth', 'profile', 'plugins', 'dashboard',
  'health', 'status', 'credits', 'user',
  'favicon.ico', 'robots.txt',
]);

// Panel routes: reachable even while the instance is stopped, otherwise stopping an instance
// would also take away the panel that switches it back on.
function isPanelPath(p) {
  return p === '/admin' || p.startsWith('/admin/');
}

module.exports = { INST_NAME_RE, RESERVED_PATHS, isPanelPath };
