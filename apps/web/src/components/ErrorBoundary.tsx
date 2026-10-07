import { Component, type ReactNode } from 'react';
import { text } from '../i18n/catalog';

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main className="fatal-error">
          <h1>{text.unexpectedError}</h1>
          <button className="button primary" onClick={() => location.reload()}>
            {text.reloadApp}
          </button>
        </main>
      );
    return this.props.children;
  }
}
