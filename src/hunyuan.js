const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SECRET_FILE = path.resolve("C:/Users/Administrator/Downloads/SecretKey.csv");
const ENDPOINT = "https://hunyuan.tencentcloudapi.com";
const HOST = "hunyuan.tencentcloudapi.com";
const SERVICE = "hunyuan";
const VERSION = "2023-09-01";
const ACTION = "ChatCompletions";

async function summarizeWithHunyuan(release) {
  const credentials = loadCredentials();
  if (!credentials) return null;

  const prompt = [
    "你是监控平台产品经理。请把 exporter 的 GitHub release notes 整理成干净、紧凑、适合 UI 展示的中文摘要。",
    "要求：",
    "1. 最多 4 条，每条不超过 28 个中文字符。",
    "2. 按【新增能力】【破坏性变更】【修复】【升级注意】归类，没内容的类别不要写。",
    "3. 不要输出 Markdown 表格，不要输出链接，不要输出寒暄。",
    "4. 如果原文很少，直接提炼一句。",
    "",
    `Exporter: ${release.name}`,
    `Version: ${release.version}`,
    `Release notes:\n${String(release.body || "").slice(0, 6000)}`
  ].join("\n");

  const models = process.env.HUNYUAN_MODEL
    ? [process.env.HUNYUAN_MODEL]
    : ["hunyuan-standard-256K", "hunyuan-pro"];
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    for (const model of models) {
      try {
        const response = await callTencentApi(credentials, {
          Model: model,
          Stream: false,
          Temperature: 0.2,
          Messages: [
            {
              Role: "user",
              Content: prompt
            }
          ]
        });
        const content = response?.Response?.Choices?.[0]?.Message?.Content?.trim();
        if (content) return content;
      } catch (error) {
        lastError = error;
      }
    }
    await delay(400);
  }

  if (lastError) throw lastError;
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadCredentials() {
  const envId = process.env.HUNYUAN_SECRET_ID || process.env.TENCENTCLOUD_SECRET_ID;
  const envKey = process.env.HUNYUAN_SECRET_KEY || process.env.TENCENTCLOUD_SECRET_KEY;
  if (envId && envKey) return { secretId: envId, secretKey: envKey };
  if (!fs.existsSync(SECRET_FILE)) return null;

  const raw = fs.readFileSync(SECRET_FILE, "utf8").trim();
  const [headerLine, valueLine] = raw.split(/\r?\n/);
  if (!headerLine || !valueLine) return null;
  const headers = parseCsvLine(headerLine);
  const values = parseCsvLine(valueLine);
  const row = Object.fromEntries(headers.map((header, index) => [header.trim(), values[index]?.trim()]));
  if (!row.SecretId || !row.SecretKey) return null;
  return { secretId: row.SecretId, secretKey: row.SecretKey };
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

async function callTencentApi(credentials, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const body = JSON.stringify(payload);
  const hashedPayload = sha256(body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${HOST}\nx-tc-action:${ACTION.toLowerCase()}\n`;
  const signedHeaders = "content-type;host;x-tc-action";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    hashedPayload
  ].join("\n");

  const credentialScope = `${date}/${SERVICE}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");

  const secretDate = hmac(`TC3${credentials.secretKey}`, date);
  const secretService = hmac(secretDate, SERVICE);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization = `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": authorization,
        "Content-Type": "application/json; charset=utf-8",
        "Host": HOST,
        "X-TC-Action": ACTION,
        "X-TC-Timestamp": String(timestamp),
        "X-TC-Version": VERSION
      },
      body,
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Hunyuan HTTP ${res.status}`);
    const json = JSON.parse(text);
    if (json.Response?.Error) throw new Error(json.Response.Error.Message || json.Response.Error.Code);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

module.exports = {
  summarizeWithHunyuan
};
