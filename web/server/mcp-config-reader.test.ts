import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AcpMcpServer } from './mcp-config-reader.js';

// Мокаем fs и os ДО импорта тестируемого модуля
vi.mock('fs', () => ({
   existsSync: vi.fn(() => false),
   readFileSync: vi.fn(() => '{}'),
}));

vi.mock('os', () => ({
   homedir: vi.fn(() => '/mock-home'),
}));

// Импортируем после моков
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { convertToAcpFormat, readMcpConfigFile, readMcpServersForAcp } from './mcp-config-reader.js';

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockHomedir = vi.mocked(homedir);

// ─── convertToAcpFormat ─────────────────────────────────────────────────────

describe('convertToAcpFormat', () => {
   it('конвертирует stdio-сервер с командой и аргументами', () => {
      const result = convertToAcpFormat('my-server', {
         command: 'npx',
         args: ['-y', '@my/server'],
         env: { API_KEY: 'secret', PORT: '3000' },
      });

      expect(result).toEqual<AcpMcpServer>({
         transport: 'stdio',
         name: 'my-server',
         command: 'npx',
         args: ['-y', '@my/server'],
         env: [
            { name: 'API_KEY', value: 'secret' },
            { name: 'PORT', value: '3000' },
         ],
      });
   });

   it('конвертирует stdio-сервер без env', () => {
      const result = convertToAcpFormat('simple', {
         command: '/usr/bin/server',
      });

      expect(result).toEqual<AcpMcpServer>({
         transport: 'stdio',
         name: 'simple',
         command: '/usr/bin/server',
         args: [],
      });
   });

   it('конвертирует http-сервер с url', () => {
      const result = convertToAcpFormat('remote', {
         type: 'http',
         url: 'http://localhost:8080/mcp',
      });

      expect(result).toEqual<AcpMcpServer>({
         transport: 'http',
         name: 'remote',
         url: 'http://localhost:8080/mcp',
      });
   });

   it('конвертирует sse-сервер с заголовками (Record формат)', () => {
      const result = convertToAcpFormat('sse-server', {
         type: 'sse',
         url: 'http://example.com/sse',
         headers: { Authorization: 'Bearer token123' },
      });

      expect(result).toEqual<AcpMcpServer>({
         transport: 'sse',
         name: 'sse-server',
         url: 'http://example.com/sse',
         headers: [{ name: 'Authorization', value: 'Bearer token123' }],
      });
   });

   it('конвертирует sse-сервер с заголовками (массив формат)', () => {
      const headers = [{ name: 'X-Custom', value: 'val' }];
      const result = convertToAcpFormat('sse2', {
         type: 'sse',
         url: 'http://example.com/sse',
         headers,
      });

      expect(result.headers).toEqual(headers);
   });

   it('использует transport поле если type отсутствует', () => {
      const result = convertToAcpFormat('t', { transport: 'http', url: 'http://x' });
      expect(result.transport).toBe('http');
   });

   it('по умолчанию использует stdio если transport/type не указаны', () => {
      const result = convertToAcpFormat('default', { command: 'cmd' });
      expect(result.transport).toBe('stdio');
   });

   it('конвертирует числовые значения env в строки', () => {
      const result = convertToAcpFormat('num-env', {
         command: 'cmd',
         env: { PORT: 3000, DEBUG: true },
      });

      expect(result.env).toEqual([
         { name: 'PORT', value: '3000' },
         { name: 'DEBUG', value: 'true' },
      ]);
   });
});

// ─── readMcpConfigFile ──────────────────────────────────────────────────────

describe('readMcpConfigFile', () => {
   beforeEach(() => {
      vi.clearAllMocks();
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReturnValue('{}');
   });

   it('возвращает пустой объект если файл не существует', () => {
      mockExistsSync.mockReturnValue(false);
      expect(readMcpConfigFile('/nonexistent')).toEqual({});
   });

   it('читает mcpServers из JSON-файла', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
         JSON.stringify({
            mcpServers: {
               'my-server': { command: 'npx', args: ['-y', 'pkg'] },
            },
         }),
      );

      const result = readMcpConfigFile('/some/path.json');
      expect(result).toEqual({
         'my-server': { command: 'npx', args: ['-y', 'pkg'] },
      });
   });

   it('поддерживает альтернативный ключ mcp_servers', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
         JSON.stringify({
            mcp_servers: {
               alt: { command: 'alt-cmd' },
            },
         }),
      );

      const result = readMcpConfigFile('/some/path.json');
      expect(result).toEqual({ alt: { command: 'alt-cmd' } });
   });

   it('возвращает пустой объект при невалидном JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('not json!!!');
      expect(readMcpConfigFile('/bad.json')).toEqual({});
   });

   it('возвращает пустой объект если нет ключа mcpServers', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify({ other: 'stuff' }));
      expect(readMcpConfigFile('/no-mcp.json')).toEqual({});
   });
});

// ─── readMcpServersForAcp ───────────────────────────────────────────────────

describe('readMcpServersForAcp', () => {
   beforeEach(() => {
      vi.clearAllMocks();
      mockHomedir.mockReturnValue('/mock-home');
      mockExistsSync.mockReturnValue(false);
      mockReadFileSync.mockReturnValue('{}');
   });

   it('объединяет серверы из нескольких конфигов', () => {
      mockExistsSync.mockImplementation((path) => {
         return path === '/mock-home/.claude/settings.json' || path === '/mock-home/.claude.json';
      });

      mockReadFileSync.mockImplementation((path) => {
         if (path === '/mock-home/.claude/settings.json') {
            return JSON.stringify({
               mcpServers: {
                  server1: { command: 'cmd1' },
               },
            });
         }
         if (path === '/mock-home/.claude.json') {
            return JSON.stringify({
               mcpServers: {
                  server2: { type: 'http', url: 'http://x' },
               },
            });
         }
         return '{}';
      });

      const servers = readMcpServersForAcp();
      expect(servers).toHaveLength(2);
      expect(servers[0].name).toBe('server1');
      expect(servers[1].name).toBe('server2');
   });

   it('дедуплицирует серверы по имени — первый найденный побеждает', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation((path) => {
         if (String(path).includes('.claude/settings.json')) {
            return JSON.stringify({
               mcpServers: { dup: { command: 'first' } },
            });
         }
         if (String(path).includes('.claude.json')) {
            return JSON.stringify({
               mcpServers: { dup: { command: 'second' } },
            });
         }
         return '{}';
      });

      const servers = readMcpServersForAcp();
      // Только один сервер с именем "dup", и это первый (command: 'first')
      const dups = servers.filter((s) => s.name === 'dup');
      expect(dups).toHaveLength(1);
      expect(dups[0].command).toBe('first');
   });

   it('возвращает пустой массив если конфигов нет', () => {
      mockExistsSync.mockReturnValue(false);
      const servers = readMcpServersForAcp();
      expect(servers).toEqual([]);
   });
});
