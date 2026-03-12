import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolveBinary } from './path-resolver.js';
import { getAcpAgent } from './acp-registry.js';

// Резолвит бинарник ACP-агента: PATH → searchPaths → кастомный путь
export function resolveAcpBinary(binaryOrAgentId: string, customPath?: string): string | null {
   // 1. Кастомный путь — высший приоритет
   if (customPath && existsSync(customPath)) return customPath;

   // 2. Абсолютный путь
   if (binaryOrAgentId.startsWith('/')) {
      return existsSync(binaryOrAgentId) ? binaryOrAgentId : null;
   }

   // 3. resolveBinary (PATH + enriched paths)
   const fromPath = resolveBinary(binaryOrAgentId);
   if (fromPath) return fromPath;

   // 4. Поиск в searchPaths из реестра
   const agent = getAcpAgent(binaryOrAgentId);
   if (agent) {
      const platform = process.platform as string;
      const paths = agent.searchPaths[platform] ?? [];
      for (const searchDir of paths) {
         const expanded = searchDir.replace('~', homedir());
         const candidate = join(expanded, agent.binary);
         if (existsSync(candidate)) return candidate;
      }
   }

   return null;
}
