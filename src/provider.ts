/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context
 * 2. Spawns a Claude CLI subprocess with correct flags
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages and cleans up the subprocess
 * 7. Implements break-early: kills subprocess at message_stop when
 *    built-in or custom-tools MCP tool_use blocks are seen
 * 8. Hardened lifecycle: inactivity timeout, subprocess exit handler,
 *    streamEnded guard, abort via SIGKILL, process registry
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
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { handleControlRequest } from "./control-handler.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
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

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
  /** Called with account rate-limit state as the CLI reports it. */
  onRateLimit?: (info: Record<string, unknown>) => void;
};

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any built-in or custom-tools MCP tool was seen, kills
 * the subprocess before Claude CLI can auto-execute the tools.
 *
 * Hardened with: inactivity timeout (180s), subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via SIGKILL, and
 * process registry integration for teardown cleanup.
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
   * stream) when a --resume pointed at a CLI session that does not exist —
   * forks copy pi history into a NEW session id, so the prior-provider-turn
   * heuristic says resume while the CLI cache is keyed to the old id (#2).
   * The driver below retries once with a full-history replay, which also
   * re-registers the CLI cache under the current session id.
   */
  async function runOnce(
    forceFullReplay: boolean,
  ): Promise<"ok" | "resume-miss"> {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let abortHandler: (() => void) | undefined;
    let resumeMiss = false;

    try {
      const cwd = options?.cwd ?? process.cwd();

      // Resume only when this conversation already contains a prior assistant
      // turn produced by pi-claude-cli (which means a CLI session has been
      // established under this session id). Otherwise — e.g. when the user
      // just switched to pi-claude-cli from another provider mid session, or
      // when this is the first turn — start a fresh CLI session via
      // --session-id. Using --resume against an unknown id fails silently
      // with "No conversation found with session ID" and produces an empty
      // assistant message.
      const hasPriorCliTurn = (context.messages as any[]).some(
        (m) =>
          m?.role === "assistant" &&
          (m?.provider === "pi-claude-cli" || m?.api === "pi-claude-cli"),
      );
      const resumeSessionId =
        !forceFullReplay && options?.sessionId && hasPriorCliTurn
          ? options.sessionId
          : undefined;

      // Build prompt: if resuming, only send the latest user turn;
      // otherwise build the full flattened conversation history
      const prompt = resumeSessionId
        ? buildResumePrompt(context)
        : buildPrompt(context);
      const systemPrompt = resumeSessionId
        ? undefined
        : buildSystemPrompt(context, cwd);

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
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
      });
      const getStderr = captureStderr(proc);

      // Register in global process registry for teardown cleanup
      registerProcess(proc);

      // Write user message to subprocess stdin
      writeUserMessage(proc, prompt);

      // Create event bridge (before endStreamWithError so bridge is in scope)
      const bridge = createEventBridge(stream, model);

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

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          forceKillProcess(proc!);
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Set up abort signal handler -- uses SIGKILL for immediate force-kill
      if (options?.signal) {
        abortHandler = () => {
          if (proc) {
            forceKillProcess(proc);
          }
        };

        if (options.signal.aborted) {
          abortHandler();
          return "ok";
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Track tool_use blocks for break-early decision at message_stop
      let sawBuiltInOrCustomTool = false;
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
        if (broken) return; // Break-early killed the process intentionally
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, _signal: string | null) => {
        clearTimeout(inactivityTimer);
        if (broken) return; // Break-early kill, expected
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
        if (broken) return; // Guard: ignore buffered lines after break-early

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !(msg as any).parent_tool_use_id;
          if (isTopLevel) {
            bridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName && isPiKnownClaudeTool(toolName)) {
              // Built-in tool (Read/Write/etc.) OR custom MCP tool (mcp__custom-tools__*)
              // Internal Claude Code tools (ToolSearch, Task, etc.) are excluded
              sawBuiltInOrCustomTool = true;
            }
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawBuiltInOrCustomTool
          ) {
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(proc!);
            rl.close();
            return; // Don't process further -- done event already pushed by event bridge
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
        } else if (msg.type === "assistant") {
          // Complete-block envelopes: marker text for CLI-side tools that
          // would otherwise be invisible between cycles.
          bridge.handleAssistantEnvelope(msg as any);
        } else if (msg.type === "user") {
          // Tool results the CLI feeds back between cycles — internal.
        } else if (msg.type === "control_request") {
          handleControlRequest(msg, proc!.stdin!);
        } else if (msg.type === "result") {
          // Surface every non-success result as an error so silent failures
          // (e.g. subtype "error_during_execution" from --resume against an
          // unknown session id, or any future error variant) don't get
          // swallowed into an empty assistant message.
          const r: any = msg as any;
          const isError =
            r.subtype !== "success" ||
            r.is_error === true ||
            typeof r.error === "string" ||
            (Array.isArray(r.errors) && r.errors.length > 0);
          if (isError) {
            const errMsg =
              r.error ??
              (Array.isArray(r.errors) && r.errors.length > 0
                ? r.errors.join("; ")
                : `Claude CLI returned ${r.subtype ?? "non-success result"}`);
            if (
              resumeSessionId &&
              /No conversation found with session ID/i.test(errMsg)
            ) {
              // Recoverable: the driver replays full history once. The CLI
              // also exits non-zero after this result — silence this
              // attempt's close/error handlers so the retry owns the stream.
              resumeMiss = true;
              broken = true;
            } else {
              endStreamWithError(errMsg);
            }
          }
          if (!isError) {
            // Authoritative episode usage + final-answer safety net.
            bridge.applyResult(r);
          }
          // For both success and error: clean up the subprocess
          clearTimeout(inactivityTimer);
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
    }
  }

  (async () => {
    try {
      const outcome = await runOnce(false);
      if (outcome === "resume-miss") {
        console.error(
          "[pi-claude-cli] CLI session missing for --resume — replaying full history under the current session id",
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
      cleanupSystemPromptFile();
    }
  })();

  return stream;
}
