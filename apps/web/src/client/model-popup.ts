import type { ModelSelection } from "@coding-agent/contracts";
import type { ModelDirectory, ModelDirectoryState } from "./model-directory.js";

export interface ModelPopupOption {
  readonly id: string;
  readonly provider: string;
  readonly providerName: string;
  readonly model: string;
  readonly label: string;
  readonly detail: string;
  readonly selection: ModelSelection;
  readonly active: boolean;
  readonly disabled: boolean;
}

export interface ModelPopupState {
  readonly open: boolean;
  readonly query: string;
  readonly options: readonly ModelPopupOption[];
  readonly visibleOptions: readonly ModelPopupOption[];
  readonly activeId: string | null;
  readonly status: "idle" | "loading" | "ready" | "selecting" | "error";
  readonly error: string | null;
}

export type ModelPopupDirectory = Pick<ModelDirectory, "getSnapshot" | "subscribe" | "load" | "select">;
export type ModelPopupListener = (state: ModelPopupState) => void;

/** Searchable `/model` popup controller over the shared Session directory. */
export class ModelPopupController {
  private state: ModelPopupState = {
    open: false,
    query: "",
    options: [],
    visibleOptions: [],
    activeId: null,
    status: "idle",
    error: null,
  };
  private readonly listeners = new Set<ModelPopupListener>();
  private readonly unsubscribeDirectory: () => void;

  constructor(private readonly directory: ModelPopupDirectory) {
    this.unsubscribeDirectory = directory.subscribe((snapshot) => this.syncDirectory(snapshot));
    this.syncDirectory(directory.getSnapshot());
  }

  getSnapshot(): ModelPopupState {
    return this.state;
  }

  subscribe(listener: ModelPopupListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async open(query = ""): Promise<void> {
    this.update({ open: true, query, status: "loading", error: null });
    this.refilter();
    try {
      await this.directory.load();
    } catch (error) {
      this.update({ status: "error", error: messageOf(error) });
    }
  }

  close(): void {
    this.update({ open: false, query: "", activeId: null, status: "idle", error: null });
  }

  setQuery(query: string): void {
    this.update({ query });
    this.refilter();
  }

  move(delta: number): void {
    const enabled = this.state.visibleOptions.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    const currentIndex = enabled.findIndex((option) => option.id === this.state.activeId);
    const base = currentIndex < 0 ? (delta >= 0 ? -1 : 0) : currentIndex;
    const next = enabled[(base + delta + enabled.length) % enabled.length];
    if (next !== undefined) this.update({ activeId: next.id });
  }

  async selectActive(commandId?: string): Promise<ModelSelection | undefined> {
    if (this.state.activeId === null) return undefined;
    return this.select(this.state.activeId, commandId);
  }

  async select(id: string, commandId?: string): Promise<ModelSelection | undefined> {
    const option = this.state.options.find((entry) => entry.id === id);
    if (option === undefined || option.disabled) return undefined;
    this.update({ status: "selecting", error: null, activeId: option.id });
    try {
      const selected = await this.directory.select(option.selection, commandId);
      this.close();
      return selected;
    } catch (error) {
      this.update({ status: "error", error: messageOf(error) });
      return undefined;
    }
  }

  async retry(): Promise<void> {
    this.update({ status: "loading", error: null });
    try {
      await this.directory.load();
    } catch (error) {
      this.update({ status: "error", error: messageOf(error) });
    }
  }

  dispose(): void {
    this.unsubscribeDirectory();
    this.listeners.clear();
  }

  private syncDirectory(snapshot: ModelDirectoryState): void {
    const options = optionsOf(snapshot);
    const directoryStatus = snapshot.status === "selecting" ? "selecting"
      : snapshot.status === "loading" ? "loading"
        : snapshot.status === "error" ? "error"
          : snapshot.status === "ready" ? "ready" : this.state.status;
    this.update({ options, status: directoryStatus, error: snapshot.error });
    this.refilter();
  }

  private refilter(): void {
    const query = this.state.query.trim().toLocaleLowerCase();
    const visibleOptions = query === ""
      ? this.state.options
      : this.state.options.filter((option) => `${option.providerName} ${option.provider} ${option.model} ${option.label} ${option.detail}`.toLocaleLowerCase().includes(query));
    const activeStillVisible = visibleOptions.some((option) => option.id === this.state.activeId && !option.disabled);
    const preferred = visibleOptions.find((option) => option.active && !option.disabled) ?? visibleOptions.find((option) => !option.disabled);
    this.update({
      visibleOptions,
      activeId: activeStillVisible ? this.state.activeId : preferred?.id ?? null,
    });
  }

  private update(partial: Partial<ModelPopupState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }
}

function optionsOf(snapshot: ModelDirectoryState): readonly ModelPopupOption[] {
  const options: ModelPopupOption[] = [];
  for (const group of snapshot.groups) {
    for (const entry of group.models) {
      const active = snapshot.current?.provider === group.provider && snapshot.current.model === entry.model;
      const reasoningEffort = active
        ? snapshot.current?.reasoningEffort ?? entry.reasoning?.defaultEffort
        : entry.reasoning?.defaultEffort;
      options.push({
        id: JSON.stringify([group.provider, entry.model]),
        provider: group.provider,
        providerName: group.displayName,
        model: entry.model,
        label: entry.displayName ?? entry.model,
        detail: `${group.displayName} · ${group.status}`,
        selection: {
          provider: group.provider,
          model: entry.model,
          ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
        },
        active,
        disabled: group.status !== "ready",
      });
    }
  }
  return options;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

