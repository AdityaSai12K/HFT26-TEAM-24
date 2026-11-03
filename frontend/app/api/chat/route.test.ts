import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatContext } from "@/lib/chat/context";
import { POST } from "./route";

const context: ChatContext = {
  boardId: "arduino_uno",
  aligned: true,
  detections: [],
  wires: [],
  rules: [{ rule: "short-power-gnd", title: "Power-to-ground short", status: "fail", severity: "critical", reason: "5V and GND are joined.", fix: "Unplug power." }],
};

const ask = (question = "Is this safe?", body: object = { question, context }) =>
  POST(new Request("http://test/api/chat", { method: "POST", body: JSON.stringify(body) }));

const llmReplies = (content: string) =>
  vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 }));

describe("/api/chat", () => {
  beforeEach(() => {
    vi.stubEnv("FEATHERLESS_API_KEY", "test-key");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns a grounded LLM answer", async () => {
    vi.stubGlobal("fetch", llmReplies("No. Disconnect power, then move the wire off GND."));
    const reply = await (await ask()).json();
    expect(reply).toMatchObject({ source: "llm", answer: "No. Disconnect power, then move the wire off GND." });
  });

  it("sends the key, the chosen model, and the constrained prompt", async () => {
    vi.stubEnv("FEATHERLESS_MODEL", "some/model");
    const fetchMock = llmReplies("Fine.");
    vi.stubGlobal("fetch", fetchMock);
    await ask();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(init.body as string);
    expect(url).toBe("https://api.featherless.ai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(sent.model).toBe("some/model");
    expect(sent.messages[0].content).toContain("Never name a pin that is not in PINOUT");
    expect(sent.messages[0].content).toContain("5V and GND are joined.");
  });

  it("discards an answer that invents a pin", async () => {
    vi.stubGlobal("fetch", llmReplies("Connect it to D20 instead."));
    const reply = await (await ask()).json();
    expect(reply.source).toBe("rules");
    expect(reply.notice).toContain("D20");
    expect(reply.answer).not.toContain("Connect it to D20");
    expect(reply.answer).toContain("Power-to-ground short");
  });

  it("falls back when the LLM is too slow", async () => {
    vi.stubEnv("LLM_TIMEOUT_MS", "20");
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })));
    const reply = await (await ask()).json();
    expect(reply).toMatchObject({ source: "rules" });
    expect(reply.notice).toContain("too long");
  });

  it("falls back on a server error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("overloaded", { status: 503 })));
    expect(await (await ask()).json()).toMatchObject({ source: "rules" });
  });

  it("falls back on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await (await ask()).json()).toMatchObject({ source: "rules" });
  });

  it("falls back on an empty reply", async () => {
    vi.stubGlobal("fetch", llmReplies("  "));
    expect(await (await ask()).json()).toMatchObject({ source: "rules" });
  });

  it("works with no key, and does not call out", async () => {
    vi.stubEnv("FEATHERLESS_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await (await ask()).json()).toMatchObject({ source: "rules" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no question", async () => {
    expect((await ask("", { question: " ", context })).status).toBe(400);
  });
});
