# jury — design spec

**Status**: Pre-v0.1 draft. Subject to change after Experiment 0.

This document records the design rationale behind jury's defaults. Read
[`README.md`](../README.md) first for positioning; this is for contributors
and early adopters who want to understand *why* we picked each default.

---

## 1. Core insight

The bet: **a majority vote across diverse LLMs produces a more trustable
signal than any single LLM's review.**

Diversity matters more than raw strength. Two calls to GPT-5.4 with slightly
different prompts don't buy you much — they share training data, tokenization,
and hallucination patterns. A mix of Claude + GPT + DeepSeek + Qwen produces
genuinely independent error modes, which is what makes ensemble work.

This has to be validated empirically (see Experiment 0 below). If the
ensemble-gain hypothesis doesn't hold on real historical bugs, jury is
dead in the water and we should walk away.

## 2. Primary value layers

Ranked by how much of the product value each layer accounts for:

| Layer                 | Value share | Why                                                                 |
|-----------------------|-------------|---------------------------------------------------------------------|
| Consensus filtering   | 50%         | Noise reduction is the #1 reason devs ignore AI review              |
| Ranking & clustering  | 25%         | Finding the 3 things that matter in a 40-item PR                    |
| Dissent surfacing     | 15%         | Long-tail catches other tools miss                                  |
| Structured output     | 5%          | Required for CI integration but table-stakes                        |
| Raw model access      | 5%          | Commodity; anyone can call APIs                                     |

Notably, "running more models" is low-value on its own. The aggregation layer
is what we sell.

## 3. Architecture

```
                   ┌──────────┐
                   │  CLI     │
                   │  GH Act. │
                   │  Plugin  │
                   └────┬─────┘
                        │
               ┌────────▼────────┐
               │   Orchestrator  │  loads jury.yaml, computes scope,
               │                 │  parallel-dispatches to reviewers
               └────────┬────────┘
                        │
        ┌───────────────┼──────────────────────┐
        │               │                      │
   ┌────▼────┐    ┌────▼────┐           ┌────▼────┐
   │ Claude  │    │  GPT    │  ......   │  Local  │
   │ adapter │    │ adapter │           │ adapter │  (OpenRouter/Ollama)
   └────┬────┘    └────┬────┘           └────┬────┘
        │              │                     │
        └──────────────▼─────────────────────┘
                       │
              ┌────────▼─────────┐
              │   Consensus      │  JSON normalization → clustering
              │   Engine         │  → quorum rules → dissent handling
              └────────┬─────────┘
                       │
              ┌────────▼─────────┐
              │     Renderer     │  markdown / json / PR comments
              └──────────────────┘
```

### Reviewer adapters

Each adapter wraps one model/CLI into a uniform interface:

```typescript
interface Reviewer {
  name: string;
  role: ReviewerRole;  // see role catalog
  review(context: ReviewContext): Promise<Finding[]>;
}

interface ReviewContext {
  diff: string;
  baseRef: string;
  headRef: string;
  touchedFiles: TouchedFile[];
  dependencyGraph?: FileGraph;   // 2-hop BFS from touched files
  recentCommits?: CommitMeta[];
}

interface Finding {
  file: string;
  line?: number;
  endLine?: number;
  severity: 'critical' | 'important' | 'minor' | 'info';
  category: FindingCategory;  // see taxonomy
  title: string;
  description: string;
  evidence?: string;   // code snippet, execution path, etc
  suggested_fix?: string;
  reviewer: string;  // set by adapter, not model
  confidence?: number; // 0..1, optional
}
```

Adapters are **not** where jury adds value. They're swappable plumbing.
A good adapter:
1. Injects a role-specialized system prompt (see §4)
2. Constrains output to JSON (tool-use API, JSON mode, or schema-guided
   generation depending on provider)
3. Implements one-shot self-repair if JSON parse fails
4. Falls back to regex extraction from free-form text as last resort
5. Rate-limits and retries transient errors transparently

### Consensus engine

Three phases:

**Phase 1: Normalize.** All adapter outputs pass through a JSON validator.
Malformed JSON → re-prompt the same model once with the parse error; still
malformed → regex extract `file:line + description` and tag as
`confidence: "low-fidelity"`.

**Phase 2: Cluster.** Findings that describe the same underlying issue must
be merged across reviewers.

- **Exact match layer**: same file + overlapping line range + same category →
  one cluster.
- **Semantic match layer**: within a cluster candidate group, use a cheap
  embedding (e.g., `text-embedding-3-small`) and compute cosine similarity
  on the finding descriptions. `> 0.85` → same cluster.
- **LLM-as-judge layer**: for borderline pairs (0.7–0.85), ask a cheap
  model ("are these two findings describing the same bug? yes/no") — this
  is cheaper than embedding retraining and handles cross-file duplicates.

We explicitly don't try global clustering (all-pairs across the whole PR).
Clusters are per-file or per-symbol. False "merge" errors are worse than
false "split" errors — a duplicate slipping through is a UX annoyance;
two real bugs merged into one is a *missed bug*.

**Phase 3: Apply quorum.** Each cluster gets a vote count. The
`quorum.critical/important/minor` rules decide inclusion in the verdict.

**Dissent path.** Clusters with <quorum-threshold reviewers get classified:

- If category ∈ `dissent.elevate_categories` AND finding has ≥1 piece of
  structured evidence (code reference, execution path, or data flow) →
  promoted to "Informed Dissent" section
- If category ∈ `dissent.weak_categories` AND cluster size < threshold →
  dropped silently
- Otherwise → appears under "Minority Report" with a confidence note

### Output format

Two outputs always generated:

1. **`jury-verdict.json`** — machine-readable, stable schema, versioned.
2. **`jury-verdict.md`** — human-readable markdown with:
   - Summary header: `4 findings · 2 critical · 1 important · 1 dissent`
   - Grouped sections: Critical → Important → Minor → Informed Dissent → Minority
   - Each finding: title, file:line, description, evidence, which reviewers
     voted for it, suggested fix if any.

GitHub Action variant produces inline PR comments anchored to the
file:line positions, plus a summary PR comment.

## 4. Reviewer role catalog

Reviewers are more than "same model, different prompt". The role shapes
which findings the reviewer is *primarily responsible* for; it isn't
exclusive, but it biases the model's attention and filter priorities.

| Role                   | Primary focus                                               | Typical model choice        |
|------------------------|-------------------------------------------------------------|-----------------------------|
| `general-correctness`  | Logic errors, null/undefined, off-by-one, edge cases        | Claude Sonnet / GPT-5.4     |
| `security`             | Authn/authz, injection, secrets, crypto, SSRF               | GPT-5.4 / Claude Opus       |
| `concurrency`          | Races, deadlocks, atomicity, async invariants               | DeepSeek-R1 (strong reasoner) |
| `data-integrity`       | DB constraint violations, transaction boundaries, NaN       | Claude Sonnet               |
| `code-quality`         | Naming, dead code, duplication, readability                 | Qwen Coder / cheap          |
| `performance`          | O(n²) patterns, N+1, memory allocs, blocking I/O             | DeepSeek-V3                 |
| `testing`              | Coverage gaps, flaky patterns, assertion adequacy           | Claude Sonnet               |
| `api-design`           | Breaking changes, backward compat, consistency              | Claude Opus                 |
| `migration-safety`     | Schema migrations, feature flags, deprecation paths         | GPT-5.4                     |

These are starting points. Users can define custom roles in `jury.yaml` by
supplying a `system_prompt` override. The role catalog evolves based on
which roles empirically earn their keep in Experiment 0 and beyond.

## 5. Critical design decisions

### 5.1 Why clustering before quorum, not both at once

Doing them together is tempting ("count findings that are similar") but
introduces an unclean coupling. Clustering is about *identity* (is this
the same bug?), quorum is about *consensus* (how many agree?). Separating
them lets us tune each independently — bump the similarity threshold if we
see dup bleed-through, adjust quorum rules if we see noise.

### 5.2 Why per-file clustering, not global

See §3. False merges are worse than false splits. Most real duplicates are
within one file anyway (multiple reviewers noticing the same line).
Cross-file "same root cause in two places" is rare and valuable; we don't
want to hide it.

### 5.3 Why dissent classification is rules-based, not learned

Because we don't have training data yet. Once we have 6 months of
`accepted/rejected` feedback from production users, `dissent.elevate_categories`
becomes a learned weight per repo. For v0.1 it's a static list because
static defaults are debuggable.

### 5.4 Why JSON output is the source of truth, markdown is derived

JSON is machine-consumable, stable across renderers, and cacheable.
Markdown is one render target among several (there will also be HTML,
Slack blocks, GitHub review comments). Always produce the JSON first.

### 5.5 Caching is not optional

Same diff + same model list + same jury version → same verdict. Keying:

```
sha256(
  diff_unified_canonical +
  sorted(model_list) +
  jury_version +
  role_prompts_sha
)
```

The role-prompts SHA is important — if we ship a prompt tweak that
changes outputs, invalidate the cache automatically.

Cache in `~/.cache/jury/` by default; hosted tier caches server-side.

### 5.6 Short-circuit rules

Not every PR needs a full panel. Rules:

- `tiny_diff_threshold` lines → only `bug-hunter` runs
- `skip_patterns` matches all touched files → no jury runs at all, empty
  verdict
- `critical_early_exit: true` → if the first N reviewers all agree on a
  `critical` finding, we can return early without waiting for the rest
  (user can toggle off for paranoid mode)

Short-circuit saves money and latency. It also reduces noise for trivial
changes where a 4-reviewer panel would be overkill.

## 6. Experiment 0: the validation gate

Before writing any consensus engine code, we need empirical evidence that
the approach works. Experiment 0:

### 6.1 Dataset construction

- Find 30 git commits across 3-5 real repositories (compass, cc-guard, a
  public OSS repo we know well) that **fixed real bugs**.
- For each fix commit, use `git blame` / history traversal to identify the
  **bug-introducing commit**.
- Construct the diff for the bug-introducing commit.
- Manually label the precise file/line of the bug. This is the ground truth.

### 6.2 Methodology

For each bug-introducing commit:
1. Run single-model review using each of 4 candidate models (Claude Sonnet,
   GPT-5.4, DeepSeek V3, Qwen Coder).
2. Run jury (all 4 + consensus engine v0 — the simplest possible: exact
   file:line match + majority rule).
3. Record findings from each.

### 6.3 Metrics

Per run, compute:
- **Recall@K**: did the bug appear in the top K findings?
- **Top-1 precision**: was the #1-ranked finding the actual bug?
- **Top-3 precision**: was the bug in top 3?
- **Mean Reciprocal Rank** (MRR) across the 30 commits
- **False positive rate**: findings that weren't the bug but scored as
  high/critical severity
- **Jaccard overlap** between model pairs (independence measure)

### 6.4 Decision thresholds

- If jury's **Top-3 precision** is < 15 percentage points higher than the
  best single model → the aggregation doesn't earn its keep. Kill project
  or pivot.
- If jury's **Top-3 precision** is 15–25 pp higher → marginal; continue
  but be sober about ROI.
- If > 25 pp higher → the bet is validated. Ship the MVP.

Also, if **all four single models have >90% pairwise Jaccard overlap on
findings**, ensemble is pointless — they're not independent. Swap in a
structurally different model (e.g., a reasoning-forward one) or walk away.

## 7. Open questions

- **Reviewer compensation for context limits.** Each model has a different
  context window. Do we truncate to the smallest? Skip models for large
  diffs? Chunk? Undecided.
- **Per-file vs. per-PR reviewer mixes.** Should security-sentinel only
  run when `auth/` or `crypto/` files are touched? Probably yes, but
  there's a tradeoff with finding cross-cutting issues.
- **Incremental review.** On a 40-commit PR, running jury on every commit
  is wasteful. Running only on the final diff loses intra-PR history.
  Maybe hybrid: run on final diff + call out "commit-level interesting"
  commits to re-review? Needs UX design.
- **Reviewer feedback loop.** Users marking findings as accepted/rejected
  feeds into role weights, but also into per-reviewer trust scores. Where
  is the data stored and how is it anonymized? Post-MVP concern.

## 8. Non-goals (for v1)

- Running our own models. We only orchestrate external APIs.
- Doing anything with the code beyond reading the diff and producing
  findings. No suggested-edit application, no auto-PR, no merge.
- Replacing deterministic tooling (linters, type checkers, SAST). We
  complement them, not replace them.
- IDE integrations beyond a thin CLI wrapper. Plugins come after the CLI
  has earned its keep.

---

See [`dsl.md`](dsl.md) for the `jury.yaml` reference and [`use-cases.md`](use-cases.md)
for when to use jury vs. not.
