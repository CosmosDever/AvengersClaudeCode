'use strict';

/*
 * Integration/smoke coverage for the actual `node state.js <cmd>` CLI, run as a real
 * subprocess against real files on disk — not the in-process functions state.test.js
 * exercises. This is what catches the class of bug unit tests miss: CLI arg parsing,
 * JSON round-tripping through the filesystem, exit codes, and whether the sequences
 * documented in commands/avengers.md actually work if followed literally.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'state.js');

function workDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'avengers-smoke-'));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj));
}

function run(args) {
  const out = execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
  return JSON.parse(out);
}

function runFails(args) {
  try {
    execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('expected the CLI to exit non-zero');
  } catch (err) {
    return err;
  }
}

// --- SMALL: router skips debate entirely, so init + render is the whole CLI surface ---

test('smoke: SMALL route end to end via real CLI calls', () => {
  const dir = workDir();
  const initPath = path.join(dir, 'init.json');
  const statePath = path.join(dir, 'state.json');
  writeJson(initPath, {
    complexity_score: 0,
    risk_flags: {},
    routing_reason: ['rename a UI label'],
    goal: ['rename the export button label'],
    constraints: [],
  });

  const initResult = run(['init', initPath, statePath]);
  assert.equal(initResult.route, 'SMALL');

  const rendered = execFileSync('node', [SCRIPT, 'render', statePath], { encoding: 'utf8' });
  assert.match(rendered, /route: SMALL/);
  assert.match(rendered, /rename the export button label/);
});

// --- MEDIUM: the exact sequence documented in commands/avengers.md's own example ---

test('smoke: MEDIUM route converges through the CLI exactly as avengers.md documents', () => {
  const dir = workDir();
  const initPath = path.join(dir, 'init.json');
  const statePath = path.join(dir, 'state.json');
  writeJson(initPath, {
    complexity_score: 2,
    risk_flags: {},
    routing_reason: ['cross-file behavior change'],
    goal: ['add retry to webhook'],
    constraints: ['keep API compatible'],
  });
  assert.equal(run(['init', initPath, statePath]).route, 'MEDIUM');

  const delta1 = path.join(dir, 'delta1.json');
  writeJson(delta1, {
    actor: 'bruce', seen_version: 0, action: 'PATCH',
    patch: { decisions: { add: { D1: { value: 'reuse scheduler', rationale: 'less infra' } } } },
    reason: ['existing scheduler already supports delay'],
    evidence: ['src/scheduler.ts:41'],
  });
  const r1 = run(['apply', statePath, delta1]);
  assert.equal(r1.applied, true);
  assert.equal(r1.converged, false);
  assert.equal(r1.budget.remaining, 2);

  const delta2 = path.join(dir, 'delta2.json');
  writeJson(delta2, { actor: 'tony', seen_version: 1, action: 'ACCEPT' });
  const r2 = run(['apply', statePath, delta2]);
  assert.equal(r2.applied, true);
  assert.equal(r2.converged, true, 'documented 2-call flow must converge');
  assert.equal(r2.budget.used, 2);

  const rendered = execFileSync('node', [SCRIPT, 'render', statePath], { encoding: 'utf8' });
  assert.match(rendered, /reuse scheduler/);
  assert.match(rendered, /approvals: bruce=1 tony=1/);
});

// --- HIGH: budget exhaustion -> Thor escalation -> human-decision patch closes it out ---

test('smoke: HIGH route exhausts debate budget, then a human-decision patch converges it', () => {
  const dir = workDir();
  const initPath = path.join(dir, 'init.json');
  const statePath = path.join(dir, 'state.json');
  writeJson(initPath, {
    complexity_score: 2,
    risk_flags: { security: true },
    routing_reason: ['changes authorization behavior'],
    goal: ['fix authz bypass'],
    constraints: [],
  });
  assert.equal(run(['init', initPath, statePath]).route, 'HIGH');

  // Bruce and Tony disagree and keep re-blocking with the SAME reason each round —
  // real rhetorical repetition, so the engine should mark every repeat NO_STATE_CHANGE
  // and never let the debate converge on its own.
  const actors = ['bruce', 'tony', 'bruce', 'tony', 'bruce'];
  let lastBudget;
  for (let i = 0; i < actors.length; i++) {
    const deltaPath = path.join(dir, `delta${i}.json`);
    writeJson(deltaPath, {
      actor: actors[i],
      seen_version: i === 0 ? 0 : 1, // only the first call actually changes the version
      action: i === 0 ? 'BLOCK' : 'BLOCK',
      blockers: [{ id: 'B1', reason: 'ownership of the fix is disputed', requires_human_decision: true }],
    });
    lastBudget = run(['apply', statePath, deltaPath]).budget;
  }
  assert.equal(lastBudget.used, 5);
  assert.equal(lastBudget.exhausted, true);

  const rendered = execFileSync('node', [SCRIPT, 'render', statePath], { encoding: 'utf8' });
  assert.match(rendered, /unresolved_blockers/);

  // Thor summarizes, the user decides, orchestrator applies one final patch that
  // resolves the blocker and gets both approvals onto the current version.
  const stateBeforeDecision = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const humanDecision = path.join(dir, 'human-decision.json');
  writeJson(humanDecision, {
    actor: 'bruce', seen_version: stateBeforeDecision.version, action: 'PATCH',
    patch: {
      decisions: { add: { D1: { value: 'security team owns the fix per human decision', rationale: 'human call after Thor summary' } } },
      blockers: { resolve: ['B1'] },
    },
    reason: ['human decided after Thor summary'],
  });
  const r = run(['apply', statePath, humanDecision]);
  assert.equal(r.applied, true);
  assert.equal(r.converged, false, 'bruce authored it, still needs tony ACCEPT');

  const tonyAccept = path.join(dir, 'tony-accept.json');
  writeJson(tonyAccept, { actor: 'tony', seen_version: r.version, action: 'ACCEPT' });
  const r2 = run(['apply', statePath, tonyAccept]);
  assert.equal(r2.converged, true);
});

// --- rejected deltas must round-trip through the filesystem as true no-ops ---

test('smoke: a rejected delta leaves the on-disk state file byte-identical', () => {
  const dir = workDir();
  const initPath = path.join(dir, 'init.json');
  const statePath = path.join(dir, 'state.json');
  writeJson(initPath, { complexity_score: 1, risk_flags: {}, routing_reason: ['x'], goal: ['g'], constraints: ['c'] });
  run(['init', initPath, statePath]);
  const before = fs.readFileSync(statePath, 'utf8');

  const badDelta = path.join(dir, 'bad.json');
  writeJson(badDelta, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { facts: { add: { F1: { value: 'no evidence attached' } } } } });
  const result = run(['apply', statePath, badDelta]);
  assert.equal(result.applied, false);

  const after = fs.readFileSync(statePath, 'utf8');
  assert.equal(after, before, 'a rejected delta must never mutate the on-disk state');
});

// --- CLI surface: bad usage exits non-zero with guidance on stderr ---

test('smoke: unknown subcommand exits non-zero with a usage message', () => {
  const err = runFails(['bogus']);
  assert.equal(err.status, 1);
  assert.match(err.stderr, /usage: state\.js/);
});

test('smoke: a stale seen_version rejected via real CLI does not corrupt the file for the next real call', () => {
  const dir = workDir();
  const initPath = path.join(dir, 'init.json');
  const statePath = path.join(dir, 'state.json');
  writeJson(initPath, { complexity_score: 1, risk_flags: {}, routing_reason: ['x'], goal: ['g'], constraints: [] });
  run(['init', initPath, statePath]);

  const goodDelta = path.join(dir, 'good.json');
  writeJson(goodDelta, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { decisions: { add: { D1: { value: 'v', rationale: 'r' } } } }, reason: ['x'] });
  run(['apply', statePath, goodDelta]); // state now v1

  const staleDelta = path.join(dir, 'stale.json');
  writeJson(staleDelta, { actor: 'tony', seen_version: 0, action: 'ACCEPT' });
  const staleResult = run(['apply', statePath, staleDelta]);
  assert.equal(staleResult.applied, false);
  assert.match(staleResult.reason, /stale/);

  // the file must still be a valid, current state usable by the next real call
  const freshDelta = path.join(dir, 'fresh.json');
  writeJson(freshDelta, { actor: 'tony', seen_version: 1, action: 'ACCEPT' });
  const okResult = run(['apply', statePath, freshDelta]);
  assert.equal(okResult.applied, true);
  assert.equal(okResult.converged, true);
});
