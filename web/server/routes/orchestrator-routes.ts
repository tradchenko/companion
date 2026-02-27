import type { Hono } from "hono";
import * as orchestratorStore from "../orchestrator-store.js";
import type { OrchestratorExecutor } from "../orchestrator-executor.js";
import type { OrchestratorConfig } from "../orchestrator-types.js";
import { containerManager } from "../container-manager.js";

/** Fields the user can set when creating/updating an orchestrator */
const EDITABLE_FIELDS = [
  "name", "description", "icon", "version",
  "stages", "backendType", "defaultModel", "defaultPermissionMode",
  "cwd", "envSlug", "env", "allowedTools", "containerMode", "enabled",
] as const;

function pickEditable(body: Record<string, unknown>): Partial<OrchestratorConfig> {
  const result: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in body) result[key] = body[key];
  }
  return result as Partial<OrchestratorConfig>;
}

export function registerOrchestratorRoutes(
  api: Hono,
  orchestratorExecutor?: OrchestratorExecutor,
): void {
  // ── Orchestrator CRUD ─────────────────────────────────────────────────

  api.get("/orchestrators", (c) => {
    return c.json(orchestratorStore.listOrchestrators());
  });

  api.get("/orchestrators/:id", (c) => {
    const orch = orchestratorStore.getOrchestrator(c.req.param("id"));
    if (!orch) return c.json({ error: "Orchestrator not found" }, 404);
    return c.json(orch);
  });

  api.post("/orchestrators", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const orch = orchestratorStore.createOrchestrator({
        version: 1,
        name: body.name || "",
        description: body.description || "",
        icon: body.icon,
        stages: body.stages || [],
        backendType: body.backendType || "claude",
        defaultModel: body.defaultModel || "",
        defaultPermissionMode: body.defaultPermissionMode || "bypassPermissions",
        cwd: body.cwd || "",
        envSlug: body.envSlug || "",
        env: body.env,
        allowedTools: body.allowedTools,
        containerMode: body.containerMode,
        enabled: body.enabled ?? true,
      });
      return c.json(orch, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.put("/orchestrators/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    try {
      const allowed = pickEditable(body);
      const orch = orchestratorStore.updateOrchestrator(id, allowed);
      if (!orch) return c.json({ error: "Orchestrator not found" }, 404);
      return c.json(orch);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/orchestrators/:id", (c) => {
    const deleted = orchestratorStore.deleteOrchestrator(c.req.param("id"));
    if (!deleted) return c.json({ error: "Orchestrator not found" }, 404);
    return c.json({ ok: true });
  });

  // ── Run Management ────────────────────────────────────────────────────

  api.post("/orchestrators/:id/run", async (c) => {
    const id = c.req.param("id");
    const orch = orchestratorStore.getOrchestrator(id);
    if (!orch) return c.json({ error: "Orchestrator not found" }, 404);
    if (!orchestratorExecutor) return c.json({ error: "Orchestrator executor not available" }, 500);

    const body = await c.req.json().catch(() => ({}));
    const input = typeof body.input === "string" ? body.input : undefined;

    try {
      const run = await orchestratorExecutor.startRun(id, input);
      return c.json(run, 201);
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.get("/orchestrators/:id/runs", (c) => {
    const id = c.req.param("id");
    return c.json(orchestratorStore.listRuns(id));
  });

  // ── Run Endpoints ─────────────────────────────────────────────────────

  api.get("/orchestrator-runs", (c) => {
    const status = c.req.query("status");
    let runs = orchestratorStore.listRuns();
    if (status) {
      runs = runs.filter((r) => r.status === status);
    }
    return c.json(runs);
  });

  api.get("/orchestrator-runs/:runId", (c) => {
    const run = orchestratorStore.getRun(c.req.param("runId"));
    if (!run) return c.json({ error: "Run not found" }, 404);
    return c.json(run);
  });

  api.post("/orchestrator-runs/:runId/cancel", async (c) => {
    const runId = c.req.param("runId");
    if (!orchestratorExecutor) return c.json({ error: "Orchestrator executor not available" }, 500);

    try {
      await orchestratorExecutor.cancelRun(runId);
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  api.delete("/orchestrator-runs/:runId", (c) => {
    const runId = c.req.param("runId");
    const run = orchestratorStore.getRun(runId);
    if (!run) return c.json({ error: "Run not found" }, 404);

    // Clean up container(s) if they exist
    if (run.containerId) {
      // Shared mode: single container with runId as key
      try {
        containerManager.removeContainer(runId);
      } catch {
        // Best-effort cleanup
      }
    } else {
      // Per-stage mode: try to clean up per-stage containers
      const orch = orchestratorStore.getOrchestrator(run.orchestratorId);
      if (orch) {
        for (let i = 0; i < orch.stages.length; i++) {
          try {
            containerManager.removeContainer(`${runId}-stage-${i}`);
          } catch {
            // Stage may not have run or already cleaned up
          }
        }
      }
    }

    const deleted = orchestratorStore.deleteRun(runId);
    if (!deleted) return c.json({ error: "Failed to delete run" }, 500);
    return c.json({ ok: true });
  });
}
