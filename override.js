'use strict';
/**
 * 参数覆写 (paramOverride)
 *
 * 网关自己的参数覆写，作用在「最终发往上游的请求体」上，覆盖 SDK 客户端送来的值。
 *   - 实例级 cfg.paramOverride 打底，渠道级 ch.paramOverride 覆盖它；
 *   - 语义：对象逐键深合并，数组/标量整体替换，值为 null 表示删掉这个参数；
 *   - 键名按该渠道的上游方言写（openai / claude / gemini）——覆写发生在方言转换之后，
 *     所以同方言直通与跨方言转换两条路径表现一致；
 *   - model 由路由/改名决定、stream 由客户端端点决定，两者不允许被覆写。
 *
 * 只做拷贝式改写：入参对象不被修改，一次失败的渠道尝试不会把覆写残留给下一次重试。
 */
const { logErr } = require('./util');

const PROTECTED = new Set(['model', 'stream']);
const MAX_BYTES = 64 * 1024;
const MAX_DEPTH = 8;

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function specDepth(v, d) {
  if (!isPlainObject(v)) return d;
  let m = d;
  for (const k of Object.keys(v)) {
    const c = specDepth(v[k], d + 1);
    if (c > m) m = c;
    if (m > MAX_DEPTH) return m;
  }
  return m;
}

/* 配置里读到什么算什么：对象直接用；JSON 文本（手写 config.json / CLI 传参）先解析。
 * 空对象 / 解析失败 / 非对象 / 过深 / 过大 都按「没有覆写」处理，配置照常加载。 */
function normalizeOverride(v, label) {
  const tag = label || 'paramOverride';
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    try { v = JSON.parse(s); } catch (e) { logErr('[override] ' + tag + ' 不是合法 JSON, 已忽略: ' + e.message); return null; }
  }
  if (!isPlainObject(v)) { logErr('[override] ' + tag + ' 必须是 JSON 对象(键=参数名), 已忽略'); return null; }
  if (!Object.keys(v).length) return null;
  if (specDepth(v, 0) > MAX_DEPTH) { logErr('[override] ' + tag + ' 嵌套超过 ' + MAX_DEPTH + ' 层, 已忽略'); return null; }
  let size = Infinity;
  try { size = JSON.stringify(v).length; } catch (_) {}
  if (!(size <= MAX_BYTES)) { logErr('[override] ' + tag + ' 超过 ' + (MAX_BYTES / 1024) + 'KB, 已忽略'); return null; }
  return v;
}

/* 两层覆写合并：渠道在实例之上。null 是「删除」标记，合并时保留、不丢。 */
function mergeSpecs(base, over) {
  if (!base) return over || null;
  if (!over) return base;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    const bv = over[k], av = out[k];
    if (bv === null || bv === undefined) { out[k] = null; continue; }
    out[k] = (isPlainObject(bv) && isPlainObject(av)) ? mergeSpecs(av, bv) : (Array.isArray(bv) ? bv.slice() : bv);
  }
  return out;
}

function overrideFor(cfg, ch) {
  const a = cfg && cfg.paramOverride;
  const b = ch && ch.paramOverride;
  if (!a && !b) return null;
  return mergeSpecs(a, b);
}

const _warned = new Set();
function warnProtected(chName, key) {
  const sig = (chName || '-') + '|' + key;
  if (_warned.has(sig)) return;
  _warned.add(sig);
  logErr('[override] 渠道 "' + (chName || '-') + '" 的 paramOverride 含 "' + key + '": 该参数由网关决定(模型看 modelMap/models, 流式看客户端端点), 已忽略');
}

/* 沿被改动的路径复制，未碰到的分支保持原引用 —— 大 body 不做整棵深拷贝，
 * 同时保证调用方手里的 client body 不被覆写污染。 */
function mergeNode(cur, spec, top, chName) {
  const out = isPlainObject(cur) ? { ...cur } : {};
  for (const key of Object.keys(spec)) {
    if (top && PROTECTED.has(key)) { warnProtected(chName, key); continue; }
    const val = spec[key];
    if (val === null || val === undefined) { delete out[key]; continue; }
    if (isPlainObject(val)) {
      const base = isPlainObject(cur) ? cur[key] : undefined;
      out[key] = mergeNode(isPlainObject(base) ? base : undefined, val, false, chName);
    } else {
      out[key] = Array.isArray(val) ? val.slice() : val;
    }
  }
  return out;
}

function applyOverride(body, spec, ch) {
  if (!spec || !isPlainObject(body)) return body;
  return mergeNode(body, spec, true, ch && ch.name);
}

module.exports = { isPlainObject, normalizeOverride, mergeSpecs, applyOverride, overrideFor, PROTECTED };
