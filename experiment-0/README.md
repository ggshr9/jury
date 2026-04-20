# Experiment 0: the validation gate

**Question.** Does multi-LLM consensus review meaningfully beat single-model
review on real historical bugs? Specifically: is jury's **Top-3 precision**
at least 15 percentage points higher than the best single reviewer?

**Decision rule.** If yes, build the MVP. If no, kill the project.

## Dataset

30 git commits across 3 codebases (compass, cc-guard, wechat-cc). Each
entry is a `(fix_commit, bug_introducing_commit)` pair where the bug's
ground truth (file + line + category) is documented.

### Schema (one JSON object per line, `dataset/bugs.jsonl`)

```jsonc
{
  "id": "compass-001",                                // short unique key
  "repo": "compass",                                   // compass | cc-guard | wechat-cc
  "repo_path": "/home/nategu/Documents/compass",       // absolute local path
  "fix_commit": "e4b2a3f",                             // the commit that fixed it
  "intro_commit": "7abcd92",                           // the commit that introduced the bug
  "file": "backend/apps/algorithms/scheduler.py",      // ground-truth location
  "line": 142,                                         // or [142, 145] for a range
  "category": "null-deref",                            // see taxonomy in docs/dsl.md
  "severity": "important",                             // critical | important | minor
  "title": "Missing None check on resource.slot before .assign()",
  "description": "scheduler assigns orders to a resource without guarding against resource being None, which happens when the upstream filter drops everything. Fix: early-return + log.",
  "notes": "Caught in prod by a migration run on 2026-03-15."
}
```

### Mining process

For each repo we run:

```bash
git log --grep='^fix' --pretty=format:'%h %s' --no-merges | head -100
```

For each candidate fix commit:
1. Read the fix to understand what was broken.
2. Use `git log --follow -p <file>` to find when the bug-introducing line
   was added. Record that SHA as `intro_commit`.
3. Verify: check out `intro_commit`, confirm the bug is present. Check
   out `intro_commit~1`, confirm the bug is absent.
4. Label ground truth in the bug-introducing diff.

A bug qualifies for the dataset if:
- Fix was a real bug fix (not refactor / doc / style)
- Intro commit has a clean single-location bug (not multi-file or
  gradual-evolution cases)
- Diff at intro is reviewable (< 500 lines; not a giant migration)

## Pipeline

```
dataset/bugs.jsonl ──► runner.ts ──► findings/<bug_id>/<model>.json
                           │
                           ├── fetches diff of intro_commit
                           ├── calls N reviewers in parallel
                           └── normalizes to { file, line, category, severity, description }

findings/ ──► ensemble.ts ──► findings/<bug_id>/jury.json
                   │
                   ├── clusters findings by (file, line)
                   └── applies majority quorum

findings/ + dataset/bugs.jsonl ──► metrics.ts ──► metrics.json
                                       │
                                       └── computes Top-1, Top-3, MRR, FPR
                                           per-model and for jury-v0,
                                           plus pairwise Jaccard overlap
                                           between models (independence check)
```

## Running

```bash
cd experiment-0

# 1. Build dataset (interactive; curate bugs from git history)
bun src/mine.ts --repo /home/nategu/Documents/compass

# 2. Run reviewers for every bug in the dataset
ANTHROPIC_API_KEY=... \
OPENAI_API_KEY=... \
DEEPSEEK_API_KEY=... \
  bun src/runner.ts

# 3. Compute jury-v0 verdicts
bun src/ensemble.ts

# 4. Compute metrics
bun src/metrics.ts > metrics.json

# 5. Report (human-readable)
bun src/report.ts metrics.json
```

## Decision thresholds (from `docs/spec.md`)

- Jury Top-3 precision < best single model Top-3 precision + 15 pp →
  **kill the project.** The consensus layer doesn't earn its keep.
- 15–25 pp gain → **continue with caution.** Marginal win. Monitor ROI
  during MVP.
- > 25 pp gain → **validated.** Ship.

Also, if all pairwise model Jaccard overlaps are > 0.90 on findings,
the ensemble is degenerate (models aren't independent) — swap in a
structurally different model or walk away.

## Status

- [ ] Runner infrastructure (`src/runner.ts` + adapter per model)
- [ ] Ensemble engine v0 (`src/ensemble.ts` — file:line match + majority)
- [ ] Metrics (`src/metrics.ts`)
- [ ] Report formatter (`src/report.ts`)
- [ ] Dataset mining helper (`src/mine.ts`)
- [ ] Dataset: 10 bugs → 30 bugs
- [ ] Run 2-model baseline (Claude + GPT via Codex) on 10 bugs
- [ ] Expand to 4 models × 30 bugs
- [ ] Produce metrics.json + decision
