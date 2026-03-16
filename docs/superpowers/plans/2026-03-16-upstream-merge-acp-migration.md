# Upstream Merge + ACP Migration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge upstream/main (v0.76→v0.90.2) into feature/acp-multi-agent-support, adapt our ACP code to upstream's new `IBackendAdapter` architecture.

**Architecture:** Upstream introduced unified `IBackendAdapter` interface, `SessionOrchestrator`, `CompanionEventBus`, and store slices. Our `AcpAdapter` must implement `IBackendAdapter`. Our ws-bridge-acp.ts logic moves into AcpAdapter methods. Session creation moves to orchestrator/creation-service.

**Tech Stack:** TypeScript, Bun, Hono, React 19, Zustand (sliced store)

---

## Chunk 1: Merge и базовая компиляция

### Task 1: Merge upstream/main с принятием их архитектуры

**Files:**
- All conflicting files (12 files)

- [ ] **Step 1: Создать backup ветку**

```bash
git branch backup/pre-upstream-merge
```

- [ ] **Step 2: Начать merge**

```bash
git merge upstream/main --no-edit
```

Ожидаем конфликты в ~12 файлах.

- [ ] **Step 3: Разрешить конфликты в серверных файлах — принять upstream**

Для файлов с архитектурным рефакторингом принимаем upstream (theirs):

```bash
# Архитектурные файлы — принять upstream полностью
git checkout --theirs web/server/ws-bridge-types.ts
git checkout --theirs web/server/ws-bridge.ts
git checkout --theirs web/server/cli-launcher.ts
git checkout --theirs web/server/index.ts
git checkout --theirs web/server/routes.ts
git checkout --theirs web/server/routes.test.ts
git checkout --theirs web/server/linear-agent.test.ts
git checkout --theirs web/server/ws-bridge-codex.test.ts

git add web/server/ws-bridge-types.ts web/server/ws-bridge.ts web/server/cli-launcher.ts web/server/index.ts web/server/routes.ts web/server/routes.test.ts web/server/linear-agent.test.ts web/server/ws-bridge-codex.test.ts
```

- [ ] **Step 4: Разрешить конфликты в UI файлах — принять upstream**

```bash
git checkout --theirs web/src/components/HomePage.tsx
git checkout --theirs web/src/components/TaskPanel.tsx
git checkout --theirs web/src/components/McpPanel.tsx
git checkout --theirs web/src/components/AgentsPage.tsx

git add web/src/components/HomePage.tsx web/src/components/TaskPanel.tsx web/src/components/McpPanel.tsx web/src/components/AgentsPage.tsx
```

- [ ] **Step 5: Добавить наши новые ACP файлы (уже в staging)**

Файлы, которые мы создали и upstream не трогал — конфликтов нет:
- `web/server/acp-adapter.ts`
- `web/server/acp-transport.ts`
- `web/server/acp-registry.ts`
- `web/server/acp-agents.json`
- `web/server/ws-bridge-acp.ts`
- `web/server/acp-binary-resolver.ts`
- `web/server/mcp-config-reader.ts`
- `web/src/utils/native-commands.ts`
- Все тесты `*.test.ts`

```bash
git add web/server/acp-*.ts web/server/acp-agents.json web/server/mcp-config-reader.ts web/src/utils/native-commands.ts
git add web/server/acp-*.test.ts web/server/mcp-config-reader.test.ts
```

- [ ] **Step 6: Разрешить оставшиеся конфликты вручную и завершить merge**

Проверить `git status` — все конфликты должны быть разрешены.

```bash
git add -A
git commit --no-edit
```

- [ ] **Step 7: Проверить компиляцию**

```bash
cd web && bun run typecheck
```

Ожидаем ошибки — ws-bridge-acp.ts и другие наши файлы ссылаются на старые типы. Это нормально — исправим в следующих задачах.

### Task 2: Обновить session-types.ts — добавить ACP поля

**Files:**
- Modify: `web/server/session-types.ts`

- [ ] **Step 1: Добавить ACP-специфичные поля в SessionState**

В upstream'овый `session-types.ts` добавить поля, которые были в нашей версии:

```typescript
// В SessionState интерфейс добавить:
acp_token_details?: {
   inputTokens: number;
   outputTokens: number;
   thoughtTokens: number;
   cachedReadTokens: number;
   totalTokens: number;
   modelContextWindow: number;
};
availableModels?: { value: string; label: string }[];
availableModes?: { value: string; label: string }[];
```

- [ ] **Step 2: Убедиться что BackendType включает 'acp'**

```typescript
export type BackendType = "claude" | "codex" | "acp";
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

### Task 3: Адаптировать AcpAdapter → IBackendAdapter

**Files:**
- Modify: `web/server/acp-adapter.ts`
- Reference: `web/server/backend-adapter.ts` (upstream — IBackendAdapter интерфейс)
- Reference: `web/server/codex-adapter.ts` (upstream — пример имплементации)

Наш `AcpAdapter` уже имеет методы `onBrowserMessage`, `onSessionMeta`, `onDisconnect`, `emit` — нужно добавить `implements IBackendAdapter` и адаптировать сигнатуры.

- [ ] **Step 1: Изучить IBackendAdapter интерфейс**

Прочитать `web/server/backend-adapter.ts` и определить какие методы нужны:
- `send(msg)` — отправить сообщение от браузера к агенту
- `onBrowserMessage(cb)` — подписка на исходящие в браузер
- `onSessionMeta(cb)` — подписка на мета-данные
- `onDisconnect(cb)` — подписка на отключение
- `isConnected()` — проверка соединения
- `disconnect()` — отключение
- `getType()` — возвращает BackendType

- [ ] **Step 2: Добавить implements IBackendAdapter**

```typescript
import type { IBackendAdapter } from './backend-adapter.js';

export class AcpAdapter implements IBackendAdapter {
   // Существующие методы уже покрывают интерфейс
   // Добавить недостающие:

   getType(): BackendType { return 'acp'; }

   disconnect(): void {
      this.options.killProcess?.();
   }

   // send() — переименовать/адаптировать handleBrowserMessage
   send(msg: BrowserOutgoingMessage): void {
      // Существующая логика из handleBrowserMessage
   }
}
```

- [ ] **Step 3: Удалить ws-bridge-acp.ts**

Логика из `attachAcpAdapterHandlers()` теперь не нужна — upstream'овый `ws-bridge.ts` имеет `attachBackendAdapter()`, который работает с любым `IBackendAdapter`.

Перенести уникальную ACP-логику (vendor notifications, session state updates) внутрь AcpAdapter.

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

### Task 4: Обновить ws-bridge-types.ts — убрать acpAdapter

**Files:**
- Modify: `web/server/ws-bridge-types.ts`

- [ ] **Step 1: Проверить что Session использует backendAdapter**

Upstream уже имеет `backendAdapter: IBackendAdapter | null`. Убедиться что наше поле `acpAdapter` удалено (оно должно быть уже удалено при checkout --theirs).

Если нет — удалить вручную.

### Task 5: Интегрировать ACP в cli-launcher.ts

**Files:**
- Modify: `web/server/cli-launcher.ts`

- [ ] **Step 1: Добавить spawnAcp() в upstream cli-launcher**

Upstream cli-launcher использует `companionBus.emit()` для уведомления о новых адаптерах. Добавить ACP-специфичный spawn:

```typescript
// Добавить импорты ACP
import { AcpTransport } from './acp-transport.js';
import { AcpAdapter } from './acp-adapter.js';
import { getAcpAgent, type AcpAgentDefinition } from './acp-registry.js';
import { resolveBinaryPath } from './acp-binary-resolver.js';

// Добавить метод spawnAcp в класс CliLauncher
async spawnAcp(sessionId: string, agentId: string, opts: SpawnAcpOpts): Promise<AcpAdapter> {
   // Логика из нашего текущего spawnAcp()
   // В конце: companionBus.emit('backend:acp-adapter-created', { sessionId, adapter })
}
```

- [ ] **Step 2: Зарегистрировать ACP event в event-bus.ts**

```typescript
// В CompanionEventMap добавить:
'backend:acp-adapter-created': { sessionId: string; adapter: AcpAdapter };
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

### Task 6: Интегрировать ACP в SessionOrchestrator

**Files:**
- Modify: `web/server/session-orchestrator.ts`

- [ ] **Step 1: Добавить ACP session creation**

В метод `createSession()` добавить ветку для `backend === 'acp'` или `backend.startsWith('acp:')`:

```typescript
if (backendType === 'acp' || backendType.startsWith('acp:')) {
   const agentId = backendType.startsWith('acp:') ? backendType.split(':')[1] : opts.agentId;
   const adapter = await this.cliLauncher.spawnAcp(sessionId, agentId, { cwd, model, ... });
   this.wsBridge.attachBackendAdapter(session, adapter);
}
```

- [ ] **Step 2: Добавить ACP relaunch логику**

Подписаться на `backend:acp-adapter-created` в orchestrator, аналогично `backend:codex-adapter-created`.

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

### Task 7: Обновить routes.ts — ACP endpoints

**Files:**
- Modify: `web/server/routes.ts`

- [ ] **Step 1: Добавить ACP-специфичные routes**

В upstream routes.ts добавить:
- `GET /api/acp/agents` — список ACP агентов из реестра
- `POST /api/acp/agents/:id/resolve` — проверка доступности бинарника
- ACP валидацию в session creation (orchestrator уже обрабатывает, но нужно передать agentId)

- [ ] **Step 2: Добавить MCP servers endpoint**

```typescript
api.get("/api/sessions/:id/mcp-servers", ...)
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

---

## Chunk 2: UI интеграция

### Task 8: Обновить HomePage — backend dropdown

**Files:**
- Modify: `web/src/components/HomePage.tsx`

- [ ] **Step 1: Добавить backend selector dropdown**

В upstream'овый HomePage (ChatGPT/Cursor style) добавить наш dropdown для выбора бэкенда (Claude Code / Codex / Gemini CLI / Qwen Code / etc.).

Использовать upstream'овые design tokens и компоненты.

- [ ] **Step 2: Добавить SessionCreationProgress для ACP**

При создании ACP-сессии показывать прогресс подключения.

- [ ] **Step 3: Добавить ACP опции (worktree, model, cwd)**

Пробросить ACP-специфичные опции в session creation form.

### Task 9: Обновить TaskPanel — ACP usage section

**Files:**
- Modify: `web/src/components/TaskPanel.tsx`

- [ ] **Step 1: Добавить AcpUsageSection**

В upstream'овый TaskPanel (с collapsible sections) добавить наш AcpUsageSection:
- Токены (input/output/reasoning) когда доступны
- "Token data not available for this agent" когда нет _meta.usage
- Context usage bar

Использовать upstream'овый `PanelSection` wrapper и `useSdkSession` hook.

### Task 10: Обновить McpPanel — read-only для ACP

**Files:**
- Modify: `web/src/components/McpPanel.tsx`

- [ ] **Step 1: Добавить read-only режим**

Для ACP и Claude Code бэкендов показывать MCP серверы в read-only (без add/remove).

### Task 11: Обновить Composer — native commands + mode cycling

**Files:**
- Modify: `web/src/components/Composer.tsx`

- [ ] **Step 1: Проверить native commands интеграцию**

После merge убедиться что импорты `tryExecuteNativeCommand`, `getNativeCommandItems` работают.

- [ ] **Step 2: Восстановить ACP mode cycling**

Проверить что `isAcp` + `availableModes` + циклический `toggleMode()` работают корректно с новым store (slices).

### Task 12: Обновить store — ACP поля в слайсах

**Files:**
- Modify: `web/src/store/sessions-slice.ts` (или где SessionState хранится)

- [ ] **Step 1: Убедиться что store работает с ACP полями**

`availableModes`, `availableModels`, `acp_token_details`, `backend_type` должны корректно сохраняться и обновляться.

### Task 13: Обновить AgentsPage — ACP agent config

**Files:**
- Modify: `web/src/components/AgentsPage.tsx`

- [ ] **Step 1: Восстановить ACP agent configuration**

В upstream'овый AgentsPage (с Linear wizard) добавить секцию конфигурации ACP-агентов:
- Карточки агентов из acp-agents.json
- Путь к бинарнику
- MCP серверы

---

## Chunk 3: Тесты и финализация

### Task 14: Обновить тесты

**Files:**
- Modify: `web/server/routes.test.ts`
- Modify: `web/server/acp-adapter.test.ts`
- Modify: `web/server/acp-transport.test.ts`

- [ ] **Step 1: Адаптировать ACP тесты под новую архитектуру**

Обновить моки — использовать `backendAdapter` вместо `acpAdapter`.

- [ ] **Step 2: Запустить все тесты**

```bash
bun run test
```

- [ ] **Step 3: Исправить failing тесты**

### Task 15: Финальная проверка

- [ ] **Step 1: Typecheck**

```bash
bun run typecheck
```

- [ ] **Step 2: Запустить dev-сервер**

```bash
PORT=3460 VITE_PORT=5180 bun run dev
```

- [ ] **Step 3: Протестировать в браузере**

- Создать QW-сессию → проверить 4 режима
- Создать GM-сессию → проверить режимы
- Проверить native commands (/tools, /stats, /model)
- Проверить TaskPanel (ACP usage)
- Проверить MCP panel (read-only)

- [ ] **Step 4: Коммит**

```bash
git add -A
git commit -m "feat(acp): migrate to IBackendAdapter architecture after upstream merge v0.90.2"
```
