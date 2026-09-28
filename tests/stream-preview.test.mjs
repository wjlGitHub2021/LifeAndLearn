import test from "node:test";
import assert from "node:assert/strict";
import { streamedTextField } from "../src/lib/stream-preview.ts";

test("stream preview reveals only the requested top-level Markdown field", () => {
  const raw = '{"meta":{"content":"hidden"},"content":"## Plan\\n- Fir';
  assert.equal(streamedTextField(raw, "content"), "## Plan\n- Fir");
  assert.equal(streamedTextField(raw, "question"), "");
  assert.equal(streamedTextField('{"content":"A \\u4f60\\u597d\\nB\\', "content"), "A 你好\nB");
});

test("stream preview waits for a complete key and ignores JSON transport text", () => {
  assert.equal(streamedTextField('{"con', "content"), "");
  assert.equal(streamedTextField('{"content":', "content"), "");
  assert.equal(streamedTextField('{"question":"**选择一项**","options":["one","two"]}', "question"), "**选择一项**");
});
