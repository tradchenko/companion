# ACP Multi-Agent Support — План реализации

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить поддержку ACP-совместимых агентов (Gemini CLI, Qwen Code, Goose и др.) в The Companion через универсальный ACP-адаптер с registry-паттерном и dropdown UI.

**Architecture:** Один `AcpAdapter` класс транслирует ACP JSON-RPC 2.0 (stdio) в `BrowserIncomingMessage`. Реестр агентов (`acp-agents.json`) описывает бинарники, флаги, модели. `AcpBinaryResolver` ищет агентов в PATH и типичных директориях. Frontend получает расширенный список бэкендов через `GET /api/backends` и показывает dropdown вместо кнопок.

**Tech Stack:** TypeScript, Bun, Hono, React 19, Zustand, TailwindCSS, Vitest

**Spec:** `docs/superpowers/specs/2026-03-12-acp-multi-agent-support.md`
**ACP Protocol Spec:** `/Users/tradchenko/acp-protocol-spec.json`
**ACP JSON Schema:** `/Users/tradchenko/acp-schema.json`

---

## Chunk 1: Codex Homebrew Fix + Foundation Types

### Task 1: Встроить Codex Homebrew fix в форк

Заменить логику siblingNode в cli-launcher.ts на прямой запуск бинарника. Это тот же патч, что сейчас применяется через `~/bin/apply-companion-codex-fix`.

**Files:**
- Modify: `web/server/cli-launcher.ts:745-760` (в `spawnCodexStdio`)

- [ ] **Step 1: Создать feature-ветку**

```bash
cd /Users/tradchenko/companion
git checkout -b feature/acp-multi-agent-support
```

- [ ] **Step 2: Прочитать текущий код siblingNode блока**

Открыть `web/server/cli-launcher.ts`, найти блок `if (existsSync(siblingNode))` в `spawnCodexStdio` (около строки 747).

- [ ] **Step 3: Применить фикс — убрать siblingNode логику**

Заменить блок:
```typescript
if (existsSync(siblingNode)) {
  let codexScript: string;
  try {
    codexScript = realpathSync(binary);
  } catch {
    codexScript = binary;
  }
  spawnCmd = [siblingNode, codexScript, ...args];
} else {
  const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
  spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
}
```

На:
```typescript
// Homebrew/Cask Codex — нативный бинарник, запускаем напрямую.
// Windows: .cmd/.bat нельзя запустить через Bun.spawn напрямую.
const isCmdScript = process.platform === "win32" && (binary.endsWith(".cmd") || binary.endsWith(".bat"));
spawnCmd = isCmdScript ? ["cmd.exe", "/c", binary, ...args] : [binary, ...args];
```

- [ ] **Step 4: Проверить что siblingNode переменная и existsSync импорт больше не нужны**

Убрать `const siblingNode = join(binaryDir, "node");` (строка ~746). Проверить что `existsSync` и `realpathSync` используются в других местах файла — если да, оставить импорты.

- [ ] **Step 5: Запустить тесты**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test
```

- [ ] **Step 6: Коммит**

```bash
git add web/server/cli-launcher.ts
git commit -m "fix(codex): убрать siblingNode логику — запускать Codex бинарник напрямую"
```

---

### Task 2: Расширить BackendType и добавить ACP реестр

**Files:**
- Modify: `web/server/session-types.ts:312`
- Create: `web/server/acp-agents.json`
- Create: `web/server/acp-registry.ts`
- Test: `web/server/acp-registry.test.ts`

- [ ] **Step 1: Написать тест для acp-registry**

```typescript
// web/server/acp-registry.test.ts
import { describe, it, expect } from "vitest";
import { loadAcpRegistry, getAcpAgent, getAllAcpAgents } from "./acp-registry.js";

describe("ACP Registry", () => {
   it("загружает реестр агентов", () => {
      const agents = getAllAcpAgents();
      expect(agents.length).toBeGreaterThan(0);
   });

   it("находит gemini по id", () => {
      const agent = getAcpAgent("gemini");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("gemini");
      expect(agent!.acpFlags).toContain("--experimental-acp");
   });

   it("находит qwen по id", () => {
      const agent = getAcpAgent("qwen");
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe("qwen");
      expect(agent!.acpFlags).toContain("--acp");
   });

   it("возвращает null для несуществующего агента", () => {
      expect(getAcpAgent("nonexistent")).toBeNull();
   });

   it("каждый агент имеет обязательные поля", () => {
      for (const agent of getAllAcpAgents()) {
         expect(agent.id).toBeTruthy();
         expect(agent.name).toBeTruthy();
         expect(agent.binary).toBeTruthy();
         expect(agent.acpFlags).toBeInstanceOf(Array);
         expect(agent.defaultModels.length).toBeGreaterThan(0);
      }
   });
});
```

- [ ] **Step 2: Запустить тест — убедиться что падает**

```bash
cd /Users/tradchenko/companion/web && bun run test -- acp-registry
```
Ожидаемо: FAIL — модуль не найден.

- [ ] **Step 3: Создать acp-agents.json**

```json
// web/server/acp-agents.json
[
   {
      "id": "gemini",
      "name": "Gemini CLI",
      "binary": "gemini",
      "acpFlags": ["--experimental-acp"],
      "defaultModels": [
         { "value": "gemini-2.5-pro", "label": "Gemini 2.5 Pro" },
         { "value": "gemini-2.5-flash", "label": "Gemini 2.5 Flash" },
         { "value": "gemini-2.0-flash", "label": "Gemini 2.0 Flash" }
      ],
      "defaultModes": [
         { "value": "bypassPermissions", "label": "Auto" },
         { "value": "plan", "label": "Plan" }
      ],
      "searchPaths": {
         "darwin": ["/opt/homebrew/bin", "/usr/local/bin"],
         "linux": ["/usr/bin", "/usr/local/bin", "/snap/bin"],
         "win32": []
      },
      "customModelInput": true
   },
   {
      "id": "qwen",
      "name": "Qwen Code",
      "binary": "qwen",
      "acpFlags": ["--acp"],
      "defaultModels": [
         { "value": "qwen3-coder", "label": "Qwen 3 Coder" },
         { "value": "qwen-max", "label": "Qwen Max" }
      ],
      "defaultModes": [
         { "value": "bypassPermissions", "label": "Auto" },
         { "value": "plan", "label": "Plan" }
      ],
      "searchPaths": {
         "darwin": ["/opt/homebrew/bin", "/usr/local/bin"],
         "linux": ["/usr/bin", "/usr/local/bin"],
         "win32": []
      },
      "customModelInput": true
   },
   {
      "id": "goose",
      "name": "Goose",
      "binary": "goose",
      "acpFlags": ["--acp"],
      "defaultModels": [
         { "value": "default", "label": "Default" }
      ],
      "defaultModes": [
         { "value": "bypassPermissions", "label": "Auto" }
      ],
      "searchPaths": {
         "darwin": ["~/.local/bin", "/opt/homebrew/bin"],
         "linux": ["~/.local/bin", "/usr/local/bin"],
         "win32": []
      },
      "customModelInput": true
   },
   {
      "id": "copilot",
      "name": "GitHub Copilot",
      "binary": "copilot",
      "acpFlags": [],
      "defaultModels": [
         { "value": "default", "label": "Default" }
      ],
      "defaultModes": [
         { "value": "bypassPermissions", "label": "Auto" }
      ],
      "searchPaths": {
         "darwin": ["/usr/local/bin", "/opt/homebrew/bin"],
         "linux": ["/usr/local/bin"],
         "win32": []
      },
      "customModelInput": false
   }
]
```

- [ ] **Step 4: Создать acp-registry.ts**

```typescript
// web/server/acp-registry.ts
import acpAgentsData from "./acp-agents.json";

export interface AcpAgentDefinition {
   id: string;
   name: string;
   binary: string;
   acpFlags: string[];
   defaultModels: Array<{ value: string; label: string }>;
   defaultModes: Array<{ value: string; label: string }>;
   searchPaths: Record<string, string[]>;
   customModelInput: boolean;
}

const registry: AcpAgentDefinition[] = acpAgentsData as AcpAgentDefinition[];

export function getAllAcpAgents(): AcpAgentDefinition[] {
   return registry;
}

export function getAcpAgent(id: string): AcpAgentDefinition | null {
   return registry.find((a) => a.id === id) ?? null;
}
```

- [ ] **Step 5: Расширить BackendType**

В `web/server/session-types.ts`, строка 312 изменить:
```typescript
// Было:
export type BackendType = "claude" | "codex";
// Стало:
export type BackendType = "claude" | "codex" | "acp";
```

- [ ] **Step 6: Запустить тесты**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test
```
Ожидаемо: acp-registry тесты PASS, остальные тесты тоже PASS.

- [ ] **Step 7: Коммит**

```bash
git add web/server/acp-agents.json web/server/acp-registry.ts web/server/acp-registry.test.ts web/server/session-types.ts
git commit -m "feat(acp): добавить реестр ACP-агентов и расширить BackendType"
```

---

## Chunk 2: ACP Transport и Adapter

### Task 3: ACP Stdio Transport

Реализовать транспортный слой для ACP JSON-RPC 2.0 через stdio (NDJSON).

**Files:**
- Create: `web/server/acp-transport.ts`
- Test: `web/server/acp-transport.test.ts`

- [ ] **Step 1: Написать тест для AcpTransport**

```typescript
// web/server/acp-transport.test.ts
import { describe, it, expect, vi } from "vitest";
import { AcpTransport } from "./acp-transport.js";

describe("AcpTransport", () => {
   it("отправляет JSON-RPC request и получает response", async () => {
      // Мокаем stdin/stdout через pipe
      const mockStdin = { write: vi.fn() } as any;
      const transport = new AcpTransport(mockStdin, null as any);

      // Проверяем формат отправленного сообщения
      transport.notify("session/cancel", { sessionId: "test" });
      const written = mockStdin.write.mock.calls[0][0];
      const parsed = JSON.parse(written.toString().trim());
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed.method).toBe("session/cancel");
      expect(parsed.id).toBeUndefined(); // notification — без id
   });

   it("call() добавляет id и ждёт ответ", () => {
      const mockStdin = { write: vi.fn() } as any;
      const transport = new AcpTransport(mockStdin, null as any);

      const promise = transport.call("initialize", { protocolVersion: 1 });
      const written = JSON.parse(mockStdin.write.mock.calls[0][0].toString().trim());
      expect(written.id).toBeDefined();
      expect(written.method).toBe("initialize");

      // Симулируем ответ
      transport.handleIncomingLine(JSON.stringify({
         jsonrpc: "2.0",
         id: written.id,
         result: { protocolVersion: 1, agentCapabilities: {} }
      }));

      return expect(promise).resolves.toEqual({
         protocolVersion: 1,
         agentCapabilities: {}
      });
   });

   it("диспатчит notification в обработчик", () => {
      const mockStdin = { write: vi.fn() } as any;
      const transport = new AcpTransport(mockStdin, null as any);
      const handler = vi.fn();
      transport.onNotification(handler);

      transport.handleIncomingLine(JSON.stringify({
         jsonrpc: "2.0",
         method: "session/update",
         params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } } }
      }));

      expect(handler).toHaveBeenCalledWith("session/update", expect.objectContaining({ sessionId: "s1" }));
   });

   it("диспатчит agent request (permission) в обработчик", () => {
      const mockStdin = { write: vi.fn() } as any;
      const transport = new AcpTransport(mockStdin, null as any);
      const handler = vi.fn();
      transport.onRequest(handler);

      transport.handleIncomingLine(JSON.stringify({
         jsonrpc: "2.0",
         id: 42,
         method: "session/request_permission",
         params: { sessionId: "s1", toolCall: { toolCallId: "t1" }, options: [] }
      }));

      expect(handler).toHaveBeenCalledWith("session/request_permission", 42, expect.objectContaining({ sessionId: "s1" }));
   });
});
```

- [ ] **Step 2: Запустить тест — убедиться что падает**

```bash
cd /Users/tradchenko/companion/web && bun run test -- acp-transport
```

- [ ] **Step 3: Реализовать AcpTransport**

```typescript
// web/server/acp-transport.ts
// Транспорт ACP JSON-RPC 2.0 через stdio (NDJSON)
// Аналог ICodexTransport из codex-adapter.ts, но для ACP протокола

export interface IAcpTransport {
   call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
   notify(method: string, params?: Record<string, unknown>): void;
   respond(id: number | string, result: unknown): void;
   onNotification(handler: (method: string, params: Record<string, unknown>) => void): void;
   onRequest(handler: (method: string, id: number | string, params: Record<string, unknown>) => void): void;
   onRawIncoming(cb: (line: string) => void): void;
   onRawOutgoing(cb: (data: string) => void): void;
   isConnected(): boolean;
   close(): void;
}

export class AcpTransport implements IAcpTransport {
   private nextId = 1;
   private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
   private notificationHandlers: Array<(method: string, params: Record<string, unknown>) => void> = [];
   private requestHandlers: Array<(method: string, id: number | string, params: Record<string, unknown>) => void> = [];
   private rawIncomingCbs: Array<(line: string) => void> = [];
   private rawOutgoingCbs: Array<(data: string) => void> = [];
   private connected = true;
   private buffer = "";

   constructor(
      private stdin: { write(data: string | Uint8Array): void },
      stdout: ReadableStream<Uint8Array> | null,
   ) {
      if (stdout) {
         this.readStream(stdout);
      }
   }

   private async readStream(stream: ReadableStream<Uint8Array>) {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
         while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            this.buffer += decoder.decode(value, { stream: true });
            const lines = this.buffer.split("\n");
            this.buffer = lines.pop() ?? "";
            for (const line of lines) {
               if (line.trim()) this.handleIncomingLine(line.trim());
            }
         }
      } catch {
         // Поток закрыт
      } finally {
         this.connected = false;
      }
   }

   handleIncomingLine(line: string): void {
      for (const cb of this.rawIncomingCbs) cb(line);

      let msg: any;
      try {
         msg = JSON.parse(line);
      } catch {
         return;
      }

      if (msg.jsonrpc !== "2.0") return;

      // Ответ на наш запрос (есть id, есть result или error, нет method)
      if ("id" in msg && !("method" in msg)) {
         const entry = this.pending.get(msg.id);
         if (!entry) return;
         this.pending.delete(msg.id);
         if (entry.timer) clearTimeout(entry.timer);
         if (msg.error) {
            entry.reject(new Error(`ACP error ${msg.error.code}: ${msg.error.message}`));
         } else {
            entry.resolve(msg.result);
         }
         return;
      }

      // Запрос от агента (есть id и method) — например session/request_permission
      if ("id" in msg && "method" in msg) {
         for (const h of this.requestHandlers) h(msg.method, msg.id, msg.params ?? {});
         return;
      }

      // Notification от агента (есть method, нет id) — например session/update
      if ("method" in msg && !("id" in msg)) {
         for (const h of this.notificationHandlers) h(msg.method, msg.params ?? {});
         return;
      }
   }

   call(method: string, params?: Record<string, unknown>, timeoutMs = 30000): Promise<unknown> {
      const id = this.nextId++;
      return new Promise((resolve, reject) => {
         const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`ACP call "${method}" timed out after ${timeoutMs}ms`));
         }, timeoutMs);
         this.pending.set(id, { resolve, reject, timer });
         this.send({ jsonrpc: "2.0", id, method, params });
      });
   }

   notify(method: string, params?: Record<string, unknown>): void {
      this.send({ jsonrpc: "2.0", method, params });
   }

   respond(id: number | string, result: unknown): void {
      this.send({ jsonrpc: "2.0", id, result });
   }

   onNotification(handler: (method: string, params: Record<string, unknown>) => void): void {
      this.notificationHandlers.push(handler);
   }

   onRequest(handler: (method: string, id: number | string, params: Record<string, unknown>) => void): void {
      this.requestHandlers.push(handler);
   }

   onRawIncoming(cb: (line: string) => void): void {
      this.rawIncomingCbs.push(cb);
   }

   onRawOutgoing(cb: (data: string) => void): void {
      this.rawOutgoingCbs.push(cb);
   }

   isConnected(): boolean {
      return this.connected;
   }

   close(): void {
      this.connected = false;
      for (const [, entry] of this.pending) {
         if (entry.timer) clearTimeout(entry.timer);
         entry.reject(new Error("Transport closed"));
      }
      this.pending.clear();
   }

   private send(msg: Record<string, unknown>): void {
      const data = JSON.stringify(msg) + "\n";
      for (const cb of this.rawOutgoingCbs) cb(data);
      this.stdin.write(data);
   }
}
```

- [ ] **Step 4: Запустить тесты**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test -- acp-transport
```
Ожидаемо: PASS

- [ ] **Step 5: Коммит**

```bash
git add web/server/acp-transport.ts web/server/acp-transport.test.ts
git commit -m "feat(acp): реализовать AcpTransport — JSON-RPC 2.0 stdio"
```

---

### Task 4: ACP Adapter

Универсальный адаптер, транслирующий ACP протокол в BrowserIncomingMessage.

**Files:**
- Create: `web/server/acp-adapter.ts`
- Test: `web/server/acp-adapter.test.ts`

- [ ] **Step 1: Написать тесты для AcpAdapter**

```typescript
// web/server/acp-adapter.test.ts
import { describe, it, expect, vi } from "vitest";
import { AcpAdapter } from "./acp-adapter.js";

// Мок транспорта
function createMockTransport() {
   const handlers: Record<string, Function[]> = { notification: [], request: [] };
   return {
      call: vi.fn().mockResolvedValue({}),
      notify: vi.fn(),
      respond: vi.fn(),
      onNotification: (h: Function) => handlers.notification.push(h),
      onRequest: (h: Function) => handlers.request.push(h),
      onRawIncoming: vi.fn(),
      onRawOutgoing: vi.fn(),
      isConnected: () => true,
      close: vi.fn(),
      // Хелперы для тестов
      _fireNotification: (method: string, params: any) => handlers.notification.forEach(h => h(method, params)),
      _fireRequest: (method: string, id: any, params: any) => handlers.request.forEach(h => h(method, id, params)),
   };
}

describe("AcpAdapter", () => {
   it("initialize вызывает протокол ACP: initialize → session/new", async () => {
      const transport = createMockTransport();
      transport.call
         .mockResolvedValueOnce({ protocolVersion: 1, agentCapabilities: {} }) // initialize
         .mockResolvedValueOnce({ sessionId: "acp-123" }); // session/new

      const adapter = new AcpAdapter(transport as any, "test-session", {
         agentId: "gemini",
         cwd: "/tmp/test",
      });

      await adapter.initialize();

      expect(transport.call).toHaveBeenCalledWith("initialize", expect.objectContaining({
         protocolVersion: 1,
      }), expect.any(Number));
      expect(transport.call).toHaveBeenCalledWith("session/new", expect.objectContaining({
         cwd: "/tmp/test",
      }), expect.any(Number));
   });

   it("транслирует agent_message_chunk в stream_event", () => {
      const transport = createMockTransport();
      const adapter = new AcpAdapter(transport as any, "test-session", { agentId: "gemini", cwd: "/tmp" });
      const handler = vi.fn();
      adapter.onBrowserMessage(handler);

      transport._fireNotification("session/update", {
         sessionId: "acp-123",
         update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello world" },
         },
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
         type: "stream_event",
      }));
   });

   it("транслирует tool_call в tool_use сообщение", () => {
      const transport = createMockTransport();
      const adapter = new AcpAdapter(transport as any, "test-session", { agentId: "gemini", cwd: "/tmp" });
      const handler = vi.fn();
      adapter.onBrowserMessage(handler);

      transport._fireNotification("session/update", {
         sessionId: "acp-123",
         update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc1",
            title: "Read file",
            kind: "read",
            status: "in_progress",
            content: [],
            locations: [{ path: "/tmp/test.ts" }],
         },
      });

      expect(handler).toHaveBeenCalled();
   });

   it("транслирует session/request_permission в permission_request", () => {
      const transport = createMockTransport();
      const adapter = new AcpAdapter(transport as any, "test-session", { agentId: "gemini", cwd: "/tmp" });
      const handler = vi.fn();
      adapter.onBrowserMessage(handler);

      transport._fireRequest("session/request_permission", 42, {
         sessionId: "acp-123",
         toolCall: { toolCallId: "tc1", title: "Execute command", kind: "execute" },
         options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
         ],
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
         type: "permission_request",
      }));
   });

   it("sendBrowserMessage отправляет user_message как session/prompt", () => {
      const transport = createMockTransport();
      transport.call.mockResolvedValue({ stopReason: "end_turn" });
      const adapter = new AcpAdapter(transport as any, "test-session", { agentId: "gemini", cwd: "/tmp" });
      (adapter as any).acpSessionId = "acp-123"; // симулируем инициализированную сессию
      (adapter as any).initialized = true;

      adapter.sendBrowserMessage({
         type: "user_message",
         message: "Hello",
      } as any);

      expect(transport.call).toHaveBeenCalledWith("session/prompt", expect.objectContaining({
         sessionId: "acp-123",
         prompt: [{ type: "text", text: "Hello" }],
      }), expect.any(Number));
   });

   it("sendBrowserMessage отправляет interrupt как session/cancel", () => {
      const transport = createMockTransport();
      const adapter = new AcpAdapter(transport as any, "test-session", { agentId: "gemini", cwd: "/tmp" });
      (adapter as any).acpSessionId = "acp-123";
      (adapter as any).initialized = true;

      adapter.sendBrowserMessage({ type: "interrupt" } as any);

      expect(transport.notify).toHaveBeenCalledWith("session/cancel", { sessionId: "acp-123" });
   });
});
```

- [ ] **Step 2: Запустить тест — убедиться что падает**

```bash
cd /Users/tradchenko/companion/web && bun run test -- acp-adapter
```

- [ ] **Step 3: Реализовать AcpAdapter**

Создать `web/server/acp-adapter.ts`. Ключевой класс ~400-600 строк. Структура:

```typescript
// web/server/acp-adapter.ts
import type { IAcpTransport } from "./acp-transport.js";
import type { BrowserIncomingMessage, BrowserOutgoingMessage } from "./session-types.js";

export interface AcpAdapterOptions {
   agentId: string;       // id из acp-agents.json
   cwd: string;
   model?: string;
   threadId?: string;     // для session/load (resume)
   recorder?: any;
   killProcess?: () => void;
}

export class AcpAdapter {
   private transport: IAcpTransport;
   private sessionId: string;          // companion session id
   private acpSessionId: string | null = null; // ACP session id от агента
   private initialized = false;
   private connected = true;
   private streamingText = "";
   private pendingOutgoing: BrowserOutgoingMessage[] = [];
   private pendingApprovals = new Map<string, number | string>(); // requestId → jsonRpcId
   private browserMessageCbs: Array<(msg: BrowserIncomingMessage) => void> = [];
   private sessionMetaCbs: Array<(meta: Record<string, unknown>) => void> = [];
   private disconnectCbs: Array<() => void> = [];
   private initErrorCbs: Array<(err: Error) => void> = [];
   private options: AcpAdapterOptions;

   constructor(transport: IAcpTransport, sessionId: string, options: AcpAdapterOptions) {
      this.transport = transport;
      this.sessionId = sessionId;
      this.options = options;
      this.setupHandlers();
   }

   // --- Публичный API (совместимый с CodexAdapter) ---

   onBrowserMessage(cb: (msg: BrowserIncomingMessage) => void): void {
      this.browserMessageCbs.push(cb);
   }

   onSessionMeta(cb: (meta: Record<string, unknown>) => void): void {
      this.sessionMetaCbs.push(cb);
   }

   onDisconnect(cb: () => void): void {
      this.disconnectCbs.push(cb);
   }

   onInitError(cb: (err: Error) => void): void {
      this.initErrorCbs.push(cb);
   }

   sendBrowserMessage(msg: BrowserOutgoingMessage): boolean {
      if (!this.initialized) {
         this.pendingOutgoing.push(msg);
         return true;
      }
      return this.dispatchOutgoing(msg);
   }

   getThreadId(): string | null {
      return this.acpSessionId;
   }

   async initialize(): Promise<void> {
      // Шаг 1: initialize
      // Шаг 2: session/new или session/load
      // Шаг 3: emit session_init
      // Шаг 4: flush pendingOutgoing
      // Подробная реализация в коде
   }

   // --- Приватные методы ---

   private setupHandlers(): void {
      // Подписка на transport notifications и requests
      // Трансляция ACP → BrowserIncomingMessage
   }

   private dispatchOutgoing(msg: BrowserOutgoingMessage): boolean {
      // Маршрутизация browser сообщений → ACP методы
      // user_message → session/prompt
      // interrupt → session/cancel
      // permission_response → respond()
   }

   private handleSessionUpdate(params: Record<string, unknown>): void {
      // Обработка session/update notification
      // agent_message_chunk → stream_event
      // tool_call → assistant (tool_use block)
      // tool_call_update → result / stream_event
      // agent_thought_chunk → thinking block
      // plan → assistant (plan info)
   }

   private handlePermissionRequest(id: number | string, params: Record<string, unknown>): void {
      // Трансляция session/request_permission → permission_request BrowserMessage
   }

   private handleFsRequest(method: string, id: number | string, params: Record<string, unknown>): void {
      // Обработка fs/read_text_file, fs/write_text_file от агента
      // Читаем/пишем файл и отвечаем
   }

   private handleTerminalRequest(method: string, id: number | string, params: Record<string, unknown>): void {
      // Обработка terminal/* запросов от агента
   }

   private emit(msg: BrowserIncomingMessage): void {
      for (const cb of this.browserMessageCbs) cb(msg);
   }
}
```

Полная реализация должна транслировать:
- `session/update` → `stream_event`, `assistant`, `result`, `thinking`
- `session/request_permission` → `permission_request`
- `session/prompt` response (stopReason) → `result`
- `fs/*` и `terminal/*` → обработка на стороне companion (чтение/запись файлов)

- [ ] **Step 4: Запустить тесты**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test -- acp-adapter
```
Ожидаемо: PASS

- [ ] **Step 5: Коммит**

```bash
git add web/server/acp-adapter.ts web/server/acp-adapter.test.ts
git commit -m "feat(acp): реализовать AcpAdapter — трансляция ACP → BrowserMessage"
```

---

## Chunk 3: Backend Integration (Launcher + Bridge)

### Task 5: Расширить CLI Launcher для ACP

**Files:**
- Modify: `web/server/cli-launcher.ts`
- Read: `web/server/acp-registry.ts`, `web/server/acp-adapter.ts`

- [ ] **Step 1: Добавить импорты и callback**

В начало `cli-launcher.ts` добавить:
```typescript
import { AcpAdapter, type AcpAdapterOptions } from "./acp-adapter.js";
import { AcpTransport } from "./acp-transport.js";
import { getAcpAgent } from "./acp-registry.js";
```

Добавить поле и метод (рядом с `onCodexAdapterCreated`):
```typescript
private onAcpAdapter: ((sessionId: string, adapter: AcpAdapter) => void) | null = null;

onAcpAdapterCreated(cb: (sessionId: string, adapter: AcpAdapter) => void): void {
   this.onAcpAdapter = cb;
}
```

- [ ] **Step 2: Расширить LaunchOptions**

```typescript
// Добавить в LaunchOptions:
acpAgentId?: string;  // id из acp-agents.json (gemini, qwen, goose...)
```

- [ ] **Step 3: Расширить launch() для ACP**

В методе `launch()`, после блока `if (backendType === "codex")`:
```typescript
if (backendType === "acp") {
   this.spawnAcp(sessionId, info, options);
} else if (backendType === "codex") {
   this.spawnCodex(sessionId, info, options);
} else {
   this.spawnCLI(sessionId, info, options);
}
```

- [ ] **Step 4: Реализовать spawnAcp()**

```typescript
private spawnAcp(sessionId: string, info: SdkSessionInfo, options: LaunchOptions): void {
   const agentId = options.acpAgentId;
   if (!agentId) {
      log(`[ACP] Ошибка: acpAgentId не указан для сессии ${sessionId}`);
      info.state = "exited";
      info.exitCode = 1;
      return;
   }

   const agentDef = getAcpAgent(agentId);
   if (!agentDef) {
      log(`[ACP] Агент "${agentId}" не найден в реестре`);
      info.state = "exited";
      info.exitCode = 1;
      return;
   }

   const binary = options.codexBinary || resolveBinary(agentDef.binary);
   if (!binary) {
      log(`[ACP] Бинарник "${agentDef.binary}" не найден`);
      info.state = "exited";
      info.exitCode = 1;
      return;
   }

   const args = [...agentDef.acpFlags];
   const enrichedPath = getEnrichedPath();
   const binaryDir = resolve(binary, "..");
   const pathSep = process.platform === "win32" ? ";" : ":";
   const spawnPath = [binaryDir, ...enrichedPath.split(pathSep)].filter(Boolean).join(pathSep);

   log(`[ACP] Запуск ${agentDef.name}: ${binary} ${args.join(" ")} (cwd: ${info.cwd})`);

   const proc = Bun.spawn([binary, ...args], {
      cwd: info.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
         ...process.env,
         PATH: spawnPath,
         ...options.env,
      },
   });

   info.pid = proc.pid;
   info.state = "running";

   const transport = new AcpTransport(proc.stdin, proc.stdout);
   const adapter = new AcpAdapter(transport, sessionId, {
      agentId,
      cwd: info.cwd,
      model: options.model,
      threadId: info.cliSessionId,
      recorder: this.recorder ?? undefined,
      killProcess: () => proc.kill(),
   });

   // Запись raw протокола
   if (this.recorder) {
      transport.onRawIncoming((line) => this.recorder?.write(sessionId, "in", line, "cli"));
      transport.onRawOutgoing((data) => this.recorder?.write(sessionId, "out", data, "cli"));
   }

   // stderr → логирование
   if (proc.stderr) {
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      (async () => {
         try {
            while (true) {
               const { done, value } = await reader.read();
               if (done) break;
               const text = decoder.decode(value, { stream: true });
               log(`[ACP:${agentId}:${sessionId.slice(0, 8)}] ${text.trim()}`);
            }
         } catch {}
      })();
   }

   // Инициализация адаптера
   adapter.initialize().catch((err) => {
      log(`[ACP] Ошибка инициализации ${agentDef.name}: ${err.message}`);
   });

   // Callback для WsBridge
   if (this.onAcpAdapter) {
      this.onAcpAdapter(sessionId, adapter);
   }

   // Мониторинг завершения процесса
   proc.exited.then((exitCode) => {
      log(`[ACP] ${agentDef.name} завершился (exit ${exitCode})`);
      info.state = "exited";
      info.exitCode = exitCode ?? 1;
      transport.close();
   });
}
```

- [ ] **Step 5: Запустить typecheck**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck
```

- [ ] **Step 6: Коммит**

```bash
git add web/server/cli-launcher.ts
git commit -m "feat(acp): добавить spawnAcp() в cli-launcher"
```

---

### Task 6: WsBridge — интеграция ACP адаптера

**Files:**
- Create: `web/server/ws-bridge-acp.ts`
- Modify: `web/server/ws-bridge.ts` (точечно)
- Test: `web/server/ws-bridge-acp.test.ts`

- [ ] **Step 1: Написать тест для ws-bridge-acp**

```typescript
// web/server/ws-bridge-acp.test.ts
import { describe, it, expect, vi } from "vitest";

describe("attachAcpAdapterHandlers", () => {
   it("транслирует assistant сообщение в broadcast", () => {
      // Тест что onBrowserMessage корректно вызывает broadcastToBrowsers
      // Аналогично ws-bridge-codex тестам
      expect(true).toBe(true); // placeholder — реализовать с моками
   });
});
```

- [ ] **Step 2: Создать ws-bridge-acp.ts**

По аналогии с `ws-bridge-codex.ts` (247 строк). Функция `attachAcpAdapterHandlers()`:

```typescript
// web/server/ws-bridge-acp.ts
import type { AcpAdapter } from "./acp-adapter.js";
import type { Session } from "./ws-bridge-types.js";
import type { BrowserIncomingMessage } from "./session-types.js";

export interface AcpAttachDeps {
   persistSession: (session: Session) => void;
   refreshGitInfo: (session: Session, options?: { force?: boolean }) => void;
   broadcastToBrowsers: (session: Session, msg: BrowserIncomingMessage) => void;
   onCLISessionId: ((sessionId: string, cliSessionId: string) => void) | null;
   onFirstTurnCompleted: ((sessionId: string, firstUserMessage: string) => void) | null;
   autoNamingAttempted: Set<string>;
   assistantMessageListeners: Map<string, Set<(msg: BrowserIncomingMessage) => void>>;
   resultListeners: Map<string, Set<(msg: BrowserIncomingMessage) => void>>;
   onCLIRelaunchNeeded: ((sessionId: string) => void) | null;
}

export function attachAcpAdapterHandlers(
   sessionId: string,
   session: Session,
   adapter: AcpAdapter,
   deps: AcpAttachDeps,
): void {
   // Реализация по аналогии с attachCodexAdapterHandlers:
   // adapter.onBrowserMessage → update state, persist, broadcast
   // adapter.onSessionMeta → store acpSessionId
   // adapter.onDisconnect → cleanup, auto-relaunch
}
```

- [ ] **Step 3: Интегрировать в ws-bridge.ts**

Добавить в `ws-bridge.ts`:
```typescript
import { attachAcpAdapterHandlers } from "./ws-bridge-acp.js";
```

В Session interface добавить:
```typescript
acpAdapter?: AcpAdapter | null;
```

Добавить метод `attachAcpAdapter()` по аналогии с `attachCodexAdapter()`.

В обработчике browser сообщений — роутить через `session.acpAdapter?.sendBrowserMessage()` когда `backendType === "acp"`.

- [ ] **Step 4: Зарегистрировать callback в index.ts**

В `web/server/index.ts` добавить:
```typescript
launcher.onAcpAdapterCreated((sessionId, adapter) => {
   // Аналогично onCodexAdapterCreated
   bridge.attachAcpAdapter(sessionId, adapter);
});
```

- [ ] **Step 5: Запустить тесты**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test
```

- [ ] **Step 6: Коммит**

```bash
git add web/server/ws-bridge-acp.ts web/server/ws-bridge-acp.test.ts web/server/ws-bridge.ts web/server/index.ts
git commit -m "feat(acp): интегрировать AcpAdapter в WsBridge"
```

---

## Chunk 4: Backend API + Binary Resolver

### Task 7: Расширить API endpoints

**Files:**
- Modify: `web/server/routes.ts`
- Modify: `web/server/path-resolver.ts`
- Create: `web/server/acp-binary-resolver.ts`
- Test: `web/server/acp-binary-resolver.test.ts`

- [ ] **Step 1: Написать тест для acp-binary-resolver**

```typescript
// web/server/acp-binary-resolver.test.ts
import { describe, it, expect } from "vitest";
import { resolveAcpBinary } from "./acp-binary-resolver.js";

describe("resolveAcpBinary", () => {
   it("находит бинарник в PATH", () => {
      // gemini установлен — должен найти
      const result = resolveAcpBinary("gemini");
      // На CI может не быть — тест условный
      if (result) {
         expect(result).toContain("gemini");
      }
   });

   it("возвращает null для несуществующего бинарника", () => {
      expect(resolveAcpBinary("nonexistent-agent-xyz")).toBeNull();
   });

   it("принимает абсолютный путь напрямую", () => {
      const result = resolveAcpBinary("/bin/sh");
      expect(result).toBe("/bin/sh");
   });
});
```

- [ ] **Step 2: Реализовать acp-binary-resolver.ts**

```typescript
// web/server/acp-binary-resolver.ts
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { resolveBinary } from "./path-resolver.js";
import { getAcpAgent } from "./acp-registry.js";

// Резолвит бинарник ACP-агента: PATH → searchPaths → настройки пользователя
export function resolveAcpBinary(binaryOrAgentId: string, customPath?: string): string | null {
   // 1. Кастомный путь из настроек — высший приоритет
   if (customPath && existsSync(customPath)) return customPath;

   // 2. Абсолютный путь
   if (binaryOrAgentId.startsWith("/")) {
      return existsSync(binaryOrAgentId) ? binaryOrAgentId : null;
   }

   // 3. resolveBinary (PATH + enriched paths)
   const fromPath = resolveBinary(binaryOrAgentId);
   if (fromPath) return fromPath;

   // 4. Поиск в searchPaths из реестра агента
   const agent = getAcpAgent(binaryOrAgentId);
   if (agent) {
      const platform = process.platform as string;
      const paths = agent.searchPaths[platform] ?? [];
      for (const searchDir of paths) {
         const expanded = searchDir.replace("~", homedir());
         const candidate = join(expanded, agent.binary);
         if (existsSync(candidate)) return candidate;
      }
   }

   return null;
}
```

- [ ] **Step 3: Расширить GET /api/backends**

В `routes.ts`, после `backends.push({ id: "codex", ... })` добавить:

```typescript
import { getAllAcpAgents } from "./acp-registry.js";
import { resolveAcpBinary } from "./acp-binary-resolver.js";

// В GET /api/backends:
for (const agent of getAllAcpAgents()) {
   backends.push({
      id: `acp:${agent.id}`,
      name: agent.name,
      available: resolveAcpBinary(agent.binary) !== null,
   });
}
```

- [ ] **Step 4: Расширить GET /api/backends/:id/models**

```typescript
// В GET /api/backends/:id/models, добавить:
if (backendId.startsWith("acp:")) {
   const agentId = backendId.slice(4);
   const agent = getAcpAgent(agentId);
   if (!agent) return c.json({ error: `ACP agent "${agentId}" not found` }, 404);
   return c.json(agent.defaultModels.map(m => ({
      value: m.value,
      label: m.label,
      description: "",
   })));
}
```

- [ ] **Step 5: Расширить POST /api/sessions/create**

В валидации backend (строка ~194):
```typescript
// Было:
if (backend !== "claude" && backend !== "codex") ...
// Стало:
const validBackends = ["claude", "codex"];
const isAcp = backend?.startsWith("acp:");
if (!isAcp && backend && !validBackends.includes(backend)) ...
```

При вызове `launcher.launch()`:
```typescript
if (isAcp) {
   const acpAgentId = backend!.slice(4);
   // ...
   launcher.launch({
      ...opts,
      backendType: "acp",
      acpAgentId,
   });
}
```

- [ ] **Step 6: Запустить тесты**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test
```

- [ ] **Step 7: Коммит**

```bash
git add web/server/acp-binary-resolver.ts web/server/acp-binary-resolver.test.ts web/server/routes.ts
git commit -m "feat(acp): расширить API endpoints для ACP-агентов"
```

---

## Chunk 5: Frontend — Dropdown UI

### Task 8: Заменить кнопки на dropdown

**Files:**
- Modify: `web/src/components/HomePage.tsx`
- Modify: `web/src/utils/backends.ts`
- Modify: `web/src/api.ts`
- Test: `web/src/components/HomePage.test.tsx` (обновить)

- [ ] **Step 1: Обновить BackendInfo в api.ts**

Тип уже подходит (`id`, `name`, `available`). ACP-агенты придут с id формата `acp:gemini`. Добавить метод:

```typescript
// Убрать хардкод типа backend: "claude" | "codex" в CreateSessionOpts
// Заменить на:
backend?: string;  // "claude" | "codex" | "acp:gemini" | "acp:qwen" | ...
```

- [ ] **Step 2: Обновить backends.ts**

Сделать функции динамическими — для ACP агентов модели приходят из API:

```typescript
export function getModelsForBackend(backend: string): ModelOption[] {
   if (backend === "codex") return CODEX_MODELS;
   if (backend === "claude") return CLAUDE_MODELS;
   return []; // ACP — модели загружаются динамически
}

export function getDefaultModel(backend: string): string {
   if (backend === "codex") return CODEX_MODELS[0].value;
   if (backend === "claude") return CLAUDE_MODELS[0].value;
   return ""; // ACP — будет установлена после загрузки моделей
}

export function getDefaultMode(backend: string): string {
   return "bypassPermissions"; // одинаково для всех
}

export function isAcpBackend(backend: string): boolean {
   return backend.startsWith("acp:");
}
```

- [ ] **Step 3: Заменить кнопки на dropdown в HomePage.tsx**

Убрать блок с `backends.map((b) => <button ...>)` (строки 978-1004). Заменить на:

```tsx
{backends.length > 1 && (
   <div className="relative">
      <select
         value={backend}
         onChange={(e) => {
            const b = backends.find((x) => x.id === e.target.value);
            if (b?.available) switchBackend(e.target.value);
         }}
         className="appearance-none bg-cc-hover/50 text-cc-fg text-xs rounded-lg px-3 py-2 pr-7 border border-cc-border focus:outline-none focus:ring-1 focus:ring-cc-accent cursor-pointer"
      >
         {backends.map((b) => (
            <option key={b.id} value={b.id} disabled={!b.available}>
               {b.name}{!b.available ? " (не найден)" : ""}
            </option>
         ))}
      </select>
      <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-cc-muted pointer-events-none" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
         <path d="M3 5l3 3 3-3" />
      </svg>
   </div>
)}
```

- [ ] **Step 4: Обновить switchBackend для ACP**

```typescript
function switchBackend(newBackend: string) {
   setBackend(newBackend);
   localStorage.setItem("cc-backend", newBackend);
   setDynamicModels(null);

   if (isAcpBackend(newBackend)) {
      // Загрузить модели из API для ACP агента
      api.getBackendModels(newBackend).then((models) => {
         if (models.length > 0) {
            setDynamicModels(toModelOptions(models));
            setModel(models[0].value);
         }
      }).catch(() => {});
      setMode(getDefaultMode(newBackend));
      setShowBranchingControls(false);
      setResumeCandidates([]);
   } else {
      setModel(getDefaultModel(newBackend));
      setMode(getDefaultMode(newBackend));
      if (newBackend !== "claude") {
         setShowBranchingControls(false);
         setResumeCandidates([]);
      }
   }
}
```

- [ ] **Step 5: Добавить поле для кастомной модели**

Рядом с селектором модели, если текущий бэкенд — ACP с `customModelInput: true`:

```tsx
{isAcpBackend(backend) && (
   <input
      type="text"
      placeholder="Или введите модель..."
      value={customModel}
      onChange={(e) => {
         setCustomModel(e.target.value);
         if (e.target.value) setModel(e.target.value);
      }}
      className="bg-cc-hover/50 text-cc-fg text-xs rounded-lg px-3 py-2 border border-cc-border placeholder:text-cc-muted/50 focus:outline-none focus:ring-1 focus:ring-cc-accent"
   />
)}
```

- [ ] **Step 6: Обновить useEffect для динамических моделей**

Расширить существующий useEffect (строки 222-239) чтобы работал со всеми не-Claude бэкендами:

```typescript
useEffect(() => {
   if (backend === "claude") {
      setDynamicModels(null);
      return;
   }
   api.getBackendModels(backend).then((models) => {
      if (models.length > 0) {
         const options = toModelOptions(models);
         setDynamicModels(options);
         if (!options.some((m) => m.value === model)) {
            setModel(options[0].value);
         }
      }
   }).catch(() => {});
}, [backend]);
```

- [ ] **Step 7: Запустить typecheck и тесты**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test
```

- [ ] **Step 8: Собрать фронтенд**

```bash
cd /Users/tradchenko/companion/web && bun run build
```

- [ ] **Step 9: Коммит**

```bash
git add web/src/components/HomePage.tsx web/src/utils/backends.ts web/src/api.ts
git commit -m "feat(ui): заменить кнопки бэкенда на dropdown с поддержкой ACP-агентов"
```

---

## Chunk 6: Настройки + кастомные пути к бинарникам

### Task 9: Добавить настройки кастомных путей в UI

**Files:**
- Modify: `web/src/components/` (settings page — найти через grep "settings")
- Modify: `web/server/routes.ts` (GET/PUT settings endpoint)

- [ ] **Step 1: Найти компонент настроек**

```bash
grep -r "Settings" web/src/components/ --include="*.tsx" -l
```

- [ ] **Step 2: Добавить секцию "ACP Agents" в настройки**

Форма с полями для каждого ACP-агента из реестра:
- Label: имя агента
- Input: путь к бинарнику (placeholder: auto-detect path)
- Status indicator: найден / не найден

- [ ] **Step 3: Сохранение в settings.json**

В `~/.companion/settings.json` добавить:
```json
{
   "acpBinaryPaths": {
      "gemini": "/custom/path/to/gemini",
      "qwen": "/opt/custom/qwen"
   }
}
```

- [ ] **Step 4: Использовать кастомные пути в resolveAcpBinary**

Передавать `customPath` из settings при вызове `resolveAcpBinary`.

- [ ] **Step 5: Тесты и коммит**

```bash
cd /Users/tradchenko/companion/web && bun run typecheck && bun run test
git add -A && git commit -m "feat(settings): добавить настройки путей к ACP-агентам"
```

---

## Chunk 7: Интеграционное тестирование

### Task 10: E2E проверка с установленными агентами

- [ ] **Step 1: Запустить companion в dev режиме**

```bash
cd /Users/tradchenko/companion/web && bun run dev
```

- [ ] **Step 2: Проверить GET /api/backends**

```bash
curl http://localhost:3456/api/backends | jq .
```
Ожидаемо: Claude, Codex + Gemini, Qwen (available: true), Goose, Copilot (available: зависит).

- [ ] **Step 3: Проверить GET /api/backends/acp:gemini/models**

```bash
curl http://localhost:3456/api/backends/acp:gemini/models | jq .
```

- [ ] **Step 4: Создать сессию с Gemini CLI**

Через UI: выбрать Gemini CLI в dropdown → ввести промпт → убедиться что стриминг работает.

- [ ] **Step 5: Создать сессию с Qwen Code**

Аналогично с Qwen Code.

- [ ] **Step 6: Проверить Codex (регрессия)**

Убедиться что Codex по-прежнему работает корректно с встроенным siblingNode fix.

- [ ] **Step 7: Проверить Claude Code (регрессия)**

Убедиться что Claude Code не затронут.

- [ ] **Step 8: Финальный коммит**

```bash
git add -A && git commit -m "test: интеграционная проверка ACP-агентов"
```

---

## Зависимости между задачами

```
Task 1 (Codex fix) ─────────────────────────────────────────┐
Task 2 (Registry + types) ──┬──> Task 3 (Transport) ──┐     │
                             │                          ├──> Task 5 (Launcher)
                             │   Task 4 (Adapter) ─────┘     │
                             │                                ├──> Task 6 (Bridge)
                             └──> Task 7 (API + resolver) ───┘     │
                                                                    ├──> Task 8 (Frontend)
                                                                    ├──> Task 9 (Settings)
                                                                    └──> Task 10 (E2E)
```

**Параллельно можно выполнять:**
- Task 1 + Task 2 (независимы)
- Task 3 + Task 4 (после Task 2, можно параллельно)
- Task 7 + Task 5 (после Task 2, частично параллельно)
- Task 8 + Task 9 (после Task 7, параллельно)
