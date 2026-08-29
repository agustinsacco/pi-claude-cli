/**
 * Provider orchestration — observer mode (docs/SPEC-observer-mode.md).
 *
 * The Claude CLI owns its loop, its tools, and its session. streamViaCli:
 * 1. Resolves the pi session's CLI session (session-map) — resume, or
 *    create/import a fresh one from pi's full history
 * 2. Spawns `claude -p`, writes the turn's prompt to stdin as NDJSON
 * 3. Streams events to pi: prose/thinking verbatim; the CLI's own tool
 *    executions as `[Claude Code · Name]` markers; HANDOFF tools (custom pi
 *    tools) as real pi toolCall blocks
 * 4. On a handoff tool at message_stop: sends a clean `interrupt` (never a
 *    kill — a SIGKILL mid-turn corrupts the CLI transcript and poisons every
 *    later resume) and ends the stream stopReason=toolUse so pi executes
 * 5. Hardened lifecycle: inactivity timeout, exit handler, streamEnded
 *    guard, abort = interrupt + delayed SIGKILL backstop, process registry
 */

import { createInterface } from "node:readline";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
} from "./prompt-builder.js";
import { resolveSystemPromptMode } from "./system-prompt-mode.js";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
  sendInterrupt,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { createTaskTracker, isTaskSubtype } from "./task-tracker.js";
import type { TaskTrackerState } from "./types.js";
import { handleControlRequest } from "./control-handler.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isHandoffClaudeTool } from "./tool-mapping.js";
import {
  getCliSession,
  setCliSession,
  clearCliSession,
  getSystemPrompt,
  setSystemPrompt,
  clearSystemPrompt,
} from "./session-map.js";
import { randomUUID } from "node:crypto";
/** Inactivity timeout: kill subprocess if no stdout for 180 seconds (3 minutes). */
/**
 * Inactivity timeout. CLI-side tool executions (web search, user MCP
 * servers, sub-agents) can be silent on stdout for minutes, so the default
 * is generous and overridable via PI_CLAUDE_CLI_TIMEOUT_MS.
 */
const INACTIVITY_TIMEOUT_MS =
  Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_TIMEOUT_MS)
    : 300_000;

/**
 * BACKGROUND SUB-AGENTS REPORT BACK, AND THIS IS WHY THEY DIDN'T.
 *
 * The CLI answers a background `Agent` call in milliseconds with "Async agent
 * launched successfully… you will be notified when it completes", and the
 * model — correctly, per its own tool contract — ends its turn to wait. The
 * CLI then emits `result` for that turn WHILE the agents keep running.
 * Killing on that first result is what made every fan-out a dead end: the
 * agents died mid-tool-call, their reports were never written, and the turn
 * closed on "Now waiting on the three investigation agents".
 *
 * The loop the host was assumed to owe the CLI turned out to be the CLI's
 * own. Captured 2026-08-28 on claude 2.1.231, holding the process open past
 * `result`: the sub-agent finished at +25s, `task_notification` carried its
 * report, the CLI re-invoked the model unprompted, and it answered with the
 * findings and emitted a SECOND `result`. Nothing was written to stdin to
 * make that happen.
 *
 * So the fix is to stop killing: while `pendingAgents()` is non-zero, a
 * `result` is a cycle boundary, not the end of the episode. Two bounds keep a
 * runaway fan-out from holding a turn open forever — the inactivity timer
 * (which `task_progress` keeps resetting for as long as agents do real work)
 * and the wall clock below.
 *
 * `applyResult` is safe to call per cycle: the CLI's `modelUsage` is
 * cumulative for the session, verified across a two-result episode
 * (cache-read 68,718 → 161,295), so the last one wins rather than summing.
 */
const WAIT_FOR_AGENTS = process.env.PI_CLAUDE_CLI_NO_AGENT_WAIT !== "1";

/** Hard ceiling on holding a turn open for sub-agents. */
const AGENT_WAIT_TIMEOUT_MS =
  Number(process.env.PI_CLAUDE_CLI_AGENT_WAIT_MS) > 0
    ? Number(process.env.PI_CLAUDE_CLI_AGENT_WAIT_MS)
    : 900_000;

/**
 * Backstop on continuation cycles. Each completing agent costs one, and an
 * agent may launch more; this only exists so a pathological loop cannot spin
 * without end.
 */
const MAX_AGENT_CONTINUATIONS = 32;

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
  /** Called with account rate-limit state as the CLI reports it. */
  onRateLimit?: (info: Record<string, unknown>) => void;
  /**
   * Called with live sub-agent state as the CLI reports it. Ephemeral: this is
   * progress, not transcript, and must never be folded into turn content. The
   * durable half (start/finish) rides in the turn as markers instead.
   */
  onTaskProgress?: (state: TaskTrackerState) => void;
};

/**
 * The mapped CLI session is stale when pi's history moved on without it:
 * an assistant turn from another provider (model switch) after — or with no —
 * pi-claude-cli turn means the CLI never saw that exchange. Resuming would
 * answer from a conversation missing turns, so reimport instead.
 */
function cliSessionIsStale(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "assistant") continue;
    return !(m?.provider === "pi-claude-cli" || m?.api === "pi-claude-cli");
  }
  return false; // no assistant turns at all: nothing to be behind
}

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: resolve/resume the CLI session,
 * spawn, write prompt, parse NDJSON, bridge events, handle result, clean up.
 * The CLI executes its own tools; only handoff (custom pi) tools end the turn
 * early, via a clean interrupt at message_stop.
 *
 * Hardened with: inactivity timeout, subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via interrupt with
 * a SIGKILL backstop, and process registry integration for teardown cleanup.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<any>,
  context: { messages: any[]; systemPrompt?: string },
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  /**
   * One subprocess attempt. Returns "resume-miss" (without touching the
   * stream) when the sidecar pointed --resume at a CLI session that no longer
   * exists on disk. The driver below retries once with a fresh session
   * imported from pi's full history, re-recording the mapping.
   */
  async function runOnce(
    forceFullReplay: boolean,
  ): Promise<"ok" | "resume-miss"> {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let abortHandler: (() => void) | undefined;
    let resumeMiss = false;
    // Track HANDOFF tool_use blocks (custom pi tools) for the interrupt
    // decision at message_stop. Built-ins run natively and never interrupt.
    let sawHandoffTool = false;
    // Set once we have asked the CLI to end the turn (handoff or abort):
    // stream content is frozen and only the result envelope is awaited.
    let selfInterrupted = false;
    // Set on pi-initiated abort so the turn ends quietly, not as an error.
    let aborted = false;
    // CLI session this attempt staged its system prompt under, so the finally
    // below can remove the right file. Set once the ids are resolved.
    let promptFileKey: string | undefined;

    try {
      const cwd = options?.cwd ?? process.cwd();

      // One CLI session per pi session, resumed across turns and restarts.
      // Resume only when a mapping exists AND the CLI session is not behind
      // pi's history (a foreign-provider turn after our last one means the
      // CLI never saw that exchange). Anything else — first turn, fork,
      // model switch, lost sidecar, resume miss — is one reimport.
      const piSessionId = options?.sessionId;
      const mappedCliId = piSessionId ? getCliSession(piSessionId) : undefined;
      const resumeSessionId =
        !forceFullReplay &&
        mappedCliId &&
        !cliSessionIsStale(context.messages as any[])
          ? mappedCliId
          : undefined;
      // Fresh sessions get a provider-minted id, never pi's: the CLI refuses
      // a --session-id it has already seen, and forks reuse pi ids.
      const newCliId = resumeSessionId ? undefined : randomUUID();
      promptFileKey = resumeSessionId ?? newCliId;

      // Resume sends only the delta since the last assistant turn (new user
      // text, handoff tool results). Create/import sends the full history.
      const prompt = resumeSessionId
        ? buildResumePrompt(context)
        : buildPrompt(context);
      // Resolved per spawn rather than once at module load so a host can flip
      // the setting between sessions without restarting pi. Switching
      // mid-session takes effect on the next NEW session, not this one: a
      // resumed session replays the prompt it was created with (below).
      const systemPromptMode = resolveSystemPromptMode();
      // The CLI does not keep --system-prompt across --resume, so it goes on
      // EVERY spawn. On resume, replay the stored bytes rather than rebuilding
      // them: an identical prompt keeps the cached prefix, a drifted one
      // re-bills the whole transcript as cache write. See src/session-map.ts.
      const storedSystemPrompt = resumeSessionId
        ? getSystemPrompt(resumeSessionId)
        : undefined;
      const systemPrompt =
        storedSystemPrompt ?? buildSystemPrompt(context, cwd, systemPromptMode);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      // Spawn subprocess
      proc = spawnClaude(model.id, systemPrompt || undefined, {
        cwd,
        signal: options?.signal,
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: newCliId,
        systemPromptMode,
      });
      // Record the mapping as soon as the session exists on disk. On a turn
      // that later errors, the mapping is cleared so the next turn reimports.
      if (piSessionId && newCliId) setCliSession(piSessionId, newCliId);
      // Store the created prompt so every later turn re-passes these exact
      // bytes. Without it, resume falls back to a rebuild that can drift.
      if (newCliId && systemPrompt) setSystemPrompt(newCliId, systemPrompt);
      const getStderr = captureStderr(proc);

      // Register in global process registry for teardown cleanup
      registerProcess(proc);

      // Write user message to subprocess stdin
      writeUserMessage(proc, prompt);

      // Create event bridge (before endStreamWithError so bridge is in scope)
      const bridge = createEventBridge(stream, model);
      // Per-attempt: a resume-miss retry replays the episode, and its
      // sub-agents must not be counted twice.
      const taskTracker = createTaskTracker();

      // Guard against double stream.end() and double error events.
      // First error path wins; subsequent ones are no-ops.
      let streamEnded = false;

      /**
       * End the stream with an error, using a "done" event instead of "error".
       *
       * Why "done" not "error": AssistantMessageEventStream.extractResult()
       * returns event.error (a string) for error events, but agent-loop.js
       * then calls message.content.filter() on the result, crashing because
       * a string has no .content property. By pushing "done" with a valid
       * AssistantMessage (content:[]), pi gets a well-formed object.
       */
      function endStreamWithError(errMsg: string) {
        if (streamEnded || broken) return;
        streamEnded = true;
        const output = bridge.getOutput();
        const errorMessage = {
          ...output,
          content: output.content?.length
            ? output.content
            : [{ type: "text" as const, text: `Error: ${errMsg}` }],
          stopReason: "stop" as const,
        };
        stream.push({
          type: "done",
          reason: "stop",
          message: errorMessage,
        } as any);
        stream.end();
      }

      // Inactivity timeout: kill subprocess if no stdout for INACTIVITY_TIMEOUT_MS
      let inactivityTimer: ReturnType<typeof setTimeout> | undefined;

      // Sub-agent wait state (see WAIT_FOR_AGENTS): how many `result`
      // envelopes have been treated as cycle boundaries, and the wall-clock
      // backstop that stops waiting no matter what the agents are doing.
      let agentContinuations = 0;
      let agentWaitTimer: ReturnType<typeof setTimeout> | undefined;
      let agentWaitExpired = false;
      let waitingForAgents = false;

      /**
       * End the episode on what it already has: kill the CLI and close the
       * reader without pushing an error.
       *
       * Only correct once a `result` has been seen. Before that, silence means
       * a wedged CLI and the turn has nothing — which is what the inactivity
       * timeout's error is for.
       */
      function endTurnOnPartialWork() {
        agentWaitExpired = true;
        clearTimeout(inactivityTimer);
        clearTimeout(agentWaitTimer);
        cleanupProcess(proc!);
        rl.close();
      }

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          // Waiting on sub-agents is the one state where silence is not a
          // failed turn: the model already spoke and the result already
          // landed. An agent that dies without notifying must not convert
          // that into an error and throw the content away.
          if (waitingForAgents) {
            endTurnOnPartialWork();
            return;
          }
          forceKillProcess(proc!);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Abort = the CLI's own interrupt (keeps the session resumable), with a
      // SIGKILL backstop in case the CLI is wedged and never emits a result.
      if (options?.signal) {
        abortHandler = () => {
          if (!proc) return;
          aborted = true;
          selfInterrupted = true;
          sendInterrupt(proc);
          const backstop = setTimeout(() => forceKillProcess(proc!), 2000);
          proc.once("close", () => clearTimeout(backstop));
        };

        if (options.signal.aborted) {
          abortHandler();
          return "ok";
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Guard against buffered readline lines firing after rl.close()
      let broken = false;

      // Set up readline for line-by-line NDJSON parsing
      const rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      // Handle process error -- use endStreamWithError for guard
      proc.on("error", (err: Error) => {
        if (broken) return; // resume-miss retry owns the stream
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, _signal: string | null) => {
        clearTimeout(inactivityTimer);
        clearTimeout(agentWaitTimer);
        if (broken) return; // resume-miss retry owns the stream
        if (code !== 0 && code !== null) {
          const stderr = getStderr();
          const message = stderr
            ? `Claude CLI exited with code ${code}: ${stderr.trim()}`
            : `Claude CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        }
      });

      // Start inactivity timer after writing user message
      resetInactivityTimer();

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        if (broken) return; // Guard: ignore buffered lines after a resume miss

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !(msg as any).parent_tool_use_id;
          if (isTopLevel && !selfInterrupted) {
            bridge.handleEvent(msg.event);
          }

          // Track handoff tool_use blocks (top-level only). Built-ins and
          // CLI-internal tools execute natively and must not interrupt.
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName && isHandoffClaudeTool(toolName)) {
              sawHandoffTool = true;
            }
          }

          // Handoff at message_stop: ask the CLI to end the turn CLEANLY so
          // the session file stays truthful and resumable, then wait for the
          // result envelope. Never SIGKILL here — a kill truncates the
          // transcript before the assistant turn is written, and every later
          // --resume then splices in synthetic "No response requested."
          // filler that the model eventually imitates.
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawHandoffTool &&
            !selfInterrupted
          ) {
            selfInterrupted = true;
            sendInterrupt(proc!);
            return;
          }
        } else if (msg.type === "rate_limit_event") {
          // Account-level state, not turn content: hand it to the host so a
          // front-end can surface the window and its reset. Never touches
          // the assistant message.
          const info = (msg as any).rate_limit_info;
          if (info && typeof info === "object") {
            try {
              options?.onRateLimit?.(info);
            } catch {
              /* a status push must never break a turn */
            }
          }
        } else if (
          msg.type === "system" &&
          isTaskSubtype((msg as any).subtype)
        ) {
          // Sub-agent lifecycle. The agents' own envelopes carry
          // parent_tool_use_id and stay internal to the CLI, but these arrive
          // at top level even for deeply nested agents — the one channel that
          // makes a fan-out visible at all (#23).
          if (!selfInterrupted) {
            const marker = taskTracker.apply(msg as any);
            if (marker) bridge.appendMarker(marker);
            try {
              options?.onTaskProgress?.(taskTracker.snapshot());
            } catch {
              /* a status push must never break a turn */
            }
          }
        } else if (msg.type === "assistant") {
          // Complete-block envelopes: marker text for the CLI's own tool
          // executions (built-ins, WebSearch, user MCP, …), which in observer
          // mode is every tool except handoffs.
          if (!selfInterrupted) bridge.handleAssistantEnvelope(msg as any);
        } else if (msg.type === "user") {
          // Tool results the CLI feeds back between cycles — internal.
        } else if (msg.type === "control_request") {
          handleControlRequest(msg, proc!.stdin!);
        } else if (msg.type === "result") {
          const r: any = msg as any;
          const isError =
            r.subtype !== "success" ||
            r.is_error === true ||
            typeof r.error === "string" ||
            (Array.isArray(r.errors) && r.errors.length > 0);
          if (isError && !selfInterrupted && !aborted) {
            const errMsg =
              r.error ??
              (Array.isArray(r.errors) && r.errors.length > 0
                ? r.errors.join("; ")
                : `Claude CLI returned ${r.subtype ?? "non-success result"}`);
            if (
              resumeSessionId &&
              /No conversation found with session ID/i.test(errMsg)
            ) {
              // Recoverable: the sidecar pointed at a CLI session that no
              // longer exists. Clear it; the driver reimports once.
              if (piSessionId) clearCliSession(piSessionId);
              clearSystemPrompt(resumeSessionId);
              resumeMiss = true;
              broken = true;
            } else {
              // A failed turn may leave the CLI session ending on a user
              // entry; resuming that would splice filler. Reimport next turn.
              if (piSessionId) clearCliSession(piSessionId);
              // This CLI session will never be resumed, so its stored prompt
              // is dead weight.
              const deadCliId = resumeSessionId ?? newCliId;
              if (deadCliId) clearSystemPrompt(deadCliId);
              endStreamWithError(errMsg);
            }
          }
          if (!isError || selfInterrupted || aborted) {
            // Authoritative episode usage. After a self-interrupt the result
            // is `error_during_execution` BY DESIGN — the turn content (the
            // handoff toolCall) is already accumulated; usage still applies.
            bridge.applyResult(r);
          }

          // Sub-agents still working: this result ends a CYCLE, not the
          // episode. Leave the CLI alive and keep reading — it re-invokes the
          // model itself once they report, and emits another result. See
          // WAIT_FOR_AGENTS for the capture this is built on.
          if (
            WAIT_FOR_AGENTS &&
            !isError &&
            !selfInterrupted &&
            !aborted &&
            !agentWaitExpired &&
            agentContinuations < MAX_AGENT_CONTINUATIONS &&
            taskTracker.pendingAgents() > 0
          ) {
            agentContinuations++;
            waitingForAgents = true;
            if (agentWaitTimer === undefined) {
              agentWaitTimer = setTimeout(() => {
                // Give up waiting, but let the turn end on its own content:
                // the launch markers and whatever the model already said are
                // real, and an error here would throw them away.
                endTurnOnPartialWork();
              }, AGENT_WAIT_TIMEOUT_MS);
              // A pending wait must never hold the host process open.
              agentWaitTimer.unref?.();
            }
            resetInactivityTimer();
            return;
          }

          // For success, handoff and error alike: clean up the subprocess
          clearTimeout(inactivityTimer);
          clearTimeout(agentWaitTimer);
          cleanupProcess(proc!);
          rl.close();
        }
      });

      // Wait for readline to close (result received or process ended)
      await new Promise<void>((resolve) => {
        rl.on("close", resolve);
      });

      if (resumeMiss) return "resume-miss";

      // Push done event after readline closes (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        const output = bridge.getOutput();

        // If stopReason is toolUse but there are no pi-known tool calls in content,
        // it means only user MCP tools were called (filtered by event bridge).
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (output.content || []).filter(
          (c: any) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
        });
        stream.end();
      }
      return "ok";
    } finally {
      // Clean up this attempt's abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      // Staged prompt file is per CLI session, so it is removed here where
      // the ids are in scope — a resume-miss retry stages a second one.
      cleanupSystemPromptFile(promptFileKey);
    }
  }

  (async () => {
    try {
      const outcome = await runOnce(false);
      if (outcome === "resume-miss") {
        console.error(
          "[pi-claude-cli] CLI session missing for --resume — importing pi history into a fresh CLI session",
        );
        await runOnce(true);
      }
    } catch (err: any) {
      stream.push({
        type: "error",
        reason: "error",
        error: err.message ?? "Unexpected error in streamViaCli",
      } as any);
      stream.end();
    } finally {
      // The sub-agent channel is state ABOUT a turn, so it must not outlive
      // one. Left standing, the last snapshot pins whatever the agents were
      // doing when the episode ended — a host then shows "running" for
      // agents that finished, or for agents that died, until the next turn
      // happens to publish something else.
      try {
        options?.onTaskProgress?.({ tasks: [], active: 0, completed: 0 });
      } catch {
        /* a status push must never break a turn */
      }
    }
  })();

  return stream;
}
