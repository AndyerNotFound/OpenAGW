'use strict';
/* ================= Card-key permissions =================
 * A user card (apiKeys entry) carries three whitelists and two rate limits:
 *   models    allowed model names (plain or composite instance:channel:model)
 *   channels  allowed providers (channel names)
 *   branches  allowed instances
 *   rpm/tpm   requests / tokens per rolling minute; 0 or absent = unlimited
 * A whitelist accepts '*' wildcards. An empty models/channels list means "no restriction"
 * (the historical card behavior). An empty branches list means the issuing instance only --
 * cross-instance access always has to be granted explicitly.
 */
function list(v) {
  return Array.isArray(v) ? v.map(x => String(x == null ? '' : x).trim()).filter(Boolean) : [];
}

// Same glob semantics as routing: '*' matches anything, case-insensitive for patterns
function wildMatch(pat, str) {
  const esc = String(pat).split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  try { return new RegExp('^' + esc + '$', 'i').test(String(str)); } catch (_) { return false; }
}

function anyMatch(patterns, name) {
  const n = String(name == null ? '' : name);
  if (!n) return false;
  for (const p of patterns) {
    if (p === n) return true;
    if (p.indexOf('*') >= 0 && wildMatch(p, n)) return true;
  }
  return false;
}

function allows(patterns, name) {
  const p = list(patterns);
  return p.length ? anyMatch(p, name) : true;
}

function allowsChannel(uk, name) { return !uk || allows(uk.channels, name); }
function allowsBranch(uk, name) { return !uk || allows(uk.branches, name); }

// Model whitelists match the plain name or the composite instance:channel:model reference
function allowsModel(uk, ...names) {
  if (!uk) return true;
  const p = list(uk.models);
  if (!p.length) return true;
  for (const n of names) if (n && anyMatch(p, n)) return true;
  return false;
}

function filterChannels(uk, channels) {
  const chs = Array.isArray(channels) ? channels : [];
  return uk ? chs.filter(ch => allowsChannel(uk, ch && ch.name)) : chs;
}

module.exports = { list, wildMatch, anyMatch, allows, allowsChannel, allowsBranch, allowsModel, filterChannels };
