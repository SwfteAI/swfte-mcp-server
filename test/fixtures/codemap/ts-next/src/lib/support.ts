import { chatSupportAgent } from '@/swfte/support-agent';

/** Answer one question for the FAQ generator (no conversation kept). */
export async function answer(question: string): Promise<string> {
  const tag = '__CANARY_body__';
  const { output } = await chatSupportAgent({ message: `[${tag.length}] ${question}` });
  return output?.content ?? '';
}
