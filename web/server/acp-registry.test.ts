import { describe, it, expect } from 'vitest';
import { getAcpAgent, getAllAcpAgents } from './acp-registry.js';

describe('ACP Registry', () => {
   it('загружает реестр агентов', () => {
      const agents = getAllAcpAgents();
      expect(agents.length).toBeGreaterThan(0);
   });

   it('находит gemini по id', () => {
      const agent = getAcpAgent('gemini');
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe('gemini');
      expect(agent!.acpFlags).toContain('--experimental-acp');
   });

   it('находит qwen по id', () => {
      const agent = getAcpAgent('qwen');
      expect(agent).toBeDefined();
      expect(agent!.binary).toBe('qwen');
      expect(agent!.acpFlags).toContain('--acp');
   });

   it('возвращает null для несуществующего агента', () => {
      expect(getAcpAgent('nonexistent')).toBeNull();
   });

   it('каждый агент имеет обязательные поля', () => {
      for (const agent of getAllAcpAgents()) {
         expect(agent.id).toBeTruthy();
         expect(agent.name).toBeTruthy();
         expect(agent.binary).toBeTruthy();
         expect(agent.acpFlags).toBeInstanceOf(Array);
         expect(agent.defaultModels.length).toBeGreaterThan(0);
      }
   });
});
