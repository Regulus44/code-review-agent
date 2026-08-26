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
import { presentInteraction, presentPermission, presentPendingRequests } from "./presentation/request-presenter.js";
import { RequestActionGate } from "./presentation/request-action-gate.js";
import { presentSettings } from "./presentation/settings-presenter.js";
import { presentDeliverables } from "./presentation/deliverables-presenter.js";
import { createFocusTrap, FOCUSABLE_SELECTOR, nextFocusableIndex } from "./presentation/focus-trap.js";
import { presentConnection } from "./presentation/connection-presenter.js";
import { buildNavigationModel, sessionLabel, sessionRelativeTime, workspaceKey, workspaceLabel } from "./presentation/navigation-presenter.js";
import { presentQueue } from "./presentation/queue-presenter.js";
import { presentRuntimeDiagnostics } from "./presentation/job-presenter.js";
import { presentGoalBar } from "./presentation/goal-presenter.js";
import { presentPlan } from "./presentation/plan-presenter.js";
import { presentTodoPanel } from "./presentation/todo-presenter.js";
import { presentQuestionBatch } from "./presentation/question-presenter.js";
import { presentContextDiagnostics, presentContextMeter } from "./presentation/context-presenter.js";
import { presentWorktrees } from "./presentation/worktree-presenter.js";
import { presentLspTool } from "./presentation/lsp-presenter.js";
import { presentComposerSubmit } from "./presentation/composer-presenter.js";
import { beginComposerSubmit, createComposerState, releaseComposerError, settleComposerSubmit, type ComposerState } from "./presentation/composer-state.js";
import { presentUsage, presentUsageProjection } from "./presentation/usage-presenter.js";
import { createShellLayoutState, presentShellLayout, reduceShellLayout, shellViewport } from "./shell/layout.js";
import { createShellBootState, normalizeBootError, presentShellBoot, reduceShellBoot } from "./shell/boot.js";
import { createShellOverlayState, presentShellOverlay, reduceShellOverlay } from "./shell/overlay.js";
import { applyShellFrame, mountShellFrame } from "./shell/app-frame.js";

export interface BrowserWebRuntime {
  readonly api: WebApiClient;
  readonly store: SessionStore;
  readonly connection: SessionConnectionController;
  readonly loadOlder: SessionConnectionController["loadOlder"];
  readonly sendMessage: SessionConnectionController["sendMessage"];
  readonly projectConversation: typeof projectConversation;
  readonly projectTrajectory: typeof projectTrajectory;
  readonly queryTrajectory: typeof queryTrajectory;
  readonly buildTrajectoryTimeline: typeof buildTrajectoryTimeline;
  readonly inspectTrajectory: typeof inspectTrajectory;
  readonly presentTask: typeof presentTask;
  readonly presentMcpServer: typeof presentMcpServer;
  readonly presentPermission: typeof presentPermission;
  readonly presentInteraction: typeof presentInteraction;
  readonly presentPendingRequests: typeof presentPendingRequests;
  readonly createRequestActionGate: () => RequestActionGate;
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
  readonly presentGoalBar: typeof presentGoalBar;
  readonly presentPlan: typeof presentPlan;
  readonly presentTodoPanel: typeof presentTodoPanel;
  readonly presentQuestionBatch: typeof presentQuestionBatch;
  readonly presentContextMeter: typeof presentContextMeter;
  readonly presentContextDiagnostics: typeof presentContextDiagnostics;
  readonly presentWorktrees: typeof presentWorktrees;
  readonly presentLspTool: typeof presentLspTool;
  readonly presentComposerSubmit: typeof presentComposerSubmit;
  readonly createComposerState: typeof createComposerState;
  readonly beginComposerSubmit: typeof beginComposerSubmit;
  readonly settleComposerSubmit: typeof settleComposerSubmit;
  readonly releaseComposerError: typeof releaseComposerError;
  readonly presentUsage: typeof presentUsage;
  readonly presentUsageProjection: typeof presentUsageProjection;
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
  readonly mountShellFrame: typeof mountShellFrame;
  readonly applyShellFrame: typeof applyShellFrame;
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
  sendMessage: (content: string, commandId?: string, reasoningEffort?: string) => connection.sendMessage(content, commandId, reasoningEffort),
  projectConversation,
  projectTrajectory,
  queryTrajectory,
  buildTrajectoryTimeline,
  inspectTrajectory,
  presentTask,
  presentMcpServer,
  presentPermission,
  presentInteraction,
  presentPendingRequests,
  createRequestActionGate: () => new RequestActionGate(),
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
  presentGoalBar,
  presentPlan,
  presentTodoPanel,
  presentQuestionBatch,
  presentContextMeter,
  presentContextDiagnostics,
  presentWorktrees,
  presentLspTool,
  presentComposerSubmit,
  createComposerState,
  beginComposerSubmit,
  settleComposerSubmit,
  releaseComposerError,
  presentUsage,
  presentUsageProjection,
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
  mountShellFrame,
  applyShellFrame,
  buildToolCallTree,
  presentToolCall,
};

Object.assign(window, { CodeReviewAgentWeb: runtime });
