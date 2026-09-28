import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const folder = mkdtempSync(join(tmpdir(), "personal-agent-tests-"));
try {
  const tests = readdirSync(new URL(".", import.meta.url)).filter(name => name.endsWith(".test.mjs")).sort();
  const child = spawn(process.execPath, ["--experimental-strip-types", "--test", ...tests.map(name => fileURLToPath(new URL(name, import.meta.url)))], {
    stdio: "inherit",
    env: { ...process.env, TMPDIR: folder, TMP: folder, TEMP: folder, AGENT_DB_PATH: join(folder, "agents.sqlite") },
  });
  const onInt = () => child.kill("SIGINT");
  const onTerm = () => child.kill("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  let spawnError;
  child.once("error", error => { spawnError = error; });
  const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  process.off("SIGINT", onInt);
  process.off("SIGTERM", onTerm);
  if (spawnError) {
    process.stderr.write(`测试进程启动失败：${spawnError.message}\n`);
    process.exitCode = 1;
  } else if (result.signal) process.exitCode = result.signal === "SIGINT" ? 130 : 143;
  else process.exitCode = result.code ?? 1;
} finally {
  try { rmSync(folder, { recursive: true, force: true }); }
  catch (error) {
    process.stderr.write(`测试临时目录清理失败：${folder} (${error.message})\n`);
    process.exitCode = 1;
  }
}
