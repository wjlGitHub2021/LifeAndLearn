import test from "node:test";
import assert from "node:assert/strict";
import { FeedbackValidationError, feedbackMessages, parseFeedback, produceFeedback } from "../src/lib/feedback.ts";
import { beginGeneration, connect, disconnect } from "../src/lib/deepseek.ts";

test("提示只发送所属任务与记忆并标记用户内容为数据", () => {
  const messages = feedbackMessages({ role: "english", prompt: "写一段英文", preference: "简洁", memories: [{ id: "m1", text: "练习时态", source: "r1" }], answer: "I have went there." });
  assert.match(messages[0].content, /英语教练/);
  assert.match(messages[0].content, /待分析数据/);
  assert.deepEqual(JSON.parse(messages[1].content).relatedMemories.map(m => m.id), ["m1"]);
  assert.deepEqual(JSON.parse(messages[1].content).evidenceCandidates, [{ id: "s1", text: "I have went there." }]);
  assert.match(messages[0].content, /3000.*500/);
});
test("反馈必须引用本次作答，不能接受无关预设文本", () => {
  const answer = "I have went there.";
  const good = parseFeedback(JSON.stringify({ evidence: "have went", feedback: "应使用 have gone。", nextSuggestion: "继续练习现在完成时。" }), answer);
  assert.match(good.feedback, /have went/);
  assert.equal(good.suggestion, "继续练习现在完成时。");
  assert.throws(() => parseFeedback(JSON.stringify({ evidence: "unrelated", feedback: "泛泛反馈", nextSuggestion: "再练" }), answer));
  assert.throws(() => parseFeedback("固定示例反馈", answer));
  assert.match(parseFeedback(JSON.stringify({ evidence: "你好世界", feedback: "反馈", nextSuggestion: "再练" }), "你好世界，今天不错。" ).feedback, /你好世界/);
  assert.throws(() => parseFeedback(JSON.stringify({ evidence: "你好啊", feedback: "反馈", nextSuggestion: "再练" }), "你好啊，今天不错。"));
});
test("引用编号只对应本次回答原文，Unicode 和尾部短片段不丢失", () => {
  const answer = "😀".repeat(203);
  const context = { role: "english", prompt: "写一段英文", preference: "", memories: [], answer };
  const candidates = JSON.parse(feedbackMessages(context)[1].content).evidenceCandidates;
  assert.deepEqual(candidates.map(item => Array.from(item.text).length), [100, 103]);
  assert.equal(candidates.map(item => item.text).join(""), answer);
  const valid = parseFeedback(JSON.stringify({ evidenceId: "s2", feedback: "后半段有重复表达。", nextSuggestion: "练习变换句式" }), answer);
  assert.match(valid.feedback, new RegExp(`引用本次作答：“${"😀".repeat(103)}”`));
  assert.throws(() => parseFeedback(JSON.stringify({ evidenceId: "s3", evidence: "😀😀😀😀", feedback: "反馈", nextSuggestion: "再练" }), answer), { name: "Error", reason: "unknown_evidence_id" });
  assert.throws(() => parseFeedback(JSON.stringify({ evidenceId: "s2", evidence: "😀😀😀😀", feedback: "反馈", nextSuggestion: "再练" }), answer), { name: "Error", reason: "conflicting_evidence" });
});
test("反馈校验区分安全失败原因，错误不包含模型原文", () => {
  const answer = "I have went there.";
  const cases = [
    ["private raw text", "invalid_json"],
    ["[]", "invalid_object"],
    [JSON.stringify({ evidenceId: 1, feedback: "反馈", nextSuggestion: "再练" }), "invalid_evidence_id"],
    [JSON.stringify({ evidence: "missing PRIVATE", feedback: "反馈", nextSuggestion: "再练" }), "evidence_mismatch"],
    [JSON.stringify({ evidenceId: "s1", feedback: "", nextSuggestion: "再练" }), "invalid_feedback"],
    [JSON.stringify({ evidenceId: "s1", feedback: "😀".repeat(3001), nextSuggestion: "再练" }), "feedback_length"],
    [JSON.stringify({ evidenceId: "s1", feedback: "反馈", nextSuggestion: "😀".repeat(501) }), "suggestion_length"],
  ];
  for (const [raw, reason] of cases) {
    assert.throws(() => parseFeedback(raw, answer), error => error instanceof FeedbackValidationError && error.reason === reason && !error.message.includes("PRIVATE") && !error.message.includes("😀"));
  }
});
test("模拟供应商对两份不同作答生成对应反馈", async () => {
  disconnect();
  await connect("mock-test-key", async () => new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 }));
  const answers = ["I have went there.", "I have eaten breakfast."];
  for (const answer of answers) {
    const result = await produceFeedback(beginGeneration(), { role: "english", prompt: "写一句英文", preference: "", memories: [], answer }, async (_url, options) => {
      const submitted = JSON.parse(options.body).messages[1].content;
      assert.equal(JSON.parse(submitted).answer, answer);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ evidence: answer.slice(0, 6), feedback: `本次作答：${answer}`, nextSuggestion: "继续练习" }) } }] }), { status: 200 });
    });
    assert.match(result.feedback, new RegExp(answer.replaceAll(".", "\\.")));
  }
  disconnect();
});
