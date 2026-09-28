# Avengers — a design-then-build multi-agent workflow for Claude Code

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A Claude Code plugin that runs five specialised agents through a design → plan → build → review loop:

| Agent | Role | Model |
|-------|------|-------|
| **Bruce** | Rigorous design partner; final correctness review | `opus` |
| **Tony** | Bold design partner; final complexity review (Ponytail Review) | `opus` |
| **Thor** | Neutral mediator when Bruce and Tony can't converge | `opus` |
| **Steve** | Turns the converged design into an ordered, scrutinized plan | `opus` |
| **Reed** | Implements the plan with bundled Ponytail; runs fix cycles | `sonnet` |

## How it works

1. A deterministic router classifies the task as **SMALL / MEDIUM / HIGH** (risk flags override the complexity score).
2. Bruce and Tony debate over a small, versioned **canonical state** using `ACCEPT` / `PATCH` / `BLOCK` deltas. A dependency-free Node engine validates and applies each delta, so the agents never replay a transcript.
3. If the debate runs out of calls or hits an unresolved `BLOCK`, Thor summarises both positions and passes the decision to you.
4. Steve plans from the final state, and Reed builds it.
5. Bruce (correctness) and Tony (complexity) review the result and run a bounded fix loop.

The deterministic parts (patch validation, versioned approval, convergence, debate budgets, routing) live in tested code in [`scripts/state.js`](plugins/avengers/scripts/state.js). The agents handle the parts that need judgment.

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
  scripts/
    state.js                  # canonical-state engine: init / apply / render
    state.test.js             # unit tests: validator and convergence rules
    smoke.test.js             # integration tests: the real CLI against files on disk
  third_party/ponytail/       # vendored Ponytail skills (MIT, pinned)
```

## Development

Requires Node 18+. There are no dependencies and no install step.

```
node --test plugins/avengers/scripts/state.test.js plugins/avengers/scripts/smoke.test.js
```

## Contributing

Issues and pull requests are welcome. Before you open a PR:

1. Run the tests above and make sure they pass.
2. Keep `scripts/state.js` dependency-free.
3. If you change the CLI or the state/delta shape, update `commands/avengers.md` and `smoke.test.js` to match.

## License

[MIT](LICENSE) © 2026 CosmosDever.

Vendored [Ponytail](https://github.com/DietrichGebert/ponytail) files are © DietrichGebert under MIT. See [`third_party/ponytail/LICENSE`](plugins/avengers/third_party/ponytail/LICENSE).
