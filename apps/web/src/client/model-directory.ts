import type { ModelSelection, ProviderCatalogGroup, SessionId } from "@coding-agent/contracts";
import type { WebApiClient, SessionModelsResponse } from "./api.js";

export type ModelDirectoryStatus = "idle" | "loading" | "ready" | "selecting" | "error";

/** One Session's shared model catalog and current route snapshot. */
export interface ModelDirectoryState {
  readonly sessionId: SessionId | null;
  /** Host-selected route for the next turn, including an inherited route. */
  readonly current: ModelSelection | null;
  /** True when `current` came from the host/tenant default rather than a Session event. */
  readonly inherited: boolean;
  /** Host-backed routability signal when the API provides one; null means unknown. */
  readonly routable: boolean | null;
  /** Provider-grouped advisory catalog. */
  readonly groups: readonly ProviderCatalogGroup[];
  readonly status: ModelDirectoryStatus;
  readonly error: string | null;
}

export type ModelDirectoryListener = (state: ModelDirectoryState) => void;
export type ModelDirectoryApi = Pick<WebApiClient, "listSessionModels" | "selectSessionModel">;

/**
 * Session-scoped model directory shared by every Web selection surface.
 *
 * The directory owns no credentials and does not decide whether a provider is
 * routable. It only mirrors Host responses, serializes the latest operation and
 * prevents an older request from overwriting a newer Session selection.
 */
export class ModelDirectory {
  private state: ModelDirectoryState = {
    sessionId: null,
    current: null,
    inherited: false,
    routable: null,
    groups: [],
    status: "idle",
    error: null,
  };
  private generation = 0;
  private readonly listeners = new Set<ModelDirectoryListener>();

  constructor(private readonly api: ModelDirectoryApi, sessionId?: SessionId) {
    if (sessionId !== undefined) this.setSession(sessionId);
  }

  getSnapshot(): ModelDirectoryState {
    return this.state;
  }

  subscribe(listener: ModelDirectoryListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setSession(sessionId: SessionId | null): void {
    if (this.state.sessionId === sessionId) return;
    this.generation += 1;
    this.state = {
      sessionId,
      current: null,
      inherited: false,
      routable: null,
      groups: [],
      status: "idle",
      error: null,
    };
    this.publish();
  }

  async load(): Promise<ModelDirectoryState> {
    const sessionId = this.state.sessionId;
    if (sessionId === null) throw new Error("model directory requires an active session");
    const generation = ++this.generation;
    this.update({ status: "loading", error: null });
    try {
      const response = await this.api.listSessionModels(sessionId);
      if (generation !== this.generation || this.state.sessionId !== sessionId) return this.state;
      this.applyCatalogResponse(response);
      return this.state;
    } catch (error) {
      if (generation !== this.generation || this.state.sessionId !== sessionId) return this.state;
      this.update({ status: "error", error: messageOf(error) });
      throw error;
    }
  }

  async select(selection: ModelSelection, commandId?: string): Promise<ModelSelection> {
    const sessionId = this.state.sessionId;
    if (sessionId === null) throw new Error("model directory requires an active session");
    const generation = ++this.generation;
    this.update({ status: "selecting", error: null });
    try {
      const response = await this.api.selectSessionModel(sessionId, selection, commandId);
      if (generation !== this.generation || this.state.sessionId !== sessionId) return this.state.current ?? response.selection;
      this.update({
        current: response.selection,
        inherited: false,
        routable: true,
        status: "ready",
        error: null,
      });
      return response.selection;
    } catch (error) {
      if (generation !== this.generation || this.state.sessionId !== sessionId) return this.state.current ?? selection;
      this.update({ status: "error", error: messageOf(error) });
      throw error;
    }
  }

  clear(): void {
    this.generation += 1;
    this.state = {
      ...this.state,
      current: null,
      inherited: false,
      routable: null,
      groups: [],
      status: "idle",
      error: null,
    };
    this.publish();
  }

  dispose(): void {
    this.generation += 1;
    this.listeners.clear();
  }

  private applyCatalogResponse(response: SessionModelsResponse): void {
    const current = response.selection ?? response.effective ?? null;
    this.update({
      current,
      inherited: response.selection === null && response.effective !== undefined,
      // Older API responses do not expose routability; keep it explicitly
      // unknown instead of inferring it from advisory catalog membership.
      routable: null,
      groups: response.providers,
      status: "ready",
      error: null,
    });
  }

  private update(partial: Partial<ModelDirectoryState>): void {
    this.state = { ...this.state, ...partial };
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

