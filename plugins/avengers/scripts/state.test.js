'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyRoute, initState, apply, isConverged, render } = require('./state.js');

function freshState(overrides = {}) {
  return initState(Object.assign({
    complexity_score: 2,
    risk_flags: {},
    routing_reason: ['test fixture'],
    goal: ['ship the thing'],
    constraints: ['keep API compatible'],
  }, overrides));
}

// --- section 30: routing fixtures ---

test('routing: score 0, no risk => SMALL', () => {
  assert.equal(classifyRoute(0, {}), 'SMALL');
});

test('routing: score 1, no risk => MEDIUM (webhook retry policy)', () => {
  assert.equal(classifyRoute(1, {}), 'MEDIUM');
});

test('routing: score 2, no risk => MEDIUM (refactor caching)', () => {
  assert.equal(classifyRoute(2, {}), 'MEDIUM');
});

test('routing: low score but security flag => HIGH (OAuth change)', () => {
  assert.equal(classifyRoute(1, { security: true }), 'HIGH');
});

test('routing: destructive migration => HIGH', () => {
  assert.equal(classifyRoute(2, { destructive: true }), 'HIGH');
});

test('routing: money flag => HIGH', () => {
  assert.equal(classifyRoute(1, { money: true }), 'HIGH');
});

test('routing: concurrency flag => HIGH', () => {
  assert.equal(classifyRoute(2, { concurrency: true }), 'HIGH');
});

test('routing: public_api flag => HIGH', () => {
  assert.equal(classifyRoute(1, { public_api: true }), 'HIGH');
});

test('routing: score 3 forces HIGH even with no risk flags', () => {
  assert.equal(classifyRoute(3, {}), 'HIGH');
});

// --- section 29: PR1 convergence fixtures ---

test('case 1: immediate agreement converges in 2 calls', () => {
  let s = freshState();
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { decisions: { add: { D1: { value: 'use existing scheduler', rationale: 'reuse' } } } }, reason: ['reuse existing infra'] });
  assert.equal(r.applied, true);
  s = r.state;
  assert.equal(s.version, 1);

  r = apply(s, { actor: 'tony', seen_version: 1, action: 'ACCEPT' });
  assert.equal(r.applied, true);
  assert.equal(r.converged, true);
  assert.equal(r.state.debate_calls, 2);
});

test('case 2: counter-proposal converges in 3 calls', () => {
  let s = freshState();
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { decisions: { add: { D1: { value: 'A', rationale: 'r' } } } }, reason: ['x'] });
  s = r.state;
  r = apply(s, { actor: 'tony', seen_version: 1, action: 'PATCH', patch: { decisions: { update: { D1: { value: 'B', rationale: 'better' } } } }, reason: ['y'] });
  assert.equal(r.applied, true);
  s = r.state;
  assert.equal(s.approvals.bruce, null);
  assert.equal(s.approvals.tony, 2);

  r = apply(s, { actor: 'bruce', seen_version: 2, action: 'ACCEPT' });
  assert.equal(r.converged, true);
  assert.equal(r.state.debate_calls, 3);
});

test('case 3: patch after approval invalidates the stale approval', () => {
  let s = freshState();
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { decisions: { add: { D1: { value: 'A', rationale: 'r' } } } }, reason: ['x'] });
  s = r.state;
  r = apply(s, { actor: 'bruce', seen_version: 1, action: 'ACCEPT' });
  s = r.state;
  assert.equal(s.approvals.bruce, 1);

  r = apply(s, { actor: 'tony', seen_version: 1, action: 'PATCH', patch: { decisions: { update: { D1: { value: 'B', rationale: 'r2' } } } }, reason: ['z'] });
  s = r.state;
  assert.equal(s.approvals.bruce, null, 'bruce approval must be invalidated by tony patch');
  assert.equal(isConverged(s), false);
});

test('case 4: malformed patch (removes constraint without reason) is rejected, state unchanged', () => {
  const s = freshState();
  const r = apply(s, { actor: 'tony', seen_version: 0, action: 'PATCH', patch: { constraints: { remove: ['keep API compatible'] } } });
  assert.equal(r.applied, false);
  assert.match(r.reason, /reason/);
  assert.equal(r.state.version, 0);
  assert.deepEqual(r.state.approvals, { bruce: null, tony: null });
});

test('case 5: stale seen_version is rejected, state unchanged', () => {
  let s = freshState();
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { decisions: { add: { D1: { value: 'A', rationale: 'r' } } } }, reason: ['x'] });
  s = r.state; // now v1
  r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { decisions: { add: { D2: { value: 'B', rationale: 'r' } } } }, reason: ['stale'] });
  assert.equal(r.applied, false);
  assert.match(r.reason, /stale/);
  assert.equal(r.state.version, 1);
});

test('case 6: fact without evidence is rejected', () => {
  const s = freshState();
  const r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { facts: { add: { F1: { value: 'db already dedupes' } } } } });
  assert.equal(r.applied, false);
  assert.match(r.reason, /evidence/);
  assert.equal(r.state.version, 0);
});

test('case 7: approvals match but open question remains => not converged', () => {
  let s = freshState({ open_questions: ['A1 must be verified'] });
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'ACCEPT' });
  s = r.state;
  r = apply(s, { actor: 'tony', seen_version: 0, action: 'ACCEPT' });
  assert.equal(r.state.approvals.bruce, 0);
  assert.equal(r.state.approvals.tony, 0);
  assert.equal(r.converged, false);
});

test('case 8: repeated identical blocker is NO_STATE_CHANGE and does not re-spend version', () => {
  let s = freshState();
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'BLOCK', blockers: [{ id: 'B1', reason: 'ambiguous requirement', requires_human_decision: true }] });
  assert.equal(r.applied, true);
  s = r.state;
  assert.equal(s.version, 1);

  r = apply(s, { actor: 'bruce', seen_version: 1, action: 'BLOCK', blockers: [{ id: 'B1', reason: 'ambiguous requirement', requires_human_decision: true }] });
  assert.equal(r.applied, false);
  assert.match(r.reason, /NO_STATE_CHANGE/);
  assert.equal(r.state.version, 1, 'no-op repeat must not bump version');
  assert.equal(r.state.debate_calls, 2, 'budget is still consumed even when rejected as a repeat');
});

// --- extra: protections that section 5/13/14 call out explicitly ---

test('agents cannot write approvals or version directly', () => {
  const s = freshState();
  const r = apply(s, { actor: 'bruce', seen_version: 0, action: 'ACCEPT', approvals: { bruce: 99 } });
  assert.equal(r.applied, false);
  assert.match(r.reason, /unknown top-level field/);
});

test('routing is immutable during debate', () => {
  const s = freshState();
  const r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { routing: { route: 'SMALL' } } });
  assert.equal(r.applied, false);
  assert.match(r.reason, /unknown section: routing/);
});

test('debate call budget is tracked and reported as exhausted for MEDIUM after 3 calls', () => {
  let s = freshState(); // MEDIUM (score 2, no risk)
  let r;
  r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { decisions: { add: { D1: { value: 'A', rationale: 'r' } } } }, reason: ['x'] });
  s = r.state;
  r = apply(s, { actor: 'tony', seen_version: 1, action: 'PATCH', patch: { decisions: { update: { D1: { value: 'B', rationale: 'y' } } } }, reason: ['y'] });
  s = r.state;
  assert.equal(r.budget.remaining, 1);
  r = apply(s, { actor: 'bruce', seen_version: 2, action: 'ACCEPT' });
  assert.equal(r.budget.exhausted, true);
  assert.equal(r.budget.used, 3);
});

test('assumption cannot be verified without evidence', () => {
  let s = freshState();
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { assumptions: { add: { A1: { value: 'scheduler supports delay', status: 'unverified', owner: 'bruce' } } } }, reason: ['flag it'] });
  s = r.state;
  r = apply(s, { actor: 'bruce', seen_version: 1, action: 'PATCH', patch: { assumptions: { update: { A1: { status: 'verified' } } } }, reason: ['no evidence attached'] });
  assert.equal(r.applied, false);
  assert.match(r.reason, /evidence/);
});

test('unverified assumption blocks convergence even with matching approvals', () => {
  let s = freshState();
  let r = apply(s, { actor: 'bruce', seen_version: 0, action: 'PATCH', patch: { assumptions: { add: { A1: { value: 'scheduler supports delay', status: 'unverified', owner: 'bruce' } } } }, reason: ['flag'] });
  s = r.state;
  r = apply(s, { actor: 'tony', seen_version: 1, action: 'ACCEPT' });
  assert.equal(r.state.approvals.bruce, 1);
  assert.equal(r.state.approvals.tony, 1);
  assert.equal(r.converged, false, 'unverified assumption must block convergence');
});

test('render produces compact, human-readable text with no crashes on empty sections', () => {
  const s = freshState();
  const text = render(s);
  assert.match(text, /AVENGERS_STATE v0/);
  assert.match(text, /route: MEDIUM/);
});
