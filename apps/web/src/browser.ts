import { WebApiClient } from "./client/api.js";
import { SessionConnectionController } from "./client/connection.js";
import { SessionStore } from "./client/store.js";
import { projectConversation } from "./projection/conversation.js";

export interface BrowserWebRuntime {
  readonly api: WebApiClient;
  readonly store: SessionStore;
  readonly connection: SessionConnectionController;
  readonly projectConversation: typeof projectConversation;
}

const api = new WebApiClient();
const store = new SessionStore();
const connection = new SessionConnectionController({ api, store });
const runtime: BrowserWebRuntime = { api, store, connection, projectConversation };

Object.assign(window, { CodeReviewAgentWeb: runtime });
