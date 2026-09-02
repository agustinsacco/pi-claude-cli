/**
 * Pi extension entry point for pi-claude-cli.
 *
 * Registers a custom provider that routes LLM calls through the Claude Code CLI
 * subprocess using stream-json NDJSON protocol.
 */

import { getBuiltinModels as getModels } from "@earendil-works/pi-ai/providers/all";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { streamViaCli } from "./src/provider.js";
import {
  validateCliPresence,
  validateCliAuth,
  killAllProcesses,
} from "./src/process-manager.js";
import {
  getCustomToolDefs,
  writeSchemaFile,
  cleanupMcpConfigFiles,
} from "./src/mcp-config.js";
import { startHandoffBroker, stopHandoffBroker } from "./src/handoff-broker.js";
import { retireAllCliProcesses } from "./src/cli-process.js";
import { rewriteOverflowMessage } from "./src/overflow.js";
import { buildRateLimitPayload, rateLimitIdentity } from "./src/rate-limit.js";
import type { TaskTrackerState } from "./src/types.js";

// Kill all active Claude subprocesses on process exit to prevent orphans
process.on("exit", killAllProcesses);
// Remove the schema/config temp files this process staged in tmpdir
process.on("exit", cleanupMcpConfigFiles);
// Close the handoff socket and remove its file
process.on("exit", stopHandoffBroker);
// Parked CLI processes hold their stdin from us: ending pi ends them (the
// pipe closes and the CLI exits), but retire cleanly when we can.
process.on("beforeExit", () => {
  void retireAllCliProcesses();
});

const PROVIDER_ID = "pi-claude-cli";

/**
 * Status key carrying account rate-limit state to the front-end. Neutral
 * (not pidex-specific) because any pi front-end can read it.
 */
const RATE_LIMIT_STATUS_KEY = "claude-rate-limit";

/**
 * The stream runs deep inside streamSimple, which has no ExtensionContext,
 * so the ctx handed to session_start is kept for its `ui.setStatus`.
 */
let uiContext:
  { ui?: { setStatus?(key: string, text?: string): void } } | undefined;
/** Last payload pushed — the CLI repeats this event on every turn. */
let lastRateLimitJson: string | undefined;

function publishRateLimit(info: Record<string, unknown>): void {
  const setStatus = uiContext?.ui?.setStatus;
  if (typeof setStatus !== "function") return;
  const payload = buildRateLimitPayload(info);
  // Push only on change: the event repeats every turn, and a status that
  // rewrites itself constantly is noise for whatever renders it.
  const identity = rateLimitIdentity(payload);
  if (identity === lastRateLimitJson) return;
  lastRateLimitJson = identity;
  try {
    setStatus.call(
      uiContext!.ui,
      RATE_LIMIT_STATUS_KEY,
      JSON.stringify(payload),
    );
  } catch {
    /* never break a turn over a status push */
  }
}

/**
 * Live sub-agent state, on its own status key.
 *
 * Same reasoning as the rate-limit channel: this is state ABOUT the turn, not
 * content OF it. `task_progress` fires once per sub-agent tool call (roughly
 * 700 times in the incident that motivated #23), so folding it into the
 * transcript would bury the turn and cost context on every later replay. The
 * durable half — one marker when a sub-agent starts, one when it finishes —
 * goes in the turn instead, and needs no host change to render.
 */
const SUBAGENTS_STATUS_KEY = "claude-subagents";
/** Last payload pushed, so an unchanged snapshot does not rewrite the status. */
let lastSubagentsJson: string | undefined;

function publishTaskProgress(state: TaskTrackerState): void {
  const setStatus = uiContext?.ui?.setStatus;
  if (typeof setStatus !== "function") return;
  const json = JSON.stringify(state);
  if (json === lastSubagentsJson) return;
  lastSubagentsJson = json;
  try {
    // An empty snapshot means the episode is over: CLEAR the key rather than
    // pushing `{"tasks":[],...}`. A host reads a present status as live
    // state, so an empty one left standing is a strip that still claims
    // agents when there are none.
    setStatus.call(
      uiContext!.ui,
      SUBAGENTS_STATUS_KEY,
      state.tasks.length === 0 ? undefined : json,
    );
  } catch {
    /* never break a turn over a status push */
  }
}

/** Last staged schema, handed to every spawn; undefined until pi's registry is up. */
let mcpSchema: { schemaPath: string; version: number } | undefined;

/**
 * Stage pi's custom-tool schemas on first request, then keep them in step
 * with pi's tool registry. Not done at load time: pi.getAllTools() fails
 * while extensions are still loading.
 *
 * Re-checked on EVERY request rather than locked after the first. pi packages
 * register and unregister tools at runtime — pi-mcp-adapter re-registers its
 * `mcp` gateway with a fresh description whenever an MCP server is added,
 * enabled or disabled — and a locked snapshot left the CLI advertising a
 * turn-1 tool surface for the whole session. writeSchemaFile only touches
 * disk when the surface actually changed, so the steady-state cost is one
 * getAllTools() call and a string compare.
 *
 * The CLI reads the schema through --mcp-config at spawn, so a mid-session
 * change lands on the next spawn: the version bump retires a parked process
 * (its tool list is what it advertised at connect time) and the next call
 * resumes the CLI session in a fresh process.
 *
 * Uses warn-don't-block: failure logs a warning but does not
 * prevent the provider from functioning (built-ins still work).
 */
function ensureMcpSchema(
  pi: ExtensionAPI,
): { schemaPath: string; version: number } | undefined {
  try {
    const allTools = pi.getAllTools();

    // Registry not ready yet — retry on the next call
    if (!Array.isArray(allTools)) {
      return mcpSchema;
    }

    const toolDefs = getCustomToolDefs(pi);
    if (toolDefs.length === 0) {
      return mcpSchema;
    }

    const { schemaPath, changed, version } = writeSchemaFile(toolDefs);
    mcpSchema = { schemaPath, version };
    if (changed) {
      console.error(
        `[pi-claude-cli] MCP config generated with ${toolDefs.length} custom tool(s)`,
      );
    }
  } catch (err) {
    console.warn(
      "[pi-claude-cli] MCP config generation failed, custom tools unavailable:",
      err,
    );
  }
  return mcpSchema;
}

/**
 * The handoff socket the schema server calls back into. Started once, on the
 * first turn; a failure to bind logs once and leaves proxied handoffs off (the
 * provider then falls back to interrupt-and-resume for custom tools).
 */
let handoffSocket: string | undefined;
let handoffSocketAttempted = false;
async function ensureHandoffSocket(): Promise<string | undefined> {
  if (handoffSocket || handoffSocketAttempted) return handoffSocket;
  handoffSocketAttempted = true;
  try {
    handoffSocket = await startHandoffBroker();
  } catch (err) {
    console.warn(
      "[pi-claude-cli] handoff socket unavailable, custom tools fall back to interrupt-and-resume:",
      err,
    );
  }
  return handoffSocket;
}

export default function (pi: ExtensionAPI) {
  try {
    // Startup validation
    validateCliPresence(); // throws if CLI not on PATH
    validateCliAuth(); // warns if not authenticated

    const models = getModels("anthropic").map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      // pi's thinking selector only offers xhigh/max when the model's
      // thinkingLevelMap declares them (getSupportedThinkingLevels in pi-ai);
      // without this, every model is capped at "high" in the UI. The mapped
      // values are unused by this provider — effort is derived from
      // options.reasoning in mapThinkingEffort.
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    }));

    // Ensure all registered tools are active so pi can execute them.
    // Some tools (find, grep, ls) are registered but not activated by default.
    pi.on("session_start", async (_event: unknown, ctx: unknown) => {
      uiContext = ctx as typeof uiContext;
      lastRateLimitJson = undefined;
      lastSubagentsJson = undefined;
      const allTools = pi.getAllTools();
      if (Array.isArray(allTools)) {
        pi.setActiveTools(allTools.map((t: any) => t.name));
      }
    });

    const streamFn = (
      model: Parameters<typeof streamViaCli>[0],
      context: Parameters<typeof streamViaCli>[1],
      options?: Parameters<typeof streamViaCli>[2],
    ) => {
      const schema = ensureMcpSchema(pi);
      // The socket start is async; the provider awaits it inside its own
      // driver so streamSimple still returns the stream synchronously.
      return streamViaCli(model, context, {
        ...options,
        mcpConfig: schema
          ? { ...schema, handoffSocket: ensureHandoffSocket() }
          : undefined,
        onRateLimit: publishRateLimit,
        onTaskProgress: publishTaskProgress,
      });
    };

    // pi.registerProvider() feeds pi's provider composer, but pi 0.84's
    // default stream fn (pi-agent-core setDefaultStreamFn) resolves
    // model.api against pi-ai's global api registry instead — print mode
    // and nested agent loops take that path and would throw
    // "No API provider registered for api: pi-claude-cli" (#32).
    // Register the custom api id there too.
    registerApiProvider(
      { api: PROVIDER_ID as any, stream: streamFn, streamSimple: streamFn },
      PROVIDER_ID,
    );

    // Overflow recovery: rewrite provider-scoped context-limit errors to
    // the prefix pi's auto-compaction recognizes (see src/overflow.ts).

    (pi.on as any)("message_end", (event: any, ctx: any) => {
      return rewriteOverflowMessage(event?.message ?? {}, ctx?.model?.provider);
    });

    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "pi-claude-cli",
      apiKey: "unused",
      api: "pi-claude-cli",
      models,
      streamSimple: streamFn,
    });
  } catch (err) {
    console.error(`[pi-claude-cli] Failed to register provider:`, err);
  }
}
