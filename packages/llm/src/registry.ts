import type { ChatModel, ModelContextCapability } from "@coding-agent/contracts";

/** Transient input passed from a provider bootstrap to one protocol adapter. */
export interface ModelProtocolModelConfig {
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly contextCapability?: ModelContextCapability;
  /** Protocol-owned output cap; adapters apply their documented default when absent. */
  readonly maxOutputTokens?: number;
  /** Optional protocol API version used by adapters with versioned wire contracts. */
  readonly apiVersion?: string;
  /** Maximum interval without response bytes before the adapter aborts the request. */
  readonly idleTimeoutMs?: number;
  /** Injectable for protocol contract tests; production adapters use platform Fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

/** A wire-protocol adapter. It has no EventStore, API Host, or credential storage dependency. */
export interface ModelProtocolAdapter {
  readonly protocol: string;
  createModel(config: ModelProtocolModelConfig): ChatModel;
}

export interface ModelProtocolRegistration {
  readonly protocol: string;
  /** Releases this exact registration without removing a later replacement. */
  dispose(): void;
}

export class ModelProtocolRegistryError extends Error {
  readonly code: "MODEL_PROTOCOL_INVALID" | "MODEL_PROTOCOL_DUPLICATE" | "MODEL_PROTOCOL_UNAVAILABLE";

  constructor(code: ModelProtocolRegistryError["code"], message: string) {
    super(message);
    this.name = "ModelProtocolRegistryError";
    this.code = code;
  }
}

/**
 * Small provider-neutral protocol registry. Registration is fail-fast and
 * disposal is identity-safe; profile persistence and hot replacement belong to
 * later routing slices.
 */
export class ModelProtocolRegistry {
  private readonly adapters = new Map<string, ModelProtocolAdapter>();

  register(adapter: ModelProtocolAdapter): ModelProtocolRegistration {
    const protocol = requireProtocol(adapter.protocol);
    if (adapter.protocol !== protocol) {
      throw new ModelProtocolRegistryError("MODEL_PROTOCOL_INVALID", `Protocol must be canonical: ${adapter.protocol}`);
    }
    if (this.adapters.has(protocol)) {
      throw new ModelProtocolRegistryError("MODEL_PROTOCOL_DUPLICATE", `Protocol is already registered: ${protocol}`);
    }
    this.adapters.set(protocol, adapter);
    let disposed = false;
    return {
      protocol,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.adapters.get(protocol) === adapter) this.adapters.delete(protocol);
      },
    };
  }

  get(protocol: string): ModelProtocolAdapter {
    const normalized = requireProtocol(protocol);
    const adapter = this.adapters.get(normalized);
    if (adapter === undefined) {
      throw new ModelProtocolRegistryError("MODEL_PROTOCOL_UNAVAILABLE", `Protocol is not registered: ${normalized}`);
    }
    return adapter;
  }

  create(protocol: string, config: ModelProtocolModelConfig): ChatModel {
    return this.get(protocol).createModel(config);
  }

  protocols(): readonly string[] {
    return [...this.adapters.keys()];
  }
}

function requireProtocol(value: string): string {
  const protocol = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(protocol)) {
    throw new ModelProtocolRegistryError("MODEL_PROTOCOL_INVALID", "Protocol must be a lowercase identifier");
  }
  return protocol;
}
