/**
 * Чтение MCP-серверов из конфигов Claude и конвертация в ACP-формат.
 *
 * Поддерживаемые источники:
 * - ~/.claude/settings.json  (ключ mcpServers)
 * - ~/.claude.json            (альтернативный файл)
 * - ~/.companion/settings.json (собственные настройки Companion)
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// ─── Типы ACP MCP-сервера ───────────────────────────────────────────────────

export interface AcpMcpServer {
   transport: 'stdio' | 'sse' | 'http';
   name: string;
   command?: string;
   args?: string[];
   env?: Array<{ name: string; value: string }>;
   url?: string;
   headers?: Array<{ name: string; value: string }>;
}

// ─── Публичный API ──────────────────────────────────────────────────────────

/** Читает MCP-серверы из всех известных конфигов и возвращает в ACP-формате */
export function readMcpServersForAcp(): AcpMcpServer[] {
   const servers: AcpMcpServer[] = [];
   const seen = new Set<string>();

   const configPaths = [
      join(homedir(), '.claude', 'settings.json'),
      join(homedir(), '.claude.json'),
      join(homedir(), '.companion', 'settings.json'),
   ];

   for (const configPath of configPaths) {
      const configs = readMcpConfigFile(configPath);
      for (const [name, config] of Object.entries(configs)) {
         // Дедупликация по имени — первый найденный побеждает
         if (seen.has(name)) continue;
         seen.add(name);
         servers.push(convertToAcpFormat(name, config));
      }
   }

   return servers;
}

// ─── Внутренние функции ─────────────────────────────────────────────────────

/** Читает секцию mcpServers из JSON-файла */
export function readMcpConfigFile(path: string): Record<string, any> {
   if (!existsSync(path)) return {};
   try {
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      return data.mcpServers || data.mcp_servers || {};
   } catch {
      return {};
   }
}

/** Конвертирует один MCP-сервер из формата Claude в формат ACP */
export function convertToAcpFormat(name: string, config: any): AcpMcpServer {
   // Определяем транспорт: Claude использует "type", ACP — "transport"
   const rawTransport: string = config.type || config.transport || 'stdio';
   const transport = rawTransport === 'sse' ? 'sse' : rawTransport === 'http' ? 'http' : 'stdio';

   const server: AcpMcpServer = {
      transport: transport as 'stdio' | 'sse' | 'http',
      name,
   };

   if (server.transport === 'stdio') {
      server.command = config.command;
      server.args = config.args || [];
      // Claude хранит env как Record<string, string>, ACP ожидает массив {name, value}
      if (config.env && typeof config.env === 'object') {
         server.env = Object.entries(config.env).map(([k, v]) => ({
            name: k,
            value: String(v),
         }));
      }
   } else {
      // http / sse транспорт
      server.url = config.url;
      if (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) {
         // Конвертируем Record<string, string> в массив {name, value}
         server.headers = Object.entries(config.headers).map(([k, v]) => ({
            name: k,
            value: String(v),
         }));
      } else if (Array.isArray(config.headers)) {
         server.headers = config.headers;
      }
   }

   return server;
}
