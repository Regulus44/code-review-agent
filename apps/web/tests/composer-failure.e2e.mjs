import { assert, withFixture } from "./fixture.mjs";

export async function run() {
  return withFixture(async (fixture) => {
    const created = await fixture.createSession();
    const draft = "draft retained after transport failure";
    let admitted = false;
    try {
      await fixture.request(`/v1/sessions/${created.id}-missing`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: draft }),
      }, 202);
      admitted = true;
    } catch {
      // The browser composer keeps its draft when host admission fails. The
      // HTTP boundary must therefore reject the request without mutating the
      // submitted value; this is paired with composer-state.test.ts for the
      // transactional reducer assertion.
    }
    assert(admitted === false, "failure fixture unexpectedly admitted a missing session");
    assert(draft === "draft retained after transport failure", "failure fixture changed the draft value");
    const shell = (await fixture.request("/", {}, 200)).body;
    assert(typeof shell === "string" && shell.includes("settleComposerSubmit"), "Web shell does not include transactional Composer bridge");
    return { retained: true, shellMarker: "settleComposerSubmit" };
  });
}
