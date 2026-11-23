'use strict';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CosmosDever

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const m = require('./memory.js');

const SCRIPT = path.join(__dirname, 'memory.js');
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), `avengers-mem-${p}-`));

function project() {
  const dir = tmp('proj');
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://someone@github.com/acme/shop.git']);
  const run = (id, step, state) => {
    fs.mkdirSync(path.join(dir, '.avengers', id), { recursive: true });
    fs.writeFileSync(path.join(dir, '.avengers', id, 'state.json'), JSON.stringify(state));
    fs.writeFileSync(path.join(dir, '.avengers', id, 'progress.json'), JSON.stringify({ step }));
  };
  run('20260101-000000', 'done', {
    decisions: { D1: { value: 'Use row locks for stock', rationale: 'avoids oversell' } },
    facts: { F1: { value: 'API lives in src/api', evidence: 'src/api/index.ts' } },
    risks: { R1: { value: 'Refunds can race', severity: 'high' }, R2: { value: 'Deploy key is password=hunter2secret', severity: 'high' } },
  });
  run('20260201-000000', '2', { decisions: { D1: { value: 'use  ROW locks for stock', rationale: 'same' }, D2: { value: 'Add a queue', rationale: 'draft' } } });
  fs.mkdirSync(path.join(dir, '.avengers', 'assets')); // not a run
  return dir;
}

const note = (name, extra = {}) => ({ name, type: 'decision', status: 'verified', description: 'Stock uses row locks', keywords: ['stock', 'สต็อก'], source: 'x', files: ['src/a.ts'], body: 'Row locks.', ...extra });

test('repoIdFromUrl: https, credentials, ssh, and junk', () => {
  assert.equal(m.repoIdFromUrl('https://someone@github.com/acme/shop.git'), 'acme--shop');
  assert.equal(m.repoIdFromUrl('git@github.com:acme/shop.git'), 'acme--shop');
  assert.equal(m.repoIdFromUrl(''), null);
});

test('hasSecret: catches credentials, ignores placeholders and prose', () => {
  for (const s of ['password=hunter2secret', 'ghp_' + 'a'.repeat(36), 'postgres://u:pw12345@db/x', 'api_key: "abcdef123456"']) assert.equal(m.hasSecret(s), true, s);
  for (const s of ['password=${DB_PASS}', 'rotate the api key monthly', 'token: <redacted>']) assert.equal(m.hasSecret(s), false, s);
});

test('scan: counts real runs only and flags unfinished ones', () => {
  const r = m.scan(project(), tmp('home'));
  assert.equal(r.runs, 2);
  assert.equal(r.finished_runs, 1);
  assert.deepEqual(r.unfinished_runs, ['20260201-000000']);
});

test('extract: dedupes, blocks secrets, newest first', () => {
  const r = m.extract(project());
  assert.equal(r.secrets_blocked, 1);
  assert.equal(r.duplicates, 1);
  assert.equal(r.candidates.length, 4);
  assert.equal(r.candidates[0].run, '20260201-000000');
  assert.equal(JSON.stringify(r).includes('hunter2'), false);
});

test('writeNotes: dry run writes nothing; real write is idempotent and never overwrites', () => {
  const dir = project();
  const vault = tmp('vault');
  assert.equal(m.writeNotes({ notes: [note('stock-locks')] }, dir, { vault, dryRun: true }).written, 1);
  assert.equal(fs.existsSync(path.join(vault, 'repos')), false);
  const first = m.writeNotes({ notes: [note('stock-locks')] }, dir, { vault });
  assert.equal(first.written, 1);
  const file = path.join(vault, 'repos', 'acme--shop', 'decisions', 'stock-locks.md');
  fs.appendFileSync(file, 'my edit\n');
  const again = m.writeNotes({ notes: [note('stock-locks', { body: 'other' })] }, dir, { vault });
  assert.deepEqual([again.written, again.skipped], [0, ['stock-locks']]);
  assert.match(fs.readFileSync(file, 'utf8'), /my edit/);
});

test('writeNotes: one bad note rejects the whole proposal', () => {
  const dir = project();
  const vault = tmp('vault');
  for (const bad of [note('../evil'), note('leaky', { body: 'password=hunter2secret' }), note('x-y', { type: 'nope' })]) {
    const r = m.writeNotes({ notes: [note('good-note'), bad] }, dir, { vault });
    assert.equal(r.written, 0);
    assert.equal(r.errors.length, 1);
  }
  assert.equal(fs.existsSync(path.join(vault, 'repos')), false);
});

test('undo: removes untouched notes, keeps edited ones', () => {
  const dir = project();
  const vault = tmp('vault');
  const r = m.writeNotes({ notes: [note('note-one'), note('note-two')] }, dir, { vault, migration: true });
  fs.appendFileSync(path.join(vault, 'repos', 'acme--shop', 'decisions', 'note-two.md'), 'edited\n');
  const u = m.undo(r.id, dir, { vault });
  assert.equal(u.removed.length, 1);
  assert.equal(u.kept_because_edited.length, 1);
  assert.notEqual(m.sessionHint(dir, { vault, home: tmp('home') }), null); // migration can be offered again
});

test('matchNotes: finds Thai keywords, follows links, hides superseded, skips inbox', () => {
  const dir = project();
  const vault = tmp('vault');
  m.writeNotes({ notes: [
    note('stock-locks', { links: ['refund-race'] }),
    note('refund-race', { description: 'Refunds can race', keywords: ['refund'] }),
    note('old-stock', { status: 'superseded' }),
    note('draft-stock', { inbox: true }),
  ] }, dir, { vault });
  const r = m.matchNotes('แก้ระบบสต็อกหน่อย', m.loadNotes(vault, 'acme--shop'));
  assert.deepEqual(r.hits.map((h) => h.name), ['stock-locks']);
  assert.deepEqual(r.related.map((h) => h.name), ['refund-race']);
});

test('batch + mergeProposals: splits evenly, first name wins, dangling links dropped', () => {
  const dir = tmp('batch');
  const file = path.join(dir, 'c.json');
  fs.writeFileSync(file, JSON.stringify({ candidates: [1, 2, 3, 4, 5] }));
  assert.equal(m.batch(file, 2, path.join(dir, 'out')).batches, 3);
  assert.throws(() => m.batch(file, 0, dir));
  const r = m.mergeProposals([{ notes: [note('a-note', { body: 'first', links: ['b-note', 'gone-note'] })] }, { notes: [note('a-note', { body: 'second' }), note('b-note')] }]);
  assert.deepEqual(r.dropped, ['a-note']);
  assert.equal(r.notes[0].body, 'first');
  assert.deepEqual(r.notes[0].links, ['b-note']);
});

test('sessionHint: nudges once, stops after skip, silent without history', () => {
  const dir = project();
  const vault = tmp('vault');
  const home = tmp('home');
  assert.match(m.sessionHint(dir, { vault, home }), /2 past run/);
  m.skip(dir, { vault });
  assert.equal(m.sessionHint(dir, { vault, home }), null);
  assert.equal(m.sessionHint(tmp('empty'), { vault, home }), null);
});

test('hook CLI: emits context on a hit; silent on miss, bad input, or when disabled', () => {
  const dir = project();
  const vault = tmp('vault');
  m.writeNotes({ notes: [note('stock-locks')] }, dir, { vault });
  const run = (input, env = {}) => execFileSync('node', [SCRIPT, 'hook-prompt'], { input, encoding: 'utf8', env: { ...process.env, AVENGERS_VAULT: vault, CLAUDE_PROJECT_DIR: dir, ...env } });
  const out = JSON.parse(run(JSON.stringify({ prompt: 'change stock logic' })));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /stock-locks/);
  assert.equal(run(JSON.stringify({ prompt: 'hello there' })), '');
  assert.equal(run('not json'), '');
  assert.equal(run(JSON.stringify({ prompt: 'change stock logic' }), { AVENGERS_MEMORY: 'off' }), '');
});
