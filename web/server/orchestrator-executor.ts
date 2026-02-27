import { randomUUID } from "node:crypto";
import type { CliLauncher, SdkSessionInfo } from "./cli-launcher.js";
import type { WsBridge } from "./ws-bridge.js";
import type { CLIResultMessage } from "./session-types.js";
import { containerManager } from "./container-manager.js";
import * as envManager from "./env-manager.js";
import * as sessionNames from "./session-names.js";
import * as orchestratorStore from "./orchestrator-store.js";
import type {
  OrchestratorConfig,
  OrchestratorRun,
  OrchestratorRunStatus,
  RunStage,
  RunStageStatus,
} from "./orchestrator-types.js";

/** Default stage timeout: 30 minutes */
const DEFAULT_STAGE_TIMEOUT_MS = 30 * 60_000;
/** Max time to wait for CLI to connect (ms) */
const CLI_CONNECT_TIMEOUT_MS = 30_000;
/** Poll interval when waiting for CLI connection */
const CLI_CONNECT_POLL_MS = 500;

export class OrchestratorExecutor {
  /** Track active runs in memory for quick lookup and cancellation */
  private activeRuns = new Map<string, {
    run: OrchestratorRun;
    currentSessionId?: string;
    cancelled: boolean;
  }>();

  constructor(
    private launcher: CliLauncher,
    private wsBridge: WsBridge,
  ) {}

  /**
   * Start a new orchestrator run. Creates a Docker container, then executes
   * each stage sequentially as child sessions inside the container.
   *
   * Returns the run immediately (in "pending" state). Execution proceeds
   * asynchronously — poll getRun() or the REST API for status updates.
   */
  async startRun(orchestratorId: string, input?: string): Promise<OrchestratorRun> {
    const config = orchestratorStore.getOrchestrator(orchestratorId);
    if (!config) throw new Error(`Orchestrator "${orchestratorId}" not found`);
    if (!config.enabled) throw new Error(`Orchestrator "${orchestratorId}" is disabled`);
    if (config.stages.length === 0) throw new Error("Orchestrator has no stages");

    // Validate Docker environment
    const env = envManager.getEnv(config.envSlug);
    if (!env) {
      throw new Error(`Environment "${config.envSlug}" not found — Docker is required for orchestrator runs`);
    }
    const image = env.imageTag || env.baseImage;
    if (!image) {
      throw new Error(`Environment "${config.envSlug}" has no Docker image configured`);
    }
    if (!containerManager.checkDocker()) {
      throw new Error("Docker is not available — orchestrator runs require Docker");
    }
    if (!containerManager.imageExists(image)) {
      throw new Error(`Docker image "${image}" not found locally — build or pull it first`);
    }

    // Create run record
    const runId = randomUUID();
    const stages: RunStage[] = config.stages.map((stage, index) => ({
      index,
      name: stage.name,
      status: "pending" as RunStageStatus,
    }));

    const run: OrchestratorRun = {
      id: runId,
      orchestratorId: config.id,
      orchestratorName: config.name,
      status: "pending",
      stages,
      input: input?.trim() || undefined,
      createdAt: Date.now(),
      totalCostUsd: 0,
    };
    orchestratorStore.createRun(run);

    // Track in memory for cancellation
    const activeEntry = { run, cancelled: false };
    this.activeRuns.set(runId, activeEntry);

    // Increment totalRuns on the config
    orchestratorStore.updateOrchestrator(config.id, {
      totalRuns: config.totalRuns + 1,
    });

    // Execute asynchronously — don't await here so the API can return immediately
    this.executeRun(runId, config, image, env, activeEntry).catch((err) => {
      console.error(`[orchestrator-executor] Unhandled error in run ${runId}:`, err);
    });

    return run;
  }

  /**
   * Cancel an active run. Kills the current stage's session and marks
   * the run as cancelled.
   */
  async cancelRun(runId: string): Promise<void> {
    const entry = this.activeRuns.get(runId);
    if (!entry) {
      // Run may have already completed — check store
      const run = orchestratorStore.getRun(runId);
      if (!run) throw new Error(`Run "${runId}" not found`);
      if (run.status !== "running" && run.status !== "pending") {
        throw new Error(`Run "${runId}" is not active (status: ${run.status})`);
      }
      return;
    }

    entry.cancelled = true;

    // Kill the currently running session
    if (entry.currentSessionId) {
      await this.launcher.kill(entry.currentSessionId);
    }
  }

  /** Get a run by ID (from store). */
  getRun(runId: string): OrchestratorRun | null {
    return orchestratorStore.getRun(runId);
  }

  /** Get all currently active (in-memory) run IDs. */
  getActiveRuns(): OrchestratorRun[] {
    const runs: OrchestratorRun[] = [];
    for (const entry of this.activeRuns.values()) {
      const fresh = orchestratorStore.getRun(entry.run.id);
      if (fresh) runs.push(fresh);
    }
    return runs;
  }

  // ── Private execution logic ─────────────────────────────────────────────

  private async executeRun(
    runId: string,
    config: OrchestratorConfig,
    image: string,
    env: ReturnType<typeof envManager.getEnv> & {},
    activeEntry: { run: OrchestratorRun; currentSessionId?: string; cancelled: boolean },
  ): Promise<void> {
    const containerMode = config.containerMode || "shared";
    let sharedContainerId: string | undefined;
    let sharedContainerName: string | undefined;

    try {
      // Container setup for shared mode
      if (containerMode === "shared") {
        const containerResult = await this.setupContainer(runId, config, image, env);
        sharedContainerId = containerResult.containerId;
        sharedContainerName = containerResult.containerName;

        this.updateRun(runId, {
          status: "running",
          startedAt: Date.now(),
          containerId: sharedContainerId,
          containerName: sharedContainerName,
        });
      } else {
        this.updateRun(runId, {
          status: "running",
          startedAt: Date.now(),
        });
      }

      // Execute each stage sequentially
      let totalCost = 0;
      for (let i = 0; i < config.stages.length; i++) {
        if (activeEntry.cancelled) {
          this.skipRemainingStages(runId, i);
          this.updateRun(runId, {
            status: "cancelled",
            completedAt: Date.now(),
            totalCostUsd: totalCost,
          });
          return;
        }

        const stageConfig = config.stages[i];
        let stageContainerId = sharedContainerId;
        let stageContainerName = sharedContainerName;

        // Per-stage container mode: create a fresh container for each stage
        if (containerMode === "per-stage") {
          const containerResult = await this.setupContainer(
            `${runId}-stage-${i}`,
            config,
            image,
            env,
          );
          stageContainerId = containerResult.containerId;
          stageContainerName = containerResult.containerName;
        }

        if (!stageContainerId || !stageContainerName) {
          throw new Error("No container available for stage execution");
        }

        const stageResult = await this.executeStage(
          runId,
          config,
          stageConfig,
          i,
          stageContainerId,
          stageContainerName,
          activeEntry,
        );

        if (stageResult.costUsd) {
          totalCost += stageResult.costUsd;
        }

        // Per-stage cleanup
        if (containerMode === "per-stage") {
          containerManager.removeContainer(`${runId}-stage-${i}`);
        }

        // Check cancellation after stage completes (cancel may have occurred mid-stage)
        if (activeEntry.cancelled) {
          this.skipRemainingStages(runId, i + 1);
          this.updateRun(runId, {
            status: "cancelled",
            completedAt: Date.now(),
            totalCostUsd: totalCost,
          });
          return;
        }

        if (stageResult.status === "failed") {
          // Skip remaining stages
          this.skipRemainingStages(runId, i + 1);
          this.updateRun(runId, {
            status: "failed",
            completedAt: Date.now(),
            error: stageResult.error || "Stage failed",
            totalCostUsd: totalCost,
          });
          return;
        }
      }

      // All stages completed successfully
      this.updateRun(runId, {
        status: "completed",
        completedAt: Date.now(),
        totalCostUsd: totalCost,
      });
      console.log(`[orchestrator-executor] Run ${runId} completed successfully (cost: $${totalCost.toFixed(4)})`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator-executor] Run ${runId} failed:`, errorMsg);
      this.updateRun(runId, {
        status: "failed",
        completedAt: Date.now(),
        error: errorMsg,
      });
    } finally {
      // Clean up shared container if it exists
      if (containerMode === "shared" && sharedContainerId) {
        try {
          containerManager.removeContainer(runId);
        } catch (err) {
          console.error(`[orchestrator-executor] Failed to remove shared container for run ${runId}:`, err);
        }
      }
      this.activeRuns.delete(runId);
    }
  }

  private async setupContainer(
    trackingKey: string,
    config: OrchestratorConfig,
    image: string,
    env: ReturnType<typeof envManager.getEnv> & {},
  ): Promise<{ containerId: string; containerName: string }> {
    console.log(`[orchestrator-executor] Creating container for ${trackingKey} with image ${image}`);

    // Merge env variables from environment profile + orchestrator config
    const envVars: Record<string, string> = {
      ...(env.variables || {}),
      ...(config.env || {}),
    };

    const containerInfo = containerManager.createContainer(trackingKey, config.cwd, {
      image,
      ports: env.ports || [],
      volumes: env.volumes,
      env: Object.keys(envVars).length > 0 ? envVars : undefined,
    });

    // Copy workspace files into the container
    await containerManager.copyWorkspaceToContainer(containerInfo.containerId, config.cwd);
    containerManager.reseedGitAuth(containerInfo.containerId);

    // Run init script if configured
    if (env.initScript?.trim()) {
      console.log(`[orchestrator-executor] Running init script in container for ${trackingKey}`);
      const result = await containerManager.execInContainerAsync(
        containerInfo.containerId,
        ["bash", "-lc", env.initScript],
        { timeout: 120_000 },
      );
      if (result.exitCode !== 0) {
        console.warn(`[orchestrator-executor] Init script exited with code ${result.exitCode}: ${result.output.slice(0, 200)}`);
      }
    }

    return {
      containerId: containerInfo.containerId,
      containerName: containerInfo.name,
    };
  }

  private async executeStage(
    runId: string,
    config: OrchestratorConfig,
    stageConfig: { name: string; prompt: string; model?: string; permissionMode?: string; allowedTools?: string[]; timeout?: number },
    stageIndex: number,
    containerId: string,
    containerName: string,
    activeEntry: { run: OrchestratorRun; currentSessionId?: string; cancelled: boolean },
  ): Promise<{ status: RunStageStatus; costUsd?: number; error?: string }> {
    const totalStages = config.stages.length;
    console.log(`[orchestrator-executor] Run ${runId}: starting stage ${stageIndex + 1}/${totalStages} "${stageConfig.name}"`);

    // Mark stage as running
    this.updateStage(runId, stageIndex, {
      status: "running",
      startedAt: Date.now(),
    });

    try {
      // Launch child session inside the container
      const model = stageConfig.model || config.defaultModel;
      const permissionMode = stageConfig.permissionMode || config.defaultPermissionMode;
      const allowedTools = stageConfig.allowedTools || config.allowedTools;

      const sessionInfo: SdkSessionInfo = this.launcher.launch({
        model,
        permissionMode,
        cwd: config.cwd,
        backendType: config.backendType,
        containerId,
        containerName,
        containerCwd: "/workspace",
        allowedTools,
        env: config.env,
      });

      const sessionId = sessionInfo.sessionId;
      activeEntry.currentSessionId = sessionId;

      // Update stage with session ID
      this.updateStage(runId, stageIndex, { sessionId });

      // Set session name for UI visibility
      sessionNames.setName(sessionId, `🎭 ${config.name} / ${stageConfig.name}`);

      // Wait for CLI to connect
      await this.waitForCLIConnection(sessionId);

      // Build prompt
      const run = orchestratorStore.getRun(runId);
      let prompt = `[orchestrator:${config.id}] Stage ${stageIndex + 1}/${totalStages}: ${stageConfig.name}\n\n${stageConfig.prompt}`;
      if (run?.input) {
        prompt += `\n\n--- Context ---\n${run.input}`;
      }

      // Inject prompt
      this.wsBridge.injectUserMessage(sessionId, prompt);

      // Await completion with timeout
      const timeout = stageConfig.timeout || DEFAULT_STAGE_TIMEOUT_MS;
      const result = await this.waitForResult(sessionId, timeout);

      activeEntry.currentSessionId = undefined;

      const costUsd = result.total_cost_usd || 0;
      const isError = result.is_error === true;

      this.updateStage(runId, stageIndex, {
        status: isError ? "failed" : "completed",
        completedAt: Date.now(),
        costUsd,
        error: isError ? (result.errors?.join("; ") || "Stage returned an error") : undefined,
      });

      return {
        status: isError ? "failed" : "completed",
        costUsd,
        error: isError ? (result.errors?.join("; ") || "Stage returned an error") : undefined,
      };
    } catch (err) {
      activeEntry.currentSessionId = undefined;
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[orchestrator-executor] Stage ${stageIndex} failed:`, errorMsg);

      this.updateStage(runId, stageIndex, {
        status: "failed",
        completedAt: Date.now(),
        error: errorMsg,
      });

      return { status: "failed", error: errorMsg };
    }
  }

  /** Wait for CLI to be connected (poll up to timeout). */
  private async waitForCLIConnection(sessionId: string): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < CLI_CONNECT_TIMEOUT_MS) {
      const info = this.launcher.getSession(sessionId);
      if (info && (info.state === "connected" || info.state === "running")) {
        return;
      }
      if (info?.state === "exited") {
        throw new Error(`CLI process exited before connecting (exit code: ${info.exitCode})`);
      }
      await new Promise((r) => setTimeout(r, CLI_CONNECT_POLL_MS));
    }

    throw new Error(`CLI process did not connect within ${CLI_CONNECT_TIMEOUT_MS / 1000}s`);
  }

  /** Wait for a result message on a session, with timeout. */
  private waitForResult(sessionId: string, timeoutMs: number): Promise<CLIResultMessage> {
    return new Promise<CLIResultMessage>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubscribe) unsubscribe();
      };

      unsubscribe = this.wsBridge.onResultMessage(sessionId, (msg) => {
        cleanup();
        resolve(msg);
      });

      timeoutId = setTimeout(() => {
        cleanup();
        // Kill the timed-out session
        this.launcher.kill(sessionId).catch(() => {});
        reject(new Error(`Stage timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
    });
  }

  /** Update a run in the store and refresh in-memory reference. */
  private updateRun(runId: string, updates: Partial<OrchestratorRun>): void {
    orchestratorStore.updateRun(runId, updates);
  }

  /** Update a specific stage within a run. */
  private updateStage(runId: string, stageIndex: number, updates: Partial<RunStage>): void {
    const run = orchestratorStore.getRun(runId);
    if (!run || !run.stages[stageIndex]) return;

    const stages = [...run.stages];
    stages[stageIndex] = { ...stages[stageIndex], ...updates };
    orchestratorStore.updateRun(runId, { stages });
  }

  /** Mark all stages from startIndex onwards as skipped. */
  private skipRemainingStages(runId: string, startIndex: number): void {
    const run = orchestratorStore.getRun(runId);
    if (!run) return;

    const stages = [...run.stages];
    for (let i = startIndex; i < stages.length; i++) {
      if (stages[i].status === "pending") {
        stages[i] = { ...stages[i], status: "skipped" };
      }
    }
    orchestratorStore.updateRun(runId, { stages });
  }
}
