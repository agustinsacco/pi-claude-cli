import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist mock references so they survive vi.mock hoisting
const mocks = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  tmpdir: vi.fn(() => "/tmp"),
}));

// Mock node:fs writeFileSync/unlinkSync to avoid disk I/O
vi.mock("node:fs", () => ({
  writeFileSync: mocks.writeFileSync,
  unlinkSync: mocks.unlinkSync,
}));

// Mock node:os tmpdir
vi.mock("node:os", () => ({
  tmpdir: mocks.tmpdir,
}));

import {
  getCustomToolDefs,
  writeMcpConfig,
  cleanupMcpConfigFiles,
  resetMcpConfigCache,
} from "../src/mcp-config";
import type { McpToolDef } from "../src/mcp-config";

describe("getCustomToolDefs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters out all 6 built-in tools and returns only custom tools", () => {
    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "read",
          description: "Read file",
          parameters: { type: "object" },
        },
        {
          name: "write",
          description: "Write file",
          parameters: { type: "object" },
        },
        {
          name: "edit",
          description: "Edit file",
          parameters: { type: "object" },
        },
        {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object" },
        },
        { name: "grep", description: "Search", parameters: { type: "object" } },
        {
          name: "find",
          description: "Find files",
          parameters: { type: "object" },
        },
        {
          name: "search",
          description: "Custom search tool",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
          },
        },
        {
          name: "deploy",
          description: "Deploy app",
          parameters: {
            type: "object",
            properties: { target: { type: "string" } },
          },
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("search");
    expect(result[1].name).toBe("deploy");
  });

  it("returns empty array when all tools are built-in", () => {
    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "read",
          description: "Read file",
          parameters: { type: "object" },
        },
        {
          name: "write",
          description: "Write file",
          parameters: { type: "object" },
        },
        {
          name: "edit",
          description: "Edit file",
          parameters: { type: "object" },
        },
        {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object" },
        },
        { name: "grep", description: "Search", parameters: { type: "object" } },
        {
          name: "find",
          description: "Find files",
          parameters: { type: "object" },
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("includes custom tool with correct name, description, inputSchema from parameters", () => {
    const customParams = {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number" },
      },
      required: ["query"],
    };

    const mockPi = {
      getAllTools: vi.fn(() => [
        {
          name: "custom_search",
          description: "Search the codebase",
          parameters: customParams,
        },
      ]),
    };

    const result = getCustomToolDefs(mockPi);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("custom_search");
    expect(result[0].description).toBe("Search the codebase");
    expect(result[0].inputSchema).toBe(customParams);
  });

  it("handles pi.getAllTools() returning empty array", () => {
    const mockPi = {
      getAllTools: vi.fn(() => []),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("returns empty array when pi.getAllTools() returns undefined", () => {
    const mockPi = {
      getAllTools: vi.fn(() => undefined),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });

  it("returns empty array when pi.getAllTools() returns null", () => {
    const mockPi = {
      getAllTools: vi.fn(() => null),
    };

    const result = getCustomToolDefs(mockPi);
    expect(result).toEqual([]);
  });
});

describe("writeMcpConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetMcpConfigCache();
  });

  it("writes schema file to tmpdir with correct content (JSON array of tool defs)", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    // First writeFileSync call is the schema file
    const schemaCall = mocks.writeFileSync.mock.calls[0];
    expect(schemaCall[0]).toMatch(/pi-claude-mcp-schemas/);
    expect(JSON.parse(schemaCall[1])).toEqual(toolDefs);
  });

  it("writes config file to tmpdir with mcpServers.custom-tools entry", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    // Second writeFileSync call is the config file
    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    expect(config).toHaveProperty("mcpServers");
    expect(config.mcpServers).toHaveProperty("custom-tools");
  });

  it("config uses 'command': 'node' format (not 'type': 'http')", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    const server = config.mcpServers["custom-tools"];

    expect(server.command).toBe("node");
    expect(server).not.toHaveProperty("type");
  });

  it("config args include path to mcp-schema-server.cjs and schema file path", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    writeMcpConfig(toolDefs);

    const configCall = mocks.writeFileSync.mock.calls[1];
    const config = JSON.parse(configCall[1]);
    const server = config.mcpServers["custom-tools"];

    expect(server.args).toHaveLength(2);
    // First arg should be the server .cjs path (normalize separators for Windows)
    expect(server.args[0].replace(/\\/g, "/")).toContain(
      "mcp-schema-server.cjs",
    );
    // Second arg should be the schema file path
    expect(server.args[1]).toMatch(/pi-claude-mcp-schemas/);
  });

  it("returns the config file path", () => {
    const toolDefs: McpToolDef[] = [
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object" },
      },
    ];

    const result = writeMcpConfig(toolDefs);

    expect(result.configPath).toMatch(/pi-claude-mcp-config/);
    expect(result.configPath).toMatch(/\.json$/);
    expect(result.changed).toBe(true);
  });
});

describe("writeMcpConfig refresh", () => {
  const defs = (description: string): McpToolDef[] => [
    { name: "mcp", description, inputSchema: { type: "object" } },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetMcpConfigCache();
  });

  it("does not rewrite either file when the tool surface is unchanged", () => {
    writeMcpConfig(defs("Servers: linear"));
    const afterFirst = mocks.writeFileSync.mock.calls.length;

    const second = writeMcpConfig(defs("Servers: linear"));

    expect(second.changed).toBe(false);
    expect(mocks.writeFileSync.mock.calls.length).toBe(afterFirst);
  });

  it("rewrites the schema file when the tool surface changes", () => {
    writeMcpConfig(defs("Servers: linear"));
    mocks.writeFileSync.mockClear();

    const second = writeMcpConfig(defs("Servers: linear, notion"));

    expect(second.changed).toBe(true);
    const schemaWrites = mocks.writeFileSync.mock.calls.filter(
      (call: unknown[]) => /pi-claude-mcp-schemas/.test(String(call[0])),
    );
    expect(schemaWrites).toHaveLength(1);
    expect(JSON.parse(String(schemaWrites[0][1]))[0].description).toBe(
      "Servers: linear, notion",
    );
  });

  it("keeps a stable path across refreshes so temp files never accumulate", () => {
    const first = writeMcpConfig(defs("a"));
    const second = writeMcpConfig(defs("b"));

    expect(second.configPath).toBe(first.configPath);
    const schemaPaths = new Set(
      mocks.writeFileSync.mock.calls
        .map((call: unknown[]) => String(call[0]))
        .filter((path: string) => /pi-claude-mcp-schemas/.test(path)),
    );
    expect(schemaPaths.size).toBe(1);
  });

  it("writes the config file once, not on every refresh", () => {
    writeMcpConfig(defs("a"));
    mocks.writeFileSync.mockClear();

    writeMcpConfig(defs("b"));

    const configWrites = mocks.writeFileSync.mock.calls.filter(
      (call: unknown[]) => /pi-claude-mcp-config/.test(String(call[0])),
    );
    expect(configWrites).toHaveLength(0);
  });
});

describe("cleanupMcpConfigFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tmpdir.mockReturnValue("/tmp");
    resetMcpConfigCache();
  });

  it("unlinks both the schema and the config file", () => {
    writeMcpConfig([
      { name: "mcp", description: "d", inputSchema: { type: "object" } },
    ]);

    cleanupMcpConfigFiles();

    const removed = mocks.unlinkSync.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    expect(removed.some((p: string) => /pi-claude-mcp-schemas/.test(p))).toBe(
      true,
    );
    expect(removed.some((p: string) => /pi-claude-mcp-config/.test(p))).toBe(
      true,
    );
  });

  it("is safe when the files were never written", () => {
    mocks.unlinkSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => cleanupMcpConfigFiles()).not.toThrow();
  });
});
