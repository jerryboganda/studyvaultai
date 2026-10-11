import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './Button';
import { logError } from './log';
import { InlineNotice } from './Notice';
import { errorMessage } from './text';

interface Props {
  /** What crashed, in words a person would use: "popup", "side panel", "settings page". */
  surface: string;
  children: ReactNode;
}

interface State {
  failed: boolean;
  message: string;
}

/** A render that throws must leave a recoverable message, never a blank extension page. */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, message: '' };

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, message: errorMessage(error, 'An unexpected error occurred.') };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo) {
    logError(`the ${this.props.surface} stopped on a render error`, error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="sv-crash">
        <InlineNotice
          tone="error"
          title={`StudyVault could not show the ${this.props.surface}`}
          action={
            <div className="sv-row">
              <Button variant="primary" onClick={() => this.setState({ failed: false })}>
                Try again
              </Button>
              <Button onClick={() => window.location.reload()}>Reload</Button>
            </div>
          }
        >
          <p>{this.state.message}</p>
          <p>Your saved highlights and notes are not affected by this error.</p>
        </InlineNotice>
      </div>
    );
  }
}
