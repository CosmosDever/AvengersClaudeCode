'use strict';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CosmosDever

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { truncate } = require('./truncate-tool-output.js');

const SCRIPT = path.join(__dirname, 'truncate-tool-output.js');

function runCli(input, env = {}) {
  const out = execFileSync('node', [SCRIPT], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return out;
}

test('truncate: oversized Bash stdout/stderr is head+tail truncated', () => {
  const stdout = 'A'.repeat(9000);
  const stderr = 'B'.repeat(9000);
  const result = truncate({ tool_name: 'Bash', tool_response: { stdout, stderr, interrupted: false, isImage: false } });
  assert.ok(result);
  assert.equal(result.stdout.length < stdout.length, true);
  assert.match(result.stdout, /chars \/ ~\d+ tokens omitted/);
  assert.equal(result.stdout.startsWith('A'.repeat(2000)), true);
  assert.equal(result.stdout.endsWith('A'.repeat(2000)), true);
  assert.equal(result.interrupted, false);
});

test('truncate: combined-only trigger (both under LIMIT alone) still truncates both', () => {
  const stdout = 'A'.repeat(6000);
  const stderr = 'B'.repeat(6000);
  const result = truncate({ tool_name: 'Bash', tool_response: { stdout, stderr, interrupted: false, isImage: false } });
  assert.ok(result);
  assert.equal(result.stdout.length + result.stderr.length < 12000, true);
  assert.match(result.stdout, /chars \/ ~\d+ tokens omitted/);
  assert.match(result.stderr, /chars \/ ~\d+ tokens omitted/);
});

test('truncate: short stream is left alone, oversized stream donates budget from short one', () => {
  const stdout = 'A'.repeat(20000);
  const stderr = 'B'.repeat(100);
  const result = truncate({ tool_name: 'Bash', tool_response: { stdout, stderr, interrupted: false, isImage: false } });
  assert.ok(result);
  assert.equal(result.stderr, stderr);
  assert.equal(result.stdout.length < 8000 && result.stdout.length > 7800, true, `expected ~7900, got ${result.stdout.length}`);
});

test('truncate: does not split a surrogate pair at the head/tail cut', () => {
  const emoji = '😀'; // U+1F600, split as high+low surrogate
  const stdout = 'A'.repeat(3999) + emoji + 'A'.repeat(3999) + emoji + 'B'.repeat(4000);
  const stderr = '';
  const result = truncate({ tool_name: 'Bash', tool_response: { stdout, stderr, interrupted: false, isImage: false } });
  assert.ok(result);
  const lonelySurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(lonelySurrogate.test(result.stdout), false);
});

test('truncate: small output is left alone (no-op)', () => {
  const result = truncate({ tool_name: 'Bash', tool_response: { stdout: 'hi', stderr: '', interrupted: false, isImage: false } });
  assert.equal(result, null);
});

test('truncate: non-Bash tool is skipped', () => {
  const result = truncate({ tool_name: 'Read', tool_response: { stdout: 'A'.repeat(9000), stderr: '', interrupted: false, isImage: false } });
  assert.equal(result, null);
});

test('truncate: malformed input (missing tool_response) is a no-op', () => {
  assert.equal(truncate({ tool_name: 'Bash' }), null);
  assert.equal(truncate(null), null);
  assert.equal(truncate({}), null);
});

test('truncate: isImage true passes through untruncated even if oversized', () => {
  const result = truncate({ tool_name: 'Bash', tool_response: { stdout: 'A'.repeat(9000), stderr: '', interrupted: false, isImage: true } });
  assert.equal(result, null);
});

test('truncate: AVENGERS_TRUNCATE=off disables the gate', () => {
  const input = { tool_name: 'Bash', tool_response: { stdout: 'A'.repeat(20000), stderr: '', interrupted: false, isImage: false } };
  for (const v of ['off', 'OFF', '0', 'false']) assert.equal(truncate(input, { AVENGERS_TRUNCATE: v }), null);
  assert.ok(truncate(input, { AVENGERS_TRUNCATE: 'on' }));
});

test('truncate: AVENGERS_TRUNCATE_CHARS overrides the budget; junk falls back to 8000', () => {
  const input = { tool_name: 'Bash', tool_response: { stdout: 'A'.repeat(20000), stderr: '', interrupted: false, isImage: false } };
  const small = truncate(input, { AVENGERS_TRUNCATE_CHARS: '1000' });
  assert.ok(small.stdout.length < 1100, `got ${small.stdout.length}`);
  assert.equal(truncate(input, { AVENGERS_TRUNCATE_CHARS: '50000' }), null);
  for (const v of ['abc', '-5', '0', '1.5']) {
    const r = truncate(input, { AVENGERS_TRUNCATE_CHARS: v });
    assert.ok(r.stdout.length > 7800 && r.stdout.length < 8100, `${v}: got ${r.stdout.length}`);
  }
});

// --- subprocess smoke test: the actual hook contract over stdin/stdout ---

test('truncate CLI: oversized input on stdin produces the hookSpecificOutput envelope', () => {
  const stdout = 'A'.repeat(9000);
  const out = runCli({ tool_name: 'Bash', tool_response: { stdout, stderr: '', interrupted: false, isImage: false } });
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.ok(parsed.hookSpecificOutput.updatedToolOutput.stdout.length < stdout.length);
});

test('truncate CLI: small input produces no stdout at all', () => {
  const out = runCli({ tool_name: 'Bash', tool_response: { stdout: 'hi', stderr: '', interrupted: false, isImage: false } });
  assert.equal(out, '');
});

test('truncate CLI: AVENGERS_TRUNCATE=off in the hook env produces no stdout', () => {
  const out = runCli({ tool_name: 'Bash', tool_response: { stdout: 'A'.repeat(9000), stderr: '', interrupted: false, isImage: false } }, { AVENGERS_TRUNCATE: 'off' });
  assert.equal(out, '');
});

test('truncate CLI: malformed JSON on stdin exits 0 with no output', () => {
  const out = execFileSync('node', [SCRIPT], { input: 'not json{{{', encoding: 'utf8' });
  assert.equal(out, '');
});
