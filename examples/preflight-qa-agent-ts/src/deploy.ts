/**
 * Deploy a local app directory into a fresh Solari sandbox and expose it on a
 * public preview URL.
 *
 * The sandbox is the "staging server" for the test run: the app runs there, the
 * cloud browser reaches it over the preview URL, and the whole thing is thrown
 * away at the end. Nothing is installed or exposed on your machine.
 */
import { readdir, readFile } from "node:fs/promises"
import { join, posix } from "node:path"
import { SolariClient } from "@solarisdk/sdk"

export interface DeployedApp {
  url: string
  sandboxId: string
  /** Tail of the app's stdout/stderr inside the VM. */
  appLog: () => Promise<string>
  /** Destroy the VM. */
  teardown: () => Promise<void>
}

export interface DeployOptions {
  apiKey: string
  appDir: string
  /** Shell command that starts the app, run from /app with $PORT set. */
  start: string
  port: number
  log: (line: string) => void
}

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist"])

export async function deployToSandbox(opts: DeployOptions): Promise<DeployedApp> {
  // SolariClient defaults baseUrl; the standalone SandboxClient would not.
  const pt = new SolariClient({ apiKey: opts.apiKey })

  const sandbox = await pt.sandboxes.create({
    template: "base",
    // Rolling idle window, NOT a hard deadline — resets on every command.
    timeoutMs: 15 * 60_000,
    metadata: { app: "preflight" },
  })
  opts.log(`sandbox ${sandbox.sandboxId} booted`)

  try {
    // The control channel is needed for files.*; commands alone could use the
    // one-shot HTTP path, but we need both.
    await sandbox.connect()

    // ---- upload the app -------------------------------------------------
    const files = await walk(opts.appDir)
    if (files.length === 0) throw new Error(`no files found under ${opts.appDir}`)

    const dirs = new Set<string>(["/app"])
    for (const f of files) dirs.add(posix.dirname(posix.join("/app", f)))
    for (const d of [...dirs].sort()) {
      // `cmd` is argv[0], not a shell line — so no quoting problems here.
      await sandbox.commands.run("mkdir", { args: ["-p", d] })
    }
    for (const f of files) {
      await sandbox.files.write(posix.join("/app", f), await readFile(join(opts.appDir, f)))
    }
    opts.log(`uploaded ${files.length} file(s) to /app`)

    // ---- start it in the background --------------------------------------
    // commands.run waits for exit, so a foreground server would block until
    // the idle timeout. nohup + & through an explicit shell detaches it.
    const startLine = `cd /app && PORT=${opts.port} nohup ${opts.start} > /tmp/app.log 2>&1 &`
    const started = await sandbox.commands.run("sh", { args: ["-c", startLine] })
    if (started.exitCode !== 0) {
      throw new Error(`start command failed (exit ${started.exitCode}): ${started.stderr}`)
    }

    const { url } = await sandbox.previewUrl(opts.port)
    opts.log(`preview ${url}`)

    // ---- wait until it answers from the open internet ---------------------
    // The preview edge returns 5xx until the process binds the port. Poll from
    // *here* (outside the VM) so we know the browser will be able to reach it.
    const deadline = Date.now() + 60_000
    let lastStatus = "no response yet"
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { redirect: "manual" })
        if (res.ok || (res.status >= 300 && res.status < 400)) break
        lastStatus = `HTTP ${res.status}`
      } catch (err) {
        lastStatus = err instanceof Error ? err.message : String(err)
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
    if (Date.now() >= deadline) {
      const log = await sandbox.files.readText("/tmp/app.log").catch(() => "(no log)")
      throw new Error(`app never became reachable at ${url} (${lastStatus}). App log:\n${log}`)
    }
    opts.log("app is reachable")

    return {
      url,
      sandboxId: sandbox.sandboxId,
      appLog: () => sandbox.files.readText("/tmp/app.log").catch(() => ""),
      // kill() destroys the VM. close() would only drop our channel and leave
      // it running (and billing) until the idle timeout.
      teardown: () => sandbox.kill(),
    }
  } catch (err) {
    await sandbox.kill().catch(() => {})
    throw err
  }
}

/** Recursively list files under `root` as POSIX-relative paths. */
async function walk(root: string, rel = ""): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(join(root, rel), { withFileTypes: true })
  for (const e of entries) {
    const p = rel ? posix.join(rel, e.name) : e.name
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...(await walk(root, p)))
    } else if (e.isFile()) {
      out.push(p)
    }
  }
  return out
}
