import { WebApiClient } from "./client/api.js";
import { SessionConnectionController } from "./client/connection.js";
import { SessionStore } from "./client/store.js";
import { projectConversation } from "./projection/conversation.js";
import { buildToolCallTree } from "./projection/tool-call-tree.js";
import { projectTrajectory } from "./projection/trajectory.js";
import { presentToolCall } from "./presentation/tool-presenter.js";

export interface BrowserWebRuntime {
  readonly api: WebApiClient;
  readonly store: SessionStore;
  readonly connection: SessionConnectionController;
  readonly projectConversation: typeof projectConversation;
  readonly projectTrajectory: typeof projectTrajectory;
  readonly buildToolCallTree: typeof buildToolCallTree;
  readonly presentToolCall: typeof presentToolCall;
}

const api = new WebApiClient();
const store = new SessionStore();
const connection = new SessionConnectionController({ api, store });
const runtime: BrowserWebRuntime = { api, store, connection, projectConversation, projectTrajectory, buildToolCallTree, presentToolCall };

Object.assign(window, { CodeReviewAgentWeb: runtime });
