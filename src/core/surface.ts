export type SurfaceCategory =
  "bootstrap" | "context" | "decisions" | "tasks" | "handoffs";

export interface SurfaceFeature {
  id: string;
  category: SurfaceCategory;
  name: string;
  description: string;
  cliCommand: string;
  mcpTool: string;
  profileRestricted?: boolean;
}

export interface DocumentedException {
  interface: "cli" | "mcp";
  name: string;
  reason: string;
}

export const SURFACE_FEATURES: readonly SurfaceFeature[] = [
  // 1. Bootstrap
  {
    id: "bootstrap.status",
    category: "bootstrap",
    name: "Workspace status",
    description:
      "Inspect workspace initialization, storage health, and manifest metadata.",
    cliCommand: "status",
    mcpTool: "context_status",
  },
  // 2. Context
  {
    id: "context.propose",
    category: "context",
    name: "Propose context item",
    description:
      "Propose a durable context item or operational state for the workspace.",
    cliCommand: "propose",
    mcpTool: "context_propose",
  },
  {
    id: "context.get",
    category: "context",
    name: "Get context item",
    description:
      "Retrieve a context item by its unique ID across all lifecycle states.",
    cliCommand: "get",
    mcpTool: "context_get",
  },
  {
    id: "context.search",
    category: "context",
    name: "Search context items",
    description:
      "Search workspace knowledge using SQLite FTS5 with BM25 ranking.",
    cliCommand: "search",
    mcpTool: "context_search",
  },
  {
    id: "context.pack",
    category: "context",
    name: "Context pack retrieval",
    description:
      "Retrieve a deterministic, token-budgeted pack of approved workspace context.",
    cliCommand: "pack",
    mcpTool: "context_pack",
  },
  {
    id: "context.archive",
    category: "context",
    name: "Archive context item",
    description:
      "Archive an approved context item when it is no longer relevant.",
    cliCommand: "archive",
    mcpTool: "context_archive",
  },
  {
    id: "context.approve",
    category: "context",
    name: "Approve context item",
    description:
      "Approve a proposed durable context item through the approval gate.",
    cliCommand: "approve",
    mcpTool: "context_approve",
    profileRestricted: true,
  },
  // 3. Decisions
  {
    id: "decisions.propose",
    category: "decisions",
    name: "Propose decision",
    description:
      "Propose an architectural or product decision with rationale and supersession.",
    cliCommand: "decision",
    mcpTool: "decision_propose",
  },
  // 4. Tasks
  {
    id: "tasks.create",
    category: "tasks",
    name: "Create task",
    description: "Create a coordination task with scope and title.",
    cliCommand: "task create",
    mcpTool: "task_create",
  },
  {
    id: "tasks.claim",
    category: "tasks",
    name: "Claim task lease",
    description:
      "Claim, renew, or takeover a single-machine task lease with TTL.",
    cliCommand: "task claim",
    mcpTool: "task_claim",
  },
  {
    id: "tasks.release",
    category: "tasks",
    name: "Release task lease",
    description: "Release an active task lease and transition task status.",
    cliCommand: "task release",
    mcpTool: "task_release",
  },
  {
    id: "tasks.get",
    category: "tasks",
    name: "Get task",
    description: "Retrieve task record along with active lease state.",
    cliCommand: "task get",
    mcpTool: "task_get",
  },
  // 5. Handoffs
  {
    id: "handoffs.create",
    category: "handoffs",
    name: "Create handoff",
    description:
      "Record an evidence-bearing structured handoff across a context boundary.",
    cliCommand: "handoff create",
    mcpTool: "handoff_create",
  },
  {
    id: "handoffs.get",
    category: "handoffs",
    name: "Get handoff",
    description:
      "Retrieve structured handoff narrative, metadata, and evidence by ID.",
    cliCommand: "handoff get",
    mcpTool: "handoff_get",
  },
  {
    id: "handoffs.resume",
    category: "handoffs",
    name: "Resume handoff",
    description:
      "Resume work from a handoff by claiming task lease and reading handoff context.",
    cliCommand: "resume",
    mcpTool: "handoff_resume",
  },
] as const;

export const DOCUMENTED_EXCEPTIONS: readonly DocumentedException[] = [
  {
    interface: "cli",
    name: "init",
    reason:
      "Host filesystem workspace initialization executed in terminal before starting agent sessions. MCP operates inside an initialized workspace.",
  },
  {
    interface: "cli",
    name: "mcp",
    reason:
      "CLI transport launcher that serves the MCP protocol over stdio. An MCP session cannot nest its own transport runner.",
  },
  {
    interface: "cli",
    name: "reindex",
    reason:
      "Offline administrative maintenance command for rebuilding SQLite search index from Markdown files.",
  },
  {
    interface: "cli",
    name: "reconcile",
    reason:
      "Offline administrative maintenance command for reconciling external Markdown knowledge edits with SQLite operational state.",
  },
  {
    interface: "cli",
    name: "connect",
    reason:
      "Host client configuration utility for writing MCP server definitions into external host configs (Claude, Codex, Cursor) or printing generic MCP blocks. An MCP session cannot configure external host launch files.",
  },
] as const;

export interface ParityReport {
  passed: boolean;
  mcpToolCount: number;
  expectedToolCount: number;
  undocumentedCliCommands: string[];
  undocumentedMcpTools: string[];
  missingCliImplementations: string[];
  missingMcpImplementations: string[];
}

export function verifySurfaceParity(
  registeredCliCommands: string[],
  registeredMcpTools: string[],
  options?: { elevated?: boolean },
): ParityReport {
  const isElevated = options?.elevated ?? false;

  const expectedMcpFeatures = SURFACE_FEATURES.filter(
    (f) => !f.profileRestricted || isElevated,
  );
  const expectedMcpToolNames = new Set(
    expectedMcpFeatures.map((f) => f.mcpTool),
  );

  const cliExceptionNames = new Set(
    DOCUMENTED_EXCEPTIONS.filter((e) => e.interface === "cli").map(
      (e) => e.name,
    ),
  );
  const mcpExceptionNames = new Set(
    DOCUMENTED_EXCEPTIONS.filter((e) => e.interface === "mcp").map(
      (e) => e.name,
    ),
  );

  const registeredCliSet = new Set(registeredCliCommands);
  const registeredMcpSet = new Set(registeredMcpTools);

  // Check for undocumented CLI commands
  const undocumentedCliCommands: string[] = [];
  for (const cmd of registeredCliCommands) {
    const isMapped = SURFACE_FEATURES.some(
      (f) => f.cliCommand === cmd || f.cliCommand.startsWith(`${cmd} `),
    );
    const isException = cliExceptionNames.has(cmd);
    if (!isMapped && !isException) {
      undocumentedCliCommands.push(cmd);
    }
  }

  // Check for undocumented MCP tools
  const undocumentedMcpTools: string[] = [];
  for (const tool of registeredMcpTools) {
    const isMapped = SURFACE_FEATURES.some((f) => f.mcpTool === tool);
    const isException = mcpExceptionNames.has(tool);
    if (!isMapped && !isException) {
      undocumentedMcpTools.push(tool);
    }
  }

  // Check that expected MCP tools are actually registered
  const missingMcpImplementations: string[] = [];
  for (const expectedTool of expectedMcpToolNames) {
    if (!registeredMcpSet.has(expectedTool)) {
      missingMcpImplementations.push(expectedTool);
    }
  }

  // Check that expected CLI commands are registered
  const missingCliImplementations: string[] = [];
  for (const feature of SURFACE_FEATURES) {
    const rootCliCmd = feature.cliCommand.split(" ")[0]!;
    if (!registeredCliSet.has(rootCliCmd)) {
      missingCliImplementations.push(feature.cliCommand);
    }
  }

  const passed =
    undocumentedCliCommands.length === 0 &&
    undocumentedMcpTools.length === 0 &&
    missingCliImplementations.length === 0 &&
    missingMcpImplementations.length === 0 &&
    registeredMcpTools.length === expectedMcpFeatures.length;

  return {
    passed,
    mcpToolCount: registeredMcpTools.length,
    expectedToolCount: expectedMcpFeatures.length,
    undocumentedCliCommands,
    undocumentedMcpTools,
    missingCliImplementations,
    missingMcpImplementations,
  };
}
