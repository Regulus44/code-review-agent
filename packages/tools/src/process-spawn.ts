/**
 * Spawn policy for Agent-owned command processes.
 *
 * Windows children stay attached to the Agent host and hide their console
 * window. POSIX children keep detached process groups so cancellation can
 * terminate the complete command tree.
 */
export interface HiddenProcessSpawnOptions {
  readonly detached: boolean;
  readonly shell: false;
  readonly windowsHide: true;
}

export function hiddenProcessSpawnOptions(platform: NodeJS.Platform = process.platform): HiddenProcessSpawnOptions {
  return {
    detached: platform !== "win32",
    shell: false,
    windowsHide: true,
  };
}
