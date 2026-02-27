import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use vi.hoisted so the mock factory can reference tempHome after hoisting
const tempHome = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return mkdtempSync(join(tmpdir(), "orch-store-test-"));
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tempHome };
});

import {
  listOrchestrators,
  getOrchestrator,
  createOrchestrator,
  updateOrchestrator,
  deleteOrchestrator,
  listRuns,
  getRun,
  createRun,
  updateRun,
  deleteRun,
} from "./orchestrator-store.js";

import type { OrchestratorConfigCreateInput, OrchestratorRun } from "./orchestrator-types.js";

// ── Test Data ───────────────────────────────────────────────────────────────

function makeOrchestratorInput(overrides?: Partial<OrchestratorConfigCreateInput>): OrchestratorConfigCreateInput {
  return {
    version: 1,
    name: "Test Orchestrator",
    description: "A test orchestrator",
    stages: [
      { name: "Stage 1", prompt: "Do step 1" },
      { name: "Stage 2", prompt: "Do step 2" },
    ],
    backendType: "claude",
    defaultModel: "claude-sonnet-4-6",
    defaultPermissionMode: "bypassPermissions",
    cwd: "/tmp/test-repo",
    envSlug: "test-env",
    enabled: true,
    ...overrides,
  };
}

function makeRun(overrides?: Partial<OrchestratorRun>): OrchestratorRun {
  return {
    id: `run-${Date.now()}`,
    orchestratorId: "test-orchestrator",
    orchestratorName: "Test Orchestrator",
    status: "pending",
    stages: [
      { index: 0, name: "Stage 1", status: "pending" },
      { index: 1, name: "Stage 2", status: "pending" },
    ],
    createdAt: Date.now(),
    totalCostUsd: 0,
    ...overrides,
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

afterEach(() => {
  // Clean up orchestrators and runs directories between tests
  const orchDir = join(tempHome, ".companion", "orchestrators");
  const runsDir = join(tempHome, ".companion", "orchestrator-runs");
  try { rmSync(orchDir, { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(runsDir, { recursive: true, force: true }); } catch { /* ok */ }
});

// ── Orchestrator CRUD Tests ─────────────────────────────────────────────────

describe("orchestrator-store: orchestrator CRUD", () => {
  it("should create and retrieve an orchestrator", () => {
    const input = makeOrchestratorInput();
    const created = createOrchestrator(input);

    expect(created.id).toBe("test-orchestrator");
    expect(created.name).toBe("Test Orchestrator");
    expect(created.stages).toHaveLength(2);
    expect(created.envSlug).toBe("test-env");
    expect(created.createdAt).toBeGreaterThan(0);
    expect(created.updatedAt).toBeGreaterThan(0);
    expect(created.totalRuns).toBe(0);

    const fetched = getOrchestrator("test-orchestrator");
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe("Test Orchestrator");
  });

  it("should list orchestrators sorted by name", () => {
    createOrchestrator(makeOrchestratorInput({ name: "Zebra Orchestrator" }));
    createOrchestrator(makeOrchestratorInput({ name: "Alpha Orchestrator" }));

    const list = listOrchestrators();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("Alpha Orchestrator");
    expect(list[1].name).toBe("Zebra Orchestrator");
  });

  it("should reject duplicate names", () => {
    createOrchestrator(makeOrchestratorInput());
    expect(() => createOrchestrator(makeOrchestratorInput())).toThrow("already exists");
  });

  it("should reject missing name", () => {
    expect(() => createOrchestrator(makeOrchestratorInput({ name: "" }))).toThrow("name is required");
  });

  it("should reject empty stages", () => {
    expect(() => createOrchestrator(makeOrchestratorInput({ stages: [] }))).toThrow("At least one stage");
  });

  it("should reject missing envSlug", () => {
    expect(() => createOrchestrator(makeOrchestratorInput({ envSlug: "" }))).toThrow("Environment slug is required");
  });

  it("should update an orchestrator", () => {
    createOrchestrator(makeOrchestratorInput());

    const updated = updateOrchestrator("test-orchestrator", {
      description: "Updated description",
      totalRuns: 5,
    });

    expect(updated).not.toBeNull();
    expect(updated!.description).toBe("Updated description");
    expect(updated!.totalRuns).toBe(5);
    expect(updated!.updatedAt).toBeGreaterThanOrEqual(updated!.createdAt);
  });

  it("should handle rename with slug change", () => {
    createOrchestrator(makeOrchestratorInput());

    const updated = updateOrchestrator("test-orchestrator", { name: "Renamed Orchestrator" });
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe("renamed-orchestrator");
    expect(updated!.name).toBe("Renamed Orchestrator");

    // Old ID should no longer exist
    expect(getOrchestrator("test-orchestrator")).toBeNull();
    // New ID should exist
    expect(getOrchestrator("renamed-orchestrator")).not.toBeNull();
  });

  it("should return null when updating non-existent orchestrator", () => {
    expect(updateOrchestrator("non-existent", { description: "x" })).toBeNull();
  });

  it("should delete an orchestrator", () => {
    createOrchestrator(makeOrchestratorInput());
    expect(deleteOrchestrator("test-orchestrator")).toBe(true);
    expect(getOrchestrator("test-orchestrator")).toBeNull();
  });

  it("should return false when deleting non-existent orchestrator", () => {
    expect(deleteOrchestrator("non-existent")).toBe(false);
  });

  it("should return empty list when no orchestrators exist", () => {
    expect(listOrchestrators()).toEqual([]);
  });

  it("should return null when getting non-existent orchestrator", () => {
    expect(getOrchestrator("non-existent")).toBeNull();
  });
});

// ── Run CRUD Tests ──────────────────────────────────────────────────────────

describe("orchestrator-store: run CRUD", () => {
  it("should create and retrieve a run", () => {
    const run = makeRun({ id: "run-1" });
    const created = createRun(run);

    expect(created.id).toBe("run-1");
    expect(created.status).toBe("pending");
    expect(created.stages).toHaveLength(2);

    const fetched = getRun("run-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("run-1");
  });

  it("should list runs sorted by createdAt descending", () => {
    createRun(makeRun({ id: "run-old", createdAt: 1000 }));
    createRun(makeRun({ id: "run-new", createdAt: 2000 }));

    const runs = listRuns();
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBe("run-new");
    expect(runs[1].id).toBe("run-old");
  });

  it("should filter runs by orchestratorId", () => {
    createRun(makeRun({ id: "run-a", orchestratorId: "orch-a" }));
    createRun(makeRun({ id: "run-b", orchestratorId: "orch-b" }));

    const runs = listRuns("orch-a");
    expect(runs).toHaveLength(1);
    expect(runs[0].orchestratorId).toBe("orch-a");
  });

  it("should update a run", () => {
    createRun(makeRun({ id: "run-1" }));

    const updated = updateRun("run-1", {
      status: "running",
      startedAt: Date.now(),
    });

    expect(updated).not.toBeNull();
    expect(updated!.status).toBe("running");
    expect(updated!.startedAt).toBeGreaterThan(0);
  });

  it("should preserve immutable run fields on update", () => {
    const run = makeRun({ id: "run-1", orchestratorId: "orch-1" });
    createRun(run);

    const updated = updateRun("run-1", {
      id: "should-not-change" as string,
      orchestratorId: "should-not-change",
      createdAt: 0,
      status: "completed",
    });

    expect(updated).not.toBeNull();
    expect(updated!.id).toBe("run-1");
    expect(updated!.orchestratorId).toBe("orch-1");
    expect(updated!.createdAt).toBe(run.createdAt);
    expect(updated!.status).toBe("completed");
  });

  it("should return null when updating non-existent run", () => {
    expect(updateRun("non-existent", { status: "failed" })).toBeNull();
  });

  it("should delete a run", () => {
    createRun(makeRun({ id: "run-1" }));
    expect(deleteRun("run-1")).toBe(true);
    expect(getRun("run-1")).toBeNull();
  });

  it("should return false when deleting non-existent run", () => {
    expect(deleteRun("non-existent")).toBe(false);
  });

  it("should return empty list when no runs exist", () => {
    expect(listRuns()).toEqual([]);
  });
});
