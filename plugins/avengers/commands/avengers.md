---
description: Run the full Bruce/Tony/Thor/Steve/Reed design-then-build workflow, backed by a versioned canonical state instead of a replayed debate transcript.
---

Run this workflow for: $ARGUMENTS

You are the **orchestrator**. You are the *only* thing allowed to write the canonical state file. Every agent below (`avengers:bruce`, `avengers:tony`, `avengers:thor`, `avengers:steve`, `avengers:reed`) gets exactly the slice of state it needs and returns a small structured block — never the full conversation, never each other's raw responses. This is the core of the v2 design: a small validated shared state beats a big replayed transcript, both for cost and for determinism.

All state lives in a scratch working directory for this run (use the session scratchpad directory if one is available, otherwise a fresh temp dir) — call it `$WORK`. The engine is `${CLAUDE_PLUGIN_ROOT}/scripts/state.js`, a plain Node script with no dependencies; use the `Bash` tool to run it. Its three subcommands:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.js" init   <init.json> <state.json>
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.js" apply  <state.json> <delta.json>
node "${CLAUDE_PLUGIN_ROOT}/scripts/state.js" render <state.json>
```

`init` and `apply` print a small JSON result to stdout (`route`, `applied`, `reason`, `converged`, `budget`, ...) — read it, don't guess. `apply` rejects invalid/stale/malformed deltas and leaves the state file untouched when it does; always report what it actually did, never assume a delta landed. Every `apply` call — whether from the design-debate loop or the one-off Thor-decision patch in Step 1b — counts against the same debate-call budget; review findings (Step 5) never go through `apply` at all, they're tracked directly by you as plain findings, so there's nothing else competing for that budget.

---

## Step 0 — Classify (deterministic router)

Read enough of the task/codebase to judge, then decide:

**`complexity_score`**: `0` = trivial/local (typo, label change, obvious small fix). `1` = small but behavioral. `2` = meaningful cross-file/design decision. `3` = complex architecture or high uncertainty.

**`risk_flags`** (booleans) — set `true` if the task *materially touches*: `security` (auth/authz/secrets/crypto), `money` (billing/balances), `destructive` (data-loss-capable migration/op), `concurrency` (distributed consistency/race conditions), `public_api` (public compatibility surface), `privacy` (privacy-sensitive data), `production_infra` (irreversible prod infra change). Any `true` flag forces `HIGH` regardless of score — risk overrides size.

Write `routing_reason` as 1-3 short bullets explaining the score/flags you picked — this is the audit trail, not decoration.

Then write `$WORK/init.json`:
```json
{
  "complexity_score": 2,
  "risk_flags": { "security": false, "money": false, "destructive": false, "concurrency": false, "public_api": false, "privacy": false, "production_infra": false },
  "routing_reason": ["..."],
  "goal": ["..."],
  "constraints": ["..."],
  "non_goals": [],
  "open_questions": [],
  "verification": []
}
```
Run `init`. It tells you the derived `route` (`SMALL`/`MEDIUM`/`HIGH`) — that's now fixed for the rest of this run; nothing later is allowed to patch `routing`.

---

## Step 1 — Design debate (skip entirely for `SMALL`)

Model policy for this phase: **Bruce** = `opus` if `HIGH`, else `sonnet`. **Tony** = `sonnet` always.

Loop:
1. Run `render` to get the current compact state text.
2. Call whichever of `avengers:bruce` / `avengers:tony` does **not** currently hold approval for the current version (first turn: Bruce). Give it: the task, the rendered state, and "you are seeing version N, respond with exactly one DEBATE_DELTA block." Nothing else — not the other agent's response, not prior turns.
3. Translate the actor's `DEBATE_DELTA:` YAML block into `$WORK/delta.json` matching this shape, then run `apply`:
   ```json
   {
     "actor": "bruce",
     "seen_version": 3,
     "action": "PATCH",
     "patch": { "...": "as the agent specified, same section names" },
     "reason": ["..."],
     "evidence": ["..."]
   }
   ```
   For `BLOCK`, include `"blockers": [{"id": "B1", "reason": "...", "requires_human_decision": true}]` instead of `patch`.
4. Read `apply`'s output. If `applied: false`, tell the same actor plainly what was rejected and why (e.g. "your patch removed a constraint without a reason — resubmit") and let them retry *that same turn* — a rejected delta must never silently become shared truth, and it doesn't consume a fresh turn against the other actor.
5. If `converged: true`, stop the loop — design is final.
6. If `budget.exhausted: true` and not converged, stop the loop and go to **Step 1b**.
7. Otherwise, go to 1 with the other actor.

Never send Bruce what Tony said or vice versa — only the rendered state. Never replay this loop's history back into a prompt; the state's own compact `history` field is the only memory that survives across turns.

### Step 1b — Escalate to Thor (only if budget exhausted without convergence)

Call `avengers:thor` with the rendered state (it already contains compact `history` and any unresolved `blockers` — that's the "compact history" Thor needs, not a transcript). Present Thor's summary to the user **directly in chat** and wait for their decision — do not decide on the user's behalf.

Translate the user's decision into one final `PATCH` (or a `blockers.resolve` patch) delta, actor set to whichever of bruce/tony the decision most resembles (or either, it's a human-authorized override), and `apply` it. Then re-check `converged` — it must be true before continuing. If the user's decision doesn't actually resolve the open question/blocker, ask again rather than proceeding on an unconverged state.

---

## Step 2 — Plan (`avengers:steve`)

Model: `haiku` for `SMALL`/`MEDIUM`, `sonnet` for `HIGH`.

Give Steve **only** the final `render` output — not the debate, not the history of how it got there. If Steve returns `PLAN_BLOCKED`, the state is internally inconsistent; do not patch around it yourself — that's a real problem, surface it to the user before continuing.

Show the user the plan before implementation, unless they already said to proceed automatically for this run.

---

## Step 3 — Implement (`avengers:reed`)

Model: `haiku` for `SMALL` (see fallback below), `sonnet` for `MEDIUM`/`HIGH`.

Give Reed the final state render + Steve's plan. Ponytail is Reed's default behavior regardless of route (see `reed.md`) — you don't need to say anything extra about it.

**SMALL-only fallback:** if Reed was Haiku and verification fails, the implementation turned out cross-cutting, a risk override was discovered mid-implementation, or Reed explicitly reports unsafe uncertainty — retry Reed on `sonnet`, giving it only: the final state, the plan, the current diff, and the failed verification output. Don't replay the first attempt's full reasoning.

If Reed returns `REOPEN_DESIGN`: this is not a fix-cycle, it's new information. Go back to Step 1 for the affected decision(s) only — write a `PATCH` to `open_questions` capturing what needs re-deciding (this bumps the version and invalidates both approvals, exactly as intended by rule 6/7 of the design), run the debate loop again just for that, then re-run Steve/Reed. This should be rare.

---

## Step 4 — Verification

Run the project's actual test/lint/typecheck commands per the state's `verification` list (Reed already ran these as part of its own step, but re-confirm here if anything's ambiguous). Keep only pass/fail + a short failure excerpt if it failed — don't paste full logs into later prompts.

---

## Step 5 — Review

- **Bruce**: skip for `SMALL` unless a risk override surfaced anywhere above (routing risk flag, Reed's `REOPEN_DESIGN`, or a verification failure that smells like a correctness/security issue). Otherwise always run. Model: `sonnet` normally, `opus` only if the state carries unresolved critical-reasoning risk from a `HIGH` route.
- **Tony**: always run. Model: `haiku`. This is the Ponytail Review pass.

Give both the final state, the actual diff, and the verification result — not Reed's narration.

---

## Step 6 — Fix loop

Budget: `SMALL`/`MEDIUM` = 1 fix cycle, `HIGH` = 2 fix cycles. Track this as a plain counter in your own notes — it's one comparison, it doesn't need the state engine.

While there are open findings (from either reviewer's `REVIEW.findings`) and the budget isn't exhausted:
1. Collect only the *open* findings (id, severity, location, issue, required_fix) — not the reviewers' reasoning.
2. Call `avengers:reed` in fix-cycle mode with those findings + the current diff.
3. Re-run targeted verification.
4. Re-run **only** the reviewer(s) whose findings were addressed — if only Bruce had findings, only Bruce re-checks; if both did, both re-check.
5. Increment the fix-cycle counter.

If findings remain when the budget runs out, don't loop silently — escalate to the user (or, if a finding requires changing an approved decision, use the `REOPEN_DESIGN` path from Step 3 instead of forcing another fix cycle on it).

---

## Step 7 — Summary

Tell the user, concisely:
- Route taken and why (`routing_reason`).
- The final design decisions (from state, not the debate blow-by-blow).
- What Reed built and how it was verified.
- Review outcome: any findings, fixed or still open.
- Debate calls used / budget, and fix cycles used / budget — this is the whole point of the v2 rework, so don't bury it.

## Where you must stay in the loop with the user

Regardless of route: Step 1b (Thor escalation) always needs a human decision. Step 2's plan should be shown before Step 3 unless the user pre-approved auto-run. Anything requiring `REOPEN_DESIGN`, a destructive action, or a genuinely ambiguous requirement outside the original scope stops for the user too. Everything else in Steps 2-6 can run without stopping.
