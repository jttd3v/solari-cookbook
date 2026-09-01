/**
 * The agent's hands and eyes: a thin harness over a Solari cloud browser.
 *
 * Claude never sees raw HTML. It sees a compact page state (visible text plus a
 * numbered list of interactive elements) and acts by id. Every action also
 * returns the browser "signals" that fired since the last one — console
 * errors, uncaught exceptions, failed requests, HTTP 4xx/5xx — because those
 * are the bugs a human tester would miss while looking at the screen.
 */
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { BrowserSession } from "@solarisdk/browser"

// Playwright's Page type, without taking a dependency on patchright-core.
type Page = Awaited<ReturnType<BrowserSession["newPage"]>>

export type SignalKind = "console.error" | "console.warning" | "pageerror" | "requestfailed" | "http.error"

export interface Signal {
  step: number
  kind: SignalKind
  text: string
}

export interface Screenshot {
  file: string
  step: number
  note: string
}

interface PageItem {
  id: number
  tag: string
  type?: string
  role?: string
  label: string
  href?: string
  value?: string
  checked?: boolean
  disabled?: boolean
}

export class Harness {
  readonly signals: Signal[] = []
  readonly screenshots: Screenshot[] = []
  /** Current action number; the agent loop increments it. */
  step = 0
  private drained = 0

  constructor(
    readonly page: Page,
    readonly baseUrl: string,
    readonly outDir: string,
  ) {
    page.on("console", (m) => {
      const t = m.type()
      if (t === "error") this.push("console.error", m.text())
      else if (t === "warning") this.push("console.warning", m.text())
    })
    page.on("pageerror", (e) => this.push("pageerror", e.message))
    page.on("requestfailed", (r) =>
      this.push("requestfailed", `${r.method()} ${r.url()} — ${r.failure()?.errorText ?? "failed"}`),
    )
    page.on("response", (r) => {
      if (r.status() >= 400) this.push("http.error", `${r.request().method()} ${r.url()} → HTTP ${r.status()}`)
    })
  }

  private push(kind: SignalKind, text: string) {
    this.signals.push({ step: this.step, kind, text: text.slice(0, 400) })
  }

  /** Signals that fired since the last call. */
  drainSignals(): Signal[] {
    const fresh = this.signals.slice(this.drained)
    this.drained = this.signals.length
    return fresh
  }

  // ---- actions ------------------------------------------------------------

  async navigate(url: string): Promise<string> {
    const target = new URL(url, this.baseUrl).toString()
    await this.page.goto(target, { waitUntil: "domcontentloaded", timeout: 20_000 })
    await this.settle()
    return this.pageState()
  }

  async click(id: number): Promise<string> {
    await this.locator(id).click({ timeout: 8_000 })
    await this.settle()
    return this.pageState()
  }

  async type(id: number, text: string, submit: boolean): Promise<string> {
    const el = this.locator(id)
    await el.fill(text, { timeout: 8_000 })
    if (submit) await el.press("Enter")
    await this.settle()
    return this.pageState()
  }

  async press(key: string): Promise<string> {
    await this.page.keyboard.press(key)
    await this.settle()
    return this.pageState()
  }

  async screenshot(note: string): Promise<{ file: string; base64: string }> {
    const bytes = await this.page.screenshot({ type: "jpeg", quality: 60 })
    const slug = note.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40) || "shot"
    const file = `screenshots/step-${String(this.step).padStart(2, "0")}-${slug}.jpg`
    await mkdir(join(this.outDir, "screenshots"), { recursive: true })
    await writeFile(join(this.outDir, file), bytes)
    this.screenshots.push({ file, step: this.step, note })
    return { file, base64: Buffer.from(bytes).toString("base64") }
  }

  // ---- perception ---------------------------------------------------------

  /**
   * Tag every visible interactive element with data-pf="N" and return a
   * compact, LLM-friendly description of the page. Ids are re-assigned on
   * every call, so the agent must act on the ids from its latest state.
   */
  async pageState(): Promise<string> {
    // NOTE: no named inner functions in here. tsx/esbuild wraps them in a
    // `__name(...)` helper that does not exist inside the page, and evaluate
    // then throws "ReferenceError: __name is not defined".
    const { text, items } = await this.page.evaluate(() => {
      const selector =
        'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], ' +
        '[role="checkbox"], [role="tab"], [role="menuitem"], [role="switch"], [contenteditable="true"]'
      document.querySelectorAll("[data-pf]").forEach((el) => el.removeAttribute("data-pf"))

      const els = Array.from(document.querySelectorAll(selector))
        .filter((el) => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"
        })
        .slice(0, 80)
      const items = els.map((el, i) => {
        el.setAttribute("data-pf", String(i + 1))
        const e = el as HTMLInputElement
        const isButton = el.tagName === "BUTTON" || e.type === "submit" || e.type === "button"
        const labelSrc =
          e.getAttribute("aria-label") ||
          (e.labels && e.labels[0]?.textContent) ||
          e.placeholder ||
          e.textContent ||
          (isButton ? e.value : "") ||
          e.title ||
          ""
        return {
          id: i + 1,
          tag: el.tagName.toLowerCase(),
          type: e.type || undefined,
          role: el.getAttribute("role") || undefined,
          label: labelSrc.trim().replace(/\s+/g, " ").slice(0, 80),
          href: (el as unknown as HTMLAnchorElement).href || undefined,
          value:
            !isButton && e.type !== "checkbox" && e.type !== "radio" && typeof e.value === "string"
              ? e.value.slice(0, 80)
              : undefined,
          checked: e.type === "checkbox" || e.type === "radio" ? e.checked : undefined,
          disabled: e.disabled || undefined,
        }
      })
      const text = (document.body?.innerText ?? "")
        .replace(/[ \t]+/g, " ")
        .replace(/\s*\n\s*/g, "\n")
        .trim()
        .slice(0, 4000)
      return { text, items }
    })

    const lines = [
      `URL: ${this.page.url()}`,
      `Title: ${await this.page.title()}`,
      "",
      "--- visible text ---",
      text || "(empty)",
      "",
      "--- interactive elements (act on these by id) ---",
      ...(items as PageItem[]).map(describe),
    ]
    return lines.join("\n")
  }

  private locator(id: number) {
    if (!Number.isInteger(id) || id < 1) throw new Error(`invalid element id ${id}`)
    return this.page.locator(`[data-pf="${id}"]`).first()
  }

  /** Let the page react: same-document JS, fetches, small re-renders. */
  private async settle() {
    await this.page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {})
    await this.page.waitForTimeout(700)
  }
}

function describe(it: PageItem): string {
  const kind = it.tag === "input" ? `input(${it.type ?? "text"})` : it.role ? `${it.tag}[${it.role}]` : it.tag
  const bits = [`[${it.id}] ${kind} "${it.label}"`]
  if (it.value !== undefined && it.value !== "") bits.push(`value="${it.value}"`)
  if (it.checked !== undefined) bits.push(`checked=${it.checked}`)
  if (it.href) bits.push(`href=${it.href}`)
  if (it.disabled) bits.push("disabled")
  return bits.join(" ")
}

export function formatSignals(signals: Signal[]): string {
  if (signals.length === 0) return "Browser signals since last action: none."
  return [
    `Browser signals since last action (${signals.length}):`,
    ...signals.map((s) => `  • ${s.kind}: ${s.text}`),
  ].join("\n")
}
