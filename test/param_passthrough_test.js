'use strict';
/* Parameter fidelity test
 * Two reported regressions:
 *  (1) part of the request parameters never reached the upstream once a request took the
 *      conversion path (cross-format channel, or same-format with response redaction on)
 *  (2) the privacy filter rewrote protocol parameters and broke otherwise valid requests
 * Also covers the reverse direction: usage breakdown (cache reads / reasoning tokens) reaching
 * the client instead of being flattened to prompt/completion counters.
 * Run: node test/param_passthrough_test.js
 */
const C = require('../convert.js');
const { redactDeep } = require('../redact.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; failures.push(msg); console.error('  x ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + ` (got=${JSON.stringify(a)}, want=${JSON.stringify(b)})`); }
function has(obj, k, msg) { ok(obj && obj[k] !== undefined, msg + ' (missing "' + k + '")'); }

const OPENAI_BODY = {
  model: 'gpt-5',
  messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }],
  temperature: 0.7, top_p: 0.9, max_tokens: 4096, stop: ['END'], n: 3,
  presence_penalty: 0.1, frequency_penalty: 0.2, seed: 42,
  logit_bias: { '50256': -100 }, logprobs: true, top_logprobs: 5,
  response_format: { type: 'json_schema', json_schema: { name: 'out', schema: { type: 'object' }, strict: true } },
  parallel_tool_calls: false, user: 'u-123', metadata: { trace: 'abc' },
  reasoning_effort: 'high', service_tier: 'auto', store: false,
  verbosity: 'low',                       // unknown to the gateway: must survive via extra
  prediction: { type: 'content', content: 'x' },
  tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
  tool_choice: 'auto',
};

/* (1) same dialect: everything the client sent reaches the upstream */
{
  const up = C.canonicalToOpenAIBody(C.openaiToCanonical(OPENAI_BODY, 'gpt-5'));
  for (const k of ['temperature', 'top_p', 'max_tokens', 'stop', 'n', 'presence_penalty', 'frequency_penalty',
    'seed', 'logit_bias', 'logprobs', 'top_logprobs', 'response_format', 'parallel_tool_calls', 'user',
    'reasoning_effort', 'service_tier', 'store', 'verbosity', 'prediction']) has(up, k, '同方言回填 ' + k);
  eq(JSON.stringify(up.response_format), JSON.stringify(OPENAI_BODY.response_format), 'response_format 原样');
  eq(JSON.stringify(up.tools), JSON.stringify(OPENAI_BODY.tools), 'tools 原样');
  eq(up.messages.length, 2, '消息条数不变');
  ok(up.extra === undefined && up._clientFormat === undefined, '内部字段不落进上游 body');
  ok(!('metadata' in up), 'Chat Completions 不支持的 metadata 不下发');
}

/* (2) OpenAI -> Claude: what Claude understands is translated, the rest is not invented */
{
  const canon = C.openaiToCanonical(OPENAI_BODY, 'gpt-5');
  canon.model = 'claude-sonnet-4-5';
  const up = C.canonicalToClaudeBody(canon);
  eq(up.temperature, 0.7, 'claude: temperature');
  eq(up.top_p, 0.9, 'claude: top_p');
  eq(up.max_tokens, 4096, 'claude: max_tokens');
  eq(JSON.stringify(up.stop_sequences), '["END"]', 'claude: stop_sequences');
  eq(up.metadata && up.metadata.user_id, 'u-123', 'claude: user -> metadata.user_id');
  eq(up.output_config && up.output_config.format && up.output_config.format.type, 'json_schema', 'claude: response_format -> output_config.format');
  eq(up.output_config.effort, 'high', 'claude: reasoning_effort -> output_config.effort');
  eq(up.service_tier, 'auto', 'claude: service_tier');
  ok(!('seed' in up) && !('presence_penalty' in up), 'claude: 无对应语义的参数不硬塞');
  eq(up.system, 'be brief', 'claude: system 抽出');
}

/* (3) Claude -> Claude: native parameters stay native */
{
  const body = {
    model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1024,
    temperature: 0.5, top_p: 0.9, top_k: 40, thinking: { type: 'enabled', budget_tokens: 4096 },
    metadata: { user_id: 'u1' }, stop_sequences: ['x'], service_tier: 'auto',
    container: 'c-1',                       // unknown: must ride along via extra
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object' } }],
  };
  const up = C.canonicalToClaudeBody(C.claudeToCanonical(body, 'claude-sonnet-4-5'));
  eq(up.top_k, 40, 'claude: top_k');
  eq(JSON.stringify(up.thinking), JSON.stringify(body.thinking), 'claude: thinking');
  eq(up.metadata.user_id, 'u1', 'claude: metadata.user_id');
  eq(up.service_tier, 'auto', 'claude: service_tier');
  ok(up.max_tokens > 4096, 'claude: max_tokens 被抬到 thinking 预算之上');
  eq(up.container, 'c-1', 'claude: 未知字段经 extra 回填');
}

/* (4) Gemini -> Gemini: generationConfig sub-fields and safetySettings survive */
{
  const body = {
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: {
      temperature: 0.5, topP: 0.9, topK: 40, candidateCount: 2, maxOutputTokens: 1000,
      presencePenalty: 0.1, frequencyPenalty: 0.2, seed: 7,
      responseMimeType: 'application/json', responseSchema: { type: 'object' },
      thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',   // unknown to the gateway
    },
    safetySettings: [{ category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' }],
  };
  const up = C.canonicalToGeminiBody(C.geminiToCanonical(body, 'gemini-3-pro'));
  const gc = up.generationConfig || {};
  eq(gc.topK, 40, 'gemini: topK');
  eq(gc.candidateCount, 2, 'gemini: candidateCount');
  eq(gc.presencePenalty, 0.1, 'gemini: presencePenalty');
  eq(gc.frequencyPenalty, 0.2, 'gemini: frequencyPenalty');
  eq(gc.seed, 7, 'gemini: seed');
  eq(gc.responseMimeType, 'application/json', 'gemini: JSON 模式');
  eq(JSON.stringify(gc.responseSchema), '{"type":"object"}', 'gemini: responseSchema');
  eq(JSON.stringify(gc.thinkingConfig), JSON.stringify(body.generationConfig.thinkingConfig), 'gemini: thinkingConfig');
  eq(gc.mediaResolution, 'MEDIA_RESOLUTION_HIGH', 'gemini: 未知 generationConfig 字段回填');
  eq(JSON.stringify(up.safetySettings), JSON.stringify(body.safetySettings), 'gemini: safetySettings');
}

/* (5) OpenAI -> Gemini / OpenAI -> Responses translation */
{
  const canon = C.openaiToCanonical(OPENAI_BODY, 'gpt-5');
  const gcanon = C.geminiToCanonical({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    generationConfig: { thinkingConfig: { thinkingBudget: 2048 }, responseLogprobs: true, logprobs: 4 } }, 'gemini-3-pro');
  eq(gcanon.thinking_config && gcanon.thinking_config.thinkingBudget, 2048, 'gemini: thinkingConfig 入 canonical');
  eq(gcanon.logprobs, true, 'gemini: responseLogprobs -> logprobs');
  eq(gcanon.top_logprobs, 4, 'gemini: logprobs(n) -> top_logprobs');
  const gclaude = C.canonicalToClaudeBody({ ...gcanon, model: 'claude-sonnet-4-5' });
  eq(gclaude.thinking && gclaude.thinking.budget_tokens, 2048, 'gemini>claude: thinking 预算');
  const goa = C.canonicalToOpenAIBody({ ...gcanon, model: 'gpt-5' });
  eq(goa.logprobs, true, 'gemini>openai: logprobs');
  eq(goa.top_logprobs, 4, 'gemini>openai: top_logprobs');

  const gm = C.canonicalToGeminiBody({ ...canon, model: 'gemini-3-pro' });
  const gc = gm.generationConfig || {};
  eq(gc.seed, 42, 'openai>gemini: seed');
  eq(gc.presencePenalty, 0.1, 'openai>gemini: presence_penalty');
  eq(gc.candidateCount, 3, 'openai>gemini: n -> candidateCount');
  eq(gc.thinkingConfig && gc.thinkingConfig.thinkingBudget > 0, true, 'openai>gemini: reasoning_effort -> thinkingBudget');
  eq(gc.responseMimeType, 'application/json', 'openai>gemini: response_format');

  const rs = C.canonicalToResponsesBody({ ...canon, model: 'gpt-5' });
  eq(rs.reasoning && rs.reasoning.effort, 'high', 'openai>responses: reasoning.effort');
  eq(rs.text && rs.text.format && rs.text.format.type, 'json_schema', 'openai>responses: text.format');
  eq(rs.text.format.strict, true, 'openai>responses: strict 透传');
  eq(rs.parallel_tool_calls, false, 'openai>responses: parallel_tool_calls');
  eq(JSON.stringify(rs.metadata), '{"trace":"abc"}', 'openai>responses: metadata');
  eq(rs.user, 'u-123', 'openai>responses: user');
}

/* (6) Responses client -> chat upstream */
{
  const body = {
    model: 'gpt-5', input: 'hi', max_output_tokens: 800, temperature: 0.3, top_p: 0.8,
    reasoning: { effort: 'medium' }, text: { format: { type: 'json_schema', name: 'o', schema: { type: 'object' }, strict: true } },
    parallel_tool_calls: false, metadata: { a: 'b' }, user: 'u-9', store: true, service_tier: 'flex',
    truncation: 'auto',
  };
  const canon = C.responsesToCanonical(body, 'gpt-5');
  eq(canon.max_tokens, 800, 'responses>chat: max_output_tokens');
  eq(canon.reasoning_effort, 'medium', 'responses>chat: reasoning.effort');
  eq(canon.response_format && canon.response_format.json_schema.name, 'o', 'responses>chat: text.format');
  const up = C.canonicalToOpenAIBody(canon);
  eq(up.reasoning_effort, 'medium', 'responses>chat: reasoning_effort 落到 Chat');
  eq(up.parallel_tool_calls, false, 'responses>chat: parallel_tool_calls');
  eq(up.text, undefined, 'responses>chat: 不把 Responses 的 text 结构塞给 Chat');
}

/* (7) usage breakdown round-trip */
{
  const oa = { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens_details: { reasoning_tokens: 20 } } };
  const canon = C.openaiRespToCanonical(oa);
  const oc = C.canonicalToOpenAIResp(canon, 'm').usage;
  eq(oc.prompt_tokens_details && oc.prompt_tokens_details.cached_tokens, 80, 'usage: openai cached_tokens');
  eq(oc.completion_tokens_details && oc.completion_tokens_details.reasoning_tokens, 20, 'usage: openai reasoning_tokens');
  const cc = C.canonicalToClaudeResp(canon, 'm').usage;
  eq(cc.cache_read_input_tokens, 80, 'usage: claude cache_read_input_tokens');
  eq(cc.input_tokens, 100, 'usage: claude input_tokens');
  const gc = C.canonicalToGeminiResp(canon, 'm').usageMetadata;
  eq(gc.cachedContentTokenCount, 80, 'usage: gemini cachedContentTokenCount');
  eq(gc.thoughtsTokenCount, 20, 'usage: gemini thoughtsTokenCount');
  const rc = C.canonicalToResponsesResp(canon, 'm').usage;
  eq(rc.input_tokens_details && rc.input_tokens_details.cached_tokens, 80, 'usage: responses cached');
  eq(rc.output_tokens_details && rc.output_tokens_details.reasoning_tokens, 20, 'usage: responses reasoning');
}
{
  const cl = { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 } };
  const canon = C.claudeRespToCanonical(cl);
  eq(canon.usage.cached, 940, 'usage: claude cached 汇总');
  const oc = C.canonicalToOpenAIResp(canon, 'm').usage;
  eq(oc.prompt_tokens_details.cached_tokens, 900, 'usage: claude>openai cache_read');
}

/* (8) Privacy filter: protocol parameters are not content */
{
  const body = {
    model: 'gpt-5',
    max_tokens: '4096', temperature: '0.7',     // stringified numbers: must stay untouched
    user: 'someone@corp.example',
    metadata: { user_id: 'someone@corp.example' },
    stop: ['END'],
    tools: [{ type: 'function', function: { name: 'f', description: 'phone like 13800138000',
      parameters: { type: 'object', properties: { tel: { type: 'string', description: 'e.g. 13800138000' } } } } }],
    response_format: { type: 'json_schema', json_schema: { name: 'o', schema: { type: 'object', properties: { tel: { type: 'string', description: 'phone 13800138000' } } } } },
    messages: [
      { role: 'user', content: [{ type: 'text', text: '联系我 someone@corp.example' }, { type: 'image_url', image_url: { url: 'http://127.0.0.1:8080/a.png' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"url":"http://127.0.0.1:8080/a.png"}' } }] },
    ],
  };
  const out = redactDeep(JSON.parse(JSON.stringify(body)), undefined, 0);
  eq(out.max_tokens, '4096', 'redact: 字符串 max_tokens 不被误杀');
  eq(out.temperature, '0.7', 'redact: 字符串 temperature 不被误杀');
  eq(out.user, body.user, 'redact: user 参数不被误杀');
  eq(JSON.stringify(out.metadata), JSON.stringify(body.metadata), 'redact: metadata 不被误杀');
  eq(JSON.stringify(out.stop), JSON.stringify(body.stop), 'redact: stop 不被误杀');
  eq(JSON.stringify(out.tools), JSON.stringify(body.tools), 'redact: 工具 schema 不被改写');
  eq(JSON.stringify(out.response_format), JSON.stringify(body.response_format), 'redact: response_format 不被改写');
  eq(out.messages[0].content[1].image_url.url, 'http://127.0.0.1:8080/a.png', 'redact: 图片 URL 原样保留');
  eq(out.messages[1].tool_calls[0].id, 'call_1', 'redact: tool_call id 原样');
  ok(out.messages[1].tool_calls[0].function.arguments.includes('http://127.0.0.1:8080/a.png'), 'redact: 工具参数里的本地 URL 不被改写');
  ok(out.messages[0].content[0].text !== body.messages[0].content[0].text, 'redact: 正文里的邮箱仍然过滤');
}
/* data: URLs / base64 blobs are never scanned (they are payloads, not prose) */
{
  const body = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' } }] }],
    contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: 'A'.repeat(600) } }] }] };
  const out = redactDeep(JSON.parse(JSON.stringify(body)), undefined, 0);
  eq(JSON.stringify(out), JSON.stringify(body), 'redact: base64 / data: 原样');
}

/* Gemini's systemInstruction is prose, not a parameter */
{
  const MAIL = ['someone', 'example.com'].join('@');
  const body = { systemInstruction: { parts: [{ text: 'owner ' + MAIL }] }, contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };
  const out = redactDeep(JSON.parse(JSON.stringify(body)), undefined, 0);
  ok(!out.systemInstruction.parts[0].text.includes(MAIL), 'redact: Gemini systemInstruction 正文被过滤');
}
/* numeric / logprob values are never masked by field-name rules */
{
  const resp = { usage: { input_tokens: '1024', output_tokens: '8', prompt_tokens: '77', token_count: '3' },
    choices: [{ logprobs: { content: [{ token: 'hello', logprob: -0.1 }] } }, { message: { api_key: 'abcdef123456' } }] };
  const out = redactDeep(JSON.parse(JSON.stringify(resp)), undefined, 0);
  eq(out.usage.input_tokens, '1024', 'redact: input_tokens 数值串不被误杀');
  eq(out.usage.output_tokens, '8', 'redact: output_tokens 数值串不被误杀');
  eq(out.usage.prompt_tokens, '77', 'redact: prompt_tokens 数值串不被误杀');
  eq(out.usage.token_count, '3', 'redact: token_count 数值串不被误杀');
  eq(out.choices[0].logprobs.content[0].token, 'hello', 'redact: logprobs token 不被误杀');
  eq(out.choices[1].message.api_key, '***', 'redact: 响应里的 api_key 仍被掩码');
}

/* numeric credentials stay masked; counter keys do not */
{
  const body = { api_key: '123456789012345678', password: '0000', authorization: '10086',
    usage: { input_tokens: '1024', output_tokens: '8', token_count: '3', max_input_tokens: '999' } };
  const out = redactDeep(JSON.parse(JSON.stringify(body)), undefined, 0);
  eq(out.api_key, '***', 'redact: 纯数字 api_key 仍掩码');
  eq(out.password, '***', 'redact: 纯数字 password 仍掩码');
  eq(out.authorization, '***', 'redact: 纯数字 authorization 仍掩码');
  eq(out.usage.input_tokens, '1024', 'redact: input_tokens 不掩码');
  eq(out.usage.token_count, '3', 'redact: token_count 不掩码');
  eq(out.usage.max_input_tokens, '999', 'redact: max_input_tokens 不掩码');
}
/* tool_use.input is executed by the client: a parameter named `token` must survive, prose must not */
{
  const MAIL = ['someone', 'example.com'].join('@');
  const resp = { content: [{ type: 'tool_use', id: 'toolu_1', name: 'f', input: { token: 'abc123', to: MAIL } }] };
  const out = redactDeep(JSON.parse(JSON.stringify(resp)), undefined, 0);
  eq(out.content[0].input.token, 'abc123', 'redact: tool_use.input 里的 token 参数不被改写');
  ok(!out.content[0].input.to.includes(MAIL), 'redact: tool_use.input 里的正文仍被过滤');
  const req = { messages: [{ role: 'user', content: 'x', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"token":"abc123"}' } }] }] };
  eq(redactDeep(JSON.parse(JSON.stringify(req)), undefined, 0).messages[0].tool_calls[0].function.arguments, '{"token":"abc123"}', 'redact: 工具参数字符串原样');
}

/* thinking / reasoning TEXT on the response side is content; the parameter object on the request side is not */
{
  const MAIL = ['someone', 'example.com'].join('@');
  const resp = { content: [{ type: 'thinking', thinking: 'plan with ' + MAIL }, { type: 'text', text: 'ok' }],
    choices: [{ message: { reasoning: 'step ' + MAIL } }] };
  const out = redactDeep(JSON.parse(JSON.stringify(resp)), undefined, 0);
  ok(!out.content[0].thinking.includes(MAIL) && out.content[0].thinking.includes('***'), 'redact: 响应里的 thinking 正文仍被过滤');
  ok(!out.choices[0].message.reasoning.includes(MAIL) && out.choices[0].message.reasoning.includes('***'), 'redact: 响应里的 reasoning 正文仍被过滤');
  const reqBody = { thinking: { type: 'enabled', budget_tokens: 2048 }, reasoning: { effort: 'high' } };
  const out2 = redactDeep(JSON.parse(JSON.stringify(reqBody)), undefined, 0);
  eq(JSON.stringify(out2), JSON.stringify(reqBody), 'redact: 请求里的 thinking/reasoning 参数原样');
}

/* channel-level output cap: chat gets max_tokens, Responses gets max_output_tokens */
{
  const { buildRequestForChannel } = require('../sync.js');
  const cfg = { channels: [] };
  const mk = (type) => ({ name: 'c', type, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', models: ['m'], maxTokens: 1234 });
  const req = { headers: {} };
  const chat = buildRequestForChannel(cfg, mk('openai'), 'openai', 'chat',
    { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { model: 'm' }, req);
  eq(JSON.parse(chat.bodyBuf).max_tokens, 1234, 'maxTokens: chat 渠道注入 max_tokens');
  const resp = buildRequestForChannel(cfg, mk('openai'), 'openai', 'responses',
    { model: 'm', stream: false, messages: [{ role: 'user', content: 'hi' }] }, { model: 'm', input: 'hi' }, { model: 'm' }, req);
  const rb = JSON.parse(resp.bodyBuf);
  eq(rb.max_output_tokens, 1234, 'maxTokens: Responses 渠道注入 max_output_tokens');
  eq(rb.max_tokens, undefined, 'maxTokens: Responses 渠道不注入 max_tokens');
}

console.log(`\nparam passthrough test: ${pass} passed, ${fail} failed`);
if (fail) { console.error(failures.join('\n')); process.exit(1); }
