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
   ContentBlock,
} from './session-types.js';
import type { RecorderManager } from './recorder.js';
import type { IBackendAdapter } from './backend-adapter.js';
import { readMcpServersForAcp } from './mcp-config-reader.js';
import { cacheAcpAgentModels } from './acp-registry.js';

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

interface AcpAvailableCommandsUpdate extends AcpSessionUpdateBase {
   sessionUpdate: 'available_commands_update';
   availableCommands: { name: string; description?: string; aliases?: string[]; input?: unknown }[];
}

type AcpSessionUpdate =
   | AcpAgentMessageChunk
   | AcpAgentThoughtChunk
   | AcpToolCall
   | AcpToolCallUpdate
   | AcpPlan
   | AcpSessionInfoUpdate
   | AcpAvailableCommandsUpdate;

/** Ответ session/new — содержит модели и режимы */
interface AcpSessionNewResult {
   sessionId: string;
   models?: {
      availableModels?: { modelId: string; name?: string; description?: string; _meta?: { contextLimit?: number } }[];
      currentModelId?: string;
   };
   modes?: {
      availableModes?: { id: string; name?: string; description?: string }[];
      currentModeId?: string;
   };
}

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

export class AcpAdapter implements IBackendAdapter {
   private transport: IAcpTransport;
   private sessionId: string;
   private options: AcpAdapterOptions;

   // Коллбэки
   private browserMessageCb: ((msg: BrowserIncomingMessage) => void) | null = null;
   private sessionMetaCb: ((meta: { cliSessionId?: string; model?: string; cwd?: string }) => void) | null = null;
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
   private streamingThinkingText = '';
   private streamingMessageId: string = randomUUID();

   // Маппинг permission request: наш requestId → { jsonRpcId, options }
   private pendingPermissions = new Map<
      string,
      { jsonRpcId: number | string; options: Array<{ optionId: string; kind?: string }> }
   >();

   // Счётчик turns
   private numTurns = 0;

   // Модели и режимы от ACP-агента
   private availableModels: { value: string; label: string }[] = [];
   private availableModes: { value: string; label: string }[] = [];
   private currentModel = '';
   private currentMode = '';

   // Аккумуляция usage из _meta (ACP агенты шлют в каждом agent_message_chunk)
   private totalInputTokens = 0;
   private totalOutputTokens = 0;
   private contextLimit = 0;

   // MCP-серверы, переданные агенту при создании сессии
   private mcpServerNames: string[] = [];

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
   onSessionMeta(cb: (meta: { cliSessionId?: string; model?: string; cwd?: string }) => void): void {
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

   /** IBackendAdapter.send() — единая точка входа для сообщений от браузера */
   send(msg: BrowserOutgoingMessage): boolean {
      return this.sendBrowserMessage(msg);
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
         // Прогресс: подключение
         this.emitProgress(`Connecting to ${this.options.agentId}...`);

         // Шаг 1: Инициализация ACP-протокола
         const initResult = await this.transport.call(
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
         ) as { agentInfo?: { name?: string; version?: string } } | undefined;

         this.connected = true;
         const agentVersion = initResult?.agentInfo?.version;
         const agentName = initResult?.agentInfo?.name || this.options.agentId;

         // Прогресс: создание сессии
         this.emitProgress(`${agentName}${agentVersion ? ` v${agentVersion}` : ''} — creating session...`);

         // Шаг 2: Создаём или загружаем сессию
         if (this.options.threadId) {
            // Возобновляем существующую сессию — передаём cwd и mcpServers (Qwen требует)
            const mcpServers = readMcpServersForAcp();
            this.mcpServerNames = (mcpServers as Array<{ name?: string }>).map((s) => s.name || 'unknown');
            const loadResult = (await this.transport.call(
               'session/load',
               {
                  sessionId: this.options.threadId,
                  cwd: this.options.cwd,
                  mcpServers,
               },
               RPC_METHOD_TIMEOUTS['session/load'],
            )) as AcpSessionNewResult;
            this.acpSessionId = loadResult.sessionId;
            // Парсим модели и режимы из ответа session/load
            if (loadResult.models?.availableModels) {
               this.availableModels = loadResult.models.availableModels.map((m) => ({
                  value: m.modelId,
                  label: m.name || m.modelId,
               }));
               cacheAcpAgentModels(this.options.agentId, this.availableModels);
               for (const m of loadResult.models.availableModels) {
                  if (m._meta?.contextLimit && m._meta.contextLimit > 0) {
                     this.contextLimit = m._meta.contextLimit;
                     break;
                  }
               }
            }
            if (loadResult.models?.currentModelId) {
               this.currentModel = loadResult.models.currentModelId;
            }
            if (loadResult.modes?.availableModes) {
               this.availableModes = loadResult.modes.availableModes.map((m) => ({
                  value: m.id,
                  label: m.name || m.id,
               }));
            }
            if (loadResult.modes?.currentModeId) {
               this.currentMode = loadResult.modes.currentModeId;
            }
         } else {
            // Создаём новую сессию, пробрасывая MCP-серверы из конфигов
            const mcpServers = readMcpServersForAcp();
            // Сохраняем имена MCP-серверов для отображения в панели
            this.mcpServerNames = (mcpServers as Array<{ name?: string }>).map((s) => s.name || 'unknown');
            const newResult = (await this.transport.call(
               'session/new',
               {
                  cwd: this.options.cwd,
                  mcpServers,
               },
               RPC_METHOD_TIMEOUTS['session/new'],
            )) as AcpSessionNewResult;
            this.acpSessionId = newResult.sessionId;
            // Парсим модели и режимы из ответа ACP-агента
            if (newResult.models?.availableModels) {
               this.availableModels = newResult.models.availableModels.map((m) => ({
                  value: m.modelId,
                  label: m.name || m.modelId,
               }));
               // Кешируем модели для консистентности на HomePage
               cacheAcpAgentModels(this.options.agentId, this.availableModels);
               // Извлекаем contextLimit из метаданных модели
               for (const m of newResult.models.availableModels) {
                  if (m._meta?.contextLimit && m._meta.contextLimit > 0) {
                     this.contextLimit = m._meta.contextLimit;
                     break;
                  }
               }
            }
            if (newResult.models?.currentModelId) {
               this.currentModel = newResult.models.currentModelId;
            }
            if (newResult.modes?.availableModes) {
               this.availableModes = newResult.modes.availableModes.map((m) => ({
                  value: m.id,
                  label: m.name || m.id,
               }));
            }
            if (newResult.modes?.currentModeId) {
               this.currentMode = newResult.modes.currentModeId;
            }
         }

         this.initialized = true;
         console.log(`[acp-adapter] Сессия ${this.sessionId} инициализирована (acpSessionId=${this.acpSessionId})`);

         // Уведомляем о метаданных сессии
         this.sessionMetaCb?.({
            cliSessionId: this.acpSessionId ?? undefined,
            model: this.currentModel || this.options.model,
            cwd: this.options.cwd,
         });

         // Отправляем session_init в браузер
         const state: SessionState = {
            session_id: this.sessionId,
            backend_type: 'acp',
            model: this.currentModel || this.options.model || '',
            cwd: this.options.cwd || '',
            tools: [],
            permissionMode: this.currentMode || 'default',
            claude_code_version: '',
            mcp_servers: this.mcpServerNames.map((name) => ({ name, status: 'connected' })),
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
            // agentId НЕ ставим — иначе сессия попадёт в "Agent Runs" вместо группировки по проектам.
            // Информация об ACP-агенте доступна через agents[] и backendType.
            availableModels: this.availableModels.length ? this.availableModels : undefined,
            availableModes: this.availableModes.length ? this.availableModes : undefined,
         };

         this.emit({ type: 'session_init', session: state });

         // Сбрасываем очередь сообщений, накопившихся во время инициализации
         this.flushPendingOutgoing();
      } catch (err) {
         const errorMsg = `ACP initialization error: ${err}`;
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
         // ACP присылает {sessionId, update: {sessionUpdate: "...", ...}}
         const rawUpdate = (params.update ?? params) as Record<string, unknown>;
         // Извлекаем _meta.usage для трекинга токенов и контекста
         this.extractUsageFromMeta(rawUpdate);
         const update = rawUpdate as unknown as AcpSessionUpdate;
         this.handleSessionUpdate(update);
      } else if (method === 'available_commands_update') {
         // Qwen и другие агенты присылают slash-команды отдельным уведомлением
         this.handleAvailableCommandsUpdate(params);
      } else if (method.startsWith('_') && params.message) {
         // Vendor-specific уведомления (напр. _qwencode/slash_command) — выводим message как текст
         this.handleVendorNotification(method, params);
      }
   }

   /** Обработка vendor-specific уведомлений с текстовым сообщением */
   private handleVendorNotification(_method: string, params: Record<string, unknown>): void {
      const text = String(params.message ?? '');
      if (!text) return;

      // Сбрасываем накопленный стриминг перед выводом
      this.flushStreamingText();

      const msgId = randomUUID();
      this.emit({
         type: 'assistant',
         message: {
            id: msgId,
            type: 'message',
            role: 'assistant',
            model: this.currentModel,
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
         },
         parent_tool_use_id: null,
      });
   }

   /** Extract usage from _meta in ACP update and emit token details */
   private extractUsageFromMeta(rawUpdate: Record<string, unknown>): void {
      const meta = rawUpdate._meta as {
         usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; thoughtTokens?: number; cachedReadTokens?: number };
      } | undefined;
      if (!meta?.usage) return;

      const { inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens } = meta.usage;
      if (inputTokens != null) this.totalInputTokens = inputTokens;
      if (outputTokens != null) this.totalOutputTokens += outputTokens;

      // Calculate context_used_percent and emit token details
      const pct = this.contextLimit > 0
         ? Math.round(((this.totalInputTokens + this.totalOutputTokens) / this.contextLimit) * 100)
         : 0;

      this.emit({
         type: 'session_update',
         session: {
            context_used_percent: Math.max(0, Math.min(pct, 100)),
            num_turns: this.numTurns,
            acp_token_details: {
               inputTokens: this.totalInputTokens,
               outputTokens: this.totalOutputTokens,
               thoughtTokens: thoughtTokens ?? 0,
               cachedReadTokens: cachedReadTokens ?? 0,
               totalTokens: totalTokens ?? (this.totalInputTokens + this.totalOutputTokens),
               modelContextWindow: this.contextLimit,
            },
         },
      });
   }

   /** available_commands_update (из session/update) → slash-команды в браузер */
   private handleAvailableCommandsUpdateFromSession(update: AcpAvailableCommandsUpdate): void {
      const commands = update.availableCommands;
      if (!commands?.length) return;
      this.emitSlashCommands(commands);
   }

   /** available_commands_update (как отдельное уведомление) → slash-команды в браузер */
   private handleAvailableCommandsUpdate(params: Record<string, unknown>): void {
      const commands = (params.availableCommands ?? params.commands) as Array<{ name: string; description?: string; aliases?: string[] }> | undefined;
      if (!commands?.length) return;
      this.emitSlashCommands(commands);
   }

   /** Общий хелпер для отправки slash-команд в браузер */
   private emitSlashCommands(commands: Array<{ name: string; description?: string; aliases?: string[] }>): void {
      const slashCommands = commands.map((c) => {
         const aliases = c.aliases?.length ? ` (${c.aliases.join(', ')})` : '';
         return `${c.name}${aliases}`;
      });
      this.emit({
         type: 'session_update',
         session: { slash_commands: slashCommands },
      });
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
         case 'available_commands_update':
            this.handleAvailableCommandsUpdateFromSession(update as AcpAvailableCommandsUpdate);
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
      this.streamingThinkingText += update.content.text;
      this.emit({
         type: 'stream_event',
         event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: update.content.text },
         },
         parent_tool_use_id: null,
      });
   }

   /**
    * Сбросить накопленный стриминг-текст как финальное assistant-сообщение.
    * Вызывается перед tool_call, чтобы thinking/text не потерялись.
    */
   private flushStreamingText(): void {
      const hasText = this.streamingText.trim().length > 0;
      const hasThinking = this.streamingThinkingText.trim().length > 0;
      if (!hasText && !hasThinking) return;

      const contentBlocks: ContentBlock[] = [];
      if (hasThinking) {
         contentBlocks.push({ type: 'thinking' as const, thinking: this.streamingThinkingText });
      }
      if (hasText) {
         contentBlocks.push({ type: 'text' as const, text: this.streamingText });
      }

      this.emit({
         type: 'assistant',
         message: {
            id: `msg_${this.streamingMessageId}`,
            type: 'message',
            role: 'assistant',
            model: this.options.model || '',
            content: contentBlocks,
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
         },
         parent_tool_use_id: null,
      });

      // Сбрасываем и генерируем новый ID для следующего блока
      this.streamingText = '';
      this.streamingThinkingText = '';
      this.streamingMessageId = randomUUID();
   }

   /** tool_call → progress summary (не assistant message, чтобы не создавать пустые боксы) */
   private handleToolCall(update: AcpToolCall): void {
      // Сбрасываем накопленный текст/мысли перед tool_call
      this.flushStreamingText();

      // Отображаем tool_call как прогресс-индикатор, а не как message bubble
      const title = update.title && update.title !== '{}' ? update.title : update.kind || 'tool';
      this.emit({
         type: 'tool_use_summary',
         summary: title,
         tool_use_ids: [update.toolCallId],
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
            content: [{ type: 'text', text: `Plan:\n${planText}` }],
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
      const options = params.options as Array<{ optionId: string; name?: string; kind?: string }> | undefined;

      // Сохраняем маппинг наш requestId → { jsonRpcId, options } для корректного ответа
      this.pendingPermissions.set(requestId, { jsonRpcId, options: options ?? [] });

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
         await this.transport.respond(id, { error: `Failed to read file: ${err}` });
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
         await this.transport.respond(id, { error: `Failed to write file: ${err}` });
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
         case 'set_model':
            this.handleOutgoingSetModel(msg);
            return true;
         default:
            return false;
      }
   }

   /** user_message → session/prompt */
   private async handleOutgoingUserMessage(msg: { type: 'user_message'; content: string; images?: { media_type: string; data: string }[] }): Promise<void> {
      if (!this.acpSessionId) {
         this.emit({ type: 'error', message: 'ACP session not initialized' });
         return;
      }

      // Сбрасываем стриминг перед новым промптом
      this.streamingText = '';
      this.streamingThinkingText = '';
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

         // Сбрасываем накопленный стриминг как финальное сообщение
         this.flushStreamingText();

         // Отправляем result с реальными данными usage
         const resultMsg: CLIResultMessage = {
            type: 'result',
            subtype: result.stopReason === 'cancelled' ? 'error_during_execution' : 'success',
            is_error: result.stopReason === 'cancelled',
            duration_ms: 0,
            duration_api_ms: 0,
            num_turns: this.numTurns,
            total_cost_usd: 0,
            stop_reason: result.stopReason || 'end_turn',
            usage: {
               input_tokens: this.totalInputTokens,
               output_tokens: this.totalOutputTokens,
               cache_creation_input_tokens: 0,
               cache_read_input_tokens: 0,
            },
            uuid: randomUUID(),
            session_id: this.sessionId,
         };

         this.emit({ type: 'result', data: resultMsg });

         // Сбрасываем стриминг
         this.streamingText = '';
      } catch (err) {
         this.emit({ type: 'error', message: `session/prompt error: ${err}` });
      } finally {
         // Статус "idle"
         this.emit({ type: 'status_change', status: 'idle' });
      }
   }

   /** permission_response → ответ на pending permission request с реальными optionId от агента */
   private handleOutgoingPermissionResponse(msg: { type: 'permission_response'; request_id: string; behavior: 'allow' | 'deny' }): void {
      const pending = this.pendingPermissions.get(msg.request_id);
      if (!pending) {
         console.warn(`[acp-adapter] Unknown permission request_id: ${msg.request_id}`);
         return;
      }

      this.pendingPermissions.delete(msg.request_id);

      // Ищем подходящий optionId из options, присланных агентом
      // Gemini: proceed_once/cancel, Qwen: allow_once/reject_once, и т.д.
      let optionId: string;
      if (msg.behavior === 'allow') {
         const match = pending.options.find((o) => o.kind === 'allow_once');
         optionId = match?.optionId ?? 'proceed_once';
      } else {
         const match = pending.options.find((o) => o.kind === 'reject_once');
         optionId = match?.optionId ?? 'cancel';
      }

      this.transport.respond(pending.jsonRpcId, {
         outcome: { outcome: 'selected', optionId },
      });
   }

   /** interrupt → session/cancel уведомление */
   private handleOutgoingInterrupt(): void {
      if (!this.acpSessionId) return;
      this.transport.notify('session/cancel', { sessionId: this.acpSessionId });
   }

   /** set_model → session/setModel RPC */
   private async handleOutgoingSetModel(msg: { type: 'set_model'; model: string }): Promise<void> {
      if (!this.acpSessionId) return;

      try {
         await this.transport.call(
            'session/setModel',
            { sessionId: this.acpSessionId, modelId: msg.model },
            DEFAULT_RPC_TIMEOUT_MS,
         );
         this.currentModel = msg.model;
         // Уведомляем браузер об изменении модели
         this.emit({
            type: 'session_update',
            session: { model: msg.model },
         });
      } catch (err) {
         console.error(`[acp-adapter] Ошибка session/setModel: ${err}`);
         this.emit({ type: 'error', message: `Failed to switch model: ${err}` });
      }
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

   /** Отправить краткое статусное сообщение в чат */
   private emitProgress(text: string): void {
      this.emit({ type: 'tool_use_summary', summary: text, tool_use_ids: [] });
   }
}
