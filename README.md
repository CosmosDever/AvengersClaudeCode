# avengers

A Claude Code plugin marketplace bundling the Bruce / Tony / Thor / Steve / Reed design-then-build
multi-agent workflow: Bruce and Tony debate a design for up to 5 rounds, Thor mediates and hands the
decision to the user if they don't converge, Steve plans and self-scrutinizes, Reed implements, then
Bruce and Tony review the result.

## Install

Push this repo to GitHub as `CosmosDever/avengers`, then inside Claude Code:

```
/plugin marketplace add CosmosDever/avengers
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
      bruce.md
      tony.md
      thor.md
      steve.md
      reed.md
    commands/
      avengers.md          # the /avengers orchestrator command
```

## Note

This bundle uses Claude Code's native **plugin** system (agents + slash command) to work.
