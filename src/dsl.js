const { createPatch } = require("./models");

function parseScalar(value) {
  const raw = value.trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw.replace(/^["']|["']$/g, "");
}

function parseDsl(source) {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.replace(/\t/g, "  "))
    .filter((line) => line.trim() && !line.trim().startsWith("#"));

  const document = { patch: {}, actions: [] };
  let section = null;
  let currentAction = null;
  let nestedKey = null;

  for (const line of lines) {
    const indent = line.match(/^\s*/)[0].length;
    const text = line.trim();

    if (indent === 0 && text.endsWith(":")) {
      section = text.slice(0, -1);
      currentAction = null;
      nestedKey = null;
      continue;
    }

    if (section === "patch" && indent >= 2) {
      const [key, ...rest] = text.split(":");
      document.patch[toCamel(key)] = parseScalar(rest.join(":"));
      continue;
    }

    if (section === "actions" && text.startsWith("- ")) {
      const actionText = text.slice(2);
      const [op, ...rest] = actionText.split(":");
      currentAction = { op: toCamel(op), args: {} };
      document.actions.push(currentAction);
      nestedKey = null;
      if (rest.join(":").trim()) {
        currentAction.args.value = parseScalar(rest.join(":"));
      }
      continue;
    }

    if (section === "actions" && currentAction && indent >= 4) {
      const [key, ...rest] = text.split(":");
      const normalized = toCamel(key);
      const value = rest.join(":").trim();
      if (!value) {
        nestedKey = normalized;
        currentAction.args[nestedKey] = {};
      } else if (nestedKey && indent >= 8) {
        currentAction.args[nestedKey][normalized] = parseScalar(value);
      } else {
        nestedKey = null;
        currentAction.args[normalized] = parseScalar(value);
      }
    }
  }

  return document;
}

function compileDsl(source) {
  const ast = parseDsl(source);
  const ir = {
    metrics: [],
    collectors: [],
    plugins: [],
    configPatches: []
  };

  for (const action of ast.actions) {
    const args = action.args;
    if (action.op === "addMetric" || action.op === "removeMetric") {
      ir.metrics.push({
        op: action.op.replace("Metric", ""),
        name: args.name,
        type: args.type || "gauge"
      });
    }
    if (action.op === "addCollector" || action.op === "modifyCollector") {
      ir.collectors.push({
        op: action.op.replace("Collector", ""),
        name: args.name,
        change: args.change || {}
      });
    }
    if (action.op === "addPlugin") {
      ir.plugins.push({
        op: "add",
        id: args.id,
        source: args.source
      });
    }
    if (action.op === "configPatch") {
      ir.configPatches.push({
        op: "modify",
        path: args.path,
        change: args.change || {}
      });
    }
  }

  return {
    ast,
    ir,
    patch: createPatch({
      id: ast.patch.id,
      name: ast.patch.name || ast.patch.id,
      baseVersion: ast.patch.base || ast.patch.baseVersion,
      dsl: source,
      ir
    })
  };
}

function toCamel(value) {
  return value.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
}

module.exports = {
  compileDsl,
  parseDsl
};
