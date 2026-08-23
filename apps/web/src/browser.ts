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
  buildToolCallTree,
  presentToolCall,
};

Object.assign(window, { CodeReviewAgentWeb: runtime });
