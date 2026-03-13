/**
 * Companion-native slash-команды.
 *
 * Перехватываются на стороне браузера и выполняются локально,
 * вместо отправки агенту через session/prompt.
 */
import { sendToSession } from '../ws.js';
import { useStore } from '../store.js';
import type { BackendType } from '../../server/session-types.js';

// ── Типы ─────────────────────────────────────────────────────────────────────

export interface NativeCommand {
   /** Имя без "/" */
   name: string;
   /** Описание для UI */
   description: string;
   /** Для каких бэкендов доступна (undefined = для всех) */
   backends?: BackendType[];
   /** Обработчик. Возвращает текст для вставки в чат как системное сообщение, или null */
   execute: (ctx: NativeCommandContext) => string | null;
}

export interface NativeCommandContext {
   sessionId: string;
   /** Аргументы после команды (напр. "/model gpt-4" → "gpt-4") */
   args: string;
}

// ── Хелпер: вставить системное сообщение в чат ──────────────────────────────

let sysIdCounter = 0;

function appendSystemMessage(sessionId: string, text: string): void {
   useStore.getState().appendMessage(sessionId, {
      id: `native-cmd-${Date.now()}-${++sysIdCounter}`,
      role: 'assistant',
      content: text,
      timestamp: Date.now(),
   });
}

// ── Реестр команд ────────────────────────────────────────────────────────────

export const NATIVE_COMMANDS: NativeCommand[] = [
   {
      name: 'tools',
      description: 'List available tools for this session',
      execute: ({ sessionId }) => {
         const session = useStore.getState().sessions.get(sessionId);
         const tools = session?.tools ?? [];
         const mcpServers = session?.mcp_servers ?? [];

         const lines: string[] = [];

         if (tools.length > 0) {
            lines.push(`**Available tools (${tools.length}):**`);
            for (const t of tools) lines.push(`• ${t}`);
         }

         if (mcpServers.length > 0) {
            if (lines.length > 0) lines.push('');
            lines.push(`**MCP Servers (${mcpServers.length}):**`);
            for (const s of mcpServers) {
               const icon = s.status === 'connected' ? '🟢' : s.status === 'failed' ? '🔴' : '🟡';
               lines.push(`${icon} ${s.name} — ${s.status}`);
            }
         }

         if (lines.length === 0) return 'No tools available.';

         appendSystemMessage(sessionId, lines.join('\n'));
         return null;
      },
   },
   {
      name: 'stats',
      description: 'Show session statistics',
      execute: ({ sessionId }) => {
         const session = useStore.getState().sessions.get(sessionId);
         if (!session) return 'Session not found.';

         const lines: string[] = ['**Session Stats:**'];
         lines.push(`• Model: ${session.model}`);
         lines.push(`• Turns: ${session.num_turns}`);
         lines.push(`• Context: ${session.context_used_percent}%`);

         if (session.total_cost_usd > 0) {
            lines.push(`• Cost: $${session.total_cost_usd.toFixed(4)}`);
         }

         // ACP токены
         const acp = session.acp_token_details;
         if (acp && (acp.inputTokens > 0 || acp.outputTokens > 0)) {
            lines.push(`• Input tokens: ${acp.inputTokens.toLocaleString()}`);
            lines.push(`• Output tokens: ${acp.outputTokens.toLocaleString()}`);
            if (acp.thoughtTokens > 0) lines.push(`• Reasoning tokens: ${acp.thoughtTokens.toLocaleString()}`);
         }

         // Codex токены
         const codex = session.codex_token_details;
         if (codex) {
            lines.push(`• Input tokens: ${codex.inputTokens.toLocaleString()}`);
            lines.push(`• Output tokens: ${codex.outputTokens.toLocaleString()}`);
            if (codex.reasoningOutputTokens > 0) lines.push(`• Reasoning tokens: ${codex.reasoningOutputTokens.toLocaleString()}`);
         }

         if (session.total_lines_added > 0 || session.total_lines_removed > 0) {
            lines.push(`• Lines: +${session.total_lines_added} / -${session.total_lines_removed}`);
         }

         appendSystemMessage(sessionId, lines.join('\n'));
         return null;
      },
   },
   {
      name: 'model',
      description: 'Show or switch the current model',
      execute: ({ sessionId, args }) => {
         const session = useStore.getState().sessions.get(sessionId);
         if (!args.trim()) {
            // Без аргументов — показать текущую модель и доступные
            const lines = [`**Current model:** ${session?.model ?? 'unknown'}`];
            const available = session?.availableModels;
            if (available?.length) {
               lines.push('**Available models:**');
               for (const m of available) {
                  const marker = m.value === session?.model ? ' ← current' : '';
                  lines.push(`• ${m.label}${marker}`);
               }
            }
            appendSystemMessage(sessionId, lines.join('\n'));
            return null;
         }
         // С аргументом — переключить модель
         sendToSession(sessionId, { type: 'set_model', model: args.trim() });
         appendSystemMessage(sessionId, `Switching model to **${args.trim()}**...`);
         return null;
      },
   },
   {
      name: 'mode',
      description: 'Show or switch permission mode',
      execute: ({ sessionId, args }) => {
         const session = useStore.getState().sessions.get(sessionId);
         if (!args.trim()) {
            const modes = session?.availableModes;
            const lines = [`**Current mode:** ${session?.permissionMode ?? 'unknown'}`];
            if (modes?.length) {
               lines.push('**Available modes:**');
               for (const m of modes) {
                  const marker = m.value === session?.permissionMode ? ' ← current' : '';
                  lines.push(`• ${m.value} — ${m.label}${marker}`);
               }
            }
            appendSystemMessage(sessionId, lines.join('\n'));
            return null;
         }
         sendToSession(sessionId, { type: 'set_permission_mode', mode: args.trim() });
         appendSystemMessage(sessionId, `Switching mode to **${args.trim()}**...`);
         return null;
      },
   },
   {
      name: 'mcp',
      description: 'Show MCP servers status',
      execute: ({ sessionId }) => {
         const session = useStore.getState().sessions.get(sessionId);
         const servers = session?.mcp_servers ?? [];
         if (servers.length === 0) {
            appendSystemMessage(sessionId, 'No MCP servers configured.');
            return null;
         }
         const lines = [`**MCP Servers (${servers.length}):**`];
         for (const s of servers) {
            const icon = s.status === 'connected' ? '🟢' : s.status === 'failed' ? '🔴' : '🟡';
            lines.push(`${icon} ${s.name} — ${s.status}`);
         }
         appendSystemMessage(sessionId, lines.join('\n'));
         return null;
      },
   },
   {
      name: 'context',
      description: 'Show context window usage',
      execute: ({ sessionId }) => {
         const session = useStore.getState().sessions.get(sessionId);
         if (!session) return 'Session not found.';

         const pct = session.context_used_percent ?? 0;
         const acp = session.acp_token_details;
         const codex = session.codex_token_details;

         const lines = [`**Context usage:** ${pct}%`];

         if (acp?.modelContextWindow) {
            const used = acp.inputTokens + acp.outputTokens;
            lines.push(`• ${used.toLocaleString()} / ${acp.modelContextWindow.toLocaleString()} tokens`);
         } else if (codex?.modelContextWindow) {
            const used = codex.inputTokens + codex.outputTokens;
            lines.push(`• ${used.toLocaleString()} / ${codex.modelContextWindow.toLocaleString()} tokens`);
         }

         // Визуальная полоса
         const barLen = 20;
         const filled = Math.round((pct / 100) * barLen);
         const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
         lines.push(`\`[${bar}]\``);

         appendSystemMessage(sessionId, lines.join('\n'));
         return null;
      },
   },
   {
      name: 'cost',
      description: 'Show session cost',
      backends: ['claude'],
      execute: ({ sessionId }) => {
         const session = useStore.getState().sessions.get(sessionId);
         if (!session) return 'Session not found.';
         appendSystemMessage(sessionId, `**Session cost:** $${(session.total_cost_usd ?? 0).toFixed(4)}`);
         return null;
      },
   },
   {
      name: 'help',
      description: 'Show available commands',
      execute: ({ sessionId }) => {
         const session = useStore.getState().sessions.get(sessionId);
         const backendType = session?.backend_type;

         // Собираем native-команды для этого бэкенда
         const nativeCmds = NATIVE_COMMANDS.filter(
            (c) => !c.backends || (backendType && c.backends.includes(backendType)),
         );

         const lines = ['**Companion commands:**'];
         for (const c of nativeCmds) {
            lines.push(`• \`/${c.name}\` — ${c.description}`);
         }

         // Команды агента
         const agentCmds = session?.slash_commands ?? [];
         if (agentCmds.length > 0) {
            lines.push('', '**Agent commands:**');
            for (const cmd of agentCmds) {
               lines.push(`• \`/${cmd}\``);
            }
         }

         appendSystemMessage(sessionId, lines.join('\n'));
         return null;
      },
   },
];

// ── Быстрый lookup ──────────────────────────────────────────────────────────

const nativeCommandMap = new Map<string, NativeCommand>();
for (const cmd of NATIVE_COMMANDS) {
   nativeCommandMap.set(cmd.name, cmd);
}

/**
 * Проверяет, является ли сообщение native-командой.
 * Если да — выполняет и возвращает true.
 * Если нет — возвращает false (вызывающий код должен отправить агенту).
 */
export function tryExecuteNativeCommand(sessionId: string, message: string): boolean {
   const match = message.match(/^\/(\S+)(?:\s+(.*))?$/);
   if (!match) return false;

   const [, cmdName, rawArgs] = match;
   const cmd = nativeCommandMap.get(cmdName.toLowerCase());
   if (!cmd) return false;

   // Проверяем бэкенд
   const session = useStore.getState().sessions.get(sessionId);
   if (cmd.backends && session?.backend_type && !cmd.backends.includes(session.backend_type)) {
      return false; // Команда не для этого бэкенда — пусть агент обработает
   }

   const result = cmd.execute({ sessionId, args: (rawArgs ?? '').trim() });
   if (result) {
      appendSystemMessage(sessionId, result);
   }
   return true;
}

/**
 * Возвращает CommandItem[] для native-команд, подходящих текущему бэкенду.
 */
export function getNativeCommandItems(backendType?: BackendType): { name: string; type: 'native'; description: string }[] {
   return NATIVE_COMMANDS.filter((c) => !c.backends || (backendType && c.backends.includes(backendType))).map((c) => ({
      name: c.name,
      type: 'native' as const,
      description: c.description,
   }));
}
