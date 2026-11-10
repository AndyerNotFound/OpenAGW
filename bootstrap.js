'use strict';
/**
 * GET /api/app/bootstrap — the OpenAGW client's entry point.
 *
 * The App is a renderer with no business state: everything it shows on first
 * contact comes from here — site profile, layout, auth capabilities, plugin
 * disclosure (sha256 + permissions), SDUI page registry, runtime capabilities.
 *
 * Field names mirror the OpenAGW client's Bootstrap / PluginInfo / ThemeInfo data classes;
 * the client treats every field as optional, so partial data degrades instead of
 * crashing. This server is single-tenant: uid is always 1 and there are no
 * accounts, so `auth.user` stays false and `userDebug` stays null.
 */
const { VERSION } = require('./util');
const { availableBranches } = require('./router');

const DEFAULT_LAYOUT = {
  version: 1,
  bottomBar: ['home', 'personal', 'settings'],
  hidden: [],
  homeOrder: [],
  theme: 'theme-md3',
};

const DEFAULT_SERVER_INFO = {
  name: '',
  description: '',
  icon: null,
  announcement: '',
  contact: '',
  website: '',
  currencySymbol: '¥',
  currencyRate: 1,
};

const NO_REGISTRATION = {
  enable: false, minPasswordLen: 8, captchaProvider: 'none', captchaSiteKey: '', emailVerify: false,
};

/** Any of Bearer / x-api-key / x-goog-api-key / ?key= — same rule as the chat endpoints. */
function tokenOf(req, u) {
  const h = (req && req.headers) || {};
  const a = String(h.authorization || '');
  if (a.startsWith('Bearer ')) return a.slice(7).trim();
  return h['x-api-key'] || h['x-goog-api-key'] || (u && u.searchParams.get('key')) || '';
}

function buildBootstrap(cfg, kernel, req, u) {
  const inst = (cfg && cfg._name) || 'default';
  const token = tokenOf(req, u);
  const uk = token ? ((cfg.apiKeys || []).find(k => k && k.key === token) || null) : null;
  let branches = [inst];
  try { branches = availableBranches(cfg, uk) || branches; } catch (_) {}

  return {
    ok: true,
    core: VERSION,
    appApi: 1,
    branch: inst,
    uid: 1,
    serverInfo: Object.assign({}, DEFAULT_SERVER_INFO, cfg.serverInfo || {}, { name: (cfg.serverInfo && cfg.serverInfo.name) || inst }),
    userDebug: cfg.userDebug || null,
    layout: Object.assign({}, DEFAULT_LAYOUT, cfg.layout || {}),
    branches: branches.map((n, i) => ({ name: n, uid: i + 1 })),
    auth: {
      cardkey: (cfg.apiKeys || []).length > 0,
      user: false,

      registration: NO_REGISTRATION,
    },
    themes: kernel ? kernel.themeList(cfg) : [],
    plugins: kernel ? kernel.bootstrapPlugins(inst, cfg) : [],
    adminUi: kernel ? kernel.adminUiManifest(inst) : { version: 1, pages: [] },
    capabilities: kernel ? kernel.listCapabilities(inst) : [],
  };
}

function handleBootstrap(cfg, req, res, kernel) {
  const u = new URL(req.url, 'http://localhost');
  const body = JSON.stringify(buildBootstrap(cfg, kernel, req, u));
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

module.exports = { buildBootstrap, handleBootstrap, DEFAULT_LAYOUT, DEFAULT_SERVER_INFO };
