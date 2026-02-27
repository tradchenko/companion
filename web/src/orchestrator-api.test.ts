// @vitest-environment jsdom
/**
 * Tests for orchestrator-api.ts — the REST API client for orchestrator CRUD and run management.
 *
 * Each test verifies that the correct URL, HTTP method, headers, and body are sent via fetch,
 * and that the parsed JSON response is returned. Error handling for non-ok responses is also covered.
 */

import { orchestratorApi } from "./orchestrator-api.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

/** Helper to build a mock Response-like object */
function mockResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(data),
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  // Clear any auth token between tests
  localStorage.removeItem("companion_auth_token");
});

// ===========================================================================
// Auth header injection
// ===========================================================================
describe("auth headers", () => {
  it("includes Authorization header when token exists in localStorage", async () => {
    localStorage.setItem("companion_auth_token", "test-token-123");
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await orchestratorApi.list();

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe("Bearer test-token-123");
  });

  it("omits Authorization header when no token is in localStorage", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await orchestratorApi.list();

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBeUndefined();
  });
});

// ===========================================================================
// list()
// ===========================================================================
describe("list", () => {
  it("sends GET to /api/orchestrators and returns parsed JSON array", async () => {
    const configs = [{ id: "orch-1", name: "Deploy Pipeline", stages: [] }];
    mockFetch.mockResolvedValueOnce(mockResponse(configs));

    const result = await orchestratorApi.list();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrators");
    expect(result).toEqual(configs);
  });
});

// ===========================================================================
// get()
// ===========================================================================
describe("get", () => {
  it("sends GET to /api/orchestrators/:id and returns parsed JSON", async () => {
    const config = { id: "orch-1", name: "Deploy Pipeline", stages: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(config));

    const result = await orchestratorApi.get("orch-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrators/orch-1");
    expect(result).toEqual(config);
  });
});

// ===========================================================================
// create()
// ===========================================================================
describe("create", () => {
  it("sends POST to /api/orchestrators with body and returns created config", async () => {
    const input = { name: "New Orch", description: "test", stages: [], backendType: "claude" as const };
    const created = { id: "new-orch", ...input, createdAt: 1, updatedAt: 1, totalRuns: 0, enabled: true };
    mockFetch.mockResolvedValueOnce(mockResponse(created));

    const result = await orchestratorApi.create(input);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrators");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual(input);
    expect(result).toEqual(created);
  });
});

// ===========================================================================
// update()
// ===========================================================================
describe("update", () => {
  it("sends PUT to /api/orchestrators/:id with body and returns updated config", async () => {
    const updates = { name: "Updated Name" };
    const updated = { id: "orch-1", name: "Updated Name", stages: [], createdAt: 1, updatedAt: 2 };
    mockFetch.mockResolvedValueOnce(mockResponse(updated));

    const result = await orchestratorApi.update("orch-1", updates);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrators/orch-1");
    expect(opts.method).toBe("PUT");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual(updates);
    expect(result).toEqual(updated);
  });
});

// ===========================================================================
// delete()
// ===========================================================================
describe("delete", () => {
  it("sends DELETE to /api/orchestrators/:id", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await orchestratorApi.delete("orch-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrators/orch-1");
    expect(opts.method).toBe("DELETE");
  });
});

// ===========================================================================
// startRun()
// ===========================================================================
describe("startRun", () => {
  it("sends POST to /api/orchestrators/:id/run with input and returns run", async () => {
    const run = { id: "run-1", orchestratorId: "orch-1", status: "pending", stages: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(run));

    const result = await orchestratorApi.startRun("orch-1", "Deploy to production");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrators/orch-1/run");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ input: "Deploy to production" });
    expect(result).toEqual(run);
  });

  it("sends empty body when input is not provided", async () => {
    const run = { id: "run-2", orchestratorId: "orch-1", status: "pending", stages: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(run));

    await orchestratorApi.startRun("orch-1");

    const [, opts] = mockFetch.mock.calls[0];
    expect(JSON.parse(opts.body)).toEqual({});
  });
});

// ===========================================================================
// listRuns()
// ===========================================================================
describe("listRuns", () => {
  it("sends GET to /api/orchestrators/:id/runs and returns array", async () => {
    const runs = [{ id: "run-1", orchestratorId: "orch-1", status: "completed" }];
    mockFetch.mockResolvedValueOnce(mockResponse(runs));

    const result = await orchestratorApi.listRuns("orch-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrators/orch-1/runs");
    expect(result).toEqual(runs);
  });
});

// ===========================================================================
// listAllRuns()
// ===========================================================================
describe("listAllRuns", () => {
  it("sends GET to /api/orchestrator-runs without status filter", async () => {
    const runs = [{ id: "run-1", status: "running" }, { id: "run-2", status: "completed" }];
    mockFetch.mockResolvedValueOnce(mockResponse(runs));

    const result = await orchestratorApi.listAllRuns();

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrator-runs");
    expect(result).toEqual(runs);
  });

  it("sends GET with status query param when provided", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse([]));

    await orchestratorApi.listAllRuns("running");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrator-runs?status=running");
  });
});

// ===========================================================================
// getRun()
// ===========================================================================
describe("getRun", () => {
  it("sends GET to /api/orchestrator-runs/:runId and returns run", async () => {
    const run = { id: "run-1", orchestratorId: "orch-1", status: "running", stages: [] };
    mockFetch.mockResolvedValueOnce(mockResponse(run));

    const result = await orchestratorApi.getRun("run-1");

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrator-runs/run-1");
    expect(result).toEqual(run);
  });
});

// ===========================================================================
// cancelRun()
// ===========================================================================
describe("cancelRun", () => {
  it("sends POST to /api/orchestrator-runs/:runId/cancel", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await orchestratorApi.cancelRun("run-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrator-runs/run-1/cancel");
    expect(opts.method).toBe("POST");
  });
});

// ===========================================================================
// deleteRun()
// ===========================================================================
describe("deleteRun", () => {
  it("sends DELETE to /api/orchestrator-runs/:runId", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ ok: true }));

    await orchestratorApi.deleteRun("run-1");

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("/api/orchestrator-runs/run-1");
    expect(opts.method).toBe("DELETE");
  });
});

// ===========================================================================
// Error handling — non-ok responses
// ===========================================================================
describe("error handling", () => {
  it("throws with error message from JSON body on non-ok GET response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Orchestrator not found" }, 404));

    await expect(orchestratorApi.get("missing")).rejects.toThrow("Orchestrator not found");
  });

  it("falls back to statusText when JSON body has no error field", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({}, 500));

    await expect(orchestratorApi.list()).rejects.toThrow("Error");
  });

  it("falls back to statusText when JSON parsing fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.reject(new Error("invalid json")),
    });

    await expect(orchestratorApi.get("bad")).rejects.toThrow("Internal Server Error");
  });

  it("throws with error message from JSON body on non-ok POST response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Validation failed" }, 400));

    await expect(orchestratorApi.create({ name: "" })).rejects.toThrow("Validation failed");
  });

  it("throws with error message from JSON body on non-ok PUT response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Conflict" }, 409));

    await expect(orchestratorApi.update("orch-1", { name: "dup" })).rejects.toThrow("Conflict");
  });

  it("throws with error message from JSON body on non-ok DELETE response", async () => {
    mockFetch.mockResolvedValueOnce(mockResponse({ error: "Cannot delete running orchestrator" }, 409));

    await expect(orchestratorApi.delete("orch-active")).rejects.toThrow("Cannot delete running orchestrator");
  });
});
