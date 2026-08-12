import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";

async function readNamespaceIdFromLocalEnv() {
  for (const file of [".env.local", ".env"]) {
    try {
      const contents = await readFile(file, "utf8");
      const match = contents.match(/^\s*ROADBOOK_KV_NAMESPACE_ID\s*=\s*(.*?)\s*$/m);
      if (!match) continue;
      const value = match[1].trim().replace(/^(['"])(.*)\1$/, "$2");
      if (value) return value;
    } catch {
      // A local env file is optional; the shell environment still works.
    }
  }
  return "";
}

const namespaceId = (process.env.ROADBOOK_KV_NAMESPACE_ID?.trim() || await readNamespaceIdFromLocalEnv()).trim();
if (namespaceId) process.env.ROADBOOK_KV_NAMESPACE_ID = namespaceId;

if (!namespaceId) {
  console.error("部署已停止：缺少 ROADBOOK_KV_NAMESPACE_ID。请从 Cloudflare KV 命名空间详情页复制 ID，然后执行：");
  console.error('ROADBOOK_KV_NAMESPACE_ID="你的 KV Namespace ID" npm run deploy');
  process.exit(1);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        WRANGLER_WRITE_LOGS: "false",
        WRANGLER_LOG_PATH: ".wrangler/logs",
      },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

const build = await run("npm", ["run", "build"]);
if (build.code !== 0) process.exit(build.code);

let config;
try {
  config = JSON.parse(await readFile("dist/server/wrangler.json", "utf8"));
} catch (error) {
  console.error("部署已停止：找不到或无法读取 dist/server/wrangler.json。", error);
  process.exit(1);
}

const hasRoadbookBinding = config.kv_namespaces?.some(
  (binding) => binding.binding === "ROADBOOK_KV" && binding.id === namespaceId,
);

if (!hasRoadbookBinding) {
  console.error("部署已停止：生成的 Wrangler 配置没有正确包含 ROADBOOK_KV。为避免覆盖 Cloudflare 上已有的绑定，本次不会发布。");
  console.error("请确认 ROADBOOK_KV_NAMESPACE_ID 是目标 KV 命名空间的 ID，然后重试。");
  process.exit(1);
}

const deploy = await run("npx", ["wrangler", "deploy", "--config", "dist/server/wrangler.json", "--name", "roam-note-roadbook"]);
if (deploy.code !== 0) process.exit(deploy.code);
