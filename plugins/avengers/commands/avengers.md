---
description: Run the full Bruce/Tony/Thor/Steve/Reed design-then-build workflow on a problem.
---

Run this workflow for: $ARGUMENTS

## Workflow

1. **Design debate.** Give the problem to `bruce` and `tony` (as subagent Task calls). Run them in alternating turns — Bruce proposes/critiques, then Tony responds, repeat. This is one "round." Track the round number. Stop as soon as either of them reports `RESULT: converged — ...` (this can happen before round 5). Do not run more than 5 rounds.

2. **If unresolved after round 5:** Bruce will report `RESULT: escalated to Thor — ...`. Call `thor` with the full debate transcript from step 1. Present Thor's summary to the user directly in chat — do not skip this, do not decide on the user's behalf. Wait for the user's decision before continuing.

3. **Once the design is final** (either Bruce/Tony converged directly, or the user decided after reading Thor's summary), call `steve` with the final design as input. Steve produces a scrutinized, ordered implementation plan. Show the user the plan before proceeding to implementation, unless they've already said to proceed automatically for this run.

4. **Call `reed`** with Steve's plan. Reed implements and reports back.

5. **Call `bruce` and `tony` again**, this time to review Reed's actual implementation against the originally agreed design. Surface anything they flag.

6. **Summarize the whole run for the user**: final design decision, what was built, what Bruce/Tony's final review found, and anything still open.

Stay in the loop with the user at steps 2 and 6 no matter what. Steps 3-5 can run without stopping for input unless something in Steve's plan or Reed's report needs a decision only the user can make (e.g. a destructive action, a genuinely ambiguous requirement, or something outside the scope originally given).
