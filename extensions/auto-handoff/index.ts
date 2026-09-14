/**
 * auto-handoff: when context grows past a threshold, automatically continue
 * in a fresh session that points back at this one via `parentSession`.
 *
 * The new session's agent recovers prior context with one command that prints
 * the previous session's dialogue (`session-tail.py` in this folder), instead
 * of inheriting a bloated conversation — zero summarization cost, zero loss.
 *
 * Commands:
 *   /handoff           - hand off now, regardless of context size
 *   /handoff-threshold [kTokens|off|on]
 *                      - show / set threshold in kilo-tokens, e.g. 100 = 100k
 *                        (persisted to
 *                        ~/.pi/agent/auto-handoff.json; "off" disables,
 *                        "on" re-enables at the last threshold)
 *
 * Why the auto path goes through a command: `ctx.newSession()` only exists on
 * the command context (`createCommandContext()`), NOT on the event context
 * (`createContext()`) that `agent_settled` receives. So the event handler
 * re-enters via `pi.sendUserMessage("/handoff", { expandPromptTemplates: true })`,
 * which makes pi dispatch the registered command through the proper context.
 *
 * Config file: ~/.pi/agent/auto-handoff.json
 *   { "threshold": 100000, "enabled": true }
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "auto-handoff.json");
const DEFAULT_THRESHOLD = 100_000;
const TARGET_TYPE = "auto-handoff-target";

/** Fallback in case import.meta.url is unavailable in the bundled runtime. */
const EXTENSION_DIR = (() => {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return join(homedir(), ".pi", "agent", "extensions", "auto-handoff");
  }
})();
const TEMPLATE_PATH = join(EXTENSION_DIR, "kickoff.template.md");
const SCRIPT_PATH = join(EXTENSION_DIR, "session-tail.py");

/** Short stand-in if the template file cannot be read. */
const FALLBACK_KICKOFF = `Continue the work from a previous session whose context grew too large.
Its transcript is: {{SESSION_FILE}}

Recover the state in one command — it prints every user message in full and
assistant replies truncated, each with an \`rg\` command to read it whole:

    python3 "{{SCRIPT}}" "{{SESSION_FILE}}"

Read that output and continue the work. If the dump is larger than you need,
re-run with \`--turns 20\`. If the next step is still ambiguous, ask the user
instead of guessing.`;

interface Config {
  threshold: number;
  enabled: boolean;
}

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
      return {
        threshold: typeof raw.threshold === "number" && raw.threshold > 0 ? raw.threshold : DEFAULT_THRESHOLD,
        enabled: raw.enabled !== false,
      };
    }
  } catch {
    // fall through to defaults
  }
  return { threshold: DEFAULT_THRESHOLD, enabled: true };
}

function saveConfig(cfg: Config) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
  } catch {
    // non-fatal
  }
}

/** Read the template fresh at handoff time so edits need no reload. */
function kickoffText(parentFile: string): string {
  let template = FALLBACK_KICKOFF;
  try {
    template = readFileSync(TEMPLATE_PATH, "utf8");
  } catch {
    // keep fallback
  }
  return template.replaceAll("{{SESSION_FILE}}", parentFile).replaceAll("{{SCRIPT}}", SCRIPT_PATH);
}

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();
  let handingOff = false;
  let attempted = false; // only auto-handoff once per session

  /** True when this session was itself created by auto-handoff (marker in its entries). */
  function isHandoffTarget(ctx: ExtensionContext): boolean {
    try {
      return ctx.sessionManager
        .getEntries()
        .some((e) => e.type === "custom" && e.customType === TARGET_TYPE);
    } catch {
      return false;
    }
  }

  /** Runs inside a command handler, where ctx.newSession() exists. */
  async function doHandoff(ctx: ExtensionCommandContext) {
    const parentFile: string | undefined = ctx.sessionManager.getSessionFile() ?? undefined;
    if (!parentFile) {
      ctx.ui.notify("auto-handoff: no session file (ephemeral session), nothing to hand off", "error");
      return;
    }
    handingOff = true;
    try {
      const result = await ctx.newSession({
        parentSession: parentFile,
        // Mark the fresh session so its first settle does not immediately hand off again.
        setup: async (sm) => {
          sm.appendCustomEntry(TARGET_TYPE, { from: parentFile });
        },
        withSession: async (newCtx) => {
          await newCtx.sendUserMessage(kickoffText(parentFile));
        },
      });
      if (result?.cancelled) {
        ctx.ui.notify("auto-handoff: session replacement was cancelled", "error");
      }
    } catch (err) {
      ctx.ui.notify(`auto-handoff failed: ${(err as Error).message}`, "error");
      throw err;
    } finally {
      handingOff = false;
    }
  }

  pi.registerCommand("handoff", {
    description: "Continue this work in a fresh session (old context stays reachable via parentSession)",
    handler: async (_args, ctx) => {
      await doHandoff(ctx);
    },
  });

  pi.registerCommand("handoff-threshold", {
    description: "Show or set auto-handoff threshold in kilo-tokens: /handoff-threshold [kTokens|off|on]",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();
      if (!arg) {
        ctx.ui.notify(
          `auto-handoff: ${cfg.enabled ? `on, threshold ${cfg.threshold.toLocaleString()} tokens` : "off"}`,
          "info",
        );
        return;
      }
      if (arg === "off") {
        cfg.enabled = false;
        saveConfig(cfg);
        ctx.ui.notify("auto-handoff disabled", "info");
        return;
      }
      if (arg === "on") {
        cfg.enabled = true;
        saveConfig(cfg);
        ctx.ui.notify(`auto-handoff enabled (threshold ${cfg.threshold.toLocaleString()})`, "info");
        return;
      }
      const n = Number(arg.replace(/[_,]/g, ""));
      if (Number.isFinite(n) && n >= 1) {
        cfg.threshold = Math.floor(n * 1000);
        cfg.enabled = true;
        saveConfig(cfg);
        ctx.ui.notify(`auto-handoff threshold set to ${cfg.threshold.toLocaleString()} tokens`, "info");
        return;
      }
      ctx.ui.notify("Usage: /handoff-threshold [kTokens|off|on]  (e.g. /handoff-threshold 150 = 150k tokens)", "error");
    },
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (!cfg.enabled || handingOff || attempted) return;
    if (isHandoffTarget(ctx)) return; // brand-new session from a handoff: let it work
    const usage = ctx.getContextUsage?.();
    if (!usage || usage.tokens == null || usage.tokens < cfg.threshold) return;
    attempted = true;
    ctx.ui.notify(
      `auto-handoff: context ~${usage.tokens.toLocaleString()} tokens, continuing in a fresh session`,
      "info",
    );
    // Event ctx has no newSession(); re-enter through the command so pi builds a
    // command context (the only context that exposes newSession).
    await pi.sendUserMessage("/handoff", { expandPromptTemplates: true });
  });
}
