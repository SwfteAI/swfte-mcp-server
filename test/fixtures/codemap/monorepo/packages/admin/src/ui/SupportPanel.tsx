import { EmbeddedChat as SupportChat } from '@swfte/chat-widget/react';

/** Side panel in the admin console: editors ask the support agent about a customer's ticket. */
export function SupportPanel({ height }: { height: string }) {
  return <SupportChat agentId="ag_Supp9x" height={height} />;
}
