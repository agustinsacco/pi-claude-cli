#!/usr/bin/env node
/**
 * Deterministic Claude Code CLI stub for pi-claude-cli e2e tests.
 * Speaks just enough of the stream-json NDJSON protocol:
 *   claude --version            -> version string
 *   claude auth status          -> JSON auth blob
 *   claude ... stream-json ...  -> reads one user message, streams "PORT-OK"
 *
 * A prompt containing "fanout" instead replays the shape of a real background
 * sub-agent turn (captured 2026-08-28, claude 2.1.231): the model launches an
 * agent, the CLI emits `result` for that turn WHILE the agent runs, and only
 * later notifies and re-invokes the model with the findings. A provider that
 * kills on the first result never sees "AGENT-REPORT".
 */
const args = process.argv.slice(2);

if (args.includes("--version")) {
  console.log("9.9.9-stub (Claude Code)");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log(JSON.stringify({ loggedIn: true, method: "stub" }));
  process.exit(0);
}

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

let responded = false;
const respond = () => {
  if (responded) return;
  responded = true;
  emit({ type: "system", subtype: "init", session_id: "stub-session" });
  emit({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 0 } },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "PORT-OK" },
    },
  });
  emit({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  emit({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    },
  });
  emit({ type: "stream_event", event: { type: "message_stop" } });
  emit({ type: "result", subtype: "success", is_error: false });
  process.exit(0);
};

/** One assistant cycle: message_start … message_stop, streaming `text`. */
const cycle = (text) => {
  emit({
    type: "stream_event",
    event: {
      type: "message_start",
      message: { usage: { input_tokens: 5, output_tokens: 0 } },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  });
  emit({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  });
  emit({
    type: "stream_event",
    event: { type: "content_block_stop", index: 0 },
  });
  emit({
    type: "stream_event",
    event: {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
    },
  });
  emit({ type: "stream_event", event: { type: "message_stop" } });
};

const respondFanout = () => {
  if (responded) return;
  responded = true;
  emit({ type: "system", subtype: "init", session_id: "stub-session" });

  // The agent, and an auto-backgrounded Bash that is NOT one.
  emit({
    type: "system",
    subtype: "task_started",
    task_id: "aStubAgent1",
    task_type: "local_agent",
    tool_use_id: "toolu_stub_1",
    description: "Dig into the thing",
    subagent_type: "general-purpose",
  });
  emit({
    type: "system",
    subtype: "task_started",
    task_id: "bStubShell1",
    task_type: "local_bash",
    description: "Search for a local checkout",
  });

  cycle("LAUNCHED-WAITING");
  // The turn's result, with the agent still running. This is the kill point.
  emit({ type: "result", subtype: "success", is_error: false });

  setTimeout(() => {
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "bStubShell1",
      status: "completed",
    });
    emit({
      type: "system",
      subtype: "task_notification",
      task_id: "aStubAgent1",
      status: "completed",
      summary: "found it",
      usage: { total_tokens: 1234, tool_uses: 2, duration_ms: 900 },
    });
    // The CLI re-invokes the model itself once the agent reports.
    cycle("AGENT-REPORT");
    emit({ type: "result", subtype: "success", is_error: false });
    process.exit(0);
  }, 1500);
};

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  if (!buf.includes("\n")) return;
  if (buf.includes("fanout")) respondFanout();
  else respond();
});
// Safety net: some callers write without trailing newline then wait.
setTimeout(respond, 3000);
