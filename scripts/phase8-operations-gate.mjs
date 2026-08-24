/** Phase 8.5 backup/restore and migration rollback gate. */
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  restoreSqliteDatabase,
  rollbackSqliteRestore,
  SqliteEventStore,
  inspectSqliteDatabase,
  assessSqliteUpgrade,
} from "../packages/storage/dist/index.js";

const root = mkdtempSync(join(tmpdir(), "code-review-agent-phase8-operations-"));
const assert = (condition, message) => { if (!condition) throw new Error(`Phase 8.5 operations gate: ${message}`); };
const databasePath = join(root, "active.sqlite");
const backupPath = join(root, "backup.sqlite");
const legacyPath = join(root, "legacy-v5.sqlite");
const restoredPath = join(root, "restored.sqlite");

try {
  const first = new SqliteEventStore({ databasePath });
  const sessionId = await first.createSession(join(root, "workspace"));
  await first.append({ sessionId, type: "user/message", payload: { content: "operations fixture" } });
  first.upsertCredential({ id: "cred_ops", tenantId: "tenant-ops", kind: "header", label: "Operations provider", status: "active", version: 1, createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" });
  const backup = first.backup(backupPath);
  assert(backup.schemaVersion === 7 && backup.sessions === 1 && backup.events === 2 && backup.credentials === 1 && backup.principals === 0, "backup metadata does not describe the durable database");
  assert(!readFileSync(backupPath).toString("utf8").includes("operations-secret-material"), "backup contains secret material");
  first.close();

  copyFileSync(backupPath, legacyPath);
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec("DROP TABLE credentials; DROP TABLE principals; DELETE FROM schema_migrations WHERE version >= 6; PRAGMA user_version = 5;");
  legacy.close();
  const legacyInspection = inspectSqliteDatabase(legacyPath);
  assert(legacyInspection.schemaVersion === 5 && legacyInspection.integrity === "ok", "legacy v5 fixture is not a valid migration input");
  const upgradeAssessment = assessSqliteUpgrade(legacyPath);
  assert(upgradeAssessment.allowed && upgradeAssessment.requiresBackup && upgradeAssessment.requiresMigrationLock && upgradeAssessment.rollback === "retained-displaced-database", "upgrade policy did not require backup, lock, readiness, and retained rollback");

  const restored = restoreSqliteDatabase(legacyPath, restoredPath);
  assert(restored.migrated === true && restored.sourceSchemaVersion === 5 && restored.restoredSchemaVersion === 7, "restore did not migrate the legacy snapshot to schema v7");
  const restoredStore = new SqliteEventStore({ databasePath: restoredPath });
  assert((await restoredStore.list(sessionId)).length === 2, "restored event history is incomplete");
  restoredStore.close();

  const active = new SqliteEventStore({ databasePath });
  const activeSessionId = await active.createSession(join(root, "rollback-workspace"));
  await active.append({ sessionId: activeSessionId, type: "user/message", payload: { content: "active database must survive rollback" } });
  active.close();
  const overwritten = restoreSqliteDatabase(legacyPath, databasePath, { overwrite: true });
  assert(typeof overwritten.rollbackPath === "string" && existsSync(overwritten.rollbackPath), "overwrite restore did not retain a rollback target");
  const rolledBack = rollbackSqliteRestore(overwritten);
  const rolledStore = new SqliteEventStore({ databasePath });
  const activeProjection = await rolledStore.project(activeSessionId);
  assert(activeProjection?.messages.at(-1)?.content === "active database must survive rollback", "rollback did not restore the pre-upgrade database");
  rolledStore.close();
  assert(existsSync(rolledBack.destinationPath) && rolledBack.displacedPath !== undefined && existsSync(rolledBack.displacedPath), "rollback did not retain the displaced restore target");

  console.log(JSON.stringify({ phase: "8.5", gate: "sqlite-backup-restore-migration-rollback", passed: true, backupSchema: backup.schemaVersion, legacySchema: legacyInspection.schemaVersion, restoredSchema: restored.restoredSchemaVersion, rollback: true, upgradePolicy: upgradeAssessment.allowed, secretRedaction: true }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
