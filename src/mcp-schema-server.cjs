#!/usr/bin/env node
// Schema-only MCP server for pi's custom tools, with an optional handoff
// proxy. Reads tool schemas from a JSON file and implements:
//   initialize, tools/list           — always
//   tools/call                        — forwarded to pi over a local socket
//                                       when one is given; otherwise an error
//                                       result (the CLI must never hang)
//
// argv: <schemaPath> [<handoffSocketPath> <cliSessionId>]
//
// The proxy is what keeps the CLI process alive across custom tool calls:
// the request blocks here until pi has executed the tool and answered, so the
// CLI continues its turn in-process instead of being interrupted and resumed
// (see src/handoff-broker.ts for why that matters).
"use strict";

const fs = require("fs");
const net = require("net");
const readline = require("readline");

const [schemaPath, socketPath, cliSessionId] = process.argv.slice(2);
if (!schemaPath) {
  process.exit(1);
}

let tools = [];
try {
  tools = JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
} catch {
  process.exit(1);
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const UNAVAILABLE =
  "Tool execution is unavailable in this environment: pi is not attached.";

/** Ask pi to execute the tool; resolves to an MCP result object. */
function proxyCall(id, name, args, toolUseId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const errorResult = (text) => ({
      content: [{ type: "text", text }],
      isError: true,
    });
    let buffer = "";
    const socket = net.connect(socketPath);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        JSON.stringify({
          type: "call",
          session: cliSessionId,
          toolUseId,
          name,
          arguments: args,
        }) + "\n",
      );
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      try {
        const msg = JSON.parse(buffer.slice(0, nl));
        finish({
          content: Array.isArray(msg.content) ? msg.content : [],
          isError: msg.isError === true,
        });
      } catch {
        finish(errorResult("pi returned a malformed tool result"));
      }
      socket.end();
    });
    socket.on("error", (err) => {
      finish(errorResult(`pi is not reachable: ${err.message}`));
    });
    socket.on("close", () => {
      finish(errorResult("pi closed the connection without a result"));
    });
    pending.set(id, socket);
  });
}

/** In-flight proxied calls by JSON-RPC id, so a cancel can drop the socket. */
const pending = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "custom-tools", version: "1.0.0" },
      },
    });
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools } });
  } else if (msg.method === "tools/call") {
    const params = msg.params || {};
    const name = typeof params.name === "string" ? params.name : "";
    const args =
      params.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {};
    // Claude Code tags the call with the assistant block that made it.
    const toolUseId =
      (params._meta && params._meta["claudecode/toolUseId"]) || "";
    if (!socketPath || !cliSessionId) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: UNAVAILABLE }],
          isError: true,
        },
      });
      return;
    }
    proxyCall(msg.id, name, args, toolUseId).then((result) => {
      pending.delete(msg.id);
      send({ jsonrpc: "2.0", id: msg.id, result });
    });
  } else if (msg.method === "notifications/cancelled") {
    // The CLI abandoned a call (interrupt). Drop the socket so the broker sees
    // the close and forgets the pending call.
    const id = msg.params && msg.params.requestId;
    const socket = pending.get(id);
    if (socket) {
      pending.delete(id);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
  } else if (msg.id !== undefined && msg.method) {
    // ping, prompts/list, resources/list … — answer so the client never waits.
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: `Method not supported: ${msg.method}` },
    });
  }
  // notifications/initialized and other notifications need no response.
});
