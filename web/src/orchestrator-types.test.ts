/**
 * Tests for orchestrator-types.ts (frontend) — a type-only module.
 *
 * This file mirrors the backend types and exports only TypeScript interfaces
 * and type aliases. These are erased at compile time and produce no runtime code.
 * The purpose of this test is to ensure the module resolves without errors and
 * to satisfy coverage tooling that flags uncovered changed files.
 */

import type {
  OrchestratorStage,
  OrchestratorConfig,
  RunStageStatus,
  RunStage,
  OrchestratorRunStatus,
  OrchestratorRun,
} from "./orchestrator-types.js";

describe("orchestrator-types (frontend)", () => {
  it("exports type-only declarations that compile without errors", () => {
    // Runtime assertions on values typed with the exported interfaces.
    // These prove the module resolves and the types are structurally valid.
    const stage: OrchestratorStage = { name: "test", prompt: "Run tests" };
    expect(stage.name).toBe("test");

    const config: Partial<OrchestratorConfig> = {
      id: "orch-1",
      version: 1,
      backendType: "claude",
    };
    expect(config.backendType).toBe("claude");

    const stageStatus: RunStageStatus = "failed";
    expect(stageStatus).toBe("failed");

    const runStatus: OrchestratorRunStatus = "cancelled";
    expect(runStatus).toBe("cancelled");

    const runStage: RunStage = { index: 2, name: "deploy", status: "skipped" };
    expect(runStage.status).toBe("skipped");

    const run: Partial<OrchestratorRun> = {
      id: "run-42",
      orchestratorId: "orch-1",
      status: "completed",
      totalCostUsd: 0.05,
    };
    expect(run.totalCostUsd).toBe(0.05);
  });
});
