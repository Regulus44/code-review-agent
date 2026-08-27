export class AnthropicMessagesError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly providerCode?: string;

  constructor(code: string, message: string, options: { readonly status?: number; readonly providerCode?: string } = {}) {
    super(message);
    this.name = "AnthropicMessagesError";
    this.code = code;
    if (options.status !== undefined) this.status = options.status;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
  }
}

export function anthropicHttpError(status: number, providerCode?: string, detail?: string): AnthropicMessagesError {
  const code = status === 401 || status === 403
    ? "ANTHROPIC_AUTHENTICATION_FAILED"
    : status === 413
      ? "ANTHROPIC_CONTEXT_TOO_LARGE"
      : status === 429
        ? "ANTHROPIC_RATE_LIMITED"
        : status === 529
          ? "ANTHROPIC_OVERLOADED"
          : "ANTHROPIC_HTTP_ERROR";
  const boundedDetail = detail === undefined || detail.length === 0 ? "" : `: ${detail.slice(0, 300)}`;
  return new AnthropicMessagesError(code, `Anthropic Messages request failed with HTTP ${status}${boundedDetail}`, {
    status,
    ...(providerCode === undefined ? {} : { providerCode }),
  });
}
