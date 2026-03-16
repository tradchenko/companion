# Поддержка ACP-агентов в The Companion

**Дата**: 2026-03-12
**Статус**: Проектирование
**Репозиторий**: https://github.com/tradchenko/companion (форк The-Vibe-Company/companion)

---

## Цель

Добавить поддержку Gemini CLI, Qwen Code и других ACP-совместимых агентов в The Companion через универсальный ACP-адаптер. Заменить кнопочный переключатель бэкендов на выпадающий список с auto-detect.

---

## Текущая архитектура

### Бэкенд (server/)

- **BackendType** = `"claude" | "codex"` (`session-types.ts:312`)
- **Claude Code**: WebSocket (`--sdk-url ws://localhost:3456/ws/cli/{sessionId}`)
- **Codex**: JSON-RPC 2.0 через stdio → `CodexAdapter` (2521 строк) → `BrowserIncomingMessage`
- **Паттерн**: Transport (`ICodexTransport`) → Adapter (`CodexAdapter`) → WsBridge → Browser

### Ключевые файлы

| Файл | Назначение | Строк |
|------|-----------|-------|
| `server/session-types.ts` | Типы BackendType, BrowserMessage, SessionState | 440 |
| `server/codex-adapter.ts` | Codex JSON-RPC → BrowserMessage трансляция | 2521 |
| `server/ws-bridge.ts` | WebSocket мост браузер ↔ CLI/адаптер | ~2000 |
| `server/ws-bridge-codex.ts` | Codex-специфичные обработчики bridge | 247 |
| `server/cli-launcher.ts` | Спавн CLI/Codex процессов, lifecycle | 1236 |
| `server/routes.ts` | REST API: GET /api/backends, POST /api/sessions/create | ~2000 |

### Фронтенд (src/)

- **React 19 + Vite + Zustand + TailwindCSS**
- **HomePage.tsx** — UI выбора бэкенда (кнопки Claude | Codex)
- **backends.ts** — конфигурация моделей/режимов по бэкенду
- **api.ts** — REST клиент, `BackendInfo` интерфейс
- **Персистентность**: `localStorage.getItem("cc-backend")`

### ICodexTransport (интерфейс транспорта)

```typescript
interface ICodexTransport {
  call(method: string, params?, timeoutMs?): Promise<unknown>
  notify(method: string, params?): Promise<void>
  respond(id: number, result: unknown): Promise<void>
  onNotification(handler: (method: string, params) => void): void
  onRequest(handler: (method: string, id: number, params) => void): void
  onRawIncoming(cb: (line: string) => void): void
  onRawOutgoing(cb: (data: string) => void): void
  isConnected(): boolean
}
```

### CodexAdapter (публичный API)

```typescript
class CodexAdapter {
  onBrowserMessage(cb): void           // адаптер → браузер
  onSessionMeta(cb): void              // threadId, model, cwd
  onDisconnect(cb): void               // очистка
  onInitError(cb): void                // ошибка инициализации
  sendBrowserMessage(msg): boolean     // браузер → адаптер
  getThreadId(): string | null         // для resume
  resetForReconnect(transport): void   // переподключение
}
```

### Маршрутизация исходящих сообщений

```
dispatchOutgoing(msg: BrowserOutgoingMessage)
  ├─ "user_message"        → turn/start
  ├─ "permission_response" → respond(id, result)
  ├─ "interrupt"           → turn/interrupt
  ├─ "set_permission_mode" → настройки
  ├─ "mcp_get_status"      → MCP статус
  ├─ "mcp_toggle"          → вкл/выкл MCP
  ├─ "mcp_reconnect"       → переподключение MCP
  └─ "mcp_set_servers"     → настройка MCP серверов
```

---

## ACP протокол (Agent Client Protocol)

**Стандарт**: JSON-RPC 2.0 через stdio (NDJSON)
**Спецификация**: https://agentclientprotocol.com/protocol/overview

### Основные методы

| Метод | Тип | Назначение |
|-------|-----|-----------|
| `session/initialize` | request | Хендшейк, обмен capabilities |
| `session/new` | request | Создание сессии |
| `session/prompt` | request | Отправка промпта (text + resource) |
| `session/update` | notification | Стриминг ответа (chunks, tool_calls, thoughts) |
| `session/request_permission` | request | Запрос одобрения действий |
| `resource/read` | request | Чтение файла |
| `resource/write` | request | Запись файла |

### session/prompt формат

```json
{
  "method": "session/prompt",
  "params": {
    "sessionId": "session_12345",
    "content": [
      {"type": "text", "text": "Refactor this function"},
      {"type": "resource", "uri": "file:///src/main.ts", "mimeType": "text/typescript"}
    ]
  }
}
```

### session/update типы обновлений

- `agent_message_chunk` — текст ответа AI
- `agent_thought_chunk` — reasoning
- `tool_call` — вызов инструмента
- `tool_call_update` — статус выполнения инструмента
- `plan` — план выполнения

### ACP-совместимые агенты

| Агент | Разработчик | Флаг ACP | Статус |
|-------|-------------|----------|--------|
| Gemini CLI | Google | `--experimental-acp` | Experimental |
| Qwen Code | Alibaba | `--acp` | Стабильный |
| Goose | Block | `--acp` | Стабильный |
| GitHub Copilot CLI | GitHub | ACP public preview | Preview |
| OpenCode | open-source | ACP native | Стабильный |
| Kilo Code CLI | Kilo AI | ACP | Стабильный |

---

## Установленные агенты на системе

| Агент | Версия | Путь | Метод установки |
|-------|--------|------|-----------------|
| Claude Code | 2.1.74 | `~/.local/bin/claude` | curl install.sh |
| Gemini CLI | 0.33.0 | `/opt/homebrew/bin/gemini` | Homebrew |
| Qwen Code | 0.12.0 | `/opt/homebrew/bin/qwen` | Homebrew |
| Codex CLI | 0.114.0 | `~/bin/codex` | Custom |

---

## Принятые решения

### 1. UI: Выпадающий список с auto-detect

- Заменить кнопки (Claude | Codex) на dropdown/select
- Показывать только найденных в системе агентов
- Недоступные агенты видны, но disabled (чтобы пользователь знал что можно доустановить)
- Endpoint `GET /api/backends` расширяется новыми агентами

### 2. Модели: Захардкоженные дефолты + кастомный ввод

- Для каждого агента задать известные модели по умолчанию
- Добавить поле для ввода произвольного имени модели
- ACP не гарантирует метод получения списка моделей

### 3. Архитектура: Registry-паттерн

- Один универсальный `AcpAdapter` для всех ACP-агентов
- JSON-реестр агентов (`acp-agents.json`) с описанием: бинарник, флаги, модели, особенности
- Добавление нового агента = добавление записи в JSON без кода
- Точечные хуки для quirks отдельных агентов при необходимости

### 4. Обнаружение бинарников: Auto-detect + ручной override

- Поиск в PATH + проверка типичных директорий (npm global, brew, pip, cargo, ~/.local/bin)
- Пользователь может указать кастомный путь к бинарнику в настройках companion
- Кроссплатформенность: macOS, Linux, Windows

---

## Способы установки агентов (для auto-detect)

### Типичные пути по ОС

**macOS:**
- Homebrew: `/opt/homebrew/bin/`, `/usr/local/bin/`
- npm global: `~/.npm-global/bin/`, `/usr/local/bin/`
- bun global: `~/.bun/bin/`
- pip/pipx: `~/.local/bin/`
- cargo: `~/.cargo/bin/`
- curl install: `~/.local/bin/`

**Linux:**
- apt/snap: `/usr/bin/`, `/snap/bin/`
- npm global: `/usr/local/bin/`, `~/.npm-global/bin/`
- pip/pipx: `~/.local/bin/`
- cargo: `~/.cargo/bin/`

**Windows:**
- npm global: `%APPDATA%\npm\`
- pip: `%LOCALAPPDATA%\Programs\Python\...\Scripts\`
- scoop: `%USERPROFILE%\scoop\shims\`
- winget: `%LOCALAPPDATA%\Microsoft\WinGet\...`

### Бинарники и установка по агентам

| Агент | Binary | npm | brew | pip | curl |
|-------|--------|-----|------|-----|------|
| Claude Code | `claude` | — | — | — | `curl -fsSL https://claude.ai/install.sh` |
| Gemini CLI | `gemini` | `@google/gemini-cli` | `gemini-cli` | — | — |
| Qwen Code | `qwen` | — | `qwen-code` | — | curl install.sh |
| Codex | `codex` | `@openai/codex` | cask | — | — |
| Goose | `goose` | — | — | — | curl install.sh |
| Copilot CLI | `copilot` | `@github/copilot` | — | — | — |
| Aider | `aider` | — | — | `aider-chat` | — |
| Amp | `amp` | `@sourcegraph/amp` | — | — | curl install.sh |

---

## Архитектура решения (план)

### Новые файлы

| Файл | Назначение |
|------|-----------|
| `server/acp-adapter.ts` | Универсальный ACP адаптер (JSON-RPC 2.0 stdio → BrowserMessage) |
| `server/acp-agents.json` | Реестр ACP-агентов (бинарники, флаги, модели, пути) |
| `server/acp-binary-resolver.ts` | Auto-detect бинарников по ОС + кастомные пути |
| `server/ws-bridge-acp.ts` | ACP-специфичные обработчики bridge |

### Изменяемые файлы

| Файл | Изменения |
|------|-----------|
| `server/session-types.ts` | `BackendType = "claude" \| "codex" \| "acp"` |
| `server/cli-launcher.ts` | `spawnAcp()` метод, чтение реестра |
| `server/ws-bridge.ts` | `attachAcpAdapter()`, маршрутизация |
| `server/routes.ts` | Расширить GET /api/backends, GET /api/backends/:id/models |
| `src/components/HomePage.tsx` | Dropdown вместо кнопок |
| `src/utils/backends.ts` | Динамические модели/режимы из API |
| `src/api.ts` | Расширить BackendInfo типы |

### Формат acp-agents.json

```json
{
  "gemini": {
    "name": "Gemini CLI",
    "binary": "gemini",
    "acpFlags": ["--experimental-acp"],
    "defaultModels": [
      {"id": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
      {"id": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"}
    ],
    "defaultModes": [
      {"value": "bypassPermissions", "label": "Auto"},
      {"value": "plan", "label": "Plan"}
    ],
    "searchPaths": {
      "darwin": ["/opt/homebrew/bin", "/usr/local/bin"],
      "linux": ["/usr/bin", "/usr/local/bin", "/snap/bin"],
      "win32": []
    },
    "customModelInput": true
  },
  "qwen": {
    "name": "Qwen Code",
    "binary": "qwen",
    "acpFlags": ["--acp"],
    "defaultModels": [
      {"id": "qwen3-coder", "label": "Qwen 3 Coder"},
      {"id": "qwen-max", "label": "Qwen Max"}
    ],
    "defaultModes": [
      {"value": "bypassPermissions", "label": "Auto"},
      {"value": "plan", "label": "Plan"}
    ],
    "searchPaths": {
      "darwin": ["/opt/homebrew/bin", "/usr/local/bin"],
      "linux": ["/usr/bin", "/usr/local/bin"],
      "win32": []
    },
    "customModelInput": true
  },
  "goose": {
    "name": "Goose",
    "binary": "goose",
    "acpFlags": ["--acp"],
    "defaultModels": [
      {"id": "default", "label": "Default"}
    ],
    "defaultModes": [
      {"value": "bypassPermissions", "label": "Auto"}
    ],
    "searchPaths": {
      "darwin": ["~/.local/bin"],
      "linux": ["~/.local/bin"],
      "win32": []
    },
    "customModelInput": true
  }
}
```

### Data Flow

```
Браузер → dropdown выбирает "Gemini CLI"
  → POST /api/sessions/create { backend: "acp", acpAgent: "gemini", model: "gemini-2.5-pro" }
  → CliLauncher.spawnAcp("gemini", sessionId, options)
    → читает acp-agents.json → binary="gemini", flags=["--experimental-acp"]
    → AcpBinaryResolver.resolve("gemini") → /opt/homebrew/bin/gemini
    → spawn("gemini", ["--experimental-acp", ...])
    → new AcpAdapter(stdioTransport, sessionId, options)
    → WsBridge.attachAcpAdapter(sessionId, adapter)
  → adapter.initialize() → session/initialize → session/new
  → браузер отправляет промпт → adapter.sendBrowserMessage()
    → session/prompt → session/update (стриминг) → BrowserIncomingMessage → браузер
```

---

## Существующий патч: Codex Homebrew fix

### Проблема
Companion при запуске Codex ищет "sibling Node.js" (`siblingNode`) рядом с бинарником и пытается запустить Codex через него. Но Homebrew/Cask Codex — нативный бинарник, и эта логика ломает запуск.

### Текущее решение (вне форка)
- **`~/bin/apply-companion-codex-fix`** — bash-скрипт, патчит `cli-launcher.ts`:
  - Убирает блок `if (existsSync(siblingNode))` с `realpathSync` логикой
  - Заменяет на прямой вызов бинарника
  - Создаёт timestamped backup перед патчем
  - Целевые файлы: bun global install и homebrew install
- **`~/bin/codex`** — обёртка, запускает последнюю версию из `/opt/homebrew/Caskroom/codex/`
- **`~/.zshrc` алиас**: `companion-update-safe='bun add -g the-companion@latest && apply-companion-codex-fix && companion restart'`

### Как включить в форк
Этот фикс нужно **встроить прямо в код форка** в `cli-launcher.ts`, чтобы:
1. Патч больше не нужно было применять отдельно
2. При rebase с upstream — если upstream починит проблему, наш фикс просто уйдёт при разрешении конфликта
3. Алиас `companion-update-safe` можно будет упростить до обычного обновления из форка

---

## Стратегия обновлений (fork + rebase)

- **Upstream remote**: `The-Vibe-Company/companion`
- **Feature branch**: `feature/acp-multi-agent-support`
- **При обновлении**: `git fetch upstream && git rebase upstream/main`
- **Минимизация конфликтов**: новые файлы (acp-adapter, acp-agents.json) не пересекаются с upstream; изменения в существующих файлах точечные
- **Установка из форка**: `bun install -g github:tradchenko/companion`
