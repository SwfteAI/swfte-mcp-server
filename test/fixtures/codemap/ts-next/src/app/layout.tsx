import type { ReactNode } from 'react';
import { ChatWidget } from '@swfte/chat-widget/react';
import { SearchPalette } from '@/components/SearchPalette';

const SUPPORT_AGENT = 'ag_Supp9x';

export const metadata = { title: 'Acme Content Studio' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <SearchPalette />
        <ChatWidget agentId={SUPPORT_AGENT} position="bottom-left" />
      </body>
    </html>
  );
}
