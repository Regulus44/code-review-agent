import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderProfileRecord } from "@coding-agent/contracts";

interface ProviderProfileFile {
  readonly version: 1;
  readonly profiles: readonly ProviderProfileRecord[];
}

/** Host-local durable metadata for custom provider profiles.
 *
 * Provider profiles contain only protocol, endpoint, model catalog and opaque
 * credential references. Secret material is kept in LocalFileSecretProvider.
 */
export class LocalProviderProfileStore {
  readonly filePath: string;
  private profiles: ProviderProfileRecord[] = [];

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    this.load();
  }

  list(tenantId?: string): readonly ProviderProfileRecord[] {
    return this.profiles.filter((profile) => profile.tenantId === undefined || profile.tenantId === tenantId);
  }

  listAll(): readonly ProviderProfileRecord[] {
    return [...this.profiles];
  }

  upsert(profile: ProviderProfileRecord): ProviderProfileRecord {
    const key = profileKey(profile);
    this.profiles = [...this.profiles.filter((item) => profileKey(item) !== key), profile];
    this.persist();
    return profile;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles)) return;
      this.profiles = parsed.profiles.filter(isProviderProfileRecord);
    } catch {
      // A corrupt profile catalog must not stop the host from booting. Routes
      // referring to unavailable profiles fail closed until repaired.
      this.profiles = [];
    }
  }

  private persist(): void {
    const directory = path.dirname(this.filePath);
    mkdirSync(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, profiles: this.profiles } satisfies ProviderProfileFile) + "\n", { encoding: "utf8", mode: 0o600 });
      try { chmodSync(temporary, 0o600); } catch { /* platform without chmod */ }
      renameSync(temporary, this.filePath);
      try { chmodSync(this.filePath, 0o600); } catch { /* platform without chmod */ }
    } catch (error) {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort cleanup */ }
      throw error;
    }
  }
}

function profileKey(profile: ProviderProfileRecord): string {
  return `${profile.tenantId ?? ""}\u0000${profile.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProviderProfileRecord(value: unknown): value is ProviderProfileRecord {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.displayName !== "string" || typeof value.protocol !== "string" || typeof value.enabled !== "boolean" || !Number.isInteger(value.revision) || !Array.isArray(value.models) || typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return false;
  if (value.tenantId !== undefined && typeof value.tenantId !== "string") return false;
  if (value.baseUrl !== undefined && typeof value.baseUrl !== "string") return false;
  return true;
}
