#!/usr/bin/env node
'use strict';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CosmosDever

/*
 * Real token/cost report for one /avengers run, read from Claude Code's own
 * transcripts — no hooks, no network.
 *
 *   node usage.js <since-ISO-timestamp> [project-cwd]
 *
 * Layout read: <config>/projects/<slug(cwd)>/<session>/subagents/agent-<id>.jsonl
 * with a sibling agent-<id>.meta.json carrying {agentType}. Only agentType
 * "avengers:*" counts. The orchestrator's own turns (<session>.jsonl) are counted
 * for sessions that spawned an Avengers agent. Only assistant lines with
 * timestamp >= since count, so a resumed run spanning sessions sums correctly.
 *
 * Claude Code writes one JSONL line per content block; duplicate message.id
 * lines carry growing usage snapshots for the same message, so the last one
 * wins (Map overwrite, not sum) and totals stay correct.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// USD per 1M tokens. Cache write = 1.25x input, cache read = 0.1x input.
// ponytail: family-level list prices, ignores 1h-cache 2x and long-context tiers; estimate only.
const RATES = [
  [/fable|mythos/, 10, 50],
  [/opus-5-5/, 4, 20],
  [/opus/, 5, 25],
  [/sonnet-5/, 2, 10],
  [/sonnet/, 3, 15],
  [/haiku/, 1, 5],
];

function rateFor(model) {
  const hit = RATES.find(([re]) => re.test(String(model).toLowerCase()));
  return hit ? { in: hit[1], out: hit[2] } : { in: 3, out: 15 };
}

function costUsd(u, model) {
  const r = rateFor(model);
  return (u.input * r.in + u.output * r.out + u.cache_write * r.in * 1.25 + u.cache_read * r.in * 0.1) / 1e6;
}

// Sum deduped usage from one JSONL file for assistant lines at/after `since`.
// Returns { model, usage } or null if nothing counted.
function sumFile(file, since) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const byId = new Map();
  let model = 'unknown';
  let n = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'assistant' || !e.message || !e.message.usage) continue;
    if (since && !(e.timestamp >= since)) continue;
    byId.set(e.message.id || `__line_${n++}`, e.message.usage);
    if (e.message.model && e.message.model !== '<synthetic>') model = e.message.model;
  }
  if (!byId.size) return null;
  const usage = { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  for (const u of byId.values()) {
    usage.input += num(u.input_tokens);
    usage.output += num(u.output_tokens);
    usage.cache_write += num(u.cache_creation_input_tokens);
    usage.cache_read += num(u.cache_read_input_tokens);
  }
  return { model, usage };
}

// A session ran /avengers if its main transcript has this literal marker,
// even if it resumed and spawned no subagent this run (e.g. only Step 4/7).
function hasAvengersMarker(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  return text.includes('<command-name>/avengers:avengers');
}

function projectDir(configDir, cwd) {
  const root = path.join(configDir, 'projects');
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  let names;
  try { names = fs.readdirSync(root); } catch { return null; }
  const hit = names.find((n) => n.toLowerCase() === slug); // Windows drive-letter case varies
  return hit ? path.join(root, hit) : null;
}

// Pure-ish core: returns rows [{agent, model, calls, usage, usd}] for the run.
function collect(since, cwd, configDir) {
  const dir = projectDir(configDir, cwd);
  if (!dir) return [];
  const rows = new Map();
  const add = (agent, r) => {
    const key = `${agent}\t${r.model}`;
    const row = rows.get(key) || { agent, model: r.model, calls: 0, usage: { input: 0, output: 0, cache_write: 0, cache_read: 0 } };
    row.calls += 1;
    for (const k of Object.keys(row.usage)) row.usage[k] += r.usage[k];
    rows.set(key, row);
  };

  // Each session shows up as a `<session>` folder (if it spawned subagents)
  // and/or a `<session>.jsonl` file; dedupe both to one session id.
  const sessions = new Set(fs.readdirSync(dir).map((e) => (e.endsWith('.jsonl') ? e.slice(0, -'.jsonl'.length) : e)));
  for (const session of sessions) {
    const sessionFile = path.join(dir, `${session}.jsonl`);
    const subDir = path.join(dir, session, 'subagents');
    let metas = [];
    try { metas = fs.readdirSync(subDir).filter((f) => f.endsWith('.meta.json')); } catch { /* no subagents dir */ }
    let hasAvengersMeta = false;
    for (const m of metas) {
      let meta;
      try { meta = JSON.parse(fs.readFileSync(path.join(subDir, m), 'utf8')); } catch { continue; }
      if (!String(meta.agentType || '').startsWith('avengers:')) continue;
      hasAvengersMeta = true;
      const r = sumFile(path.join(subDir, m.replace(/\.meta\.json$/, '.jsonl')), since);
      if (r) add(meta.agentType.slice('avengers:'.length), r);
    }
    // Orchestrator counts if this session spawned an Avengers agent, or ran
    // /avengers at all (resume sessions can spawn no agent this turn).
    if (hasAvengersMeta || hasAvengersMarker(sessionFile)) {
      const r = sumFile(sessionFile, since);
      if (r) add('orchestrator', r);
    }
  }
  return [...rows.values()].map((row) => ({ ...row, usd: costUsd(row.usage, row.model) }));
}

function format(rows) {
  if (!rows.length) return 'no Avengers agent usage found for this run';
  const total = { agent: 'TOTAL', model: '', calls: 0, usage: { input: 0, output: 0, cache_write: 0, cache_read: 0 }, usd: 0 };
  for (const r of rows) {
    total.calls += r.calls;
    total.usd += r.usd;
    for (const k of Object.keys(total.usage)) total.usage[k] += r.usage[k];
  }
  const head = ['agent', 'model', 'calls', 'input', 'output', 'cache_write', 'cache_read', 'est_usd'];
  const cells = [...rows.sort((a, b) => b.usd - a.usd), total].map((r) => [
    r.agent, r.model, r.calls, r.usage.input, r.usage.output, r.usage.cache_write, r.usage.cache_read, r.usd.toFixed(4),
  ].map(String));
  const w = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
  return [head, ...cells].map((c) => c.map((v, i) => v.padEnd(w[i])).join('  ').trimEnd()).join('\n') +
    '\n(orchestrator = whole main session since run start; est_usd uses list prices, not your bill;\n' +
    'a concurrent or later /avengers run in the same repo since `since` is included too)';
}

module.exports = { collect, format, sumFile, rateFor };

if (require.main === module) {
  const [since, cwd = process.cwd()] = process.argv.slice(2);
  if (!since || Number.isNaN(Date.parse(since))) {
    console.error('usage: usage.js <since-ISO-timestamp> [project-cwd]');
    process.exit(1);
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  console.log(format(collect(new Date(since).toISOString(), path.resolve(cwd), configDir)));
}
