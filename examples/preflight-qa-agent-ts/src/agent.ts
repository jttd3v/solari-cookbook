/**
 * The agent loop: Claude decides, the harness acts, signals flow back.
 *
 * This is a plain manual tool-use loop rather than the SDK's tool runner so
 * the whole control flow is on one screen: send state, get tool calls, run
 * them, append results, repeat until `finish` or the action budget runs out.
 */
import Anthropic from "@anthropic-ai/sdk"
import { formatSignals, type Harness } from "./browser-tools.ts"

export type Severity = "critical" | "major" | "minor" | "note"

export interface Finding {
  id: number
  step: number
  severity: Severity
  title: string
  steps: string[]
  expected: string
  actual: string
  url: string
  screenshot?: string
}

export interface AgentResult {
  findings: Finding[]
  summary: string
  verdict: "pass" | "fail" | "incomplete"
  steps: number
  model: string
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export const MODEL = "claude-opus-5"

const SYSTEM = `You are Preflight, a QA engineer running an exploratory smoke test of a web app through a real browser.

You perceive the page with get_page (visible text plus numbered interactive elements) and screenshot. You act with navigate, click, type and press. Every action result also lists the browser signals that fired since your last action — console errors, uncaught exceptions, failed requests and HTTP 4xx/5xx responses. Treat those as evidence, not noise: a user clicked something and the app failed behind the scenes.

How to work:
- Start from the test goal and exercise the main user flows end to end, including the edge cases a careful tester tries: empty input, whitespace, repeating an action, acting on the second or third item rather than only the first, undoing.
- After each action, compare the new state with what a user would expect. Check counts, list contents and labels before and after.
- When behaviour is wrong, call report_finding right away with exact reproduction steps and expected vs actual. One finding per distinct bug; do not report the same root cause twice. Severity: critical = data loss or a core flow is blocked; major = a feature is wrong or broken; minor = cosmetic or edge case; note = an observation worth a look.
- Element ids are reassigned on every state you receive, so always act on ids from the latest state.
- Take a screenshot when visual state matters or the text is ambiguous. report_finding captures one automatically.
- You have a limited action budget. Spend it on coverage, not repetition. When you have covered the goal, or you are told the budget is exhausted, call finish with a short summary and a verdict.`

const tools: Anthropic.Beta.BetaTool[] = [
  {
    name: "get_page",
    description: "Return the current page state: URL, title, visible text and the numbered interactive elements.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "navigate",
    description: "Open a URL. Relative paths are resolved against the app's base URL.",
    input_schema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "click",
    description: "Click the interactive element with this id (from the latest page state).",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", minimum: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "type",
    description: "Replace the contents of an input/textarea (by id) with text. Set submit=true to press Enter afterwards.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 1 },
        text: { type: "string" },
        submit: { type: "boolean", default: false },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "press",
    description: "Press a keyboard key on the focused element, e.g. Enter, Escape, Tab.",
    input_schema: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
  },
  {
    name: "screenshot",
    description: "Capture the viewport as an image you can look at. Give it a short note describing the moment.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "report_finding",
    description: "Record a bug. A screenshot of the current state is attached automatically.",
    input_schema: {
      type: "object",
      properties: {
        severity: { type: "string", enum: ["critical", "major", "minor", "note"] },
        title: { type: "string", description: "One line, specific. 'Delete removes the wrong item', not 'Delete bug'." },
        steps: { type: "array", items: { type: "string" }, description: "Exact reproduction steps from a fresh page load." },
        expected: { type: "string" },
        actual: { type: "string" },
      },
      required: ["severity", "title", "steps", "expected", "actual"],
      additionalProperties: false,
    },
  },
  {
    name: "finish",
    description: "End the test run.",
    input_schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "3-6 sentences: what was covered, what was found, what was not tested." },
        verdict: { type: "string", enum: ["pass", "fail"] },
      },
      required: ["summary", "verdict"],
      additionalProperties: false,
    },
  },
]

export interface AgentOptions {
  harness: Harness
  goal: string
  maxSteps: number
  log: (line: string) => void
}

export async function runAgent({ harness, goal, maxSteps, log }: AgentOptions): Promise<AgentResult> {
  // Resolves ANTHROPIC_API_KEY (or an `ant auth login` profile) on its own.
  const client = new Anthropic()

  const findings: Finding[] = []
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let summary = ""
  let verdict: AgentResult["verdict"] = "incomplete"
  let servedBy = MODEL
  let finished = false
  let budgetWarned = false

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    {
      role: "user",
      content:
        `Test goal: ${goal}\n` +
        `Start URL: ${harness.baseUrl}\n` +
        `Action budget: ${maxSteps} actions.\n` +
        `Begin with get_page.`,
    },
  ]

  while (!finished) {
    const res = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8_000,
      // If a safety classifier declines a turn, the API re-runs it on a
      // fallback model inside the same call instead of stopping the run.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Stable prefix first (system + tools) so it is served from cache on
      // every step; the growing transcript comes after the breakpoint.
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
      output_config: { effort: "medium" },
      // Once the budget is spent, the only legal move is to wrap up.
      ...(harness.step >= maxSteps ? { tool_choice: { type: "tool" as const, name: "finish" } } : {}),
    })

    usage.input += res.usage.input_tokens
    usage.output += res.usage.output_tokens
    usage.cacheRead += res.usage.cache_read_input_tokens ?? 0
    usage.cacheWrite += res.usage.cache_creation_input_tokens ?? 0
    if (res.model !== servedBy) {
      servedBy = res.model
      log(`note: this turn was served by ${res.model}`)
    }

    if (res.stop_reason === "refusal") {
      summary = `The model declined to continue (${res.stop_details?.category ?? "unspecified"}).`
      break
    }

    const text = res.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text.trim())
      .filter(Boolean)
      .join("\n")
    if (text) log(`claude: ${text}`)

    const toolUses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
    messages.push({ role: "assistant", content: res.content })

    if (res.stop_reason !== "tool_use" || toolUses.length === 0) {
      // Ended without calling finish — treat the last text as the summary.
      summary = text || "(no summary)"
      verdict = findings.some((f) => f.severity === "critical" || f.severity === "major") ? "fail" : "pass"
      break
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
    for (const tu of toolUses) {
      const input = (tu.input ?? {}) as Record<string, unknown>
      if (tu.name !== "finish") harness.step++
      log(`#${harness.step} ${tu.name} ${JSON.stringify(input).slice(0, 160)}`)

      try {
        results.push(await execute(tu.id, tu.name, input))
      } catch (err) {
        const msg = err instanceof Error ? err.message.split("\n")[0] : String(err)
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          is_error: true,
          content: `${tu.name} failed: ${msg}\n\n${formatSignals(harness.drainSignals())}`,
        })
      }
    }

    const content: Anthropic.Beta.BetaContentBlockParam[] = [...results]
    if (!finished && harness.step >= maxSteps && !budgetWarned) {
      budgetWarned = true
      content.push({ type: "text", text: "Action budget exhausted. Call finish now." })
    }
    messages.push({ role: "user", content })
  }

  return { findings, summary, verdict, steps: harness.step, model: servedBy, usage }

  // ---- tool dispatch ------------------------------------------------------

  async function execute(
    id: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
    const withSignals = (body: string) => `${body}\n\n${formatSignals(harness.drainSignals())}`

    switch (name) {
      case "get_page":
        return { type: "tool_result", tool_use_id: id, content: withSignals(await harness.pageState()) }

      case "navigate":
        return { type: "tool_result", tool_use_id: id, content: withSignals(await harness.navigate(String(input.url))) }

      case "click":
        return { type: "tool_result", tool_use_id: id, content: withSignals(await harness.click(Number(input.id))) }

      case "type":
        return {
          type: "tool_result",
          tool_use_id: id,
          content: withSignals(await harness.type(Number(input.id), String(input.text ?? ""), Boolean(input.submit))),
        }

      case "press":
        return { type: "tool_result", tool_use_id: id, content: withSignals(await harness.press(String(input.key))) }

      case "screenshot": {
        const shot = await harness.screenshot(String(input.note ?? "screenshot"))
        return {
          type: "tool_result",
          tool_use_id: id,
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: shot.base64 } },
            { type: "text", text: withSignals(`Saved as ${shot.file}.`) },
          ],
        }
      }

      case "report_finding": {
        const shot = await harness.screenshot(`finding-${findings.length + 1}`)
        const finding: Finding = {
          id: findings.length + 1,
          step: harness.step,
          severity: (input.severity as Severity) ?? "note",
          title: String(input.title ?? "Untitled finding"),
          steps: Array.isArray(input.steps) ? input.steps.map(String) : [],
          expected: String(input.expected ?? ""),
          actual: String(input.actual ?? ""),
          url: harness.page.url(),
          screenshot: shot.file,
        }
        findings.push(finding)
        log(`  ▲ ${finding.severity.toUpperCase()}: ${finding.title}`)
        return {
          type: "tool_result",
          tool_use_id: id,
          content: withSignals(`Recorded finding #${finding.id} (${finding.severity}). Screenshot: ${shot.file}.`),
        }
      }

      case "finish":
        finished = true
        summary = String(input.summary ?? "")
        verdict = input.verdict === "fail" ? "fail" : "pass"
        return { type: "tool_result", tool_use_id: id, content: "Run ended." }

      default:
        return { type: "tool_result", tool_use_id: id, is_error: true, content: `unknown tool ${name}` }
    }
  }
}
