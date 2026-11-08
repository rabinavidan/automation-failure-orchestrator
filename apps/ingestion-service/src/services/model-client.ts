import { Ollama } from 'ollama';
import { config } from '../config';

/**
 * The one place a chat-model client is built: the CI and SOC agents and the offline evaluation
 * tools (benchmark, failure-mode sampler, version comparison) all call this, so host, model and
 * the per-request timeout (OLLAMA_TIMEOUT_MS) come from the same validated configuration.
 */
export function createOllamaClient(): { client: Ollama; model: string } {
  const { OLLAMA_HOST: host, OLLAMA_MODEL: model, OLLAMA_TIMEOUT_MS: timeoutMs } = config();
  const client = new Ollama({
    host,
    fetch: (input, init) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      return fetch(input, { ...init, signal });
    },
  });
  return { client, model };
}
