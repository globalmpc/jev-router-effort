import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startCodexProxy,
  codexModels,
  effortForModel,
  jevDecisionEvents,
  addJevModel,
  applyCodexTier,
  CODEX_AUTO_EFFORT,
} from '../src/codex-proxy.mjs';
import { codexArgs } from '../src/codex-cli.mjs';

test('Codex launcher defaults Jev Router effort to auto', () => {
  const automatic = codexArgs('http://127.0.0.1:1234', []);
  assert.ok(automatic.includes('model_reasoning_effort="auto"'));
  const concrete = codexArgs('http://127.0.0.1:1234', ['--model', 'gpt-6-sol']);
  assert.ok(!concrete.includes('model_reasoning_effort="auto"'));
});

test('Jev model exposes auto as the default plus every catalog effort', () => {
  const catalog = addJevModel({ models: [{
    slug: 'gpt-6-astra',
    supported_reasoning_levels: [
      { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
      { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
    ],
  }] });
  const jev = catalog.models[0];
  assert.equal(jev.default_reasoning_level, CODEX_AUTO_EFFORT);
  assert.deepEqual(
    jev.supported_reasoning_levels.map(level => level.effort),
    ['auto', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  );
});

test('effort routing exposes API levels while excluding client-only catalog levels', () => {
  const catalog = new Map([['gpt-6-astra', {
    slug: 'gpt-6-astra',
    supported_in_api: true,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'none' },
      { effort: 'minimal' },
      { effort: 'low' },
      { effort: 'medium' },
      { effort: 'high' },
      { effort: 'xhigh' },
      { effort: 'max' },
      { effort: 'ultra' },
      { effort: 'auto' },
      { effort: 'future-client-mode' },
    ],
  }]]);
  const [model] = codexModels(catalog);
  assert.deepEqual(model.efforts, ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.match(model.description, /supported reasoning efforts: none, minimal, low, medium, high, xhigh, max/);
  assert.doesNotMatch(model.description, /ultra|auto|future-client-mode/);
  assert.equal(effortForModel(model, 'max', 'low'), 'max');
  assert.equal(effortForModel(model, 'ultra', 'low'), 'low');
  assert.equal(effortForModel(model, 'unsupported', 'high'), 'high');
  assert.match(
    jevDecisionEvents({ tier: 'fable', model: model.id, effort: 'max', confidence: 0.9,
      effortMode: 'auto', effortConfidence: 0.8, reason: 'jev' }),
    /effort auto → max \(0\.80\)/,
  );
});

test('effort fallback rejects client-only levels even in unfiltered model metadata', () => {
  const model = { efforts: ['ultra', 'auto', 'high', 'max'], defaultEffort: 'ultra' };
  assert.equal(effortForModel(model, 'ultra', 'max'), 'max');
  assert.equal(effortForModel(model, 'auto', 'ultra'), 'high');
  assert.equal(effortForModel({ ...model, defaultEffort: 'max' }, 'ultra'), 'max');
  assert.equal(effortForModel({ efforts: ['ultra', 'auto'], defaultEffort: 'ultra' }, 'ultra', 'auto'), null);
});

test('automatic request normalization cannot emit client-only effort, even without a valid fallback', () => {
  const models = new Map([['gpt-6-sol', {
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'max' }, { effort: 'ultra' }, { effort: 'auto' }],
  }]]);
  for (const effort of ['ultra', 'auto']) {
    const body = { model: 'jev-router', reasoning: { effort, summary: 'none' } };
    applyCodexTier(body, 'opus', models, 'gpt-6-sol');
    assert.equal(body.reasoning.effort, 'medium');
    assert.equal(body.reasoning.summary, 'none');
  }
  models.set('gpt-6-sol', {
    default_reasoning_level: 'ultra',
    supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 'auto' }],
  });
  const body = { model: 'jev-router', reasoning: { effort: 'ultra', summary: 'none' } };
  applyCodexTier(body, 'opus', models, 'gpt-6-sol');
  assert.equal(Object.hasOwn(body.reasoning, 'effort'), false);
  assert.equal(body.reasoning.summary, 'none');
});

for (const lite of [true, false]) {
  test(`wire compatibility: Lite=${lite} filters choices and pinned continuations`, async () => {
    const sent = [];
    const catalog = [
      { slug: 'gpt-5.5', supported_in_api: true, use_responses_lite: false },
      { slug: 'gpt-6-sol', supported_in_api: true, use_responses_lite: true },
      { slug: 'gpt-unknown', supported_in_api: true },
    ];
    const upstream = http.createServer(async (req, res) => {
      if (req.url.startsWith('/models')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ models: catalog }));
        return;
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      sent.push({ model: body.model, lite: req.headers['x-openai-internal-codex-responses-lite'] });
      res.statusCode = req.headers['x-openai-internal-codex-responses-lite'] && body.model !== 'gpt-6-sol' ? 400 : 200;
      res.end('{}');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${upstream.address().port}`;
    const proxy = await startCodexProxy({ chatgptBaseURL: base, apiBaseURL: base, route: async ({ models }) => {
      assert.deepEqual(models.map(m => m.id), lite ? ['gpt-6-sol'] : catalog.map(m => m.slug));
      return { choice: 'gpt-5.5', confidence: 1 };
    } });
    try {
      for (const input of [
        [{ type: 'additional_tools' }, { role: 'user', content: 'hello' }],
        [{ type: 'function_call_output', output: 'ok' }],
      ]) {
        const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(lite ? { 'X-OpenAI-Internal-Codex-Responses-Lite': 'true' } : {}) },
          body: JSON.stringify({ model: 'jev-router', prompt_cache_key: 'wire-test', input }),
        });
        await response.text();
        assert.equal(response.status, 200);
      }
      assert.deepEqual(sent, Array(2).fill({ model: lite ? 'gpt-6-sol' : 'gpt-5.5', lite: lite ? 'true' : undefined }));
    } finally {
      proxy.close();
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
}

test('an absent catalog never produces hardcoded model candidates', () => {
  assert.deepEqual(codexModels(), []);
});

test('API-safe routing survives rejecting upstream, pins continuations, and preserves native manual Ultra requests', async () => {
  const sent = [];
  const catalog = [{
    slug: 'gpt-6-sol',
    supported_in_api: true,
    use_responses_lite: true,
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low' }, { effort: 'medium' }, { effort: 'high' },
      { effort: 'xhigh' }, { effort: 'max' }, { effort: 'ultra' },
    ],
  }];
  const upstream = http.createServer(async (req, res) => {
    if (req.url.startsWith('/models')) return void res.end(JSON.stringify({ models: catalog }));
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    sent.push(body);
    if (['ultra', 'auto'].includes(body.reasoning?.effort)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid reasoning.effort' } }));
      return;
    }
    res.end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;
  let routeCalls = 0;
  const proxy = await startCodexProxy({ chatgptBaseURL: base, apiBaseURL: base,
    route: async ({ efforts, prompt }) => {
      routeCalls++;
      assert.deepEqual(efforts, prompt === 'manual task'
        ? []
        : ['low', 'medium', 'high', 'xhigh', 'max']);
      return { choice: 'gpt-6-sol', confidence: 1,
        effort: prompt === 'stale decision' ? 'ultra' : 'max', effortConfidence: 0.9 };
    },
  });
  try {
    const postBody = async body => {
      const response = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-OpenAI-Internal-Codex-Responses-Lite': 'true' },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
    };
    const post = (input, effort = 'auto', key = 'effort-test') => postBody({
      model: 'jev-router', prompt_cache_key: key, reasoning: { effort }, input,
    });
    const newTurn = content => [{ type: 'additional_tools' }, { role: 'user', content }];
    const continuation = [{ type: 'function_call_output', output: 'ok' }];
    await post(newTurn('hard task'));
    await post(continuation);
    await post(newTurn('stale decision'), 'auto', 'stale-effort-test');
    await post(continuation, 'auto', 'stale-effort-test');
    await post(newTurn('manual task'), 'high', 'manual-effort-test');
    const nativeManualBody = {
      model: 'gpt-6-astra',
      prompt_cache_key: 'native-manual-ultra',
      reasoning: { effort: 'xhigh', context: 'all_turns' },
      input: [
        { role: 'developer', content: '<multi_agent_mode>Proactive multi-agent delegation is active.</multi_agent_mode>' },
        ...newTurn('native Ultra task'),
      ],
    };
    await postBody(nativeManualBody);
    assert.deepEqual(sent.map(body => body.reasoning.effort), ['max', 'max', 'medium', 'medium', 'high', 'xhigh']);
    assert.deepEqual(sent.at(-1), nativeManualBody);
    assert.equal(routeCalls, 3);
  } finally {
    proxy.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

for (const unavailable of [false, true]) {
  test(`cold start: catalog ${unavailable ? 'failure blocks forwarding' : 'controls routing and tool continuations'}`, async () => {
    const sent = [];
    const catalog = [{ slug: 'gpt-6-luna', supported_in_api: true }];
    const upstream = http.createServer(async (req, res) => {
      if (req.url.startsWith('/models')) {
        res.writeHead(unavailable ? 401 : 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: catalog }));
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      sent.push(JSON.parse(body));
      res.end('{}');
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${upstream.address().port}`;
    let calls = 0;
    const proxy = await startCodexProxy({ chatgptBaseURL: base, apiBaseURL: base, route: async ({ models }) => {
      calls++;
      assert.deepEqual(models.map(m => m.id), ['gpt-6-luna']);
      // A stale/invalid Jev answer must not reintroduce an unavailable model.
      return { choice: 'gpt-nonexistent', confidence: 1 };
    } });
    try {
      const post = input => fetch(`http://127.0.0.1:${proxy.port}/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'jev-router', prompt_cache_key: 'test', input }),
      });
      const response = await post([{ type: 'additional_tools' }, { role: 'user', content: 'hello' }]);
      await response.text();
      assert.equal(response.status, unavailable ? 503 : 200);
      if (unavailable) {
        assert.equal(sent.length, 0);
        assert.equal(calls, 0);
      } else {
        const continuation = await post([{ type: 'function_call_output', output: 'ok' }]);
        await continuation.text();
        assert.equal(continuation.status, 200);
        assert.deepEqual(sent.map(body => body.model), ['gpt-6-luna', 'gpt-6-luna']);
        assert.equal(calls, 1);
      }
    } finally {
      proxy.close();
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
  });
}
