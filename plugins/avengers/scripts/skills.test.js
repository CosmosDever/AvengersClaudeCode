'use strict';

// SPDX-License-Identifier: MIT
// Copyright (c) 2026 CosmosDever

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { frontmatter, loadSkills, match, skillDirs } = require('./skills.js');

const SCRIPT = path.join(__dirname, 'skills.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'avengers-skills-'));
  const write = (name, body) => {
    fs.mkdirSync(path.join(root, '.claude', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'skills', name, 'SKILL.md'), body);
  };
  write('deploy-staging', '---\nname: deploy-staging\ndescription: "Ship the app to the staging cluster with helm"\nkeywords: [deploy, staging, ดีพลอย]\n---\nbody');
  write('db-migration', '---\nname: db-migration\ndescription: Write and run a Postgres schema migration safely\n---\nbody');
  write('broken', 'no frontmatter at all');
  fs.mkdirSync(path.join(root, '.claude', 'skills', 'empty-dir'));
  // symlinked skill dir (how synced skills often arrive); 'junction' needs no admin rights on Windows
  const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'avengers-linked-'));
  fs.writeFileSync(path.join(linked, 'SKILL.md'), '---\nname: linked-skill\ndescription: reached through a symlink\n---\n');
  fs.symlinkSync(linked, path.join(root, '.claude', 'skills', 'linked-skill'), 'junction');
  return root;
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'avengers-home-')); // keep the real ~/.claude out of tests

test('frontmatter: reads quoted and plain values', () => {
  assert.deepEqual(frontmatter('---\nname: x\ndescription: "a: b"\n---\n'), { name: 'x', description: 'a: b' });
  assert.deepEqual(frontmatter('nothing'), {});
});

test('loadSkills: follows symlinks, skips dirs without SKILL.md, falls back to dir name, tolerates missing dirs', () => {
  const skills = loadSkills([...skillDirs(fixture(), home), '/does/not/exist']);
  assert.deepEqual(skills.map((s) => s.name).sort(), ['broken', 'db-migration', 'deploy-staging', 'linked-skill']);
});

test('match: keyword hit ranks first, unrelated text matches nothing', () => {
  const skills = loadSkills(skillDirs(fixture(), home));
  assert.equal(match('please deploy this to staging', skills)[0].name, 'deploy-staging');
  assert.equal(match('run the postgres schema migration', skills)[0].name, 'db-migration');
  assert.deepEqual(match('fix the typo in the footer', skills), []);
});

test('match: ASCII keywords need whole words; Thai keywords match inside running text', () => {
  const skills = loadSkills(skillDirs(fixture(), home));
  assert.deepEqual(match('redeployed yesterday', skills), []);
  assert.equal(match('ช่วยดีพลอยให้หน่อย', skills)[0].name, 'deploy-staging');
});

test('hook CLI: emits additionalContext on a hit, nothing on a miss, bad input, or when disabled', () => {
  const root = fixture();
  const run = (input, env = {}) => execFileSync('node', [SCRIPT, 'hook'], { input, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: root, ...env } });
  const out = JSON.parse(run(JSON.stringify({ prompt: 'deploy to staging' })));
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(out.hookSpecificOutput.additionalContext, /deploy-staging/);
  assert.equal(run(JSON.stringify({ prompt: 'hello there' })), '');
  assert.equal(run('not json'), '');
  assert.equal(run(JSON.stringify({ prompt: 'deploy to staging' }), { AVENGERS_SKILL_HINT: 'off' }), '');
});
