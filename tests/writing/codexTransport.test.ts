import { afterEach, describe, expect, it } from "vitest";
import { CodexTransport } from "../../electron/writing/codexTransport";

const clients: CodexTransport[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.stop(); });
function server(body: string) {
  const client = new CodexTransport(process.execPath, ["--input-type=module", "-e", `import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line', line=>{const m=JSON.parse(line); ${body}});`], { cwd: process.cwd(), env: process.env });
  clients.push(client); return client;
}
describe("Codex JSONL transport", () => {
  it("assembles fragmented responses and correlates simultaneous requests", async () => {
    const client = server(`const s=JSON.stringify({id:m.id,result:{method:m.method}})+'\\n'; process.stdout.write(s.slice(0,5)); setTimeout(()=>process.stdout.write(s.slice(5)),5);`);
    expect(await client.request("first")).toEqual({ method: "first" });
    expect(await client.request("second")).toEqual({ method: "second" });
  });
  it("times out without retaining a request", async () => {
    const client = server("");
    await expect(client.request("hang", {}, 30)).rejects.toMatchObject({ agentError: { code: "request_timeout" } });
  });
  it("rejects pending requests on process exit and subsequent requests immediately", async () => {
    const client = server("process.exit(1);");
    await expect(client.request("exit")).rejects.toThrow();
    await expect(client.request("after")).rejects.toThrow();
  });
  it("does not expose provider error bodies", async () => {
    const client = server(`process.stdout.write(JSON.stringify({id:m.id,error:{message:'PRIVATE DOCUMENT'}})+'\\n');`);
    await expect(client.request("error")).rejects.not.toThrow("PRIVATE DOCUMENT");
  });
  it("rejects malformed output", async () => {
    const client = server(`process.stdout.write('not JSON\\n');`);
    await expect(client.request("bad")).rejects.toThrow();
  });
});
