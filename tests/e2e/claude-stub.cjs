#!/usr/bin/env node
/**
 * Deterministic Claude Code CLI stub for pi-claude-cli e2e tests.
 * Speaks just enough of the stream-json NDJSON protocol:
 *   claude --version            -> version string
 *   claude auth status          -> JSON auth blob
 *   claude ... stream-json ...  -> reads one user message, streams "PORT-OK"
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

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString();
  if (buf.includes("\n")) respond();
});
// Safety net: some callers write without trailing newline then wait.
setTimeout(respond, 3000);
