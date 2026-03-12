// Транспорт ACP JSON-RPC 2.0 через stdio (NDJSON)
// Обеспечивает отправку/приём JSON-RPC сообщений через stdin/stdout дочернего процесса.

// ─── Таймауты по умолчанию ──────────────────────────────────────────────────

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

/** Специальные таймауты для конкретных методов */
const RPC_METHOD_TIMEOUTS: Record<string, number> = {
   initialize: 60_000,
};

// ─── JSON-RPC типы ──────────────────────────────────────────────────────────

interface JsonRpcRequest {
   jsonrpc: '2.0';
   method: string;
   id: number | string;
   params?: Record<string, unknown>;
}

interface JsonRpcNotification {
   jsonrpc: '2.0';
   method: string;
   params?: Record<string, unknown>;
}

interface JsonRpcResponse {
   jsonrpc: '2.0';
   id: number | string;
   result?: unknown;
   error?: { code: number; message: string; data?: unknown };
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ─── Интерфейс транспорта ───────────────────────────────────────────────────

export interface IAcpTransport {
   call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
   notify(method: string, params?: Record<string, unknown>): void;
   respond(id: number | string, result: unknown): void;
   respondError(id: number | string, code: number, message: string): void;
   onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
   onRequest(handler: (method: string, id: number | string, params: Record<string, unknown>) => void): void;
   onRawIncoming(cb: (line: string) => void): void;
   onRawOutgoing(cb: (data: string) => void): void;
   isConnected(): boolean;
   close(): void;
}

// ─── Реализация транспорта ──────────────────────────────────────────────────

export class AcpTransport implements IAcpTransport {
   private nextId = 1;
   private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
   private pendingTimers = new Map<number, ReturnType<typeof setTimeout>>();
   private notificationHandler: ((method: string, params: Record<string, unknown>) => void) | null = null;
   private requestHandler: ((method: string, id: number | string, params: Record<string, unknown>) => void) | null = null;
   private rawInCb: ((line: string) => void) | null = null;
   private rawOutCb: ((data: string) => void) | null = null;
   private writer: WritableStreamDefaultWriter<Uint8Array>;
   private connected = true;
   private buffer = '';

   constructor(
      stdin: WritableStream<Uint8Array> | { write(data: Uint8Array): number },
      stdout: ReadableStream<Uint8Array>,
   ) {
      // Поддержка обоих типов stdin (WritableStream и Bun subprocess stdin)
      let writable: WritableStream<Uint8Array>;
      if ('write' in stdin && typeof stdin.write === 'function' && !('getWriter' in stdin)) {
         writable = new WritableStream({
            write(chunk) {
               (stdin as { write(data: Uint8Array): number }).write(chunk);
            },
         });
      } else {
         writable = stdin as WritableStream<Uint8Array>;
      }
      // Захватываем writer один раз — избегаем гонки "WritableStream is locked"
      this.writer = writable.getWriter();

      this.readStdout(stdout);
   }

   // ─── Чтение stdout ────────────────────────────────────────────────────────

   private async readStdout(stdout: ReadableStream<Uint8Array>): Promise<void> {
      const reader = stdout.getReader();
      const decoder = new TextDecoder();
      try {
         while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this.buffer += decoder.decode(value, { stream: true });
            this.processBuffer();
         }
      } catch (err) {
         console.error('[acp-transport] Ошибка чтения stdout:', err);
      } finally {
         this.connected = false;
         // Очищаем таймеры и отклоняем pending промисы
         for (const [, timer] of this.pendingTimers) {
            clearTimeout(timer);
         }
         this.pendingTimers.clear();
         for (const [, { reject }] of this.pending) {
            reject(new Error('Transport closed'));
         }
         this.pending.clear();
      }
   }

   private processBuffer(): void {
      const lines = this.buffer.split('\n');
      // Неполная строка остаётся в буфере
      this.buffer = lines.pop() || '';

      for (const line of lines) {
         const trimmed = line.trim();
         if (!trimmed) continue;
         this.handleIncomingLine(trimmed);
      }
   }

   // ─── Обработка входящих сообщений ─────────────────────────────────────────

   /** Парсит входящую NDJSON-строку и диспетчеризует сообщение.
    *  Публичный метод — удобен для тестирования без реальных потоков. */
   handleIncomingLine(line: string): void {
      // Колбэк для записи сырых входящих данных
      this.rawInCb?.(line);

      let msg: JsonRpcMessage;
      try {
         msg = JSON.parse(line);
      } catch {
         console.warn('[acp-transport] Не удалось распарсить JSON-RPC:', line.substring(0, 200));
         return;
      }

      this.dispatch(msg);
   }

   private dispatch(msg: JsonRpcMessage): void {
      if ('id' in msg && msg.id !== undefined && msg.id !== null) {
         if ('method' in msg && msg.method) {
            // Запрос ОТ агента (например, session/request_permission, fs/read_text_file)
            this.requestHandler?.(msg.method, msg.id as number | string, (msg as JsonRpcRequest).params || {});
         } else {
            // Ответ на наш запрос
            const msgId = msg.id as number;
            const pending = this.pending.get(msgId);
            if (!pending) return;

            this.pending.delete(msgId);
            const timer = this.pendingTimers.get(msgId);
            if (timer) {
               clearTimeout(timer);
               this.pendingTimers.delete(msgId);
            }

            const resp = msg as JsonRpcResponse;
            if (resp.error) {
               pending.reject(new Error(resp.error.message));
            } else {
               pending.resolve(resp.result);
            }
         }
      } else if ('method' in msg) {
         // Нотификация (без id) — например session/update
         this.notificationHandler?.(msg.method, (msg as JsonRpcNotification).params || {});
      }
   }

   // ─── Отправка сообщений ───────────────────────────────────────────────────

   /** Отправляет JSON-RPC запрос и ожидает ответ.
    *  Отклоняется по таймауту если ответ не приходит вовремя. */
   async call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<unknown> {
      const id = this.nextId++;
      const effectiveTimeout = timeoutMs ?? RPC_METHOD_TIMEOUTS[method] ?? DEFAULT_RPC_TIMEOUT_MS;
      return new Promise<unknown>(async (resolve, reject) => {
         const timer = setTimeout(() => {
            this.pending.delete(id);
            this.pendingTimers.delete(id);
            reject(new Error(`RPC timeout: ${method} не ответил в течение ${effectiveTimeout}ms`));
         }, effectiveTimeout);
         this.pendingTimers.set(id, timer);
         this.pending.set(id, { resolve, reject });
         const request = JSON.stringify({ jsonrpc: '2.0', method, id, params });
         try {
            await this.writeRaw(request + '\n');
         } catch (err) {
            clearTimeout(timer);
            this.pendingTimers.delete(id);
            this.pending.delete(id);
            reject(err instanceof Error ? err : new Error(String(err)));
         }
      });
   }

   /** Отправляет нотификацию (ответ не ожидается). */
   notify(method: string, params: Record<string, unknown> = {}): void {
      const notification = JSON.stringify({ jsonrpc: '2.0', method, params });
      this.writeRaw(notification + '\n').catch((err) => {
         console.error('[acp-transport] Ошибка отправки нотификации:', err);
      });
   }

   /** Отправляет успешный ответ на запрос от агента. */
   respond(id: number | string, result: unknown): void {
      const response = JSON.stringify({ jsonrpc: '2.0', id, result });
      this.writeRaw(response + '\n').catch((err) => {
         console.error('[acp-transport] Ошибка отправки ответа:', err);
      });
   }

   /** Отправляет ответ с ошибкой на запрос от агента. */
   respondError(id: number | string, code: number, message: string): void {
      const response = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
      this.writeRaw(response + '\n').catch((err) => {
         console.error('[acp-transport] Ошибка отправки ответа с ошибкой:', err);
      });
   }

   // ─── Регистрация обработчиков ─────────────────────────────────────────────

   /** Регистрирует обработчик нотификаций от агента. */
   onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
      this.notificationHandler = handler;
   }

   /** Регистрирует обработчик запросов от агента (требующих ответа). */
   onRequest(handler: (method: string, id: number | string, params: Record<string, unknown>) => void): void {
      this.requestHandler = handler;
   }

   /** Регистрирует колбэк для сырых входящих строк (до парсинга). */
   onRawIncoming(cb: (line: string) => void): void {
      this.rawInCb = cb;
   }

   /** Регистрирует колбэк для сырых исходящих данных (до записи). */
   onRawOutgoing(cb: (data: string) => void): void {
      this.rawOutCb = cb;
   }

   // ─── Состояние и завершение ───────────────────────────────────────────────

   isConnected(): boolean {
      return this.connected;
   }

   /** Закрывает транспорт, отклоняет все ожидающие вызовы. */
   close(): void {
      this.connected = false;
      // Очищаем таймеры
      for (const [, timer] of this.pendingTimers) {
         clearTimeout(timer);
      }
      this.pendingTimers.clear();
      // Отклоняем все pending промисы
      for (const [, { reject }] of this.pending) {
         reject(new Error('Transport closed'));
      }
      this.pending.clear();
   }

   // ─── Внутренние методы ────────────────────────────────────────────────────

   private async writeRaw(data: string): Promise<void> {
      if (!this.connected) {
         throw new Error('Transport closed');
      }
      // Колбэк для записи сырых исходящих данных
      this.rawOutCb?.(data);
      await this.writer.write(new TextEncoder().encode(data));
   }
}
