'use strict';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CosmosDever

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect } = require('./usage.js');

const CWD = 'C:\\Work\\my-repo';

function line(id, ts, model, usage) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, usage } });
}

// Fake <config>/projects/<slug>/<session>/subagents layout.
function fixture() {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'avengers-usage-'));
  const proj = path.join(config, 'projects', 'c--Work-my-repo'); // lowercase drive, like VS Code
  const sub = path.join(proj, 's1', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  const u = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };
  // Bruce: one message split over two lines (same id) + one message before `since`.
  fs.writeFileSync(path.join(sub, 'agent-a.meta.json'), JSON.stringify({ agentType: 'avengers:bruce' }));
  fs.writeFileSync(path.join(sub, 'agent-a.jsonl'), [
    line('m0', '2026-01-01T00:00:00.000Z', 'claude-sonnet-5', u),
    line('m1', '2026-02-01T00:00:00.000Z', 'claude-sonnet-5', u),
    line('m1', '2026-02-01T00:00:00.100Z', 'claude-sonnet-5', u),
    '{not json',
  ].join('\n'));
  // Non-Avengers subagent must be ignored.
  fs.writeFileSync(path.join(sub, 'agent-b.meta.json'), JSON.stringify({ agentType: 'Explore' }));
  fs.writeFileSync(path.join(sub, 'agent-b.jsonl'), line('x', '2026-02-01T00:00:00.000Z', 'claude-haiku-4-5', u));
  // Orchestrator main session.
  fs.writeFileSync(path.join(proj, 's1.jsonl'), line('o1', '2026-02-02T00:00:00.000Z', 'claude-opus-5-5', u));
  // A session with no Avengers agents: orchestrator turns there must not count.
  fs.writeFileSync(path.join(proj, 's2.jsonl'), line('o2', '2026-02-02T00:00:00.000Z', 'claude-opus-5-5', u));
  return config;
}

// D1: sessions that ran /avengers but spawned no agent counted after `since`.
function resumeFixture() {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'avengers-usage-'));
  const proj = path.join(config, 'projects', 'c--Work-my-repo');
  const u = { input_tokens: 10, output_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000 };
  // s3: avengers:tony meta exists, but its usage predates `since` (no usage
  // counted for tony); orchestrator turns after `since` must still count.
  const sub3 = path.join(proj, 's3', 'subagents');
  fs.mkdirSync(sub3, { recursive: true });
  fs.writeFileSync(path.join(sub3, 'agent-c.meta.json'), JSON.stringify({ agentType: 'avengers:tony' }));
  fs.writeFileSync(path.join(sub3, 'agent-c.jsonl'), line('m2', '2026-01-01T00:00:00.000Z', 'claude-sonnet-5', u));
  fs.writeFileSync(path.join(proj, 's3.jsonl'), line('o3', '2026-02-02T00:00:00.000Z', 'claude-opus-5-5', u));
  // s4: no subagents dir at all, but the main transcript ran /avengers (marker
  // present) — orchestrator turns after `since` must still count.
  fs.writeFileSync(
    path.join(proj, 's4.jsonl'),
    line('o4', '2026-02-02T00:00:00.000Z', 'claude-opus-5-5', u) + '\n' +
      JSON.stringify({ type: 'user', timestamp: '2026-02-02T00:00:00.000Z', message: { content: '<command-name>/avengers:avengers</command-name>' } }),
  );
  // s5: neither an avengers agent nor the marker — must not count.
  fs.writeFileSync(path.join(proj, 's5.jsonl'), line('o5', '2026-02-02T00:00:00.000Z', 'claude-opus-5-5', u));
  return config;
}

test('usage: dedupes by message.id, filters by since, only avengers agents + their orchestrator', () => {
  const rows = collect('2026-01-15T00:00:00.000Z', CWD, fixture());
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent, r]));
  assert.deepEqual(Object.keys(byAgent).sort(), ['bruce', 'orchestrator']);
  assert.deepEqual(byAgent.bruce.usage, { input: 10, output: 100, cache_write: 1000, cache_read: 10000 });
  // sonnet-5 at $2/$10: (10*2 + 100*10 + 1000*2.5 + 10000*0.2) / 1e6
  assert.equal(byAgent.bruce.usd.toFixed(6), (5520 / 1e6).toFixed(6));
  assert.equal(byAgent.orchestrator.model, 'claude-opus-5-5');
});

test('usage: D1 — resume sessions with no fresh agent usage still count orchestrator turns', () => {
  const rows = collect('2026-01-15T00:00:00.000Z', CWD, resumeFixture());
  const byAgent = Object.fromEntries(rows.map((r) => [r.agent, r]));
  // (a) agent meta present but sumFile returns null (usage predates since);
  // (b) no subagents dir at all but the /avengers marker is present.
  // Both must be folded into one orchestrator row; s5 (neither) contributes nothing.
  assert.deepEqual(Object.keys(byAgent), ['orchestrator']);
  assert.equal(byAgent.orchestrator.calls, 2); // s3 + s4, not s5
});

test('usage: unknown project dir yields no rows', () => {
  assert.deepEqual(collect('2026-01-01T00:00:00.000Z', 'D:\\nope', fixture()), []);
});

test('usage CLI: prints a table with TOTAL; rejects a bad timestamp', () => {
  const script = path.join(__dirname, 'usage.js');
  const out = execFileSync('node', [script, '2026-01-15T00:00:00Z', CWD], {
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: fixture() },
  });
  assert.match(out, /^agent\s+model/);
  assert.match(out, /\nTOTAL\s+2\s/);
  assert.throws(() => execFileSync('node', [script, 'yesterday'], { stdio: 'pipe' }));
});

test('usage: rateFor maps current model IDs to list prices', () => {
  const { rateFor } = require('./usage.js');
  assert.deepEqual(rateFor('claude-sonnet-5-5'), { in: 2, out: 10 });
  assert.deepEqual(rateFor('claude-opus-5-5'), { in: 4, out: 20 });
  assert.deepEqual(rateFor('claude-opus-5'), { in: 5, out: 25 });
  assert.deepEqual(rateFor('claude-haiku-4-5-20251001'), { in: 1, out: 5 });
});
