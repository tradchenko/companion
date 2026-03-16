# Анализ интеграции бэкенд-адаптеров (upstream/main)

## Файлы исследованы

Полное содержимое каждого файла сохранено при извлечении из `upstream/main`:

| Файл | Сохранен в |
|---|---|
| `web/server/ws-bridge.ts` (~900 строк) | `tool-results/b9bnbd0pg.txt` |
| `web/server/codex-adapter.ts` (~3024 строки) | `tool-results/b9li6oti7.txt` |
| `web/server/ws-bridge-codex.ts` (~250 строк) | Получен полностью в Bash output |
| `web/server/cli-launcher.ts` (~800 строк) | `tool-results/b90h0p552.txt` |
| `web/server/index.ts` (~350 строк) | Получен полностью в Bash output |
| `web/server/routes.ts` (~900 строк) | `tool-results/bnxfo1rpi.txt` |

Все файлы находятся в: `/Users/tradchenko/.claude/projects/-Users-tradchenko/62e46370-13bd-435c-a064-9d6209194512/tool-results/`

---

## Архитектура интеграции бэкенд-адаптеров

### 1. Интерфейс IBackendAdapter (`backend-adapter.ts`)

Все адаптеры реализуют интерфейс `IBackendAdapter`:
- `send(msg: BrowserOutgoingMessage): boolean` — отправка сообщения в бэкенд
- `onBrowserMessage(cb)` — колбэк для сообщений ОТ бэкенда К браузеру
- `onSessionMeta(cb)` — метаданные сессии (cliSessionId, model, cwd)
- `onDisconnect(cb)` — колбэк отключения
- `onInitError(cb)` — ошибка инициализации
- `isConnected(): boolean`
- `disconnect(): Promise<void>`

### 2. WsBridge (`ws-bridge.ts`) — главный хаб

**Класс `WsBridge`** управляет сессиями и маршрутизацией сообщений:

- **sessions**: `Map<string, Session>` — все активные сессии
- **Сессия содержит**: `browserSockets`, `cliSockets`, `backendAdapter`, `messageHistory`, `pendingPermissions`, `pendingMessages`, `state`, `stateMachine`

**Ключевые методы:**
- `handleCLIOpen(ws, sessionId)` — CLI (Claude Code) подключается по WebSocket
- `handleCLIMessage(ws, msg)` — NDJSON сообщения от Claude Code CLI
- `handleBrowserOpen(ws, sessionId)` — браузер подключается
- `handleBrowserMessage(ws, msg)` — сообщения от браузера
- `attachBackendAdapter(sessionId, adapter)` — **УНИФИЦИРОВАННАЯ** точка подключения адаптера

**Метод `attachBackendAdapter()`** — единый pipeline для ВСЕХ бэкендов:
1. Устанавливает `session.backendAdapter = adapter`
2. Подписывается на `adapter.onBrowserMessage()` — обрабатывает все типы входящих сообщений:
   - `session_init` / `session_update` — обновление состояния
   - `status_change` — compacting и т.д.
   - `assistant` — добавление в историю + broadcast
   - `result` — завершение хода + auto-naming
   - `permission_request` — AI validation + broadcast
   - `permission_cancelled` — очистка pending
3. Подписывается на `adapter.onSessionMeta()` — обновляет метаданные
4. Подписывается на `adapter.onDisconnect()` — очистка + auto-relaunch
5. Сбрасывает очередь `pendingMessages`
6. Отправляет `cli_connected` в браузеры

**Маршрутизация browser -> backend:**
- `routeBrowserMessage()` вызывает `session.backendAdapter.send(msg)` для типов:
  - `user_message`, `permission_response`, `interrupt`
  - `set_model`, `set_permission_mode`
  - `mcp_get_status`, `mcp_toggle`, `mcp_reconnect`, `mcp_set_servers`
- Если адаптер недоступен, сообщение ставится в `session.pendingMessages`

**Маршрутизация CLI (Claude Code NDJSON) -> browser:**
- `routeCLIMessage()` парсит NDJSON строки от Claude Code CLI
- Использует `ClaudeAdapter` (отдельный адаптер для Claude Code)

### 3. CodexAdapter (`codex-adapter.ts`) — адаптер для Codex

**Транспорт:** `ICodexTransport` — абстракция над JSON-RPC
- `StdioTransport` — через stdin/stdout процесса (legacy)
- `WebSocketTransport` — через WebSocket к Codex app-server (основной)

**Инициализация (initialize()):**
1. `transport.call("initialize", { clientInfo, capabilities })`
2. `transport.notify("initialized", {})`
3. `transport.call("thread/start" | "thread/resume", { model, cwd, approvalPolicy, sandbox })`
4. Эмит `session_init` с полным `SessionState`
5. Сброс очереди `pendingOutgoing`

**Протокол JSON-RPC:**
- **Notifications (от Codex):** `item/started`, `item/completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `turn/started`, `turn/completed`, `thread/tokenUsage/updated`, и др.
- **Requests (от Codex, требуют ответа):** `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/mcpToolCall/requestApproval`, `item/tool/call`, `item/tool/requestUserInput`
- **Calls (от Companion к Codex):** `turn/start`, `turn/interrupt`, `mcpServerStatus/list`, `config/read`, `config/value/write`, `config/mcpServer/reload`

**Трансляция Codex -> BrowserIncomingMessage:**
- `item/started(agentMessage)` -> `stream_event(message_start)` + `stream_event(content_block_start)`
- `item/agentMessage/delta` -> `stream_event(content_block_delta)`
- `item/completed(agentMessage)` -> `stream_event(content_block_stop)` + `assistant`
- `item/started(commandExecution)` -> `assistant(tool_use:Bash)`
- `item/completed(commandExecution)` -> `assistant(tool_result)`
- `item/started(fileChange)` -> `assistant(tool_use:Edit|Write)`
- `item/completed(fileChange)` -> `assistant(tool_result)`
- `item/started(mcpToolCall)` -> `assistant(tool_use:mcp:server:tool)`
- `turn/completed` -> `result`
- `requestApproval` -> `permission_request`

### 4. ws-bridge-codex.ts — DEPRECATED

Файл помечен как `@deprecated`. Раньше содержал отдельную логику подключения Codex адаптера (`attachCodexAdapterHandlers`), но теперь вся логика перенесена в единый `attachBackendAdapter()` в `ws-bridge.ts`. Файл оставлен только для покрытия тестами.

### 5. CliLauncher (`cli-launcher.ts`)

**Запуск бэкендов:**
- `launch(sessionId, options)` — запуск нового процесса CLI
- Определяет тип бэкенда: `claude` или `codex`
- Для Claude Code: `Bun.spawn(["claude", ...args])`, подключение через NDJSON WebSocket
- Для Codex:
  - Если WS transport: запускает `codex --app-server-port=PORT`, создает `WebSocketTransport`, создает `CodexAdapter(transport)`
  - Если stdio: `Bun.spawn(["codex", "--app-server"])`, создает `CodexAdapter(proc)`
- После запуска вызывает `wsBridge.attachBackendAdapter(sessionId, adapter)`

**WebSocket транспорт для Codex:**
- Companion запускает Codex с `--app-server-port=PORT`
- Затем создает WebSocket proxy к `ws://127.0.0.1:PORT`
- Proxy обрабатывает переподключения (companion/wsReconnected)

### 6. server/index.ts — точка входа

**Инициализация:**
```
sessionStore = new SessionStore()
wsBridge = new WsBridge()
launcher = new CliLauncher(port)
orchestrator = new SessionOrchestrator({ launcher, wsBridge, sessionStore, ... })
```

**WebSocket endpoints:**
- `/ws/cli/:sessionId` — Claude Code CLI подключается сюда (NDJSON)
- `/ws/browser/:sessionId` — браузер подключается сюда
- `/ws/terminal/:sessionId` — встроенный терминал
- `/ws/novnc/:sessionId` — noVNC proxy

**Маршрутизация WS событий:**
- `open` -> `wsBridge.handleCLIOpen()` / `wsBridge.handleBrowserOpen()`
- `message` -> `wsBridge.handleCLIMessage()` / `wsBridge.handleBrowserMessage()`
- `close` -> `wsBridge.handleCLIClose()` / `wsBridge.handleBrowserClose()`

### 7. routes.ts — HTTP API

**Ключевые эндпоинты для сессий:**
- `POST /sessions` — создание сессии через `orchestrator.createSession()`
- `POST /sessions/:id/relaunch` — перезапуск
- `GET /sessions` — список сессий
- `DELETE /sessions/:id` — удаление
- `POST /sessions/:id/send` — отправка сообщения через HTTP (альтернатива WS)

---

## Схема потока данных

```
Browser <--WS--> WsBridge <---> BackendAdapter (IBackendAdapter)
                    |                    |
                    |            +-------+-------+
                    |            |               |
                    |      ClaudeAdapter    CodexAdapter
                    |         (NDJSON)      (JSON-RPC)
                    |            |               |
                    |      Claude Code CLI   Codex app-server
                    |            |               |
                    +-- CLI WS --+      StdioTransport / WebSocketTransport
```

## Ключевые выводы для миграции

1. **Единый pipeline** — `attachBackendAdapter()` в `ws-bridge.ts` обрабатывает ВСЕ бэкенды одинаково через `IBackendAdapter` интерфейс
2. **Адаптер отвечает за трансляцию** — CodexAdapter транслирует JSON-RPC в BrowserIncomingMessage/BrowserOutgoingMessage
3. **ws-bridge-codex.ts deprecated** — вся Codex-специфичная логика теперь внутри CodexAdapter + единый pipeline WsBridge
4. **Транспорт абстрагирован** — `ICodexTransport` позволяет менять stdio/websocket без изменения адаптера
5. **CliLauncher** — единая точка запуска процессов, знает как запускать и Claude Code, и Codex
6. **SessionOrchestrator** — координирует lifecycle (создание, relaunch, удаление)
