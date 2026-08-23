export type ShellBootState =
  | { readonly status: "booting" }
  | { readonly status: "ready" }
  | { readonly status: "failed"; readonly error: string; readonly retryable: boolean };

export type ShellBootAction =
  | { readonly type: "booting" }
  | { readonly type: "ready" }
  | { readonly type: "failed"; readonly error: unknown; readonly retryable?: boolean };

export interface ShellBootRenderIntent {
  readonly status: ShellBootState["status"];
  readonly appBusy: boolean;
  readonly title: string;
  readonly message: string;
  readonly mark: string;
  readonly retryable: boolean;
}

export function createShellBootState(): ShellBootState {
  return { status: "booting" };
}

export function reduceShellBoot(state: ShellBootState, action: ShellBootAction): ShellBootState {
  switch (action.type) {
    case "booting":
      return { status: "booting" };
    case "ready":
      return { status: "ready" };
    case "failed":
      return {
        status: "failed",
        error: normalizeBootError(action.error),
        retryable: action.retryable !== false,
      };
  }
}

export function presentShellBoot(state: ShellBootState, maxMessageChars = 240): ShellBootRenderIntent {
  if (state.status === "booting") {
    return {
      status: state.status,
      appBusy: true,
      title: "Loading workspace",
      message: "Connecting to the Coding Agent host…",
      mark: "…",
      retryable: false,
    };
  }
  if (state.status === "ready") {
    return {
      status: state.status,
      appBusy: false,
      title: "",
      message: "",
      mark: "",
      retryable: false,
    };
  }
  return {
    status: state.status,
    appBusy: false,
    title: "Unable to connect",
    message: bounded(state.error, maxMessageChars),
    mark: "!",
    retryable: state.retryable,
  };
}

export function normalizeBootError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The Coding Agent host did not respond.";
}

function bounded(value: string, maxChars: number): string {
  const limit = Math.max(32, Math.floor(maxChars));
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
