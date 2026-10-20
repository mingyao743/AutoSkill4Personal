---
name: create-skill
description: Use when creating new skills, editing existing skills, or verifying skills work before deployment
---

# Create Skill

## Overview

**Creating skills IS Test-Driven Development applied to process documentation.**

You write test cases (pressure scenarios with subagents), watch them fail (baseline behavior), write the skill (documentation), watch tests pass (agents comply), and refactor (close loopholes).

**Core principle:** If you didn't watch an agent fail without the skill, you don't know if the skill teaches the right thing.

**Personal skills live in your runtime's skills directory** (`~/.claude/skills/` on Claude Code). Codex, Copilot CLI, and Gemini CLI also recognize `~/.agents/skills/` as a cross-runtime alias.

**Official guidance:** See anthropic-best-practices.md for Anthropic's skill authoring guidance, which complements the TDD-focused approach here.

## What is a Skill?

A **skill** is a reference guide for proven techniques, patterns, or tools that helps future agents find and apply effective approaches.

**Skills ARE:** reusable techniques, patterns, tools, reference guides.
**Skills are NOT:** narratives about how you solved a problem once.

## When to Create a Skill

**Create when:**
- Technique wasn't intuitively obvious to you
- You'd reference it across projects
- Pattern applies broadly (not project-specific)

**Don't create for:**
- One-off solutions
- Standard practices well-documented elsewhere
- Project-specific conventions (put in your instructions file)
- Mechanical constraints (if enforceable with regex/validation, automate it — save documentation for judgment calls)

## The Iron Law

```
NO SKILL WITHOUT A FAILING TEST FIRST
```

Applies to NEW skills AND EDITS to existing skills.

Write skill before testing? Delete it. Start over.
Edit skill without testing? Same violation.

**No exceptions:**
- Not for "simple additions" or "just adding a section"
- Don't keep untested changes as "reference"
- Don't "adapt" while running tests
- Delete means delete

## TDD Mapping

| TDD | Skill Creation |
|-----|----------------|
| Test case | Pressure scenario with subagent |
| RED | Agent violates rule without skill (baseline) |
| GREEN | Agent complies with skill present |
| REFACTOR | Close loopholes while maintaining compliance |

Same discipline as code TDD: watch the test fail, write minimal code, watch it pass, refactor.

## RED-GREEN-REFACTOR for Skills

### RED: Baseline (Write Failing Test)

Run pressure scenario with subagent WITHOUT the skill. Document verbatim:
- What choices did they make?
- What rationalizations did they use (verbatim)?
- Which pressures triggered violations?

### GREEN: Write Minimal Skill

Address those specific rationalizations. Don't add content for hypothetical cases. Re-run scenarios WITH skill — agent should now comply.

### REFACTOR: Close Loopholes

Agent found a new rationalization? Add an explicit counter. Re-test until bulletproof.

**Micro-test wording before full scenarios:** full pressure runs are slow per iteration. Verify the wording itself first — one fresh-context sample per call, always include a no-guidance control, 5+ reps per variant, manually read every flagged match. See testing-skills-with-subagents.md for the complete methodology (pressure scenarios, pressure types, plugging holes, meta-testing).

## Testing by Skill Type

| Skill Type | Examples | Test With | Success Criteria |
|---|---|---|---|
| Discipline (rules) | TDD, verification-before-completion | Pressure scenarios, 3+ combined pressures | Follows rule under maximum pressure |
| Technique (how-to) | root-cause-tracing, defensive-programming | Application + variation scenarios | Applies technique to new scenario |
| Pattern (mental models) | reducing-complexity | Recognition + counter-examples | Knows when/how — and when NOT — to apply |
| Reference (APIs/docs) | command references | Retrieval + gap testing | Finds and correctly applies information |

## SKILL.md Structure

**Frontmatter (YAML):** two required fields — `name` and `description` (see [agentskills.io/specification](https://agentskills.io/specification) for all fields; max 1024 chars total).
- `name`: letters, numbers, hyphens only
- `description`: third person, describes ONLY when to use

```markdown
---
name: Skill-Name-With-Hyphens
description: Use when [specific triggering conditions and symptoms]
---

# Skill Name

## Overview
What is this? Core principle in 1-2 sentences.

## When to Use
Bullet list with SYMPTOMS and use cases. When NOT to use.

## Core Pattern (for techniques/patterns)
Before/after code comparison.

## Quick Reference
Table or bullets for scanning common operations.

## Implementation
Inline code for simple patterns; link to file for heavy reference.

## Common Mistakes
What goes wrong + fixes.
```

## Skill Discovery Optimization (SDO)

Future agents must FIND your skill. The description field is what they read to decide whether to load it for a task.

**Description rules:**
- Start with "Use when..." — focus on triggering conditions
- Describe the *problem* (race conditions, flaky tests), not language-specific symptoms (setTimeout, sleep)
- Concrete triggers: symptoms, error messages, tool names, synonyms
- Third person; under 500 characters

**CRITICAL: description = When to Use, NOT what the skill does.**

Tested finding: when a description summarizes the workflow, agents follow the description instead of reading the skill. A description saying "code review between tasks" caused agents to do ONE review, even though the skill's flowchart required TWO. A trigger-only description fixed it.

```yaml
# ❌ Summarizes workflow — agents follow this instead of reading the skill
description: Use when executing plans - dispatches subagent per task with code review between tasks

# ✅ Triggering conditions only
description: Use when executing implementation plans with independent tasks
```

**Naming:** active voice, verb-first. Gerunds (-ing) work well for processes.
- ✅ `condition-based-waiting` not `async-test-helpers`
- ✅ `creating-skills` not `skill-creation`
- ✅ Name by what you DO or core insight: `flatten-with-flags` > `data-structure-refactoring`

**Token efficiency:** skills load into context; every token counts. Move details to tool `--help`, cross-reference instead of repeating, compress examples, one example per pattern. Targets: frequently-loaded skills <200 words, others <500.

**Cross-referencing:** use skill names with explicit markers, never `@` paths.
- ✅ `**REQUIRED SUB-SKILL:** Use [test-driven-development]`
- ❌ `@skills/testing/SKILL.md` (force-loads, burns context)

## File Organization

```
skill-name/
  SKILL.md              # Main reference (required)
  supporting-file.*     # Only if needed
```

Flat namespace — all skills in one searchable namespace. Three patterns by content:

| Pattern | Structure | When |
|---|---|---|
| Self-contained | `SKILL.md` only | All content fits |
| Reusable tool | `SKILL.md` + working script | Tool is reusable code, not narrative |
| Heavy reference | `SKILL.md` + reference docs + `scripts/` | Reference too large for inline (100+ lines) |

Keep inline: principles, concepts, code patterns (<50 lines). Separate files for heavy reference (100+ lines) and reusable tools.

Invoke bundled scripts through their interpreter in prose (`bash scripts/tool.sh`, `node scripts/tool.js`), never by bare path — some harness packagers strip executable bits, and a bare path fails with `Permission denied`.

## Match the Form to the Failure

Before writing guidance, classify the baseline failure. The form that bulletproofs one failure type measurably backfires on another.

| Baseline failure | Right form | Wrong form |
|---|---|---|
| Skips rule under pressure (knows better, does it anyway) | Prohibition + rationalization table + red flags | Soft guidance ("prefer...", "consider...") |
| Output has wrong shape (bloated, buried, restated) | Positive recipe: state what the output IS — its parts, in order | Prohibition list ("don't restate", "never narrate") |
| Omits a required element from something they already produce | Structural: REQUIRED field/slot in the template | Prose reminders near the template |
| Behavior depends on a condition | Conditional on observable predicate ("if the brief exists, reference it") | Unconditional rule + exemption clauses |

**Why prohibitions backfire on shaping problems:** under a competing incentive, agents negotiate with "don't X". In head-to-head wording tests, the prohibition arm produced MORE of the unwanted content than even the no-guidance control. A recipe leaves nothing to negotiate: the output matches the stated shape or it doesn't. (Micro-test your own case rather than assuming.)

**Rules for whichever form:**
- **No nuance clauses.** "Don't X unless it matters" reopens negotiation. Express a real exception as its own conditional on an observable predicate.
- **Exemption clauses don't scope.** "This limit doesn't apply to code blocks" still suppresses code blocks — restructure so the rule can't reach it.

## Bulletproofing Against Rationalization

For discipline failures — agent knows the rule but skips it under pressure. (For wrong-shaped output, use recipes per the table above.)

**Close every loophole explicitly** — forbid specific workarounds:
```markdown
Write code before test? Delete it. Start over.

**No exceptions:**
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete
```

**Cut off "spirit vs letter" arguments early:**
```markdown
Violating the letter of the rules is violating the spirit of the rules.
```

**Build a rationalization table** — every excuse from baseline testing goes in:

| Excuse | Reality |
|--------|---------|
| "Skill is obviously clear" | Clear to you ≠ clear to other agents. Test it. |
| "It's just a reference" | References have gaps. Test retrieval. |
| "Testing is overkill" | Untested skills have issues. Always. 15 min testing saves hours. |
| "I'll test if problems emerge" | Problems = agents can't use skill. Test BEFORE deploying. |
| "No time to test" | Deploying untested wastes more time fixing it later. |

**All of these mean: Test before deploying. No exceptions.**

**Create a red flags list** for self-checking:
```markdown
## Red Flags - STOP and Start Over

- "I already manually tested it"
- "It's about spirit not ritual"
- "This is different because..."
```

**Update description with violation symptoms** (e.g. "use when ... or when manually testing seems faster").

For the research foundation behind these techniques (authority, commitment, scarcity, social proof — Cialdini 2021; Meincke et al. 2025), see persuasion-principles.md.

## Flowchart Usage

Use flowcharts ONLY for:
- Non-obvious decision points
- Process loops where you might stop too early
- "When to use A vs B" decisions

Never for reference material (tables/lists), code examples (markdown blocks), or linear instructions (numbered lists). No generic labels (step1, helper2) — labels need semantic meaning.

See graphviz-conventions.dot for style rules. Render a skill's flowcharts to SVG: `node ./render-graphs.js ../some-skill` (add `--combine` for one SVG).

## Code Examples

**One excellent example beats many mediocre ones.** Choose the most relevant language; make it complete, runnable, well-commented explaining WHY, from a real scenario, ready to adapt.

**Don't:** implement in 5+ languages, create fill-in-the-blank templates, write contrived examples. Agents are good at porting — one great example is enough.

## Anti-Patterns

- ❌ **Narrative example** ("In session 2025-10-03, we found...") — too specific, not reusable
- ❌ **Multi-language dilution** (example-js.js, example-py.py, example-go.go) — mediocre quality, maintenance burden
- ❌ **Code in flowcharts** — can't copy-paste, hard to read
- ❌ **Batch-creating skills without testing each** — deploying untested skills = deploying untested code

## Skill Creation Checklist

**RED:**
- [ ] Create pressure scenarios (3+ combined pressures for discipline skills)
- [ ] Run WITHOUT skill — document baseline behavior and rationalizations verbatim

**GREEN:**
- [ ] Frontmatter: `name` (letters/numbers/hyphens) + `description` ("Use when...", third person, triggers only, no workflow summary)
- [ ] Clear overview with core principle
- [ ] Guidance form matches failure type (see Match the Form to the Failure)
- [ ] One excellent example; searchable keywords throughout
- [ ] Micro-tested wording against no-guidance control (N/A for pure reference skills)
- [ ] Re-run scenarios WITH skill — agents comply

**REFACTOR:**
- [ ] New rationalizations countered; rationalization table updated; red flags list created
- [ ] Description updated with violation symptoms
- [ ] Re-test until bulletproof

**STOP after each skill.** Do NOT create multiple skills in batch without testing each. The checklist is mandatory for EACH skill.

## References in This Directory

- **testing-skills-with-subagents.md** — complete testing methodology (pressure scenarios, pressure types, plugging holes, meta-testing)
- **anthropic-best-practices.md** — official Anthropic skill authoring guidance
- **persuasion-principles.md** — research foundation for bulletproofing techniques
- **graphviz-conventions.dot, render-graphs.js** — flowchart style rules and rendering
- **examples/CLAUDE_MD_TESTING.md** — full worked test campaign
