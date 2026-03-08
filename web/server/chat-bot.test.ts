import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Module mocks (before imports) ──────────────────────────────────────────

// Mock the Chat SDK modules — they require external API keys we don't have in tests.
const mockOnNewMention = vi.fn();
const mockOnSubscribedMessage = vi.fn();
const mockChatShutdown = vi.fn();
const mockChatWebhooks = { github: vi.fn() };

vi.mock("chat", () => ({
  Chat: class MockChat {
    onNewMention = mockOnNewMention;
    onSubscribedMessage = mockOnSubscribedMessage;
    shutdown = mockChatShutdown;
    webhooks = mockChatWebhooks;
  },
  ConsoleLogger: class MockConsoleLogger {
    constructor(_level?: string) {}
  },
}));

vi.mock("@chat-adapter/github", () => ({
  createGitHubAdapter: vi.fn(() => ({ type: "github-adapter" })),
}));

vi.mock("@chat-adapter/state-memory", () => ({
  createMemoryState: vi.fn(() => ({})),
}));

vi.mock("./agent-store.js", () => ({
  listAgents: vi.fn(() => []),
  getAgent: vi.fn(() => null),
}));

import { ChatBot } from "./chat-bot.js";
import * as agentStore from "./agent-store.js";
import type { AgentConfig } from "./agent-types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-1",
    version: 1,
    name: "Test Agent",
    description: "A test agent",
    backendType: "claude",
    model: "claude-sonnet-4-6",
    permissionMode: "bypassPermissions",
    cwd: "/tmp/test",
    prompt: "Do something useful",
    enabled: true,
    createdAt: 1000,
    updatedAt: 2000,
    totalRuns: 0,
    consecutiveFailures: 0,
    triggers: {
      chat: {
        enabled: true,
        platforms: [{ adapter: "github", autoSubscribe: true }],
      },
    },
    ...overrides,
  };
}

/** Creates an agent with per-binding GitHub credentials for per-agent runtime tests */
function makeAgentWithCredentials(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return makeAgent({
    id: "agent-creds",
    name: "Agent With Creds",
    triggers: {
      chat: {
        enabled: true,
        platforms: [{
          adapter: "github",
          autoSubscribe: true,
          credentials: {
            token: "ghp_test-token",
            webhookSecret: "whsec_test-webhook-secret",
          },
        }],
      },
    },
    ...overrides,
  });
}

function createMockExecutor() {
  return {
    executeAgent: vi.fn().mockResolvedValue({ sessionId: "test-session-1" }),
  };
}

function createMockWsBridge() {
  return {
    onAssistantMessageForSession: vi.fn(() => vi.fn()), // returns unsubscribe fn
    onResultForSession: vi.fn(() => vi.fn()),
    injectUserMessage: vi.fn(),
  };
}

function createMockThread(overrides: Partial<{
  id: string;
  state: { sessionId: string; agentId: string } | null;
}> = {}) {
  return {
    id: overrides.id || "github:issue-123",
    post: vi.fn(),
    startTyping: vi.fn(),
    setState: vi.fn(),
    subscribe: vi.fn(),
    get state() {
      return Promise.resolve(overrides.state || null);
    },
  };
}

/**
 * Helper: initializes a per-agent runtime and returns the agent-scoped
 * mention and subscribed-message handlers registered with the mock Chat SDK.
 * Since each new Chat() instance calls the same mockOnNewMention/mockOnSubscribedMessage,
 * the agent-scoped handlers are always the LAST registered callbacks.
 */
function setupAgentRuntime(
  bot: ChatBot,
  executor: ReturnType<typeof createMockExecutor>,
  agentOverrides: Partial<AgentConfig> = {},
) {
  const agent = makeAgentWithCredentials({
    id: "agent-scoped-1",
    name: "Agent Scoped",
    ...agentOverrides,
  });

  // Make the agent discoverable via getAgent (used inside handleAgentMention)
  vi.mocked(agentStore.getAgent).mockReturnValue(agent);

  bot.initializeAgentRuntime(agent);

  // The agent-scoped handlers are the last registered callbacks
  const mentionCalls = mockOnNewMention.mock.calls;
  const subscribedCalls = mockOnSubscribedMessage.mock.calls;
  const mentionHandler = mentionCalls[mentionCalls.length - 1][0];
  const subscribedHandler = subscribedCalls[subscribedCalls.length - 1][0];

  return { agent, mentionHandler, subscribedHandler };
}

// ─── Environment setup ──────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("ChatBot", () => {
  describe("initialize()", () => {
    it("returns true when agents with credentials exist in the store", () => {
      // initialize() scans stored agents and creates per-agent runtimes for
      // those with chat platform credentials. Returns true if any were created.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      vi.mocked(agentStore.listAgents).mockReturnValue([makeAgentWithCredentials()]);

      const result = bot.initialize();

      expect(result).toBe(true);
    });

    it("returns false when no agents have chat credentials", () => {
      // Without any agents that have per-binding credentials,
      // no runtimes are created and initialize() returns false.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      // Explicitly return empty list (no agents with credentials)
      vi.mocked(agentStore.listAgents).mockReturnValue([]);
      const result = bot.initialize();

      expect(result).toBe(false);
    });

    it("registers onNewMention and onSubscribedMessage handlers for agent runtime", () => {
      // When a per-agent runtime is created, it registers Chat SDK handlers.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      vi.mocked(agentStore.listAgents).mockReturnValue([makeAgentWithCredentials()]);
      bot.initialize();

      expect(mockOnNewMention).toHaveBeenCalledTimes(1);
      expect(mockOnSubscribedMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe("webhooks (legacy getter)", () => {
    it("always returns empty object (legacy global init removed)", () => {
      // The legacy global webhook getter always returns empty — per-agent
      // handlers should be accessed via getWebhookHandler() instead.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      expect(bot.webhooks).toEqual({});

      vi.mocked(agentStore.listAgents).mockReturnValue([makeAgentWithCredentials()]);
      bot.initialize();

      expect(bot.webhooks).toEqual({});
    });
  });

  describe("platforms (legacy getter)", () => {
    it("always returns empty array (legacy global init removed)", () => {
      // The legacy global platforms getter always returns empty — per-agent
      // platforms should be accessed via listAgentPlatforms() instead.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      expect(bot.platforms).toEqual([]);

      vi.mocked(agentStore.listAgents).mockReturnValue([makeAgentWithCredentials()]);
      bot.initialize();

      expect(bot.platforms).toEqual([]);
    });
  });

  // ─── Agent-scoped mention handler tests ──────────────────────────────────
  // These test handleAgentMention via the onNewMention callback registered
  // by initializeAgentRuntime(). The handler routes directly to a specific agent.

  describe("handleAgentMention (via per-agent runtime)", () => {
    it("starts a session and stores state for a matching agent", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler, agent } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:issue-456" });
      const message = { text: "help me with this issue" };

      await mentionHandler(thread, message);

      // Should have called executeAgent with the agent ID and message text
      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-scoped-1",
        "help me with this issue",
        { force: true, triggerType: "chat" },
      );

      // Should have stored state and subscribed
      expect(thread.setState).toHaveBeenCalledWith({
        sessionId: "test-session-1",
        agentId: "agent-scoped-1",
      });
      expect(thread.subscribe).toHaveBeenCalled();
    });

    it("posts error when agent is disabled", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials({ id: "agent-disabled" });
      vi.mocked(agentStore.getAgent).mockReturnValue(agent);
      bot.initializeAgentRuntime(agent);

      // Now disable the agent in the store
      vi.mocked(agentStore.getAgent).mockReturnValue({ ...agent, enabled: false });

      const mentionCalls = mockOnNewMention.mock.calls;
      const mentionHandler = mentionCalls[mentionCalls.length - 1][0];
      const thread = createMockThread({ id: "github:issue-disabled" });

      await mentionHandler(thread, { text: "help" });

      expect(thread.post).toHaveBeenCalledWith(
        expect.stringContaining("not available"),
      );
      expect(executor.executeAgent).not.toHaveBeenCalled();
    });

    it("posts error when agent execution fails (returns null)", async () => {
      const executor = createMockExecutor();
      executor.executeAgent.mockResolvedValue(null); // Execution failed
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:issue-111" });

      await mentionHandler(thread, { text: "do something" });

      expect(thread.post).toHaveBeenCalledWith(
        expect.stringContaining("Failed to start agent session"),
      );
    });

    it("posts error when executeAgent throws an exception", async () => {
      const executor = createMockExecutor();
      executor.executeAgent.mockRejectedValue(new Error("Spawn failed"));
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:scoped-error" });

      await mentionHandler(thread, { text: "trigger error" });

      expect(thread.post).toHaveBeenCalledWith(
        expect.stringContaining("Spawn failed"),
      );
    });

    it("sets up response relay with wsBridge listeners", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:issue-222" });

      await mentionHandler(thread, { text: "test relay" });

      // Should register listeners on the wsBridge for the session
      expect(wsBridge.onAssistantMessageForSession).toHaveBeenCalledWith(
        "test-session-1",
        expect.any(Function),
      );
      expect(wsBridge.onResultForSession).toHaveBeenCalledWith(
        "test-session-1",
        expect.any(Function),
      );
    });

    it("calls thread.subscribe() when autoSubscribe is true (default)", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:scoped-sub" });

      await mentionHandler(thread, { text: "handle this" });

      expect(thread.subscribe).toHaveBeenCalled();
      expect(thread.setState).toHaveBeenCalledWith({
        sessionId: "test-session-1",
        agentId: "agent-scoped-1",
      });
    });

    it("respects mentionPattern filter", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor, {
        triggers: {
          chat: {
            enabled: true,
            platforms: [{
              adapter: "github",
              autoSubscribe: true,
              mentionPattern: "@bot",
              credentials: {
                token: "ghp_scoped-token",
                webhookSecret: "whsec_scoped-webhook-secret",
              },
            }],
          },
        },
      });
      const thread = createMockThread({ id: "github:issue-333" });

      // Message that doesn't match the pattern — should be silently ignored
      await mentionHandler(thread, { text: "hello world" });
      expect(executor.executeAgent).not.toHaveBeenCalled();
      expect(thread.post).not.toHaveBeenCalled();

      // Message that matches
      vi.clearAllMocks();
      vi.mocked(agentStore.getAgent).mockReturnValue(makeAgentWithCredentials({
        id: "agent-scoped-1",
        triggers: {
          chat: {
            enabled: true,
            platforms: [{
              adapter: "github",
              autoSubscribe: true,
              mentionPattern: "@bot",
              credentials: {
                token: "ghp_scoped-token",
                webhookSecret: "whsec_scoped-webhook-secret",
              },
            }],
          },
        },
      }));
      await mentionHandler(thread, { text: "@bot help me" });
      expect(executor.executeAgent).toHaveBeenCalled();
    });

    it("silently ignores messages that don't match mentionPattern", async () => {
      // Agent-scoped handler with mentionPattern returns silently (no error post)
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor, {
        triggers: {
          chat: {
            enabled: true,
            platforms: [{
              adapter: "github",
              autoSubscribe: true,
              mentionPattern: "^deploy",
              credentials: {
                token: "ghp_scoped-token",
                webhookSecret: "whsec_scoped-webhook-secret",
              },
            }],
          },
        },
      });
      const thread = createMockThread({ id: "github:scoped-pattern" });

      await mentionHandler(thread, { text: "hello world" });

      expect(executor.executeAgent).not.toHaveBeenCalled();
      expect(thread.post).not.toHaveBeenCalled();
      expect(thread.subscribe).not.toHaveBeenCalled();
    });
  });

  // ─── Agent-scoped subscribed message handler tests ───────────────────────

  describe("handleAgentSubscribedMessage (via per-agent runtime)", () => {
    it("injects a message into the existing session", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { subscribedHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({
        id: "github:issue-444",
        state: { sessionId: "existing-session", agentId: "agent-scoped-1" },
      });

      await subscribedHandler(thread, { text: "follow up question" });

      expect(wsBridge.injectUserMessage).toHaveBeenCalledWith(
        "existing-session",
        "follow up question",
      );
      expect(thread.startTyping).toHaveBeenCalled();
    });

    it("re-wires response relay before injecting follow-up message", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { subscribedHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({
        id: "github:issue-relay",
        state: { sessionId: "existing-session", agentId: "agent-scoped-1" },
      });

      await subscribedHandler(thread, { text: "follow up" });

      // Should re-register listeners on the wsBridge for the session
      expect(wsBridge.onAssistantMessageForSession).toHaveBeenCalledWith(
        "existing-session",
        expect.any(Function),
      );
      expect(wsBridge.onResultForSession).toHaveBeenCalledWith(
        "existing-session",
        expect.any(Function),
      );
      expect(wsBridge.injectUserMessage).toHaveBeenCalledWith(
        "existing-session",
        "follow up",
      );
    });

    it("falls back to handleAgentMention when thread has no session state", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { subscribedHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:issue-555", state: null });

      await subscribedHandler(thread, { text: "new topic" });

      // Should have started a new session via executeAgent
      expect(executor.executeAgent).toHaveBeenCalledWith(
        "agent-scoped-1",
        "new topic",
        { force: true, triggerType: "chat" },
      );
    });
  });

  // ─── Session cleanup and lifecycle ────────────────────────────────────────

  describe("cleanupSession()", () => {
    it("calls all stored unsubscribers for a session", async () => {
      // Start a session via agent-scoped handler, then clean it up and verify
      // the wsBridge unsubscribers are called.
      const executor = createMockExecutor();
      const unsub1 = vi.fn();
      const unsub2 = vi.fn();
      const wsBridge = createMockWsBridge();
      wsBridge.onAssistantMessageForSession.mockReturnValue(unsub1);
      wsBridge.onResultForSession.mockReturnValue(unsub2);
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:issue-666" });
      await mentionHandler(thread, { text: "test" });

      // Now cleanup the session
      bot.cleanupSession("test-session-1");

      expect(unsub1).toHaveBeenCalled();
      expect(unsub2).toHaveBeenCalled();
    });

    it("does nothing for unknown session IDs", () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      // Should not throw
      bot.cleanupSession("nonexistent-session");
    });
  });

  describe("shutdown()", () => {
    it("cleans up all sessions and shuts down per-agent Chat SDK runtimes", async () => {
      const executor = createMockExecutor();
      const unsub = vi.fn();
      const wsBridge = createMockWsBridge();
      wsBridge.onAssistantMessageForSession.mockReturnValue(unsub);
      wsBridge.onResultForSession.mockReturnValue(vi.fn());
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);

      // Set up a session relay
      await mentionHandler(createMockThread({ id: "github:i-1" }), { text: "t" });

      await bot.shutdown();

      expect(unsub).toHaveBeenCalled();
      expect(mockChatShutdown).toHaveBeenCalled();
    });
  });

  // ─── Per-agent runtime management ─────────────────────────────────────────

  describe("per-agent runtime (credentials)", () => {
    it("creates a runtime when agent has chat credentials", () => {
      // When an agent has per-binding credentials, initializeAgentRuntime should
      // create a Chat SDK instance and return true.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials();
      const result = bot.initializeAgentRuntime(agent);

      expect(result).toBe(true);
    });

    it("returns false for agents without credentials", () => {
      // Agents without per-binding credentials should NOT get a per-agent runtime.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      // Default makeAgent() has no credentials on its platform binding
      const agent = makeAgent();
      const result = bot.initializeAgentRuntime(agent);

      expect(result).toBe(false);
    });

    it("returns false for disabled agents", () => {
      // Even if the agent has credentials, a disabled agent should not be initialized.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials({ enabled: false });
      const result = bot.initializeAgentRuntime(agent);

      expect(result).toBe(false);
    });

    it("returns false when chat trigger is disabled", () => {
      // Agent has credentials but the chat trigger itself is disabled.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials({
        triggers: {
          chat: {
            enabled: false,
            platforms: [{
              adapter: "github",
              autoSubscribe: true,
              credentials: {
                token: "ghp_test-token",
                webhookSecret: "whsec_test-webhook-secret",
              },
            }],
          },
        },
      });
      const result = bot.initializeAgentRuntime(agent);

      expect(result).toBe(false);
    });

    it("returns false when credentials lack auth method", () => {
      // GitHub credentials need at least token or appId+privateKey.
      // Missing auth should cause createAdapterForBinding to return null.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials({
        triggers: {
          chat: {
            enabled: true,
            platforms: [{
              adapter: "github",
              autoSubscribe: true,
              credentials: {
                // No token or appId — only webhookSecret
                webhookSecret: "whsec_test-webhook-secret",
              },
            }],
          },
        },
      });
      const result = bot.initializeAgentRuntime(agent);

      expect(result).toBe(false);
    });

    it("getWebhookHandler returns handler for initialized agent", () => {
      // After initializeAgentRuntime succeeds, getWebhookHandler should return
      // the webhook handler function for the agent's platform.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials();
      bot.initializeAgentRuntime(agent);

      const handler = bot.getWebhookHandler("agent-creds", "github");

      // The mock Chat SDK returns { github: vi.fn() } as webhooks
      expect(handler).toBeDefined();
      expect(typeof handler).toBe("function");
    });

    it("getWebhookHandler returns null for unknown agent", () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const handler = bot.getWebhookHandler("nonexistent-agent", "github");

      expect(handler).toBeNull();
    });

    it("getWebhookHandler returns null for unknown platform on existing agent", () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials();
      bot.initializeAgentRuntime(agent);

      const handler = bot.getWebhookHandler("agent-creds", "slack");

      expect(handler).toBeNull();
    });

    it("listAgentPlatforms returns correct data for initialized agents", () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials();
      bot.initializeAgentRuntime(agent);

      // getAgent is called by listAgentPlatforms to resolve the human-readable name
      vi.mocked(agentStore.getAgent).mockReturnValue(agent);

      const result = bot.listAgentPlatforms();

      expect(result).toEqual([
        {
          agentId: "agent-creds",
          agentName: "Agent With Creds",
          platforms: ["github"],
        },
      ]);
    });

    it("listAgentPlatforms falls back to agentId when getAgent returns null", () => {
      // If the agent was deleted from the store but its runtime is still active,
      // listAgentPlatforms should use the agentId as the display name.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials();
      bot.initializeAgentRuntime(agent);

      vi.mocked(agentStore.getAgent).mockReturnValue(null);

      const result = bot.listAgentPlatforms();

      expect(result).toEqual([
        {
          agentId: "agent-creds",
          agentName: "agent-creds", // falls back to ID
          platforms: ["github"],
        },
      ]);
    });

    it("listAgentPlatforms returns empty array when no agent runtimes exist", () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const result = bot.listAgentPlatforms();

      expect(result).toEqual([]);
    });

    it("initialize() creates per-agent runtimes from stored agent credentials", () => {
      // When initialize() is called and there are agents with credentials in the store,
      // it should create per-agent runtimes.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      vi.mocked(agentStore.listAgents).mockReturnValue([makeAgentWithCredentials()]);

      const result = bot.initialize();

      expect(result).toBe(true);
      // Should have a webhook handler for the agent's platform
      const handler = bot.getWebhookHandler("agent-creds", "github");
      expect(handler).toBeDefined();
    });
  });

  describe("reloadAgent()", () => {
    function makeReloadAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
      return makeAgentWithCredentials({
        id: "agent-reload",
        name: "Agent Reload Test",
        ...overrides,
      });
    }

    it("shuts down old runtime and creates new one from current config", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      // First, initialize an agent runtime
      const agent = makeReloadAgent();
      bot.initializeAgentRuntime(agent);

      // Verify runtime exists before reload
      expect(bot.getWebhookHandler("agent-reload", "github")).toBeDefined();

      // Mock getAgent to return updated agent config
      const updatedAgent = makeReloadAgent({ name: "Updated Agent" });
      vi.mocked(agentStore.getAgent).mockReturnValue(updatedAgent);

      mockChatShutdown.mockClear();

      await bot.reloadAgent("agent-reload");

      // The old runtime should have been shut down
      expect(mockChatShutdown).toHaveBeenCalledTimes(1);

      // A new runtime should exist (getWebhookHandler still works)
      expect(bot.getWebhookHandler("agent-reload", "github")).toBeDefined();
    });

    it("handles non-existent agents gracefully (no runtime to remove)", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeReloadAgent({ id: "agent-new" });
      vi.mocked(agentStore.getAgent).mockReturnValue(agent);

      // Should not throw even though there is no existing runtime for "agent-new"
      await bot.reloadAgent("agent-new");

      expect(bot.getWebhookHandler("agent-new", "github")).toBeDefined();
    });

    it("does nothing when getAgent returns null (agent deleted)", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeReloadAgent();
      bot.initializeAgentRuntime(agent);

      // Agent has been deleted from the store
      vi.mocked(agentStore.getAgent).mockReturnValue(null);
      mockChatShutdown.mockClear();

      await bot.reloadAgent("agent-reload");

      // Old runtime should be shut down
      expect(mockChatShutdown).toHaveBeenCalledTimes(1);
      // No new runtime should exist
      expect(bot.getWebhookHandler("agent-reload", "github")).toBeNull();
    });
  });

  describe("removeAgent()", () => {
    it("shuts down and deletes the runtime for an existing agent", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgentWithCredentials({
        id: "agent-remove",
        name: "Agent To Remove",
      });
      bot.initializeAgentRuntime(agent);

      // Verify the runtime exists
      expect(bot.getWebhookHandler("agent-remove", "github")).toBeDefined();

      mockChatShutdown.mockClear();

      await bot.removeAgent("agent-remove");

      // The Chat SDK for this agent should have been shut down
      expect(mockChatShutdown).toHaveBeenCalledTimes(1);
      // The runtime should no longer be accessible
      expect(bot.getWebhookHandler("agent-remove", "github")).toBeNull();
    });

    it("does nothing for unknown agents (no throw, no shutdown call)", async () => {
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      mockChatShutdown.mockClear();

      // Should not throw
      await bot.removeAgent("nonexistent-agent");

      expect(mockChatShutdown).not.toHaveBeenCalled();
    });
  });

  describe("createAdapterForBinding edge cases", () => {
    it("initializeAgentRuntime skips agents with credentials that lack auth", () => {
      // createAdapterForBinding returns null when credentials are present but
      // don't have the required auth method (no token or appId+privateKey).
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const agent = makeAgent({
        id: "agent-no-auth",
        triggers: {
          chat: {
            enabled: true,
            platforms: [{
              adapter: "github",
              autoSubscribe: true,
              credentials: {
                // Has credentials object but no token/appId
                webhookSecret: "whsec_secret",
              },
            }],
          },
        },
      });

      // Should return false — credentials present but no valid auth method
      const result = bot.initializeAgentRuntime(agent);
      expect(result).toBe(false);
    });
  });

  // ─── testMentionPattern edge cases ────────────────────────────────────────

  describe("testMentionPattern edge cases", () => {
    it("treats invalid regex as no match (does not throw)", async () => {
      // An agent-scoped handler with a syntactically invalid regex mentionPattern
      // should treat it as a non-match silently (no throw, no post).
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();
      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor, {
        triggers: {
          chat: {
            enabled: true,
            platforms: [{
              adapter: "github",
              autoSubscribe: true,
              mentionPattern: "(invalid[regex",
              credentials: {
                token: "ghp_scoped-token",
                webhookSecret: "whsec_scoped-webhook-secret",
              },
            }],
          },
        },
      });
      const thread = createMockThread({ id: "github:bad-regex" });

      // This should not throw — the invalid regex is caught and treated as no match
      await mentionHandler(thread, { text: "anything" });

      // Agent-scoped handler: no match on pattern → silently returns (no post)
      expect(executor.executeAgent).not.toHaveBeenCalled();
      expect(thread.post).not.toHaveBeenCalled();
    });
  });

  // ─── Response relay message posting ───────────────────────────────────────

  describe("setupResponseRelay message posting", () => {
    it("posts accumulated assistant text to thread when result arrives", async () => {
      // The response relay collects text from assistant messages and posts
      // them to the thread when a result message arrives.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();

      // Capture the callbacks passed to wsBridge so we can invoke them manually
      let assistantCallback: ((msg: any) => void) | null = null;
      let resultCallback: (() => void) | null = null;

      (wsBridge.onAssistantMessageForSession as any).mockImplementation((_sid: string, cb: (msg: any) => void) => {
        assistantCallback = cb;
        return vi.fn(); // unsubscribe
      });
      (wsBridge.onResultForSession as any).mockImplementation((_sid: string, cb: () => void) => {
        resultCallback = cb;
        return vi.fn(); // unsubscribe
      });

      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:relay-test" });

      await mentionHandler(thread, { text: "test relay posting" });

      // Simulate assistant messages arriving via the relay
      expect(assistantCallback).not.toBeNull();
      expect(resultCallback).not.toBeNull();

      // Send an assistant message with text content blocks
      assistantCallback!({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello from the agent!" },
          ],
        },
      });

      // Send another assistant message to test accumulation
      assistantCallback!({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Second chunk." },
          ],
        },
      });

      // Now fire the result callback — this should post accumulated text to the thread
      await resultCallback!();

      // The thread.post should have been called with the accumulated text
      expect(thread.post).toHaveBeenCalledWith("Hello from the agent!\nSecond chunk.");
    });

    it("does not post to thread when no assistant text was accumulated", async () => {
      // When a result arrives but no assistant text was accumulated (e.g., the
      // agent only used tools without producing text), no post should be made.
      const executor = createMockExecutor();
      const wsBridge = createMockWsBridge();

      let resultCallback: (() => void) | null = null;

      (wsBridge.onAssistantMessageForSession as any).mockImplementation((_sid: string, _cb: any) => {
        return vi.fn();
      });
      (wsBridge.onResultForSession as any).mockImplementation((_sid: string, cb: () => void) => {
        resultCallback = cb;
        return vi.fn();
      });

      const bot = new ChatBot(executor as any, wsBridge as any);

      const { mentionHandler } = setupAgentRuntime(bot, executor);
      const thread = createMockThread({ id: "github:relay-empty" });

      await mentionHandler(thread, { text: "no text" });

      // Fire result without any assistant messages
      await resultCallback!();

      // thread.post should NOT have been called for the relay (only startTyping)
      expect(thread.post).not.toHaveBeenCalled();
    });
  });
});
