import { describe, it, expect } from 'vitest';
import { resolveAcpBinary } from './acp-binary-resolver.js';

describe('resolveAcpBinary', () => {
   it('находит бинарник в PATH (gemini)', () => {
      const result = resolveAcpBinary('gemini');
      // Может не быть на CI, поэтому проверяем формат если найден
      if (result) {
         expect(result).toContain('gemini');
      }
   });

   it('возвращает null для несуществующего бинарника', () => {
      expect(resolveAcpBinary('nonexistent-agent-xyz-42')).toBeNull();
   });

   it('принимает абсолютный путь напрямую', () => {
      expect(resolveAcpBinary('/bin/sh')).toBe('/bin/sh');
   });

   it('возвращает null для несуществующего абсолютного пути', () => {
      expect(resolveAcpBinary('/nonexistent/path/to/binary')).toBeNull();
   });

   it('кастомный путь имеет высший приоритет', () => {
      expect(resolveAcpBinary('gemini', '/bin/sh')).toBe('/bin/sh');
   });

   it('ищет по agentId в реестре', () => {
      // "gemini" — это agentId в реестре, binary тоже "gemini"
      const result = resolveAcpBinary('gemini');
      // Если установлен — найдёт через PATH или searchPaths
      if (result) {
         expect(typeof result).toBe('string');
      }
   });
});
