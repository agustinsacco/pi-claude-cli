/**
 * Custom tool discovery and MCP config file generation.
 *
 * Discovers non-built-in tools from pi, writes their schemas to a temp file,
 * and generates an MCP config that points to the schema-only MCP server.
 */

import { writeFileSync } from "node:fs";
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

/**
 * Tools reached through a native CLI tool instead of the custom-tools MCP
 * server. `ask_user` bridges from the CLI's own AskUserQuestion (see
 * tool-mapping.ts); advertising it here too would show the model two
 * near-identical question tools.
 */
const NATIVELY_BRIDGED_TOOL_NAMES = new Set(["ask_user"]);

/** A custom tool definition with MCP-compatible schema. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

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
    .filter(
      (tool: any) =>
        !BUILT_IN_TOOL_NAMES.has(tool.name) &&
        !NATIVELY_BRIDGED_TOOL_NAMES.has(tool.name),
    )
    .map((tool: any) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    }));
}

/**
 * Write MCP config and tool schemas to temp files.
 *
 * Creates two temp files:
 * 1. Schema file: JSON array of tool definitions
 * 2. Config file: MCP config pointing to the schema-only server
 *
 * @param toolDefs - Array of custom tool definitions
 * @returns Path to the MCP config file
 */
export function writeMcpConfig(toolDefs: McpToolDef[]): string {
  // Write tool schemas to temp file
  const schemaFilePath = join(
    tmpdir(),
    `pi-claude-mcp-schemas-${process.pid}.json`,
  );
  writeFileSync(schemaFilePath, JSON.stringify(toolDefs));

  // Resolve path to the schema server .cjs file (sibling of this module)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const serverPath = join(__dirname, "mcp-schema-server.cjs");

  // Build MCP config
  const config = {
    mcpServers: {
      "custom-tools": {
        command: "node",
        args: [serverPath, schemaFilePath],
      },
    },
  };

  // Write config to temp file
  const configFilePath = join(
    tmpdir(),
    `pi-claude-mcp-config-${process.pid}.json`,
  );
  writeFileSync(configFilePath, JSON.stringify(config));

  return configFilePath;
}
