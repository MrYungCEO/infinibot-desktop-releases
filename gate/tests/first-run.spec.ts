/**
 * InfiniBot Desktop release gate: a brand-new user's whole first run, driven
 * through the PACKAGED app (installed exe / AppImage) with Playwright's
 * Electron support, on a machine with no Node on PATH.
 *
 * Every area is a recorded check (out/results.json + out/summary.md, screenshots
 * in out/shots). A failing area doesn't stop the walk, so one run reports
 * everything that's broken; the test fails if any check failed.
 *
 * Env:
 *   IB_GATE_APP              installed InfiniBot.exe / AppImage (or a wine wrapper)
 *   IB_GATE_APP_ARGS         extra app args (default --disable-gpu on Linux/Xvfb)
 *   IB_GATE_PLATFORM         windows | linux | wine (labels only)
 *   IB_GATE_EXPECT_VERSION   e.g. v2026.10.18: the app must report this version
 *   IB_GATE_BRAIN_CARDS      comma list of quick-option card ids to require
 *   IB_GATE_PROVIDERS        comma list of API-key providers that must be offered
 *   IB_GATE_<X>_KEY          optional real keys (OLLAMA_CLOUD, OPENAI, ANTHROPIC, OPENROUTER)
 *   IB_GATE_SKIP             comma list of check ids to skip (local pre-checks only)
 */
import { test, expect, _electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("out");
const SHOTS = path.join(OUT, "shots");
const FIXTURE_WAV = path.resolve("fixtures/known-quick-brown-fox.wav");
const FEED = "https://github.com/MrYungCEO/infinibot-desktop-releases/releases/latest/download";
const PLATFORM = process.env.IB_GATE_PLATFORM || process.platform;
const SKIP = new Set((process.env.IB_GATE_SKIP || "").split(",").map((s) => s.trim()).filter(Boolean));

const BRAIN_CARDS = (process.env.IB_GATE_BRAIN_CARDS || "gemini-cli,codex-cli,claude-cli,grok-cli").split(",");
const CODER_ID: Record<string, string> = {
  "codex-cli": "codex",
  "grok-cli": "grok-build",
  "gemini-cli": "gemini",
  "claude-cli": "claude-code",
  "opencode-cli": "opencode",
};
const PROVIDERS = (process.env.IB_GATE_PROVIDERS || "Ollama Cloud,OpenAI,Anthropic,OpenRouter,Google,Groq").split(",");
const PROVIDER_KEYS: Record<string, string | undefined> = {
  "Ollama Cloud": process.env.IB_GATE_OLLAMA_CLOUD_KEY,
  OpenAI: process.env.IB_GATE_OPENAI_KEY,
  Anthropic: process.env.IB_GATE_ANTHROPIC_KEY,
  OpenRouter: process.env.IB_GATE_OPENROUTER_KEY,
};

type Status = "pass" | "fail" | "skip";
type Check = { id: string; title: string; status: Status; detail: string; ms: number; shots: string[] };
const checks: Check[] = [];
const facts: Record<string, unknown> = { platform: PLATFORM, startedAt: new Date().toISOString() };
const inAppWindows: Array<{ url: string; at: number }> = [];
let shotN = 0;

fs.mkdirSync(SHOTS, { recursive: true });

class Skip extends Error {}

async function shot(page: Page | undefined, name: string, into?: string[]) {
  if (!page || page.isClosed()) return;
  const file = path.join(SHOTS, `${String(++shotN).padStart(2, "0")}-${name}.png`);
  try {
    await page.screenshot({ path: file, timeout: 20_000 });
    into?.push(path.relative(OUT, file));
  } catch {
    /* page busy/closed: no shot */
  }
}

/** Run one area; never throws. Returns the status. */
async function check(page: Page | undefined, id: string, title: string, fn: (shots: string[]) => Promise<string | void>) {
  const t0 = Date.now();
  const shots: string[] = [];
  let status: Status = "pass";
  let detail = "";
  if (SKIP.has(id)) {
    status = "skip";
    detail = "skipped by IB_GATE_SKIP";
  } else {
    try {
      detail = (await fn(shots)) || "";
    } catch (e) {
      status = e instanceof Skip ? "skip" : "fail";
      detail = String((e as Error)?.message || e).split("\n").slice(0, 12).join("\n");
    }
  }
  await shot(page, `${id}-${status}`, shots);
  const c = { id, title, status, detail, ms: Date.now() - t0, shots };
  checks.push(c);
  console.log(`[gate] ${status.toUpperCase().padEnd(4)} ${id} — ${detail.split("\n")[0]}`);
  writeResults();
  return status;
}

function writeResults() {
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ ...facts, inAppWindows, checks }, null, 2));
  const icon = { pass: "✅", fail: "❌", skip: "⏭️" };
  const rows = checks.map((c) => `| ${icon[c.status]} | \`${c.id}\` | ${c.title} | ${c.detail.replace(/\|/g, "\\|").replace(/\n/g, "<br>").slice(0, 600)} |`);
  const failed = checks.filter((c) => c.status === "fail").length;
  fs.writeFileSync(
    path.join(OUT, "summary.md"),
    [
      `## Release gate — ${PLATFORM} — InfiniBot ${facts.appVersion ?? "?"}`,
      "",
      failed ? `**${failed} check(s) FAILED**` : "**All checks passed**",
      "",
      "| | id | check | detail |",
      "|---|---|---|---|",
      ...rows,
      "",
    ].join("\n"),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs: number, stepMs = 1500): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    await sleep(stepMs);
  }
  return undefined;
}

async function visible(page: Page, sel: string) {
  return page.locator(sel).first().isVisible().catch(() => false);
}

async function rpc<T = any>(page: Page, method: string, params: unknown = {}, timeoutMs = 30_000): Promise<T> {
  return page.evaluate(
    async ([m, p, t]) => {
      const c = (window as any).__infinibotGatewayClient ?? (document.querySelector("infinibot-app") as any)?.client;
      if (!c) throw new Error("no gateway client on window");
      return c.request(m, p, { timeoutMs: t });
    },
    [method, params, timeoutMs] as const,
  );
}

async function externalCalls(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => ((globalThis as any).__gate?.external ?? []).map((x: any) => x.url));
}

/** Watch for an external-browser handoff (or a wrong in-app window) after `act`. */
async function expectExternalHandoff(app: ElectronApplication, act: () => Promise<void>, waitMs = 20_000) {
  const ext0 = (await externalCalls(app)).length;
  const win0 = inAppWindows.length;
  await act();
  const got = await until(async () => {
    const ext = await externalCalls(app);
    if (ext.length > ext0) return { external: ext.slice(ext0) };
    if (inAppWindows.length > win0) return { inApp: inAppWindows.slice(win0).map((w) => w.url) };
    return null;
  }, waitMs, 500);
  await sleep(1500); // a late in-app window would still count
  const inApp = inAppWindows.slice(win0).map((w) => w.url);
  const external = (await externalCalls(app)).slice(ext0);
  return { external, inApp, timedOut: !got };
}

let app: ElectronApplication;
let page: Page;
let mainLog = "";

test.afterAll(async () => {
  fs.writeFileSync(path.join(OUT, "electron-main.log"), mainLog);
  // Copy the gateway / voice logs out of the state dir.
  const stateDir = facts.stateDir as string | undefined;
  if (stateDir) {
    for (const sub of ["logs", path.join("voice")]) {
      const src = path.join(stateDir, sub);
      try {
        fs.cpSync(src, path.join(OUT, "state", sub), {
          recursive: true,
          filter: (s) => fs.statSync(s).isDirectory() || /\.(log|json|txt|jsonl)$/.test(s),
        });
      } catch {
        /* missing */
      }
    }
    for (const f of ["coders", "coders.json"]) {
      try {
        fs.cpSync(path.join(stateDir, f), path.join(OUT, "state", f), {
          recursive: true,
          filter: (s) => fs.statSync(s).isDirectory() || /\.(log|json|txt)$/.test(s),
        });
      } catch {
        /* missing */
      }
    }
  }
  writeResults();
  try {
    await Promise.race([app?.evaluate(({ app: a }) => a.quit()), sleep(5000)]);
  } catch {
    /* already gone */
  }
  await Promise.race([app?.close().catch(() => {}), sleep(10_000)]);
});

test("brand-new user: install → onboarding → brains → voice → chat → update → links", async () => {
  const args = (process.env.IB_GATE_APP_ARGS ?? (process.platform === "linux" ? "--disable-gpu" : "")).split(" ").filter(Boolean);
  app = await _electron.launch({ executablePath: process.env.IB_GATE_APP!, args, env: { ...process.env } as Record<string, string>, timeout: 180_000 });
  app.process().stdout?.on("data", (d) => (mainLog += d));
  app.process().stderr?.on("data", (d) => (mainLog += d));

  // Record every openExternal call (and don't actually launch a browser), and
  // every extra in-app window: a sign-in or link that opens INSIDE the app is
  // the bug class this gate exists for.
  await app.evaluate(({ shell }) => {
    const g = globalThis as any;
    g.__gate = { external: [] as Array<{ url: string; at: number }> };
    (shell as any).openExternal = async (url: string) => {
      g.__gate.external.push({ url, at: Date.now() });
    };
  });
  page = await app.firstWindow();
  app.on("window", (p) => {
    if (p === page) return;
    void (async () => {
      await p.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
      inAppWindows.push({ url: p.url(), at: Date.now() });
      console.log(`[gate] in-app window opened: ${p.url()}`);
      await shot(p, "in-app-window");
      await p.close().catch(() => {});
    })();
  });
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900);
  });
  facts.appVersion = await app.evaluate(({ app: a }) => a.getVersion());

  // ── 1. First-run screen ────────────────────────────────────────────────
  await check(page, "first-run", "First launch shows the welcome screen and starts InfiniBot", async () => {
    const want = (process.env.IB_GATE_EXPECT_VERSION || "").replace(/^v/, "");
    if (want && facts.appVersion !== want) throw new Error(`app reports ${facts.appVersion}, expected ${want}`);
    await expect(page.locator("#fr-go")).toBeVisible({ timeout: 60_000 });
    facts.stateDir = (await page.locator("#fr-dir").textContent())?.trim();
    await shot(page, "welcome");
    await page.locator("#fr-go").click();
    const t0 = Date.now();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 15 * 60_000 }).catch(async (e) => {
      const err = await page.locator("#fr-error").textContent().catch(() => "");
      const log = await page.locator("#fr-log").textContent().catch(() => "");
      throw new Error(`gateway UI never opened: ${err || e.message}\n${(log || "").slice(-1500)}`);
    });
    facts.gatewayUrl = new URL(page.url()).origin;
    return `v${facts.appVersion}, state ${facts.stateDir}, gateway ${facts.gatewayUrl} up in ${Math.round((Date.now() - t0) / 1000)} s`;
  });
  if (!facts.gatewayUrl) return finish();

  // ── 2. Onboarding opens; pick use cases ────────────────────────────────
  await check(page, "onboarding-opens", "Onboarding opens by itself; use-case step works", async () => {
    await expect(page.locator('[data-testid="onboarding-flow"]')).toBeVisible({ timeout: 120_000 });
    await page.locator('[data-testid="onb-uc-coding"]').click();
    await page.locator('[data-testid="onb-uc-assistant"]').click();
    await shot(page, "usecases");
    await page.locator('[data-testid="onb-next"]').click();
    await expect(page.locator('[data-testid^="onb-brain-card-"]:not(.is-skeleton)').first()).toBeVisible({ timeout: 90_000 });
    const cards = await page.locator('[data-testid^="onb-brain-card-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("onb-brain-card-", "")));
    facts.brainCards = cards;
    return `brain cards: ${cards.join(", ")}`;
  });

  // ── 3. Every AI-brain quick option: installed + sign-in URL via the system browser
  const signIn: Record<string, unknown> = {};
  facts.signIn = signIn;
  for (const id of BRAIN_CARDS) {
    await check(page, `brain-${id}`, `AI brain quick option "${id}": installs, then hands sign-in to the system browser`, async () => {
      await backToBrainCards(page);
      const card = page.locator(`[data-testid="onb-brain-card-${id}"]`);
      if (!(await card.isVisible().catch(() => false))) throw new Error(`card onb-brain-card-${id} not offered (cards: ${(facts.brainCards as string[] | undefined)?.join(", ")})`);
      const title = (await card.locator(".sob-opt__title").textContent())?.trim();
      // Clicking the card IS the action; the sign-in may open by itself right
      // after the install, so watch for handoffs from here on.
      const ext0 = (await externalCalls(app)).length;
      const win0 = inAppWindows.length;
      await card.click();
      await expect(page.locator('[data-testid="onb-cli-setup"]')).toBeVisible({ timeout: 30_000 });
      const install = page.locator('[data-testid="onb-cli-step-install"]');
      const t0 = Date.now();
      const state = await until(async () => {
        const s = await install.getAttribute("data-state");
        if (s === "done" || s === "skipped" || s === "error") return s;
        if (await visible(page, '[data-testid="onb-cli-error"]')) return "error";
        return null;
      }, 12 * 60_000, 2000);
      const installSecs = Math.round((Date.now() - t0) / 1000);
      await shot(page, `brain-${id}-install-${state ?? "timeout"}`);
      if (state !== "done" && state !== "skipped") {
        const msg = (await page.locator('[data-testid="onb-cli-error"]').textContent().catch(() => ""))?.replace(/\s+/g, " ").trim();
        const job = await rpc(page, "coders.status", { id: CODER_ID[id] ?? id }).catch((e) => ({ rpcError: String(e) }));
        const jobLog = JSON.stringify((job as any)?.coder?.job ?? job).slice(0, 1500);
        signIn[id] = { title, install: state ?? "timeout", error: msg, job: (job as any)?.coder?.job };
        throw new Error(`install ${state ?? "timed out"} after ${installSecs} s: ${msg || "(no message)"}\njob: ${jobLog}`);
      }
      // Sign-in: produce the URL and hand it to the system browser.
      const end = Date.now() + 90_000;
      let clicked = 0;
      while (Date.now() < end) {
        const ext = (await externalCalls(app)).slice(ext0);
        if (ext.length || inAppWindows.length > win0) break;
        const btn = page.locator('[data-testid="onb-cli-primary"]');
        const label = ((await btn.textContent().catch(() => "")) || "").trim();
        if (/sign-in window|sign in/i.test(label) && (await btn.isEnabled().catch(() => false)) && clicked < 2) {
          clicked++;
          await btn.click().catch(() => {});
        }
        if (await visible(page, '[data-testid="onb-cli-error"]')) break;
        await sleep(1000);
      }
      await sleep(2000);
      const external = (await externalCalls(app)).slice(ext0);
      const inApp = inAppWindows.slice(win0).map((w) => w.url);
      const code = (await page.locator('[data-testid="onb-cli-user-code"]').textContent().catch(() => null))?.trim();
      const err = (await page.locator('[data-testid="onb-cli-error"]').textContent().catch(() => ""))?.replace(/\s+/g, " ").trim();
      const steps = await page.locator('[data-testid^="onb-cli-step-"]').evaluateAll((els) => els.map((e) => `${e.getAttribute("data-testid")!.replace("onb-cli-step-", "")}=${e.getAttribute("data-state")}`));
      signIn[id] = { title, install: state, installSecs, external, inApp, code, steps, error: err };
      await shot(page, `brain-${id}-signin`);
      if (inApp.length) throw new Error(`installed (${state}, ${installSecs} s) but sign-in opened INSIDE the app, not the system browser: ${inApp.join(" ")}`);
      if (!external.length) throw new Error(`installed (${state}, ${installSecs} s) but no sign-in URL reached the system browser. steps: ${steps.join(" ")} ${err ? `error: ${err}` : ""}`);
      if (!external.some((u) => /^https:\/\//.test(u))) throw new Error(`openExternal got a non-https URL: ${external.join(" ")}`);
      return `installed (${state}, ${installSecs} s); sign-in via system browser: ${external.join(" ")}${code ? ` code ${code}` : ""}`;
    });
  }
  await backToBrainCards(page).catch(() => {});

  // ── 4. API-key providers incl. Ollama Cloud, each with a model picker ──
  let brainSaved = "";
  await check(page, "providers-list", `API-key providers offered (${PROVIDERS.join(", ")})`, async () => {
    await openApiKeyPanel(page);
    const offered = await page.locator(".iob-prov .sob-opt__title").allTextContents();
    facts.providersOffered = offered.map((s) => s.trim());
    await shot(page, "providers");
    const missing = PROVIDERS.filter((p) => !offered.some((o) => o.trim().toLowerCase() === p.toLowerCase()));
    if (missing.length) throw new Error(`missing: ${missing.join(", ")} (offered: ${offered.join(", ")})`);
    return `offered: ${offered.join(", ")}`;
  });
  for (const name of PROVIDERS) {
    await check(page, `provider-${slug(name)}`, `${name}: key field + model picker`, async () => {
      await openApiKeyPanel(page);
      const card = page.locator(".iob-prov", { has: page.locator(".sob-opt__title", { hasText: new RegExp(`^\\s*${escapeRe(name)}\\s*$`, "i") }) });
      if (!(await card.first().isVisible().catch(() => false))) throw new Error(`${name} is not in the provider list`);
      await card.first().click();
      await expect(page.locator('[data-testid="onb-api-key"]')).toBeVisible();
      const model = page.locator(".sob-field", { hasText: "Model" }).locator("select, input");
      await expect(model.first()).toBeVisible();
      const key = PROVIDER_KEYS[name];
      if (!key) {
        return `key field + model field present; live key test SKIPPED (no IB_GATE_${slug(name).toUpperCase().replace(/-/g, "_")}_KEY secret)`;
      }
      await page.locator('[data-testid="onb-api-key"]').fill(key);
      await page.getByRole("button", { name: "Check key" }).click();
      const sel = page.locator(".sob-field", { hasText: "Model" }).locator("select");
      await expect(sel).toBeVisible({ timeout: 60_000 });
      const n = await sel.locator("option").count();
      if (n < 1) throw new Error("model picker is empty");
      if (!brainSaved) {
        await page.getByRole("button", { name: "Save key" }).click();
        await sleep(4000);
        brainSaved = name;
      }
      return `key accepted, ${n} models in the picker${brainSaved === name ? " (saved as the brain)" : ""}`;
    });
  }

  // ── 5. Advance to voice ─────────────────────────────────────────────────
  await check(page, "to-voice", "Continue through Channels to Voice", async () => {
    await advanceUntil(page, async () => (await visible(page, '[data-testid="onb-voice-later"]')) || (await visible(page, "ib-local-voice-setup")), 6);
    return "voice step reached";
  });

  // ── 6. Voice: one-click local voice, then real TTS + STT through the native engine
  await check(page, "voice-setup", "Voice setup finishes (built-in engine)", async () => {
    if (!(await visible(page, '[data-testid="local-voice-setup"]'))) {
      await page.locator('[data-testid="onb-voice-local"]').first().click();
    }
    const root = page.locator('[data-testid="local-voice-setup"]');
    await expect(root).toBeVisible({ timeout: 30_000 });
    const t0 = Date.now();
    let started = false;
    const final = await until(async () => {
      const card = await root.getAttribute("data-card");
      if (card === "intro" && !started) {
        started = true;
        await page.locator('[data-testid="lvs-start"]').click();
      } else if (card === "needs-docker" || card === "needs-permission" || card === "needs-sudo") {
        if (await visible(page, '[data-testid="lvs-use-native"]')) await page.locator('[data-testid="lvs-use-native"]').click();
        else return card;
      } else if (card === "done" || card === "failed" || card === "unsupported") {
        return card;
      }
      return null;
    }, 25 * 60_000, 3000);
    const log = (await page.locator('[data-testid="lvs-log"]').textContent().catch(() => ""))?.trim();
    const headline = (await page.locator('[data-testid="lvs-headline"]').textContent().catch(() => ""))?.trim();
    facts.voiceSetup = { final, secs: Math.round((Date.now() - t0) / 1000), headline, log: log?.slice(-3000) };
    const st = await rpc(page, "voice.local.status", {}).catch((e) => ({ rpcError: String(e) }));
    facts.voiceStatus = st;
    if (final !== "done") throw new Error(`voice setup ended "${final ?? "timeout"}": ${headline || ""}\n${(log || "").slice(-1200)}`);
    return `voice ready in ${Math.round((Date.now() - t0) / 1000)} s`;
  });

  await check(page, "voice-engine", "Native voice engine loads; real TTS synth + STT of a known WAV", async () => {
    const base = await engineUrl(page);
    facts.voiceEngineUrl = base;
    const health = await until(async () => {
      const r = await fetch(`${base}/health`).catch(() => null);
      if (!r) return null;
      const j: any = await r.json().catch(() => ({}));
      if (j.status === "ok" || j.status === "error") return j;
      return null;
    }, 6 * 60_000, 3000);
    facts.voiceHealth = health;
    if (!health) throw new Error(`engine at ${base} never became healthy`);
    if (health.status !== "ok") throw new Error(`engine failed to load: ${health.error ?? JSON.stringify(health)}`);
    const backend = `tts=${health.tts ?? "?"} stt=${health.stt ?? "?"} sttModel=${health.sttModel ?? "?"} sttDevice=${health.sttDevice ?? "?"}`;
    // TTS
    const t0 = Date.now();
    const sr = await fetch(`${base}/v1/audio/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "InfiniBot release gate. Testing one two three.", response_format: "wav" }),
    });
    const wav = Buffer.from(await sr.arrayBuffer());
    if (!sr.ok || wav.length < 8000 || wav.subarray(0, 4).toString() !== "RIFF") throw new Error(`TTS failed: HTTP ${sr.status} ${wav.subarray(0, 300).toString()}`);
    fs.writeFileSync(path.join(OUT, "tts.wav"), wav);
    const ttsMs = Date.now() - t0;
    // STT of the known WAV
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(FIXTURE_WAV)], { type: "audio/wav" }), "known.wav");
    fd.append("response_format", "json");
    const t1 = Date.now();
    const tr = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", body: fd });
    const tj: any = await tr.json().catch(async () => ({ text: "", raw: await tr.text().catch(() => "") }));
    const text = String(tj.text ?? "").toLowerCase();
    facts.voiceStt = { text: tj.text, ms: Date.now() - t1 };
    const hits = ["quick", "brown", "fox", "lazy", "dog"].filter((w) => text.includes(w));
    if (!tr.ok || hits.length < 3) throw new Error(`STT wrong: HTTP ${tr.status} "${tj.text ?? JSON.stringify(tj)}" (${backend})`);
    return `${backend}; TTS ${wav.length} B in ${ttsMs} ms; STT "${tj.text}" in ${Date.now() - t1} ms`;
  });

  // ── 7. Finish onboarding → first chat ───────────────────────────────────
  await check(page, "finish-onboarding", "Phone / Privacy / Plan / Finish", async () => {
    await advanceUntil(page, async () => visible(page, '[data-testid="onb-finish"]'), 8);
    await page.locator('[data-testid="onb-finish"]').click();
    await expect(page.locator('[data-testid="onb-done"]')).toBeVisible({ timeout: 60_000 });
    await shot(page, "done");
    if (await visible(page, '[data-testid="onb-start-course"]')) await page.locator('[data-testid="onb-start-course"]').click().catch(() => {});
    return "finished";
  });

  await check(page, "first-chat", "First chat message gets an answer (or a clear next step)", async () => {
    const input = page.locator("textarea.wc-input");
    if (!(await input.isVisible({ timeout: 20_000 }).catch(() => false))) {
      await page.goto(`${facts.gatewayUrl}/webchat`);
    }
    await expect(input).toBeVisible({ timeout: 60_000 });
    await expect(input).toBeEnabled({ timeout: 60_000 });
    await input.fill("Reply with exactly two words: GATE OK");
    await page.locator("button.wc-send").click();
    const got = await until(async () => {
      const asst = (await page.locator(".wc-asst .wc-md").last().textContent().catch(() => ""))?.trim();
      const streaming = await visible(page, ".wc-caret");
      if (asst && !streaming) return { kind: "reply", text: asst };
      const err = (await page.locator(".wc-error").last().textContent().catch(() => ""))?.trim();
      if (err && (await visible(page, ".wc-error"))) return { kind: "error", text: err };
      if (await visible(page, "ib-chat-subscription-card")) return { kind: "card", text: (await page.locator("ib-chat-subscription-card").first().innerText().catch(() => "")).trim() };
      return null;
    }, 180_000, 2000);
    facts.firstChat = got;
    if (!got) throw new Error("no reply, error or next-step card within 3 min");
    if (brainSaved && got.kind !== "reply") throw new Error(`brain ${brainSaved} saved but chat failed: ${got.text}`);
    if (got.kind === "error" && /unknown model|stack|undefined|\bat [\w.]+ \(/i.test(got.text)) throw new Error(`raw error shown to a new user: ${got.text}`);
    return `${got.kind}: ${got.text.slice(0, 300)}${brainSaved ? "" : " (no brain configured in CI: no provider key secret and no signed-in subscription)"}`;
  });

  // ── 8. Update widget shows the DESKTOP feed version ────────────────────
  await check(page, "update-widget", "Sidebar update widget follows the desktop release feed", async () => {
    const yml = await fetch(`${FEED}/${PLATFORM === "linux" ? "latest-linux.yml" : "latest.yml"}`).then((r) => r.text());
    const feedVersion = /^version:\s*(\S+)/m.exec(yml)?.[1];
    facts.feedVersion = feedVersion;
    if (!(await visible(page, ".sidebar-upd-desktop"))) {
      const t = page.locator("button.nav-footer-toggle").first();
      if (await t.isVisible().catch(() => false)) await t.click();
    }
    const text = await until(async () => {
      const el = page.locator(".sidebar-upd-desktop .sidebar-upd-text").first();
      if (!(await el.isVisible().catch(() => false))) return null;
      const s = ((await el.textContent()) || "").trim();
      return s && !/checking/i.test(s) ? s : null;
    }, 90_000, 2000);
    if (!text) {
      const any = (await page.locator(".sidebar-upd").allInnerTexts().catch(() => [])).join(" | ");
      throw new Error(`no desktop update widget (.sidebar-upd-desktop); sidebar update area shows: "${any || "nothing"}" (feed v${feedVersion}, app v${facts.appVersion})`);
    }
    facts.updateWidget = text;
    if (/failed/i.test(text)) throw new Error(`widget: "${text}"`);
    const ok = text.includes(String(facts.appVersion)) || (feedVersion && text.includes(feedVersion));
    if (!ok) throw new Error(`widget "${text}" shows neither the app version v${facts.appVersion} nor the desktop feed v${feedVersion}`);
    return `"${text}" (app v${facts.appVersion}, feed v${feedVersion})`;
  });

  // ── 9. External links go to the system browser ─────────────────────────
  await check(page, "external-links", "External links open in the system browser (openExternal), never in-app", async () => {
    const results: string[] = [];
    const bad: string[] = [];
    // a) window.open from the control UI (what every target=_blank / sign-in path does)
    const a = await expectExternalHandoff(app, async () => {
      await page.evaluate(() => void window.open("https://infinibotos.com/docs", "_blank"));
    });
    results.push(`window.open → external ${a.external.length}, in-app ${a.inApp.length}`);
    if (a.inApp.length || !a.external.length) bad.push(`window.open("https://infinibotos.com/docs") → ${a.inApp.length ? `in-app window ${a.inApp.join(" ")}` : "nothing"}`);
    // b) a real target=_blank link in the UI
    const href = await page.evaluate(() => {
      const walk = (root: Document | ShadowRoot): HTMLAnchorElement | null => {
        for (const el of Array.from(root.querySelectorAll("*"))) {
          if (el instanceof HTMLAnchorElement && el.target === "_blank" && /^https?:\/\/(?!127\.0\.0\.1|localhost)/.test(el.href) && el.offsetParent) return el;
          if ((el as HTMLElement).shadowRoot) {
            const f = walk((el as HTMLElement).shadowRoot!);
            if (f) return f;
          }
        }
        return null;
      };
      const l = walk(document);
      if (!l) return null;
      l.setAttribute("data-gate-link", "1");
      return l.href;
    });
    if (href) {
      const b = await expectExternalHandoff(app, async () => {
        await page.locator('[data-gate-link="1"]').first().click({ timeout: 10_000 });
      });
      results.push(`link ${href} → external ${b.external.length}, in-app ${b.inApp.length}`);
      if (b.inApp.length || !b.external.length) bad.push(`link ${href} → ${b.inApp.length ? `in-app window` : "nothing"}`);
    } else results.push("no visible target=_blank link on this page");
    // c) Help menu
    const help = await app.evaluate(({ Menu }) => {
      const m = Menu.getApplicationMenu();
      const helpMenu = m?.items.find((i) => /help/i.test(i.label));
      const item = helpMenu?.submenu?.items.find((i) => /doc|website|github|support|learn/i.test(i.label));
      if (!item) return null;
      (item as any).click();
      return item.label;
    }).catch(() => null);
    if (help) {
      await sleep(3000);
      results.push(`Help › ${help} → openExternal total ${(await externalCalls(app)).length}`);
    }
    results.push(`all openExternal: ${(await externalCalls(app)).join(" ")}`);
    if (bad.length) throw new Error(bad.join("\n") + "\n" + results.join("\n"));
    return results.join("\n");
  });

  finish();
});

function finish() {
  facts.finishedAt = new Date().toISOString();
  writeResults();
  const failed = checks.filter((c) => c.status === "fail");
  expect(failed.map((c) => `${c.id}: ${c.detail.split("\n")[0]}`), "release gate checks").toEqual([]);
}

async function backToBrainCards(p: Page) {
  if (await visible(p, '[data-testid^="onb-brain-card-"]')) return;
  if (await visible(p, '[data-testid="onb-cli-back"]')) {
    await p.locator('[data-testid="onb-cli-back"]').click();
  } else {
    // Error/working state without "Choose another": reload; progress is saved.
    await p.reload();
  }
  await until(async () => visible(p, '[data-testid^="onb-brain-card-"]'), 60_000, 1000);
  if (!(await visible(p, '[data-testid^="onb-brain-card-"]'))) {
    // Reloaded onto another step: use the rail.
    await p.locator('.sob-node[aria-label^="Step 2"]').first().click().catch(() => {});
    await until(async () => visible(p, '[data-testid^="onb-brain-card-"]'), 30_000, 1000);
  }
}

async function openApiKeyPanel(p: Page) {
  if (await visible(p, '[data-testid="onb-api-key"]')) return;
  await backToBrainCards(p);
  if (!(await visible(p, '[data-testid="onb-brain-apikey"]'))) await p.locator('[data-testid="onb-brain-more"]').click();
  await p.locator('[data-testid="onb-brain-apikey"]').click();
  await expect(p.locator('[data-testid="onb-api-key"]')).toBeVisible({ timeout: 15_000 });
}

async function advanceUntil(p: Page, done: () => Promise<boolean>, max: number) {
  for (let i = 0; i < max; i++) {
    if (await done()) return;
    const next = p.locator('[data-testid="onb-next"]');
    if ((await next.isVisible().catch(() => false)) && (await next.isEnabled().catch(() => false))) await next.click();
    else if (await visible(p, '[data-testid="onb-skip"]')) await p.locator('[data-testid="onb-skip"]').click();
    else if (await visible(p, '[data-testid="onb-cli-continue"]')) await p.locator('[data-testid="onb-cli-continue"]').click();
    else if (await visible(p, '[data-testid="onb-cli-back"]')) await p.locator('[data-testid="onb-cli-back"]').click();
    await sleep(1500);
  }
  if (!(await done())) throw new Error(`target step not reached after ${max} steps`);
}

async function engineUrl(p: Page): Promise<string> {
  const st: any = await rpc(p, "voice.local.status", {}).catch(() => null);
  const found = JSON.stringify(st ?? {}).match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/);
  return found?.[0] ?? "http://127.0.0.1:8886";
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}
function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
