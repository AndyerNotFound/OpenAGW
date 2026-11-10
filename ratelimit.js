'use strict';
/* ================= Per-card rolling-window rate limits =================
 * RPM and TPM are enforced over a 60-second sliding window per card token.
 * State is process-local and deliberately not persisted: a restart only forgets
 * at most the last minute of counters, while config stays free of runtime noise.
 *
 * TPM accounting: a request reserves its estimated prompt tokens on admission and
 * settles to the real input+output usage when it finishes. A failed request releases
 * its reservation, so upstream errors never eat a user's token budget.
 */
const WINDOW_MS = 60 * 1000;
const MAX_EST_TOKENS = 200000;
const buckets = new Map(); // card key -> { req: [ts], tok: [{t, n}], last }

function limitOf(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function bucketOf(key) {
  let b = buckets.get(key);
  if (!b) { b = { req: [], tok: [], last: Date.now() }; buckets.set(key, b); }
  return b;
}

function prune(b, now) {
  const cut = now - WINDOW_MS;
  while (b.req.length && b.req[0] <= cut) b.req.shift();
  while (b.tok.length && b.tok[0].t <= cut) b.tok.shift();
  b.last = now;
}

function tokenSum(b) {
  let n = 0;
  for (const e of b.tok) n += e.n;
  return n;
}

function secs(ms) {
  return Math.max(1, Math.ceil(ms / 1000));
}

// How long until enough of the oldest token entries expire for `need` more tokens
function tpmWaitMs(b, now, need) {
  let over = need;
  for (const e of b.tok) {
    over -= e.n;
    if (over <= 0) return Math.max(1, e.t + WINDOW_MS - now);
  }
  return WINDOW_MS;
}

/* Admission. Returns {ok:true,reservation} or {ok:false,status,error,retryAfter}. */
function admit(uk, estTokens) {
  if (!uk || !uk.key) return { ok: true, reservation: null };
  const rpm = limitOf(uk.rpm);
  const tpm = limitOf(uk.tpm);
  if (!rpm && !tpm) return { ok: true, reservation: null };
  const now = Date.now();
  const b = bucketOf(String(uk.key));
  prune(b, now);

  if (rpm && b.req.length >= rpm) {
    const wait = secs(b.req[0] + WINDOW_MS - now);
    return {
      ok: false, status: 429, retryAfter: wait,
      error: 'RPM 超限: 每分钟 ' + rpm + ' 次, 当前窗口已用 ' + b.req.length + ' 次, ' + wait + ' 秒后重试',
    };
  }

  const est = Math.max(0, Math.min(MAX_EST_TOKENS, Math.round(Number(estTokens) || 0)));
  if (tpm) {
    if (est > tpm) {
      return {
        ok: false, status: 429, retryAfter: 60,
        error: 'TPM 超限: 本次请求预估 ' + est + ' tokens, 超过每分钟上限 ' + tpm,
      };
    }
    const used = tokenSum(b);
    if (used + est > tpm) {
      const wait = secs(tpmWaitMs(b, now, used + est - tpm));
      return {
        ok: false, status: 429, retryAfter: wait,
        error: 'TPM 超限: 每分钟 ' + tpm + ' tokens, 当前窗口已用 ' + used + ', 本次预估 ' + est + ', ' + wait + ' 秒后重试',
      };
    }
  }

  if (rpm) b.req.push(now);
  let entry = null;
  if (tpm) { entry = { t: now, n: est }; b.tok.push(entry); }
  return { ok: true, reservation: entry ? { key: String(uk.key), entry, est } : null };
}

/* Settle a reservation: success replaces the estimate with real usage, failure releases it. */
function settle(reservation, actualTokens, ok) {
  if (!reservation || !reservation.entry) return;
  const b = buckets.get(reservation.key);
  if (!b) return;
  const idx = b.tok.indexOf(reservation.entry);
  if (idx < 0) return;
  if (ok === false) { b.tok.splice(idx, 1); return; }
  const actual = Math.max(0, Math.round(Number(actualTokens) || 0));
  if (actual > 0) reservation.entry.n = actual;
}

/* Current rolling-window usage, for the panel (never persisted). */
function snapshot(uk) {
  if (!uk || !uk.key) return { rpmUsed: 0, tpmUsed: 0 };
  const b = buckets.get(String(uk.key));
  if (!b) return { rpmUsed: 0, tpmUsed: 0 };
  prune(b, Date.now());
  return { rpmUsed: b.req.length, tpmUsed: tokenSum(b) };
}

/* Drop or reset one card's window (card deleted / limits edited). */
function drop(key) { buckets.delete(String(key)); }
function reset(key) { buckets.delete(String(key)); }

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    prune(b, now);
    if (!b.req.length && !b.tok.length && now - b.last > WINDOW_MS * 2) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

module.exports = { admit, settle, snapshot, drop, reset, limitOf, WINDOW_MS };
