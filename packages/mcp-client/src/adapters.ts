import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export class McpResourceAdapter {
  constructor(private readonly client: Client) {}

  read(uri: string, timeout = 120_000): ReturnType<Client["readResource"]> {
    return this.client.readResource({ uri }, { timeout });
  }
}

export class McpPromptAdapter {
  constructor(private readonly client: Client) {}

  get(name: string, args?: Readonly<Record<string, string>>, timeout = 120_000): ReturnType<Client["getPrompt"]> {
    return this.client.getPrompt({ name, ...(args === undefined ? {} : { arguments: { ...args } }) }, { timeout });
  }
}
