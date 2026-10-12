import { Suspense, lazy } from 'react';
import { browser } from 'wxt/browser';
import { Button, EmptyState, useSettings } from '@ui';
import { settingsPath } from '@ui/shell/paths';
import type { ChatViewProps } from './ChatView';

// The chat (and with it the AI engine and its screens) is only fetched once AI is on and this view is
// opened: with AI off, or in any other view, none of it is loaded.
const ChatView = lazy(() => import('./ChatView').then((m) => ({ default: m.ChatView })));

/** The chat view's gate: explains the opt-in when AI is off, otherwise loads the chat. */
export function ChatEntry(props: ChatViewProps) {
  const { settings } = useSettings();
  if (settings === null) return <p className="sv-muted">Reading your settings…</p>;
  if (!settings.features.ai) {
    return (
      <EmptyState
        title="AI features are off"
        action={
          <Button
            onClick={() =>
              void browser.tabs.create({
                url: browser.runtime.getURL(`/${settingsPath('ai')}` as never),
              })
            }
          >
            Open the AI settings
          </Button>
        }
      >
        Chat sends your question and the passages you choose to the AI provider you set up. While AI
        is off nothing is sent anywhere and everything else works as before.
      </EmptyState>
    );
  }
  return (
    <Suspense fallback={<p className="sv-muted">Loading the chat…</p>}>
      <ChatView {...props} />
    </Suspense>
  );
}
