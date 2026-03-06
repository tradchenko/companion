// Tests for the Linear Agent Session Bridge.
// Covers session creation from AgentSessionEvent, follow-up prompt handling,
// message relay from Companion sessions to Linear activities, and cleanup.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies
vi.mock("./agent-store.js", () => ({
  listAgents: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock("./linear-agent.js", () => ({
  postActivity: vi.fn().mockResolvedValue(undefined),
  updateSessionUrls: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./settings-manager.js", () => ({
  getSettings: vi.fn().mockReturnValue({ publicUrl: "" }),
}));

import * as agentStore from "./agent-store.js";
import * as linearAgent from "./linear-agent.js";
import { LinearAgentBridge } from "./linear-agent-bridge.js";
import type { AgentSessionEventPayload } from "./linear-agent.js";

// ─── Test helpers ────────────────────────────────────────────────────────────

function createMockAgentExecutor() {
  return {
    executeAgent: vi.fn(),
  } as unknown as import("./agent-executor.js").AgentExecutor;
}

function createMockWsBridge() {
  return {
    onAssistantMessageForSession: vi.fn().mockReturnValue(() => {}),
    onResultForSession: vi.fn().mockReturnValue(() => {}),
    injectUserMessage: vi.fn(),
    getSession: vi.fn().mockReturnValue({ id: "mock-session" }), // session exists by default
  } as unknown as import("./ws-bridge.js").WsBridge;
}

function makeCreatedEvent(overrides: Partial<AgentSessionEventPayload["data"]> = {}): AgentSessionEventPayload {
  return {
    action: "created",
    type: "AgentSessionEvent",
    data: {
      id: "linear-session-1",
      promptContext: "Fix the login bug on issue LIN-42",
      ...overrides,
    },
  };
}

function makePromptedEvent(linearSessionId: string, message: string): AgentSessionEventPayload {
  return {
    action: "prompted",
    type: "AgentSessionEvent",
    data: { id: linearSessionId },
    agentActivity: { body: message },
  };
}

const testAgent = {
  id: "agent-1",
  name: "Linear Bot",
  enabled: true,
  triggers: { linear: { enabled: true } },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("LinearAgentBridge", () => {
  let bridge: LinearAgentBridge;
  let executor: ReturnType<typeof createMockAgentExecutor>;
  let wsBridge: ReturnType<typeof createMockWsBridge>;

  beforeEach(() => {
    vi.clearAllMocks();
    executor = createMockAgentExecutor();
    wsBridge = createMockWsBridge();
    bridge = new LinearAgentBridge(executor, wsBridge);
  });

  describe("handleEvent — created action", () => {
    it("acknowledges with a thought, launches agent session, and sets up relay", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);

      await bridge.handleEvent(makeCreatedEvent());

      // Should post initial acknowledgement thought
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({ type: "thought", body: "Starting Companion session..." }),
      );

      // Should launch agent session with prompt context
      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-1",
        "Fix the login bug on issue LIN-42",
        { force: true, triggerType: "linear" },
      );

      // Should set external URLs
      expect(linearAgent.updateSessionUrls).toHaveBeenCalledWith(
        "linear-session-1",
        expect.arrayContaining([
          expect.objectContaining({ label: "Companion Session" }),
        ]),
      );

      // Should set up relay listeners
      expect(wsBridge.onAssistantMessageForSession).toHaveBeenCalledWith(
        "comp-sess-1",
        expect.any(Function),
      );
      expect(wsBridge.onResultForSession).toHaveBeenCalledWith(
        "comp-sess-1",
        expect.any(Function),
      );

      // Should post "session started" thought
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({
          type: "thought",
          body: expect.stringContaining("Linear Bot"),
        }),
      );
    });

    it("posts error when no agent with Linear trigger is found", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([]);

      await bridge.handleEvent(makeCreatedEvent());

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({
          type: "error",
          body: expect.stringContaining("No Companion agent"),
        }),
      );
      // Should not attempt to launch session
      expect(executor.executeAgent).not.toHaveBeenCalled();
    });

    it("posts error when agent executor returns null (no overlap)", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(agentStore.getAgent).mockReturnValue({ ...testAgent, lastSessionId: undefined } as ReturnType<typeof agentStore.getAgent>);
      vi.mocked(executor.executeAgent).mockResolvedValue(undefined as never);

      await bridge.handleEvent(makeCreatedEvent());

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({
          type: "error",
          body: expect.stringContaining("Failed to start Companion session"),
        }),
      );
    });

    it("posts 'agent busy' error when executor returns null due to overlap", async () => {
      // Agent is busy with a running session
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(agentStore.getAgent).mockReturnValue({ ...testAgent, lastSessionId: "running-session" } as ReturnType<typeof agentStore.getAgent>);
      vi.mocked(wsBridge.getSession).mockReturnValue({ id: "running-session" } as never);
      vi.mocked(executor.executeAgent).mockResolvedValue(undefined as never);

      await bridge.handleEvent(makeCreatedEvent());

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({
          type: "error",
          body: expect.stringContaining("currently busy"),
        }),
      );
    });

    it("posts error when agent executor throws", async () => {
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockRejectedValue(new Error("CLI not found"));

      await bridge.handleEvent(makeCreatedEvent());

      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({
          type: "error",
          body: expect.stringContaining("CLI not found"),
        }),
      );
    });

    it("skips disabled agents when finding Linear agent", async () => {
      const disabledAgent = { ...testAgent, enabled: false };
      vi.mocked(agentStore.listAgents).mockReturnValue([disabledAgent] as ReturnType<typeof agentStore.listAgents>);

      await bridge.handleEvent(makeCreatedEvent());

      // No agent found → error posted
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({ type: "error" }),
      );
    });
  });

  describe("handleEvent — prompted action", () => {
    it("injects follow-up message into existing Companion session", async () => {
      // First, create a session to establish the mapping
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());

      vi.clearAllMocks();

      // Now send a follow-up
      await bridge.handleEvent(makePromptedEvent("linear-session-1", "What's the status?"));

      // Should post acknowledgement thought
      expect(linearAgent.postActivity).toHaveBeenCalledWith(
        "linear-session-1",
        expect.objectContaining({ type: "thought", body: "Processing follow-up..." }),
      );

      // Should inject message into the Companion session
      expect(wsBridge.injectUserMessage).toHaveBeenCalledWith("comp-sess-1", "What's the status?");
    });

    it("creates new session when Companion session is dead", async () => {
      // Create a session first
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);
      await bridge.handleEvent(makeCreatedEvent());
      vi.clearAllMocks();

      // Simulate the session being dead
      vi.mocked(wsBridge.getSession).mockReturnValue(undefined);
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-new" } as never);

      await bridge.handleEvent(makePromptedEvent("linear-session-1", "Follow up?"));

      // Should launch a new session instead of injecting
      expect(executor.executeAgent).toHaveBeenCalled();
      expect(wsBridge.injectUserMessage).not.toHaveBeenCalled();
    });

    it("creates new session when no mapping exists for prompted event", async () => {
      // Send prompted event without a prior created event
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-new" } as never);

      await bridge.handleEvent(makePromptedEvent("unknown-session", "help"));

      // Should fall back to handleCreated → launch new session
      expect(executor.executeAgent).toHaveBeenCalled();
    });
  });

  describe("shutdown", () => {
    it("cleans up all session mappings and relay listeners", async () => {
      // Create a session
      vi.mocked(agentStore.listAgents).mockReturnValue([testAgent] as ReturnType<typeof agentStore.listAgents>);
      const unsubAssistant = vi.fn();
      const unsubResult = vi.fn();
      vi.mocked(wsBridge.onAssistantMessageForSession).mockReturnValue(unsubAssistant);
      vi.mocked(wsBridge.onResultForSession).mockReturnValue(unsubResult);
      vi.mocked(executor.executeAgent).mockResolvedValue({ sessionId: "comp-sess-1" } as never);

      await bridge.handleEvent(makeCreatedEvent());

      bridge.shutdown();

      // Should call cleanup unsubscribers
      expect(unsubAssistant).toHaveBeenCalled();
      expect(unsubResult).toHaveBeenCalled();
    });
  });
});
