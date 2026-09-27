'use client';

import { ChatWidget } from '@swfte/chat-widget/react';

/** White-label chat for tenant portals: each deployment sets its own public agent id at build time. */
export function TenantChat() {
  return <ChatWidget agentId={process.env.NEXT_PUBLIC_SWFTE_AGENT_ID ?? ''} theme="auto" />;
}
