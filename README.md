# avengers

A Claude Code plugin marketplace bundling the Bruce / Tony / Thor / Steve / Reed design-then-build
multi-agent workflow. v2: a deterministic router classifies the task as SMALL/MEDIUM/HIGH (risk flags
override complexity score), Bruce and Tony debate over a small versioned **canonical state** —
ACCEPT/PATCH/BLOCK deltas validated and applied by a dependency-free Node engine, never a replayed
transcript — Thor mediates and hands unresolved calls to the user, Steve plans and self-scrutinizes,
Reed implements with bundled Ponytail, then Bruce (correctness) and Tony (Ponytail Review) review the
result and drive a bounded fix loop. See `AVENGERS_V2_REVISED_PLAN.md` for the full design.

## Install

inside Claude Code:

```
/plugin marketplace add CosmosDever/AvengersCluadeCode
/plugin install avengers@avengers-marketplace
```

## Use

```
/avengers <describe the problem you want designed and built>
```

Or call the individual agents directly by name (`bruce`, `tony`, `thor`, `steve`, `reed`) whenever you
just want one of their perspectives without running the full workflow.

## Structure

```
.claude-plugin/
  marketplace.json        # marketplace catalog (this repo)
plugins/
  avengers/
    .claude-plugin/
      plugin.json          # plugin manifest
    agents/
      bruce.md              # design debate (correctness) + final correctness review
      tony.md                # design debate (leverage) + final Ponytail Review pass
      thor.md                 # mediator, called only if debate exhausts its call budget
      steve.md                  # plans from the final converged state only
      reed.md                    # implements with bundled Ponytail; runs fix cycles
    commands/
      avengers.md          # the /avengers orchestrator command (owns the canonical state)
    scripts/
      state.js             # dependency-free canonical-state engine: init/apply/render
      state.test.js         # node --test: patch validator & convergence rules, in-process
      smoke.test.js          # node --test: same flows through the real `node state.js` CLI/files
    third_party/ponytail/  # vendored Ponytail + Ponytail Review skills (MIT, pinned version)
```

Run the tests with `node --test plugins/avengers/scripts/state.test.js plugins/avengers/scripts/smoke.test.js`
(Node 18+, no install step — zero dependencies by design). `state.test.js` calls the validator/convergence
functions directly; `smoke.test.js` spawns the actual CLI against real files to catch what unit tests
can't — argument parsing, JSON-on-disk round-tripping, exit codes, and whether the exact call sequence
`commands/avengers.md` documents still works if followed literally.

## Note

This bundle uses Claude Code's native **plugin** system (agents + slash command) to work. The orchestration
logic that's actually deterministic (patch validation, versioned approval, convergence, debate-call
budgets, SMALL/MEDIUM/HIGH routing) lives in real, tested code in `scripts/state.js` — not in a prompt
asking an LLM to self-validate. Everything that requires judgment (reading the task, proposing a design,
writing code) stays with the agents.
