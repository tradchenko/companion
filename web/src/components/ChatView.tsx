import { useMemo, useState, useCallback, useEffect } from "react";
import { useStore } from "../store.js";
import { api } from "../api.js";
import { captureException } from "../analytics.js";
import { MessageFeed } from "./MessageFeed.js";
import { Composer } from "./Composer.js";
import { PermissionBanner } from "./PermissionBanner.js";
import { AiValidationBadge } from "./AiValidationBadge.js";

export function ChatView({ sessionId }: { sessionId: string }) {
  const sessionPerms = useStore((s) => s.pendingPermissions.get(sessionId));
  const aiResolved = useStore((s) => s.aiResolvedPermissions.get(sessionId));
  const clearAiResolvedPermissions = useStore((s) => s.clearAiResolvedPermissions);
  const connStatus = useStore(
    (s) => s.connectionStatus.get(sessionId) ?? "disconnected"
  );
  const cliConnected = useStore((s) => s.cliConnected.get(sessionId) ?? false);
  const [relaunching, setRelaunching] = useState(false);

  // Сбрасываем состояние relaunching при восстановлении соединения
  useEffect(() => {
    if (cliConnected) setRelaunching(false);
  }, [cliConnected]);

  const handleRelaunch = useCallback(() => {
    setRelaunching(true);
    api.relaunchSession(sessionId).catch((err) => {
      setRelaunching(false);
      captureException(err);
    });
  }, [sessionId]);

  const perms = useMemo(
    () => (sessionPerms ? Array.from(sessionPerms.values()) : []),
    [sessionPerms]
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* CLI disconnected / reconnecting banner */}
      {connStatus === "connected" && !cliConnected && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center flex items-center justify-center gap-3">
          {relaunching ? (
            <>
              <span className="w-3 h-3 border-2 border-cc-warning/40 border-t-cc-warning rounded-full animate-spin shrink-0" />
              <span className="text-xs text-cc-warning font-medium">
                Переподключение...
              </span>
            </>
          ) : (
            <>
              <span className="text-xs text-cc-warning font-medium">
                CLI disconnected
              </span>
              <button
                onClick={handleRelaunch}
                className="text-xs font-medium px-3 py-2 rounded-md bg-cc-warning/20 hover:bg-cc-warning/30 text-cc-warning transition-colors cursor-pointer"
              >
                Reconnect
              </button>
            </>
          )}
        </div>
      )}

      {/* WebSocket disconnected banner */}
      {connStatus === "disconnected" && (
        <div className="px-4 py-2 bg-cc-warning/10 border-b border-cc-warning/20 text-center">
          <span className="text-xs text-cc-warning font-medium">
            Reconnecting to session...
          </span>
        </div>
      )}

      {/* Message feed */}
      <MessageFeed sessionId={sessionId} />

      {/* AI auto-resolved notification (most recent only) */}
      {aiResolved && aiResolved.length > 0 && (
        <div className="shrink-0 border-t border-cc-border bg-cc-card">
          <AiValidationBadge
            entry={aiResolved[aiResolved.length - 1]}
            onDismiss={() => clearAiResolvedPermissions(sessionId)}
          />
        </div>
      )}

      {/* Permission banners */}
      {perms.length > 0 && (
        <div className="shrink-0 max-h-[60dvh] overflow-y-auto border-t border-cc-border bg-cc-card">
          {perms.map((p) => (
            <PermissionBanner key={p.request_id} permission={p} sessionId={sessionId} />
          ))}
        </div>
      )}

      {/* Composer */}
      <Composer sessionId={sessionId} />
    </div>
  );
}
