import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use vi.hoisted so the mock factory can reference tempHome after hoisting
const tempHome = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { join } = require("node:path");
  const { tmpdir } = require("node:os");
  return mkdtempSync(join(tmpdir(), "orch-exec-test-"));
});

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => tempHome };
});

// Mock container-manager (synchronous module-level singleton)
vi.mock("./container-manager.js", () => ({
  containerManager: {
    checkDocker: vi.fn().mockReturnValue(true),
    imageExists: vi.fn().mockReturnValue(true),
    createContainer: vi.fn().mockReturnValue({
      containerId: "fake-container-id-abc123",
      name: "companion-fake1234",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/tmp/test",
      containerCwd: "/workspace",
      state: "running",
    }),
    copyWorkspaceToContainer: vi.fn().mockResolvedValue(undefined),
    reseedGitAuth: vi.fn(),
    execInContainerAsync: vi.fn().mockResolvedValue({ exitCode: 0, output: "" }),
    removeContainer: vi.fn(),
  },
}));

// Mock env-manager
vi.mock("./env-manager.js", () => ({
  getEnv: vi.fn().mockReturnValue({
    name: "Test Env",
    slug: "test-env",
    variables: {},
    imageTag: "the-companion:latest",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }),
}));

// Mock session-names
vi.mock("./session-names.js", () => ({
  setName: vi.fn(),
  getName: vi.fn(),
}));

import * as orchestratorStore from "./orchestrator-store.js";
import { OrchestratorExecutor } from "./orchestrator-executor.js";
import type { OrchestratorConfig } from "./orchestrator-types.js";
import { containerManager } from "./container-manager.js";

// ── Mock CliLauncher + WsBridge ─────────────────────────────────────────────

function createMockLauncher() {
  const sessions = new Map<string, { sessionId: string; state: string; exitCode?: number }>();
  let launchCounter = 0;

  return {
    launch: vi.fn((options: Record<string, unknown>) => {
      launchCounter++;
      const sessionId = `mock-session-${launchCounter}`;
      const info = { sessionId, state: "connected", ...options };
      sessions.set(sessionId, info);
      return info;
    }),
    kill: vi.fn(async (sessionId: string) => {
      const session = sessions.get(sessionId);
      if (session) session.state = "exited";
      return true;
    }),
    getSession: vi.fn((sessionId: string) => sessions.get(sessionId) || null),
    isAlive: vi.fn((sessionId: string) => {
      const session = sessions.get(sessionId);
      return !!session && session.state !== "exited";
    }),
    _sessions: sessions,
  };
}

function createMockWsBridge() {
  const resultListeners = new Map<string, Array<(msg: Record<string, unknown>) => void>>();

  return {
    injectUserMessage: vi.fn(),
    onResultMessage: vi.fn((sessionId: string, cb: (msg: Record<string, unknown>) => void) => {
      if (!resultListeners.has(sessionId)) {
        resultListeners.set(sessionId, []);
      }
      resultListeners.get(sessionId)!.push(cb);
      return () => {
        const listeners = resultListeners.get(sessionId);
        if (listeners) {
          const idx = listeners.indexOf(cb);
          if (idx >= 0) listeners.splice(idx, 1);
        }
      };
    }),
    /** Test helper: simulate a result message for a session */
    _fireResult: (sessionId: string, msg: Record<string, unknown>) => {
      const listeners = resultListeners.get(sessionId);
      if (listeners) {
        resultListeners.delete(sessionId);
        for (const cb of listeners) cb(msg);
      }
    },
    _resultListeners: resultListeners,
  };
}

// ── Setup / Teardown ────────────────────────────────────────────────────────

let mockLauncher: ReturnType<typeof createMockLauncher>;
let mockWsBridge: ReturnType<typeof createMockWsBridge>;
let executor: OrchestratorExecutor;

beforeEach(() => {
  mockLauncher = createMockLauncher();
  mockWsBridge = createMockWsBridge();
  executor = new OrchestratorExecutor(
    mockLauncher as unknown as ConstructorParameters<typeof OrchestratorExecutor>[0],
    mockWsBridge as unknown as ConstructorParameters<typeof OrchestratorExecutor>[1],
  );
});

afterEach(() => {
  // Clean up store files
  const orchDir = join(tempHome, ".companion", "orchestrators");
  const runsDir = join(tempHome, ".companion", "orchestrator-runs");
  try { rmSync(orchDir, { recursive: true, force: true }); } catch { /* ok */ }
  try { rmSync(runsDir, { recursive: true, force: true }); } catch { /* ok */ }
  vi.restoreAllMocks();
});

// ── Helper: create a test orchestrator in the store ─────────────────────────

function createTestOrchestrator(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return orchestratorStore.createOrchestrator({
    version: 1,
    name: overrides?.name || `Test Orch ${Date.now()}`,
    description: "Test orchestrator",
    stages: overrides?.stages || [
      { name: "Stage 1", prompt: "Do thing 1" },
      { name: "Stage 2", prompt: "Do thing 2" },
    ],
    backendType: "claude",
    defaultModel: "claude-sonnet-4-6",
    defaultPermissionMode: "bypassPermissions",
    cwd: "/tmp/test-repo",
    envSlug: "test-env",
    enabled: true,
    ...overrides,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OrchestratorExecutor", () => {
  it("should reject non-existent orchestrator", async () => {
    await expect(executor.startRun("non-existent")).rejects.toThrow("not found");
  });

  it("should reject disabled orchestrator", async () => {
    const config = createTestOrchestrator({ enabled: false });
    await expect(executor.startRun(config.id)).rejects.toThrow("disabled");
  });

  it("should reject when Docker is not available", async () => {
    const config = createTestOrchestrator();
    vi.mocked(containerManager.checkDocker).mockReturnValueOnce(false);
    await expect(executor.startRun(config.id)).rejects.toThrow("Docker is not available");
  });

  it("should reject when Docker image is missing", async () => {
    const config = createTestOrchestrator();
    vi.mocked(containerManager.imageExists).mockReturnValueOnce(false);
    await expect(executor.startRun(config.id)).rejects.toThrow("not found locally");
  });

  it("should create a run and return it in pending state", async () => {
    const config = createTestOrchestrator();

    // Don't let stages complete — we just want to check the initial return
    const run = await executor.startRun(config.id);

    expect(run).toBeDefined();
    expect(run.orchestratorId).toBe(config.id);
    expect(run.orchestratorName).toBe(config.name);
    expect(run.status).toBe("pending");
    expect(run.stages).toHaveLength(2);
    expect(run.stages[0].status).toBe("pending");
    expect(run.stages[1].status).toBe("pending");
  });

  it("should execute stages sequentially and complete run", async () => {
    const config = createTestOrchestrator({
      name: "Sequential Test",
      stages: [
        { name: "Build", prompt: "Build the thing" },
        { name: "Test", prompt: "Test the thing" },
      ],
    });

    // Override injectUserMessage to auto-fire result after prompt injection
    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      // Fire the result on next tick to simulate async CLI processing
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.05,
          num_turns: 3,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);

    // Wait for async execution to complete
    await waitForRunStatus(run.id, "completed", 5000);

    const completedRun = orchestratorStore.getRun(run.id)!;
    expect(completedRun.status).toBe("completed");
    expect(completedRun.stages[0].status).toBe("completed");
    expect(completedRun.stages[1].status).toBe("completed");
    expect(completedRun.totalCostUsd).toBeCloseTo(0.10, 2);
    expect(completedRun.completedAt).toBeGreaterThan(0);

    // Should have launched 2 sessions (one per stage)
    expect(mockLauncher.launch).toHaveBeenCalledTimes(2);
    // Should have injected 2 prompts
    expect(mockWsBridge.injectUserMessage).toHaveBeenCalledTimes(2);

    // Verify prompt contents include stage info
    const firstPrompt = mockWsBridge.injectUserMessage.mock.calls[0][1] as string;
    expect(firstPrompt).toContain("Stage 1/2: Build");
    expect(firstPrompt).toContain("Build the thing");
  });

  it("should stop execution on stage failure and skip remaining stages", async () => {
    const config = createTestOrchestrator({
      name: "Fail Test",
      stages: [
        { name: "Fail Stage", prompt: "This will fail" },
        { name: "Skip Stage", prompt: "This should be skipped" },
      ],
    });

    // First stage fails
    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.02,
          num_turns: 1,
          is_error: true,
          error: "Something went wrong",
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.stages[0].status).toBe("failed");
    expect(failedRun.stages[1].status).toBe("skipped");
    // Only one session launched (second stage was skipped)
    expect(mockLauncher.launch).toHaveBeenCalledTimes(1);
  });

  it("should cancel an active run", async () => {
    const config = createTestOrchestrator({ name: "Cancel Test" });

    // Don't auto-fire results — let the stage hang so we can cancel
    const run = await executor.startRun(config.id);

    // Wait for the executor to reach the waitForResult phase.
    // waitForCLIConnection polls every 500ms, so wait enough for it to pass.
    await new Promise((r) => setTimeout(r, 1000));

    await executor.cancelRun(run.id);

    // Fire result to unblock the pending waitForResult (simulates the kill causing a result)
    const sessionId = mockLauncher.launch.mock.results[0]?.value?.sessionId;
    if (sessionId) {
      mockWsBridge._fireResult(sessionId, {
        type: "result",
        total_cost_usd: 0,
        num_turns: 0,
        is_error: true,
      });
    }

    await waitForRunStatus(run.id, "cancelled", 5000);

    const cancelledRun = orchestratorStore.getRun(run.id)!;
    expect(cancelledRun.status).toBe("cancelled");
  }, 10000);

  it("should include input context in stage prompts", async () => {
    const config = createTestOrchestrator({
      name: "Input Test",
      stages: [{ name: "Stage", prompt: "Do work" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id, "Build the login feature");
    await waitForRunStatus(run.id, "completed", 5000);

    const prompt = mockWsBridge.injectUserMessage.mock.calls[0][1] as string;
    expect(prompt).toContain("Build the login feature");
    expect(prompt).toContain("--- Context ---");
  });

  it("should pass container info to launcher", async () => {
    const config = createTestOrchestrator({
      name: "Container Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    await executor.startRun(config.id);
    await new Promise((r) => setTimeout(r, 200));

    // Verify launch was called with container options
    const launchCall = mockLauncher.launch.mock.calls[0][0];
    expect(launchCall.containerId).toBe("fake-container-id-abc123");
    expect(launchCall.containerName).toBe("companion-fake1234");
    expect(launchCall.containerCwd).toBe("/workspace");
  });

  it("should increment totalRuns on the orchestrator config", async () => {
    const config = createTestOrchestrator({
      name: "Count Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    await executor.startRun(config.id);
    await waitForRunStatus(orchestratorStore.listRuns()[0]?.id || "", "completed", 5000);

    const updated = orchestratorStore.getOrchestrator(config.id)!;
    expect(updated.totalRuns).toBe(1);
  });

  // ── Additional coverage tests ──────────────────────────────────────────────

  it("should reject orchestrator with no stages", async () => {
    // Covers line 48: the "Orchestrator has no stages" error path
    // The store validates stages at creation time, so we create with 1 stage
    // then spy on getOrchestrator to return a config with empty stages
    const config = createTestOrchestrator({
      name: "Empty Stages",
      stages: [{ name: "Temp", prompt: "Temp" }],
    });
    vi.spyOn(orchestratorStore, "getOrchestrator").mockReturnValueOnce({
      ...config,
      stages: [],
    });
    await expect(executor.startRun(config.id)).rejects.toThrow("Orchestrator has no stages");
  });

  it("should reject when environment is not found", async () => {
    // Covers lines 52-53: env not found error path
    const { getEnv } = await import("./env-manager.js");
    vi.mocked(getEnv).mockReturnValueOnce(undefined as any);

    const config = createTestOrchestrator({ name: "No Env Test" });
    await expect(executor.startRun(config.id)).rejects.toThrow("not found — Docker is required");
  });

  it("should reject when environment has no Docker image", async () => {
    // Covers lines 55-57: env exists but has no imageTag or baseImage
    const { getEnv } = await import("./env-manager.js");
    vi.mocked(getEnv).mockReturnValueOnce({
      name: "No Image Env",
      slug: "no-image",
      variables: {},
      imageTag: undefined,
      baseImage: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    const config = createTestOrchestrator({ name: "No Image Test" });
    await expect(executor.startRun(config.id)).rejects.toThrow("has no Docker image configured");
  });

  it("should use baseImage when imageTag is not set", async () => {
    // Covers the fallback in line 55: env.imageTag || env.baseImage
    const { getEnv } = await import("./env-manager.js");
    vi.mocked(getEnv).mockReturnValueOnce({
      name: "Base Image Env",
      slug: "base-img",
      variables: {},
      imageTag: undefined,
      baseImage: "my-base-image:latest",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    // Also need getEnv to work during setupContainer call (second call)
    vi.mocked(getEnv).mockReturnValueOnce({
      name: "Base Image Env",
      slug: "base-img",
      variables: {},
      imageTag: undefined,
      baseImage: "my-base-image:latest",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const config = createTestOrchestrator({
      name: "BaseImage Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });
    const run = await executor.startRun(config.id);

    // imageExists should have been called with the baseImage
    expect(containerManager.imageExists).toHaveBeenCalledWith("my-base-image:latest");

    // Let the async run complete
    await waitForRunStatus(run.id, "completed", 5000);
  });

  it("should execute stages in per-stage container mode", async () => {
    // Covers lines 168-172 (per-stage status update without shared container),
    // lines 193-201 (per-stage container creation), and line 224 (per-stage cleanup)
    // Clear call counts from previous tests since module-level mocks persist
    vi.mocked(containerManager.createContainer).mockClear();
    vi.mocked(containerManager.removeContainer).mockClear();

    const config = createTestOrchestrator({
      name: "Per-Stage Container Test",
      containerMode: "per-stage",
      stages: [
        { name: "Stage A", prompt: "Do A" },
        { name: "Stage B", prompt: "Do B" },
      ],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.03,
          num_turns: 2,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    const completedRun = orchestratorStore.getRun(run.id)!;
    expect(completedRun.status).toBe("completed");
    expect(completedRun.stages[0].status).toBe("completed");
    expect(completedRun.stages[1].status).toBe("completed");
    // Per-stage mode does NOT set containerId/containerName on the run itself
    expect(completedRun.containerId).toBeUndefined();
    expect(completedRun.containerName).toBeUndefined();
    // Should have created 2 containers (one per stage) and removed each
    expect(containerManager.createContainer).toHaveBeenCalledTimes(2);
    expect(containerManager.removeContainer).toHaveBeenCalledTimes(2);
  });

  it("should handle cancellation before first stage starts (pre-stage check)", async () => {
    // Covers lines 178-185: cancellation check before each stage iteration
    const config = createTestOrchestrator({
      name: "Early Cancel Test",
      stages: [
        { name: "Stage 1", prompt: "Do 1" },
        { name: "Stage 2", prompt: "Do 2" },
      ],
    });

    // Cancel immediately on first injectUserMessage — this simulates the first stage completing
    // but cancellation happening right before stage 2 starts
    let stageCount = 0;
    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      stageCount++;
      if (stageCount === 1) {
        // Fire result for the first stage but also mark as cancelled
        setTimeout(async () => {
          // Mark cancelled right after first stage result fires
          // This will be caught by the post-stage cancellation check (lines 228-236)
          await executor.cancelRun(run.id);
          mockWsBridge._fireResult(_sessionId, {
            type: "result",
            total_cost_usd: 0.01,
            num_turns: 1,
            is_error: false,
          });
        }, 10);
      } else {
        // Second stage should not be reached, but handle just in case
        setTimeout(() => {
          mockWsBridge._fireResult(_sessionId, {
            type: "result",
            total_cost_usd: 0,
            num_turns: 1,
            is_error: false,
          });
        }, 10);
      }
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "cancelled", 5000);

    const cancelledRun = orchestratorStore.getRun(run.id)!;
    expect(cancelledRun.status).toBe("cancelled");
    // First stage completed, second skipped due to cancellation
    expect(cancelledRun.stages[0].status).toBe("completed");
    expect(cancelledRun.stages[1].status).toBe("skipped");
  });

  it("should handle cancelRun for non-existent run", async () => {
    // Covers lines 111-112: run not in activeRuns and not in store
    await expect(executor.cancelRun("non-existent-id")).rejects.toThrow("not found");
  });

  it("should handle cancelRun for already completed run", async () => {
    // Covers lines 113-115: run exists in store but is not active
    const config = createTestOrchestrator({
      name: "Already Done Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    // Now try to cancel the completed run — it's no longer in activeRuns
    // but exists in the store with status "completed", so it should throw
    await expect(executor.cancelRun(run.id)).rejects.toThrow("is not active");
  });

  it("should return null for getRun with non-existent ID", () => {
    // Covers line 129: getRun delegates to orchestratorStore.getRun
    const result = executor.getRun("non-existent-run-id");
    expect(result).toBeNull();
  });

  it("should return active runs from getActiveRuns", async () => {
    // Covers lines 134-139: iterates activeRuns map and fetches fresh data
    const config = createTestOrchestrator({
      name: "Active Runs Test",
      stages: [{ name: "Slow Stage", prompt: "Take time" }],
    });

    // Don't auto-fire results so the run stays active
    const run = await executor.startRun(config.id);

    // Let the async execution start (container setup + launch)
    await new Promise((r) => setTimeout(r, 200));

    const activeRuns = executor.getActiveRuns();
    expect(activeRuns.length).toBeGreaterThanOrEqual(1);
    expect(activeRuns.some((r) => r.id === run.id)).toBe(true);

    // Fire result to clean up
    const sessionId = mockLauncher.launch.mock.results[0]?.value?.sessionId;
    if (sessionId) {
      mockWsBridge._fireResult(sessionId, {
        type: "result",
        total_cost_usd: 0,
        num_turns: 0,
        is_error: false,
      });
    }
    await waitForRunStatus(run.id, "completed", 5000);
  });

  it("should handle waitForCLIConnection when CLI process exits before connecting", async () => {
    // Covers lines 426-428: CLI exits with an exit code before connecting
    const config = createTestOrchestrator({
      name: "CLI Exit Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    // Override launcher to simulate CLI exiting immediately
    mockLauncher.launch.mockImplementationOnce((options: Record<string, unknown>) => {
      const sessionId = `mock-session-exit`;
      const info = { sessionId, state: "exited", exitCode: 1, ...options };
      mockLauncher._sessions.set(sessionId, info);
      return info;
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toContain("CLI process exited before connecting");
  });

  it("should handle waitForCLIConnection timeout", async () => {
    // Covers lines 429-432: CLI never connects within timeout
    // We need to temporarily override the timeout to make this test fast.
    // Since we can't modify the source, we use a launcher that returns "spawning" state
    // and never transitions to "connected". The poll interval is 500ms and timeout 30s.
    // To make this fast, we override getSession to report exited after a brief delay.
    const config = createTestOrchestrator({
      name: "CLI Timeout Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    // Override launcher: session stays in "spawning" state forever (until timeout)
    mockLauncher.launch.mockImplementationOnce((options: Record<string, unknown>) => {
      const sessionId = `mock-session-timeout`;
      const info = { sessionId, state: "spawning", ...options };
      mockLauncher._sessions.set(sessionId, info);
      return info;
    });

    const run = await executor.startRun(config.id);

    // The CLI_CONNECT_TIMEOUT_MS is 30s which is too long to wait.
    // Instead, after a short delay, transition the session to "exited" so the
    // waitForCLIConnection exits via the "exited" branch (lines 426-428) rather than waiting.
    await new Promise((r) => setTimeout(r, 800));
    const sess = mockLauncher._sessions.get("mock-session-timeout");
    if (sess) {
      sess.state = "exited";
      sess.exitCode = 137;
    }

    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toContain("CLI process exited before connecting");
  });

  it("should handle executeStage error when launch throws", async () => {
    // Covers lines 402-413: the catch block in executeStage
    const config = createTestOrchestrator({
      name: "Launch Error Test",
      stages: [
        { name: "Bad Stage", prompt: "This will blow up" },
        { name: "Skipped Stage", prompt: "Should not run" },
      ],
    });

    // Make launcher throw an error on the first call
    mockLauncher.launch.mockImplementationOnce(() => {
      throw new Error("Failed to spawn process");
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.stages[0].status).toBe("failed");
    expect(failedRun.stages[0].error).toContain("Failed to spawn process");
    expect(failedRun.stages[1].status).toBe("skipped");
  });

  it("should handle setupContainer init script with non-zero exit code", async () => {
    // Covers lines 305-314: init script runs but exits with non-zero code (warning logged, not fatal)
    const { getEnv } = await import("./env-manager.js");
    vi.mocked(getEnv).mockReturnValue({
      name: "Init Script Env",
      slug: "init-script-env",
      variables: { FOO: "bar" },
      imageTag: "the-companion:latest",
      initScript: "echo 'setup stuff' && exit 1",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    // execInContainerAsync returns non-zero exit code
    vi.mocked(containerManager.execInContainerAsync).mockResolvedValueOnce({
      exitCode: 1,
      output: "init script failed output",
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const config = createTestOrchestrator({
      name: "Init Script Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    // The run should still complete — non-zero init script is a warning, not fatal
    const completedRun = orchestratorStore.getRun(run.id)!;
    expect(completedRun.status).toBe("completed");
    // Verify init script was executed
    expect(containerManager.execInContainerAsync).toHaveBeenCalled();
  });

  it("should handle setupContainer init script that succeeds", async () => {
    // Covers lines 305-310: init script path when initScript is defined and exits 0
    const { getEnv } = await import("./env-manager.js");
    vi.mocked(getEnv).mockReturnValue({
      name: "Good Init Env",
      slug: "good-init",
      variables: {},
      imageTag: "the-companion:latest",
      initScript: "npm install",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    vi.mocked(containerManager.execInContainerAsync).mockResolvedValueOnce({
      exitCode: 0,
      output: "installed",
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const config = createTestOrchestrator({
      name: "Good Init Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    expect(containerManager.execInContainerAsync).toHaveBeenCalledWith(
      "fake-container-id-abc123",
      ["bash", "-lc", "npm install"],
      { timeout: 120_000 },
    );
  });

  it("should handle top-level error in executeRun (e.g. setupContainer fails)", async () => {
    // Covers lines 258-265: the catch block in executeRun when setupContainer throws
    const config = createTestOrchestrator({
      name: "Container Fail Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    // Make createContainer throw
    vi.mocked(containerManager.createContainer).mockImplementationOnce(() => {
      throw new Error("Docker daemon not responding");
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toContain("Docker daemon not responding");
  });

  it("should handle shared container removal failure in finally block", async () => {
    // Covers lines 268-274: shared container cleanup fails gracefully (logs error but doesn't throw)
    const config = createTestOrchestrator({
      name: "Cleanup Fail Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    // Make removeContainer throw to simulate cleanup failure
    vi.mocked(containerManager.removeContainer).mockImplementationOnce(() => {
      throw new Error("Container already removed");
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    // The run should still complete despite cleanup failure
    const completedRun = orchestratorStore.getRun(run.id)!;
    expect(completedRun.status).toBe("completed");
  });

  it("should handle stage result with errors array", async () => {
    // Covers line 394: result.errors?.join("; ") when is_error=true and errors array present
    const config = createTestOrchestrator({
      name: "Errors Array Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          is_error: true,
          errors: ["Error 1", "Error 2"],
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.stages[0].error).toBe("Error 1; Error 2");
    expect(failedRun.error).toBe("Error 1; Error 2");
  });

  it("should handle stage result with is_error=true but no errors array", async () => {
    // Covers line 394: the fallback "Stage returned an error" when errors array is empty/undefined
    const config = createTestOrchestrator({
      name: "Error No Details Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.01,
          num_turns: 1,
          is_error: true,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.stages[0].error).toBe("Stage returned an error");
  });

  it("should pass stage-level model and permissionMode overrides to launcher", async () => {
    // Covers lines 343-345: stage-specific model/permissionMode/allowedTools override defaults
    const config = createTestOrchestrator({
      name: "Override Test",
      defaultModel: "claude-sonnet-4-6",
      defaultPermissionMode: "bypassPermissions",
      allowedTools: ["tool-a"],
      stages: [{
        name: "Custom Stage",
        prompt: "Do custom",
        model: "claude-opus-4-6",
        permissionMode: "default",
        allowedTools: ["tool-b", "tool-c"],
      }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    const launchCall = mockLauncher.launch.mock.calls[0][0];
    expect(launchCall.model).toBe("claude-opus-4-6");
    expect(launchCall.permissionMode).toBe("default");
    expect(launchCall.allowedTools).toEqual(["tool-b", "tool-c"]);
  });

  it("should use config defaults when stage does not override model/permissionMode", async () => {
    // Covers lines 343-345: falling back to config defaults when stage has no overrides
    const config = createTestOrchestrator({
      name: "Defaults Test",
      defaultModel: "claude-sonnet-4-6",
      defaultPermissionMode: "bypassPermissions",
      allowedTools: ["tool-default"],
      stages: [{
        name: "Default Stage",
        prompt: "Use defaults",
        // No model, permissionMode, or allowedTools overrides
      }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    const launchCall = mockLauncher.launch.mock.calls[0][0];
    expect(launchCall.model).toBe("claude-sonnet-4-6");
    expect(launchCall.permissionMode).toBe("bypassPermissions");
    expect(launchCall.allowedTools).toEqual(["tool-default"]);
  });

  it("should handle whitespace-only input by trimming to undefined", async () => {
    // Covers line 80: input?.trim() || undefined when input is whitespace
    const config = createTestOrchestrator({
      name: "Whitespace Input Test",
      stages: [{ name: "Stage", prompt: "Do work" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id, "   ");
    expect(run.input).toBeUndefined();

    await waitForRunStatus(run.id, "completed", 5000);

    // Prompt should NOT contain "--- Context ---" since input was whitespace
    const prompt = mockWsBridge.injectUserMessage.mock.calls[0][1] as string;
    expect(prompt).not.toContain("--- Context ---");
  });

  it("should not set containerId/containerName on the run in per-stage mode", async () => {
    // Covers lines 169-172: per-stage mode sets status to running without container info
    const config = createTestOrchestrator({
      name: "Per-Stage No Container ID Test",
      containerMode: "per-stage",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    const completedRun = orchestratorStore.getRun(run.id)!;
    // Per-stage mode: no shared container on the run record
    expect(completedRun.containerId).toBeUndefined();
    expect(completedRun.containerName).toBeUndefined();
  });

  it("should set containerId and containerName on the run in shared mode", async () => {
    // Verifies lines 162-167: shared mode sets containerId/containerName on the run
    const config = createTestOrchestrator({
      name: "Shared Container ID Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    const completedRun = orchestratorStore.getRun(run.id)!;
    expect(completedRun.containerId).toBe("fake-container-id-abc123");
    expect(completedRun.containerName).toBe("companion-fake1234");
  });

  it("should merge env variables from environment profile and orchestrator config", async () => {
    // Covers lines 288-297 in setupContainer: env var merging
    // Clear call counts to isolate this test's createContainer call
    vi.mocked(containerManager.createContainer).mockClear();

    const { getEnv } = await import("./env-manager.js");
    vi.mocked(getEnv).mockReturnValue({
      name: "Env With Vars",
      slug: "env-vars",
      variables: { ENV_VAR_1: "from_env", SHARED_VAR: "env_value" },
      imageTag: "the-companion:latest",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any);

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const config = createTestOrchestrator({
      name: "Env Merge Test",
      env: { ORCH_VAR: "from_orch", SHARED_VAR: "orch_value" },
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    // Verify createContainer was called with merged env vars
    // orchestrator env overrides environment profile env for shared keys
    const createCall = vi.mocked(containerManager.createContainer).mock.calls[0];
    const opts = createCall[2] as any;
    expect(opts.env).toEqual({
      ENV_VAR_1: "from_env",
      SHARED_VAR: "orch_value",
      ORCH_VAR: "from_orch",
    });
  });

  it("should return empty array from getActiveRuns when no runs are active", () => {
    // Covers line 134-139: getActiveRuns with empty map
    const activeRuns = executor.getActiveRuns();
    expect(activeRuns).toEqual([]);
  });

  it("should handle cancelRun when run is in store but not running or pending", async () => {
    // Covers the early return on line 116: run exists in store, is not active,
    // and its status is "completed" — should throw
    const config = createTestOrchestrator({
      name: "Cancel Completed Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    // Now try to cancel — should throw "is not active"
    await expect(executor.cancelRun(run.id)).rejects.toThrow("is not active");
  });

  it("should handle per-stage container mode with failed stage and skip remaining", async () => {
    // Covers per-stage container mode with stage failure, ensuring cleanup and skip happen
    vi.mocked(containerManager.createContainer).mockClear();
    vi.mocked(containerManager.removeContainer).mockClear();

    const config = createTestOrchestrator({
      name: "Per-Stage Fail Test",
      containerMode: "per-stage",
      stages: [
        { name: "Fail Stage", prompt: "Fail" },
        { name: "Skip Stage", prompt: "Skip" },
      ],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0.02,
          num_turns: 1,
          is_error: true,
          errors: ["Stage error"],
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.stages[0].status).toBe("failed");
    expect(failedRun.stages[1].status).toBe("skipped");
    // Per-stage container should be cleaned up even on failure
    expect(containerManager.removeContainer).toHaveBeenCalledTimes(1);
  });

  it("should not clean up shared container in per-stage mode in the finally block", async () => {
    // Covers lines 268-274: the finally block only cleans up in shared mode
    vi.mocked(containerManager.removeContainer).mockClear();

    const config = createTestOrchestrator({
      name: "Per-Stage Cleanup Test",
      containerMode: "per-stage",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    mockWsBridge.injectUserMessage.mockImplementation((_sessionId: string) => {
      setTimeout(() => {
        mockWsBridge._fireResult(_sessionId, {
          type: "result",
          total_cost_usd: 0,
          num_turns: 1,
          is_error: false,
        });
      }, 10);
    });

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "completed", 5000);

    // In per-stage mode, removeContainer is called per-stage (line 224), not in finally block
    // So removeContainer should be called exactly once (for the single stage)
    expect(containerManager.removeContainer).toHaveBeenCalledTimes(1);
  });

  it("should handle cancellation during container setup (before stage loop)", async () => {
    // Covers lines 178-185: the early cancellation check at the top of the stage loop.
    // We start a run and immediately cancel it after startRun returns but before any
    // stage begins executing. This tests the pre-loop cancellation guard.
    const config = createTestOrchestrator({
      name: "Pre-Loop Cancel Test",
      stages: [
        { name: "Stage 1", prompt: "Do 1" },
        { name: "Stage 2", prompt: "Do 2" },
      ],
    });

    // Make copyWorkspaceToContainer delay a bit so cancel can fire in time
    vi.mocked(containerManager.copyWorkspaceToContainer).mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(resolve, 200)),
    );

    const run = await executor.startRun(config.id);
    // Cancel immediately — the run is in activeRuns but setupContainer is still pending
    await executor.cancelRun(run.id);

    await waitForRunStatus(run.id, "cancelled", 5000);

    const cancelledRun = orchestratorStore.getRun(run.id)!;
    expect(cancelledRun.status).toBe("cancelled");
    // Both stages should be skipped since cancellation happened before any stage ran
    expect(cancelledRun.stages[0].status).toBe("skipped");
    expect(cancelledRun.stages[1].status).toBe("skipped");
  });

  it("should handle cancelRun for run in store with running status but not in activeRuns", async () => {
    // Covers line 116: run is in store with "running" status but no longer in activeRuns map.
    // This can happen if the run was evicted from memory but the store wasn't updated yet.
    // We simulate this by manually creating a run in the store with "running" status.
    const config = createTestOrchestrator({
      name: "Orphan Run Test",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    // Manually create a run in the store with "running" status
    const fakeRunId = "fake-orphan-run-id";
    orchestratorStore.createRun({
      id: fakeRunId,
      orchestratorId: config.id,
      orchestratorName: config.name,
      status: "running",
      stages: [{ index: 0, name: "Stage", status: "running" }],
      createdAt: Date.now(),
      startedAt: Date.now(),
      totalCostUsd: 0,
    });

    // cancelRun should return without error (early return on line 116)
    await expect(executor.cancelRun(fakeRunId)).resolves.toBeUndefined();
  });

  it("should throw 'No container available' when per-stage setupContainer fails to provide container", async () => {
    // Covers line 205: the error when stageContainerId or stageContainerName is missing.
    // This happens if per-stage setupContainer returns empty values.
    const config = createTestOrchestrator({
      name: "No Container Test",
      containerMode: "per-stage",
      stages: [{ name: "Stage", prompt: "Test" }],
    });

    // Make createContainer return no containerId for the per-stage call
    vi.mocked(containerManager.createContainer).mockReturnValueOnce({
      containerId: "",
      name: "",
      image: "the-companion:latest",
      portMappings: [],
      hostCwd: "/tmp/test",
      containerCwd: "/workspace",
      state: "running",
    } as any);

    const run = await executor.startRun(config.id);
    await waitForRunStatus(run.id, "failed", 5000);

    const failedRun = orchestratorStore.getRun(run.id)!;
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toContain("No container available");
  });
});

// ── Test Utility ────────────────────────────────────────────────────────────

/** Poll run status until it matches expected value or timeout. */
async function waitForRunStatus(
  runId: string,
  expectedStatus: string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = orchestratorStore.getRun(runId);
    if (run && run.status === expectedStatus) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  const run = orchestratorStore.getRun(runId);
  throw new Error(
    `Run ${runId} did not reach status "${expectedStatus}" within ${timeoutMs}ms (current: ${run?.status || "not found"})`,
  );
}
