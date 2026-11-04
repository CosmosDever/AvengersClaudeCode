#!/usr/bin/env node
'use strict';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CosmosDever

/*
 * Picks the few skills relevant to a piece of text, so the model isn't left to
 * find them in a long skill listing (lost in the middle). Deterministic word
 * matching over SKILL.md frontmatter (name, description, keywords). No network.
 *
 *   node skills.js match "<text>" [projectDir]   -> JSON [{name, path, score}]
 *   node skills.js hook                          -> UserPromptSubmit hook (stdin JSON)
 *
 * Scans <projectDir>/.claude/skills and ~/.claude/skills.
 * Env: AVENGERS_SKILL_HINT=off|0|false disables the hook.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MAX_HITS = 3;
const MIN_SCORE = 3; // one name/keyword hit, or three description words
const STOP = new Set(('the and for with this that when use used using user users asks ask want wants into from your you are any not but all can will should about also only than then them they what which while skill skills trigger triggers like such other more each does make makes run runs').split(' '));

// Minimal frontmatter reader: top-level `key: value` lines only.
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function list(value) {
  return String(value || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase()).filter(Boolean);
}

function skillDirs(projectDir, home = os.homedir()) {
  return [projectDir && path.join(projectDir, '.claude', 'skills'), home && path.join(home, '.claude', 'skills')].filter(Boolean);
}

// ponytail: rescans SKILL.md files on every call; fine up to ~200 skills, cache an index if it gets slow.
function loadSkills(dirs) {
  const seen = new Set();
  const skills = [];
  for (const dir of dirs) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) { // no isDirectory() check: synced skills are often symlinks/junctions
      const file = path.join(dir, e.name, 'SKILL.md');
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const fm = frontmatter(text);
      const name = fm.name || e.name;
      if (seen.has(name)) continue; // project copy wins over the user-level one
      seen.add(name);
      skills.push({ name, description: fm.description || '', keywords: list(fm.keywords), path: file });
    }
  }
  return skills;
}

const words = (s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP.has(w));

// ASCII terms match whole words; others (e.g. Thai, written without spaces) match as substrings.
function contains(text, term) {
  if (!term) return false;
  if (/^[\x00-\x7f]+$/.test(term)) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`).test(text);
  }
  return text.includes(term);
}

function score(skill, text) {
  let s = 0;
  const strong = new Set([skill.name.toLowerCase(), skill.name.toLowerCase().replace(/[-_]/g, ' '), ...skill.keywords]);
  for (const t of strong) if (contains(text, t)) s += 3;
  for (const w of new Set(words(skill.description))) if (contains(text, w)) s += 1;
  return s;
}

function match(text, skills) {
  const lower = String(text || '').toLowerCase();
  return skills
    .map((sk) => ({ name: sk.name, description: sk.description, path: sk.path, score: score(sk, lower) }))
    .filter((r) => r.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, MAX_HITS);
}

function hint(hits) {
  if (!hits.length) return null;
  const lines = hits.map((h) => `- ${h.name}: ${h.description.length > 160 ? h.description.slice(0, 157) + '...' : h.description}`);
  return ['Skills likely relevant to this request (load with the Skill tool if they apply; ignore if not):', ...lines].join('\n');
}

function hookOff(env) {
  return /^(off|0|false|no)$/i.test(String(env.AVENGERS_SKILL_HINT || '').trim());
}

function main(argv) {
  const [cmd, text, dir] = argv;
  if (cmd === 'match') {
    const hits = match(text, loadSkills(skillDirs(dir || process.cwd())));
    console.log(JSON.stringify(hits.map(({ name, path: p, score: s }) => ({ name, path: p, score: s })), null, 2));
    return;
  }
  if (cmd === 'hook') {
    let raw = '';
    process.stdin.on('data', (c) => { raw += c; });
    process.stdin.on('end', () => {
      try { // fail open: any error means no hint, never a blocked prompt
        if (hookOff(process.env)) return;
        const input = JSON.parse(raw);
        const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
        const ctx = hint(match(input.prompt, loadSkills(skillDirs(projectDir))));
        if (ctx) console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } }));
      } catch { /* no hint */ }
    });
    return;
  }
  console.error('usage: skills.js match "<text>" [projectDir] | skills.js hook');
  process.exitCode = 2;
}

module.exports = { frontmatter, loadSkills, match, hint, skillDirs };

if (require.main === module) main(process.argv.slice(2));
