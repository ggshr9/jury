/**
 * Shared types for Experiment 0.
 *
 * Any module in src/ imports from this file. Keeping one source of truth
 * for the Finding shape is important because it flows through every stage
 * (runner → normalize → ensemble → metrics) and a field-name drift would
 * silently corrupt comparisons.
 */

export type Severity = 'critical' | 'important' | 'minor' | 'info'

export type Category =
    // Correctness
    | 'logic-error' | 'off-by-one' | 'null-deref' | 'type-mismatch'
    // Security
    | 'auth' | 'injection' | 'secret-leak' | 'crypto' | 'ssrf' | 'csrf' | 'xss'
    // Concurrency
    | 'race-condition' | 'deadlock' | 'async-invariant' | 'channel-hygiene'
    // Data
    | 'data-integrity' | 'migration-unsafe' | 'constraint-violation' | 'encoding'
    // Performance
    | 'quadratic' | 'n-plus-one' | 'memory-leak' | 'blocking-io'
    // Quality
    | 'naming' | 'style' | 'doc-formatting' | 'dead-code' | 'duplication' | 'complexity'
    // Testing
    | 'coverage-gap' | 'flaky-test' | 'weak-assertion'
    | 'other'

/** Ground-truth entry in dataset/bugs.jsonl. */
export interface DatasetEntry {
    id: string              // "compass-001"
    repo: string            // "compass" | "cc-guard" | "wechat-cc"
    repo_path: string       // absolute path
    fix_commit: string      // short SHA
    intro_commit: string    // short SHA of bug-introducing commit
    file: string            // ground-truth file path, relative to repo root
    line: number | [number, number]
    category: Category
    severity: Severity
    title: string
    description: string
    notes?: string
}

/** A finding as produced by a single reviewer. Normalized from whatever
 *  that model's adapter extracted from its raw output. */
export interface Finding {
    file: string
    line?: number
    endLine?: number
    severity: Severity
    category: Category
    title: string
    description: string
    evidence?: string
    reviewer: string    // set by adapter, e.g. "claude-sonnet-4.6"
    confidence?: number // 0..1 if the model provided one
}

/** Jury-v0 clustered verdict item. */
export interface Verdict {
    file: string
    line?: number
    severity: Severity           // the max across cluster members
    category: Category           // first reviewer's category
    title: string                // first reviewer's title
    description: string          // first reviewer's description
    reviewers: string[]          // who voted
    dissent: boolean             // true if below quorum but elevated
    raw: Finding[]               // all findings merged into this cluster
}

export interface ReviewerRun {
    bug_id: string
    reviewer: string
    model: string
    ts: string                   // ISO timestamp
    duration_ms: number
    findings: Finding[]
    raw_output?: string          // keep the model's raw text for debugging
    error?: string
}

export interface BugRunAggregate {
    bug_id: string
    ground_truth: DatasetEntry
    single_model: Record<string, Finding[]>  // reviewer name → findings
    jury_verdict: Verdict[]
}

export interface BugMetrics {
    bug_id: string
    repo: string
    // Per-reviewer metrics
    per_reviewer: Record<string, PerModelMetric>
    // Jury metrics
    jury: PerModelMetric
}

export interface PerModelMetric {
    caught: boolean              // did ANY finding match ground truth?
    caught_rank: number | null   // 1-indexed rank of the matching finding, or null
    top1_hit: boolean
    top3_hit: boolean
    mrr_contribution: number     // 1/rank or 0
    total_findings: number
    false_positives: number      // high/critical findings that weren't the bug
}

export interface AggregateMetrics {
    n: number                    // dataset size
    per_reviewer: Record<string, ReviewerAggregate>
    jury: ReviewerAggregate
    pairwise_jaccard: Record<string, Record<string, number>>  // independence check
    decision: 'SHIP' | 'CONTINUE_CAUTIOUSLY' | 'KILL'
    decision_reason: string
}

export interface ReviewerAggregate {
    recall: number               // fraction of bugs caught anywhere
    top1_precision: number
    top3_precision: number
    mrr: number
    mean_findings: number
    mean_false_positives: number
}
