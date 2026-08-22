import { existsSync, writeFileSync } from "node:fs";

const marker = process.argv[2];
const mode = process.argv[3] ?? "normal";
let buffer = Buffer.alloc(0);

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.method === "initialize") {
    frame({ jsonrpc: "2.0", id: message.id, result: { capabilities: { diagnosticProvider: {}, definitionProvider: true, referencesProvider: true } } });
    return;
  }
  if (message.method === "initialized" || message.method === "textDocument/didOpen" || message.method === "$/cancelRequest") return;
  if (message.method === "textDocument/diagnostic" && mode === "crash-once" && marker !== undefined && !existsSync(marker)) {
    writeFileSync(marker, "crashed", "utf8");
    process.stderr.write("fixture crash\n");
    process.exit(23);
  }
  if (message.method === "textDocument/diagnostic" && mode === "slow") {
    setTimeout(() => frame({ jsonrpc: "2.0", id: message.id, result: { items: [] } }), 250);
    return;
  }
  if (message.method === "textDocument/diagnostic") { frame({ jsonrpc: "2.0", id: message.id, result: { items: [{ severity: 2, message: "fixture diagnostic" }] } }); return; }
  if (message.method === "textDocument/definition") { frame({ jsonrpc: "2.0", id: message.id, result: [{ uri: "file:///fixture.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] }); return; }
  if (message.method === "textDocument/references") { frame({ jsonrpc: "2.0", id: message.id, result: [{ uri: "file:///fixture.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }] }); return; }
  if (typeof message.id === "number") frame({ jsonrpc: "2.0", id: message.id, result: null });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) return;
    const header = buffer.subarray(0, separator).toString("ascii");
    const match = /Content-Length:\s*(\d+)/iu.exec(header);
    if (match === null) process.exit(24);
    const length = Number(match[1]);
    const start = separator + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    handle(JSON.parse(body));
  }
});
