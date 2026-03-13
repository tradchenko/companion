/**
 * ACP (Agent Client Protocol) Adapter
 *
 * Транслирует между протоколом ACP JSON-RPC и типами
 * BrowserIncomingMessage/BrowserOutgoingMessage, используемыми The Companion.
 *
 * Браузер не знает, какой бекенд запущен — он видит одни и те же типы сообщений
 * независимо от того, Claude Code, Codex или ACP-агент работает за кулисами.
 */

import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
   BrowserIncomingMessage,
   BrowserOutgoingMessage,
   SessionState,
   PermissionRequest,
   CLIResultMessage,
} from './session-types.js';
import type { RecorderManager } from './recorder.js';
import { readMcpServersForAcp } from './mcp-config-reader.js';

// ─── Интерфейс ACP-транспорта ────────────────────────────────────────────────
// Если acp-transport.ts ещё не создан другим агентом, используем этот интерфейс.
// Реальная реализация будет подключена позже.

/** Абстрактный транспорт для ACP JSON-RPC коммуникации. */
export interface IAcpTransport {
   /** Вызов RPC-метода с ожиданием ответа */
   call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
   /** Отправка уведомления (без ожидания ответа) */
   notify(method: string, params?: Record<string, unknown>): void;
   /** Ответ на входящий запрос по его id */
   respond(id: number | string, result: unknown): void;
   /** Обработчик входящих уведомлений от агента */
   onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
   /** Обработчик входящих запросов от агента */
   onRequest(handler: (method: string, id: number | string, params: Record<string, unknown>) => void): void;
   /** Коллбэк для записи сырых входящих сообщений */
   onRawIncoming(cb: (line: string) => void): void;
   /** Коллбэк для записи сырых исходящих сообщений */
   onRawOutgoing(cb: (data: string) => void): void;
   /** Подключён ли транспорт */
   isConnected(): boolean;
}

// ─── Опции адаптера ──────────────────────────────────────────────────────────

export interface AcpAdapterOptions {
   agentId: string;
   cwd: string;
   model?: string;
   /** ACP sessionId для возобновления через session/load */
   threadId?: string;
   /** Рекордер для записи сырых сообщений протокола */
   recorder?: RecorderManager;
   /** Коллбэк для завершения процесса/соединения при отключении */
   killProcess?: () => Promise<void> | void;
}

// ─── ACP типы ────────────────────────────────────────────────────────────────

/** Блок контента ACP */
interface AcpContentBlock {
   type: 'text';
   text: string;
}

/** Запись плана ACP */
interface AcpPlanEntry {
   id: string;
   title: string;
   status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

/** Варианты обновления сессии от агента */
interface AcpSessionUpdateBase {
   sessionUpdate: string;
}

interface AcpAgentMessageChunk extends AcpSessionUpdateBase {
   sessionUpdate: 'agent_message_chunk';
   content: AcpContentBlock;
}

interface AcpAgentThoughtChunk extends AcpSessionUpdateBase {
   sessionUpdate: 'agent_thought_chunk';
   content: AcpContentBlock;
}

interface AcpToolCall extends AcpSessionUpdateBase {
   sessionUpdate: 'tool_call';
   toolCallId: string;
   title: string;
   kind?: string;
   status: 'in_progress' | 'completed' | 'failed';
   content?: AcpContentBlock[];
   locations?: unknown[];
}

interface AcpToolCallUpdate extends AcpSessionUpdateBase {
   sessionUpdate: 'tool_call_update';
   toolCallId: string;
   status: 'in_progress' | 'completed' | 'failed';
   title?: string;
   content?: AcpContentBlock[];
   locations?: unknown[];
}

interface AcpPlan extends AcpSessionUpdateBase {
   sessionUpdate: 'plan';
   entries: AcpPlanEntry[];
}

interface AcpSessionInfoUpdate extends AcpSessionUpdateBase {
   sessionUpdate: 'session_info_update';
   title?: string;
   updatedAt?: string;
}

type AcpSessionUpdate =
   | AcpAgentMessageChunk
   | AcpAgentThoughtChunk
   | AcpToolCall
   | AcpToolCallUpdate
   | AcpPlan
   | AcpSessionInfoUpdate;

// ─── Таймауты RPC ───────────────────────────────────────────────────────────

/** Таймаут по умолчанию для RPC-вызовов (мс) */
const DEFAULT_RPC_TIMEOUT_MS = 60_000;

/** Таймауты для конкретных методов (мс) */
const RPC_METHOD_TIMEOUTS: Record<string, number> = {
   'session/prompt': 300_000, // Генерация может занять долго
   'initialize': 30_000,
   'session/new': 30_000,
   'session/load': 30_000,
};

// ─── Адаптер ─────────────────────────────────────────────────────────────────

export class AcpAdapter {
   private transport: IAcpTransport;
   private sessionId: string;
   private options: AcpAdapterOptions;

   // Коллбэки
   private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
   private sessionMetaCb: ((meta: Record<string, unknown>) => void) | null = null;
   private disconnectCb: (() => void) | null = null;
   private initErrorCb: ((error: string) => void) | null = null;

   // Состояние сессии
   private acpSessionId: string | null = null;
   private connected = false;
   private initialized = false;
   private initFailed = false;
   private initInProgress = false;

   // Очередь сообщений до инициализации
   private pendingOutgoing: BrowserOutgoingMessage[] = [];

   // Стриминг текста — аккумулируем чанки
   private streamingText = '';
   private streamingMessageId: string = randomUUID();

   // Маппинг permission request: наш requestId → jsonRpcId
   private pendingPermissions = new Map<string, number | string>();

   // Счётчик turns
   private numTurns = 0;

   constructor(transport: IAcpTransport, sessionId: string, options: AcpAdapterOptions) {
      this.transport = transport;
      this.sessionId = sessionId;
      this.options = options;

      // Подписываемся на уведомления и запросы от агента
      this.transport.onNotification((method, params) => this.handleNotification(method, params));
      this.transport.onRequest((method, id, params) => this.handleRequest(method, id, params));

      // Подключаем запись сырых сообщений если передан рекордер
      if (options.recorder) {
         const recorder = options.recorder;
         const cwd = options.cwd || '';
         this.transport.onRawIncoming((line) => {
            recorder.record(sessionId, 'in', line, 'cli', 'acp', cwd);
         });
         this.transport.onRawOutgoing((data) => {
            recorder.record(sessionId, 'out', data.trimEnd(), 'cli', 'acp', cwd);
         });
      }

      // Запускаем инициализацию
      this.initialize();
   }

   // ── Публичный API (совпадает с CodexAdapter) ──────────────────────────

   /** Подписка на сообщения для браузера */
   onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
      this.browserMessageCb = cb;
   }

   /** Подписка на метаданные сессии */
   onSessionMeta(cb: (meta: Record<string, unknown>) => void): void {
      this.sessionMetaCb = cb;
   }

   /** Подписка на отключение */
   onDisconnect(cb: () => void): void {
      this.disconnectCb = cb;
   }

   /** Подписка на ошибку инициализации */
   onInitError(cb: (error: string) => void): void {
      this.initErrorCb = cb;
   }

   /** Отправить сообщение от браузера к ACP-агенту */
   sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
      // Если инициализация провалилась — отклоняем
      if (this.initFailed) {
         return false;
      }

      // Очередь сообщений до завершения инициализации
      if (!this.initialized || !this.acpSessionId || this.initInProgress) {
         if (msg.type === 'user_message' || msg.type === 'permission_response') {
            console.log(`[acp-adapter] Очередь ${msg.type} — адаптер ещё не инициализирован`);
            this.pendingOutgoing.push(msg);
            return true;
         }
         if (!this.connected) return false;
      }

      // Проверяем что транспорт жив
      if (!this.transport.isConnected()) {
         console.warn(`[acp-adapter] Транспорт отключён — не могу отправить ${msg.type}`);
         return false;
      }

      // Сбрасываем очередь
      this.flushPendingOutgoing();

      return this.dispatchOutgoing(msg);
   }

   /** Получить ACP sessionId (аналог threadId) */
   getThreadId(): string | null {
      return this.acpSessionId;
   }

   /** Подключён ли адаптер */
   isConnected(): boolean {
      return this.connected;
   }

   /** Отключиться от агента */
   async disconnect(): Promise<void> {
      this.connected = false;
      if (this.options.killProcess) {
         try {
            await this.options.killProcess();
         } catch {
            // Игнорируем ошибки при завершении
         }
      }
   }

   /** Уведомить адаптер что транспорт закрылся */
   handleTransportClose(): void {
      this.connected = false;
      this.pendingPermissions.clear();
      this.disconnectCb?.();
   }

   // ── Инициализация ─────────────────────────────────────────────────────

   private async initialize(): Promise<void> {
      if (this.initInProgress) {
         console.warn('[acp-adapter] initialize() вызван повторно — пропускаем');
         return;
      }
      this.initInProgress = true;

      try {
         // Шаг 1: Инициализация ACP-протокола
         await this.transport.call(
            'initialize',
            {
               protocolVersion: 1,
               clientCapabilities: {
                  fs: { readTextFile: true, writeTextFile: true },
                  terminal: true,
               },
               clientInfo: {
                  name: 'the-companion',
                  version: '1.0.0',
               },
            },
            RPC_METHOD_TIMEOUTS['initialize'],
         );

         this.connected = true;

         // Шаг 2: Создаём или загружаем сессию
         if (this.options.threadId) {
            // Возобновляем существующую сессию
            const loadResult = (await this.transport.call(
               'session/load',
               {
                  sessionId: this.options.threadId,
               },
               RPC_METHOD_TIMEOUTS['session/load'],
            )) as { sessionId: string };
            this.acpSessionId = loadResult.sessionId;
         } else {
            // Создаём новую сессию, пробрасывая MCP-серверы из конфигов
            const mcpServers = readMcpServersForAcp();
            const newResult = (await this.transport.call(
               'session/new',
               {
                  cwd: this.options.cwd,
                  mcpServers,
               },
               RPC_METHOD_TIMEOUTS['session/new'],
            )) as { sessionId: string };
            this.acpSessionId = newResult.sessionId;
         }

         this.initialized = true;
         console.log(`[acp-adapter] Сессия ${this.sessionId} инициализирована (acpSessionId=${this.acpSessionId})`);

         // Уведомляем о метаданных сессии
         this.sessionMetaCb?.({
            cliSessionId: this.acpSessionId ?? undefined,
            model: this.options.model,
            cwd: this.options.cwd,
         });

         // Отправляем session_init в браузер
         const state: SessionState = {
            session_id: this.sessionId,
            backend_type: 'acp',
            model: this.options.model || '',
            cwd: this.options.cwd || '',
            tools: [],
            permissionMode: 'default',
            claude_code_version: '',
            mcp_servers: [],
            agents: [this.options.agentId],
            slash_commands: [],
            skills: [],
            total_cost_usd: 0,
            num_turns: 0,
            context_used_percent: 0,
            is_compacting: false,
            git_branch: '',
            is_worktree: false,
            is_containerized: false,
            repo_root: '',
            git_ahead: 0,
            git_behind: 0,
            total_lines_added: 0,
            total_lines_removed: 0,
            agentId: this.options.agentId,
         };

         this.emit({ type: 'session_init', session: state });

         // Сбрасываем очередь сообщений, накопившихся во время инициализации
         this.flushPendingOutgoing();
      } catch (err) {
         const errorMsg = `Ошибка инициализации ACP: ${err}`;
         console.error(`[acp-adapter] ${errorMsg}`);
         this.initFailed = true;
         this.connected = false;
         this.pendingOutgoing.length = 0;
         this.emit({ type: 'error', message: errorMsg });
         this.initErrorCb?.(errorMsg);
      } finally {
         this.initInProgress = false;
      }
   }

   // ── Обработка входящих уведомлений от агента ──────────────────────────

   private handleNotification(method: string, params: Record<string, unknown>): void {
      if (method === 'session/update') {
         this.handleSessionUpdate(params as unknown as AcpSessionUpdate);
      }
   }

   /** Трансляция session/update уведомлений в BrowserIncomingMessage */
   private handleSessionUpdate(update: AcpSessionUpdate): void {
      switch (update.sessionUpdate) {
         case 'agent_message_chunk':
            this.handleAgentMessageChunk(update);
            break;
         case 'agent_thought_chunk':
            this.handleAgentThoughtChunk(update);
            break;
         case 'tool_call':
            this.handleToolCall(update);
            break;
         case 'tool_call_update':
            this.handleToolCallUpdate(update);
            break;
         case 'plan':
            this.handlePlan(update);
            break;
         case 'session_info_update':
            this.handleSessionInfoUpdate(update);
            break;
      }
   }

   /** agent_message_chunk → stream_event с накоплением текста */
   private handleAgentMessageChunk(update: AcpAgentMessageChunk): void {
      this.streamingText += update.content.text;
      this.emit({
         type: 'stream_event',
         event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: update.content.text },
         },
         parent_tool_use_id: null,
      });
   }

   /** agent_thought_chunk → stream_event для thinking/reasoning */
   private handleAgentThoughtChunk(update: AcpAgentThoughtChunk): void {
      this.emit({
         type: 'stream_event',
         event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: update.content.text },
         },
         parent_tool_use_id: null,
      });
   }

   /** tool_call → assistant сообщение с tool_use блоком */
   private handleToolCall(update: AcpToolCall): void {
      this.emit({
         type: 'assistant',
         message: {
            id: `msg_${update.toolCallId}`,
            type: 'message',
            role: 'assistant',
            model: this.options.model || '',
            content: [
               {
                  type: 'tool_use',
                  id: update.toolCallId,
                  name: update.title,
                  input: {
                     kind: update.kind || '',
                     status: update.status,
                  },
               },
            ],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
         },
         parent_tool_use_id: null,
      });
   }

   /** tool_call_update с status "completed" → result */
   private handleToolCallUpdate(update: AcpToolCallUpdate): void {
      if (update.status === 'completed' || update.status === 'failed') {
         // Формируем текст результата из content блоков
         const resultText = update.content?.map((c) => c.text).join('\n') || '';

         this.emit({
            type: 'assistant',
            message: {
               id: `msg_result_${update.toolCallId}`,
               type: 'message',
               role: 'assistant',
               model: this.options.model || '',
               content: [
                  {
                     type: 'tool_result',
                     tool_use_id: update.toolCallId,
                     content: resultText,
                     is_error: update.status === 'failed',
                  },
               ],
               stop_reason: null,
               usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            },
            parent_tool_use_id: null,
         });
      }
   }

   /** plan → assistant сообщение с информацией о плане */
   private handlePlan(update: AcpPlan): void {
      const planText = update.entries.map((e) => `[${e.status}] ${e.title}`).join('\n');
      this.emit({
         type: 'assistant',
         message: {
            id: `msg_plan_${randomUUID()}`,
            type: 'message',
            role: 'assistant',
            model: this.options.model || '',
            content: [{ type: 'text', text: `План:\n${planText}` }],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
         },
         parent_tool_use_id: null,
      });
   }

   /** session_info_update → session_update с заголовком */
   private handleSessionInfoUpdate(update: AcpSessionInfoUpdate): void {
      if (update.title) {
         this.emit({
            type: 'session_name_update',
            name: update.title,
         });
      }
   }

   // ── Обработка входящих запросов от агента ─────────────────────────────

   private handleRequest(method: string, id: number | string, params: Record<string, unknown>): void {
      switch (method) {
         case 'session/request_permission':
            this.handlePermissionRequest(id, params);
            break;
         case 'fs/read_text_file':
            this.handleFsReadTextFile(id, params);
            break;
         case 'fs/write_text_file':
            this.handleFsWriteTextFile(id, params);
            break;
         case 'terminal/create':
         case 'terminal/output':
         case 'terminal/wait_for_exit':
         case 'terminal/kill':
         case 'terminal/release':
            // Заглушка для терминальных запросов — пока не реализовано
            this.handleTerminalStub(id, method);
            break;
         default:
            console.warn(`[acp-adapter] Неизвестный запрос от агента: ${method}`);
      }
   }

   /** session/request_permission → permission_request для браузера */
   private handlePermissionRequest(jsonRpcId: number | string, params: Record<string, unknown>): void {
      const requestId = randomUUID();
      const toolCall = params.toolCall as { title?: string; kind?: string; toolCallId?: string } | undefined;
      const options = params.options as string[] | undefined;

      // Сохраняем маппинг наш requestId → jsonRpcId
      this.pendingPermissions.set(requestId, jsonRpcId);

      const permRequest: PermissionRequest = {
         request_id: requestId,
         tool_name: toolCall?.title || 'unknown',
         input: {
            kind: toolCall?.kind || '',
            options: options || [],
         },
         tool_use_id: toolCall?.toolCallId || requestId,
         timestamp: Date.now(),
      };

      this.emit({ type: 'permission_request', request: permRequest });
   }

   /** fs/read_text_file → читаем файл с диска и отвечаем */
   private async handleFsReadTextFile(id: number | string, params: Record<string, unknown>): Promise<void> {
      const path = params.path as string;
      try {
         const content = await readFile(path, 'utf-8');
         await this.transport.respond(id, { content });
      } catch (err) {
         await this.transport.respond(id, { error: `Не удалось прочитать файл: ${err}` });
      }
   }

   /** fs/write_text_file → записываем файл на диск и отвечаем */
   private async handleFsWriteTextFile(id: number | string, params: Record<string, unknown>): Promise<void> {
      const path = params.path as string;
      const content = params.content as string;
      try {
         await mkdir(dirname(path), { recursive: true });
         await writeFile(path, content, 'utf-8');
         await this.transport.respond(id, { success: true });
      } catch (err) {
         await this.transport.respond(id, { error: `Не удалось записать файл: ${err}` });
      }
   }

   /** Заглушка для терминальных запросов */
   private async handleTerminalStub(id: number | string, method: string): Promise<void> {
      console.warn(`[acp-adapter] Терминальный запрос ${method} пока не реализован`);
      await this.transport.respond(id, { error: `${method} не реализован` });
   }

   // ── Исходящие сообщения (браузер → агент) ─────────────────────────────

   private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
      switch (msg.type) {
         case 'user_message':
            this.handleOutgoingUserMessage(msg);
            return true;
         case 'permission_response':
            this.handleOutgoingPermissionResponse(msg);
            return true;
         case 'interrupt':
            this.handleOutgoingInterrupt();
            return true;
         default:
            return false;
      }
   }

   /** user_message → session/prompt */
   private async handleOutgoingUserMessage(msg: { type: 'user_message'; content: string; images?: { media_type: string; data: string }[] }): Promise<void> {
      if (!this.acpSessionId) {
         this.emit({ type: 'error', message: 'ACP-сессия ещё не создана' });
         return;
      }

      // Сбрасываем стриминг перед новым промптом
      this.streamingText = '';
      this.streamingMessageId = randomUUID();
      this.numTurns++;

      // Статус "running"
      this.emit({ type: 'status_change', status: 'running' });

      try {
         const result = (await this.transport.call(
            'session/prompt',
            {
               sessionId: this.acpSessionId,
               prompt: [{ type: 'text', text: msg.content }],
            },
            RPC_METHOD_TIMEOUTS['session/prompt'],
         )) as { stopReason?: string };

         // Если есть накопленный текст — отправляем финальное assistant-сообщение
         if (this.streamingText) {
            this.emit({
               type: 'assistant',
               message: {
                  id: this.streamingMessageId,
                  type: 'message',
                  role: 'assistant',
                  model: this.options.model || '',
                  content: [{ type: 'text', text: this.streamingText }],
                  stop_reason: result.stopReason || 'end_turn',
                  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
               },
               parent_tool_use_id: null,
            });
         }

         // Отправляем result
         const resultMsg: CLIResultMessage = {
            type: 'result',
            subtype: result.stopReason === 'cancelled' ? 'error_during_execution' : 'success',
            is_error: result.stopReason === 'cancelled',
            duration_ms: 0,
            duration_api_ms: 0,
            num_turns: this.numTurns,
            total_cost_usd: 0,
            stop_reason: result.stopReason || 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            uuid: randomUUID(),
            session_id: this.sessionId,
         };

         this.emit({ type: 'result', data: resultMsg });

         // Сбрасываем стриминг
         this.streamingText = '';
      } catch (err) {
         this.emit({ type: 'error', message: `Ошибка session/prompt: ${err}` });
      } finally {
         // Статус "idle"
         this.emit({ type: 'status_change', status: 'idle' });
      }
   }

   /** permission_response → ответ на pending permission request */
   private handleOutgoingPermissionResponse(msg: { type: 'permission_response'; request_id: string; behavior: 'allow' | 'deny' }): void {
      const jsonRpcId = this.pendingPermissions.get(msg.request_id);
      if (jsonRpcId === undefined) {
         console.warn(`[acp-adapter] Неизвестный permission request_id: ${msg.request_id}`);
         return;
      }

      this.pendingPermissions.delete(msg.request_id);

      if (msg.behavior === 'allow') {
         this.transport.respond(jsonRpcId, {
            outcome: { outcome: 'selected', optionId: 'allow_once' },
         });
      } else {
         this.transport.respond(jsonRpcId, {
            outcome: { outcome: 'selected', optionId: 'reject_once' },
         });
      }
   }

   /** interrupt → session/cancel уведомление */
   private handleOutgoingInterrupt(): void {
      if (!this.acpSessionId) return;
      this.transport.notify('session/cancel', { sessionId: this.acpSessionId });
   }

   // ── Вспомогательные методы ────────────────────────────────────────────

   /** Сбросить очередь ожидающих сообщений */
   private flushPendingOutgoing(): void {
      if (this.pendingOutgoing.length === 0) return;
      if (!this.transport.isConnected()) {
         console.warn(
            `[acp-adapter] Сессия ${this.sessionId}: транспорт отключён — ${this.pendingOutgoing.length} сообщение(й) в очереди`,
         );
         return;
      }
      console.log(`[acp-adapter] Сессия ${this.sessionId}: сбрасываем ${this.pendingOutgoing.length} сообщение(й) из очереди`);
      const queued = this.pendingOutgoing.splice(0);
      for (const msg of queued) {
         this.dispatchOutgoing(msg);
      }
   }

   /** Отправить сообщение в браузер */
   private emit(msg: BrowserIncomingMessage): void {
      this.browserMessageCb?.(msg);
   }
}
