import { describe, expect, it } from "vitest";
import { parseAssistantResponse } from "../src/ai/parsing/parseAssistantResponse";
import { extractFirstJsonObject, tryParseJsonWithRepair } from "../src/ai/parsing/jsonRepair";

describe("parseAssistantResponse", () => {
  it("parses a message action", () => {
    const result = parseAssistantResponse('{"type":"message","content":"hi there"}');
    expect(result.parseOk).toBe(true);
    expect(result.action).toEqual({ type: "message", content: "hi there" });
  });

  it("parses a tool_call action", () => {
    const result = parseAssistantResponse(
      '{"type":"tool_call","tool":"ping","arguments":{},"reason":"user asked"}',
    );
    expect(result.parseOk).toBe(true);
    expect(result.action).toMatchObject({ type: "tool_call", tool: "ping" });
  });

  it("parses confirmation_request and clarification actions", () => {
    const confirm = parseAssistantResponse(
      '{"type":"confirmation_request","content":"sure?","pending_tool_call":{"tool":"timeout_user","arguments":{"userId":"1"}}}',
    );
    expect(confirm.parseOk).toBe(true);
    expect(confirm.action.type).toBe("confirmation_request");

    const clarify = parseAssistantResponse('{"type":"clarification","content":"which user?"}');
    expect(clarify.parseOk).toBe(true);
    expect(clarify.action.type).toBe("clarification");
  });

  it("extracts JSON from code fences and surrounding prose", () => {
    const fenced = parseAssistantResponse(
      'Sure! Here you go:\n```json\n{"type":"message","content":"fenced"}\n```\nhope that helps',
    );
    expect(fenced.parseOk).toBe(true);
    expect(fenced.action).toEqual({ type: "message", content: "fenced" });
  });

  it("repairs trailing commas", () => {
    const result = parseAssistantResponse('{"type":"message","content":"oops",}');
    expect(result.parseOk).toBe(true);
  });

  it("falls back to plain message on non-JSON output without throwing", () => {
    const result = parseAssistantResponse("just a casual reply with no json");
    expect(result.parseOk).toBe(false);
    expect(result.action).toEqual({ type: "message", content: "just a casual reply with no json" });
  });

  it("never produces an executable tool_call from invalid protocol JSON", () => {
    const result = parseAssistantResponse('{"type":"tool_call"}'); // missing tool name
    expect(result.parseOk).toBe(false);
    expect(result.action.type).toBe("message");
  });

  it("handles empty output", () => {
    const result = parseAssistantResponse("");
    expect(result.parseOk).toBe(false);
    expect(result.action.type).toBe("message");
  });
});

describe("jsonRepair", () => {
  it("extracts the first balanced object, respecting strings", () => {
    const text = 'prefix {"a": "with } brace", "b": {"c": 1}} suffix {"d":2}';
    expect(extractFirstJsonObject(text)).toBe('{"a": "with } brace", "b": {"c": 1}}');
  });

  it("returns null when no object exists", () => {
    expect(extractFirstJsonObject("no json here")).toBeNull();
  });

  it("repairs python-style literals", () => {
    expect(tryParseJsonWithRepair('{"ok": True, "val": None}')).toEqual({ ok: true, val: null });
  });
});
