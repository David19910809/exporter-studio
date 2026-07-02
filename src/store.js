const fs = require("node:fs");
const path = require("node:path");

const DATA_DIR = path.resolve(process.env.EXPORTER_STUDIO_DATA_DIR || path.join(process.cwd(), ".elmp"));
const STORE_FILE = path.join(DATA_DIR, "store.json");

const DEFAULT_EXPORTER = {
  id: "snmp_exporter",
  name: "snmp_exporter",
  officialRepo: "https://github.com/prometheus/snmp_exporter",
  upstreamRemote: "upstream",
  officialBranch: "main",
  officialBaseline: "v0.30.0",
  minorVersion: "v0.30.0",
  minorVersionNote: "默认官方基线",
  monitoringSystem: "统一监控平台",
  department: "网络运维部",
  contactName: "张工",
  contactInfo: "ops@example.com",
  localBranch: "cmg/snmp_exporter",
  companyBranch: "cmg/snmp_exporter",
  localVersion: "snmp_exporter-internal-1.0.0",
  customDir: "custom",
  exporterConfig: {
    path: ".exporter.yaml",
    schemaVersion: "v1"
  },
  companyExt: {
    path: "company/ext",
    interfaceVersion: "v1",
    registryHook: "company/ext/registry.go:RegisterCompanyExt",
    description: "稳定扩展接口，官方代码只保留最小接入点。"
  },
  officialArtifacts: [],
  collectorRegistryHook: {
    file: "company/ext/registry.go",
    symbol: "RegisterCompanyExt",
    strategy: "stable-hook",
    description: "官方主干只保留 company/ext 稳定接口，custom 能力包在构建期装配。"
  },
  customManifest: {
    path: "custom/custom.yaml",
    schemaVersion: "v1",
    compileMode: "source-build",
    entries: ["authtest"]
  },
  trunkChanges: [
    {
      id: "hook-registry",
      file: "company/ext/registry.go",
      type: "company-ext-hook",
      risk: "low",
      summary: "增加 company/ext 稳定接口，用于装配 custom/custom.yaml 中选择的能力包。"
    }
  ],
  status: "active",
  customItems: [
    {
      id: "authtest",
      packageId: "authtest",
      name: "测试认证",
      type: "security",
      kind: "security",
      sourcePath: "custom/capabilities/authtest/capability.go",
      mountPath: "custom/capabilities/authtest/capability.go",
      description: "要求访问指标时携带 testauth 请求头",
      status: "enabled"
    }
  ],
  diffs: [
    {
      id: "diff-authtest",
      file: "custom/capabilities/authtest/capability.go",
      change: "选择 custom 能力包",
      risk: "low",
      boundary: "custom-package",
      summary: "选择测试认证能力包，通过 custom/custom.yaml 装配，不改动官方主分支代码。"
    }
  ],
  builds: [
    {
      id: "build-demo",
      version: "snmp_exporter-internal-1.0.0+custom.1",
      sourceBranch: "cmg/snmp_exporter",
      baseline: "v0.30.0",
      customCount: 1,
      manifestPath: "custom/snmp_exporter/custom.manifest.json",
      registryHook: "collector/registry_custom.go:RegisterCustomCollectors",
      compileMode: "source-build",
      trunkChangeCount: 1,
      status: "success",
      artifact: "registry.internal/exporters/snmp_exporter:internal-1.0.0-custom.1",
      createdAt: new Date().toISOString()
    }
  ],
  instances: [
    {
      id: "dc-a-snmp-01",
      name: "A 区 SNMP Exporter 01",
      environment: "prod",
      address: "10.10.1.21:9116",
      runningVersion: "snmp_exporter-internal-1.0.0+custom.1",
      baseline: "v0.30.0",
      status: "running",
      updatedAt: new Date().toISOString()
    }
  ]
};

const DEFAULT_STATE = {
  selectedExporterId: DEFAULT_EXPORTER.id,
  exporterCatalog: createDefaultCatalog(),
  capabilityPackages: [
    {
      id: "authtest",
      name: "????",
      kind: "security",
      type: "security",
      version: "1.0.0",
      description: "????????? testauth ????",
      owner: "????",
      import_path: "example.com/exporter/custom/capabilities/authtest",
      source: "custom/capabilities/authtest",
      sourcePath: "custom/capabilities/authtest/capability.go",
      default_enabled: false,
      provides: ["security:testauth"],
      requires: [],
      metrics: [],
      config: { header: "testauth" },
      compatible: { exporters: ["*"], min_version: "", max_version: "" },
      files: ["custom/capabilities/authtest/capability.go"],
      status: "active"
    }
  ],
  exporters: [DEFAULT_EXPORTER],
  activity: [
    {
      id: "activity-demo",
      title: "系统初始化完成",
      detail: "已创建 snmp_exporter 示例数据，可直接维护官方基线、本地分支和 custom 定制内容。",
      createdAt: new Date().toISOString()
    }
  ]
};

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(DEFAULT_STATE, null, 2), "utf8");
  }
}

function loadState() {
  ensureStore();
  const state = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  return normalizeState(state);
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(normalizeState(state), null, 2), "utf8");
  return state;
}

function resetState() {
  saveState(structuredClone(DEFAULT_STATE));
}

function normalizeState(state) {
  if (Array.isArray(state.exporters) && state.exporters.length === 0) {
    return {
      selectedExporterId: "",
      exporterCatalog: Array.isArray(state.exporterCatalog) && state.exporterCatalog.length
        ? state.exporterCatalog.map(normalizeCatalogItem)
        : createDefaultCatalog(),
      capabilityPackages: Array.isArray(state.capabilityPackages) && state.capabilityPackages.length
        ? state.capabilityPackages.map(normalizeCapabilityPackage)
        : [],
      exporters: [],
      activity: Array.isArray(state.activity) ? state.activity : []
    };
  }

  if (Array.isArray(state.exporters) && state.exporters.length) {
    return {
      selectedExporterId: state.selectedExporterId || state.exporters[0].id,
      exporterCatalog: Array.isArray(state.exporterCatalog) && state.exporterCatalog.length
        ? state.exporterCatalog.map(normalizeCatalogItem)
        : createDefaultCatalog(),
      capabilityPackages: Array.isArray(state.capabilityPackages) && state.capabilityPackages.length
        ? state.capabilityPackages.map(normalizeCapabilityPackage)
        : collectCapabilityPackages(state.exporters),
      exporters: state.exporters.map(normalizeExporter),
      activity: Array.isArray(state.activity) ? state.activity : []
    };
  }

  const migrated = structuredClone(DEFAULT_STATE);
  const exporter = migrated.exporters[0];
  if (state.registry?.exporter) {
    exporter.id = state.registry.exporter;
    exporter.name = state.registry.exporter;
    exporter.localVersion = `${state.registry.exporter}-internal-1.0.0`;
    exporter.customDir = `custom/${state.registry.exporter}`;
  }
  if (state.official?.upstreamUrl) exporter.officialRepo = state.official.upstreamUrl;
  if (state.official?.versions?.length) exporter.officialBaseline = state.official.versions.at(-1);
  if (state.registry?.base_version) exporter.localBranch = `cmg/${state.registry.base_version}`;
  migrated.selectedExporterId = exporter.id;
  return migrated;
}

function createDefaultCatalog() {
  return [
    catalogItem("node_exporter", "主机指标", "prometheus", "node_exporter", "https://github.com/prometheus/node_exporter"),
    catalogItem("blackbox_exporter", "黑盒探测", "prometheus", "blackbox_exporter", "https://github.com/prometheus/blackbox_exporter"),
    catalogItem("snmp_exporter", "SNMP 设备", "prometheus", "snmp_exporter", "https://github.com/prometheus/snmp_exporter"),
    catalogItem("mysqld_exporter", "MySQL", "prometheus", "mysqld_exporter", "https://github.com/prometheus/mysqld_exporter"),
    catalogItem("postgres_exporter", "PostgreSQL", "prometheus-community", "postgres_exporter", "https://github.com/prometheus-community/postgres_exporter"),
    catalogItem("redis_exporter", "Redis", "oliver006", "redis_exporter", "https://github.com/oliver006/redis_exporter"),
    catalogItem("windows_exporter", "Windows", "prometheus-community", "windows_exporter", "https://github.com/prometheus-community/windows_exporter"),
    catalogItem("jmx_exporter", "JMX / Java", "prometheus", "jmx_exporter", "https://github.com/prometheus/jmx_exporter"),
    catalogItem("elasticsearch_exporter", "Elasticsearch", "prometheus-community", "elasticsearch_exporter", "https://github.com/prometheus-community/elasticsearch_exporter")
  ];
}

function catalogItem(id, category, owner, repo, officialRepo) {
  return {
    id,
    name: id,
    category,
    owner,
    repo,
    officialRepo,
    officialBranch: "main",
    latestVersion: "待同步",
    latestPublishedAt: null,
    updateSummary: "尚未同步 GitHub Release。",
    releaseUrl: officialRepo,
    packages: [],
    syncStatus: "pending",
    syncedAt: null
  };
}

function normalizeCatalogItem(item) {
  const fallback = catalogItem(item.id || item.name, item.category || "其他", item.owner || "", item.repo || item.id || item.name, item.officialRepo || "");
  return {
    ...fallback,
    ...item,
    latestVersion: item.latestVersion || "待同步",
    updateSummary: item.updateSummary || "尚未同步 GitHub Release。",
    packages: Array.isArray(item.packages) ? item.packages : [],
    syncStatus: item.syncStatus || "pending"
  };
}

function normalizeExporter(exporter) {
  return {
    id: exporter.id || exporter.name,
    name: exporter.name || exporter.id,
    officialRepo: exporter.officialRepo || "",
    upstreamRemote: exporter.upstreamRemote || "upstream",
    officialBranch: exporter.officialBranch || "main",
    officialBaseline: exporter.officialBaseline || "v0.1.0",
    minorVersion: exporter.minorVersion || exporter.officialBaseline || "v0.1.0",
    minorVersionNote: exporter.minorVersionNote || "",
    officialPackageId: exporter.officialPackageId || "",
    officialPackageSource: exporter.officialPackageSource || "",
    officialPackageFileName: exporter.officialPackageFileName || "",
    exporterConfig: exporter.exporterConfig || {
      path: ".exporter.yaml",
      schemaVersion: "v1"
    },
    companyExt: exporter.companyExt || {
      path: "company/ext",
      interfaceVersion: "v1",
      registryHook: "company/ext/registry.go:RegisterCompanyExt",
      description: "稳定扩展接口，官方代码只保留最小接入点。"
    },
    monitoringSystem: exporter.monitoringSystem || "未登记",
    department: exporter.department || "未登记",
    contactName: exporter.contactName || "未登记",
    contactInfo: exporter.contactInfo || "",
    localBranch: normalizeCmgBranch(exporter.localBranch, exporter.name || exporter.id),
    companyBranch: normalizeCmgBranch(exporter.companyBranch || exporter.localBranch, exporter.name || exporter.id),
    localVersion: exporter.localVersion || `${exporter.id || exporter.name}-internal-1.0.0`,
    customDir: exporter.customDir || "custom",
    collectorRegistryHook: exporter.collectorRegistryHook || {
      file: "collector/registry_custom.go",
      symbol: "RegisterCustomCollectors",
      strategy: "stable-hook",
      description: "通过稳定 registry hook 注册 custom collector。"
    },
    customManifest: exporter.customManifest || {
      path: "custom/custom.yaml",
      schemaVersion: "v1",
      compileMode: "source-build",
      entries: []
    },
    trunkChanges: Array.isArray(exporter.trunkChanges) ? exporter.trunkChanges : [],
    officialArtifacts: Array.isArray(exporter.officialArtifacts) ? exporter.officialArtifacts : [],
    status: exporter.status || "active",
    customItems: Array.isArray(exporter.customItems) ? exporter.customItems : [],
    diffs: Array.isArray(exporter.diffs) ? exporter.diffs : [],
    builds: Array.isArray(exporter.builds) ? exporter.builds : [],
    instances: Array.isArray(exporter.instances) ? exporter.instances : []
  };
}

function normalizeCapabilityPackage(pkg) {
  const id = pkg.id || pkg.packageId || pkg.name;
  const kind = pkg.kind || pkg.type || pkg.extensionPoint || "metric";
  const sourcePath = pkg.sourcePath || pkg.path || `custom/capabilities/${id}/capability.go`;
  return {
    id,
    packageId: id,
    name: pkg.name || id,
    kind,
    type: kind,
    version: pkg.version || "1.0.0",
    sourcePath,
    import_path: pkg.import_path || `example.com/exporter/${sourcePath.replace(/\\/g, "/").replace(/\/[^/]+\.go$/, "")}`,
    source: pkg.source || sourcePath,
    default_enabled: Boolean(pkg.default_enabled ?? pkg.defaultEnabled ?? false),
    provides: Array.isArray(pkg.provides) ? pkg.provides : [kind],
    requires: Array.isArray(pkg.requires) ? pkg.requires : [],
    metrics: Array.isArray(pkg.metrics) ? pkg.metrics : [],
    config: pkg.config && typeof pkg.config === "object" ? pkg.config : {},
    compatible: pkg.compatible && typeof pkg.compatible === "object" ? pkg.compatible : { exporters: ["*"], min_version: "", max_version: "" },
    files: Array.isArray(pkg.files) && pkg.files.length ? pkg.files : [sourcePath],
    entry: pkg.entry || "",
    description: pkg.description || "可复用 custom 能力包",
    owner: pkg.owner || "未登记",
    status: pkg.status || "active",
    editableCode: pkg.editableCode || "",
    generatedCode: pkg.generatedCode || "",
    validation: pkg.validation || { status: "unknown", errors: [] },
    updatedAt: pkg.updatedAt || new Date().toISOString()
  };
}

function collectCapabilityPackages(exporters = []) {
  const packages = new Map();
  exporters.forEach((exporter) => {
    (exporter.customItems || []).forEach((item) => {
      const normalized = normalizeCapabilityPackage({
        ...item,
        id: item.packageId || item.id,
        sourcePath: item.sourcePath || item.path
      });
      packages.set(normalized.id, normalized);
    });
  });
  return Array.from(packages.values());
}

function normalizeCmgBranch(branch, exporterName) {
  const name = String(exporterName || "exporter").trim();
  const current = String(branch || "").trim();
  if (!current) return `cmg/${name}`;
  if (current.startsWith("company/")) return `cmg/${current.slice("company/".length)}`;
  return current;
}

module.exports = {
  DATA_DIR,
  STORE_FILE,
  DEFAULT_STATE,
  ensureStore,
  loadState,
  resetState,
  saveState
};
