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
    DatasetEntry, Finding, ReviewerRun, BugMetrics, PerModelMetric,
    AggregateMetrics, ReviewerAggregate, Verdict,
} from './types'
import { buildJuryVerdict } from './ensemble'

const ROOT = new URL('..', import.meta.url).pathname
const DATASET = join(ROOT, 'dataset', 'bugs.jsonl')
const FINDINGS_DIR = join(ROOT, 'findings')
const OUT = join(ROOT, 'metrics.json')

const LINE_TOLERANCE = 3

function loadDataset(): DatasetEntry[] {
    return readFileSync(DATASET, 'utf8')
        .split('\n').filter(l => l.trim() && !l.startsWith('//'))
        .map(l => JSON.parse(l) as DatasetEntry)
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

/** Match a finding against ground truth. Same file + line within tolerance.
 *  We don't check category/severity because models vary in taxonomy. */
function matchesGroundTruth(f: Finding | Verdict, gt: DatasetEntry): boolean {
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

function computePerModel(findings: Finding[], gt: DatasetEntry): PerModelMetric {
    let caughtRank: number | null = null
    for (let i = 0; i < findings.length; i++) {
        if (matchesGroundTruth(findings[i]!, gt)) {
            caughtRank = i + 1
            break
        }
    }
    const total = findings.length
    const falsePositives = findings.filter(f =>
        (f.severity === 'critical' || f.severity === 'important') && !matchesGroundTruth(f, gt),
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
    const bestTop3 = Math.max(...reviewers.map(r => r.top3_precision))
    const juryTop3 = agg.jury.top3_precision
    const gainPp = (juryTop3 - bestTop3) * 100

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
    if (gainPp < 15) {
        return { decision: 'KILL', reason: `jury Top-3 only +${gainPp.toFixed(1)}pp vs best single (${round(bestTop3)}); below 15pp threshold` }
    }
    if (gainPp < 25) {
        return { decision: 'CONTINUE_CAUTIOUSLY', reason: `jury Top-3 +${gainPp.toFixed(1)}pp vs best single; marginal` }
    }
    return { decision: 'SHIP', reason: `jury Top-3 +${gainPp.toFixed(1)}pp vs best single; validated` }
}

function perBugMetrics(bug: DatasetEntry, runs: Record<string, ReviewerRun>): BugMetrics {
    const per_reviewer: Record<string, PerModelMetric> = {}
    for (const [name, run] of Object.entries(runs)) {
        per_reviewer[name] = computePerModel(run.findings, bug)
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
            if (matchesGroundTruth(verdict[i]!, bug)) { caughtRank = i + 1; break }
        }
        const falsePositives = verdict.filter(v =>
            (v.severity === 'critical' || v.severity === 'important') && !matchesGroundTruth(v, bug),
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

    return { bug_id: bug.id, repo: bug.repo, per_reviewer, jury }
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

    const agg: AggregateMetrics = {
        n: perBug.length,
        per_reviewer,
        jury: aggregateJury(perBug),
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
