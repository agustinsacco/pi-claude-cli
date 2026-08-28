/**
 * Control protocol handler for Claude CLI stream-json communication.
 *
 * Processes control_request messages from Claude CLI stdout and writes
 * control_response messages to stdin.
 *
 * - Custom MCP tools (mcp__custom-tools__*): DENIED — pi executes these
 * - Everything else (user MCP tools, internal tools): ALLOWED — Claude handles
 */

import type { ClaudeControlRequest } from "./types";
import {
  CUSTOM_TOOLS_MCP_PREFIX,
  ASK_USER_QUESTION_CLAUDE,
} from "./tool-mapping.js";

export const TOOL_EXECUTION_DENIED_MESSAGE =
  "Tool execution is unavailable in this environment.";

/**
 * AskUserQuestion's deny message doubles as the tool_result the model reads
 * in the CLI transcript on the next resume, so it must say what actually
 * happens: the host is asking, and the answers arrive as the next message.
 */
export const ASK_USER_HANDOFF_MESSAGE =
  "The host UI is presenting these questions to the user. " +
  "Their answers will arrive in the next message; do not re-ask.";

/** Prefix for MCP (Model Context Protocol) tool names. */
export const MCP_PREFIX = "mcp__";

/**
 * Claude Code 2.x control_response wire shape: `request_id` lives INSIDE
 * `response`, and allow decisions carry `updatedInput` (the tool input,
 * passed through unmodified). The 1.x shape (`request_id` at the top level)
 * is silently ignored by 2.1.x — the CLI keeps waiting for an answer and
 * the episode stalls until the inactivity timer kills it, which surfaced
 * as truncated multi-cycle turns (#3). Verified against claude 2.1.237.
 */
interface ControlResponse {
  type: "control_response";
  response: {
    subtype: "success";
    request_id: string;
    response:
      | { behavior: "allow"; updatedInput: Record<string, unknown> }
      | { behavior: "deny"; message: string };
  };
}

/**
 * Handle a control_request from the Claude CLI.
 *
 * Denies custom MCP tools (mcp__custom-tools__*) so pi can execute them.
 * Allows everything else (user MCP tools, internal Claude tools).
 *
 * @returns true if the tool was allowed, false if denied
 */
export function handleControlRequest(
  msg: ClaudeControlRequest,
  stdin: NodeJS.WritableStream,
): boolean {
  if (!msg.request_id || !msg.request) {
    console.error(
      "[pi-claude-cli] Malformed control_request: missing request_id or request object",
      msg,
    );
    return false;
  }

  const toolName = msg.request?.tool_name ?? "";
  const isCustomTool = toolName.startsWith(CUSTOM_TOOLS_MCP_PREFIX);
  // AskUserQuestion is a handoff too: allowing it would need
  // `updatedInput.answers` filled by a UI this process does not have, and
  // allowing it UNCHANGED makes the CLI answer the model with "The user did
  // not answer the questions." — which models read as a human who declined.
  // Deny it here; the provider hands the questions to pi as an `ask_user`
  // toolCall and the real answers come back next episode.
  const isAskUser = toolName === ASK_USER_QUESTION_CLAUDE;
  const denied = isCustomTool || isAskUser;

  const response: ControlResponse = {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: msg.request_id,
      response: denied
        ? {
            behavior: "deny",
            message: isAskUser
              ? ASK_USER_HANDOFF_MESSAGE
              : TOOL_EXECUTION_DENIED_MESSAGE,
          }
        : { behavior: "allow", updatedInput: msg.request?.input ?? {} },
    },
  };

  stdin.write(JSON.stringify(response) + "\n");
  return !denied;
}
