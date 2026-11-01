'use strict';
/* Privacy filter test
 * Coverage: (1) built-in rules (API keys/Bearer/emails/phone numbers/national IDs/bank cards/private IPs)  (2) long non-sensitive numbers are never masked
 *       (3) traitless-text fast path (zero copy)  (4) long tokens across CDC cuts are never missed  (5) extra rules + cache invalidation
 *       (6) streaming filtering (char-by-char / random fragmentation) matches the whole-string result
 * Run: node test/redact_test.js
 */
const R = require('../redact-cache.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  ✗ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }

/* (1) Built-in rules */
eq(R.redactSmart('key sk-abcdefghijklmnopqrstuvwx'), 'key ***', 'sk- 密钥');
eq(R.redactSmart('token ghp_abcdefghijklmnopqrstuvwxyz'), 'token ***', 'GitHub token');
eq(R.redactSmart('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), 'Authorization: ***', 'Bearer');
eq(R.redactSmart('mail me: user.name+tag@example.co.uk'), 'mail me: ***', '邮箱');
eq(R.redactSmart('tel 13800138000 ok'), 'tel *** ok', '手机号');
eq(R.redactSmart('id 110105199003071234 ok'), 'id *** ok', '身份证');
eq(R.redactSmart('card 4111 1111 1111 1111 ok'), 'card *** ok', '银行卡(带空格, Luhn 通过)');
eq(R.redactSmart('host 192.168.100.20'), 'host ***', '内网 IPv4');

/* (2) False-positive control */
eq(R.redactSmart('order 1234567890123456 done'), 'order 1234567890123456 done', '非 Luhn 长数字不误伤');
eq(R.redactSmart('date 2026-10-27 12:00'), 'date 2026-10-27 12:00', '日期不误伤');
eq(R.redactSmart('v1.2.3 build 7654321'), 'v1.2.3 build 7654321', '短数字不误伤');

/* (3) Fast path: ordinary large text returns the original reference (no copy, no cache) */
const plain = ('这是一段普通对话内容, 用来模拟很长的上下文. ' + 'normal words, punctuation! 42. ').repeat(2000);
ok(R.redactSmart(plain) === plain, '无敏感特征文本走快路径(引用相同)');

/* (4) Long tokens across chunks: must not be missed under any offset */
const tok = 'A'.repeat(900);
const bearerLeak = (off) => {
  const s = 'x'.repeat(120000 + off) + ' Bearer ' + tok + ' tail';
  const out = R.redactSmart(s);
  return out.includes(tok.slice(0, 64)) || out.includes(tok.slice(-64));
};
for (const off of [0, 7, 101, 999, 4097, 12345]) ok(!bearerLeak(off), '长 Bearer token 跨块不漏 (offset=' + off + ')');
const skTok = 'sk-' + 'B'.repeat(600);
const s2 = 'y'.repeat(90000) + ' ' + skTok + ' z';
ok(!R.redactSmart(s2).includes('B'.repeat(64)), '超长 sk- 密钥跨块不漏');

/* (5) extra rules + fingerprint switching */
eq(R.redactSmart('id EMP-42 ok', ['EMP-\\d+']), 'id *** ok', 'extra 规则生效');
eq(R.redactSmart('id EMP-42 ok'), 'id EMP-42 ok', '去掉 extra 后缓存自动失效');
eq(R.redactSmart('id DEV-7 ok', ['DEV-\\d']), 'id *** ok', '更换 extra 规则后立即生效');

/* (6) Streaming: any fragmentation must match the whole-string filtering result */
const secrets = [
  'sk-abcdefghijklmnopqrstuvwxyz012345', 'Bearer ' + 'Q'.repeat(900),
  'user.name+tag@example.co.uk', '13800138000', '110105199003071234',
  '192.168.100.200', '4111 1111 1111 1111',
];
let s = '';
for (let i = 0; i < 30; i++) s += '这是普通内容 with words, punctuation! 12345. ' + (i % 7 === 0 ? secrets[i % secrets.length] : '');
s += ' END';
const full = R.redactSmart(s);
for (const step of [1, 3, 7, 53]) {
  const f = R.createStreamFilter();
  let out = '';
  for (let i = 0; i < s.length; i += step) out += f.push(s.slice(i, i + step));
  out += f.flush();
  ok(out === full, '流式分片(' + step + ')结果与整串一致');
  ok(!/Q{64}|B{64}/.test(out) && !out.includes('13800138000') && !out.includes('example.co.uk'), '流式分片(' + step + ')无泄漏');
}
/* extra rules apply to streaming too */
{
  const ef = R.createStreamFilter(['EMP-[0-9]+']);
  let eo = '';
  for (let i = 0; i < '员工 EMP-12345 打卡'.length; i += 2) eo += ef.push('员工 EMP-12345 打卡'.slice(i, i + 2));
  eo += ef.flush();
  eq(eo, '员工 *** 打卡', 'extra 规则的流式过滤');
}
/* Empty input / undefined must not crash */
eq(R.redactSmart(''), '', '空串');
eq(R.redactSmart(undefined), undefined, 'undefined');
/* (6b) streaming cut must not split a UTF-16 surrogate pair (clients encoding each delta separately would see U+FFFD) */
{
  const sf = R.createStreamFilter();
  const a = sf.push('aaaaa🚀bbbbbbbbbbbbbbb');
  const b = sf.flush();
  ok(!/[\uD800-\uDBFF]$/.test(a), '流式切分: 不把代理对劈在前一段末尾');
  ok(!/^[\uDC00-\uDFFF]/.test(b), '流式切分: 后一段不以孤低代理开头');
  eq(a + b, 'aaaaa🚀bbbbbbbbbbbbbbb', '流式切分: 代理对拼接后完整');
}

const emptyF = R.createStreamFilter();
eq(emptyF.push(''), '', '流式空分片');
eq(emptyF.flush(), '', '流式空收尾');

/* (7) Same prefix, different tail: the cache must not reuse old masked results on new content */
R.reset();
const p = 'z'.repeat(5000) + ' sk-AAAAAAAAAAAAAAAAAAAAA';
const q = 'z'.repeat(5000) + ' sk-BBBBBBBBBBBBBBBBBBBBB';
R.redactSmart(p);
const qOut = R.redactSmart(q);
ok(!qOut.includes('BBBBBBBBBBBBBBBBBBBBB') && qOut.includes('***'), '缓存块内容变化后重新过滤');
ok(!qOut.includes('AAAAAAAAAAAAAAAAAAAAA'), '缓存不串味(不返回上一次的正文)');

console.log(`\nredact test: ${pass} passed, ${fail} failed`);
if (fail) { console.error(failures.join('\n')); process.exit(1); }
