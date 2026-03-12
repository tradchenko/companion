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

export function getAllAcpAgents(): AcpAgentDefinition[] {
   return registry;
}

export function getAcpAgent(id: string): AcpAgentDefinition | null {
   return registry.find((a) => a.id === id) ?? null;
}
