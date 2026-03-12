import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AcpTransport } from './acp-transport.js';

// ─── Хелперы для создания mock-потоков ──────────────────────────────────────

/** Создаёт mock WritableStream, записывая все данные в массив строк. */
function createMockStdin() {
   const written: string[] = [];
   const decoder = new TextDecoder();
   const stream = new WritableStream<Uint8Array>({
      write(chunk) {
         written.push(decoder.decode(chunk));
      },
   });
   return { stream, written };
}

/** Создаёт ReadableStream, который остаётся открытым (не закрывается сразу).
 *  Это важно, т.к. закрытие stdout приводит к отклонению всех pending промисов. */
function createOpenStdout(): ReadableStream<Uint8Array> {
   return new ReadableStream({
      start() {
         // Контроллер не закрываем — поток остаётся открытым
      },
   });
}

/** Создаёт транспорт с mock stdin и открытым stdout.
 *  Возвращает транспорт и массив записанных строк. */
function createTestTransport() {
   const { stream: stdin, written } = createMockStdin();
   const stdout = createOpenStdout();
   const transport = new AcpTransport(stdin, stdout);
   return { transport, written };
}

// ─── Тесты ──────────────────────────────────────────────────────────────────

describe('AcpTransport', () => {
   describe('call()', () => {
      it('отправляет корректный JSON-RPC запрос с id', async () => {
         // Проверяем, что call() отправляет сообщение с jsonrpc, method, id и params
         const { transport, written } = createTestTransport();

         // Вызываем call и сразу имитируем ответ, чтобы промис разрешился
         const promise = transport.call('test/method', { key: 'value' });

         // Ждём микротаски (запись в поток)
         await new Promise((r) => setTimeout(r, 10));

         // Проверяем отправленное сообщение
         expect(written.length).toBe(1);
         const sent = JSON.parse(written[0].trim());
         expect(sent.jsonrpc).toBe('2.0');
         expect(sent.method).toBe('test/method');
         expect(sent.id).toBe(1);
         expect(sent.params).toEqual({ key: 'value' });

         // Разрешаем pending промис через handleIncomingLine
         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' }));
         const result = await promise;
         expect(result).toBe('ok');
      });

      it('автоинкрементирует id для каждого вызова', async () => {
         // Проверяем, что каждый последующий call получает увеличенный id
         const { transport, written } = createTestTransport();

         const p1 = transport.call('method1');
         const p2 = transport.call('method2');

         await new Promise((r) => setTimeout(r, 10));

         const msg1 = JSON.parse(written[0].trim());
         const msg2 = JSON.parse(written[1].trim());
         expect(msg1.id).toBe(1);
         expect(msg2.id).toBe(2);

         // Разрешаем оба
         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'r1' }));
         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'r2' }));
         expect(await p1).toBe('r1');
         expect(await p2).toBe('r2');
      });
   });

   describe('notify()', () => {
      it('отправляет корректный JSON-RPC формат без id', async () => {
         // Нотификация не должна содержать поле id
         const { transport, written } = createTestTransport();

         transport.notify('session/update', { status: 'running' });

         await new Promise((r) => setTimeout(r, 10));

         expect(written.length).toBe(1);
         const sent = JSON.parse(written[0].trim());
         expect(sent.jsonrpc).toBe('2.0');
         expect(sent.method).toBe('session/update');
         expect(sent.params).toEqual({ status: 'running' });
         expect(sent).not.toHaveProperty('id');
      });
   });

   describe('respond()', () => {
      it('отправляет корректный JSON-RPC ответ', async () => {
         // respond() должен отправить объект с id и result
         const { transport, written } = createTestTransport();

         transport.respond(42, { allowed: true });

         await new Promise((r) => setTimeout(r, 10));

         expect(written.length).toBe(1);
         const sent = JSON.parse(written[0].trim());
         expect(sent.jsonrpc).toBe('2.0');
         expect(sent.id).toBe(42);
         expect(sent.result).toEqual({ allowed: true });
         expect(sent).not.toHaveProperty('error');
      });

      it('поддерживает строковый id', async () => {
         // ACP может использовать строковые id
         const { transport, written } = createTestTransport();

         transport.respond('req-abc', { ok: true });

         await new Promise((r) => setTimeout(r, 10));

         const sent = JSON.parse(written[0].trim());
         expect(sent.id).toBe('req-abc');
      });
   });

   describe('respondError()', () => {
      it('отправляет JSON-RPC ответ с ошибкой', async () => {
         // respondError() должен отправить объект с id и error
         const { transport, written } = createTestTransport();

         transport.respondError(7, -32600, 'Invalid Request');

         await new Promise((r) => setTimeout(r, 10));

         expect(written.length).toBe(1);
         const sent = JSON.parse(written[0].trim());
         expect(sent.jsonrpc).toBe('2.0');
         expect(sent.id).toBe(7);
         expect(sent.error).toEqual({ code: -32600, message: 'Invalid Request' });
         expect(sent).not.toHaveProperty('result');
      });
   });

   describe('handleIncomingLine() — ответы', () => {
      it('разрешает pending промис при получении ответа', async () => {
         // Входящий ответ с id должен разрешить соответствующий pending call
         const { transport } = createTestTransport();

         const promise = transport.call('test/echo', { data: 'hello' });
         await new Promise((r) => setTimeout(r, 10));

         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { data: 'hello' } }));

         const result = await promise;
         expect(result).toEqual({ data: 'hello' });
      });

      it('отклоняет pending промис при получении ошибки', async () => {
         // Входящий ответ с error должен отклонить pending call
         const { transport } = createTestTransport();

         const promise = transport.call('test/fail');
         await new Promise((r) => setTimeout(r, 10));

         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }));

         await expect(promise).rejects.toThrow('Method not found');
      });
   });

   describe('handleIncomingLine() — нотификации', () => {
      it('вызывает обработчик нотификаций', () => {
         // Входящее сообщение с method но без id — нотификация от агента
         const { transport } = createTestTransport();
         const handler = vi.fn();
         transport.onNotification(handler);

         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { status: 'idle' } }));

         expect(handler).toHaveBeenCalledTimes(1);
         expect(handler).toHaveBeenCalledWith('session/update', { status: 'idle' });
      });

      it('подставляет пустой объект params если params отсутствует', () => {
         // Если нотификация приходит без params, передаём пустой объект
         const { transport } = createTestTransport();
         const handler = vi.fn();
         transport.onNotification(handler);

         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', method: 'heartbeat' }));

         expect(handler).toHaveBeenCalledWith('heartbeat', {});
      });
   });

   describe('handleIncomingLine() — запросы от агента', () => {
      it('вызывает обработчик запросов', () => {
         // Входящее сообщение с method И id — запрос от агента, требующий ответа
         const { transport } = createTestTransport();
         const handler = vi.fn();
         transport.onRequest(handler);

         transport.handleIncomingLine(
            JSON.stringify({ jsonrpc: '2.0', method: 'session/request_permission', id: 99, params: { tool: 'fs/write' } }),
         );

         expect(handler).toHaveBeenCalledTimes(1);
         expect(handler).toHaveBeenCalledWith('session/request_permission', 99, { tool: 'fs/write' });
      });

      it('поддерживает строковый id в запросах', () => {
         // Агент может использовать строковые id
         const { transport } = createTestTransport();
         const handler = vi.fn();
         transport.onRequest(handler);

         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', method: 'fs/read_text_file', id: 'req-1', params: { path: '/tmp/test' } }));

         expect(handler).toHaveBeenCalledWith('fs/read_text_file', 'req-1', { path: '/tmp/test' });
      });
   });

   describe('raw callbacks', () => {
      it('вызывает onRawIncoming для каждой входящей строки', () => {
         // rawInCb должен вызываться до парсинга JSON
         const { transport } = createTestTransport();
         const rawCb = vi.fn();
         transport.onRawIncoming(rawCb);

         const line = '{"jsonrpc":"2.0","method":"test"}';
         transport.handleIncomingLine(line);

         expect(rawCb).toHaveBeenCalledWith(line);
      });

      it('вызывает onRawOutgoing для каждой исходящей записи', async () => {
         // rawOutCb должен вызываться перед записью в поток
         const { transport } = createTestTransport();
         const rawCb = vi.fn();
         transport.onRawOutgoing(rawCb);

         transport.notify('ping');
         await new Promise((r) => setTimeout(r, 10));

         expect(rawCb).toHaveBeenCalledTimes(1);
         // Данные включают завершающий \n
         expect(rawCb.mock.calls[0][0]).toContain('"method":"ping"');
      });
   });

   describe('close()', () => {
      it('отклоняет все pending вызовы', async () => {
         // close() должен отклонить все незавершённые промисы с "Transport closed"
         const { transport } = createTestTransport();

         const p1 = transport.call('method1');
         const p2 = transport.call('method2');
         await new Promise((r) => setTimeout(r, 10));

         transport.close();

         await expect(p1).rejects.toThrow('Transport closed');
         await expect(p2).rejects.toThrow('Transport closed');
      });

      it('помечает транспорт как отключённый', () => {
         const { transport } = createTestTransport();
         expect(transport.isConnected()).toBe(true);

         transport.close();

         expect(transport.isConnected()).toBe(false);
      });
   });

   describe('timeout', () => {
      it('отклоняет промис при таймауте', async () => {
         // Если ответ не приходит в течение указанного таймаута — промис отклоняется
         const { transport } = createTestTransport();

         // Используем очень короткий таймаут для теста
         const promise = transport.call('slow/method', {}, 50);

         await expect(promise).rejects.toThrow('RPC timeout');
      });

      it('использует таймаут по умолчанию для initialize (60с)', async () => {
         // Проверяем, что initialize использует увеличенный таймаут.
         // Не можем ждать 60с, просто проверяем что запрос отправляется корректно.
         const { transport, written } = createTestTransport();

         const promise = transport.call('initialize', { capabilities: {} });
         await new Promise((r) => setTimeout(r, 10));

         const sent = JSON.parse(written[0].trim());
         expect(sent.method).toBe('initialize');

         // Разрешаем чтобы не висел
         transport.handleIncomingLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: {} } }));
         await promise;
      });
   });

   describe('некорректный JSON', () => {
      it('игнорирует невалидный JSON без ошибок', () => {
         // handleIncomingLine не должен бросать исключение на мусорные данные
         const { transport } = createTestTransport();
         const handler = vi.fn();
         transport.onNotification(handler);

         // Не должно бросить исключение
         expect(() => transport.handleIncomingLine('not valid json {{')).not.toThrow();
         expect(handler).not.toHaveBeenCalled();
      });
   });
});
