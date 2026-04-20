/**
 * Dataset loader with legacy-shape promotion.
 *
 * Accepts both the new multi-label form (`ground_truths: [...]`) and the
 * old single-label form (`file`, `line`, `category`, etc.). Loader emits
 * a uniform shape with `ground_truths` always populated.
 */

import { readFileSync } from 'fs'
import type { DatasetEntry, GroundTruth } from './types'

export interface NormalizedEntry extends DatasetEntry {
    ground_truths: GroundTruth[]
}

export function loadDataset(path: string): NormalizedEntry[] {
    return readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('//'))
        .map(line => JSON.parse(line) as DatasetEntry)
        .map(normalize)
}

function normalize(e: DatasetEntry): NormalizedEntry {
    if (e.ground_truths && e.ground_truths.length > 0) {
        return { ...e, ground_truths: e.ground_truths }
    }
    // Promote legacy fields to ground_truths[0]
    if (e.file && e.line !== undefined && e.category && e.severity) {
        return {
            ...e,
            ground_truths: [{
                file: e.file,
                line: e.line,
                category: e.category,
                severity: e.severity,
                description: e.description ?? '',
            }],
        }
    }
    // Entry has no ground truth — allowed (for exploratory entries), but
    // metrics.ts treats it as "no way to compute caught".
    return { ...e, ground_truths: [] }
}
