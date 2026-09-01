/**
 * Turn the run into something a human (or a PR comment bot) can read.
 *
 * Output directory layout:
 *   report.md            the thing you read
 *   findings.json        the thing your CI parses
 *   signals.txt          every console error / failed request, by step
 *   screenshots/*.jpg    evidence, one per finding plus any the agent took
 *   replay.ndjson        rrweb DOM recording of the whole browser session
 *   app.log              stdout/stderr of the app inside the sandbox
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { AgentResult } from "./agent.ts"
import type { Harness } from "./browser-tools.ts"

export interface ReportMeta {
  target: string
  sessionId: string
  sandboxId?: string
  durationMs: number
  replayFile?: string
  appLog?: string
}

export async function writeReport(outDir: string, result: AgentResult, harness: Harness, meta: ReportMeta): Promise<string> {
  await mkdir(outDir, { recursive: true })

  const bySeverity = { critical: 0, major: 0, minor: 0, note: 0 }
  for (const f of result.findings) bySeverity[f.severity]++

  const md: string[] = []
  md.push(`# Preflight report`)
  md.push("")
  md.push(`**Target:** ${meta.target}  `)
  md.push(`**Verdict:** ${badge(result.verdict)}  `)
  md.push(
    `**Findings:** ${result.findings.length} ` +
      `(critical ${bySeverity.critical}, major ${bySeverity.major}, minor ${bySeverity.minor}, note ${bySeverity.note})  `,
  )
  md.push(`**Actions:** ${result.steps} · **Duration:** ${(meta.durationMs / 1000).toFixed(0)}s · **Model:** ${result.model}  `)
  md.push(
    `**Tokens:** ${result.usage.input.toLocaleString()} in / ${result.usage.output.toLocaleString()} out ` +
      `(${result.usage.cacheRead.toLocaleString()} read from cache)  `,
  )
  md.push(`**Browser session:** \`${meta.sessionId}\`${meta.replayFile ? ` · replay: [${meta.replayFile}](${meta.replayFile})` : ""}  `)
  if (meta.sandboxId) md.push(`**Sandbox:** \`${meta.sandboxId}\`  `)
  md.push("")

  md.push(`## Summary`)
  md.push("")
  md.push(result.summary || "_(none)_")
  md.push("")

  md.push(`## Findings`)
  md.push("")
  if (result.findings.length === 0) {
    md.push("_No findings._")
  } else {
    md.push(`| # | Severity | Title | Step | Evidence |`)
    md.push(`| --- | --- | --- | --- | --- |`)
    for (const f of result.findings) {
      md.push(
        `| ${f.id} | ${f.severity} | ${escapePipes(f.title)} | ${f.step} | ${f.screenshot ? `[screenshot](${f.screenshot})` : ""} |`,
      )
    }
    md.push("")
    for (const f of result.findings) {
      md.push(`### ${f.id}. ${f.title}`)
      md.push("")
      md.push(`**Severity:** ${f.severity} · **URL:** ${f.url}`)
      md.push("")
      md.push(`**Steps to reproduce**`)
      md.push("")
      f.steps.forEach((s, i) => md.push(`${i + 1}. ${s}`))
      md.push("")
      md.push(`**Expected:** ${f.expected}`)
      md.push("")
      md.push(`**Actual:** ${f.actual}`)
      md.push("")
      if (f.screenshot) {
        md.push(`![finding ${f.id}](${f.screenshot})`)
        md.push("")
      }
    }
  }

  md.push(`## Browser signals (${harness.signals.length})`)
  md.push("")
  if (harness.signals.length === 0) {
    md.push("_None — no console errors, uncaught exceptions, failed requests or HTTP 4xx/5xx during the run._")
  } else {
    md.push(`| Step | Kind | Detail |`)
    md.push(`| --- | --- | --- |`)
    for (const s of harness.signals) md.push(`| ${s.step} | ${s.kind} | ${escapePipes(s.text)} |`)
  }
  md.push("")

  if (harness.screenshots.length > 0) {
    md.push(`## Screenshots`)
    md.push("")
    for (const s of harness.screenshots) md.push(`- step ${s.step} — [${s.note}](${s.file})`)
    md.push("")
  }

  if (meta.appLog !== undefined) {
    const tail = meta.appLog.trim().split("\n").slice(-40).join("\n")
    md.push(`## App log (tail)`)
    md.push("")
    md.push("```")
    md.push(tail || "(empty)")
    md.push("```")
    md.push("")
  }

  await writeFile(join(outDir, "report.md"), md.join("\n"))
  await writeFile(
    join(outDir, "findings.json"),
    JSON.stringify({ target: meta.target, verdict: result.verdict, findings: result.findings, usage: result.usage }, null, 2),
  )
  await writeFile(
    join(outDir, "signals.txt"),
    harness.signals.map((s) => `[step ${s.step}] ${s.kind}: ${s.text}`).join("\n") + "\n",
  )
  if (meta.appLog !== undefined) await writeFile(join(outDir, "app.log"), meta.appLog)

  return join(outDir, "report.md")
}

function badge(v: AgentResult["verdict"]): string {
  return v === "pass" ? "✅ PASS" : v === "fail" ? "❌ FAIL" : "⚠️ INCOMPLETE"
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ")
}
