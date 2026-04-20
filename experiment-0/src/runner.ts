#!/usr/bin/env bun
/**
 * Experiment 0 runner.
 *
 * For every bug in `dataset/bugs.jsonl`, construct the diff of the
 * bug-introducing commit, call all configured reviewers in parallel,
 * persist raw findings. Re-running is idempotent — it skips any
 * (bug_id, reviewer) pair that already has a result file, unless
 * you pass --rerun.
 *
 * Usage:
 *   bun src/runner.ts                 # all bugs × all reviewers with env keys
 *   bun src/runner.ts --bug compass-001
 *   bun src/runner.ts --reviewer deepseek
 *   bun src/runner.ts --rerun
 */

import { mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import type { ReviewerRun } from './types'
import {
    AnthropicReviewer, DeepSeekReviewer, KimiOnPremReviewer, ZenMuxReviewer,
    type Reviewer, type ReviewContext,
} from './reviewers'
import { loadDataset as loadDatasetNormalized } from './dataset'

const ROOT = new URL('..', import.meta.url).pathname
const DATASET = join(ROOT, 'dataset', 'bugs.jsonl')
const FINDINGS_DIR = join(ROOT, 'findings')

function loadDataset() {
    if (!existsSync(DATASET)) {
        console.error(`Missing ${DATASET}. Populate it first (see experiment-0/README.md).`)
        process.exit(1)
    }
    return loadDatasetNormalized(DATASET)
}

/** Resolve the unified diff of `commit` in `repo_path`. */
function getDiff(repoPath: string, commit: string): string {
    const r = spawnSync('git', ['show', '--format=', commit], {
        cwd: repoPath,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
    })
    if (r.status !== 0) {
        throw new Error(`git show ${commit} in ${repoPath} failed: ${r.stderr}`)
    }
    return r.stdout
}

function extractTouchedFiles(diff: string): string[] {
    const files = new Set<string>()
    for (const line of diff.split('\n')) {
        const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/)
        if (m) files.add(m[2]!)
    }
    return [...files]
}

function buildReviewers(): Reviewer[] {
    // Each reviewer silently omits itself if its env key isn't set.
    // The runner reports which were skipped at the top so you know what
    // ran before committing to a comparison.
    const out: Reviewer[] = []
    if (process.env.ANTHROPIC_API_KEY) out.push(new AnthropicReviewer())
    if (process.env.DEEPSEEK_API_KEY)  out.push(new DeepSeekReviewer())
    if (process.env.COMPASS_LLM_ONPREM_KEY) out.push(new KimiOnPremReviewer())
    if (process.env.ZENMUX_API_KEY)    out.push(new ZenMuxReviewer('gpt-5.4', 'openai/gpt-5.4'))
    // Future additions go here.
    return out
}

async function runOneReviewer(
    reviewer: Reviewer,
    ctx: ReviewContext,
): Promise<ReviewerRun> {
    const start = Date.now()
    ;(globalThis as Record<string, unknown>).__jury_last_raw = undefined
    try {
        const findings = await reviewer.review(ctx)
        const raw = (globalThis as Record<string, unknown>).__jury_last_raw as string | undefined
        return {
            bug_id: ctx.bugId,
            reviewer: reviewer.name,
            model: reviewer.model,
            ts: new Date().toISOString(),
            duration_ms: Date.now() - start,
            findings,
            raw_output: typeof raw === 'string' ? raw : undefined,
        }
    } catch (err) {
        const raw = (globalThis as Record<string, unknown>).__jury_last_raw as string | undefined
        return {
            bug_id: ctx.bugId,
            reviewer: reviewer.name,
            model: reviewer.model,
            ts: new Date().toISOString(),
            duration_ms: Date.now() - start,
            findings: [],
            raw_output: typeof raw === 'string' ? raw : undefined,
            error: err instanceof Error ? err.message : String(err),
        }
    }
}

function resultPath(bugId: string, reviewer: string): string {
    return join(FINDINGS_DIR, bugId, `${reviewer}.json`)
}

async function main() {
    const args = process.argv.slice(2)
    const onlyBug = argValue(args, '--bug')
    const onlyReviewer = argValue(args, '--reviewer')
    const rerun = args.includes('--rerun')

    const dataset = loadDataset()
    const reviewers = buildReviewers()

    if (reviewers.length === 0) {
        console.error('No reviewers configured. Set at least one env key:')
        console.error('  ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, COMPASS_LLM_ONPREM_KEY, ZENMUX_API_KEY')
        process.exit(1)
    }

    const filteredBugs = onlyBug ? dataset.filter(b => b.id === onlyBug) : dataset
    const filteredReviewers = onlyReviewer ? reviewers.filter(r => r.name === onlyReviewer) : reviewers

    console.error(`Running ${filteredBugs.length} bug${filteredBugs.length === 1 ? '' : 's'} × ${filteredReviewers.length} reviewer${filteredReviewers.length === 1 ? '' : 's'}`)
    console.error(`Reviewers: ${filteredReviewers.map(r => r.name).join(', ')}`)

    for (const bug of filteredBugs) {
        console.error(`\n━━━ ${bug.id} (${bug.repo}) — ${bug.title}`)
        mkdirSync(join(FINDINGS_DIR, bug.id), { recursive: true })

        let diff: string
        try {
            diff = getDiff(bug.repo_path, bug.intro_commit)
        } catch (err) {
            console.error(`  skipping: ${err instanceof Error ? err.message : err}`)
            continue
        }

        const ctx: ReviewContext = {
            bugId: bug.id,
            diff,
            touchedFiles: extractTouchedFiles(diff),
        }

        // Parallel dispatch across reviewers (one bug at a time to keep
        // concurrent API pressure manageable).
        const tasks = filteredReviewers.map(async (reviewer) => {
            const out = resultPath(bug.id, reviewer.name)
            if (existsSync(out) && !rerun) {
                console.error(`  ${reviewer.name}: cached, skipping`)
                return
            }
            const run = await runOneReviewer(reviewer, ctx)
            writeFileSync(out, JSON.stringify(run, null, 2) + '\n')
            const status = run.error
                ? `ERROR ${run.error.slice(0, 80)}`
                : `${run.findings.length} finding${run.findings.length === 1 ? '' : 's'} (${run.duration_ms}ms)`
            console.error(`  ${reviewer.name}: ${status}`)
        })
        await Promise.all(tasks)
    }

    console.error('\ndone.')
}

function argValue(args: string[], name: string): string | undefined {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
}

await main()
