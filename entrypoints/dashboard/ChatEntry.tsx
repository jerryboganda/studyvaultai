import { Suspense, lazy } from 'react';
import { MessagesSquare, Settings } from 'lucide-react';
import { browser } from 'wxt/browser';
import { BuddyEmptyState, useSettings } from '@ui';
import { settingsPath } from '@ui/shell/paths';
import { Loading, ViewHead } from './moreKit';
import type { ChatViewProps } from './ChatView';

// The chat (and with it the AI engine and its screens) is only fetched once AI is on and this view is
// opened: with AI off, or in any other view, none of it is loaded.
const ChatView = lazy(() => import('./ChatView').then((m) => ({ default: m.ChatView })));

/** The chat view's gate: explains the opt-in when AI is off, otherwise loads the chat. */
export function ChatEntry(props: ChatViewProps) {
  const { settings } = useSettings();
  if (settings === null) return <Loading>Reading your settings…</Loading>;
  if (!settings.features.ai) {
    return (
      <section className="dash-panel mv-view" aria-labelledby="chat-off-h" data-testid="chat-off">
        <ViewHead
          icon={MessagesSquare}
          tone="violet"
          title="Chat with your notes"
          titleId="chat-off-h"
          off
          info="Chat sends the passages you pick to the AI provider you set up. It stays off until you turn AI on in Settings."
          infoLabel="About chat"
        />
        <BuddyEmptyState
          pose="think"
          title="AI features are off"
          text="Nothing is sent anywhere while AI is off."
          action={{
            label: 'Open the AI settings',
            icon: Settings,
            onClick: () =>
              void browser.tabs.create({
                url: browser.runtime.getURL(`/${settingsPath('ai')}` as never),
              }),
          }}
        />
      </section>
    );
  }
  return (
    <Suspense fallback={<Loading>Loading the chat…</Loading>}>
      <ChatView {...props} />
    </Suspense>
  );
}
