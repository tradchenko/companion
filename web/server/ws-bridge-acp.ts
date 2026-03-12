/**
 * Обработчики ACP-адаптера для WsBridge.
 *
 * Повторяет паттерн ws-bridge-codex.ts — подключает AcpAdapter к сессии,
 * транслирует сообщения между адаптером и браузерами.
 */

import type {
   BrowserIncomingMessage,
   BrowserOutgoingMessage,
} from './session-types.js';
import type { AcpAdapter } from './acp-adapter.js';
import type { Session } from './ws-bridge-types.js';

export interface AcpAttachDeps {
   persistSession: (session: Session) => void;
   refreshGitInfo: (session: Session, options?: { broadcastUpdate?: boolean; notifyPoller?: boolean }) => void;
   broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void;
   onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null;
   onFirstTurnCompleted: ((sessionId: string, firstUserMessage: string) => void) | null;
   autoNamingAttempted: Set<string>;
   /** Подписчики на assistant-сообщения (используется chat relay). */
   assistantMessageListeners: Map<string, Set<(msg: BrowserIncomingMessage) => void>>;
   /** Подписчики на result-сообщения (используется chat relay). */
   resultListeners: Map<string, Set<(msg: BrowserIncomingMessage) => void>>;
   /** Коллбэк для авто-перезапуска при отключении бекенда. */
   onCLIRelaunchNeeded: ((sessionId: string) => void) | null;
}

export function attachAcpAdapterHandlers(
   sessionId: string,
   session: Session,
   adapter: AcpAdapter,
   deps: AcpAttachDeps,
): void {
   adapter.onBrowserMessage((msg) => {
      // Обработка session_init / session_update — обновляем состояние сессии
      if (msg.type === 'session_init') {
         const { slash_commands, skills, ...rest } = msg.session;
         session.state = {
            ...session.state,
            ...rest,
            ...(slash_commands?.length ? { slash_commands } : {}),
            ...(skills?.length ? { skills } : {}),
            backend_type: 'acp',
         };
         deps.refreshGitInfo(session, { notifyPoller: true });
         deps.persistSession(session);
      } else if (msg.type === 'session_update') {
         const { slash_commands, skills, ...rest } = msg.session;
         session.state = {
            ...session.state,
            ...rest,
            ...(slash_commands?.length ? { slash_commands } : {}),
            ...(skills?.length ? { skills } : {}),
            backend_type: 'acp',
         };
         deps.refreshGitInfo(session, { notifyPoller: true });
         deps.persistSession(session);
      } else if (msg.type === 'status_change') {
         session.state.is_compacting = msg.status === 'compacting';
         deps.persistSession(session);
      }

      // assistant — сохраняем в историю, уведомляем слушателей
      if (msg.type === 'assistant') {
         const assistantMsg = { ...msg, timestamp: msg.timestamp || Date.now() };
         session.messageHistory.push(assistantMsg);
         deps.persistSession(session);
         deps.assistantMessageListeners.get(sessionId)?.forEach((cb) => {
            try {
               cb(assistantMsg);
            } catch (err) {
               console.error('[ws-bridge-acp] Ошибка в assistant listener:', err);
            }
         });
      } else if (msg.type === 'result') {
         // result — сохраняем в историю, уведомляем слушателей
         session.messageHistory.push(msg);
         deps.persistSession(session);
         deps.resultListeners.get(sessionId)?.forEach((cb) => {
            try {
               Promise.resolve(cb(msg)).catch((err) => console.error('[ws-bridge-acp] Ошибка в async result listener:', err));
            } catch (err) {
               console.error('[ws-bridge-acp] Ошибка в result listener:', err);
            }
         });
      }

      // permission_request — добавляем в pending
      if (msg.type === 'permission_request') {
         const perm = msg.request;
         session.pendingPermissions.set(perm.request_id, perm);
         deps.persistSession(session);
      }

      // Отправляем сообщение во все подключённые браузеры
      deps.broadcastToBrowsers(session, msg);

      // Авто-именование после первого успешного result
      if (
         msg.type === 'result' &&
         !(msg.data as { is_error?: boolean }).is_error &&
         deps.onFirstTurnCompleted &&
         !deps.autoNamingAttempted.has(session.id)
      ) {
         deps.autoNamingAttempted.add(session.id);
         const firstUserMsg = session.messageHistory.find((m) => m.type === 'user_message');
         if (firstUserMsg && firstUserMsg.type === 'user_message') {
            deps.onFirstTurnCompleted(session.id, firstUserMsg.content);
         }
      }
   });

   // Метаданные сессии — threadId, model, cwd
   adapter.onSessionMeta((meta) => {
      if (meta.cliSessionId && deps.onCLISessionId) {
         deps.onCLISessionId(session.id, meta.cliSessionId as string);
      }
      if (meta.model) session.state.model = meta.model as string;
      if (meta.cwd) session.state.cwd = meta.cwd as string;
      session.state.backend_type = 'acp';
      deps.refreshGitInfo(session, { broadcastUpdate: true, notifyPoller: true });
      deps.persistSession(session);
   });

   // Отключение адаптера
   adapter.onDisconnect(() => {
      // Защита: игнорируем отключение устаревшего адаптера (при перезапуске
      // новый адаптер подключается до того, как старый отправит disconnect)
      if (session.acpAdapter !== adapter) {
         console.log(`[ws-bridge] Игнорируем устаревший disconnect для сессии ${sessionId} (адаптер заменён)`);
         return;
      }
      // Отменяем все pending permissions
      for (const [reqId] of session.pendingPermissions) {
         deps.broadcastToBrowsers(session, { type: 'permission_cancelled', request_id: reqId });
      }
      session.pendingPermissions.clear();
      session.acpAdapter = null;
      deps.persistSession(session);
      console.log(`[ws-bridge] ACP-адаптер отключён для сессии ${sessionId}`);
      deps.broadcastToBrowsers(session, { type: 'cli_disconnected' });

      // Авто-перезапуск, если браузеры ещё подключены
      if (session.browserSockets.size > 0 && deps.onCLIRelaunchNeeded) {
         console.log(`[ws-bridge] Авто-перезапуск ACP для сессии ${sessionId} (${session.browserSockets.size} браузер(ов) подключено)`);
         deps.onCLIRelaunchNeeded(sessionId);
      }
   });

   // Сбрасываем очередь сообщений, накопившихся до подключения адаптера
   if (session.pendingMessages.length > 0) {
      console.log(`[ws-bridge] Сбрасываем ${session.pendingMessages.length} сообщение(й) в ACP-адаптер для сессии ${sessionId}`);
      const queued = session.pendingMessages.splice(0);
      for (const raw of queued) {
         try {
            const msg = JSON.parse(raw) as BrowserOutgoingMessage;
            adapter.sendBrowserMessage(msg);
         } catch {
            console.warn(`[ws-bridge] Не удалось распарсить сообщение для ACP: ${raw.substring(0, 100)}`);
         }
      }
   }

   deps.broadcastToBrowsers(session, { type: 'cli_connected' });
   console.log(`[ws-bridge] ACP-адаптер подключён для сессии ${sessionId}`);
}
