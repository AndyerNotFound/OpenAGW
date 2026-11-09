'use strict';
/* Plugin protocol v2 test — manifest validation / activation order / capabilities /
 * admin-SDUI registration / intent signatures / dispatch / bootstrap shape.
 * Run: node test/plugin_protocol_test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const { PluginManager } = require(path.join(ROOT, 'plugins.js'));
const { buildBootstrap } = require(path.join(ROOT, 'bootstrap.js'));

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

// ---------- sandbox gateway ----------
const GW = fs.mkdtempSync(path.join(os.tmpdir(), 'agw-plugin-'));
fs.mkdirSync(path.join(GW, 'plugins'), { recursive: true });
fs.mkdirSync(path.join(GW, 'data', 'plugins-data'), { recursive: true });
function addPlugin(id, manifest, serverSrc, files) {
  const dir = path.join(GW, 'plugins', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(Object.assign({ id }, manifest), null, 2));
  if (serverSrc) fs.writeFileSync(path.join(dir, 'server.js'), serverSrc);
  for (const [rel, body] of Object.entries(files || {})) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
}

const logLines = [];
const kernel = new PluginManager(GW, (...a) => logLines.push(a.join(' ')));

// auth plugin: must activate before business (ordering check)
addPlugin('demo-auth', { name: 'Auth', type: 'auth', hasServer: true, provides: ['user-system'] }, `
module.exports = { activate(ctx) {
  ctx.provideCapability('demo-session', { api: () => ({ endpoints: { whoami: '/whoami' } }) });
  ctx.registerRoute('GET', '/whoami', async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, plugin: ctx.id }));
  });
} };`);

// business plugin: capability consumer, admin-SDUI page, intent-protected route, static page
addPlugin('demo-biz', {
  name: 'Biz', type: 'business', hasServer: true, dataScope: 'global',
  permissions: ['gateway:adminUi'], provides: ['demo-ui'],
  appUi: { home: { title: '演示', icon: 'star', ui: '/ui/home' } },
  userPage: 'pages/user.html',
  adminPage: 'pages/admin.html',
}, `
module.exports = { activate(ctx) {
  const session = ctx.requireCapability('demo-session');
  ctx.provideCapability('demo-cap', { api: () => ({ endpoints: { sign: '/signin' } }), hasSession: !!session });
  ctx.registerAdminUi({ id: 'demo-page', title: '演示页', menu: true,
    render: () => ({ gcui: 1, title: '演示', root: { type: 'column', children: [] } }) });
  ctx.registerRoute('POST', '/noop', async (req, res, params) => {
    const v = ctx.security.guard(req, res, params);
    if (!v) return;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: '业务拒绝' }));
  });
  ctx.registerRoute('POST', '/signin', async (req, res, params) => {
    const v = ctx.security.guard(req, res, params);
    if (!v) return;
    if (v.replay) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v.replay)); return; }
    const out = { ok: true, signed: true, who: v.keyRecord ? v.keyRecord.name : null };
    ctx.security.commit(v, out);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
} };`, { 'pages/user.html': '<h1>demo</h1>', 'pages/admin.html': '<h1>admin</h1>' });

// rejected manifests
addPlugin('bad-theme', { name: 'Evil', type: 'theme', hasServer: true, theme: { name: 'x' } }, `module.exports={activate(){}}`);
addPlugin('bad-id', { id: 'Bad_ID', name: 'Bad', hasServer: false }, '');
addPlugin('no-perm', { name: 'NoPerm', type: 'business', hasServer: true }, `
module.exports = { activate(ctx) {
  ctx.provideCapability('ghost-cap', {});
  ctx.registerAdminUi({ id: 'ghost', render: () => ({ gcui: 1 }) });
} };`);

// secrets probe: needs gateway:config
addPlugin('demo-config', { name: 'Cfg', type: 'business', hasServer: true, permissions: ['gateway:config'] }, `
module.exports = { activate(ctx) {
  ctx.registerRoute('GET', '/cfg', async (req, res) => {
    const c = ctx.getInstanceConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      webToken: c.webToken, gatewayKey: c.gatewayKey, adminAuth: c.adminAuth,
      chanKey: c.channels[0].apiKey, hdr: c.channels[0].headers.Authorization,
      proxyPass: c.proxies.p1.pass,
      peer: Object.keys(ctx.getPluginConfig('demo-biz') || {}),
    }));
  });
} };`);

// same read without the permission: activation must throw and roll back
addPlugin('demo-noperm', { name: 'NoPermCfg', type: 'business', hasServer: true }, `
module.exports = { activate(ctx) { ctx.getInstanceConfig(); } };`);

// ---------- (1) manifest validation ----------
{
  const n = kernel.normalizeManifest({ id: 'Bad_ID' }, 'x');
  eq(n.ok, false, 'manifest: illegal id rejected');
  eq(kernel.normalizeManifest({ id: 't1', type: 'nope' }, 't1').ok, false, 'manifest: illegal type rejected');
  eq(kernel.normalizeManifest({ id: 't2', type: 'theme', hasServer: true, theme: {} }, 't2').ok, false, 'manifest: theme with hasServer rejected');
  eq(kernel.normalizeManifest({ id: 't3', type: 'theme', permissions: ['storage'], theme: {} }, 't3').ok, false, 'manifest: theme with permissions rejected');
  eq(kernel.normalizeManifest({ id: 't4', type: 'theme' }, 't4').ok, false, 'manifest: theme without tokens rejected');
  const good = kernel.normalizeManifest({ id: 't5', type: 'theme', theme: { name: 'T', dark: { primary: '#123' } } }, 't5');
  eq(good.ok, true, 'manifest: valid theme accepted');
  eq(good.manifest.hasServer, false, 'manifest: theme forced hasServer=false');
  eq(kernel.normalizeManifest({ id: 't6', adminApi: ['no-slash'] }, 't6').ok, false, 'manifest: adminApi must start with /');
}

// ---------- (2) activation ----------
kernel.scanInstalled();
eq(kernel.installed.has('bad-theme'), false, 'scan: theme-with-server never installed');
eq(kernel.installed.has('bad-id'), false, 'scan: illegal id never installed');
ok(kernel.installed.get('demo-biz').sha256.length === 64, 'scan: directory sha256 computed (64 hex)');

const cfg = {
  _name: 'default',
  apiKeys: [{ key: 'sk-test-abc', name: 'tester' }],
  webToken: 'SECRET-WEB-TOKEN',
  adminAuth: { secondKey: 'SECRET-2FA' },
  proxies: { p1: { type: 'socks5', host: '127.0.0.1', port: 1080, user: 'u', pass: 'SECRET-PROXY-PASS' } },
  channels: [{ name: 'c1', type: 'openai', baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-up-not-a-real-secret', headers: { Authorization: 'Bearer hdr-secret', 'X-Trace': 'ok' } }],
  plugins: [
    { id: 'demo-biz', enable: true, config: { note: 'hi' } },   // listed first on purpose
    { id: 'demo-auth', enable: true },
    { id: 'no-perm', enable: true },
    { id: 'demo-config', enable: true },
    { id: 'demo-noperm', enable: true },
  ],
};
kernel.activateInstance('default', cfg, {
  findKey: t => (cfg.apiKeys.find(k => k.key === t) || null),
  grantQuota: () => true,
});

ok(kernel.active.has('default/demo-auth'), 'activate: auth plugin active');
ok(kernel.active.has('default/demo-biz'), 'activate: business plugin active');
eq(kernel.active.has('default/no-perm'), false, 'activate: plugin throwing in activate() is rolled back');
eq(kernel.adminPages('default').some(p => p.id === 'ghost'), false, 'activate: rolled-back plugin leaves no admin page');
eq(kernel.listCapabilities('default').some(c => c.name === 'ghost-cap'), false, 'activate: rolled-back plugin leaves no capability');

// ---------- (3) capabilities ----------
const caps = kernel.listCapabilities('default').map(c => c.name).sort();
eq(JSON.stringify(caps), JSON.stringify(['demo-cap', 'demo-session']), 'capabilities: both providers registered');
ok(kernel.requireCapability('another-instance', 'demo-cap') !== null, 'capabilities: dataScope=global mounts at the global layer');
const demoCap = kernel.listCapabilities('default').find(c => c.name === 'demo-cap');
eq(JSON.stringify(demoCap.api), JSON.stringify({ endpoints: { sign: '/signin' } }), 'capabilities: api() serialized into bootstrap');
eq(kernel.requireCapability('default', 'demo-session').hasSession, undefined, 'capabilities: session impl is an object');
const impl = kernel.requireCapability('no-such-inst', 'no-such-cap');
eq(impl, null, 'capabilities: missing capability returns null (degrade, not throw)');
ok(kernel.requireCapability('default', 'demo-cap').hasSession === true, 'capabilities: business saw the auth capability (auth activated first)');

// ---------- (4) admin SDUI ----------
const pages = kernel.adminPages('default');
eq(pages.length, 1, 'adminUi: one page registered');
eq(pages[0].id, 'demo-page', 'adminUi: page id kept');
const man = kernel.adminUiManifest('default');
eq(man.version, 1, 'adminUi: manifest version 1');
eq(man.pages[0].ui, '/admin/ui/demo-page', 'adminUi: manifest ui path');

// ---------- (5) dispatch ----------
function fakeRes() {
  return {
    status: 0, headers: {}, body: '', headersSent: false,
    writeHead(c, h) { this.status = c; this.headers = h || {}; this.headersSent = true; },
    end(b) { this.body = b == null ? '' : String(b); },
  };
}
const call = (method, url, headers, body) => {
  const res = fakeRes();
  const u = new URL(url, 'http://localhost');
  return kernel.handle(cfg, { method, url, headers: headers || {} }, res, u, u.pathname, body || '')
    .then(() => res);
};

(async () => {
  let r = await call('GET', '/plugins/demo-auth/whoami', { accept: 'application/json' });
  eq(r.status, 200, 'dispatch: registered route hit');
  eq(JSON.parse(r.body).plugin, 'demo-auth', 'dispatch: handler sees its own ctx');

  r = await call('GET', '/plugins/demo-biz/pages/user.html', { accept: 'text/html' });
  eq(r.status, 200, 'dispatch: static page served');
  eq(r.body, '<h1>demo</h1>', 'dispatch: static bytes unchanged');

  {
    // a raw path with .. (URL would normalise it away before the kernel sees it)
    const res = fakeRes();
    const rawPath = '/plugins/demo-biz/../../plugins.js';
    await kernel.handle(cfg, { method: 'GET', url: rawPath, headers: {} }, res, new URL('http://x/'), rawPath, '');
    ok(res.status === 403 || res.status === 404, 'dispatch: path traversal blocked (' + res.status + ')');
    // and one that passes the static whitelist (html under pages/) but still escapes the plugin dir
    const res2 = fakeRes();
    const raw2 = '/plugins/demo-biz/pages/../../escape.html';
    await kernel.handle(cfg, { method: 'GET', url: raw2, headers: {} }, res2, new URL('http://x/'), raw2, '');
    eq(res2.status, 403, 'dispatch: pages/ traversal blocked by the dir check');
  }

  r = await call('GET', '/plugins/not-enabled/x', {});
  eq(r.status, 404, 'dispatch: unknown plugin 404');
  eq(JSON.parse(r.body).error.startsWith('插件未启用'), true, 'dispatch: 404 body says 插件未启用');

  // ---------- (6) intent signatures ----------
  const sign = (token, o) => crypto.createHmac('sha256', token)
    .update([o.ts, o.nonce, o.seq, o.intentId, o.method, o.path,
      crypto.createHash('sha256').update(o.body || '').digest('hex')].join('\n')).digest('hex');
  const tokenOf = 'sk-test-abc';
  const pathName = '/plugins/demo-biz/signin';
  let seq = 1;
  const makeReq = (body, over) => {
    const o = Object.assign({
      ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex'), seq: seq,
      intentId: crypto.randomUUID(), method: 'POST', path: pathName, body,
    }, over || {});
    return {
      req: {
        method: 'POST', url: pathName, headers: {
          authorization: 'Bearer ' + tokenOf,
          'x-gc-timestamp': String(o.ts), 'x-gc-nonce': o.nonce, 'x-gc-seq': String(o.seq),
          'x-gc-intent-id': o.intentId, 'x-gc-sign': over && over.sign ? over.sign : sign(tokenOf, o),
        },
      },
      meta: o,
    };
  };

  // valid
  let m = makeReq('{"a":1}');
  r = await call('POST', pathName, m.req.headers, '{"a":1}');
  eq(r.status, 200, 'intent: valid signature accepted');
  eq(JSON.parse(r.body).who, 'tester', 'intent: key record resolved from token');

  // replay (same intentId, higher seq -> cached response)
  seq = 2;
  m = makeReq('{"a":1}', { intentId: m.meta.intentId });
  r = await call('POST', pathName, m.req.headers, '{"a":1}');
  eq(r.status, 200, 'intent: replay returns cached 200');
  eq(JSON.parse(r.body).who, 'tester', 'intent: replay body is the cached response');

  // rollback (seq reused)
  m = makeReq('{"a":2}', { seq: 1 });
  r = await call('POST', pathName, m.req.headers, '{"a":2}');
  eq(r.status, 401, 'intent: sequence rollback rejected');
  eq(JSON.parse(r.body).currentSeq, 2, 'intent: rollback reports the last accepted seq (a replay still burns its seq)');

  // nonce reuse (new intentId, old nonce from the first request)
  seq = 3;
  const reusedNonce = 'aabbccddeeff0011';
  m = makeReq('{"a":3}', { nonce: reusedNonce });
  await call('POST', pathName, m.req.headers, '{"a":3}');
  seq = 4;
  m = makeReq('{"a":3}', { nonce: reusedNonce });
  r = await call('POST', pathName, m.req.headers, '{"a":3}');
  eq(r.status, 401, 'intent: replayed nonce rejected');

  // tampered body
  seq = 5;
  m = makeReq('{"a":4}');
  r = await call('POST', pathName, m.req.headers, '{"a":999}');
  eq(r.status, 401, 'intent: tampered body rejected');

  // missing headers
  r = await call('POST', pathName, { authorization: 'Bearer ' + tokenOf }, '{}');
  eq(r.status, 400, 'intent: missing signature headers -> 400');

  // wrong plugin namespace: dispatch would 404 for an inactive plugin, so test the guard directly
  seq = 6;
  m = makeReq('{"a":5}');
  {
    const v = kernel.guardFor('default').verify({
      pluginId: 'demo-biz',
      req: { method: 'POST', url: '/plugins/other/signin', headers: m.req.headers },
      params: { token: tokenOf, rawBody: '{"a":5}' },
      cfg, findKey: () => null,
    });
    eq(v.ok, false, 'intent: guard rejects foreign namespace');
    eq(v.status, 403, 'intent: plugin namespace mismatch -> 403');
  }

  // security file never stores the token in clear text
  const secFile = path.join(GW, 'data', 'plugins-data', 'default', '.gc-security.json');
  const secRaw = fs.readFileSync(secFile, 'utf8');
  eq(secRaw.includes(tokenOf), false, 'intent: store holds token hash only, never the card');

  // ---------- (6b) secrets never reach a plugin unless it is trusted ----------
  const cfgR = await call('GET', '/plugins/demo-config/cfg', {});
  eq(cfgR.status, 200, 'secrets: trusted plugin route works');
  const cfgJ = JSON.parse(cfgR.body);
  eq(cfgJ.webToken, '***', 'secrets: webToken masked');
  eq(JSON.stringify(cfgJ.adminAuth), JSON.stringify({ configured: true }), 'secrets: adminAuth reduced to a flag');
  eq(cfgJ.chanKey, '***', 'secrets: channel apiKey masked');
  eq(cfgJ.hdr, '***', 'secrets: channel auth header masked');
  eq(cfgJ.proxyPass, '***', 'secrets: proxy password masked');
  eq(JSON.stringify(cfgJ.peer), JSON.stringify(['note']), 'secrets: peer plugin config readable with the permission');
  eq(kernel.active.has('default/demo-noperm'), false, 'secrets: reading instance config without gateway:config aborts activation');

  // ---------- (6c) static surface ----------
  r = await call('GET', '/plugins/demo-biz/server.js', {});
  eq(r.status, 404, 'static: plugin source not served');
  r = await call('GET', '/plugins/demo-biz/manifest.json', {});
  eq(r.status, 404, 'static: manifest not served');
  r = await call('GET', '/plugins/demo-biz/pages/admin.html', {});
  eq(r.status, 401, 'static: admin page needs the panel credential');
  kernel.setAdminCheck(() => true);
  r = await call('GET', '/plugins/demo-biz/pages/admin.html', {});
  eq(r.status, 200, 'static: admin page opens with the credential');

  // ---------- (6d) intent: keyless instance, burned nonce, branch scope ----------
  const mkHeaders = (o) => ({
    'x-gc-timestamp': String(o.ts), 'x-gc-nonce': o.nonce, 'x-gc-seq': String(o.seq),
    'x-gc-intent-id': o.intentId, 'x-gc-sign': sign(o.token, o),
  });
  {
    const o = { token: 'sk-anything', ts: Date.now(), nonce: crypto.randomBytes(8).toString('hex'), seq: 50, intentId: crypto.randomUUID(), method: 'POST', path: '/plugins/demo-biz/noop', body: '{}' };
    const v = kernel.guardFor('keyless').verify({
      pluginId: 'demo-biz',
      req: { method: 'POST', url: '/plugins/demo-biz/noop', headers: mkHeaders(o) },
      params: { token: o.token, rawBody: '{}' },
      cfg: { _name: 'keyless' }, findKey: () => null,
    });
    eq(v.ok, false, 'intent: keyless instance refuses self-signed requests');
    eq(v.status, 401, 'intent: keyless returns 401');
  }
  {
    // the handler returns 400 without commit: the nonce must still be burned
    seq = 7;
    m = makeReq('{}', { path: '/plugins/demo-biz/noop' });
    r = await call('POST', '/plugins/demo-biz/noop', m.req.headers, '{}');
    eq(r.status, 400, 'intent: early business rejection returns 400');
    r = await call('POST', '/plugins/demo-biz/noop', m.req.headers, '{}');
    eq(r.status, 401, 'intent: the same signature is not replayable after an early return');
  }
  {
    const keyRec = { key: 'sk-test-abc', name: 'tester', branches: ['other-inst'] };
    seq = 30;
    m = makeReq('{}', { path: '/plugins/demo-biz/noop' });
    const v = kernel.guardFor('default').verify({
      pluginId: 'demo-biz',
      req: { method: 'POST', url: '/plugins/demo-biz/noop', headers: m.req.headers },
      params: { token: 'sk-test-abc', rawBody: '{}' },
      cfg: { apiKeys: [keyRec] }, findKey: () => keyRec,
    });
    eq(v.ok, false, 'intent: card scoped to another branch');
    eq(v.status, 403, 'intent: branch mismatch -> 403');
  }

  // ---------- (7) bootstrap ----------
  const bs = buildBootstrap(cfg, kernel, { headers: { authorization: 'Bearer ' + tokenOf } }, new URL('http://x/api/app/bootstrap'));
  eq(bs.ok, true, 'bootstrap: ok');
  eq(bs.branch, 'default', 'bootstrap: branch name');
  eq(bs.appApi, 1, 'bootstrap: appApi version');
  eq(bs.auth.cardkey, true, 'bootstrap: cardkey auth advertised');
  eq(bs.auth.user, false, 'bootstrap: no user accounts');
  eq(bs.layout.bottomBar.join(','), 'home,personal,settings', 'bootstrap: default layout');
  eq(bs.plugins.length, 3, 'bootstrap: enabled plugins listed, disabled/rolled-back excluded');
  eq(bs.plugins.map(p => p.id).sort().join(','), 'demo-auth,demo-biz,demo-config', 'bootstrap: exactly the three activated plugins');
  const biz = bs.plugins.find(p => p.id === 'demo-biz');
  eq(biz.type, 'business', 'bootstrap: plugin type');
  eq(biz.sha256.length, 64, 'bootstrap: plugin sha256 disclosed');
  eq(biz.capabilities.join(','), 'demo-cap', 'bootstrap: runtime capabilities attached');
  eq(biz.provides.join(','), 'demo-ui', 'bootstrap: static provides kept separate');
  eq(biz.appUi.home.title, '演示', 'bootstrap: appUi passed through');
  eq(bs.adminUi.pages[0].id, 'demo-page', 'bootstrap: adminUi page registry');
  const cap = bs.capabilities.find(c => c.name === 'demo-cap');
  eq(JSON.stringify(cap.api), JSON.stringify({ endpoints: { sign: '/signin' } }), 'bootstrap: capability endpoint description');
  eq(bs.themes[0].locked, true, 'bootstrap: a locked default theme always exists');

  // ---------- (8) deactivation rolls contributions back ----------
  kernel.deactivateInstance('default');
  eq(kernel.listCapabilities('default').length, 0, 'deactivate: capabilities removed');
  eq(kernel.adminPages('default').length, 0, 'deactivate: admin pages removed');
  eq(kernel.active.size, 0, 'deactivate: no active plugins');

  console.log(`\nplugin protocol: ${pass} passed, ${fail} failed`);
  if (fail) console.log('failures:\n  ' + failures.join('\n  '));
  try { fs.rmSync(GW, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
