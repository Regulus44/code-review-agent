export type RequestActionStatus = "idle" | "submitting" | "error";

export interface RequestActionState {
  readonly status: RequestActionStatus;
  readonly error?: string;
}

/** Local one-shot guard; durable resolved events remain authoritative. */
export class RequestActionGate {
  private readonly states = new Map<string, RequestActionState>();

  state(key: string): RequestActionState {
    return this.states.get(key) ?? { status: "idle" };
  }

  begin(key: string): boolean {
    if (this.state(key).status === "submitting") return false;
    this.states.set(key, { status: "submitting" });
    return true;
  }

  fail(key: string, error: string): void {
    this.states.set(key, { status: "error", error });
  }

  clear(key: string): void {
    this.states.delete(key);
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.states.keys()) if (!keys.has(key)) this.states.delete(key);
  }
}
