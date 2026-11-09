'use strict';
/**
 * Compatibility layer for plugins ported from ai-gateway-core.
 *
 * Those plugins were written against `<core>/src/router.js`. OpenAGW has no
 * `src/` tree — its equivalents live at the repository root. This file keeps
 * the ported plugin sources byte-identical, so they can be re-synced later.
 *
 * Two call shapes are in use upstream and must both keep working:
 *   core style   : upstreamRequest(opts, ch, url, headers, bodyBuf, cb, method)
 *   probe style  : upstreamRequest({ch, url, method, cb})
 */
const up = require('../upstream.js');
const router = require('../router.js');

const DEFAULTS = () => ({ responseTimeout: 30000, connectTimeout: 15000, proxies: {} });

function upstreamRequest(a, b, c, d, e, f, g) {
  // {ch, url, method, cb, body} — probe / thinking-summary style
  if (a && typeof a === 'object' && a.ch && b === undefined) {
    const o = a;
    return up.upstreamRequest(
      Object.assign(DEFAULTS(), o.cfg || {}),
      o.ch, o.url, o.headers || {}, o.body || Buffer.alloc(0), o.cb, o.method || 'POST'
    );
  }
  // (opts, ch, url, headers, body, cb, method) — balance style
  const cfg = Object.assign(DEFAULTS(), (a && typeof a === 'object') ? a : {});
  return up.upstreamRequest(cfg, b, c, d, e, f, g);
}

module.exports = Object.assign({}, router, {
  upstreamRequest,
  joinUrl: up.joinUrl,
  digPath: up.digPath,
  fetchChannelBalance: (cfg, ch, cb) => up.fetchChannelBalance(Object.assign(DEFAULTS(), cfg || {}), ch, cb),
});
