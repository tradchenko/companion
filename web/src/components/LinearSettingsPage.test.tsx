// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

interface MockStoreState {
  currentSessionId: string | null;
  publicUrl: string;
}

let mockState: MockStoreState;

const mockApi = {
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getLinearConnection: vi.fn(),
  getLinearStates: vi.fn(),
  getLinearOAuthStatus: vi.fn(),
  getLinearOAuthAuthorizeUrl: vi.fn(),
  disconnectLinearOAuth: vi.fn(),
  listLinearConnections: vi.fn(),
  createLinearConnection: vi.fn(),
  deleteLinearConnection: vi.fn(),
  verifyLinearConnection: vi.fn(),
  updateLinearConnection: vi.fn(),
};

vi.mock("../api.js", () => ({
  api: {
    getSettings: (...args: unknown[]) => mockApi.getSettings(...args),
    updateSettings: (...args: unknown[]) => mockApi.updateSettings(...args),
    getLinearConnection: (...args: unknown[]) => mockApi.getLinearConnection(...args),
    getLinearStates: (...args: unknown[]) => mockApi.getLinearStates(...args),
    getLinearOAuthStatus: (...args: unknown[]) => mockApi.getLinearOAuthStatus(...args),
    getLinearOAuthAuthorizeUrl: (...args: unknown[]) => mockApi.getLinearOAuthAuthorizeUrl(...args),
    disconnectLinearOAuth: (...args: unknown[]) => mockApi.disconnectLinearOAuth(...args),
    listLinearConnections: (...args: unknown[]) => mockApi.listLinearConnections(...args),
    createLinearConnection: (...args: unknown[]) => mockApi.createLinearConnection(...args),
    deleteLinearConnection: (...args: unknown[]) => mockApi.deleteLinearConnection(...args),
    verifyLinearConnection: (...args: unknown[]) => mockApi.verifyLinearConnection(...args),
    updateLinearConnection: (...args: unknown[]) => mockApi.updateLinearConnection(...args),
  },
}));

vi.mock("../store.js", () => {
  const useStoreFn = (selector: (state: MockStoreState) => unknown) => selector(mockState);
  useStoreFn.getState = () => mockState;
  return { useStore: useStoreFn };
});

import { LinearSettingsPage } from "./LinearSettingsPage.js";

const defaultConnection = {
  id: "conn-1",
  name: "Work",
  apiKeyLast4: "1234",
  workspaceName: "Acme",
  workspaceId: "ws-1",
  viewerName: "Ada",
  viewerEmail: "ada@example.com",
  connected: true,
  autoTransition: false,
  autoTransitionStateId: "",
  autoTransitionStateName: "",
  archiveTransition: false,
  archiveTransitionStateId: "",
  archiveTransitionStateName: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockState = { currentSessionId: null, publicUrl: "" };

  // Default: list one connected connection
  mockApi.listLinearConnections.mockResolvedValue({
    connections: [defaultConnection],
  });

  mockApi.getLinearOAuthStatus.mockResolvedValue({
    configured: false,
    hasClientId: false,
    hasClientSecret: false,
    hasWebhookSecret: false,
    hasAccessToken: false,
  });

  mockApi.updateSettings.mockResolvedValue({
    anthropicApiKeyConfigured: false,
    anthropicModel: "claude-sonnet-4.6",
    linearApiKeyConfigured: true,
    linearAutoTransition: false,
    linearAutoTransitionStateName: "",
    linearArchiveTransition: false,
    linearArchiveTransitionStateName: "",
  });

  mockApi.getLinearStates.mockResolvedValue({
    teams: [
      {
        id: "team-1",
        key: "ENG",
        name: "Engineering",
        states: [
          { id: "s-backlog", name: "Backlog", type: "backlog" },
          { id: "s-inprogress", name: "In Progress", type: "started" },
          { id: "s-done", name: "Done", type: "completed" },
        ],
      },
    ],
  });

  mockApi.createLinearConnection.mockResolvedValue({
    connection: { ...defaultConnection, id: "conn-new", name: "New" },
  });

  mockApi.updateLinearConnection.mockResolvedValue({
    connection: defaultConnection,
  });
});

// =============================================================================
// Connection list
// =============================================================================

describe("LinearSettingsPage — connection list", () => {
  it("loads and displays connections on mount", async () => {
    // Verifies that the connection list is fetched and rendered on mount.
    render(<LinearSettingsPage />);
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Work")).toBeInTheDocument();
  });

  it("shows empty state when no connections exist", async () => {
    // Verifies the empty state message when no connections are configured.
    mockApi.listLinearConnections.mockResolvedValue({ connections: [] });
    render(<LinearSettingsPage />);
    expect(await screen.findByText("No Linear connections yet.")).toBeInTheDocument();
  });

  it("shows connection card with status badge and masked key", async () => {
    // Verifies that connection cards display name, connected badge,
    // viewer/workspace info, and masked API key.
    render(<LinearSettingsPage />);
    expect(await screen.findByText("Work")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/Ada/)).toBeInTheDocument();
    expect(screen.getByText(/...1234/)).toBeInTheDocument();
  });

  it("shows hero status banner with connected count", async () => {
    // Verifies the hero banner shows connected count and total connections.
    render(<LinearSettingsPage />);
    expect(await screen.findByText("1 connected")).toBeInTheDocument();
    expect(screen.getByText("1 connection configured")).toBeInTheDocument();
  });

  it("shows 'Not connected' badge for unverified connections", async () => {
    // Verifies that a connection without connected=true shows the right badge.
    mockApi.listLinearConnections.mockResolvedValue({
      connections: [{ ...defaultConnection, connected: false }],
    });
    render(<LinearSettingsPage />);
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
  });
});

// =============================================================================
// Add connection
// =============================================================================

describe("LinearSettingsPage — add connection", () => {
  it("toggles the add connection form", async () => {
    // Verifies clicking Add Connection shows the form and Cancel hides it.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));
    expect(screen.getByLabelText("Connection Name")).toBeInTheDocument();
    expect(screen.getByLabelText("API Key")).toBeInTheDocument();

    // Button should now say "Cancel"
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Connection Name")).toBeNull();
  });

  it("creates a new connection and reloads the list", async () => {
    // Verifies that submitting the add form calls createLinearConnection
    // and then reloads the connection list.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));

    fireEvent.change(screen.getByLabelText("Connection Name"), {
      target: { value: "Personal" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "lin_api_personal" },
    });

    const saveBtn = screen.getByRole("button", { name: "Save" });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockApi.createLinearConnection).toHaveBeenCalledWith({
        name: "Personal",
        apiKey: "lin_api_personal",
      });
    });
    // Should reload connections after adding
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(2);
  });

  it("shows validation error when name or key is empty", async () => {
    // Verifies the form shows an error if name or key is not provided.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));
    // Save button should be disabled when fields are empty
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
  });

  it("shows error from API when create fails", async () => {
    // Verifies that an API error message is displayed in the form.
    mockApi.createLinearConnection.mockResolvedValue({ error: "Invalid API key" });
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Add Connection" }));
    fireEvent.change(screen.getByLabelText("Connection Name"), {
      target: { value: "Bad" },
    });
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "lin_api_bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Invalid API key")).toBeInTheDocument();
  });
});

// =============================================================================
// Delete / Verify connections
// =============================================================================

describe("LinearSettingsPage — delete and verify", () => {
  it("deletes a connection when Delete is clicked", async () => {
    // Verifies calling deleteLinearConnection and reloading the list.
    mockApi.deleteLinearConnection.mockResolvedValue({});
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(mockApi.deleteLinearConnection).toHaveBeenCalledWith("conn-1");
    });
    // Should reload after deletion
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(2);
  });

  it("verifies a connection when Verify is clicked", async () => {
    // Verifies calling verifyLinearConnection and reloading the list.
    mockApi.verifyLinearConnection.mockResolvedValue({});
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    await waitFor(() => {
      expect(mockApi.verifyLinearConnection).toHaveBeenCalledWith("conn-1");
    });
    // Should reload to reflect new verification status
    expect(mockApi.listLinearConnections).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Edit connection (auto-transition / archive transition settings)
// =============================================================================

describe("LinearSettingsPage — edit connection settings", () => {
  it("opens the edit panel and loads workflow states", async () => {
    // Verifies that clicking Edit on a connected connection opens
    // the settings panel and fetches workflow states from the API.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    await waitFor(() => {
      expect(mockApi.getLinearStates).toHaveBeenCalledWith("conn-1");
    });
    expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    expect(screen.getByText("On session archive")).toBeInTheDocument();
  });

  it("toggles Edit to Close and back", async () => {
    // Verifies that clicking Edit toggles the panel open/close.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    // Open
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Auto-transition")).toBeInTheDocument();

    // Close
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("Auto-transition")).toBeNull();
  });

  it("enables auto-transition toggle and shows state selector", async () => {
    // Verifies that enabling the auto-transition toggle reveals the
    // target status selector with workflow states.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    });

    // Find auto-transition switch (first one)
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    // Should now show the Target status selector
    await waitFor(() => {
      expect(screen.getAllByText("Target status").length).toBeGreaterThan(0);
    });
  });

  it("enables archive-transition toggle", async () => {
    // Verifies that the archive transition toggle reveals the target status.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("On session archive")).toBeInTheDocument();
    });

    // The archive switch is the second switch
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[1]);

    await waitFor(() => {
      expect(screen.getAllByText("Target status").length).toBeGreaterThan(0);
    });
  });

  it("saves connection settings via updateLinearConnection", async () => {
    // Verifies that clicking Save Settings calls updateLinearConnection
    // with the correct auto-transition and archive-transition fields.
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await waitFor(() => {
      expect(screen.getByText("Auto-transition")).toBeInTheDocument();
    });

    // Enable auto-transition
    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);

    // Click Save Settings
    fireEvent.click(screen.getByRole("button", { name: "Save Settings" }));

    await waitFor(() => {
      expect(mockApi.updateLinearConnection).toHaveBeenCalledWith("conn-1", {
        autoTransition: true,
        autoTransitionStateId: "",
        autoTransitionStateName: "",
        archiveTransition: false,
        archiveTransitionStateId: "",
        archiveTransitionStateName: "",
      });
    });
  });

  it("disables Edit button for unconnected connections", async () => {
    // Verifies that the Edit button is disabled when the connection
    // is not verified (connected=false).
    mockApi.listLinearConnections.mockResolvedValue({
      connections: [{ ...defaultConnection, connected: false }],
    });
    render(<LinearSettingsPage />);
    await screen.findByText("Work");

    expect(screen.getByRole("button", { name: "Edit" })).toBeDisabled();
  });
});

// =============================================================================
// OAuth Agent App section
// =============================================================================

describe("LinearSettingsPage — OAuth Agent App section", () => {
  it("renders the Linear Agent App section", async () => {
    // Verifies that the OAuth section renders with its heading
    render(<LinearSettingsPage />);
    expect(await screen.findByText("Linear Agent App")).toBeInTheDocument();
  });

  it("shows 'Not configured' status when OAuth is not set up", async () => {
    // Verifies the status text when no OAuth credentials are configured
    render(<LinearSettingsPage />);
    expect(await screen.findByText("Not configured")).toBeInTheDocument();
  });

  it("renders all OAuth input fields", async () => {
    // Verifies all three credential fields are present
    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    expect(screen.getByLabelText("Client ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Client Secret")).toBeInTheDocument();
    expect(screen.getByLabelText("Webhook Signing Secret")).toBeInTheDocument();
  });

  it("saves OAuth credentials when Save Credentials is clicked", async () => {
    // Verifies that entering credentials and clicking Save Credentials
    // calls updateSettings with the trimmed values
    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "  my-client-id  " },
    });
    fireEvent.change(screen.getByLabelText("Client Secret"), {
      target: { value: "  my-secret  " },
    });
    fireEvent.change(screen.getByLabelText("Webhook Signing Secret"), {
      target: { value: "  wh-secret  " },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save Credentials" }));

    await waitFor(() => {
      expect(mockApi.updateSettings).toHaveBeenCalledWith({
        linearOAuthClientId: "my-client-id",
        linearOAuthClientSecret: "my-secret",
        linearOAuthWebhookSecret: "wh-secret",
      });
    });
  });

  it("shows connected status when OAuth has access token", async () => {
    // Verifies the connected badge and status text when OAuth is fully configured
    mockApi.getLinearOAuthStatus.mockResolvedValue({
      configured: true,
      hasClientId: true,
      hasClientSecret: true,
      hasWebhookSecret: true,
      hasAccessToken: true,
    });

    render(<LinearSettingsPage />);

    // Should show the agent status text indicating it's connected
    expect(await screen.findByText(/agents with the Linear trigger/i)).toBeInTheDocument();
  });

  it("opens OAuth authorize URL when Install to Workspace is clicked", async () => {
    // Verifies that clicking Install to Workspace calls the API and opens the URL
    mockApi.getLinearOAuthStatus.mockResolvedValue({
      configured: true,
      hasClientId: true,
      hasClientSecret: true,
      hasWebhookSecret: false,
      hasAccessToken: false,
    });
    mockApi.getLinearOAuthAuthorizeUrl.mockResolvedValue({
      url: "https://linear.app/oauth/authorize?client_id=test",
    });

    // Mock window.open
    const originalOpen = window.open;
    window.open = vi.fn();

    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    // Wait for the status to load (sets oauthConfigured)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install to Workspace" })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Install to Workspace" }));

    await waitFor(() => {
      expect(mockApi.getLinearOAuthAuthorizeUrl).toHaveBeenCalled();
    });
    expect(window.open).toHaveBeenCalledWith(
      "https://linear.app/oauth/authorize?client_id=test",
      "_self",
    );

    window.open = originalOpen;
  });

  it("disconnects OAuth when Disconnect is clicked", async () => {
    // Verifies that clicking Disconnect calls the disconnect API
    mockApi.getLinearOAuthStatus.mockResolvedValue({
      configured: true,
      hasClientId: true,
      hasClientSecret: true,
      hasWebhookSecret: true,
      hasAccessToken: true,
    });

    render(<LinearSettingsPage />);

    // Wait for the OAuth connected status text (unique to the OAuth section)
    await screen.findByText(/agents with the Linear trigger/i);

    // Find and click the OAuth Disconnect button
    const disconnectButtons = screen.getAllByRole("button", { name: "Disconnect" });
    fireEvent.click(disconnectButtons[disconnectButtons.length - 1]);

    await waitFor(() => {
      expect(mockApi.disconnectLinearOAuth).toHaveBeenCalled();
    });
  });

  it("shows setup guide details section", async () => {
    // Verifies the expandable setup guide is present
    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    expect(screen.getByText("Setup guide")).toBeInTheDocument();
  });

  it("disables Save Credentials when no fields are filled", async () => {
    // Verifies the button is disabled when all OAuth fields are empty
    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    const saveBtn = screen.getByRole("button", { name: "Save Credentials" });
    expect(saveBtn).toBeDisabled();
  });

  it("shows 'Credentials saved' status when configured but not installed", async () => {
    // Verifies the intermediate status text when OAuth has credentials saved
    // on the server but no access token (not yet installed to workspace).
    mockApi.getLinearOAuthStatus.mockResolvedValue({
      configured: true,
      hasClientId: true,
      hasClientSecret: true,
      hasWebhookSecret: false,
      hasAccessToken: false,
    });

    render(<LinearSettingsPage />);

    expect(await screen.findByText(/Credentials saved/i)).toBeInTheDocument();
  });

  it("shows error when Save Credentials fails", async () => {
    // Verifies that a server error on updateSettings shows the error message
    mockApi.updateSettings.mockRejectedValueOnce(new Error("Server error"));

    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "test-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Credentials" }));

    expect(await screen.findByText("Server error")).toBeInTheDocument();
  });

  it("shows success message after saving OAuth credentials", async () => {
    // Verifies the success banner appears after a successful save
    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "test-id" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Credentials" }));

    expect(await screen.findByText("OAuth credentials saved.")).toBeInTheDocument();
  });

  it("shows error when Install to Workspace API call fails", async () => {
    // Verifies that an error from getLinearOAuthAuthorizeUrl is displayed
    mockApi.getLinearOAuthStatus.mockResolvedValue({
      configured: true,
      hasClientId: true,
      hasClientSecret: true,
      hasWebhookSecret: false,
      hasAccessToken: false,
    });
    mockApi.getLinearOAuthAuthorizeUrl.mockRejectedValueOnce(new Error("Not configured"));

    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    // Wait for the button to be enabled (oauthConfigured = true from API)
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Install to Workspace" })).not.toBeDisabled();
    });

    fireEvent.click(screen.getByRole("button", { name: "Install to Workspace" }));

    expect(await screen.findByText("Not configured")).toBeInTheDocument();
  });

  it("handles OAuth success callback from URL hash", async () => {
    // Verifies that when the URL hash contains oauth_success=true (from
    // the OAuth redirect callback), the component shows the success state.
    mockApi.getLinearOAuthStatus.mockResolvedValue({
      configured: true, hasClientId: true, hasClientSecret: true,
      hasWebhookSecret: true, hasAccessToken: true,
    });

    const originalHash = window.location.hash;
    window.location.hash = "#/settings/linear?oauth_success=true";

    render(<LinearSettingsPage />);

    // The component should detect oauth_success in the URL and show connected state
    expect(await screen.findByText("Agent app connected successfully!")).toBeInTheDocument();

    window.location.hash = originalHash;
  });

  it("handles OAuth error callback from URL hash", async () => {
    // Verifies that when the URL hash contains oauth_error=..., the
    // component displays the decoded error message.
    const originalHash = window.location.hash;
    window.location.hash = "#/settings/linear?oauth_error=access_denied";

    render(<LinearSettingsPage />);

    expect(await screen.findByText("access_denied")).toBeInTheDocument();

    window.location.hash = originalHash;
  });

  it("refreshes configured state after saving credentials", async () => {
    // After saving credentials, the UI should refresh OAuth status so
    // placeholders show "Configured" instead of the initial empty state.
    mockApi.getLinearOAuthStatus
      .mockResolvedValueOnce({ configured: false, hasClientId: false, hasClientSecret: false, hasWebhookSecret: false, hasAccessToken: false })
      .mockResolvedValueOnce({ configured: false, hasClientId: true, hasClientSecret: true, hasWebhookSecret: true, hasAccessToken: false });

    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    // Fill in all three credential fields
    fireEvent.change(screen.getByLabelText("Client ID"), { target: { value: "my-id" } });
    fireEvent.change(screen.getByLabelText("Client Secret"), { target: { value: "my-secret" } });
    fireEvent.change(screen.getByLabelText("Webhook Signing Secret"), { target: { value: "wh-secret" } });

    // Click save
    fireEvent.click(screen.getByRole("button", { name: "Save Credentials" }));
    await waitFor(() => expect(mockApi.updateSettings).toHaveBeenCalled());

    // After save, getLinearOAuthStatus should have been called again to refresh state
    await waitFor(() => expect(mockApi.getLinearOAuthStatus).toHaveBeenCalledTimes(2));
  });

  it("disables Install to Workspace when credentials are not persisted on server", async () => {
    // Verifies that typing a Client ID locally does NOT enable Install —
    // only server-side oauthConfigured makes the button clickable.
    render(<LinearSettingsPage />);
    await screen.findByText("Linear Agent App");

    // Type a client ID locally — but oauthConfigured is false from the API
    fireEvent.change(screen.getByLabelText("Client ID"), {
      target: { value: "my-client-id" },
    });

    // Install button should still be disabled because credentials aren't persisted
    const installBtn = screen.getByRole("button", { name: "Install to Workspace" });
    expect(installBtn).toBeDisabled();
  });
});
