import { swfte } from '@/lib/swfte';

/** Start the onboarding chatflow for a new workspace member. */
export async function startOnboarding(): Promise<string> {
  const session = await swfte.chatflows.startSession('cf_Onb7Rz');
  return session.id;
}

/** How many onboarding sessions are still open (admin badge). */
export async function openOnboardingSessions(): Promise<number> {
  const sessions = await swfte.chatflows.listSessions('cf_Onb7Rz', { status: 'ACTIVE', size: 100 });
  return sessions.length;
}

/** Resume whichever chatflow the caller names (support flows, onboarding, surveys). */
export async function resumeFlow(chatflowId: string): Promise<string> {
  const session = await swfte.chatflows.startSession(chatflowId);
  return session.status;
}
