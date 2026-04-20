# `jury.yaml` — DSL reference

**Status**: v0.1 draft. Backward-compatibility guarantees start at v1.0.

`jury.yaml` lives at the root of your repo (or pointed to by `--config`).
It is the **source of truth** for how jury reviews your code. Everything
else (CLI flags, GH Action inputs) either reads from this file or
overrides specific fields for that one run.

---

## Minimal example

```yaml
version: 1

reviewers:
  - name: bug-hunter
    model: claude-sonnet-4.6

  - name: security
    model: gpt-5.4
    role: security
```

That's a valid config. Two reviewers, majority quorum by default, no
dissent handling, no short-circuit. Everything else uses defaults.

## Full schema

```yaml
version: 1                   # required; jury will refuse to load unknown majors

reviewers:                   # required; 1+ entries
  - name: string             # required; kebab-case, unique within this file
    role: RoleName           # optional; one of the catalog (see below)
    model: ModelId           # required; see supported-models.md
    system_prompt: string    # optional; overrides role's default prompt
    focus: [string]          # optional; keywords the reviewer biases toward
    escalate_on: [string]    # optional; keywords that bump severity one level
    weight: 0.0..1.0         # optional, default 1.0; weight in quorum tallies
    timeout_seconds: number  # optional, default 120
    max_context_tokens: int  # optional, default model-native
    temperature: 0.0..1.0    # optional, default 0.2
    api:                     # optional; set only if overriding environment
      base_url: url
      key_env: env_var_name  # which env var holds the API key (not the key itself)

quorum:                      # optional; rules for inclusion in verdict
  critical: unanimous | majority | any | N  # default: unanimous
  important: ...                              # default: majority
  minor: ...                                  # default: any

dissent:                     # optional; rules for minority opinion handling
  elevate_categories: [string]
  # Categories where even a single reviewer's finding gets promoted to
  # "Informed Dissent" if accompanied by evidence. Typical values:
  # race-condition, auth, data-integrity, secret-leak, crypto, ssrf.

  weak_categories: [string]
  # Categories where minority findings are dropped unless
  # weak_category_threshold reviewers agree. Typical values:
  # naming, style, doc-formatting, indentation, comment-wording.

  weak_category_threshold: N  # default: 2
  evidence_required: boolean  # default: true for elevate_categories

short_circuit:               # optional; rules to skip/trim review
  tiny_diff_threshold: N     # lines; below this only the 1st reviewer runs
                             # default: 20
  critical_early_exit: bool  # default: true
  skip_patterns: [glob]      # default: [*.md, *.lock, CHANGELOG*]
  skip_files_if_only_whitespace: bool  # default: true

context:                     # optional; how much surrounding code reviewers see
  dependency_graph_depth: N  # BFS depth from touched files; default: 2
  include_commit_history: N  # last N commits touching changed files; default: 5
  max_context_tokens: int    # default: 32000 per reviewer
  include_test_files: bool   # default: true

cache:                       # optional
  enabled: boolean           # default: true
  dir: path                  # default: ~/.cache/jury
  key_includes:              # default: all listed below
    - diff_sha
    - model_list
    - jury_version
    - role_prompts_sha

routing:                     # optional; per-path reviewer mixes
  - paths: ["auth/**", "crypto/**"]
    add_reviewers: [security-sentinel-extra]
    override_quorum:
      important: unanimous   # stricter quorum for sensitive paths

  - paths: ["frontend/**"]
    use_reviewers: [bug-hunter, code-quality]
    # "use_reviewers" replaces the default panel for these paths

  - paths: ["migrations/**"]
    add_reviewers: [migration-safety]
    context:
      dependency_graph_depth: 4  # deeper context for migrations

output:                      # optional; rendering preferences
  format: markdown | json | both  # default: both
  verbose: boolean           # default: false; includes per-reviewer attribution
  show_minority_report: bool # default: true
  show_confidence_scores: bool # default: false
```

## Role catalog

Valid values for `role:`. Each role is a bundled system prompt +
categorization weights.

| Role                    | What it's asked to look for                                    |
|-------------------------|----------------------------------------------------------------|
| `general-correctness`   | Logic bugs, off-by-one, null/undefined, edge cases             |
| `security`              | Authn, authz, injection, secrets, crypto, SSRF                 |
| `concurrency`           | Races, deadlocks, async invariants                             |
| `data-integrity`        | DB constraints, transaction boundaries, invariants             |
| `code-quality`          | Naming, duplication, dead code, readability                    |
| `performance`           | O(n²), N+1, memory, blocking I/O                                |
| `testing`               | Coverage gaps, flaky patterns                                  |
| `api-design`            | Breaking changes, backward compat                              |
| `migration-safety`      | Schema migrations, feature flags                               |
| `accessibility`         | A11y violations in UI diffs                                    |
| `custom`                | Requires `system_prompt:` override; no built-in prompt          |

## Supported models

jury calls whichever provider you configure. We maintain a short-list of
tested model identifiers:

- Anthropic: `claude-opus-4.7`, `claude-sonnet-4.6`, `claude-haiku-4.5`
- OpenAI: `gpt-5.4`, `gpt-5.3-codex`
- Google: `gemini-2.5-pro`, `gemini-2.5-flash`
- DeepSeek: `deepseek-v3`, `deepseek-r1`
- Qwen: `qwen-2.5-coder-32b`, `qwen-3-coder`
- OpenRouter: any id OpenRouter supports; uses OR's API under the hood
- Ollama: `ollama:qwen2.5-coder:32b`, `ollama:llama-3.3:70b` (local)

See [`docs/supported-models.md`](supported-models.md) (shipped with
each release) for the full current list.

## Quorum grammar

The `quorum.{severity}` field accepts:

| Value        | Meaning                                                       |
|--------------|---------------------------------------------------------------|
| `unanimous`  | All reviewers must flag the finding (after weight adjustment) |
| `majority`   | `weighted_votes > total_weight / 2`                           |
| `plurality`  | More reviewers voted "yes" than "no" (ties → include)         |
| `any`        | Any single reviewer flagging is enough                        |
| `N` (int)    | At least N weighted votes                                     |

Weighted votes: a reviewer with `weight: 0.6` counts as 0.6 votes.
Thresholds are computed against the sum of reviewer weights, not count.

## Finding category taxonomy

Reviewers should categorize findings using these tags. This is what
`dissent.elevate_categories` etc. refer to.

- **Correctness**: `logic-error`, `off-by-one`, `null-deref`, `type-mismatch`
- **Security**: `auth`, `injection`, `secret-leak`, `crypto`, `ssrf`, `csrf`, `xss`
- **Concurrency**: `race-condition`, `deadlock`, `async-invariant`, `channel-hygiene`
- **Data**: `data-integrity`, `migration-unsafe`, `constraint-violation`, `encoding`
- **Performance**: `quadratic`, `n-plus-one`, `memory-leak`, `blocking-io`
- **Quality**: `naming`, `style`, `doc-formatting`, `dead-code`, `duplication`, `complexity`
- **Testing**: `coverage-gap`, `flaky-test`, `weak-assertion`

Custom categories may be introduced by a reviewer; they'll surface in the
verdict but won't match any `elevate_categories` or `weak_categories` rule
unless you add them there.

## Examples

### Small solo project

```yaml
version: 1
reviewers:
  - name: local
    model: ollama:qwen2.5-coder:32b   # runs on your laptop, no API costs
```

Minimal. One model, no consensus (by definition), fast local feedback.
Jury still useful here for the JSON output format + caching.

### Startup, 5-person team

```yaml
version: 1
reviewers:
  - name: bug-hunter
    model: claude-sonnet-4.6
  - name: security
    model: gpt-5.4
    role: security
  - name: cheap-second
    model: qwen-2.5-coder-32b
    weight: 0.5

quorum:
  critical: unanimous
  important: majority

short_circuit:
  tiny_diff_threshold: 15
```

Practical 3-reviewer setup. Two real opinions + one cheap tiebreaker.
Small diffs short-circuit fast.

### Security-sensitive service

```yaml
version: 1
reviewers:
  - name: bug-hunter
    model: claude-sonnet-4.6
  - name: security-primary
    model: gpt-5.4
    role: security
    weight: 1.2          # security weighs more
  - name: security-second
    model: claude-opus-4.7
    role: security
    weight: 1.2
  - name: concurrency
    model: deepseek-r1
    role: concurrency
  - name: maintainability
    model: qwen-coder-32b
    weight: 0.5

quorum:
  critical: unanimous    # any critical requires all to agree
  important: 3           # at least 3 weighted votes

dissent:
  elevate_categories: [auth, injection, race-condition, secret-leak, crypto]
  evidence_required: true

routing:
  - paths: ["internal/auth/**", "internal/crypto/**"]
    override_quorum:
      important: unanimous
      minor: majority    # even minor issues need majority here
```

5-reviewer panel with hand-tuned weights and per-path strictness in
auth/crypto directories.

## Gotchas

- **Do not commit API keys** in `jury.yaml`. Use `api.key_env: ANTHROPIC_API_KEY`
  and set the env var outside. The config file goes in your repo; keys
  don't.
- **`unanimous` with differing weights** means all non-zero-weight reviewers
  must agree, regardless of weight. Weights only matter for partial
  quorums.
- **`routing` rules are evaluated in order**, first match wins. Put more
  specific globs first.
- **Cache invalidation is automatic on prompt changes.** If you upgrade
  jury and wonder why findings look different, that's why.
