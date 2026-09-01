/**
 * Preflight — an AI QA agent built on Solari.
 *
 *   sandbox   hosts the app under test on a public preview URL
 *   browser   a recorded cloud browser that Claude drives through the app
 *   report    findings + screenshots + console signals + rrweb replay
 *
 *   npm start                              # test the bundled demo app
 *   npm start -- --url https://your.app    # test something already deployed
 *   npm start -- --app ./my-app --start "python3 server.py" --port 8000
 *
 * Exits 1 when the verdict is FAIL, so it drops straight into CI.
 */
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { Solari, SolariError } from "@solarisdk/browser"
import { runAgent } from "./src/agent.ts"
import { Harness } from "./src/browser-tools.ts"
import { deployToSandbox, type DeployedApp } from "./src/deploy.ts"
import { writeReport } from "./src/report.ts"

const { values: args } = parseArgs({
  options: {
    url: { type: "string" },
    app: { type: "string", default: "./demo-app" },
    start: { type: "string", default: "python3 server.py" },
    port: { type: "string", default: "8000" },
    goal: {
      type: "string",
      default:
        "Smoke-test this to-do app as a careful user would: add items (including edge cases), " +
        "complete and un-complete them, delete specific items, use every button, and verify the counter " +
        "and list stay correct after each action.",
    },
    "max-steps": { type: "string", default: "30" },
    out: { type: "string", default: "./preflight-report" },
  },
})

const apiKey = process.env.SOLARI_API_KEY
if (!apiKey) {
  console.error("SOLARI_API_KEY is not set — get one at https://console.getsolari.com")
  process.exit(2)
}

const t0 = Date.now()
const log = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`)

const outDir = args.out!
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

// ---- 1. the app under test ----------------------------------------------------
let deployed: DeployedApp | undefined
let target = args.url
if (!target) {
  log(`deploying ${args.app} into a Solari sandbox`)
  deployed = await deployToSandbox({
    apiKey,
    appDir: args.app!,
    start: args.start!,
    port: Number(args.port),
    log,
  })
  target = deployed.url
}

// ---- 2. the browser -----------------------------------------------------------
const solari = new Solari({ apiKey })
let sessionId = ""
let replayFile: string | undefined
let exitCode = 0
let harness: Harness | undefined
let result: Awaited<ReturnType<typeof runAgent>> | undefined

try {
  // recording is per SESSION — without this flag the replay endpoint 404s forever.
  const browser = await solari.launch({ recording: true })
  sessionId = browser.id
  log(`browser session ${sessionId}`)

  try {
    const page = await browser.newPage()
    harness = new Harness(page, target, outDir)
    await harness.navigate(target)

    // ---- 3. the agent ---------------------------------------------------------
    result = await runAgent({ harness, goal: args.goal!, maxSteps: Number(args["max-steps"]), log })
    log(`agent finished: ${result.verdict.toUpperCase()} with ${result.findings.length} finding(s)`)

    // ---- 4. the report --------------------------------------------------------
    // Written before we touch the browser so a teardown hiccup can't lose it.
    const reportPath = await writeReport(outDir, result, harness, {
      target,
      sessionId,
      sandboxId: deployed?.sandboxId,
      durationMs: Date.now() - t0,
      appLog: deployed ? await deployed.appLog() : undefined,
    })
    log(`report ${reportPath}`)
    exitCode = result.verdict === "fail" ? 1 : 0
  } finally {
    // Closing the browser also releases the session (that's what triggers the
    // replay upload).
    await browser.close()
  }

  // ---- 5. the replay ------------------------------------------------------------
  // The upload is async after release; the first poll usually 404s. Retry.
  for (let attempt = 1; attempt <= 10 && !replayFile; attempt++) {
    await new Promise((r) => setTimeout(r, 3000))
    try {
      const blob = await solari.sessions.downloadReplay(sessionId)
      replayFile = "replay.ndjson"
      await writeFile(join(outDir, replayFile), blob)
      const events = Buffer.from(blob).toString().split("\n").filter(Boolean).length
      log(`replay saved (${blob.byteLength} bytes, ${events} rrweb events)`)
      // Re-render the report with the replay link now that it exists.
      if (result && harness) {
        await writeReport(outDir, result, harness, {
          target,
          sessionId,
          sandboxId: deployed?.sandboxId,
          durationMs: Date.now() - t0,
          replayFile,
          appLog: deployed ? await deployed.appLog() : undefined,
        }).catch(() => {})
      }
    } catch (err) {
      if (err instanceof SolariError && err.status === 404) continue
      log(`replay download failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }
  if (!replayFile) log("no replay after ~30s (session may be too short to have flushed)")
} finally {
  if (deployed) {
    await deployed.teardown().catch(() => {})
    log(`sandbox ${deployed.sandboxId} destroyed`)
  }
  // REQUIRED in Node: the browser client keeps a loopback proxy open for the
  // connection-retry path. Without this the process prints and then hangs.
  await solari.close()
}

log(`done — verdict ${exitCode === 0 ? "PASS" : "FAIL"} · ${outDir}/report.md`)
process.exit(exitCode)
