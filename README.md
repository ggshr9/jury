# jury

**Multiple reviews. One verdict.**

Run your diff past a panel of LLM reviewers and see only the findings they
agree on — ranked, clustered, and annotated with dissenting opinions.

Built for teams who want AI code review they can actually trust to gate a merge.

---

## Why jury exists

Single-model code review has two failure modes:

- **False negatives** — real bugs slip past one model's training blind spots
- **False positives** — style/preference nitpicks drown the signal, so devs
  learn to ignore the tool

These are inverse pressures. Lower the threshold to catch more bugs → more
noise. Raise it → miss bugs. You can't tune out of it with a single reviewer
because you have **one opinion about quality, period.**

Jury works differently: it runs **several specialized LLM reviewers
independently** on the same diff and outputs a consensus-filtered verdict.
Findings three out of four reviewers caught show up as HIGH. Findings only
one reviewer caught either get elevated as *informed dissent* (if the reviewer
provides strong evidence in a high-stakes category like auth or concurrency)
or quietly dropped as noise.

The result is a shorter, more trustable review — the kind you'd actually
put in front of a CI merge gate.

## How it works

```
                                 ┌─── Reviewer A (general)       ──┐
                                 │    "missed null check at L42"    │
                                 │                                   │
                                 ├─── Reviewer B (security)      ──┤
      git diff  ────────────────►│    "SQL injection at L42"         ├── Clustering ──► Quorum ──► Verdict
                                 │                                   │
                                 ├─── Reviewer C (concurrency)  ──┤
                                 │    "race on shared map at L78"    │
                                 │                                   │
                                 └─── Reviewer D (maintainability) ─┘
                                      "variable could be named better"
```

- **Each reviewer** is a separate LLM call with a role-specialized prompt.
- **Clustering** merges findings that point at the same file + line + semantic
  concern, even when worded differently.
- **Quorum** rules decide what makes the verdict. `critical: unanimous,
  important: majority, minor: any` by default — configurable per repo.
- **Dissent handling** elevates minority opinions in high-stakes categories
  (security, concurrency, data-integrity) and drops weak dissent in
  style/naming.

A unified-JSON adapter layer lets you mix commercial APIs (Anthropic, OpenAI,
Google) with open models (DeepSeek, Qwen, Llama via Ollama) or local-first
inference, with no code changes on your side — just edit `jury.yaml`.

## Quick start

> The CLI is under construction. This section describes the target UX.

```bash
# Install
curl -sSL jury.dev/install | sh   # or `npm i -g @jury/cli` (bun/node 20+)

# Configure reviewers (interactive)
jury init

# Review your current branch against main
jury review

# Review a specific commit range
jury review main..HEAD

# Review a single commit, with structured JSON output for CI
jury review HEAD --format json

# Review only findings with >= 3 reviewers agreeing
jury review --quorum 3

# See reviewer metadata (who said what, why)
jury review --verbose
```

### GitHub Action

```yaml
# .github/workflows/jury.yml
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: jury-sh/review@v1
        with:
          config: jury.yaml   # optional; defaults to repo root
          post-as-review: true # inline comments on PR
          gate:
            block_on: critical # fails CI if any unanimous-critical finding
```

## Configuration (`jury.yaml`)

```yaml
version: 1

reviewers:
  - name: bug-hunter
    role: general-correctness
    model: claude-sonnet-4.6

  - name: security-sentinel
    role: security
    model: gpt-5.4
    focus: [authn, authz, injection, secrets, crypto]

  - name: concurrency-watcher
    role: concurrency
    model: deepseek-r1
    escalate_on: [async, worker, lock, channel, mutex, goroutine]

  - name: maintainability
    role: code-quality
    model: qwen-coder-2.5
    weight: 0.6   # counts less in quorum tallies

quorum:
  critical: unanimous
  important: majority
  minor: any

dissent:
  elevate_categories: [race-condition, auth, data-integrity, secret-leak]
  weak_categories:    [naming, style, doc-formatting]
  weak_category_threshold: 2   # weak categories need >=2 reviewers

short_circuit:
  tiny_diff_threshold: 20   # lines; below this only bug-hunter runs
  critical_early_exit: true
  skip_patterns: ["*.md", "*.lock", "CHANGELOG*"]

context:
  dependency_graph_depth: 2
  include_commit_history: 5  # last N commits touching the changed files

cache:
  enabled: true
  key_includes: [diff_sha, model_list, jury_version]
```

See [`docs/dsl.md`](docs/dsl.md) for the full reference, including role
catalog, model-specific overrides, and per-path reviewer mixes.

## What jury is not

- **Not a style linter.** ESLint/Ruff/gofmt already do that job better and
  cheaper. Jury focuses on semantic findings where LLMs add real value.
- **Not a model router.** Tools like `openai/codex-plugin-cc` route your
  prompt to a single chosen model. Jury's value is the consensus layer
  *over* multiple reviewers, not picking one.
- **Not a replacement for human review.** It's a filter that raises the
  signal-to-noise ratio of the reviews you *would* have run anyway.

## Status

- [ ] Experiment 0 — validation on 30 historical bug-introducing commits
- [ ] CLI scaffold (`jury review` with fixed 3-model panel, no DSL yet)
- [ ] Consensus engine (clustering + quorum)
- [ ] `jury.yaml` v1 parser
- [ ] GitHub Action
- [ ] Reviewer adapter plugins (Codex CLI, Claude, OpenRouter)
- [ ] Pre-commit hook
- [ ] IDE plugins

We publish milestones as they ship. No vapor ETAs.

## Philosophy

> Consensus is cheap. Informed dissent is valuable. Reviewer diversity beats
> reviewer strength. Caching is not optional.

See [`docs/spec.md`](docs/spec.md) for the design rationale behind each
default and [`docs/use-cases.md`](docs/use-cases.md) for concrete scenarios
where jury earns its keep vs. where you're better off with a single model.

## License

Apache-2.0. You can run the CLI locally with your own API keys and none of
your code leaves your machine. Hosted/enterprise tiers are a separate product
and are opt-in.
