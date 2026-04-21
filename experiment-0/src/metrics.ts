#!/usr/bin/env bun
/**
 * Compute Experiment 0 metrics from findings/ and dataset/bugs.jsonl.
 *
 * For each bug:
 *   - For each single reviewer:
 *     - caught / caught_rank / top1_hit / top3_hit / mrr_contribution /
 *       total_findings / false_positives
 *   - For jury (consensus of all available reviewers):
 *     - same metrics
 *
 * Aggregate across bugs:
 *   - per-reviewer recall, top-1 precision, top-3 precision, MRR
 *   - jury the same
 *   - pairwise Jaccard overlap between reviewers (independence sanity check)
 *   - decision (SHIP / CONTINUE_CAUTIOUSLY / KILL) per spec.md rules
 *
 * Usage:
 *   bun src/metrics.ts                  # prints aggregate + writes metrics.json
 *   bun src/metrics.ts --bug compass-001 # per-bug breakdown for one
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type {
    DatasetEntry, GroundTruth, Finding, ReviewerRun, BugMetrics, PerModelMetric,
    AggregateMetrics, ReviewerAggregate, Verdict,
} from './types'
import { buildJuryVerdict } from './ensemble'
import { loadDataset as loadDatasetNormalized, type NormalizedEntry } from './dataset'

const ROOT = new URL('..', import.meta.url).pathname
const DATASET = join(ROOT, 'dataset', 'bugs.jsonl')
const FINDINGS_DIR = join(ROOT, 'findings')
const OUT = join(ROOT, 'metrics.json')

const LINE_TOLERANCE = 3

function loadDataset(): NormalizedEntry[] {
    return loadDatasetNormalized(DATASET)
}

function loadFindings(bugId: string): Record<string, ReviewerRun> {
    const dir = join(FINDINGS_DIR, bugId)
    if (!existsSync(dir)) return {}
    const out: Record<string, ReviewerRun> = {}
    for (const file of readdirSync(dir)) {
        if (!file.endsWith('.json')) continue
        const name = file.slice(0, -5)
        const run = JSON.parse(readFileSync(join(dir, file), 'utf8')) as ReviewerRun
        out[name] = run
    }
    return out
}

/** Match a finding against any ground truth in a bug's ground_truths list.
 *  Same file + line within tolerance. No category/severity check because
 *  models vary wildly in taxonomy. */
function matchesAnyGroundTruth(f: Finding | Verdict, gts: GroundTruth[]): boolean {
    for (const gt of gts) {
        if (matchesOneGroundTruth(f, gt)) return true
    }
    return false
}

function matchesOneGroundTruth(f: Finding | Verdict, gt: GroundTruth): boolean {
    if (normFile(f.file) !== normFile(gt.file)) return false
    if (f.line === undefined) return false
    const gtStart = Array.isArray(gt.line) ? gt.line[0]! : gt.line
    const gtEnd   = Array.isArray(gt.line) ? gt.line[1]! : gt.line
    const fStart  = f.line
    const fEnd    = ('endLine' in f && f.endLine !== undefined) ? f.endLine : f.line
    return (fStart - LINE_TOLERANCE <= gtEnd) && (gtStart - LINE_TOLERANCE <= fEnd)
}

function normFile(s: string): string {
    return s.replace(/^\.?\/+/, '').trim()
}

function computePerModel(findings: Finding[], entry: NormalizedEntry): PerModelMetric {
    let caughtRank: number | null = null
    for (let i = 0; i < findings.length; i++) {
        if (matchesAnyGroundTruth(findings[i]!, entry.ground_truths)) {
            caughtRank = i + 1
            break
        }
    }
    const total = findings.length
    const falsePositives = findings.filter(f =>
        (f.severity === 'critical' || f.severity === 'important') && !matchesAnyGroundTruth(f, entry.ground_truths),
    ).length

    return {
        caught: caughtRank !== null,
        caught_rank: caughtRank,
        top1_hit: caughtRank === 1,
        top3_hit: caughtRank !== null && caughtRank <= 3,
        mrr_contribution: caughtRank !== null ? 1 / caughtRank : 0,
        total_findings: total,
        false_positives: falsePositives,
    }
}

function jaccard(aFindings: Finding[], bFindings: Finding[]): number {
    // Jaccard on (file, rounded-line) pairs. Lets us measure overlap
    // across reviewers as a proxy for independence.
    const keysA = new Set(aFindings.map(f => `${normFile(f.file)}:${Math.round((f.line ?? 0) / LINE_TOLERANCE) * LINE_TOLERANCE}`))
    const keysB = new Set(bFindings.map(f => `${normFile(f.file)}:${Math.round((f.line ?? 0) / LINE_TOLERANCE) * LINE_TOLERANCE}`))
    const intersection = [...keysA].filter(k => keysB.has(k)).length
    const union = new Set([...keysA, ...keysB]).size
    return union === 0 ? 0 : intersection / union
}

function aggregate(perBug: BugMetrics[], reviewer: string): ReviewerAggregate {
    const rows = perBug.map(b => b.per_reviewer[reviewer]).filter(Boolean) as PerModelMetric[]
    const n = rows.length || 1
    const recall = rows.filter(r => r.caught).length / n
    const top1 = rows.filter(r => r.top1_hit).length / n
    const top3 = rows.filter(r => r.top3_hit).length / n
    const mrr = rows.reduce((s, r) => s + r.mrr_contribution, 0) / n
    const meanFindings = rows.reduce((s, r) => s + r.total_findings, 0) / n
    const meanFP = rows.reduce((s, r) => s + r.false_positives, 0) / n
    return {
        recall: round(recall),
        top1_precision: round(top1),
        top3_precision: round(top3),
        mrr: round(mrr),
        mean_findings: round(meanFindings),
        mean_false_positives: round(meanFP),
    }
}

function aggregateJury(perBug: BugMetrics[]): ReviewerAggregate {
    const rows = perBug.map(b => b.jury)
    const n = rows.length || 1
    return {
        recall: round(rows.filter(r => r.caught).length / n),
        top1_precision: round(rows.filter(r => r.top1_hit).length / n),
        top3_precision: round(rows.filter(r => r.top3_hit).length / n),
        mrr: round(rows.reduce((s, r) => s + r.mrr_contribution, 0) / n),
        mean_findings: round(rows.reduce((s, r) => s + r.total_findings, 0) / n),
        mean_false_positives: round(rows.reduce((s, r) => s + r.false_positives, 0) / n),
    }
}

function round(x: number): number { return Math.round(x * 1000) / 1000 }

function decide(agg: AggregateMetrics): { decision: AggregateMetrics['decision']; reason: string } {
    const reviewers = Object.values(agg.per_reviewer)
    if (reviewers.length === 0) {
        return { decision: 'KILL', reason: 'no reviewers ran' }
    }

    // Independence check: if all pairwise jaccard > 0.9, ensemble is
    // degenerate even if the numbers look OK.
    const jaccards: number[] = []
    for (const a of Object.keys(agg.pairwise_jaccard)) {
        for (const b of Object.keys(agg.pairwise_jaccard[a] ?? {})) {
            if (a < b) jaccards.push(agg.pairwise_jaccard[a]![b]!)
        }
    }
    const meanJac = jaccards.length ? jaccards.reduce((s, j) => s + j, 0) / jaccards.length : 0
    if (meanJac > 0.9) {
        return { decision: 'KILL', reason: `reviewers too correlated: mean pairwise Jaccard = ${round(meanJac)}` }
    }

    // Updated post-2026-04-21: the product is a PRECISION tool, not a
    // RECALL tool. If consensus_precision >= 80%, jury's "trust us, these
    // are real" short list has real product value — even if recall is
    // lower than the best single model. See docs/spec.md §5 for rationale.
    const cp = agg.jury_consensus_precision
    if (cp === null || agg.jury_verdicts_total === 0) {
        return { decision: 'KILL', reason: 'jury emitted no verdicts across the dataset; quorum too strict or models too independent' }
    }
    if (cp >= 0.80) {
        return { decision: 'SHIP', reason: `consensus precision ${(cp * 100).toFixed(1)}% on ${agg.jury_verdicts_total} verdicts; product is a high-precision filter` }
    }
    if (cp >= 0.60) {
        return { decision: 'CONTINUE_CAUTIOUSLY', reason: `consensus precision ${(cp * 100).toFixed(1)}% on ${agg.jury_verdicts_total} verdicts; borderline — add dissent layer before shipping` }
    }
    return { decision: 'KILL', reason: `consensus precision only ${(cp * 100).toFixed(1)}% on ${agg.jury_verdicts_total} verdicts; below 60% threshold — adding more reviewers is not yielding trustable signal` }
}

function perBugMetrics(entry: NormalizedEntry, runs: Record<string, ReviewerRun>): BugMetrics {
    const per_reviewer: Record<string, PerModelMetric> = {}
    for (const [name, run] of Object.entries(runs)) {
        per_reviewer[name] = computePerModel(run.findings, entry)
    }

    // Compute jury verdict from all reviewers that ran successfully
    const allFindings: Finding[] = []
    const activeReviewers = Object.entries(runs).filter(([_, r]) => !r.error)
    for (const [_, run] of activeReviewers) {
        allFindings.push(...run.findings)
    }
    const verdict = buildJuryVerdict(allFindings, activeReviewers.length)
    const jury: PerModelMetric = (() => {
        let caughtRank: number | null = null
        for (let i = 0; i < verdict.length; i++) {
            if (matchesAnyGroundTruth(verdict[i]!, entry.ground_truths)) { caughtRank = i + 1; break }
        }
        const falsePositives = verdict.filter(v =>
            (v.severity === 'critical' || v.severity === 'important') && !matchesAnyGroundTruth(v, entry.ground_truths),
        ).length
        return {
            caught: caughtRank !== null,
            caught_rank: caughtRank,
            top1_hit: caughtRank === 1,
            top3_hit: caughtRank !== null && caughtRank <= 3,
            mrr_contribution: caughtRank !== null ? 1 / caughtRank : 0,
            total_findings: verdict.length,
            false_positives: falsePositives,
        }
    })()


    return { bug_id: entry.id, repo: entry.repo, per_reviewer, jury }
}

async function main() {
    const args = process.argv.slice(2)
    const onlyBug = argValue(args, '--bug')

    const dataset = loadDataset()
    if (dataset.length === 0) {
        console.error('Empty dataset; add entries to dataset/bugs.jsonl first.')
        process.exit(1)
    }

    const bugs = onlyBug ? dataset.filter(b => b.id === onlyBug) : dataset
    const perBug: BugMetrics[] = []

    // For pairwise jaccard we aggregate findings across all bugs per reviewer.
    const findingsByReviewer: Record<string, Finding[]> = {}

    for (const bug of bugs) {
        const runs = loadFindings(bug.id)
        if (Object.keys(runs).length === 0) {
            console.error(`No findings for ${bug.id}; run runner.ts first.`)
            continue
        }
        for (const [name, run] of Object.entries(runs)) {
            findingsByReviewer[name] = findingsByReviewer[name] ?? []
            findingsByReviewer[name].push(...run.findings)
        }
        perBug.push(perBugMetrics(bug, runs))
    }

    if (perBug.length === 0) {
        console.error('No usable results. Run runner.ts first.')
        process.exit(1)
    }

    // Per-reviewer aggregates
    const allReviewerNames = new Set<string>()
    perBug.forEach(b => Object.keys(b.per_reviewer).forEach(r => allReviewerNames.add(r)))
    const per_reviewer: Record<string, ReviewerAggregate> = {}
    for (const r of allReviewerNames) per_reviewer[r] = aggregate(perBug, r)

    // Jaccard
    const pairwise_jaccard: Record<string, Record<string, number>> = {}
    for (const a of allReviewerNames) {
        pairwise_jaccard[a] = {}
        for (const b of allReviewerNames) {
            if (a === b) continue
            pairwise_jaccard[a]![b] = round(jaccard(findingsByReviewer[a] ?? [], findingsByReviewer[b] ?? []))
        }
    }

    // Consensus precision: across all bugs, fraction of jury verdicts that
    // match ground truth. This is jury's flagship metric — "when consensus
    // fires, is it real?"
    let verdicts_total = 0
    let verdicts_matching = 0
    for (const bug of bugs) {
        const runs = loadFindings(bug.id)
        const activeRuns = Object.entries(runs).filter(([_, r]) => !r.error)
        const allF: Finding[] = []
        for (const [_, r] of activeRuns) allF.push(...r.findings)
        const v = buildJuryVerdict(allF, activeRuns.length)
        verdicts_total += v.length
        verdicts_matching += v.filter(x => matchesAnyGroundTruth(x, bug.ground_truths)).length
    }
    const jury_consensus_precision = verdicts_total > 0
        ? round(verdicts_matching / verdicts_total)
        : null

    const agg: AggregateMetrics = {
        n: perBug.length,
        per_reviewer,
        jury: aggregateJury(perBug),
        jury_consensus_precision,
        jury_verdicts_total: verdicts_total,
        jury_verdicts_matching: verdicts_matching,
        pairwise_jaccard,
        decision: 'KILL',
        decision_reason: '',
    }
    const d = decide(agg)
    agg.decision = d.decision
    agg.decision_reason = d.reason

    writeFileSync(OUT, JSON.stringify({ aggregate: agg, per_bug: perBug }, null, 2) + '\n')

    // Print concise report to stderr
    console.error(`\nExperiment 0 — ${perBug.length} bug${perBug.length === 1 ? '' : 's'}\n`)
    console.error('Per-reviewer:')
    for (const [name, m] of Object.entries(per_reviewer)) {
        console.error(`  ${name.padEnd(16)} recall=${pct(m.recall)} top1=${pct(m.top1_precision)} top3=${pct(m.top3_precision)} MRR=${m.mrr.toFixed(3)} FP/bug=${m.mean_false_positives.toFixed(1)}`)
    }
    console.error(`\nJury (consensus): recall=${pct(agg.jury.recall)} top1=${pct(agg.jury.top1_precision)} top3=${pct(agg.jury.top3_precision)} MRR=${agg.jury.mrr.toFixed(3)} FP/bug=${agg.jury.mean_false_positives.toFixed(1)}`)
    const cpStr = agg.jury_consensus_precision === null ? 'N/A' : `${(agg.jury_consensus_precision * 100).toFixed(1)}%`
    console.error(`Consensus precision: ${cpStr} (${agg.jury_verdicts_matching}/${agg.jury_verdicts_total} verdicts match GT)`)

    console.error('\nPairwise Jaccard (lower = more independent):')
    const names = [...allReviewerNames].sort()
    for (const a of names) {
        for (const b of names) {
            if (a >= b) continue
            console.error(`  ${a.padEnd(16)} ↔ ${b.padEnd(16)}  ${pairwise_jaccard[a]![b]!.toFixed(3)}`)
        }
    }

    console.error(`\nDecision: ${agg.decision}`)
    console.error(`Reason:   ${agg.decision_reason}`)
    console.error(`\nFull metrics: ${OUT}`)
}

function pct(x: number): string { return `${(x * 100).toFixed(1)}%` }
function argValue(args: string[], name: string): string | undefined {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
}

await main()
