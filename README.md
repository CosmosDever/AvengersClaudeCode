# Avengers — a design-then-build multi-agent workflow for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Claude Code plugin that runs five specialised agents through a design → plan → build → review loop:

| Agent | Role | Frontmatter default | Notes |
|-------|------|----------------------|-------|
| **Bruce** | Rigorous design partner; final correctness review | `sonnet` | `/avengers` bumps this to `opus` (effort high) for `HIGH`-route debate and for review when unresolved critical-reasoning risk carries over |
| **Tony** | Bold design partner; final complexity review (Ponytail Review) | `sonnet` | Review pass runs on `haiku` |
| **Thor** | Neutral mediator when Bruce and Tony can't converge | `opus` | `effort: high` |
| **Steve** | Turns the converged design into an ordered, scrutinized plan | `sonnet` | |
| **Reed** | Implements the plan with bundled Ponytail; runs fix cycles | `sonnet` | |

`/avengers` picks the actual per-step model by route (see `commands/avengers.md`) — the table above is each agent's frontmatter default, used when you call an agent directly.

## How it works

1. A deterministic router classifies the task as **SMALL / MEDIUM / HIGH** (risk flags override the complexity score).
2. Bruce and Tony debate over a small, versioned **canonical state** using `ACCEPT` / `PATCH` / `BLOCK` deltas. A dependency-free Node engine validates and applies each delta, so the agents never replay a transcript.
3. If the debate runs out of calls or hits an unresolved `BLOCK`, Thor summarises both positions and passes the decision to you.
4. Steve plans from the final state, and Reed builds it.
5. Bruce (correctness) and Tony (complexity) review the result and run a bounded fix loop.

The deterministic parts (patch validation, versioned approval, convergence, debate budgets, routing) live in tested code in [`scripts/state.js`](plugins/avengers/scripts/state.js). The agents handle the parts that need judgment.

### Token gate

A `PostToolUse` hook ([`hooks/hooks.json`](plugins/avengers/hooks/hooks.json)) runs [`scripts/truncate-tool-output.js`](plugins/avengers/scripts/truncate-tool-output.js) on every `Bash` tool call. If combined stdout+stderr exceeds ~8,000 characters, it trims the output back to ~8,000 characters in total: the budget is split between stdout and stderr (a short stream passes through whole and gives its unused share to the other), and each stream that's over its share keeps its start and end with a `[... N chars / ~M tokens omitted ...]` marker in the middle — deterministic truncation, no summarization, no network calls. Any internal error, non-`Bash` tool, or already-small output leaves the original output untouched (fail open).

## Install

Inside Claude Code:

```
/plugin marketplace add CosmosDever/AvengersClaudeCode
/plugin install avengers@avengers-marketplace
```

## Usage

```
/avengers <describe the problem you want designed and built>
```

You can also call any agent directly (`bruce`, `tony`, `thor`, `steve`, `reed`) when you only want its view.

### Changing models

Each agent's model is set in the `model:` field of its frontmatter in [`plugins/avengers/agents/`](plugins/avengers/agents/). Accepted values are `opus`, `sonnet`, `haiku`, `inherit` (uses the main session's model), or a full model ID.

## Project structure

```
.claude-plugin/
  marketplace.json          # marketplace catalog
plugins/avengers/
  .claude-plugin/plugin.json  # plugin manifest
  agents/                     # bruce, tony, thor, steve, reed
  commands/avengers.md        # /avengers orchestrator (sole writer of the canonical state)
  hooks/hooks.json            # PostToolUse token gate registration (Bash only)
  scripts/
    state.js                  # canonical-state engine: init / apply / render
    state.test.js             # unit tests: validator and convergence rules
    smoke.test.js             # integration tests: the real CLI against files on disk
    truncate-tool-output.js       # PostToolUse gate: head+tail truncation of oversized Bash output
    truncate-tool-output.test.js  # unit + subprocess tests for the gate
  third_party/ponytail/       # vendored Ponytail skills (MIT, pinned)
```

## Development

Requires Node 18+. There are no dependencies and no install step.

```
node --test plugins/avengers/scripts/state.test.js plugins/avengers/scripts/smoke.test.js plugins/avengers/scripts/truncate-tool-output.test.js
```

## Contributing

Issues and pull requests are welcome. Before you open a PR:

1. Run the tests above and make sure they pass.
2. Keep `scripts/state.js` dependency-free.
3. If you change the CLI or the state/delta shape, update `commands/avengers.md` and `smoke.test.js` to match.

## License

[MIT](LICENSE) © 2026 CosmosDever.

Vendored [Ponytail](https://github.com/DietrichGebert/ponytail) files are © DietrichGebert under MIT. See [`third_party/ponytail/LICENSE`](plugins/avengers/third_party/ponytail/LICENSE).
