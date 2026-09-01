# Preflight — an AI QA agent on Solari (TypeScript)

Point it at a web app. It hosts the app in a **Solari sandbox**, opens it in a
**recorded Solari browser**, lets **Claude** explore it like a careful tester,
and hands you a bug report with reproduction steps, screenshots, every console
error and failed request, and an rrweb replay of the whole session.

```
your app dir ──upload──▶ Solari sandbox ──previewUrl──▶ public https URL
                                                             │
                              Claude (tool use) ◀──state──  Solari browser (recording: true)
                                     │ click / type / navigate / screenshot / report_finding
                                     ▼
                         preflight-report/  report.md · findings.json · screenshots/ · replay.ndjson
```

Two Solari products, one key. The sandbox is a throwaway staging server; the
browser is the tester's machine. Nothing runs on yours.

## Run

```bash
cd examples/preflight-qa-agent-ts
npm install
cp .env.example .env            # SOLARI_API_KEY + ANTHROPIC_API_KEY
npm start                       # tests the bundled demo app
```

`npm start` reads `.env` via Node's `--env-file-if-exists`, so no dotenv. Or
export the two variables and run it the cookbook way.

Other targets:

```bash
# Something already deployed — skips the sandbox entirely
npm start -- --url https://staging.example.com --goal "Sign up, create a project, invite a member"

# Your own app: uploaded to /app in the sandbox, started with $PORT set
npm start -- --app ../my-app --start "python3 -m http.server $PORT" --port 8000

# Shorter / longer runs
npm start -- --max-steps 15
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--url` | — | Test this URL instead of deploying `--app` |
| `--app` | `./demo-app` | Directory to upload into the sandbox at `/app` |
| `--start` | `python3 server.py` | Command that starts the app (runs in `/app`, `$PORT` set) |
| `--port` | `8000` | Port the app listens on inside the sandbox |
| `--goal` | smoke-test the to-do app | What to test, in plain English |
| `--max-steps` | `30` | Action budget for the agent |
| `--out` | `./preflight-report` | Where the report goes |

Exit code is `1` on a FAIL verdict, `0` on PASS, so `npm start` works as a CI step.

## The demo app

`demo-app/server.py` is a 150-line stdlib to-do app ("Tidelist") with **four
planted bugs**: empty titles are accepted, delete removes the *previous* item,
"Clear completed" hits a route that doesn't exist, and the counter counts every
item instead of the open ones. Two of those are invisible unless you compare
state before and after; one only shows up in the console. That's the point.

## What a run looks like

_Illustrative transcript — the real one from a recorded run gets pasted here once it exists._

```
[   0.0s] deploying ./demo-app into a Solari sandbox
[   1.4s] sandbox sbx_… booted
[   2.9s] uploaded 1 file(s) to /app
[   3.6s] preview https://….preview.getsolari.com
[   6.1s] app is reachable
[   8.0s] browser session ses_…
[  14.2s] #1 get_page {}
[  22.7s] #2 type {"id":1,"text":"","submit":true}
[  31.5s] #3 report_finding {"severity":"major","title":"Empty to-do is accepted",…}
[  31.9s]   ▲ MAJOR: Empty to-do is accepted
…
[ 140.3s] agent finished: FAIL with 4 finding(s)
[ 140.4s] report preflight-report/report.md
[ 152.0s] replay saved (48213 bytes, 312 rrweb events)
[ 153.1s] sandbox sbx_… destroyed
```

`report.md` has a findings table, per-finding repro steps with expected/actual
and a screenshot, a table of every browser signal by step, and the app's own
log tail from inside the sandbox. `findings.json` is the same thing for machines.

## How it's built

- **`src/deploy.ts`** — `SolariClient.sandboxes.create` → upload → start the app
  detached with `sh -c "nohup … &"` → `previewUrl(port)` → poll the URL from
  outside until it answers. Sandbox commands are argv, not shell lines, so the
  only place a shell appears is that one `sh -c`.
- **`src/browser-tools.ts`** — `Solari.launch({ recording: true })`, then plain
  Playwright. Claude doesn't get HTML; it gets visible text plus a numbered list
  of interactive elements, and acts by number. Page listeners collect console
  errors, uncaught exceptions, failed requests and 4xx/5xx responses; every
  tool result ends with the new ones so the model can't miss them.
- **`src/agent.ts`** — a manual tool-use loop on `claude-opus-5` with eight
  tools. System prompt and tool list are the cached prefix; the transcript grows
  after it. When the step budget is spent, `tool_choice` forces `finish`.
- **`src/report.ts`** — Markdown + JSON + signals + app log.

## Gotchas this example encodes

- **`page.evaluate` + tsx:** esbuild wraps *named* inner functions in a `__name`
  helper that doesn't exist inside the page, and you get
  `ReferenceError: __name is not defined`. Keep callbacks anonymous inside
  `evaluate`.
- **Recording is per session.** `launch({ recording: true })` or the replay
  endpoint 404s forever. The upload is async after `close()`, so poll.
- **`kill()` the sandbox, `close()` the browser, then `solari.close()`.** Skip the
  last one and Node never exits — the browser client keeps a loopback proxy open.
- **Preview URLs come up before the app does.** The edge answers 5xx until the
  process binds the port; poll from outside the VM, not inside.
- **Cost:** a 30-step run is roughly 2–3 minutes of one browser and one small
  sandbox on Solari, plus one Claude Opus 5 conversation with a handful of
  screenshots in it. Trim `--max-steps` for quick checks.

Source: [`index.ts`](index.ts) · [`src/`](src) · [`demo-app/server.py`](demo-app/server.py)
