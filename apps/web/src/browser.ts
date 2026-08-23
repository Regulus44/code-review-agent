import { WebApiClient } from "./client/api.js";
import { SessionConnectionController } from "./client/connection.js";
import { SessionStore } from "./client/store.js";
import { projectConversation } from "./projection/conversation.js";
import { buildToolCallTree } from "./projection/tool-call-tree.js";
import { projectTrajectory } from "./projection/trajectory.js";
import { buildTrajectoryTimeline, inspectTrajectory, queryTrajectory } from "./presentation/trajectory-presenter.js";
import { presentTask } from "./presentation/task-presenter.js";
import { presentMcpServer } from "./presentation/mcp-presenter.js";
import { presentToolCall } from "./presentation/tool-presenter.js";
import { presentInteraction, presentPermission } from "./presentation/request-presenter.js";
import { presentSettings } from "./presentation/settings-presenter.js";
import { presentDeliverables } from "./presentation/deliverables-presenter.js";
import { createFocusTrap, FOCUSABLE_SELECTOR, nextFocusableIndex } from "./presentation/focus-trap.js";
import { presentConnection } from "./presentation/connection-presenter.js";
import { buildNavigationModel, sessionLabel, sessionRelativeTime, workspaceKey, workspaceLabel } from "./presentation/navigation-presenter.js";
import { presentQueue } from "./presentation/queue-presenter.js";
import { presentRuntimeDiagnostics } from "./presentation/job-presenter.js";
import { createShellLayoutState, presentShellLayout, reduceShellLayout, shellViewport } from "./shell/layout.js";
import { createShellBootState, normalizeBootError, presentShellBoot, reduceShellBoot } from "./shell/boot.js";
import { createShellOverlayState, presentShellOverlay, reduceShellOverlay } from "./shell/overlay.js";

export interface BrowserWebRuntime {
  readonly api: WebApiClient;
  readonly store: SessionStore;
  readonly connection: SessionConnectionController;
  readonly loadOlder: SessionConnectionController["loadOlder"];
  readonly projectConversation: typeof projectConversation;
  readonly projectTrajectory: typeof projectTrajectory;
  readonly queryTrajectory: typeof queryTrajectory;
  readonly buildTrajectoryTimeline: typeof buildTrajectoryTimeline;
  readonly inspectTrajectory: typeof inspectTrajectory;
  readonly presentTask: typeof presentTask;
  readonly presentMcpServer: typeof presentMcpServer;
  readonly presentPermission: typeof presentPermission;
  readonly presentInteraction: typeof presentInteraction;
  readonly presentSettings: typeof presentSettings;
  readonly presentDeliverables: typeof presentDeliverables;
  readonly createFocusTrap: typeof createFocusTrap;
  readonly focusableSelector: typeof FOCUSABLE_SELECTOR;
  readonly nextFocusableIndex: typeof nextFocusableIndex;
  readonly presentConnection: typeof presentConnection;
  readonly buildNavigationModel: typeof buildNavigationModel;
  readonly sessionLabel: typeof sessionLabel;
  readonly sessionRelativeTime: typeof sessionRelativeTime;
  readonly workspaceKey: typeof workspaceKey;
  readonly workspaceLabel: typeof workspaceLabel;
  readonly presentQueue: typeof presentQueue;
  readonly presentRuntimeDiagnostics: typeof presentRuntimeDiagnostics;
  readonly createShellLayoutState: typeof createShellLayoutState;
  readonly reduceShellLayout: typeof reduceShellLayout;
  readonly presentShellLayout: typeof presentShellLayout;
  readonly shellViewport: typeof shellViewport;
  readonly createShellBootState: typeof createShellBootState;
  readonly reduceShellBoot: typeof reduceShellBoot;
  readonly presentShellBoot: typeof presentShellBoot;
  readonly normalizeBootError: typeof normalizeBootError;
  readonly createShellOverlayState: typeof createShellOverlayState;
  readonly reduceShellOverlay: typeof reduceShellOverlay;
  readonly presentShellOverlay: typeof presentShellOverlay;
  readonly buildToolCallTree: typeof buildToolCallTree;
  readonly presentToolCall: typeof presentToolCall;
}

const api = new WebApiClient();
const store = new SessionStore();
const connection = new SessionConnectionController({ api, store });
const runtime: BrowserWebRuntime = {
  api,
  store,
  connection,
  loadOlder: (limit?: number) => connection.loadOlder(limit),
  projectConversation,
  projectTrajectory,
  queryTrajectory,
  buildTrajectoryTimeline,
  inspectTrajectory,
  presentTask,
  presentMcpServer,
  presentPermission,
  presentInteraction,
  presentSettings,
  presentDeliverables,
  createFocusTrap,
  focusableSelector: FOCUSABLE_SELECTOR,
  nextFocusableIndex,
  presentConnection,
  buildNavigationModel,
  sessionLabel,
  sessionRelativeTime,
  workspaceKey,
  workspaceLabel,
  presentQueue,
  presentRuntimeDiagnostics,
  createShellLayoutState,
  reduceShellLayout,
  presentShellLayout,
  shellViewport,
  createShellBootState,
  reduceShellBoot,
  presentShellBoot,
  normalizeBootError,
  createShellOverlayState,
  reduceShellOverlay,
  presentShellOverlay,
  buildToolCallTree,
  presentToolCall,
};

Object.assign(window, { CodeReviewAgentWeb: runtime });
