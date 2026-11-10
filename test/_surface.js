'use strict';
/* Test helper: the admin panel answers only /<sid>/admin/... on every port.
 * Card-holder API paths (/v1, /v1beta, /api/app, /plugins) keep their bare form, so tests
 * wrap only admin paths with surface.spath(p); a bare path is left untouched.
 * Tests call surface.set(cfg) (in-process server) or surface.useDir(dir) (spawned gateway,
 * resolved lazily on the first request). */
const path = require('path');
const panelAuth = require('../panel-auth');

let CUR = { admin: '', sid: '' };
let LAZY = null;

function fromState(st) {
  if (!st) return CUR;
  CUR = { admin: '/' + st.sid, sid: st.sid };
  return CUR;
}
function fakeCfg(dir) { return { _configFile: path.join(dir, 'config.json') }; }
function set(cfg, inst) {
  return fromState(panelAuth.ensure(cfg, inst || (cfg && cfg._name) || 'default'));
}
function setFromDir(dir, inst) {
  return fromState(panelAuth.ensure(fakeCfg(dir), inst || 'default'));
}
function useDir(dir, inst) {
  LAZY = { dir, inst: inst || 'default' };
  CUR = { admin: '', sid: '' };
}
function pair(dir, inst) {
  const st = panelAuth.ensure(fakeCfg(dir), inst || 'default');
  return { admin: '/' + st.sid, sid: st.sid };
}
function spath(p) {
  if (LAZY && !CUR.sid) { try { setFromDir(LAZY.dir, LAZY.inst); } catch (_) {} }
  if (CUR.admin && p.startsWith('/admin')) return CUR.admin + p;
  return p;
}
module.exports = { set, setFromDir, useDir, pair, spath };
