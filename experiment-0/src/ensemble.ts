/**
 * Jury-v0: the minimum viable consensus engine.
 *
 * - Cluster findings by (file, line) with ±2-line tolerance
 * - Apply `majority` quorum: cluster size > reviewers/2
 * - No category-aware dissent handling yet (that's v0.1)
 *
 * The purpose of this version is to establish an apples-to-apples
 * ensemble baseline for Experiment 0. If this naive version doesn't
 * beat single-model, fancier clustering won't save us — the hypothesis
 * is falsified.
 *
 * Intentionally dumb. Don't add embedding similarity or LLM-as-judge
 * until we see whether the core hypothesis holds.
 */

import type { Finding, Verdict, Severity } from './types'

const LINE_TOLERANCE = 2

const SEVERITY_RANK: Record<Severity, number> = {
    info: 0, minor: 1, important: 2, critical: 3,
}

function severityMax(a: Severity, b: Severity): Severity {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b
}

/**
 * Given an array of findings from N reviewers (each reviewer can have
 * multiple findings), cluster them and return verdicts for clusters
 * that pass majority quorum.
 *
 * Input: flat list of Finding — each carries its reviewer name.
 * Output: array of Verdict, sorted by severity desc then cluster size desc.
 */
export function buildJuryVerdict(
    findings: Finding[],
    totalReviewers: number,
): Verdict[] {
    const clusters: Finding[][] = []

    for (const f of findings) {
        const matchIdx = clusters.findIndex(c => c.some(x => isSameBug(x, f)))
        if (matchIdx >= 0) {
            clusters[matchIdx]!.push(f)
        } else {
            clusters.push([f])
        }
    }

    const quorumMin = Math.ceil(totalReviewers / 2) + (totalReviewers % 2 === 0 ? 0 : 0)
    // For 4 reviewers: majority = 3; for 3 reviewers: majority = 2
    const majority = Math.floor(totalReviewers / 2) + 1

    const verdicts: Verdict[] = []

    for (const cluster of clusters) {
        const uniqueReviewers = new Set(cluster.map(f => f.reviewer))
        if (uniqueReviewers.size < majority) continue

        const first = cluster[0]!
        let maxSev: Severity = first.severity
        for (const f of cluster) maxSev = severityMax(maxSev, f.severity)

        verdicts.push({
            file: first.file,
            line: first.line,
            severity: maxSev,
            category: first.category,
            title: first.title,
            description: first.description,
            reviewers: [...uniqueReviewers],
            dissent: false,
            raw: cluster,
        })
    }

    verdicts.sort((a, b) => {
        const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
        if (sev !== 0) return sev
        return b.reviewers.length - a.reviewers.length
    })

    return verdicts
}

/** Heuristic same-bug check: same file AND (line overlap with ±tolerance). */
function isSameBug(a: Finding, b: Finding): boolean {
    if (normFile(a.file) !== normFile(b.file)) return false
    if (a.line === undefined || b.line === undefined) return false
    const aStart = a.line
    const aEnd = a.endLine ?? a.line
    const bStart = b.line
    const bEnd = b.endLine ?? b.line
    return (aStart - LINE_TOLERANCE <= bEnd) && (bStart - LINE_TOLERANCE <= aEnd)
}

function normFile(f: string): string {
    return f.replace(/^\.?\/+/, '').trim()
}
