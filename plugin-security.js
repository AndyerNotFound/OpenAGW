'use strict';
/**
 * Intent signature guard — OpenAGW plugin protocol v2
 *
 * Contract (OpenAGW client §3; identical to ai-gateway-core src/plugins.js:753):
 *   X-GC-Sign = HMAC_SHA256(token,
 *     ts \n nonce \n seq \n intentId \n METHOD \n pathname \n sha256(rawBody))
 *
 * What it defends: replay, tampering, sequence rollback. It does NOT defend a
 * stolen card key — the key is the shared secret, so a leaked key can sign.
 *
 * Store: data/plugins-data/<instance>/.gc-security.json (mode 0600, tmp+rename).
 * Written on every commit: a lost seq would let a replay through after a crash.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const permissions = require('./permissions');

const WINDOW_MS = 5 * 60 * 1000;   // ±5 minutes
const NONCE_KEEP = 200;            // keep the newest N nonces per key
const INTENT_KEEP = 100;           // idempotency cache depth
const INTENT_TTL = 24 * 3600 * 1000;

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

class IntentGuard {
  constructor(dataDir, instName, logFn) {
    this.dir = dataDir;
    this.inst = instName;
    this.log = logFn || ((...a) => console.log('[intent]', ...a));
    this.file = path.join(dataDir, '.gc-security.json');
    this.data = { keys: {} };
    this.load();
  }

  load() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && typeof j === 'object' && j.keys) this.data = j;
    } catch (_) { /* first run */ }
  }

  flush() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (e) { this.log('安全记录落盘失败:', e.message); }
  }

  rec(tokenHash) {
    const d = this.data;
    d.keys[tokenHash] = d.keys[tokenHash] || { lastSeq: 0, nonces: [], intents: {} };
    return d.keys[tokenHash];
  }

  /**
   * Verify one intent request.
   * @param {object} o {pluginId, req, params, cfg, findKey}
   *   params: {token, rawBody, ...} from the kernel dispatch
   *   findKey: token => key record | null (built-in card lookup)
   * @returns {{ok:true,keyRecord,_pending}} | {{ok:false,status,error,currentSeq?}}
   */
  verify(o) {
    const req = o.req || {};
    const p = o.params || {};
    const h = req.headers || {};
    const token = p.token || '';
    if (!token) return { ok: false, status: 401, error: '缺少凭据' };

    const ts = Number(h['x-gc-timestamp'] || 0);
    const nonce = String(h['x-gc-nonce'] || '');
    const seq = Number(h['x-gc-seq'] || 0);
    const intentId = String(h['x-gc-intent-id'] || '');
    const sign = String(h['x-gc-sign'] || '');
    if (!ts || !nonce || !seq || !intentId || !sign) {
      return { ok: false, status: 400, error: '缺少签名头 (X-GC-Timestamp/Nonce/Seq/Intent-Id/Sign)' };
    }
    if (Math.abs(Date.now() - ts) > WINDOW_MS) return { ok: false, status: 401, error: '时间戳超出 ±5 分钟窗口' };

    // ownership: the request must land in this plugin's namespace, branch prefix allowed
    const pathname = String(req.url || '').split('?')[0];
    if (!pathname.includes('/plugins/' + o.pluginId + '/')) {
      return { ok: false, status: 403, error: '插件实例归属不匹配' };
    }

    const tokenHash = sha256(token);
    const rec = this.rec(tokenHash);
    if (seq <= (rec.lastSeq || 0)) {
      return { ok: false, status: 401, error: '序列号回滚 (需 > ' + (rec.lastSeq || 0) + ')', currentSeq: rec.lastSeq || 0 };
    }
    if ((rec.nonces || []).includes(nonce)) return { ok: false, status: 401, error: 'nonce 重复' };

    const bodyHash = sha256(p.rawBody || '');
    const expect = crypto.createHmac('sha256', token)
      .update([ts, nonce, seq, intentId, String(req.method || '').toUpperCase(), pathname, bodyHash].join('\n'))
      .digest('hex');
    const a = Buffer.from(expect);
    const b = Buffer.from(sign);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, status: 401, error: '验签失败' };

    /* Burn seq+nonce as soon as the signature is proven. If this only happened in commit(),
       a handler that returns early (validation error, upstream failure) leaves the request
       replayable forever. A burned request is what a nonce is for. */
    if (seq > (rec.lastSeq || 0)) rec.lastSeq = seq;
    rec.nonces = (rec.nonces || []).concat(nonce).slice(-NONCE_KEEP);
    this.flush();

    // credential check: the card must still exist / not be disabled / not expired
    let keyRecord = null;
    const key = o.findKey ? o.findKey(token) : null;
    if (key) {
      if (key.enable === false) return { ok: false, status: 401, error: 'key 已禁用' };
      if (key.expiresAt) {
        const t = new Date(key.expiresAt).getTime();
        if (!isNaN(t) && t < Date.now()) return { ok: false, status: 401, error: 'key 已过期 (' + key.expiresAt + ')' };
      }
      keyRecord = key;
    } else {
      const hasKeys = !!(o.cfg && (o.cfg.apiKeys || []).length);
      if (hasKeys) return { ok: false, status: 401, error: 'invalid key' };
      /* keyless instance: there is no credential to sign with, so an "intent" signed by an
         attacker-chosen token proves nothing. Refuse instead of accepting self-signed requests. */
      return { ok: false, status: 401, error: '本实例未配置卡密, 意图接口不可用' };
    }

    /* a card limited to certain instances must not replay its intent on another one */
    if (keyRecord && !permissions.allowsBranch(keyRecord, this.inst)) {
      return { ok: false, status: 403, error: '此卡密未授权访问实例: ' + this.inst + ' (实例权限: ' + (permissions.list(keyRecord.branches).join(', ') || '全部') + ')' };
    }

    /* idempotency: only a properly signed duplicate gets the cached response */
    if (rec.intents && rec.intents[intentId]) {
      return { ok: true, replay: rec.intents[intentId].response, keyRecord: null };
    }

    return { ok: true, keyRecord, _pending: { tokenHash, seq, nonce, intentId } };
  }

  /** Persist a successful intent so a replayed intentId returns the cached response. */
  commit(pending, response) {
    if (!pending || !pending.intentId) return;
    const rec = this.rec(pending.tokenHash);
    if (pending.seq > (rec.lastSeq || 0)) rec.lastSeq = pending.seq;
    rec.nonces = (rec.nonces || []).concat(pending.nonce).slice(-NONCE_KEEP);
    rec.intents = rec.intents || {};
    rec.intents[pending.intentId] = { ts: Date.now(), response: response === undefined ? null : response };
    const now = Date.now();
    rec.intents = Object.fromEntries(
      Object.entries(rec.intents).filter(([, v]) => now - (v.ts || 0) < INTENT_TTL).slice(-INTENT_KEEP)
    );
    this.flush();
  }
}

module.exports = { IntentGuard, sha256, WINDOW_MS };
