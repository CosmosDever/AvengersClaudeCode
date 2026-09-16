#!/usr/bin/env node
'use strict';

/*
 * Avengers v2 canonical-state engine.
 *
 * Pure, dependency-free logic for the parts of the design (AVENGERS_V2_REVISED_PLAN.md)
 * that don't require judgment: patch validation, versioned approval, convergence,
 * debate call budgets, and route derivation. The orchestrating agent (running /avengers)
 * shells out to this file via `node`; no agent ever writes the state file directly.
 *
 * Everything here is plain JSON on disk. Agents see a compact YAML-ish rendering
 * (see `render`) generated from that JSON — they never see or produce JSON deltas
 * themselves; the orchestrator translates an agent's DEBATE_DELTA block into the
 * delta.json shape documented below before calling `apply`.
 *
 * State shape:
 *   {
 *     version, routing, goal[], constraints[], non_goals[],
 *     facts{id:{value,evidence}}, assumptions{id:{value,status,owner,evidence?}},
 *     decisions{id:{value,rationale}}, risks{id:{value,severity}},
 *     open_questions[], verification[], blockers[{id,reason,requires_human_decision,resolved,raised_by}],
 *     approvals{bruce,tony}, history[], debate_calls
 *   }
 *
 * Delta shape (what `apply` consumes):
 *   {
 *     actor: 'bruce'|'tony', seen_version: number, action: 'ACCEPT'|'PATCH'|'BLOCK',
 *     patch?: {
 *       goal?: {add?: [], remove?: [], reason?: ''},
 *       constraints?: {add?: [], remove?: [], reason?: ''},
 *       non_goals?: {add?: [], remove?: [], reason?: ''},
 *       facts?: {add?: {id: {value, evidence}}},
 *       assumptions?: {add?: {id: {value, status, owner}}, update?: {id: {status, evidence?}}},
 *       decisions?: {add?: {id: {value, rationale}}, update?: {id: {value, rationale}}},
 *       risks?: {add?: {id: {value, severity}}, remove?: {ids: [], reason: ''}},
 *       open_questions?: {add?: [], remove?: []},
 *       verification?: {add?: []},
 *       blockers?: {resolve?: [ids]}
 *     },
 *     reason?: [string], evidence?: [string],
 *     blockers?: [{id, reason, requires_human_decision}]
 *   }
 */

const fs = require('fs');

const KNOWN_PATCH_SECTIONS = [
  'goal', 'constraints', 'non_goals', 'facts', 'assumptions',
  'decisions', 'risks', 'open_questions', 'verification', 'blockers',
];

const BUDGET = { MEDIUM: 3, HIGH: 5 };
const MAX_HISTORY = 6; // ponytail: fixed-length ring buffer instead of token-aware compaction (section 14); revisit if state.render ever approaches the ~1400 soft-limit token guidance in practice.

function classifyRoute(complexityScore, riskFlags) {
  const anyRisk = Object.values(riskFlags || {}).some(Boolean);
  if (anyRisk || complexityScore >= 3) return 'HIGH';
  if (complexityScore >= 1) return 'MEDIUM';
  return 'SMALL';
}

function emptyRiskFlags() {
  return {
    security: false, money: false, destructive: false, concurrency: false,
    public_api: false, privacy: false, production_infra: false,
  };
}

function initState(input) {
  const riskFlags = Object.assign(emptyRiskFlags(), input.risk_flags || {});
  const route = classifyRoute(input.complexity_score || 0, riskFlags);
  return {
    version: 0,
    routing: {
      route,
      complexity_score: input.complexity_score || 0,
      risk_flags: riskFlags,
      routing_reason: input.routing_reason || [],
    },
    goal: input.goal || [],
    constraints: input.constraints || [],
    non_goals: input.non_goals || [],
    facts: {},
    assumptions: {},
    decisions: {},
    risks: {},
    open_questions: input.open_questions || [],
    verification: input.verification || [],
    blockers: [],
    approvals: { bruce: null, tony: null },
    history: ['v0: initialized'],
    debate_calls: 0,
  };
}

function fail(reason) {
  return { ok: false, reason };
}

// Returns {ok:true} or {ok:false, reason}. Never mutates `state`.
function validateDelta(state, delta) {
  if (!delta || typeof delta !== 'object') return fail('delta is not an object');
  if (!['bruce', 'tony'].includes(delta.actor)) return fail('unknown actor');
  if (typeof delta.seen_version !== 'number' || delta.seen_version !== state.version) {
    return fail(`stale delta: seen_version=${delta.seen_version} current=${state.version}`);
  }
  if (!['ACCEPT', 'PATCH', 'BLOCK'].includes(delta.action)) return fail('unknown action');

  const allowedTopLevel = new Set(['actor', 'seen_version', 'action', 'patch', 'reason', 'evidence', 'blockers']);
  for (const key of Object.keys(delta)) {
    if (!allowedTopLevel.has(key)) return fail(`unknown top-level field: ${key} (approvals/version are orchestrator-only)`);
  }

  if (delta.action === 'BLOCK') {
    if (!Array.isArray(delta.blockers) || delta.blockers.length === 0) {
      return fail('BLOCK requires at least one blocker');
    }
    for (const b of delta.blockers) {
      if (!b.id || !b.reason) return fail('blocker requires id and reason');
    }
  }

  if (delta.action === 'PATCH') {
    const patch = delta.patch || {};
    for (const section of Object.keys(patch)) {
      if (!KNOWN_PATCH_SECTIONS.includes(section)) return fail(`patch targets unknown section: ${section}`);
    }
    // 'routing' is deliberately absent from KNOWN_PATCH_SECTIONS, so any attempt
    // to patch it is already rejected above (rule 13: routing is immutable during debate).

    // rule 9/10: removals require a reason
    for (const section of ['constraints', 'risks', 'goal', 'non_goals']) {
      const op = patch[section];
      const removing = op && (op.remove?.length || op.remove?.ids?.length);
      if (removing) {
        const reasonText = Array.isArray(op.remove) ? op.reason : op.remove.reason;
        if (!reasonText) return fail(`removing from ${section} requires a reason`);
      }
    }

    // rule 11/12: facts require evidence
    if (patch.facts?.add) {
      for (const [id, f] of Object.entries(patch.facts.add)) {
        if (!f.evidence) return fail(`fact ${id} has no evidence`);
        if (state.facts[id]) return fail(`fact id collides: ${id}`);
      }
    }

    // rule 7: new IDs must not collide
    for (const [section, bucket] of [['assumptions', state.assumptions], ['decisions', state.decisions], ['risks', state.risks]]) {
      const add = patch[section]?.add;
      if (add) {
        for (const id of Object.keys(add)) {
          if (bucket[id]) return fail(`${section} id collides: ${id}`);
        }
      }
    }

    // rule 6: referenced ids must exist for updates
    for (const [section, bucket] of [['assumptions', state.assumptions], ['decisions', state.decisions]]) {
      const update = patch[section]?.update;
      if (update) {
        for (const id of Object.keys(update)) {
          if (!bucket[id]) return fail(`${section} update references unknown id: ${id}`);
        }
      }
    }
    if (patch.risks?.remove) {
      for (const id of patch.risks.remove.ids || []) {
        if (!state.risks[id]) return fail(`risks removal references unknown id: ${id}`);
      }
    }
    if (patch.blockers?.resolve) {
      for (const id of patch.blockers.resolve) {
        if (!state.blockers.some((b) => b.id === id)) return fail(`blocker resolve references unknown id: ${id}`);
      }
    }

    // rule: assumption status must be a known value
    for (const bucket of [patch.assumptions?.add, patch.assumptions?.update]) {
      if (!bucket) continue;
      for (const a of Object.values(bucket)) {
        if (a.status && !['unverified', 'verified', 'rejected'].includes(a.status)) {
          return fail(`invalid assumption status: ${a.status}`);
        }
        if (a.status === 'verified' && !a.evidence) return fail('assumption cannot be verified without evidence');
      }
    }
  }

  return { ok: true };
}

function isNoOpPatch(patch) {
  if (!patch) return true;
  return Object.keys(patch).length === 0;
}

function applyPatch(state, patch) {
  const s = state; // caller already deep-cloned
  const arrayAdd = (arr, add) => { for (const v of add || []) if (!arr.includes(v)) arr.push(v); };
  const arrayRemove = (arr, remove) => { for (const v of remove || []) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); } };

  if (patch.goal) { arrayAdd(s.goal, patch.goal.add); arrayRemove(s.goal, patch.goal.remove); }
  if (patch.constraints) { arrayAdd(s.constraints, patch.constraints.add); arrayRemove(s.constraints, patch.constraints.remove); }
  if (patch.non_goals) { arrayAdd(s.non_goals, patch.non_goals.add); arrayRemove(s.non_goals, patch.non_goals.remove); }
  if (patch.open_questions) { arrayAdd(s.open_questions, patch.open_questions.add); arrayRemove(s.open_questions, patch.open_questions.remove); }
  if (patch.verification) { arrayAdd(s.verification, patch.verification.add); }

  if (patch.facts?.add) Object.assign(s.facts, patch.facts.add);

  if (patch.assumptions?.add) Object.assign(s.assumptions, patch.assumptions.add);
  if (patch.assumptions?.update) {
    for (const [id, upd] of Object.entries(patch.assumptions.update)) Object.assign(s.assumptions[id], upd);
  }

  if (patch.decisions?.add) Object.assign(s.decisions, patch.decisions.add);
  if (patch.decisions?.update) {
    for (const [id, upd] of Object.entries(patch.decisions.update)) Object.assign(s.decisions[id], upd);
  }

  if (patch.risks?.add) Object.assign(s.risks, patch.risks.add);
  if (patch.risks?.remove) for (const id of patch.risks.remove.ids || []) delete s.risks[id];

  if (patch.blockers?.resolve) {
    for (const id of patch.blockers.resolve) {
      const b = s.blockers.find((x) => x.id === id);
      if (b) b.resolved = true;
    }
  }

  return s;
}

function pushHistory(state, line) {
  state.history.push(line);
  if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
}

function unresolvedBlockers(state) {
  return state.blockers.filter((b) => !b.resolved);
}

function isConverged(state) {
  if (state.approvals.bruce !== state.version) return false;
  if (state.approvals.tony !== state.version) return false;
  if (state.open_questions.length > 0) return false;
  if (unresolvedBlockers(state).length > 0) return false;
  if (Object.values(state.assumptions).some((a) => a.status === 'unverified')) return false;
  return true;
}

function budgetFor(route) {
  return BUDGET[route] || Infinity;
}

// Every applied delta is a debate-phase call (reviews use a separate REVIEW/findings
// envelope tracked by the orchestrator directly — they never go through `apply`), so
// there's exactly one budget-counting path, not a phase switch.
// Returns {ok, applied, reason?, converged, budget, state}
function apply(state, delta) {
  const validation = validateDelta(state, delta);
  if (!validation.ok) {
    return {
      ok: true,
      applied: false,
      reason: validation.reason,
      converged: isConverged(state),
      budget: budgetStatus(state),
      state,
    };
  }

  const next = JSON.parse(JSON.stringify(state));
  const other = delta.actor === 'bruce' ? 'tony' : 'bruce';

  if (delta.action === 'ACCEPT') {
    next.approvals[delta.actor] = delta.seen_version;
  } else if (delta.action === 'PATCH') {
    if (isNoOpPatch(delta.patch)) {
      next.debate_calls += 1;
      return {
        ok: true,
        applied: false,
        reason: 'NO_STATE_CHANGE: empty patch, treated as repeated objection',
        converged: isConverged(next),
        budget: budgetStatus(next),
        state: next,
      };
    }
    applyPatch(next, delta.patch);
    next.version += 1;
    next.approvals[delta.actor] = next.version;
    next.approvals[other] = null;
    pushHistory(next, `v${state.version} -> v${next.version}: ${delta.actor} PATCH — ${(delta.reason || []).join('; ') || 'no reason given'}`);
  } else if (delta.action === 'BLOCK') {
    const dupe = delta.blockers.every((nb) => next.blockers.some((eb) => eb.id === nb.id && eb.reason === nb.reason));
    if (dupe) {
      next.debate_calls += 1;
      return {
        ok: true,
        applied: false,
        reason: 'NO_STATE_CHANGE: repeated blocker(s) with no new evidence',
        converged: isConverged(next),
        budget: budgetStatus(next),
        state: next,
      };
    }
    for (const b of delta.blockers) {
      next.blockers.push({ ...b, resolved: false, raised_by: delta.actor, at_version: state.version });
    }
    next.version += 1;
    next.approvals[delta.actor] = next.version;
    next.approvals[other] = null;
    pushHistory(next, `v${state.version} -> v${next.version}: ${delta.actor} BLOCK — ${delta.blockers.map((b) => b.id).join(', ')}`);
  }

  next.debate_calls += 1;

  return {
    ok: true,
    applied: true,
    converged: isConverged(next),
    budget: budgetStatus(next),
    state: next,
  };
}

function budgetStatus(state) {
  const max = budgetFor(state.routing.route);
  return { used: state.debate_calls, max, remaining: Math.max(0, max - state.debate_calls), exhausted: state.debate_calls >= max };
}

function render(state) {
  const lines = [];
  lines.push(`AVENGERS_STATE v${state.version} (route: ${state.routing.route}, score: ${state.routing.complexity_score})`);
  if (state.routing.risk_flags && Object.values(state.routing.risk_flags).some(Boolean)) {
    lines.push(`risk_flags: ${Object.entries(state.routing.risk_flags).filter(([, v]) => v).map(([k]) => k).join(', ')}`);
  }
  const section = (title, items) => { if (items && items.length) lines.push(`${title}:\n` + items.map((i) => `  - ${i}`).join('\n')); };
  section('goal', state.goal);
  section('constraints', state.constraints);
  section('non_goals', state.non_goals);

  const kv = (title, obj, fmt) => {
    const entries = Object.entries(obj || {});
    if (!entries.length) return;
    lines.push(`${title}:\n` + entries.map(([id, v]) => `  ${id}: ${fmt(v)}`).join('\n'));
  };
  kv('facts', state.facts, (f) => `${f.value} [${f.evidence}]`);
  kv('assumptions', state.assumptions, (a) => `${a.value} (${a.status}${a.evidence ? `, ${a.evidence}` : ''})`);
  kv('decisions', state.decisions, (d) => `${d.value} — ${d.rationale}`);
  kv('risks', state.risks, (r) => `${r.value} [${r.severity}]`);

  section('open_questions', state.open_questions);
  section('verification', state.verification);

  const unresolved = unresolvedBlockers(state);
  if (unresolved.length) lines.push('unresolved_blockers:\n' + unresolved.map((b) => `  - ${b.id}: ${b.reason}`).join('\n'));

  lines.push(`approvals: bruce=${state.approvals.bruce ?? 'null'} tony=${state.approvals.tony ?? 'null'}`);
  if (state.history.length) lines.push(`history:\n` + state.history.map((h) => `  - ${h}`).join('\n'));

  return lines.join('\n');
}

module.exports = { classifyRoute, initState, validateDelta, apply, isConverged, render, budgetFor, unresolvedBlockers };

// --- CLI ---
if (require.main === module) {
  const [, , cmd, ...args] = process.argv;

  const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

  try {
    if (cmd === 'init') {
      const [inputPath, statePath] = args;
      const state = initState(readJson(inputPath));
      writeJson(statePath, state);
      console.log(JSON.stringify({ ok: true, route: state.routing.route, version: state.version }, null, 2));
    } else if (cmd === 'apply') {
      const [statePath, deltaPath] = args;
      const state = readJson(statePath);
      const delta = readJson(deltaPath);
      const result = apply(state, delta);
      writeJson(statePath, result.state);
      console.log(JSON.stringify({
        ok: result.ok, applied: result.applied, reason: result.reason || null,
        converged: result.converged, version: result.state.version, budget: result.budget,
      }, null, 2));
    } else if (cmd === 'render') {
      const [statePath] = args;
      console.log(render(readJson(statePath)));
    } else {
      console.error('usage: state.js init <input.json> <state.json>');
      console.error('       state.js apply <state.json> <delta.json>');
      console.error('       state.js render <state.json>');
      process.exit(1);
    }
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}
