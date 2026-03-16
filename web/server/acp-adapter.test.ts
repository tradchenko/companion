/**
 * Тесты для AcpAdapter.
 *
 * Используем мок-транспорт чтобы проверить трансляцию
 * ACP JSON-RPC протокола ↔ BrowserIncomingMessage/BrowserOutgoingMessage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем чтение MCP конфигов чтобы тесты не зависели от ~/.claude/settings.json
vi.mock('./mcp-config-reader.js', () => ({
   readMcpServersForAcp: vi.fn(() => []),
}));

import type { IAcpTransport, AcpAdapterOptions } from './acp-adapter.js';
import { AcpAdapter } from './acp-adapter.js';
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from './session-types.js';

// ─── Мок-транспорт ───────────────────────────────────────────────────────────

/**
 * Создаёт мок-транспорт IAcpTransport.
 * Позволяет эмулировать ответы на call(), вручную вызывать
 * обработчики уведомлений и запросов от агента.
 */
function createMockTransport() {
   let notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
   let requestHandler: ((method: string, id: number, params: Record<string, unknown>) => void) | null = null;

   // Маппинг method → результат для call()
   const callResults = new Map<string, unknown>();

   const transport: IAcpTransport = {
      call: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
         const result = callResults.get(method);
         if (result instanceof Error) throw result;
         return result ?? {};
      }),
      notify: vi.fn(async () => {}),
      respond: vi.fn(async () => {}),
      onNotification: vi.fn((handler) => {
         notificationHandler = handler;
      }),
      onRequest: vi.fn((handler) => {
         requestHandler = handler;
      }),
      onRawIncoming: vi.fn(),
      onRawOutgoing: vi.fn(),
      isConnected: vi.fn(() => true),
   };

   return {
      transport,
      /** Задать результат для call(method) */
      setCallResult(method: string, result: unknown) {
         callResults.set(method, result);
      },
      /** Эмулировать входящее уведомление от агента */
      fireNotification(method: string, params: Record<string, unknown>) {
         notificationHandler?.(method, params);
      },
      /** Эмулировать входящий запрос от агента */
      fireRequest(method: string, id: number, params: Record<string, unknown>) {
         requestHandler?.(method, id, params);
      },
   };
}

// ─── Вспомогательные функции ─────────────────────────────────────────────────

const DEFAULT_OPTIONS: AcpAdapterOptions = {
   agentId: 'test-agent',
   cwd: '/tmp/test',
   model: 'test-model',
};

/**
 * Создаёт адаптер и ждёт завершения инициализации.
 * Возвращает адаптер, мок-транспорт и собранные сообщения.
 */
async function createInitializedAdapter(optionsOverride?: Partial<AcpAdapterOptions>) {
   const mock = createMockTransport();
   const messages: BrowserIncomingMessage[] = [];

   // Настраиваем ответы для инициализации
   mock.setCallResult('initialize', { protocolVersion: 1 });
   mock.setCallResult('session/new', { sessionId: 'acp-session-123' });
   mock.setCallResult('session/load', { sessionId: 'acp-session-resumed' });

   const options = { ...DEFAULT_OPTIONS, ...optionsOverride };
   const adapter = new AcpAdapter(mock.transport, 'test-session-id', options);

   adapter.onBrowserMessage((msg) => messages.push(msg));

   // Даём инициализации завершиться (она асинхронная в конструкторе)
   await vi.waitFor(() => {
      expect(messages.some((m) => m.type === 'session_init')).toBe(true);
   });

   return { adapter, mock, messages };
}

// ─── Тесты ───────────────────────────────────────────────────────────────────

describe('AcpAdapter', () => {
   // ── Инициализация ──────────────────────────────────────────────────────

   describe('initialize()', () => {
      it('вызывает ACP initialize + session/new при создании', async () => {
         /**
          * Проверяем что при создании адаптера происходит:
          * 1. Вызов initialize с правильными параметрами
          * 2. Вызов session/new с cwd и mcpServers
          * 3. Отправка session_init в браузер
          */
         const { mock, messages } = await createInitializedAdapter();

         // Проверяем вызов initialize
         expect(mock.transport.call).toHaveBeenCalledWith(
            'initialize',
            expect.objectContaining({
               protocolVersion: 1,
               clientCapabilities: expect.objectContaining({
                  fs: { readTextFile: true, writeTextFile: true },
                  terminal: true,
               }),
               clientInfo: expect.objectContaining({
                  name: 'the-companion',
               }),
            }),
            expect.any(Number),
         );

         // Проверяем вызов session/new
         expect(mock.transport.call).toHaveBeenCalledWith(
            'session/new',
            expect.objectContaining({
               cwd: '/tmp/test',
               mcpServers: [],
            }),
            expect.any(Number),
         );

         // Проверяем session_init
         const initMsg = messages.find((m) => m.type === 'session_init');
         expect(initMsg).toBeDefined();
         if (initMsg && initMsg.type === 'session_init') {
            expect(initMsg.session.backend_type).toBe('acp');
            expect(initMsg.session.cwd).toBe('/tmp/test');
            expect(initMsg.session.agents).toEqual(['test-agent']);
            // agentId НЕ должен быть установлен — иначе сессия попадёт в "Agent Runs"
            expect(initMsg.session.agentId).toBeUndefined();
         }
      });

      it('вызывает session/load при наличии threadId', async () => {
         /**
          * Проверяем что при передаче threadId используется session/load
          * вместо session/new для возобновления сессии.
          */
         const { mock } = await createInitializedAdapter({ threadId: 'existing-session' });

         expect(mock.transport.call).toHaveBeenCalledWith(
            'session/load',
            expect.objectContaining({
               sessionId: 'existing-session',
            }),
            expect.any(Number),
         );

         // session/new НЕ должен вызываться
         const calls = (mock.transport.call as ReturnType<typeof vi.fn>).mock.calls;
         const newCalls = calls.filter((c: unknown[]) => c[0] === 'session/new');
         expect(newCalls).toHaveLength(0);
      });

      it('отправляет ошибку при провале инициализации', async () => {
         /**
          * Проверяем что при ошибке initialize() адаптер:
          * 1. Отправляет error-сообщение в браузер
          * 2. Вызывает initErrorCb
          * 3. Отклоняет последующие сообщения
          */
         const mock = createMockTransport();
         const messages: BrowserIncomingMessage[] = [];
         const initErrors: string[] = [];

         mock.setCallResult('initialize', new Error('Connection refused'));

         const adapter = new AcpAdapter(mock.transport, 'test-session', DEFAULT_OPTIONS);
         adapter.onBrowserMessage((msg) => messages.push(msg));
         adapter.onInitError((err) => initErrors.push(err));

         await vi.waitFor(() => {
            expect(messages.some((m) => m.type === 'error')).toBe(true);
         });

         expect(initErrors.length).toBeGreaterThan(0);
         expect(adapter.sendBrowserMessage({ type: 'user_message', content: 'hello' })).toBe(false);
      });
   });

   // ── Трансляция session/update → BrowserIncomingMessage ─────────────────

   describe('session/update трансляция', () => {
      it('agent_message_chunk → stream_event', async () => {
         /**
          * Проверяем что agent_message_chunk от агента транслируется
          * в stream_event с content_block_delta для браузера.
          */
         const { mock, messages } = await createInitializedAdapter();
         const beforeCount = messages.length;

         mock.fireNotification('session/update', {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Привет!' },
         });

         const streamEvents = messages.slice(beforeCount).filter((m) => m.type === 'stream_event');
         expect(streamEvents).toHaveLength(1);

         const evt = streamEvents[0];
         if (evt.type === 'stream_event') {
            const event = evt.event as { type: string; delta: { type: string; text: string } };
            expect(event.type).toBe('content_block_delta');
            expect(event.delta.text).toBe('Привет!');
         }
      });

      it('agent_thought_chunk → stream_event с thinking_delta', async () => {
         /**
          * Проверяем что agent_thought_chunk транслируется в thinking_delta.
          */
         const { mock, messages } = await createInitializedAdapter();
         const beforeCount = messages.length;

         mock.fireNotification('session/update', {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'Размышляю...' },
         });

         const streamEvents = messages.slice(beforeCount).filter((m) => m.type === 'stream_event');
         expect(streamEvents).toHaveLength(1);

         const evt = streamEvents[0];
         if (evt.type === 'stream_event') {
            const event = evt.event as { type: string; delta: { type: string; thinking: string } };
            expect(event.delta.type).toBe('thinking_delta');
            expect(event.delta.thinking).toBe('Размышляю...');
         }
      });

      it('tool_call → tool_use_summary', async () => {
         /**
          * Проверяем что tool_call транслируется в tool_use_summary
          * (прогресс-индикатор, не assistant message).
          */
         const { mock, messages } = await createInitializedAdapter();
         const beforeCount = messages.length;

         mock.fireNotification('session/update', {
            sessionUpdate: 'tool_call',
            toolCallId: 'tc-001',
            title: 'read_file',
            kind: 'fs',
            status: 'in_progress',
         });

         const summaryMsgs = messages.slice(beforeCount).filter((m) => m.type === 'tool_use_summary');
         expect(summaryMsgs).toHaveLength(1);

         const msg = summaryMsgs[0];
         if (msg.type === 'tool_use_summary') {
            expect(msg.summary).toBe('read_file');
            expect(msg.tool_use_ids).toContain('tc-001');
         }
      });

      it('tool_call_update completed → assistant с tool_result', async () => {
         /**
          * Проверяем что tool_call_update со статусом completed
          * транслируется в assistant-сообщение с tool_result.
          */
         const { mock, messages } = await createInitializedAdapter();
         const beforeCount = messages.length;

         mock.fireNotification('session/update', {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'tc-001',
            status: 'completed',
            content: [{ type: 'text', text: 'Файл прочитан успешно' }],
         });

         const assistantMsgs = messages.slice(beforeCount).filter((m) => m.type === 'assistant');
         expect(assistantMsgs).toHaveLength(1);

         const msg = assistantMsgs[0];
         if (msg.type === 'assistant') {
            const block = msg.message.content[0];
            expect(block.type).toBe('tool_result');
            if (block.type === 'tool_result') {
               expect(block.tool_use_id).toBe('tc-001');
               expect(block.content).toBe('Файл прочитан успешно');
               expect(block.is_error).toBe(false);
            }
         }
      });

      it('agent_message_chunk во вложенном формате params.update (реальный протокол)', async () => {
         /**
          * Реальный ACP-протокол (Gemini CLI и др.) присылает session/update
          * в формате {sessionId: "...", update: {sessionUpdate: "...", ...}},
          * а не плоским {sessionUpdate: "...", ...}.
          * Проверяем что вложенный формат корректно обрабатывается.
          */
         const { mock, messages } = await createInitializedAdapter();
         const beforeCount = messages.length;

         // Формат как в реальном протоколе Gemini CLI
         mock.fireNotification('session/update', {
            sessionId: 'acp-session-123',
            update: {
               sessionUpdate: 'agent_message_chunk',
               content: { type: 'text', text: 'Вложенный ответ' },
            },
         });

         const streamEvents = messages.slice(beforeCount).filter((m) => m.type === 'stream_event');
         expect(streamEvents).toHaveLength(1);

         const evt = streamEvents[0];
         if (evt.type === 'stream_event') {
            const event = evt.event as { type: string; delta: { type: string; text: string } };
            expect(event.type).toBe('content_block_delta');
            expect(event.delta.text).toBe('Вложенный ответ');
         }
      });

      it('session_info_update → session_name_update', async () => {
         /**
          * Проверяем что session_info_update с title транслируется
          * в session_name_update для обновления заголовка сессии.
          */
         const { mock, messages } = await createInitializedAdapter();
         const beforeCount = messages.length;

         mock.fireNotification('session/update', {
            sessionUpdate: 'session_info_update',
            title: 'Рефакторинг модуля авторизации',
         });

         const nameUpdates = messages.slice(beforeCount).filter((m) => m.type === 'session_name_update');
         expect(nameUpdates).toHaveLength(1);
         if (nameUpdates[0].type === 'session_name_update') {
            expect(nameUpdates[0].name).toBe('Рефакторинг модуля авторизации');
         }
      });
   });

   // ── session/request_permission → permission_request ────────────────────

   describe('permission flow', () => {
      it('session/request_permission → permission_request для браузера', async () => {
         /**
          * Проверяем что входящий запрос session/request_permission от агента
          * транслируется в permission_request для браузера с корректными полями.
          */
         const { mock, messages } = await createInitializedAdapter();
         const beforeCount = messages.length;

         mock.fireRequest('session/request_permission', 42, {
            toolCall: { title: 'write_file', kind: 'fs', toolCallId: 'tc-perm-001' },
            options: ['allow_once', 'allow_always', 'reject_once', 'reject_always'],
         });

         const permMsgs = messages.slice(beforeCount).filter((m) => m.type === 'permission_request');
         expect(permMsgs).toHaveLength(1);

         if (permMsgs[0].type === 'permission_request') {
            expect(permMsgs[0].request.tool_name).toBe('write_file');
            expect(permMsgs[0].request.tool_use_id).toBe('tc-perm-001');
            expect(permMsgs[0].request.request_id).toBeDefined();
         }
      });

      it('permission_response отвечает на pending permission (allow)', async () => {
         /**
          * Проверяем что permission_response от браузера корректно
          * транслируется в respond() с outcome "selected" для агента.
          */
         const { adapter, mock, messages } = await createInitializedAdapter();

         // Агент запрашивает разрешение
         mock.fireRequest('session/request_permission', 42, {
            toolCall: { title: 'write_file', kind: 'fs', toolCallId: 'tc-perm-002' },
            options: ['allow_once', 'reject_once'],
         });

         // Находим request_id из permission_request
         const permMsg = messages.find((m) => m.type === 'permission_request');
         expect(permMsg).toBeDefined();
         if (!permMsg || permMsg.type !== 'permission_request') return;

         const requestId = permMsg.request.request_id;

         // Браузер отвечает "allow"
         adapter.sendBrowserMessage({
            type: 'permission_response',
            request_id: requestId,
            behavior: 'allow',
         });

         // Проверяем что transport.respond вызван с правильными аргументами
         expect(mock.transport.respond).toHaveBeenCalledWith(42, {
            outcome: { outcome: 'selected', optionId: 'proceed_once' },
         });
      });

      it('permission_response отвечает на pending permission (deny)', async () => {
         /**
          * Проверяем что deny-ответ корректно транслируется в reject_once.
          */
         const { adapter, mock, messages } = await createInitializedAdapter();

         mock.fireRequest('session/request_permission', 99, {
            toolCall: { title: 'rm_file', kind: 'fs', toolCallId: 'tc-perm-003' },
            options: ['allow_once', 'reject_once'],
         });

         const permMsg = messages.find((m) => m.type === 'permission_request');
         if (!permMsg || permMsg.type !== 'permission_request') return;

         adapter.sendBrowserMessage({
            type: 'permission_response',
            request_id: permMsg.request.request_id,
            behavior: 'deny',
         });

         expect(mock.transport.respond).toHaveBeenCalledWith(99, {
            outcome: { outcome: 'selected', optionId: 'cancel' },
         });
      });
   });

   // ── Исходящие сообщения (браузер → агент) ─────────────────────────────

   describe('sendBrowserMessage', () => {
      it('user_message → session/prompt', async () => {
         /**
          * Проверяем что user_message от браузера транслируется
          * в вызов session/prompt с правильными параметрами.
          * После завершения prompt отправляется result.
          */
         const { adapter, mock, messages } = await createInitializedAdapter();

         // Настраиваем ответ на session/prompt
         mock.setCallResult('session/prompt', { stopReason: 'end_turn' });

         adapter.sendBrowserMessage({ type: 'user_message', content: 'Привет мир' });

         // Ждём пока session/prompt вызовется
         await vi.waitFor(() => {
            expect(mock.transport.call).toHaveBeenCalledWith(
               'session/prompt',
               expect.objectContaining({
                  sessionId: 'acp-session-123',
                  prompt: [{ type: 'text', text: 'Привет мир' }],
               }),
               expect.any(Number),
            );
         });

         // Ждём result
         await vi.waitFor(() => {
            expect(messages.some((m) => m.type === 'result')).toBe(true);
         });
      });

      it('interrupt → session/cancel notification', async () => {
         /**
          * Проверяем что interrupt от браузера транслируется
          * в session/cancel уведомление для агента.
          */
         const { adapter, mock } = await createInitializedAdapter();

         adapter.sendBrowserMessage({ type: 'interrupt' });

         expect(mock.transport.notify).toHaveBeenCalledWith('session/cancel', {
            sessionId: 'acp-session-123',
         });
      });
   });

   // ── Очередь сообщений до инициализации ────────────────────────────────

   describe('очередь до инициализации', () => {
      it('user_message ставится в очередь если адаптер ещё не инициализирован', async () => {
         /**
          * Проверяем что сообщения, отправленные до завершения инициализации,
          * ставятся в очередь и отправляются после.
          */
         const mock = createMockTransport();

         // Задержка в инициализации
         let resolveInit: (v: unknown) => void;
         const initPromise = new Promise((resolve) => {
            resolveInit = resolve;
         });
         (mock.transport.call as ReturnType<typeof vi.fn>).mockImplementation(async (method: string) => {
            if (method === 'initialize') {
               await initPromise;
               return { protocolVersion: 1 };
            }
            if (method === 'session/new') return { sessionId: 'acp-delayed' };
            if (method === 'session/prompt') return { stopReason: 'end_turn' };
            return {};
         });

         const adapter = new AcpAdapter(mock.transport, 'queued-session', DEFAULT_OPTIONS);
         const messages: BrowserIncomingMessage[] = [];
         adapter.onBrowserMessage((msg) => messages.push(msg));

         // Отправляем сообщение до завершения инициализации — должно встать в очередь
         const accepted = adapter.sendBrowserMessage({ type: 'user_message', content: 'Ранний запрос' });
         expect(accepted).toBe(true);

         // Завершаем инициализацию
         resolveInit!({});

         // Ждём что session_init и затем session/prompt вызовутся
         await vi.waitFor(() => {
            expect(messages.some((m) => m.type === 'session_init')).toBe(true);
         });

         await vi.waitFor(() => {
            const calls = (mock.transport.call as ReturnType<typeof vi.fn>).mock.calls;
            const promptCalls = calls.filter((c: unknown[]) => c[0] === 'session/prompt');
            expect(promptCalls.length).toBeGreaterThan(0);
         });
      });
   });

   // ── getThreadId / isConnected / disconnect ────────────────────────────

   describe('вспомогательные методы', () => {
      it('getThreadId возвращает acpSessionId после инициализации', async () => {
         const { adapter } = await createInitializedAdapter();
         expect(adapter.getThreadId()).toBe('acp-session-123');
      });

      it('isConnected возвращает true после инициализации', async () => {
         const { adapter } = await createInitializedAdapter();
         expect(adapter.isConnected()).toBe(true);
      });

      it('handleTransportClose сбрасывает состояние и вызывает disconnectCb', async () => {
         const { adapter } = await createInitializedAdapter();
         const disconnectCalled = vi.fn();
         adapter.onDisconnect(disconnectCalled);

         adapter.handleTransportClose();

         expect(adapter.isConnected()).toBe(false);
         expect(disconnectCalled).toHaveBeenCalledOnce();
      });
   });
});
