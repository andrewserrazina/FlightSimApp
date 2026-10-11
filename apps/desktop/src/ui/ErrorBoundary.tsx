import { Component, type ReactNode } from "react";
import { Button } from "./Button";
import { EmptyState } from "./EmptyState";

interface State {
  error: Error | null;
}

/** Contains a rendering failure to one page so navigation and the connection keep working. */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`[${this.props.label}] render failure`, error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState tone="alert" title={`${this.props.label} could not be displayed`} action={<Button onClick={() => this.setState({ error: null })}>Try again</Button>}>
        <p>{this.state.error.message}</p>
        <p>Other pages and the simulator connection are unaffected.</p>
      </EmptyState>
    );
  }
}
