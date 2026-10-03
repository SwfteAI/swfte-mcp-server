import { EmbeddedChat } from '@swfte/chat-widget/react';
import { HelpBubble } from '@/components/HelpBubble';

export default function DocsPage() {
  return (
    <div className="docs-layout">
      <article>
        <h1>Getting started</h1>
        <p>Ask the docs assistant anything about setup, billing or the API.</p>
      </article>
      <aside>
        <EmbeddedChat
          agentId="ag_Docs2W"
          height="560px"
          welcomeMessage="Hi! I know the docs inside out."
        />
      </aside>
      <HelpBubble theme="light" />
    </div>
  );
}
