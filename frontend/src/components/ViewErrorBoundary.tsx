import { Component, type ReactNode } from "react";
import { sanitizeErrorForProductionLog } from "../lib/syncErrorUtils";

type Props = {
  children: ReactNode;
  fallback?: ReactNode;
};

type State = {
  hasError: boolean;
  errorInfo: Record<string, unknown> | null;
};

export class ViewErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorInfo: sanitizeErrorForProductionLog(error),
    };
  }

  componentDidCatch(error: Error) {
    console.error("[Opaque] View error boundary caught:", sanitizeErrorForProductionLog(error));
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="max-w-lg mx-auto my-8 rounded-xl border border-red-800/50 bg-red-950/40 p-6 text-center">
          <p className="text-sm font-medium text-red-300">Something went wrong</p>
          <p className="mt-2 text-xs text-red-400/80">
            This section failed to render. Try refreshing the page.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ hasError: false, errorInfo: null })}
            className="mt-4 rounded-lg bg-red-900/50 px-4 py-2 text-xs font-medium text-red-200 hover:bg-red-800/50 transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
