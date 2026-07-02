const PATCH_TYPES = new Set(["metric", "collector", "auth", "plugin", "config"]);
const PATCH_STATUSES = new Set(["active", "disabled", "conflict", "draft"]);

function createMetric(name, type = "gauge", labels = {}, source = "patch") {
  return {
    name,
    type,
    value: 0,
    labels,
    source
  };
}

function createPatch(input) {
  const patch = {
    id: input.id,
    name: input.name || input.id,
    baseVersion: input.baseVersion || input.base || "base-v1",
    type: input.type || inferPatchType(input.ir),
    files: input.files || [],
    commits: input.commits || [],
    status: input.status || "draft",
    dsl: input.dsl || "",
    ir: input.ir || {
      metrics: [],
      collectors: [],
      plugins: [],
      configPatches: []
    },
    conflicts: input.conflicts || []
  };

  if (!patch.id) {
    throw new Error("patch.id is required");
  }
  if (!PATCH_TYPES.has(patch.type)) {
    throw new Error(`unsupported patch type: ${patch.type}`);
  }
  if (!PATCH_STATUSES.has(patch.status)) {
    throw new Error(`unsupported patch status: ${patch.status}`);
  }

  return patch;
}

function inferPatchType(ir = {}) {
  if (ir.plugins?.length) return "plugin";
  if (ir.collectors?.length) return "collector";
  if (ir.configPatches?.length) return "config";
  return "metric";
}

module.exports = {
  createMetric,
  createPatch,
  PATCH_STATUSES,
  PATCH_TYPES
};
