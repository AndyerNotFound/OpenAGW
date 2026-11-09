'use strict';
/* ================= Endpoint completion (bare base URL) =================
 * A client whose base URL stops at the host — http://127.0.0.1:16384 with no /v1 —
 * still reaches the same endpoints: the missing /v1 is filled in before routing, so
 *   POST /chat/completions  ≡  POST /v1/chat/completions
 *   POST /messages          ≡  POST /v1/messages
 *   GET  /models            ≡  GET  /v1/models
 *   POST /images/generations ≡ POST /v1/images/generations   (and the rest of the passthrough set)
 *
 * Deliberately a shape list, not a blanket "prefix every path":
 *   - only known OpenAI-dialect endpoints and their sub-paths are completed;
 *   - the closed prefixes (/health /status /auth /admin /plugins /api/app …) are absent,
 *     so completion can never re-open a route the whitelist closed;
 *   - an already-prefixed path is returned unchanged (idempotent), and a bare path that is
 *     not in the list (/balance, /dashboard/billing/…) keeps its old 404.
 * The mirror mistake is handled too: a base URL that already ends in /v1 and a client that
 * appends its own version yields /v1/v1/chat/completions — the doubled segment is collapsed.
 * Instance routing is decided in server.js before this runs: an existing instance name always
 * wins, so /<instance>/chat/completions completes after the prefix is stripped.
 */
const EXACT = new Set([
  '/chat/completions', '/completions', '/messages', '/responses',
  '/embeddings', '/moderations', '/models',
  '/images/generations', '/images/edits', '/images/variations',
  '/audio/speech', '/audio/transcriptions', '/audio/translations',
  '/files', '/batches', '/vector_stores', '/uploads',
  '/fine_tuning/jobs', '/assistants', '/threads',
  '/evals', '/containers',
  '/branches',   // gateway-owned: the branch list this card may reach
]);
const PREFIXES = [
  '/models/',    // GET /models/{id} + Gemini /models/{model}:generateContent
  '/messages/',  // Claude /messages/count_tokens
  '/responses/',
  '/images/', '/audio/',
  '/files/', '/batches/', '/vector_stores/', '/uploads/',
  '/fine_tuning/', '/assistants/', '/threads/',
  '/evals/', '/containers/',
];

// A base URL that already ends in /v1 plus a client that appends its own version:
//   /v1/v1/chat/completions → /v1/chat/completions, /v1beta/v1beta/models/… → /v1beta/models/…
const DUP_VERSION = /^\/(v1beta|v1alpha|v1)(?:\/\1)+(?=\/|$)/;

// Is q a real endpoint once a /v1 | /v1beta | /v1alpha prefix is stripped?
function isKnownEndpoint(q) {
  const m = /^\/(v1beta|v1alpha|v1)(\/.*)$/.exec(q);
  if (!m) return false;
  const rest = m[2];
  if (EXACT.has(rest)) return true;
  return PREFIXES.some(pre => rest.startsWith(pre));
}

/* Every rewrite below is proposed as a candidate and only accepted when it lands on an endpoint
 * this gateway really serves (isKnownEndpoint). That is what keeps completion from touching the
 * passthrough set: /v1/v1/health or /v1//foo keep going upstream exactly as the client wrote them.
 *   base URL + no /v1        → /models          → /v1/models
 *   base URL + trailing /    → /chat/completions/ → /v1/chat/completions
 *   base URL + doubled /     → /v1//models      → /v1/models
 *   base URL ending in /v1   → /v1/v1/messages  → /v1/messages
 */
function completePath(p) {
  if (typeof p !== 'string' || p.length < 2 || p[0] !== '/') return p;
  const slash = p.replace(/\/{2,}/g, '/');
  const trimmed = slash.replace(/\/+$/, '') || '/';
  const out = [];
  if (slash !== p) out.push(slash);
  if (trimmed !== slash) out.push(trimmed);
  for (const base of (trimmed === slash ? [slash] : [trimmed, slash])) {
    const dedup = base.replace(DUP_VERSION, '/$1');
    if (dedup !== base && dedup !== slash) out.push(dedup);
    if (EXACT.has(dedup)) out.push('/v1' + dedup);
    for (const pre of PREFIXES) if (dedup.startsWith(pre)) out.push('/v1' + dedup);
  }
  for (const q of out) if (isKnownEndpoint(q)) return q;
  return p;
}

// First segments that can only ever be an API endpoint — never an instance name.
// poolRoute uses this to decide whether an unknown first segment is a typo'd instance (404, the
// error stays visible) or an endpoint reached through a bare base URL (falls through to default).
const HEADS = new Set();
for (const e of EXACT) HEADS.add(e.split('/')[1]);
for (const pre of PREFIXES) HEADS.add(pre.split('/')[1]);

function isEndpointHead(seg) { return HEADS.has(seg); }

module.exports = { completePath, isKnownEndpoint, isEndpointHead, HEADS, EXACT, PREFIXES };
