# Анализ merge upstream/main -> feature/acp-multi-agent-support

**Дата**: 2026-03-16
**Конфликтующих файлов**: 12
**Upstream коммитов**: ~30 (v0.84.1 -> v0.90.2)

---

## КЛЮЧЕВОЕ ОТКРЫТИЕ: Архитектурный рефакторинг в upstream

Upstream провёл **масштабный рефакторинг архитектуры**, который напрямую пересекается с нашей ACP-работой:

### Новые абстракции в upstream:
- **`IBackendAdapter`** (`backend-adapter.ts`) — унифицированный интерфейс адаптера бэкенда. Заменяет отдельные `cliSocket`, `codexAdapter` на единый `backendAdapter`.
- **`ClaudeAdapter`** (`claude-adapter.ts`) — адаптер для Claude Code (то что раньше было inline-логикой с `cliSocket`).
- **`SessionStateMachine`** (`session-state-machine.ts`) — стейт-машина сессии.
- **`SessionOrchestrator`** (`session-orchestrator.ts`) — оркестратор жизненного цикла сессий. Вся логика из `index.ts` (relaunch, idle-kill, auto-naming) вынесена в orchestrator.
- **`SessionCreationService`** (`session-creation-service.ts`) — создание сессий вынесено из routes.
- **`CompanionEventBus`** (`event-bus.ts`) — шина событий вместо callback-цепочек.
- **`Logger`** (`logger.ts`) — структурированное логирование.
- **`MetricsCollector`** (`metrics-collector.ts`) — метрики.
- **Store slices** (`web/src/store/`) — Zustand store разбит на слайсы (auth, chat, sessions, permissions, tasks, terminal, ui, updates).
- **`LinearOAuthCredentials`** — Linear credentials вынесены в отдельный интерфейс.

---

## Конфликтующие файлы: детальный анализ

### 1. `web/server/ws-bridge-types.ts` (2 конфликта)
**Суть**: У нас `cliSocket + codexAdapter + acpAdapter`, у них единый `backendAdapter: IBackendAdapter`.
**Тип**: Архитектурный — оба меняли одно и то же (Session interface).
**Рекомендация**: Принять upstream `backendAdapter`, реализовать `AcpAdapter` как `IBackendAdapter`. Это правильная абстракция — наш ACP-адаптер должен имплементировать этот интерфейс.

### 2. `web/server/ws-bridge.ts` (6 конфликтов)
**Суть**:
- Импорты: у нас `attachCodexAdapterHandlers` + `attachAcpAdapterHandlers`, upstream убрал прямые импорты.
- Session creation (2 места): `cliSocket/codexAdapter/acpAdapter: null` vs `backendAdapter: null`.
- `isCliConnected()`: наш switch по backendType vs upstream `session?.backendAdapter?.isConnected()`.
- Browser connect: наша проверка по типу бэкенда vs upstream `!!session.backendAdapter`.
- **Самый большой конфликт** (строки 1194-1336): вся наша ACP message routing логика (`session.backendType === "acp"` ветка + Claude Code switch-case) vs upstream, который делегирует всё через `backendAdapter`.
**Тип**: Архитектурный — upstream унифицировал, мы добавляли третий бэкенд по старой схеме.
**Рекомендация**: Принять upstream структуру. Переписать AcpAdapter как IBackendAdapter. Вся наша ACP-специфичная логика маршрутизации сообщений должна быть внутри AcpAdapter, а не в ws-bridge.

### 3. `web/server/cli-launcher.ts` (2 конфликта)
**Суть**: Наши callback-поля (`onCodexAdapter`, `onAcpAdapter`, `exitHandlers`) и методы регистрации (`onCodexAdapterCreated`, `onAcpAdapterCreated`, `onSessionExited`) — upstream убрал всё это, используя event-bus.
**Тип**: Архитектурный — наши callbacks vs их event-bus.
**Рекомендация**: Принять upstream. Вместо callbacks использовать `companionBus.emit()` для ACP-событий.

### 4. `web/server/index.ts` (1 большой конфликт, ~100 строк)
**Суть**: У нас вся lifecycle-логика (relaunch, idle-kill, auto-naming, PR watching, exit handling) прописана inline. Upstream заменил это одной строкой: `orchestrator.initialize()`.
**Тип**: Архитектурный — inline wiring vs orchestrator.
**Рекомендация**: Принять upstream `orchestrator.initialize()`. Добавить ACP-специфичную логику в orchestrator (или через event-bus listeners).

### 5. `web/server/routes.ts` (4 конфликта)
**Суть**:
- Session creation (2 конфликта): наша inline-логика с ACP-валидацией (`backend.startsWith("acp:")`) vs upstream `orchestrator.createSession()` / `orchestrator.createSessionStreaming()`.
- Streaming endpoint: та же проблема — наш inline код vs orchestrator delegation.
- Конец файла: наш `/mcp-servers` эндпоинт + `cleanupWorktree` helper vs upstream `registerMetricsRoutes`.
**Тип**: Смешанный — архитектурный (orchestrator) + наш новый функционал (MCP servers, worktree cleanup).
**Рекомендация**: Принять upstream orchestrator для session creation. Наш ACP-валидацию перенести в `SessionCreationService`. MCP-servers и worktree cleanup endpoints сохранить, добавить рядом с `registerMetricsRoutes`.

### 6. `web/src/components/HomePage.tsx` (1 конфликт)
**Суть**: Наш backend dropdown selector (ACP-агенты в списке) + `SessionCreationProgress` vs upstream который убрал/переделал layout (#570 homepage redesign).
**Тип**: UI — оба меняли HomePage: мы добавили backend switcher, они переделали дизайн.
**Рекомендация**: Принять upstream layout, заново интегрировать наш backend dropdown и SessionCreationProgress в новый дизайн.

### 7. `web/src/components/AgentsPage.tsx` (1 большой конфликт)
**Суть**: Наш `McpServerFormEntry`, `AgentFormData` интерфейсы и вся страница конфигурации ACP-агентов vs upstream пустой/минимальный вариант.
**Тип**: Наш новый код — upstream не трогал эту логику.
**Рекомендация**: Принять наш код (ours). Upstream изменил только импорт/обертку, наша форма конфигурации ACP-агентов должна остаться.

### 8. `web/src/components/TaskPanel.tsx` (2 конфликта)
**Суть**:
- Наш `AcpUsageSection` компонент (tokens, context для ACP) vs upstream пропустил.
- `UsageLimitsRenderer`: наш `backendType` с поддержкой ACP vs upstream `isCodex` boolean + `useSdkSession` hook.
**Тип**: Смешанный — #576 task-panel redesign + наш ACP usage panel.
**Рекомендация**: Принять upstream redesign, перенести `AcpUsageSection` в новую структуру. Использовать `useSdkSession` hook.

### 9. `web/src/components/McpPanel.tsx` (1 конфликт)
**Суть**: Наш `isReadOnly` check (ACP/Codex серверы read-only) vs upstream стандартный empty state с `text-cc-primary`.
**Тип**: Наш новый функционал.
**Рекомендация**: Принять ours, но обновить CSS-класс на `text-cc-primary` (upstream design token).

### 10. `web/server/routes.test.ts` (2 конфликта)
**Суть**: Наши тесты с полным `CompanionSettings` mock (включая `acpBinaryPaths`) vs upstream `orchestrator.archiveSession` mock.
**Тип**: Архитектурный — тесты следуют за рефакторингом.
**Рекомендация**: Переписать тесты под orchestrator API. Добавить `acpBinaryPaths` в settings type.

### 11. `web/server/linear-agent.test.ts` (1 конфликт)
**Суть**: Наш `makeSettings()` с полным CompanionSettings (включая `acpBinaryPaths`) vs upstream `LinearOAuthCredentials` отдельный тип.
**Тип**: Архитектурный — Linear credentials вынесены в отдельный интерфейс.
**Рекомендация**: Принять upstream `LinearOAuthCredentials`. Добавить `acpBinaryPaths` в CompanionSettings type отдельно.

### 12. `web/server/ws-bridge-codex.test.ts` (1 конфликт)
**Суть**: Mock Session с `cliSocket/codexAdapter/acpAdapter: null` vs `backendAdapter: null`.
**Тип**: Архитектурный.
**Рекомендация**: Принять upstream `backendAdapter: null`.

---

## Пересечения upstream PR с нашей работой

### #576 Task Panel Redesign — ВЫСОКОЕ пересечение
- Upstream переделал TaskPanel с collapsible sections и design tokens.
- Наш `AcpUsageSection` и `UsageLimitsRenderer` конфликтуют.
- Нужно: перенести ACP usage в новую структуру TaskPanel.

### #570 Homepage Redesign — ВЫСОКОЕ пересечение
- Upstream переделал HomePage в ChatGPT/Cursor стиле.
- Наш backend dropdown и session creation progress конфликтуют.
- Нужно: заново интегрировать backend switcher в новый дизайн.

### #580 WS-Bridge Fix — СРЕДНЕЕ пересечение
- Fix: prevent CLI session_id from overwriting Companion ID.
- Пересекается с нашей ws-bridge логикой, но конкретно этот fix auto-merged.

### #584 Codex Reconnection — СРЕДНЕЕ пересечение
- Improve reconnection reliability.
- Upstream добавил `companionBus` events вместо callback chains.
- Наша ACP reconnect логика должна использовать тот же паттерн.

### #568 Folder-Picker Redesign — НИЗКОЕ пересечение
- Чисто UI-компонент, не пересекается с ACP.

---

## Стратегия merge

### Рекомендуемый порядок:

1. **Сначала** — принять upstream архитектуру (IBackendAdapter, orchestrator, event-bus).
2. **Затем** — реализовать `AcpAdapter` как `IBackendAdapter` (вместо отдельного класса с отдельной маршрутизацией в ws-bridge).
3. **Затем** — перенести ACP session creation логику в `SessionCreationService`.
4. **Затем** — перенести ACP lifecycle callbacks на `CompanionEventBus`.
5. **В конце** — обновить UI (HomePage backend dropdown, TaskPanel ACP usage, McpPanel read-only).

### Оценка трудоёмкости: ВЫСОКАЯ
Это не простой merge. Upstream по сути сделал тот же рефакторинг (унификация бэкендов через интерфейс), который облегчает добавление ACP, но требует переписать наш AcpAdapter под новый интерфейс `IBackendAdapter`. Позитивный момент: после merge наш код станет чище и расширяемее.
