import type { SkillProvider, SkillLookupOptions, SkillCandidate, SkillDefinition, SkillProviderObservation } from "@coding-agent/contracts";
import { FileSystemSkillProvider, type SkillFilesystemLimits } from "@coding-agent/skills-filesystem";

export interface PluginSkillProviderOptions {
  readonly pluginName: string;
  readonly roots: readonly string[];
  readonly rank?: number;
  readonly limits?: SkillFilesystemLimits;
}

/** Provider adapter used by plugin-runtime for manifest-contributed skill roots. */
export class PluginSkillProvider implements SkillProvider {
  readonly name: string;
  private readonly delegate: FileSystemSkillProvider;
  constructor(options: PluginSkillProviderOptions) {
    this.name = "plugin:" + options.pluginName;
    this.delegate = new FileSystemSkillProvider({
      roots: options.roots.map((path) => ({ kind: "custom", path, rank: options.rank ?? 120 })),
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
  }
  list(options: SkillLookupOptions): Promise<readonly SkillCandidate[] | SkillProviderObservation> { return this.delegate.list(options); }
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> { return this.delegate.get(candidate, options); }
  start(control: import("@coding-agent/contracts").SkillProviderControl): void { this.delegate.start?.(control); }
}

export function createPluginSkillProvider(options: PluginSkillProviderOptions): PluginSkillProvider { return new PluginSkillProvider(options); }
