# When jury earns its keep (and when it doesn't)

Jury costs more than a single-model review. Each PR calls N model APIs
instead of 1, plus the consensus-engine work. That cost is justified
when it buys you real signal; not when it doesn't.

This guide is honest about both sides.

---

## When jury is worth it

### 1. You're gating merges on AI review

If AI review blocks merge, false positives cost you developer attention
every day. Every time a developer hits `--no-verify` or overrides a
failing check, the tool loses trust. A month of that and the gate is
decorative.

Jury's consensus filtering is specifically tuned for this scenario.
High-confidence findings (3/4 reviewers agree) are worth blocking on;
minority findings are informational.

**Alternative if not gating**: a single-model review configured as
informational-only works fine. Don't pay ensemble cost for opt-in
feedback.

### 2. Your code is security-sensitive

Authn, crypto, SSRF, secret handling — the cost of a missed bug here is
asymmetric. A false negative can mean a breach; a false positive costs a
few minutes of developer time.

Jury's `dissent.elevate_categories` mechanism is designed for exactly
this. Even a single reviewer flagging a potential auth bypass gets
surfaced, as long as the finding includes concrete evidence.

**Alternative**: For the most critical paths, SAST tools (Semgrep,
CodeQL) have deterministic rules. Jury complements them; it doesn't
replace them.

### 3. Your team reviews concurrency-heavy code

Race conditions and async invariants are notoriously hard for any single
LLM to catch reliably. Training data in this area is sparse and
idiosyncratic. Different models have different blind spots.

A `concurrency-watcher` reviewer using a reasoning-forward model
(DeepSeek-R1, Claude Opus extended thinking) in a panel with a
different-architecture model (GPT-5.4) catches failures one alone
wouldn't.

### 4. You're drowning in low-quality AI review noise

Teams that enabled CodeRabbit / Qodo / Greptile and later turned them
off usually complain about signal-to-noise. The underlying model works;
the filtering doesn't.

Swapping in jury (same underlying APIs, different aggregation layer)
often turns that into a tool you can leave on.

### 5. You're an OSS maintainer drowning in PRs

For maintainers processing 20+ contributor PRs a week, *any* automation
that reliably flags the real issues is gold. Jury works here not because
its findings are magically better, but because:

- The verdict is short (noise filtered)
- Informed dissent catches the weird edge cases maintainers would miss
  on a fast skim
- The machine-readable JSON output feeds into your triage scripts

---

## When single-model is fine

### 1. Your codebase is small and you know the models' blind spots

If you've been reviewing your own code with Claude Sonnet for 6 months
and you've learned what it misses, a second model running in parallel
doesn't buy much — you already have a mental model of the blind spots
and compensate for them manually.

### 2. You're doing a throwaway prototype

A hackathon project or a research notebook doesn't need a merge gate.
Run one model, take its advice with a grain of salt, move on.

### 3. Your PRs are tiny and mechanical

Dependency bumps, version string updates, string-only changes in docs.
These don't have bugs worth catching. Jury's `short_circuit.skip_patterns`
handles these automatically, but you might prefer to skip the
infrastructure entirely.

### 4. You're using deterministic analyzers that already catch the class of bugs you worry about

If your language + toolchain gives you strong static guarantees (Rust
with clippy, Haskell, TypeScript with strict mode + exhaustive
everything), the marginal bugs an LLM review catches are often not
worth paying for review across multiple models.

### 5. Cost is a real constraint

If 4x the API cost per PR isn't worth 15+ pp improvement in finding
quality, don't use jury. It's designed for teams where bugs cost more
than reviews.

---

## Borderline cases

### "We use Claude Code / Cursor heavily. Do I still need jury?"

Yes, but for a different reason. Claude Code / Cursor give you
**interactive** review during writing. Jury gives you **independent
verdict** at a checkpoint (commit, PR open). They're complementary:

- Claude Code: "help me write this function"
- Jury: "before we merge, has this function's final form been cross-checked?"

The best teams use both.

### "We already have a human reviewer for every PR."

Jury doesn't replace human review. It makes it more efficient. The
human reviewer still sees the diff, but with jury's verdict as a
pre-filter: the obvious stuff is flagged, they can focus on the
architecture and judgment calls that LLMs don't touch.

If your humans are already fast and diligent, jury's CI run adds 30-90s
of wall-clock but often saves 10+ minutes of human attention per PR.

### "We're OK with our current noisy AI review because we've trained ourselves to ignore it."

This is the single strongest signal that jury will be a clear win. You've
*already* paid the adoption cost of an AI reviewer; the only thing
missing is the aggregation layer that makes it trustable again.

Try jury on one repo for a month, compare to your current setup, decide.

---

## Rough cost model

Per PR, a typical 4-reviewer panel on a 200-line diff runs:

- ~4 × 8K tokens input + 2K output per reviewer = 32K in, 8K out total
- Mix of model costs: ~$0.15–0.40 per full panel run
- Cache hits: ~$0 (you only pay once per unique diff + model list)
- Clustering embedding call: ~$0.001
- LLM-as-judge for borderlines: ~$0.01

So **~$0.20–0.50 per unique PR review**, before aggressive short-circuiting
trims simple cases. A team of 10 shipping 50 PRs/week tops out at ~$100/month
fully loaded, cached, across the whole team.

Compare to the cost of a missed auth bug.

---

## Red flags that jury is not for you

- You're trying to replace human review entirely. Don't. Jury isn't that
  good, and nothing that exists today is.
- You're worried about sending your code to external APIs. Either use the
  Ollama/local-only setup or just don't use any AI review tool — they all
  have this problem.
- You have strong, confident opinions on "which model is best" and want
  to use just that one. Fine, use that one. Don't pay jury's price for
  the shape of your belief.
- Your team already rejects AI review as a category. A technical tool
  doesn't fix cultural trust issues.

---

## One more thing

Jury is not magic. It's a better-tuned filter over the same models.
The gains come from **reviewer diversity**, **clustering**, and
**quorum rules**, not from secret sauce. If you've got a single model
that works for your team, you don't *need* jury. But if you're looking
for a trustable signal and the options have all been underwhelming,
try it for a month.

And if Experiment 0 shows our ensemble gains aren't real, we'll tell
you and walk away from this idea. That's in the license of the product.
