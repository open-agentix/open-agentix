/**
 * `gen_ai.provider.name` from the adapter kind or family (ADR 0015 section 3.4). The value is
 * chosen from a closed table: the instance (connection) name, a base URL or any other tenant input
 * never reaches it, so it is safe as a metric label later. An unknown family falls back to the
 * adapter kind, which is itself a closed set.
 */
const BY_FAMILY: Readonly<Record<string, string>> = {
  anthropic: 'anthropic',
  bedrock: 'aws.bedrock',
  'azure-openai': 'azure.ai.openai',
  openai: 'openai',
  openrouter: 'openrouter',
  ollama: 'ollama',
  lmstudio: 'lmstudio',
  vllm: 'vllm',
  simulated: 'simulated',
};

export function genAiProviderName(kind: string, family?: string): string {
  if (family !== undefined && Object.hasOwn(BY_FAMILY, family)) return BY_FAMILY[family]!;
  return Object.hasOwn(BY_FAMILY, kind) ? BY_FAMILY[kind]! : 'other';
}
