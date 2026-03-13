import acpAgentsData from './acp-agents.json';

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

/** Кеш моделей, полученных из session/new (перезаписывает defaultModels) */
const modelCache = new Map<string, Array<{ value: string; label: string }>>();

export function getAllAcpAgents(): AcpAgentDefinition[] {
   return registry;
}

export function getAcpAgent(id: string): AcpAgentDefinition | null {
   return registry.find((a) => a.id === id) ?? null;
}

/** Обновить кеш моделей для агента (вызывается из acp-adapter после session/new) */
export function cacheAcpAgentModels(agentId: string, models: Array<{ value: string; label: string }>): void {
   if (models.length > 0) {
      modelCache.set(agentId, models);
   }
}

/** Получить модели агента: кеш (из session/new) → defaultModels */
export function getAcpAgentModels(agentId: string): Array<{ value: string; label: string }> {
   const cached = modelCache.get(agentId);
   if (cached) return cached;
   const agent = getAcpAgent(agentId);
   return agent?.defaultModels ?? [];
}
