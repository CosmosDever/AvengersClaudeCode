# Vendored: Ponytail

Bundled so `avengers` works without requiring a separate Ponytail install (per
AVENGERS_V2_REVISED_PLAN.md section 15).

- Source repository: https://github.com/DietrichGebert/ponytail
- Package: `@dietrichgebert/ponytail`
- Version pinned: `4.10.0`
- License: MIT (see `LICENSE` in this directory)
- Copied files (verbatim, no edits):
  - `skills/ponytail/SKILL.md` -> `ponytail-SKILL.md`
  - `skills/ponytail-review/SKILL.md` -> `ponytail-review-SKILL.md`
- Local changes: none.

## Why these aren't registered as `avengers:ponytail` skills

Reed and Tony (the two roles that use Ponytail — see `AVENGERS_V2_REVISED_PLAN.md`
section 16) run as subagents without the `Skill` tool. They `Read` these files
directly instead of invoking them as skills, so there's no reason to also
register them under `plugins/avengers/skills/` — that would just be an unused
second entry point. If a future role gains the `Skill` tool and needs to invoke
these interactively, move them into `skills/` at that point.

To update: bump the version above and re-copy both `SKILL.md` files.
