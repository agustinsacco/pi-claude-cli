/**
 * Custom tool discovery and MCP config file generation.
 *
 * Discovers non-built-in tools from pi, writes their schemas to a temp file,
 * and generates an MCP config that points to the schema-only MCP server.
 *
 * The schema file is refreshed whenever pi's tool surface changes. pi packages
 * register and unregister tools at runtime — pi-mcp-adapter re-registers its
 * `mcp` gateway with a new description every time an MCP server is added,
 * enabled or disabled — so a snapshot taken at the first turn goes stale for
 * the rest of the session. Both temp files keep a stable per-process path, so
 * refreshing rewrites in place instead of accumulating files.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

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

/** Serialized tool defs as of the last write, for change detection. */
let lastSchemaJson: string | undefined;
/** The config file's content never varies, so it is written once. */
let configWritten = false;

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
  return join(tmpdir(), `pi-claude-mcp-schemas-${process.pid}.json`);
}

/** Where this process stages the `--mcp-config` file pointing at them. */
function configFilePath(): string {
  return join(tmpdir(), `pi-claude-mcp-config-${process.pid}.json`);
}

/**
 * Write MCP config and tool schemas to temp files.
 *
 * Safe to call on every turn: the schema file is only rewritten when the tool
 * surface actually changed, and the config file only on the first call.
 *
 * @param toolDefs - Array of custom tool definitions
 * @returns The config file path, and whether this call rewrote the schemas
 */
export function writeMcpConfig(toolDefs: McpToolDef[]): McpConfigWrite {
  const configPath = configFilePath();
  const schemaJson = JSON.stringify(toolDefs);
  const changed = schemaJson !== lastSchemaJson;

  if (changed) {
    writeFileSync(schemaFilePath(), schemaJson);
    lastSchemaJson = schemaJson;
  }

  if (!configWritten) {
    // Resolve path to the schema server .cjs file (sibling of this module)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const serverPath = join(__dirname, "mcp-schema-server.cjs");

    const config = {
      mcpServers: {
        "custom-tools": {
          command: "node",
          args: [serverPath, schemaFilePath()],
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(config));
    configWritten = true;
  }

  return { configPath, changed };
}

/**
 * Remove both temp files. Registered on `process.on("exit")`, so it must stay
 * synchronous. A SIGKILLed process still leaks, exactly as it does for the
 * system-prompt file.
 */
export function cleanupMcpConfigFiles(): void {
  for (const path of [schemaFilePath(), configFilePath()]) {
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
  configWritten = false;
}
