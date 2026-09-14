/**
 * Custom tool discovery and MCP config file generation.
 *
 * Discovers non-built-in tools from pi, writes their schemas to a temp file,
 * and generates MCP config files that point to the schema-only MCP server.
 *
 * The schema file is refreshed whenever pi's tool surface changes. pi packages
 * register and unregister tools at runtime — pi-mcp-adapter re-registers its
 * `mcp` gateway with a new description every time an MCP server is added,
 * enabled or disabled — so a snapshot taken at the first turn goes stale for
 * the rest of the session. The schema file keeps a stable per-process path,
 * so refreshing rewrites in place instead of accumulating files; every
 * rewrite bumps `version` so a parked CLI process spawned against the old
 * surface can be retired (its tool list is what the CLI advertised at
 * connect time).
 *
 * Config files are per CLI session: each carries the session id so the
 * schema server can route proxied `tools/call` requests back to the right pi
 * session over the handoff socket (src/handoff-broker.ts).
 *
 * Every file here is staged in this process's private 0700 runtime directory
 * and written 0600. A session config names the handoff socket and the CLI
 * session id — enough, before this was locked down, for another local user to
 * address the broker directly.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFile, RUNTIME_FILE_MODE } from "./runtime-dir.js";

/** The 6 built-in tools that pi handles natively (match pi tool names). */
const BUILT_IN_TOOL_NAMES = new Set([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
]);

/** A custom tool definition with MCP-compatible schema. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Outcome of a write: where the config lives, and whether anything changed. */
export interface McpConfigWrite {
  configPath: string;
  /** False when the tool surface was byte-identical to the last write. */
  changed: boolean;
}

/** The staged schema file and how many times it has been rewritten. */
export interface SchemaFileWrite {
  schemaPath: string;
  changed: boolean;
  /** Increments on every rewrite; 1 after the first write. */
  version: number;
}

/** Serialized tool defs as of the last write, for change detection. */
let lastSchemaJson: string | undefined;
let schemaVersion = 0;
/** The legacy per-process config file's content never varies: written once. */
let configWritten = false;
/** Per-session config files this process wrote, for exit cleanup. */
const sessionConfigPaths = new Map<string, string>();

/**
 * Get custom tool definitions from pi, filtering out built-in tools.
 *
 * @param pi - The pi ExtensionAPI instance
 * @returns Array of custom tool definitions (empty if all tools are built-in)
 */
export function getCustomToolDefs(pi: any): McpToolDef[] {
  const allTools = pi.getAllTools();

  if (!Array.isArray(allTools)) {
    return [];
  }

  return allTools
    .filter((tool: any) => !BUILT_IN_TOOL_NAMES.has(tool.name))
    .map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
}

/** Where this process stages the tool schemas the CLI advertises. */
function schemaFilePath(): string {
  return runtimeFile("mcp-schemas.json");
}

/** Where this process stages the legacy (session-less) `--mcp-config` file. */
function configFilePath(): string {
  return runtimeFile("mcp-config.json");
}

function sessionConfigFilePath(cliSessionId: string): string {
  // The session id reaches us from the CLI. Keep it out of the path so a
  // hostile value cannot traverse out of the runtime directory.
  return runtimeFile(`mcp-config-${safeFileSegment(cliSessionId)}.json`);
}

/** Reduce an id to characters that cannot escape or confuse a path. */
function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "session";
}

/** Resolve the schema server .cjs (sibling of this module). */
function serverPath(): string {
  const __filename = fileURLToPath(import.meta.url);
  return join(dirname(__filename), "mcp-schema-server.cjs");
}

/**
 * Stage the tool schemas. Safe to call on every turn: the file is only
 * rewritten when the tool surface actually changed.
 */
export function writeSchemaFile(toolDefs: McpToolDef[]): SchemaFileWrite {
  const schemaJson = JSON.stringify(toolDefs);
  const changed = schemaJson !== lastSchemaJson;
  if (changed) {
    writeFileSync(schemaFilePath(), schemaJson, { mode: RUNTIME_FILE_MODE });
    lastSchemaJson = schemaJson;
    schemaVersion++;
  }
  return { schemaPath: schemaFilePath(), changed, version: schemaVersion };
}

/**
 * Write MCP config and tool schemas to temp files (session-less form: no
 * handoff proxy, the server answers `tools/call` with an error).
 *
 * @param toolDefs - Array of custom tool definitions
 * @returns The config file path, and whether this call rewrote the schemas
 */
export function writeMcpConfig(toolDefs: McpToolDef[]): McpConfigWrite {
  const configPath = configFilePath();
  const { schemaPath, changed } = writeSchemaFile(toolDefs);

  if (!configWritten) {
    const config = {
      mcpServers: {
        "custom-tools": {
          command: "node",
          args: [serverPath(), schemaPath],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(config), {
      mode: RUNTIME_FILE_MODE,
    });
    configWritten = true;
  }

  return { configPath, changed };
}

/**
 * Write the `--mcp-config` file for ONE CLI session. The schema server gets
 * the handoff socket and the session id so its `tools/call` requests reach
 * the pi session that owns this CLI process. Written once per session id.
 *
 * `secretPath` points at the broker's shared secret. It is a path and not the
 * secret itself because these args become the schema server's argv, which
 * every local user can read with `ps`.
 */
export function writeSessionMcpConfig(
  cliSessionId: string,
  schemaPath: string,
  handoffSocketPath?: string,
  secretPath?: string,
): string {
  const existing = sessionConfigPaths.get(cliSessionId);
  if (existing) return existing;
  const configPath = sessionConfigFilePath(cliSessionId);
  const args = handoffSocketPath
    ? [serverPath(), schemaPath, handoffSocketPath, cliSessionId, secretPath]
    : [serverPath(), schemaPath];
  const config = {
    mcpServers: {
      "custom-tools": { command: "node", args: args.filter(Boolean) },
    },
  };
  writeFileSync(configPath, JSON.stringify(config), {
    mode: RUNTIME_FILE_MODE,
  });
  sessionConfigPaths.set(cliSessionId, configPath);
  return configPath;
}

/** Remove one session's config file (the session will not be spawned again). */
export function removeSessionMcpConfig(cliSessionId: string): void {
  const path = sessionConfigPaths.get(cliSessionId);
  if (!path) return;
  sessionConfigPaths.delete(cliSessionId);
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/**
 * Remove every temp file. Registered on `process.on("exit")`, so it must stay
 * synchronous. A SIGKILLed process still leaks, exactly as it does for the
 * system-prompt file.
 */
export function cleanupMcpConfigFiles(): void {
  const paths = [
    schemaFilePath(),
    configFilePath(),
    ...sessionConfigPaths.values(),
  ];
  sessionConfigPaths.clear();
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {
      // Never written, or already gone — ignore
    }
  }
}

/** Test seam: forget what this process has already written. */
export function resetMcpConfigCache(): void {
  lastSchemaJson = undefined;
  schemaVersion = 0;
  configWritten = false;
  sessionConfigPaths.clear();
}
