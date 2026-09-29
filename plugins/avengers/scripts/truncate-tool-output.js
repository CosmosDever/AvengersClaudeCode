#!/usr/bin/env node
'use strict';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CosmosDever

/*
 * PostToolUse gate for Bash tool output. Deterministic head+tail truncation so a
 * single noisy command can't blow the context budget. No network/API calls, no
 * summarization — just chars in, chars out. Any internal error fails open
 * (emit nothing, exit 0) so a gate bug never breaks the original tool output.
 *
 * Env: AVENGERS_TRUNCATE=off|0|false disables the gate entirely;
 * AVENGERS_TRUNCATE_CHARS=<positive int> overrides the 8000-char budget.
 */

const DEFAULT_LIMIT = 8000;

// Returns the char budget, or null if the gate is switched off.
function limitFromEnv(env) {
  if (/^(off|0|false|no)$/i.test(String(env.AVENGERS_TRUNCATE || '').trim())) return null;
  const n = Number(env.AVENGERS_TRUNCATE_CHARS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_LIMIT;
}

// If cutting at `end` would split a surrogate pair, back off by one so the
// head keeps a whole code unit pair together.
function safeHeadEnd(s, end) {
  if (end > 0 && end < s.length && s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff) return end - 1;
  return end;
}

// Same idea for the tail's start cut: don't start on a lone low surrogate.
function safeTailStart(s, start) {
  if (start > 0 && start < s.length && s.charCodeAt(start) >= 0xdc00 && s.charCodeAt(start) <= 0xdfff) return start + 1;
  return start;
}

// Truncate a single stream to a char budget (head + marker + tail), keeping
// surrogate pairs intact.
function truncateToBudget(s, budget) {
  if (s.length <= budget) return s;
  const headLen = safeHeadEnd(s, Math.floor(budget / 2));
  const tailStart = safeTailStart(s, s.length - Math.ceil(budget / 2));
  const omitted = s.length - headLen - (s.length - tailStart);
  const tokens = Math.round(omitted / 4);
  return `${s.slice(0, headLen)}\n[... ${omitted} chars / ~${tokens} tokens omitted ...]\n${s.slice(tailStart)}`;
}

// Pure: given a hook input object, returns the updatedToolOutput object, or
// null if no truncation is needed / applicable.
function truncate(input, env = process.env) {
  const LIMIT = limitFromEnv(env);
  if (LIMIT === null) return null;
  if (!input || input.tool_name !== 'Bash') return null;
  const r = input.tool_response;
  if (!r || typeof r !== 'object' || typeof r.stdout !== 'string' || typeof r.stderr !== 'string') return null;
  if (r.isImage) return null;
  const { stdout, stderr } = r;
  if (stdout.length + stderr.length <= LIMIT) return null;

  // Split the LIMIT budget evenly between streams; a stream shorter than its
  // share donates the leftover to the other so short streams pass through.
  let budgetOut = LIMIT / 2;
  let budgetErr = LIMIT / 2;
  if (stdout.length < budgetOut) {
    budgetErr += budgetOut - stdout.length;
    budgetOut = stdout.length;
  } else if (stderr.length < budgetErr) {
    budgetOut += budgetErr - stderr.length;
    budgetErr = stderr.length;
  }

  return {
    stdout: truncateToBudget(stdout, budgetOut),
    stderr: truncateToBudget(stderr, budgetErr),
    interrupted: !!r.interrupted,
    isImage: !!r.isImage,
  };
}

function main() {
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(raw);
      const updatedToolOutput = truncate(input);
      if (!updatedToolOutput) return process.exit(0);
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput } }));
      process.exit(0);
    } catch {
      process.exit(0);
    }
  });
}

module.exports = { truncate };

if (require.main === module) main();
