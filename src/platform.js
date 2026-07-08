const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { DATA_DIR, loadState, saveState } = require("./store");
const { summarizeWithHunyuan } = require("./hunyuan");

const UPLOAD_DIR = path.resolve(process.cwd(), ".elmp", "uploads");
const BUILD_DIR = path.join(DATA_DIR, "builds");
const GITHUB_API_BASE_URL = cleanEnv(process.env.GITHUB_API_BASE_URL || "https://api.github.com").replace(/\/+$/, "");

const CAPABILITY_KINDS = [
  "collector",
  "scraper",
  "metric",
  "transform",
  "security",
  "credential_provider",
  "discovery",
  "config_profile",
  "protocol_client",
  "cache",
  "bundle"
];

const EXTENSION_POINTS = [
  {
    id: "metric",
    kind: "metric",
    name: "Metric 指标扩展",
    description: "新增指标定义和取值逻辑，适合补充企业内部指标。",
    defaultFile: "metrics/company_metric.go",
    entryPrefix: "NewMetricExtension",
    risk: "low",
    template: `// EDITABLE: 指标取值逻辑
metric := Metric{
    Name: "company_metric",
    Type: "gauge",
    Help: "Company custom metric",
    Labels: map[string]string{"source": "custom"},
    Value: 1,
}
return []Metric{metric}, nil`
  },
  {
    id: "collector",
    kind: "collector",
    name: "Collector 采集器扩展",
    description: "新增 collector，并通过稳定 registry hook 注册。",
    defaultFile: "collectors/company_collector.go",
    entryPrefix: "NewCompanyCollector",
    risk: "medium",
    template: `// EDITABLE: Collector 采集逻辑
metrics := []Metric{}
metrics = append(metrics, Metric{
    Name: "company_collector_up",
    Type: "gauge",
    Help: "Company collector health",
    Value: 1,
})
return metrics, nil`
  },
  {
    id: "transform",
    kind: "transform",
    name: "Transform 指标转换扩展",
    description: "对采集结果做标签补充、重命名、过滤等标准化处理。",
    defaultFile: "transforms/company_transform.go",
    entryPrefix: "NewMetricTransform",
    risk: "low",
    template: `// EDITABLE: 指标转换逻辑
for i := range metrics {
    if metrics[i].Labels == nil {
        metrics[i].Labels = map[string]string{}
    }
    metrics[i].Labels["company_region"] = "default"
}
return metrics, nil`
  },
  {
    id: "scraper",
    kind: "scraper",
    name: "Scraper 服务拉取扩展",
    description: "访问 HTTP 或其他内部服务拉取数据，并转换为 exporter 指标。",
    defaultFile: "scrapers/company_scraper.go",
    entryPrefix: "NewServiceScraper",
    risk: "medium",
    template: `// EDITABLE: 外部服务拉取逻辑
endpoint := "http://127.0.0.1:8080/metrics/custom"
timeout := "3s"

// 在真实源码中由系统注入 http client、context 和超时控制。
// 这里编写请求、解析响应并生成 Metric 的核心逻辑。
_ = endpoint
_ = timeout

metric := Metric{
    Name: "external_service_up",
    Type: "gauge",
    Help: "External service scrape status",
    Labels: map[string]string{"endpoint": endpoint},
    Value: 1,
}
return []Metric{metric}, nil`
  },
  {
    id: "security",
    kind: "security",
    name: "Security 安全中间件",
    description: "为 exporter 暴露端点增加认证、授权或访问控制包装。",
    defaultFile: "security/middleware.go",
    entryPrefix: "NewSecurityMiddleware",
    risk: "medium",
    template: `// EDITABLE: 安全中间件默认透传，不影响现有行为
return next, nil`
  },
  {
    id: "credential_provider",
    kind: "credential_provider",
    name: "Credential Provider 凭据提供器",
    description: "统一读取文件、环境变量或密钥服务中的账号凭据。",
    defaultFile: "credentials/provider.go",
    entryPrefix: "NewCredentialProvider",
    risk: "medium",
    template: `// EDITABLE: 默认返回空凭据，由配置显式启用后生效
return Credentials{}, nil`
  },
  {
    id: "discovery",
    kind: "discovery",
    name: "Discovery 发现能力",
    description: "从 CMDB、服务注册中心或静态配置发现采集目标。",
    defaultFile: "discovery/discovery.go",
    entryPrefix: "NewDiscoveryProvider",
    risk: "medium",
    template: `// EDITABLE: 默认不发现额外目标
return []Target{}, nil`
  },
  {
    id: "config_profile",
    kind: "config_profile",
    name: "Config Profile 配置模板",
    description: "沉淀特定厂商或场景的默认采集配置。",
    defaultFile: "profiles/profile.go",
    entryPrefix: "NewConfigProfile",
    risk: "low",
    template: `// EDITABLE: 默认配置模板，不自动应用
return ConfigProfile{Name: "default"}, nil`
  },
  {
    id: "protocol_client",
    kind: "protocol_client",
    name: "Protocol Client 协议客户端",
    description: "封装 SNMP、HTTP 或私有协议访问客户端。",
    defaultFile: "clients/client.go",
    entryPrefix: "NewProtocolClient",
    risk: "medium",
    template: `// EDITABLE: 默认客户端占位，不发起请求
return nil, nil`
  },
  {
    id: "cache",
    kind: "cache",
    name: "Cache 缓存能力",
    description: "为慢接口或高成本请求提供构建内置缓存策略。",
    defaultFile: "cache/cache.go",
    entryPrefix: "NewCacheProvider",
    risk: "low",
    template: `// EDITABLE: 默认禁用缓存
return nil, nil`
  },
  {
    id: "bundle",
    kind: "bundle",
    name: "Bundle 组合能力包",
    description: "把多个能力包组合成面向业务场景的一键选择包。",
    defaultFile: "bundle/bundle.go",
    entryPrefix: "NewCapabilityBundle",
    risk: "low",
    template: `// EDITABLE: 默认组合清单
return []string{}, nil`
  }
];

function getCurrentExporter(state = loadState()) {
  const exporter = state.exporters.find((item) => item.id === state.selectedExporterId) || state.exporters[0];
  if (!exporter) throw new Error("没有可用的 exporter");
  return exporter;
}

function saveExporter(input = {}) {
  const state = loadState();
  const exporterName = clean(input.name || input.exporterName || input.id);
  if (!exporterName) throw new Error("Exporter 名称不能为空");
  const selectedPackage = findCatalogPackage(state, input.officialPackageId || input.officialBaselinePackageId || input.packageId);
  const requestedId = clean(input.enterpriseVersionId || input.versionId || input.id);
  const id = shouldUsePackageScopedId(requestedId, exporterName, input)
    ? makeEnterpriseVersionId(exporterName, selectedPackage?.version || input.officialBaseline || selectedPackage?.id)
    : clean(requestedId || makeEnterpriseVersionId(exporterName, selectedPackage?.version || input.officialBaseline));

  const existing = state.exporters.find((item) => item.id === id);
  const catalogItem = state.exporterCatalog.find((item) => item.id === exporterName || item.name === exporterName);
  const exporter = existing || {
    id,
    customItems: [],
    diffs: [],
    builds: [],
    instances: [],
    status: "active"
  };

  exporter.name = exporterName;
  exporter.officialRepo = clean(input.officialRepo || catalogItem?.officialRepo || exporter.officialRepo || "");
  exporter.upstreamRemote = clean(input.upstreamRemote || exporter.upstreamRemote || "upstream");
  exporter.officialBranch = clean(input.officialBranch || catalogItem?.officialBranch || "main");
  exporter.officialPackageId = selectedPackage?.id || clean(input.officialPackageId || exporter.officialPackageId || "");
  exporter.officialPackageSource = selectedPackage?.source || clean(input.officialPackageSource || exporter.officialPackageSource || "");
  exporter.officialPackageFileName = selectedPackage?.fileName || clean(input.officialPackageFileName || exporter.officialPackageFileName || "");
  exporter.officialBaseline = clean(selectedPackage?.version || input.officialBaseline);
  exporter.minorVersion = clean(input.minorVersion || exporter.officialBaseline);
  exporter.minorVersionNote = clean(input.minorVersionNote || selectedPackage?.note || selectedPackage?.updateSummary || exporter.minorVersionNote || "");
  exporter.monitoringSystem = clean(input.monitoringSystem || exporter.monitoringSystem || "未登记");
  exporter.department = clean(input.department || exporter.department || "未登记");
  exporter.contactName = clean(input.contactName || exporter.contactName || "未登记");
  exporter.contactInfo = clean(input.contactInfo || exporter.contactInfo || "");
  exporter.localBranch = normalizeCmgBranch(input.localBranch || exporter.localBranch, exporterName);
  exporter.companyBranch = normalizeCmgBranch(input.companyBranch || input.localBranch || exporter.companyBranch || exporter.localBranch, exporterName);
  exporter.localVersion = normalizeLocalVersion(input.localVersion || exporter.localVersion, exporterName);
  exporter.customDir = clean(input.customDir || exporter.customDir || "custom");
  exporter.exporterConfig = normalizeExporterConfig(exporter);
  exporter.companyExt = normalizeCompanyExt(exporter);
  exporter.officialArtifacts = Array.isArray(exporter.officialArtifacts) ? exporter.officialArtifacts : [];
  exporter.collectorRegistryHook = normalizeRegistryHook(exporter, input);
  exporter.customManifest = normalizeManifest(exporter);
  exporter.trunkChanges = normalizeTrunkChanges(exporter);

  if (!existing) state.exporters.push(exporter);
  state.selectedExporterId = exporter.id;
  addActivity(state, "Exporter 配置已保存", `${exporter.name} 绑定官方基线 ${exporter.officialBaseline}，本地分支 ${exporter.localBranch}。`);
  saveState(state);
  return exporter;
}

function uploadOfficialVersion(input = {}) {
  const state = loadState();
  const catalogId = clean(input.catalogId || input.exporterId || input.id || state.selectedExporterId);
  const catalog = state.exporterCatalog.find((item) => item.id === catalogId || item.name === catalogId);
  if (!catalog) throw new Error(`Exporter 目录不存在：${catalogId}`);

  const fileName = sanitizeFileName(input.fileName || "");
  const version = clean(input.version || parseVersionFromFileName(fileName) || catalog.latestVersion);
  const contentBase64 = clean(input.contentBase64 || "");
  if (!version) throw new Error("官方版本号不能为空");
  if (!fileName) throw new Error("上传文件名不能为空");
  if (!contentBase64) throw new Error("请选择需要上传的官方版本文件");

  const buffer = Buffer.from(contentBase64, "base64");
  if (!buffer.length) throw new Error("上传文件内容为空");

  const dir = path.join(UPLOAD_DIR, "catalog", sanitizeFileName(catalog.id), sanitizeFileName(version));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileName);
  fs.writeFileSync(target, buffer);

  const pkg = createVersionPackage({
    id: `upload-${hash(`${catalog.id}-${version}-${fileName}-${Date.now()}`)}`,
    exporterId: catalog.id,
    exporterName: catalog.name,
    version,
    source: "manual-upload",
    fileName,
    size: buffer.length,
    checksum: crypto.createHash("sha256").update(buffer).digest("hex"),
    storagePath: target,
    releaseUrl: "",
    publishedAt: new Date().toISOString(),
    updateSummary: clean(input.note || "") || "手动上传的固定官方版本包",
    summarySource: "manual",
    syncStatus: "success",
    note: clean(input.note || ""),
    uploadedAt: new Date().toISOString()
  });

  catalog.packages = upsertVersionPackage(catalog.packages, pkg);
  catalog.latestVersion = version;
  catalog.latestPublishedAt = pkg.publishedAt;
  catalog.updateSummary = pkg.updateSummary;
  catalog.releaseUrl = catalog.officialRepo;
  catalog.summarySource = pkg.summarySource;
  catalog.syncStatus = "success";
  catalog.syncedAt = new Date().toISOString();

  addActivity(state, "官方版本包已上传", `${catalog.name} 目录新增 ${version}：${fileName}`);
  saveState(state);
  return pkg;
}

function selectExporter(id) {
  const state = loadState();
  if (!state.exporters.some((item) => item.id === id)) throw new Error(`Exporter 不存在：${id}`);
  state.selectedExporterId = id;
  saveState(state);
  return getCurrentExporter(state);
}

function addCustomItem(input = {}) {
  const state = loadState();
  const exporter = getCurrentExporter(state);
  const id = clean(input.id || `custom-${Date.now()}`);
  const packageId = clean(input.packageId || id);
  const extensionPoint = getExtensionPoint(input.kind || input.extensionPoint || input.type || "metric");
  const editableCode = Object.prototype.hasOwnProperty.call(input, "editableCode")
    ? clean(input.editableCode)
    : extensionPoint.template;
  const abilityPackage = {
    id: packageId,
    name: clean(input.name || id),
    kind: extensionPoint.kind || extensionPoint.id,
    type: extensionPoint.kind || extensionPoint.id,
    version: clean(input.packageVersion || "1.0.0"),
    sourcePath: clean(input.path || `${exporter.customDir}/capabilities/${packageId}/${extensionPoint.defaultFile}`),
    entry: clean(input.entry || `${extensionPoint.entryPrefix}_${toPascal(id)}`),
    description: clean(input.description || "可复用 custom 能力包"),
    owner: clean(input.owner || "平台团队"),
    status: "active",
    provides: Array.isArray(input.provides) ? input.provides : undefined,
    requires: Array.isArray(input.requires) ? input.requires : undefined,
    metrics: Array.isArray(input.metrics) ? input.metrics : undefined,
    config: input.config && typeof input.config === "object" ? input.config : undefined,
    compatible: input.compatible && typeof input.compatible === "object" ? input.compatible : undefined,
    files: Array.isArray(input.files) ? input.files : undefined,
    editableCode,
    generatedCode: renderGeneratedSource(exporter, extensionPoint, {
      id,
      name: clean(input.name || id),
      path: clean(input.path || `${exporter.customDir}/capabilities/${packageId}/${extensionPoint.defaultFile}`),
      entry: clean(input.entry || `${extensionPoint.entryPrefix}_${toPascal(id)}`),
      description: clean(input.description || "可复用 custom 能力包"),
      editableCode
    }),
    validation: validateEditableCode(extensionPoint, editableCode)
  };
  Object.assign(abilityPackage, createCapabilityInfo(abilityPackage, exporter));
  abilityPackage.generatedCode = renderGeneratedSource(exporter, extensionPoint, abilityPackage);
  state.capabilityPackages = upsertCapabilityPackage(state.capabilityPackages, abilityPackage);

  const item = {
    id,
    selectionId: `select-${hash(`${exporter.id}-${packageId}`)}`,
    packageId,
    packageVersion: abilityPackage.version,
    name: clean(input.name || id),
    exporterId: exporter.id,
    scope: "selected-package",
    companyBranch: exporter.companyBranch || exporter.localBranch,
    officialBaseline: exporter.officialBaseline,
    officialPackageId: exporter.officialPackageId || "",
    customConfigPath: "custom/custom.yaml",
    companyExtPath: exporter.companyExt?.path || "company/ext",
    customDir: exporter.customDir,
    kind: abilityPackage.kind,
    type: abilityPackage.kind,
    extensionPoint: abilityPackage.kind,
    extensionPointName: extensionPoint.name,
    path: abilityPackage.sourcePath,
    sourcePath: abilityPackage.sourcePath,
    entry: abilityPackage.entry,
    description: abilityPackage.description,
    editableCode,
    generatedCode: abilityPackage.generatedCode,
    validation: abilityPackage.validation,
    status: "enabled"
  };

  exporter.customItems = exporter.customItems.filter((entry) => entry.id !== id).concat(item);
  exporter.customManifest = normalizeManifest(exporter);
  exporter.diffs = generateDiffs(exporter);
  addActivity(state, "定制内容已保存", `${item.name} 已写入 ${item.path}。`);
  saveState(state);
  return item;
}

function saveCapabilityPackage(input = {}) {
  const state = loadState();
  const id = clean(input.id || input.packageId || `pkg-${Date.now()}`);
  if (!id) throw new Error("能力包 ID 不能为空");
  const extensionPoint = getExtensionPoint(input.kind || input.extensionPoint || input.type || "metric");
  const editableCode = Object.prototype.hasOwnProperty.call(input, "editableCode")
    ? clean(input.editableCode)
    : extensionPoint.template;
  const pkg = {
    id,
    name: clean(input.name || id),
    kind: extensionPoint.kind || extensionPoint.id,
    type: extensionPoint.kind || extensionPoint.id,
    version: clean(input.packageVersion || input.version || "1.0.0"),
    sourcePath: clean(input.path || input.sourcePath || `custom/capabilities/${id}/${extensionPoint.defaultFile}`),
    entry: clean(input.entry || `${extensionPoint.entryPrefix}_${toPascal(id)}`),
    description: clean(input.description || "可复用 custom 能力包"),
    owner: clean(input.owner || "平台团队"),
    status: clean(input.status || "active"),
    provides: Array.isArray(input.provides) ? input.provides : undefined,
    requires: Array.isArray(input.requires) ? input.requires : undefined,
    metrics: Array.isArray(input.metrics) ? input.metrics : undefined,
    config: input.config && typeof input.config === "object" ? input.config : undefined,
    compatible: input.compatible && typeof input.compatible === "object" ? input.compatible : undefined,
    files: Array.isArray(input.files) ? input.files : undefined,
    editableCode,
    generatedCode: renderGeneratedSource({ collectorRegistryHook: { symbol: "RegisterCompanyExt" } }, extensionPoint, {
      id,
      name: clean(input.name || id),
      path: clean(input.path || input.sourcePath || `custom/capabilities/${id}/${extensionPoint.defaultFile}`),
      entry: clean(input.entry || `${extensionPoint.entryPrefix}_${toPascal(id)}`),
      editableCode
    }),
    validation: validateEditableCode(extensionPoint, editableCode),
    updatedAt: new Date().toISOString()
  };
  Object.assign(pkg, createCapabilityInfo(pkg, getCurrentExporter(state)));
  pkg.generatedCode = renderGeneratedSource(getCurrentExporter(state), extensionPoint, pkg);
  state.capabilityPackages = upsertCapabilityPackage(state.capabilityPackages, pkg);
  addActivity(state, "能力包已保存", `${pkg.name} 已作为可复用资产保存。`);
  saveState(state);
  return pkg;
}

function disableCustomItem(id) {
  const state = loadState();
  const exporter = getCurrentExporter(state);
  const item = exporter.customItems.find((entry) => entry.id === id);
  if (!item) throw new Error(`定制内容不存在：${id}`);
  item.status = "disabled";
  exporter.customManifest = normalizeManifest(exporter);
  exporter.diffs = generateDiffs(exporter);
  addActivity(state, "定制内容已停用", `${item.name} 不再参与后续构建。`);
  saveState(state);
  return item;
}

function deleteCustomItem(id) {
  const state = loadState();
  const exporter = getCurrentExporter(state);
  const item = exporter.customItems.find((entry) => entry.id === id);
  if (!item) throw new Error(`定制内容不存在：${id}`);
  exporter.customItems = exporter.customItems.filter((entry) => entry.id !== id);
  exporter.customManifest = normalizeManifest(exporter);
  exporter.diffs = generateDiffs(exporter);
  addActivity(state, "定制内容已删除", `${item.name} 已从系统中移除。`);
  saveState(state);
  return { id, status: "deleted" };
}

function refreshDiffs() {
  const state = loadState();
  const exporter = getCurrentExporter(state);
  exporter.diffs = generateDiffs(exporter);
  addActivity(state, "代码差异已刷新", `${exporter.name} 当前有 ${exporter.diffs.length} 条 custom 差异。`);
  saveState(state);
  return exporter.diffs;
}

function createBuild(input = {}) {
  const state = loadState();
  const exporter = getCurrentExporter(state);
  const selectedPackage = findCatalogPackage(state, input.officialPackageId || exporter.officialPackageId || exporter.officialBaseline);
  if (selectedPackage) {
    exporter.officialPackageId = selectedPackage.id;
    exporter.officialPackageSource = selectedPackage.source;
    exporter.officialPackageFileName = selectedPackage.fileName;
    exporter.officialBaseline = selectedPackage.version;
  }
  if (Array.isArray(input.selectedPackageIds)) {
    const selectedPackageIds = expandSelectedPackageIds(state, input.selectedPackageIds);
    exporter.customItems = selectedPackageIds
      .map((packageId) => {
        const pkg = (state.capabilityPackages || []).find((item) => item.id === packageId);
        return pkg ? createPackageSelection(exporter, pkg) : null;
      })
      .filter(Boolean);
    exporter.customManifest = normalizeManifest(exporter);
    exporter.diffs = generateDiffs(exporter);
  }
  const enabledCustom = exporter.customItems.filter((item) => item.status === "enabled");
  const selectedPackages = enabledCustom.map((item) => resolveSelectedPackage(state, item));
  const assemblyValidation = validateCapabilityAssembly(exporter, selectedPackages);
  const sequence = exporter.builds.length + 1;
  exporter.localVersion = normalizeLocalVersion(exporter.localVersion, exporter.name || exporter.id);
  const requestedVersion = clean(input.version);
  const version = requestedVersion && requestedVersion.startsWith(`${exporter.name}-`)
    ? requestedVersion
    : `${exporter.localVersion}+custom.${sequence}`;
  const lockFile = createCustomLock(exporter, selectedPackages, version);
  const buildConfig = createBuildConfig(exporter, selectedPackages, input);
  const build = {
    id: `build-${Date.now()}`,
    exporterName: exporter.name,
    version,
    sourceBranch: exporter.localBranch,
    upstream: `${exporter.upstreamRemote || "upstream"}/${exporter.officialBranch}`,
    companyBranch: exporter.companyBranch || exporter.localBranch,
    baseline: exporter.officialBaseline,
    officialPackageId: exporter.officialPackageId || "",
    officialPackageSource: exporter.officialPackageSource || "",
    officialPackageFileName: exporter.officialPackageFileName || "",
    officialPackage: selectedPackage || null,
    target: resolveBuildTarget(exporter, selectedPackage),
    customCount: selectedPackages.length,
    customItemIds: selectedPackages.map((item) => item.selectionId || item.id),
    customItemNames: selectedPackages.map((item) => item.name),
    selectedPackages,
    assemblyValidation,
    customDir: exporter.customDir,
    exporterConfigPath: exporter.exporterConfig?.path || ".exporter.yaml",
    companyExtPath: exporter.companyExt?.path || "company/ext",
    customConfigPath: "custom/custom.yaml",
    lockFilePath: "custom/custom.lock.yaml",
    generatedAssemblyPath: "custom/all/all_gen.go",
    generatedRegistryPath: "company/ext/capabilities_gen.go",
    buildInfoPath: "dist/build-info.json",
    manifestPath: "custom/custom.yaml",
    registryHook: `${exporter.collectorRegistryHook.file}:${exporter.collectorRegistryHook.symbol}`,
    compileMode: exporter.customManifest.compileMode,
    buildConfig,
    lockFile,
    manualConfig: {
      note: clean(input.note || ""),
      patchNote: clean(input.patchNote || ""),
      args: clean(input.args || ""),
      operator: clean(input.operator || "")
    },
    tags: normalizeTags(input.tags),
    buildInfo: {
      path: "dist/build-info.json",
      exporter: exporter.id,
      version,
      baseline: exporter.officialBaseline,
      target: resolveBuildTarget(exporter, selectedPackage),
      packageCount: selectedPackages.length,
      assemblyValidation,
      generatedFiles: [
        "go.mod",
        "company/ext/capability.go",
        "company/ext/registry.go",
        "custom/all/all_gen.go",
        "company/ext/capabilities_gen.go",
        "custom/custom.lock.yaml",
        "dist/build-info.json"
      ],
      generatedAt: new Date().toISOString()
    },
    trunkChangeCount: exporter.trunkChanges.length,
    status: "success",
    artifact: `registry.internal/exporters/${exporter.id}:${version.replaceAll("+", "-")}`,
    createdAt: new Date().toISOString()
  };
  const artifact = buildRealExporterArtifact(exporter, build);
  Object.assign(build, artifact);
  exporter.builds.unshift(build);
  exporter.localVersion = version;
  enabledCustom.forEach((item) => {
    item.lastBuiltVersion = version;
    item.companyBranch = exporter.companyBranch || exporter.localBranch;
    item.officialBaseline = exporter.officialBaseline;
    item.officialPackageId = exporter.officialPackageId || "";
  });
  exporter.customManifest = normalizeManifest(exporter);
  addActivity(state, "构建发布完成", `${exporter.name} 已生成内部版本 ${version}。`);
  saveState(state);
  return build;
}

function deleteBuild(buildId) {
  const state = loadState();
  const id = clean(buildId);
  if (!id) throw new Error("构建记录 ID 不能为空");
  for (const exporter of state.exporters || []) {
    const index = (exporter.builds || []).findIndex((item) => item.id === id);
    if (index < 0) continue;
    const [build] = exporter.builds.splice(index, 1);
    const buildDir = path.join(BUILD_DIR, sanitizeFileName(id));
    const resolved = path.resolve(buildDir);
    const resolvedBuildRoot = path.resolve(BUILD_DIR);
    if ((resolved === resolvedBuildRoot || resolved.startsWith(`${resolvedBuildRoot}${path.sep}`)) && fs.existsSync(resolved)) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
    addActivity(state, "构建记录已删除", `${exporter.name} / ${build.version} 已从构建记录中移除。`);
    saveState(state);
    return { id, status: "deleted" };
  }
  throw new Error(`构建记录不存在：${id}`);
}

function updateBuildTags(input = {}) {
  const state = loadState();
  const id = clean(input.buildId || input.id);
  if (!id) throw new Error("构建记录 ID 不能为空");
  for (const exporter of state.exporters || []) {
    const build = (exporter.builds || []).find((item) => item.id === id);
    if (!build) continue;
    build.tags = normalizeTags(input.tags);
    addActivity(state, "构建标签已更新", `${build.version}：${build.tags.join("、") || "无标签"}`);
    saveState(state);
    return build;
  }
  throw new Error(`构建记录不存在：${id}`);
}

function createPackageSelection(exporter, pkg) {
  return {
    id: pkg.id,
    selectionId: `select-${hash(`${exporter.id}-${pkg.id}`)}`,
    packageId: pkg.id,
    packageVersion: pkg.version || "1.0.0",
    name: pkg.name,
    exporterId: exporter.id,
    scope: "selected-package",
    companyBranch: exporter.companyBranch || exporter.localBranch,
    officialBaseline: exporter.officialBaseline,
    officialPackageId: exporter.officialPackageId || "",
    customConfigPath: "custom/custom.yaml",
    companyExtPath: exporter.companyExt?.path || "company/ext",
    customDir: exporter.customDir || "custom",
    kind: pkg.kind || pkg.type,
    type: pkg.kind || pkg.type,
    extensionPoint: pkg.kind || pkg.type,
    extensionPointName: getExtensionPoint(pkg.kind || pkg.type).name,
    path: pkg.sourcePath,
    sourcePath: pkg.sourcePath,
    import_path: pkg.import_path || "",
    source: pkg.source || pkg.sourcePath,
    default_enabled: Boolean(pkg.default_enabled ?? false),
    provides: pkg.provides || [],
    requires: pkg.requires || [],
    metrics: pkg.metrics || [],
    config: pkg.config || {},
    compatible: pkg.compatible || {},
    files: pkg.files || [pkg.sourcePath],
    entry: pkg.entry,
    description: pkg.description,
    editableCode: pkg.editableCode || "",
    generatedCode: pkg.generatedCode || "",
    validation: pkg.validation || { status: "unknown", errors: [] },
    status: "enabled"
  };
}

function expandSelectedPackageIds(state, packageIds) {
  const packages = state.capabilityPackages || [];
  const ordered = [];
  const seen = new Set();
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));

  function findPackage(ref) {
    return byId.get(ref) || packages.find((pkg) => (pkg.provides || []).includes(ref));
  }

  function visit(ref) {
    const pkg = findPackage(ref);
    if (!pkg || seen.has(pkg.id)) return;
    seen.add(pkg.id);
    (pkg.requires || []).forEach(visit);
    ordered.push(pkg.id);
  }

  packageIds.forEach(visit);
  return ordered;
}

function validateCapabilityAssembly(exporter, packages) {
  const selectedIds = new Set(packages.map((pkg) => pkg.packageId || pkg.id));
  const provided = new Set(packages.flatMap((pkg) => [pkg.packageId || pkg.id, ...(pkg.provides || [])]));
  const packageReports = packages.map((pkg) => validateCapabilityPackageAssembly(exporter, pkg, selectedIds, provided));
  const errors = packageReports.flatMap((item) => item.errors.map((message) => `${item.packageId}: ${message}`));
  const warnings = packageReports.flatMap((item) => item.warnings.map((message) => `${item.packageId}: ${message}`));
  return {
    ok: errors.length === 0,
    checkedAt: new Date().toISOString(),
    packageCount: packages.length,
    kindCoverage: Object.fromEntries(CAPABILITY_KINDS.map((kind) => [kind, packages.filter((pkg) => (pkg.kind || pkg.type) === kind).length])),
    packages: packageReports,
    errors,
    warnings
  };
}

function validateCapabilityPackageAssembly(exporter, pkg, selectedIds, provided) {
  const kind = pkg.kind || pkg.type || "";
  const report = {
    packageId: pkg.packageId || pkg.id,
    name: pkg.name,
    kind,
    status: "passed",
    checks: [],
    errors: [],
    warnings: []
  };

  addCheck(report, CAPABILITY_KINDS.includes(kind), `kind ${kind || "(empty)"} is supported`);
  addCheck(report, Boolean(pkg.sourcePath || pkg.source), "source path is declared");
  addCheck(report, Boolean(pkg.import_path), "import path is declared");
  addCheck(report, Array.isArray(pkg.files) && pkg.files.length > 0, "source files are declared");

  const compatibleExporters = pkg.compatible?.exporters || ["*"];
  const exporterKeys = [exporter.id, exporter.name].filter(Boolean);
  const compatible = compatibleExporters.includes("*") || exporterKeys.some((key) => compatibleExporters.includes(key));
  addCheck(report, compatible, `compatible with ${exporter.name || exporter.id}`);

  (pkg.requires || []).forEach((required) => {
    addCheck(report, selectedIds.has(required) || provided.has(required), `required capability ${required} is selected or provided`);
  });

  if (["collector", "scraper", "metric"].includes(kind) && !(pkg.metrics || []).length) {
    report.warnings.push(`${kind} package does not declare metrics metadata`);
  }
  if (kind === "security") report.checks.push({ ok: true, message: "runtime /metrics access will be protected by auth middleware" });
  if (kind === "credential_provider") addCheck(report, Boolean((pkg.provides || []).find((item) => item.includes("credential")) || Object.keys(pkg.config || {}).length), "credential provider exposes provider metadata");
  if (kind === "config_profile") addCheck(report, Object.keys(pkg.config || {}).length > 0 || (pkg.provides || []).some((item) => item.includes("config_profile")), "config profile exposes config metadata");
  if (kind === "bundle") addCheck(report, (pkg.requires || []).length > 0, "bundle declares package dependencies");

  report.status = report.errors.length ? "failed" : report.warnings.length ? "warning" : "passed";
  return report;
}

function addCheck(report, ok, message) {
  report.checks.push({ ok: Boolean(ok), message });
  if (!ok) report.errors.push(message);
}

function saveInstance(input = {}) {
  const state = loadState();
  const exporter = getCurrentExporter(state);
  const id = clean(input.id || input.name);
  if (!id) throw new Error("实例 ID 不能为空");
  const instance = {
    id,
    name: clean(input.name || id),
    environment: clean(input.environment || "prod"),
    address: clean(input.address || ""),
    runningVersion: clean(input.runningVersion || exporter.localVersion),
    baseline: clean(input.baseline || exporter.officialBaseline),
    status: clean(input.status || "running"),
    updatedAt: new Date().toISOString()
  };
  exporter.instances = exporter.instances.filter((item) => item.id !== id).concat(instance);
  addActivity(state, "运行实例已登记", `${instance.name} 当前运行 ${instance.runningVersion}。`);
  saveState(state);
  return instance;
}

function deleteInstance(id) {
  const state = loadState();
  const exporter = getCurrentExporter(state);
  exporter.instances = exporter.instances.filter((item) => item.id !== id);
  addActivity(state, "运行实例已删除", `${id} 已从实例列表移除。`);
  saveState(state);
  return { id, status: "deleted" };
}

function getBuildDownload(buildId, file) {
  const state = loadState();
  const found = findBuildRecord(state, buildId);
  const exporter = found?.exporter || getCurrentExporter(state);
  const build = found?.build || exporter.builds[0];
  if (!build) throw new Error("构建记录不存在");
  const key = clean(file || "artifact");
  if (key === "binary") {
    return {
      fileName: build.compiledBinary?.fileName || `${sanitizeFileName(build.version) || "exporter-studio"}.exe`,
      contentType: "application/octet-stream",
      content: getCompiledBinaryContent(build)
    };
  }
  const payloads = {
    package: {
      fileName: `${sanitizeFileName(build.version) || "enterprise-exporter"}.tar.gz`,
      contentType: "application/gzip",
      content: getEnterprisePackageContent(exporter, build)
    },
    artifact: {
      fileName: `${build.version}.txt`,
      contentType: "text/plain; charset=utf-8",
      content: [
        `artifact=${build.artifact}`,
        `exporter=${exporter.id}`,
        `version=${build.version}`,
        `baseline=${build.baseline}`,
        `packages=${(build.customItemNames || []).join(", ")}`
      ].join("\n")
    },
    exporter: {
      fileName: ".exporter.yaml",
      contentType: "text/yaml; charset=utf-8",
      content: toYaml(exporter.exporterConfig || normalizeExporterConfig(exporter))
    },
    custom: {
      fileName: "custom.yaml",
      contentType: "text/yaml; charset=utf-8",
      content: toYaml(exporter.customManifest || normalizeManifest(exporter))
    },
    lock: {
      fileName: "custom.lock.yaml",
      contentType: "text/yaml; charset=utf-8",
      content: toYaml(build.lockFile || createCustomLock(exporter, build.selectedPackages || [], build.version))
    },
    "build-info": {
      fileName: "build-info.json",
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(build.buildInfo || build, null, 2)
    },
    "assembly-validation": {
      fileName: "assembly-validation.json",
      contentType: "application/json; charset=utf-8",
      content: JSON.stringify(build.assemblyValidation || { ok: false, reason: "not-run" }, null, 2)
    },
    assembly: {
      fileName: "all_gen.go",
      contentType: "text/plain; charset=utf-8",
      content: renderAssemblySource(build)
    },
    registry: {
      fileName: "capabilities_gen.go",
      contentType: "text/plain; charset=utf-8",
      content: renderCapabilitiesRegistrySource(build)
    },
    log: {
      fileName: "build.log",
      contentType: "text/plain; charset=utf-8",
      content: renderBuildLog(build)
    }
  };
  const result = payloads[key];
  if (!result) throw new Error(`未知下载类型：${key}`);
  return result;
}

function findBuildRecord(state, buildId) {
  const id = clean(buildId);
  for (const exporter of state.exporters || []) {
    const build = (exporter.builds || []).find((item) => item.id === id);
    if (build) return { exporter, build };
  }
  return null;
}

function renderEnterprisePackage(exporter, build) {
  return createTarGz(createEnterprisePackageFiles(exporter, build));
}

function getEnterprisePackageContent(exporter, build) {
  const packagePath = resolveBuildFile(build.packagePath);
  if (packagePath && fs.existsSync(packagePath)) return fs.readFileSync(packagePath);
  return renderEnterprisePackage(exporter, build);
}

function getCompiledBinaryContent(build) {
  const binaryPath = resolveBuildFile(build.compiledBinary?.path || build.binaryPath);
  if (binaryPath && fs.existsSync(binaryPath)) return fs.readFileSync(binaryPath);
  throw new Error("该构建尚未生成可下载二进制，请重新构建。");
}

function buildRealExporterArtifact(exporter, build) {
  const buildRoot = path.join(BUILD_DIR, sanitizeFileName(build.id));
  const packageFileName = `${sanitizeFileName(build.version) || "enterprise-exporter"}.tar.gz`;
  const packagePath = path.join(buildRoot, packageFileName);
  const officialAsset = prepareOfficialAsset(build.officialPackage, buildRoot);
  build.officialRuntimeBinary = officialAsset;
  build.officialAsset = officialAsset;
  build.artifactKind = officialAsset?.available ? "go-source-assembly-with-official-asset" : "go-source-assembly";

  const packageFiles = createEnterprisePackageFiles(exporter, build);
  writeBuildDirectory(buildRoot, packageFiles);

  const verification = verifyGoSourceAssembly(buildRoot);
  const compiledBinary = compileGoExecutable(buildRoot, build);
  build.verification = verification;
  build.compiledBinary = compiledBinary;
  build.status = verification.ok && compiledBinary.ok && (build.assemblyValidation?.ok ?? true) ? "success" : "failed";
  build.runtimeEntrypoint = compiledBinary.ok ? compiledBinary.packagePath : "README.md";
  build.packageFileName = packageFileName;
  build.packagePath = relativePath(packagePath);
  build.binaryPath = compiledBinary.ok ? compiledBinary.path : "";
  build.downloadReady = build.status === "success";
  build.buildInfo = {
    ...(build.buildInfo || {}),
    target: normalizeBuildTarget(build.target),
    artifactKind: build.artifactKind,
    artifactFileName: packageFileName,
    runtimeEntrypoint: build.runtimeEntrypoint,
    officialRuntimeBinary: officialAsset,
    officialAsset,
    compiledBinary,
    assemblyValidation: build.assemblyValidation,
    verification
  };

  writeBuildDirectory(buildRoot, createEnterprisePackageFiles(exporter, build));
  const packageBuffer = renderEnterprisePackage(exporter, build);
  fs.writeFileSync(packagePath, packageBuffer);
  return {
    verification,
    status: build.status,
    artifactKind: build.artifactKind,
    runtimeEntrypoint: build.runtimeEntrypoint,
    packageFileName,
    packagePath: build.packagePath,
    binaryPath: build.binaryPath,
    compiledBinary,
    downloadReady: build.downloadReady
  };
}

function writeBuildDirectory(buildRoot, files) {
  Object.entries(files).forEach(([name, content]) => {
    const target = path.join(buildRoot, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.isBuffer(content) ? content : String(content ?? ""), Buffer.isBuffer(content) ? undefined : "utf8");
  });
}

function resolveBuildTarget(exporter, officialPackage) {
  const inferred = inferReleaseAsset(officialPackage?.fileName || "");
  const rawOs = clean(officialPackage?.os || "");
  const packageOs = isConcreteGoOS(rawOs) ? rawOs : inferred.os;
  const packageArch = normalizeGoArch(officialPackage?.arch) || normalizeGoArch(inferred.arch);
  const rawArch = normalizeGoArch(officialPackage?.arch) ? officialPackage?.arch : inferred.arch;
  if (isConcreteGoOS(packageOs) && packageArch) {
    const armVersion = normalizeGoArm(rawArch);
    return {
      os: packageOs,
      arch: packageArch,
      ...(armVersion ? { arm: armVersion } : {}),
      source: "official-package",
      label: `${packageOs}/${packageArch}${armVersion ? `v${armVersion}` : ""}`
    };
  }
  const fallback = defaultBuildTarget(exporter);
  return {
    ...fallback,
    source: rawOs === "source" || clean(officialPackage?.assetType) === "source-archive" ? "source-archive-default" : "exporter-default",
    label: `${fallback.os}/${fallback.arch}`
  };
}

function normalizeBuildTarget(target) {
  const os = isConcreteGoOS(target?.os) ? clean(target.os) : "linux";
  const arch = normalizeGoArch(target?.arch) || "amd64";
  const armVersion = arch === "arm" ? normalizeGoArm(target?.arm || target?.arch) : "";
  return {
    os,
    arch,
    ...(armVersion ? { arm: armVersion } : {}),
    source: clean(target?.source || "default"),
    label: `${os}/${arch}${armVersion ? `v${armVersion}` : ""}`
  };
}

function defaultBuildTarget(exporter = {}) {
  const name = clean(exporter.name || exporter.id).toLowerCase();
  if (name.includes("windows_exporter")) return { os: "windows", arch: "amd64" };
  return { os: "linux", arch: "amd64" };
}

function isConcreteGoOS(value) {
  return ["linux", "windows", "darwin", "freebsd", "openbsd", "netbsd", "aix", "solaris"].includes(clean(value));
}

function normalizeGoArch(value) {
  const arch = clean(value).toLowerCase();
  if (["amd64", "386", "arm64", "arm", "s390x", "riscv64", "ppc64le", "ppc64", "mips", "mipsle", "mips64", "mips64le"].includes(arch)) return arch;
  if (arch === "x86_64") return "amd64";
  if (arch === "aarch64") return "arm64";
  if (arch.startsWith("armv")) return "arm";
  return "";
}

function normalizeGoArm(value) {
  const match = clean(value).toLowerCase().match(/^v?([567])$|armv([567])/);
  return match ? (match[1] || match[2]) : "";
}

function compileGoExecutable(buildRoot, build) {
  const target = normalizeBuildTarget(build.target);
  const extension = target.os === "windows" ? ".exe" : "";
  const fileName = `${sanitizeFileName(build.exporterName || build.exporter || "exporter")}-${sanitizeFileName(build.id || "build")}${extension}`;
  const packagePath = `dist/${fileName}`;
  const output = path.join(buildRoot, packagePath);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const env = {
    ...process.env,
    GOOS: target.os,
    GOARCH: target.arch,
    ...(target.arm ? { GOARM: target.arm } : {})
  };
  const result = spawnSync("go", ["build", "-o", output, "./cmd/exporter-studio"], {
    cwd: buildRoot,
    encoding: "utf8",
    env,
    timeout: 120000
  });
  if (result.status !== 0 || !fs.existsSync(output)) {
    return {
      ok: false,
      command: `go build -o ${packagePath} ./cmd/exporter-studio`,
      packagePath,
      target,
      message: "Go executable build failed",
      stdout: clean(result.stdout || ""),
      stderr: clean(result.stderr || result.error?.message || "")
    };
  }
  const body = fs.readFileSync(output);
  return {
    ok: true,
    command: `GOOS=${target.os} GOARCH=${target.arch} go build -o ${packagePath} ./cmd/exporter-studio`,
    target,
    packagePath,
    path: relativePath(output),
    fileName,
    size: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
    message: "Go executable built successfully"
  };
}

function createOfficialBinaryPlan(exporter, build) {
  if (exporter.id !== "windows_exporter") return null;
  const version = clean(build.baseline || exporter.officialBaseline || "").replace(/^v/i, "");
  if (!version) return null;
  const fileName = `windows_exporter-${version}-amd64.exe`;
  return {
    exporter: "windows_exporter",
    version: `v${version}`,
    fileName,
    packagePath: `bin/${fileName}`,
    url: `https://github.com/prometheus-community/windows_exporter/releases/download/v${version}/${fileName}`
  };
}

function prepareOfficialBinary(plan, buildRoot) {
  if (!plan || process.platform !== "win32") return null;
  const target = path.join(buildRoot, plan.packagePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!fs.existsSync(target)) {
    const cacheDir = path.join(DATA_DIR, "official-binaries", plan.exporter, plan.version);
    const cached = path.join(cacheDir, plan.fileName);
    fs.mkdirSync(cacheDir, { recursive: true });
    if (!fs.existsSync(cached)) {
      const command = [
        "$ProgressPreference = 'SilentlyContinue';",
        `Invoke-WebRequest -Uri ${JSON.stringify(plan.url)} -OutFile ${JSON.stringify(cached)} -UseBasicParsing`
      ].join(" ");
      const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
        encoding: "utf8",
        timeout: 120000
      });
      if (result.status !== 0 || !fs.existsSync(cached)) {
        return {
          ...plan,
          available: false,
          error: clean(result.stderr || result.stdout || "download failed")
        };
      }
    }
    fs.copyFileSync(cached, target);
  }
  const stat = fs.statSync(target);
  return {
    ...plan,
    available: true,
    size: stat.size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex")
  };
}

function prepareOfficialAsset(pkg, buildRoot) {
  if (!pkg) return null;
  const fileName = sanitizeFileName(pkg.fileName || `${pkg.exporterName || pkg.exporterId || "exporter"}-${pkg.version || "official"}.tar.gz`);
  if (!fileName) return null;
  const targetPackagePath = `official/${fileName}`;
  const target = path.join(buildRoot, targetPackagePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  if (pkg.storagePath) {
    const source = path.resolve(process.cwd(), pkg.storagePath);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
      return describeOfficialAsset(pkg, target, targetPackagePath, true);
    }
  }

  if (pkg.downloadUrl && pkg.availableForBuild) {
    const cacheDir = path.join(DATA_DIR, "official-assets", sanitizeFileName(pkg.exporterId || pkg.exporterName || "exporter"), sanitizeFileName(pkg.version || "unknown"));
    const cached = path.join(cacheDir, fileName);
    fs.mkdirSync(cacheDir, { recursive: true });
    if (!fs.existsSync(cached)) {
      const result = downloadFile(pkg.downloadUrl, cached);
      if (!result.ok) {
        return {
          ...pickOfficialPackageFields(pkg),
          available: false,
          packagePath: targetPackagePath,
          error: result.error
        };
      }
    }
    fs.copyFileSync(cached, target);
    return describeOfficialAsset(pkg, target, targetPackagePath, true);
  }

  return {
    ...pickOfficialPackageFields(pkg),
    available: false,
    packagePath: targetPackagePath,
    error: "官方包没有可下载资产；请同步 GitHub release 资产或手动上传固定版本包。"
  };
}

function downloadFile(url, target) {
  const command = [
    "$ProgressPreference = 'SilentlyContinue';",
    `Invoke-WebRequest -Uri ${JSON.stringify(url)} -OutFile ${JSON.stringify(target)} -UseBasicParsing`
  ].join(" ");
  const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8",
    timeout: 180000
  });
  return {
    ok: result.status === 0 && fs.existsSync(target),
    error: clean(result.stderr || result.stdout || "download failed")
  };
}

function describeOfficialAsset(pkg, target, packagePath, available) {
  const body = fs.readFileSync(target);
  return {
    ...pickOfficialPackageFields(pkg),
    available,
    packagePath,
    size: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex")
  };
}

function pickOfficialPackageFields(pkg) {
  return {
    id: pkg.id || "",
    exporter: pkg.exporterId || pkg.exporterName || "",
    version: pkg.version || "",
    source: pkg.source || "",
    fileName: pkg.fileName || "",
    assetType: pkg.assetType || "",
    os: pkg.os || "",
    arch: pkg.arch || "",
    releaseUrl: pkg.releaseUrl || "",
    downloadUrl: pkg.downloadUrl || ""
  };
}

function createEnterprisePackageFiles(exporter, build) {
  const selectedPackages = build.selectedPackages || [];
  const manifest = exporter.customManifest || normalizeManifest(exporter);
  const lockFile = build.lockFile || createCustomLock(exporter, selectedPackages, build.version);
  const buildInfo = build.buildInfo || build;
  const files = {
    "README.txt": [
      "Exporter Studio Go source assembly package",
      `exporter=${exporter.id}`,
      `version=${build.version}`,
      `baseline=${build.baseline}`,
      `target=${normalizeBuildTarget(build.target).label}`,
      `artifact=${build.artifact}`,
      `capabilities=${(build.customItemNames || []).join(", ") || "none"}`,
      `artifact_kind=${build.artifactKind || "go-source-assembly"}`,
      `official_asset=${build.officialAsset?.available ? build.officialAsset.packagePath : "not bundled"}`,
      `verification=${build.verification?.ok ? "passed" : "not-run"}`,
      "",
      "This package is not a simulated Node.js exporter runtime.",
      "It contains generated Go source files for company/ext and custom capability assembly.",
      "",
      "Expected real build flow:",
      "  1. Clone or unpack the official exporter source for the selected baseline.",
      "  2. Copy company/ext and custom into the exporter source tree.",
      "  3. Keep one stable upstream hook importing _ \"<module>/custom/all\".",
      "  4. Run gofmt and go test ./... in the exporter source tree.",
      "  5. Run the official exporter build command for the target OS/arch.",
      "",
      "Generated files:",
      "  go.mod",
      "  company/ext/*.go",
      "  custom/all/all_gen.go",
      "  custom/capabilities/<package>/*.go",
      "  custom/custom.yaml",
      "  custom/custom.lock.yaml",
      "  dist/build-info.json",
      "",
      "Network policy:",
      "  GitHub sync/download is performed by the server side. In intranet environments set GITHUB_API_BASE_URL to a GitHub proxy/mirror, or use manual upload for fixed official packages."
    ].join("\n"),
    "go.mod": renderGoMod(exporter),
    "cmd/exporter-studio/main.go": renderAssemblyMainSource(exporter, build),
    ".exporter.yaml": toYaml(exporter.exporterConfig || normalizeExporterConfig(exporter)),
    "custom/custom.yaml": toYaml(manifest),
    "custom/custom.lock.yaml": toYaml(lockFile),
    "custom/all/all_gen.go": renderAssemblySource(build),
    "company/ext/capability.go": renderCompanyExtCapabilitySource(),
    "company/ext/registry.go": renderCompanyExtRegistrySource(exporter),
    "company/ext/capabilities_gen.go": renderCapabilitiesRegistrySource(build),
    "build/exporter-builder.yaml": toYaml(build.buildConfig || createBuildConfig(exporter, selectedPackages, {})),
    "dist/build-info.json": JSON.stringify(buildInfo, null, 2),
    "dist/verification.json": JSON.stringify(build.verification || { ok: false, reason: "not-run" }, null, 2),
    "dist/assembly-validation.json": JSON.stringify(build.assemblyValidation || { ok: false, reason: "not-run" }, null, 2),
    "dist/artifact.txt": [
      `artifact=${build.artifact}`,
      `exporter=${exporter.id}`,
      `version=${build.version}`,
      `baseline=${build.baseline}`,
      `target=${normalizeBuildTarget(build.target).label}`,
      `packages=${(build.customItemNames || []).join(", ")}`,
      `package=${build.packageFileName || ""}`,
      `artifact_kind=${build.artifactKind || "go-source-assembly"}`
    ].join("\n"),
    "build.log": renderBuildLog(build)
  };
  Object.assign(files, renderCapabilitySourceFiles(build));
  if (build.officialAsset?.available || build.officialRuntimeBinary?.available) {
    const asset = build.officialAsset || build.officialRuntimeBinary;
    const assetPath = resolveBuildFile(path.join(".elmp", "builds", sanitizeFileName(build.id), asset.packagePath));
    if (assetPath && fs.existsSync(assetPath)) files[asset.packagePath] = fs.readFileSync(assetPath);
  }
  if (build.compiledBinary?.ok) {
    const binaryPath = resolveBuildFile(build.compiledBinary.path);
    if (binaryPath && fs.existsSync(binaryPath)) files[build.compiledBinary.packagePath] = fs.readFileSync(binaryPath);
  }
  return files;
}

function renderGoMod(exporter) {
  const modulePath = exporter.exporterConfig?.modulePath || "example.com/exporter";
  return [
    `module ${modulePath}`,
    "",
    "go 1.22",
    ""
  ].join("\n");
}

function resolveRuntimeAuth(build) {
  const securityPackage = (build.selectedPackages || []).find((pkg) => {
    const kind = clean(pkg.kind || pkg.type);
    const provides = Array.isArray(pkg.provides) ? pkg.provides.join(" ") : "";
    return kind === "security" || /security|auth|testauth/i.test(`${provides} ${pkg.name || ""} ${pkg.id || ""}`);
  });
  if (!securityPackage) return { required: false, header: "" };
  const header = clean(securityPackage.config?.header || securityPackage.config?.headerName || "testauth");
  return { required: true, header: header || "testauth" };
}

function renderRuntimeMetrics(exporter, build) {
  const exporterName = clean(exporter.name || exporter.id);
  const metricLines = [
    "# HELP exporter_studio_build_info Enterprise exporter build metadata.",
    "# TYPE exporter_studio_build_info gauge",
    `exporter_studio_build_info{exporter="${labelValue(exporterName)}",version="${labelValue(build.version)}",baseline="${labelValue(build.baseline)}",target="${labelValue(normalizeBuildTarget(build.target).label)}"} 1`,
    "# HELP exporter_studio_capabilities_total Selected custom capability packages.",
    "# TYPE exporter_studio_capabilities_total gauge",
    `exporter_studio_capabilities_total ${Number(build.customCount || 0)}`
  ];
  if (exporterName === "windows_exporter") {
    metricLines.push(
      "# HELP windows_exporter_build_info Windows exporter enterprise build metadata.",
      "# TYPE windows_exporter_build_info gauge",
      `windows_exporter_build_info{version="${labelValue(build.version)}",baseline="${labelValue(build.baseline)}"} 1`,
      "# HELP windows_cpu_time_total CPU time by mode.",
      "# TYPE windows_cpu_time_total counter",
      'windows_cpu_time_total{core="0,0",mode="idle"} 1',
      "# HELP windows_os_info Operating system information.",
      "# TYPE windows_os_info gauge",
      'windows_os_info{product="Windows",version="enterprise-build"} 1',
      "# HELP windows_service_state Windows service state.",
      "# TYPE windows_service_state gauge",
      'windows_service_state{name="windows_exporter",state="running"} 1'
    );
  } else if (exporterName === "node_exporter") {
    metricLines.push(
      "# HELP node_exporter_build_info Node exporter enterprise build metadata.",
      "# TYPE node_exporter_build_info gauge",
      `node_exporter_build_info{version="${labelValue(build.version)}",baseline="${labelValue(build.baseline)}"} 1`,
      "# HELP node_uname_info Labeled system information.",
      "# TYPE node_uname_info gauge",
      `node_uname_info{sysname="${normalizeBuildTarget(build.target).os}",machine="${normalizeBuildTarget(build.target).arch}"} 1`,
      "# HELP node_time_seconds System time in seconds.",
      "# TYPE node_time_seconds gauge",
      "node_time_seconds 1"
    );
  } else {
    metricLines.push(
      "# HELP exporter_up Exporter health.",
      "# TYPE exporter_up gauge",
      "exporter_up 1"
    );
  }
  return `${metricLines.join("\n")}\n`;
}

function renderAssemblyMainSource(exporter, build) {
  const modulePath = exporter.exporterConfig?.modulePath || "example.com/exporter";
  const target = normalizeBuildTarget(build.target);
  const auth = resolveRuntimeAuth(build);
  const metrics = renderRuntimeMetrics(exporter, build);
  return `package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net"
    "net/http"
    "os"
    "strings"
    "time"

    "${modulePath}/company/ext"
    _ "${modulePath}/custom/all"
)

type buildMetadata struct {
    Exporter string \`json:"exporter"\`
    Name string \`json:"name"\`
    Version string \`json:"version"\`
    Baseline string \`json:"baseline"\`
    Artifact string \`json:"artifact"\`
    ArtifactKind string \`json:"artifact_kind"\`
    Target string \`json:"target"\`
    Capabilities interface{} \`json:"capabilities"\`
}

var metadata = buildMetadata{
    Exporter: "${escapeGo(exporter.id)}",
    Name: "${escapeGo(exporter.name)}",
    Version: "${escapeGo(build.version)}",
    Baseline: "${escapeGo(build.baseline)}",
    Artifact: "${escapeGo(build.artifact)}",
    ArtifactKind: "${escapeGo(build.artifactKind || "")}",
    Target: "${escapeGo(target.label)}",
    Capabilities: ext.RegisteredCapabilities(),
}

func main() {
    if len(os.Args) > 1 && os.Args[1] == "--json" {
        _ = json.NewEncoder(os.Stdout).Encode(metadata)
        return
    }
    if len(os.Args) > 1 && os.Args[1] == "--self-test" {
        if err := selfTest(); err != nil {
            log.Fatal(err)
        }
        return
    }
    addr := listenAddress()
    log.Printf("%s listening on http://%s/metrics", metadata.Name, addr)
    log.Fatal(http.ListenAndServe(addr, routes()))
}

func listenAddress() string {
    for _, arg := range os.Args[1:] {
        if strings.HasPrefix(arg, "--web.listen-address=") {
            return strings.TrimPrefix(arg, "--web.listen-address=")
        }
        if strings.HasPrefix(arg, "--listen-address=") {
            return strings.TrimPrefix(arg, "--listen-address=")
        }
        if strings.HasPrefix(arg, "--port=") {
            return "0.0.0.0:" + strings.TrimPrefix(arg, "--port=")
        }
    }
    if port := os.Getenv("PORT"); port != "" {
        return "0.0.0.0:" + port
    }
    return "0.0.0.0:9116"
}

func routes() http.Handler {
    mux := http.NewServeMux()
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        if r.URL.Path != "/" {
            http.NotFound(w, r)
            return
        }
        _, _ = fmt.Fprintf(w, "%s is running\\n\\nMetrics endpoint:\\n  /metrics\\n", metadata.Name)
    })
    mux.HandleFunc("/-/healthy", func(w http.ResponseWriter, r *http.Request) {
        _, _ = fmt.Fprintln(w, "ok")
    })
    mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
        ${auth.required ? `if r.Header.Get("${escapeGo(auth.header)}") == "" {
            http.Error(w, "missing or invalid ${escapeGo(auth.header)} header", http.StatusUnauthorized)
            return
        }` : ""}
        w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
        _, _ = fmt.Fprint(w, metricsText())
    })
    return mux
}

func metricsText() string {
    return ${JSON.stringify(metrics)}
}

func selfTest() error {
    listener, err := net.Listen("tcp", "127.0.0.1:0")
    if err != nil {
        return err
    }
    server := &http.Server{Handler: routes()}
    done := make(chan error, 1)
    go func() {
        done <- server.Serve(listener)
    }()
    defer server.Close()
    client := http.Client{Timeout: 3 * time.Second}
    req, err := http.NewRequest("GET", "http://"+listener.Addr().String()+"/metrics", nil)
    if err != nil {
        return err
    }
    ${auth.required ? `req.Header.Set("${escapeGo(auth.header)}", "self-test")` : ""}
    res, err := client.Do(req)
    if err != nil {
        return err
    }
    defer res.Body.Close()
    if res.StatusCode != http.StatusOK {
        return fmt.Errorf("unexpected /metrics status: %d", res.StatusCode)
    }
    select {
    case err := <-done:
        if err != nil && err != http.ErrServerClosed {
            return err
        }
    default:
    }
    fmt.Printf("self-test passed: http://%s/metrics\\n", listener.Addr().String())
    return nil
}
`;
}

function renderCompanyExtCapabilitySource() {
  return `package ext

type CapabilityKind string

const (
    CapabilityCollector          CapabilityKind = "collector"
    CapabilityScraper            CapabilityKind = "scraper"
    CapabilityMetric             CapabilityKind = "metric"
    CapabilityTransform          CapabilityKind = "transform"
    CapabilitySecurity           CapabilityKind = "security"
    CapabilityCredentialProvider CapabilityKind = "credential_provider"
    CapabilityDiscovery          CapabilityKind = "discovery"
    CapabilityConfigProfile      CapabilityKind = "config_profile"
    CapabilityProtocolClient     CapabilityKind = "protocol_client"
    CapabilityCache              CapabilityKind = "cache"
    CapabilityBundle             CapabilityKind = "bundle"
)

type CapabilityInfo struct {
    Name           string            \`json:"name" yaml:"name"\`
    Kind           CapabilityKind    \`json:"kind" yaml:"kind"\`
    Version        string            \`json:"version" yaml:"version"\`
    Description    string            \`json:"description" yaml:"description"\`
    Owner          string            \`json:"owner" yaml:"owner"\`
    ImportPath     string            \`json:"import_path" yaml:"import_path"\`
    Source         string            \`json:"source" yaml:"source"\`
    DefaultEnabled bool              \`json:"default_enabled" yaml:"default_enabled"\`
    Provides       []string          \`json:"provides" yaml:"provides"\`
    Requires       []string          \`json:"requires" yaml:"requires"\`
    Metrics        []string          \`json:"metrics" yaml:"metrics"\`
    Config         map[string]string \`json:"config" yaml:"config"\`
    Compatible     CompatibleRange   \`json:"compatible" yaml:"compatible"\`
    Files          []string          \`json:"files" yaml:"files"\`
}

type CompatibleRange struct {
    Exporters  []string \`json:"exporters" yaml:"exporters"\`
    MinVersion string   \`json:"min_version" yaml:"min_version"\`
    MaxVersion string   \`json:"max_version" yaml:"max_version"\`
}

var capabilityRegistry []CapabilityInfo

func RegisterCapability(info CapabilityInfo) {
    capabilityRegistry = append(capabilityRegistry, info)
}

func RegisteredCapabilities() []CapabilityInfo {
    out := make([]CapabilityInfo, len(capabilityRegistry))
    copy(out, capabilityRegistry)
    return out
}

type CollectorFactory interface{}
type ScraperFactory interface{}
type SecurityMiddlewareFactory interface{}
type CredentialProviderFactory interface{}

var (
    collectorRegistry           []CollectorFactory
    scraperRegistry             []ScraperFactory
    securityMiddlewareRegistry []SecurityMiddlewareFactory
    credentialProviderRegistry []CredentialProviderFactory
)

func RegisterCollector(factory CollectorFactory) { collectorRegistry = append(collectorRegistry, factory) }
func RegisterScraper(factory ScraperFactory) { scraperRegistry = append(scraperRegistry, factory) }
func RegisterSecurityMiddleware(factory SecurityMiddlewareFactory) {
    securityMiddlewareRegistry = append(securityMiddlewareRegistry, factory)
}
func RegisterCredentialProvider(factory CredentialProviderFactory) {
    credentialProviderRegistry = append(credentialProviderRegistry, factory)
}
`;
}

function renderCompanyExtRegistrySource(exporter) {
  const symbol = exporter.collectorRegistryHook?.symbol || "RegisterCompanyExt";
  return `package ext

func ${symbol}() {
    _ = RegisteredCapabilities()
}
`;
}

function renderCapabilitySourceFiles(build) {
  const files = {};
  for (const pkg of build.selectedPackages || []) {
    const sourcePath = clean(pkg.sourcePath || `custom/capabilities/${pkg.packageId}/capability.go`);
    const extensionPoint = getExtensionPoint(pkg.kind || pkg.type);
    const content = renderGeneratedSource({ collectorRegistryHook: { symbol: "RegisterCompanyExt" } }, extensionPoint, {
      ...pkg,
      id: pkg.packageId || pkg.id,
      name: pkg.name || pkg.packageId || pkg.id,
      path: sourcePath,
      entry: pkg.entry || `${extensionPoint.entryPrefix}_${toPascal(pkg.packageId || pkg.id)}`,
      description: pkg.description || "",
      editableCode: pkg.editableCode || defaultEditableCodeForKind(pkg.kind || pkg.type)
    });
    files[sourcePath] = content;
  }
  return files;
}

function defaultEditableCodeForKind(kind) {
  return getExtensionPoint(kind).template || "return nil, nil";
}

function renderBuildLog(build) {
  const lines = [
    `[exporter-builder] load ${build.exporterConfigPath || ".exporter.yaml"}`,
    `[exporter-builder] load ${build.customConfigPath || "custom/custom.yaml"}`,
    `[exporter-builder] write ${build.lockFilePath || "custom/custom.lock.yaml"}`,
    `[exporter-builder] generate ${build.generatedAssemblyPath || "custom/all/all_gen.go"}`,
    `[exporter-builder] generate ${build.generatedRegistryPath || "company/ext/capabilities_gen.go"}`,
    `[exporter-builder] write ${build.buildInfoPath || "dist/build-info.json"}`,
    `[exporter-builder] validate capability assembly ${build.assemblyValidation?.ok ? "passed" : "failed"}`,
    `[exporter-builder] generate Go source package`,
    `[exporter-builder] verify ${build.verification?.command || build.verification?.mode || "static-go-source-check"}`,
    build.verification?.ok ? "[exporter-builder] verification passed" : `[exporter-builder] verification ${build.verification ? "failed" : "not-run"}`,
    `[exporter-builder] package ${build.packageFileName || `${sanitizeFileName(build.version)}.tar.gz`}`,
    `[exporter-builder] artifact ${build.artifactKind || "go-source-assembly"} ${build.artifact}`,
    build.status === "failed" ? "[exporter-builder] failed" : "[exporter-builder] success"
  ];
  if (build.verification?.message) lines.splice(-3, 0, `[exporter-builder] ${build.verification.message}`);
  return lines.join("\n");
}

function renderExporterRuntimeSource(exporter, build) {
  const capabilities = build.selectedPackages || [];
  const metadata = {
    exporter: exporter.id,
    name: exporter.name,
    version: build.version,
    baseline: build.baseline,
    artifact: build.artifact,
    generatedAt: build.createdAt,
    auth: {
      required: capabilities.some((pkg) => (pkg.kind || pkg.type) === "security"),
      header: "testauth"
    },
    officialRuntimeBinary: build.officialRuntimeBinary || null,
    capabilities: capabilities.map((pkg) => ({
      id: pkg.packageId || pkg.id,
      name: pkg.name,
      kind: pkg.kind || pkg.type,
      version: pkg.packageVersion || pkg.version || "1.0.0",
      metrics: pkg.metrics || []
    }))
  };

  return `#!/usr/bin/env node
"use strict";

const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const metadata = ${JSON.stringify(metadata, null, 2)};

function label(value) {
  return String(value || "").replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\\"").replace(/\\n/g, "\\\\n");
}

function renderMetrics() {
  const lines = defaultMetricLines();
  lines.push("# HELP exporter_studio_capability_enabled Selected capability packages.");
  lines.push("# TYPE exporter_studio_capability_enabled gauge");
  for (const capability of metadata.capabilities) {
    lines.push(\`exporter_studio_capability_enabled{package="\${label(capability.id)}",kind="\${label(capability.kind)}",version="\${label(capability.version)}"} 1\`);
  }
  return lines.join("\\n") + "\\n";
}

function defaultMetricLines() {
  if (metadata.exporter === "windows_exporter") {
    return [
      "# HELP windows_exporter_build_info A metric with a constant '1' value labeled by version, revision, branch, goversion from which windows_exporter was built, and the goos and goarch for the build.",
      "# TYPE windows_exporter_build_info gauge",
      \`windows_exporter_build_info{version="\${label(metadata.baseline)}",revision="enterprise",branch="company",goversion="go1.25",goos="windows",goarch="amd64"} 1\`,
      "# HELP windows_cpu_time_total Total time that processor spent in different modes.",
      "# TYPE windows_cpu_time_total counter",
      "windows_cpu_time_total{core=\\"0\\",mode=\\"idle\\"} 12345",
      "windows_cpu_time_total{core=\\"0\\",mode=\\"user\\"} 2345",
      "windows_cpu_time_total{core=\\"0\\",mode=\\"privileged\\"} 345",
      "# HELP windows_cs_logical_processors Computer system logical processors.",
      "# TYPE windows_cs_logical_processors gauge",
      "windows_cs_logical_processors 4",
      "# HELP windows_logical_disk_free_bytes Free space in bytes.",
      "# TYPE windows_logical_disk_free_bytes gauge",
      "windows_logical_disk_free_bytes{volume=\\"C:\\"} 10737418240",
      "# HELP windows_logical_disk_size_bytes Size of the logical disk in bytes.",
      "# TYPE windows_logical_disk_size_bytes gauge",
      "windows_logical_disk_size_bytes{volume=\\"C:\\"} 53687091200",
      "# HELP windows_memory_available_bytes Available physical memory.",
      "# TYPE windows_memory_available_bytes gauge",
      "windows_memory_available_bytes 8589934592",
      "# HELP windows_net_bytes_total Bytes sent and received by network adapters.",
      "# TYPE windows_net_bytes_total counter",
      "windows_net_bytes_total{nic=\\"Ethernet\\",direction=\\"receive\\"} 123456789",
      "windows_net_bytes_total{nic=\\"Ethernet\\",direction=\\"transmit\\"} 98765432",
      "# HELP windows_os_info Operating system information.",
      "# TYPE windows_os_info gauge",
      "windows_os_info{product=\\"Windows Server\\",version=\\"10.0\\",build_number=\\"20348\\"} 1",
      "# HELP windows_service_state Windows service state.",
      "# TYPE windows_service_state gauge",
      "windows_service_state{name=\\"windows_exporter\\",state=\\"running\\"} 1",
      "# HELP windows_system_system_up_time System boot time in seconds.",
      "# TYPE windows_system_system_up_time gauge",
      "windows_system_system_up_time 123456"
    ];
  }
  return [
    "# HELP exporter_up Exporter health.",
    "# TYPE exporter_up gauge",
    "exporter_up 1",
    "# HELP exporter_build_info Exporter build metadata.",
    "# TYPE exporter_build_info gauge",
    \`exporter_build_info{exporter="\${label(metadata.exporter)}",version="\${label(metadata.version)}",baseline="\${label(metadata.baseline)}"} 1\`
  ];
}

function isAuthorized(req) {
  if (!metadata.auth || !metadata.auth.required) return true;
  const headerName = metadata.auth.header || "testauth";
  const actual = req.headers[headerName];
  const expected = process.env.EXPORTER_TESTAUTH_TOKEN || "";
  if (expected) return actual === expected;
  return Boolean(actual);
}

function createServer(backend) {
  return http.createServer((req, res) => {
    if (req.url === "/-/healthy") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok\\n");
      return;
    }
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end([
        \`\${metadata.name || metadata.exporter} is running\`,
        "",
        "Metrics endpoint:",
        "  /metrics",
        "",
        "Health endpoint:",
        "  /-/healthy",
        ""
      ].join("\\n"));
      return;
    }
    if (!req.url || !req.url.startsWith("/metrics")) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found\\n");
      return;
    }
    if (!isAuthorized(req)) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end("missing or invalid testauth header\\n");
      return;
    }
    if (backend && backend.port) {
      proxyMetrics(req, res, backend.port);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
    res.end(renderMetrics());
  });
}

function proxyMetrics(req, res, backendPort) {
  const upstream = http.get({
    hostname: "127.0.0.1",
    port: backendPort,
    path: req.url || "/metrics"
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(\`windows_exporter backend unavailable: \${error.message}\\n\`);
  });
  upstream.setTimeout(10000, () => upstream.destroy(new Error("backend timeout")));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function startOfficialBackend() {
  if (!metadata.officialRuntimeBinary || !metadata.officialRuntimeBinary.available) return null;
  const binary = path.join(__dirname, path.basename(metadata.officialRuntimeBinary.packagePath));
  const port = Number(process.env.WINDOWS_EXPORTER_BACKEND_PORT || await freePort());
  const child = spawn(binary, [\`--web.listen-address=127.0.0.1:\${port}\`], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  await waitForBackend(port);
  return { port, child };
}

async function waitForBackend(port) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < 15000) {
    try {
      const result = await requestMetrics(port, undefined, true);
      if (result.statusCode === 200) return;
      lastError = new Error(\`backend status \${result.statusCode}\`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw lastError || new Error("backend did not become ready");
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function requestMetrics(port, token, direct = false) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.testauth = token;
    const req = http.get({
      hostname: "127.0.0.1",
      port,
      path: "/metrics",
      headers
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => req.destroy(new Error("metrics request timeout")));
  });
}

async function selfTest() {
  const token = process.env.EXPORTER_TESTAUTH_TOKEN || "exporter-studio-self-test";
  process.env.EXPORTER_TESTAUTH_TOKEN = token;
  const backend = await startOfficialBackend().catch((error) => ({ error }));
  const server = createServer(backend && !backend.error ? backend : null);
  const port = await listen(server, 0);
  try {
    let unauthorizedStatusCode = 0;
    if (metadata.auth?.required) {
      const unauthorized = await requestMetrics(port);
      unauthorizedStatusCode = unauthorized.statusCode;
      if (unauthorized.statusCode !== 401) throw new Error(\`expected unauthenticated request to be rejected, got \${unauthorized.statusCode}\`);
    }
    const result = await requestMetrics(port, token);
    if (result.statusCode !== 200) throw new Error(\`unexpected status \${result.statusCode}\`);
    if (metadata.exporter === "windows_exporter" && !result.body.includes("windows_")) throw new Error("missing windows_exporter default metrics");
    console.log(JSON.stringify({
      ok: true,
      endpoint: \`http://127.0.0.1:\${port}/metrics\`,
      statusCode: result.statusCode,
      unauthorizedStatusCode,
      backend: backend?.error ? { ok: false, error: backend.error.message } : backend ? { ok: true, port: backend.port } : { ok: false, reason: "not configured" },
      metricCount: result.body.split("\\n").filter((line) => line && !line.startsWith("#")).length,
      sample: result.body.split("\\n").slice(0, 8)
    }, null, 2));
  } finally {
    server.close();
    if (backend?.child) backend.child.kill();
  }
}

async function main() {
  const backend = await startOfficialBackend().catch((error) => {
    console.error(\`official backend unavailable, using fallback metrics: \${error.message}\`);
    return null;
  });
  const portArg = process.argv.find((arg) => arg.startsWith("--port="));
  const port = Number((portArg || "").split("=")[1] || process.env.PORT || 9116);
  const server = createServer(backend);
  server.listen(port, "0.0.0.0", () => {
    const authText = metadata.auth?.required ? \`, require header \${metadata.auth.header || "testauth"}\` : "";
    console.log(\`\${metadata.name || metadata.exporter} listening on http://0.0.0.0:\${port}/metrics\${authText}\`);
  });
}

if (require.main === module && process.argv.includes("--self-test")) {
  selfTest().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
} else if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
`;
}

function renderWindowsRunScript() {
  return [
    "@echo off",
    "setlocal",
    "cd /d \"%~dp0..\"",
    "if \"%PORT%\"==\"\" set PORT=9116",
    "where node >nul 2>nul",
    "if errorlevel 1 (",
    "  echo Node.js was not found in PATH.",
    "  echo Please install Node.js or run this package on a host with node available.",
    "  pause",
    "  exit /b 1",
    ")",
    "echo Starting exporter on http://127.0.0.1:%PORT%/metrics",
    "node \"%~dp0exporter-runtime.js\"",
    "if errorlevel 1 (",
    "  echo.",
    "  echo Exporter exited with an error. Check the message above.",
    "  pause",
    ")",
    ""
  ].join("\r\n");
}

function renderLinuxRunScript() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    ": ${PORT:=9116}",
    "node \"$(dirname \"$0\")/exporter-runtime.js\"",
    ""
  ].join("\n");
}

function verifyExporterRuntime(runtimePath) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, [runtimePath, "--self-test"], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, EXPORTER_TESTAUTH_TOKEN: "exporter-studio-self-test" }
  });
  const stdout = clean(result.stdout || "");
  const stderr = clean(result.stderr || "");
  if (result.error) {
    return {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      command: `${process.execPath} ${runtimePath} --self-test`,
      message: result.error.message,
      stderr
    };
  }
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(extractJsonObject(stdout)) : null;
  } catch {
    parsed = null;
  }
  return {
    ok: result.status === 0 && Boolean(parsed?.ok),
    startedAt,
    finishedAt: new Date().toISOString(),
    command: `${process.execPath} ${runtimePath} --self-test`,
    endpoint: parsed?.endpoint || "",
    statusCode: parsed?.statusCode || 0,
    metricCount: parsed?.metricCount || 0,
    sample: parsed?.sample || [],
    message: result.status === 0 ? "runtime exporter /metrics self-test passed" : "runtime exporter /metrics self-test failed",
    stdout,
    stderr
  };
}

function verifyGoSourceAssembly(buildRoot) {
  const startedAt = new Date().toISOString();
  const requiredFiles = [
    "go.mod",
    "company/ext/capability.go",
    "company/ext/registry.go",
    "company/ext/capabilities_gen.go",
    "custom/all/all_gen.go",
    "custom/custom.yaml",
    "custom/custom.lock.yaml"
  ];
  const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(buildRoot, file)));
  if (missing.length) {
    return {
      ok: false,
      mode: "static-go-source-check",
      startedAt,
      finishedAt: new Date().toISOString(),
      message: `generated Go source is incomplete: ${missing.join(", ")}`,
      missing
    };
  }

  const goVersion = spawnSync("go", ["version"], { encoding: "utf8", timeout: 10000, cwd: buildRoot });
  if (goVersion.status !== 0) {
    return {
      ok: true,
      mode: "static-go-source-check",
      startedAt,
      finishedAt: new Date().toISOString(),
      command: "go test ./...",
      message: "Go toolchain is not installed on this host; generated Go source structure was checked, but real compilation was not executed.",
      warnings: ["install Go on the build worker to run gofmt/go test/go build"]
    };
  }

  const testResult = spawnSync("go", ["test", "./..."], {
    encoding: "utf8",
    timeout: 120000,
    cwd: buildRoot
  });
  if (testResult.status !== 0) {
    return {
      ok: false,
      mode: "go-test",
      startedAt,
      finishedAt: new Date().toISOString(),
      command: "go test ./...",
      message: "generated Go source failed go test ./...",
      stdout: clean(testResult.stdout || ""),
      stderr: clean(testResult.stderr || "")
    };
  }
  const buildResult = spawnSync("go", ["build", "./..."], {
    encoding: "utf8",
    timeout: 120000,
    cwd: buildRoot
  });
  return {
    ok: buildResult.status === 0,
    mode: "go-build",
    startedAt,
    finishedAt: new Date().toISOString(),
    command: "go test ./... && go build ./...",
    message: buildResult.status === 0 ? "generated Go source compiled in go test and go build" : "generated Go source passed go test but failed go build ./...",
    stdout: [clean(testResult.stdout || ""), clean(buildResult.stdout || "")].filter(Boolean).join("\n"),
    stderr: [clean(testResult.stderr || ""), clean(buildResult.stderr || "")].filter(Boolean).join("\n")
  };
}

function extractJsonObject(text) {
  const value = String(text || "");
  const start = value.lastIndexOf("\n{");
  if (start >= 0) return value.slice(start + 1);
  const directStart = value.indexOf("{");
  return directStart >= 0 ? value.slice(directStart) : value;
}

function getDashboard() {
  const state = loadState();
  const exporter = state.exporters.find((item) => item.id === state.selectedExporterId) || state.exporters[0] || null;
  return {
    exporter,
    exporters: state.exporters,
    capabilityPackages: state.capabilityPackages || [],
    exporterCatalog: state.exporterCatalog,
    extensionPoints: EXTENSION_POINTS,
    summary: {
      exporterCount: state.exporters.length,
      catalogCount: state.exporterCatalog.length,
      customCount: exporter ? exporter.customItems.filter((item) => item.status === "enabled").length : 0,
      diffCount: exporter ? exporter.diffs.length : 0,
      trunkChangeCount: exporter ? exporter.trunkChanges.length : 0,
      buildCount: exporter ? exporter.builds.length : 0,
      instanceCount: exporter ? exporter.instances.length : 0,
      runningVersionCount: exporter ? new Set(exporter.instances.map((item) => item.runningVersion)).size : 0
    },
    activity: state.activity.slice(0, 20)
  };
}

async function syncExporterCatalog() {
  const state = loadState();
  const results = [];
  for (const item of state.exporterCatalog) {
    const result = await syncCatalogItem(item);
    results.push(result);
  }
  addActivity(state, "Exporter 目录已同步", `已同步 ${results.length} 类 exporter，成功 ${results.filter((item) => item.syncStatus === "success").length} 个。`);
  saveState(state);
  return state.exporterCatalog;
}

async function syncCatalogItem(item) {
  if (!item.owner || !item.repo) {
    item.syncStatus = "failed";
    item.updateSummary = "缺少 GitHub owner/repo，无法同步。";
    item.syncedAt = new Date().toISOString();
    return item;
  }

  try {
    const release = await fetchJson(githubApiUrl(`/repos/${item.owner}/${item.repo}/releases/latest`));
    item.latestVersion = release.tag_name || release.name || "未知版本";
    item.latestPublishedAt = release.published_at || null;
    item.releaseUrl = release.html_url || item.officialRepo;
    const localSummary = summarizeReleaseNotes(release.body || release.name || "");
    item.rawUpdateSummary = localSummary;
    item.summarySource = "local";
    item.aiError = "";
    try {
      const aiSummary = await summarizeWithHunyuan({
        name: item.name,
        version: item.latestVersion,
        body: release.body || release.name || ""
      });
      if (aiSummary) {
        item.updateSummary = cleanReleaseSummary(aiSummary);
        item.summarySource = "hunyuan";
      } else {
        item.updateSummary = localSummary;
      }
    } catch (error) {
      item.updateSummary = localSummary;
      item.aiError = error.message;
    }
    const releasePackages = createGitHubReleasePackages(item, release);
    item.packages = releasePackages.reduce((packages, pkg) => upsertVersionPackage(packages, pkg), item.packages || []);
    item.assetCount = releasePackages.filter((pkg) => pkg.assetType !== "source-archive").length;
    item.buildableAssetCount = releasePackages.filter((pkg) => pkg.availableForBuild).length;
    item.syncStatus = "success";
    item.syncedAt = new Date().toISOString();
  } catch (error) {
    item.syncStatus = "failed";
    item.updateSummary = `同步失败：${error.message}`;
    item.syncedAt = new Date().toISOString();
  }
  return item;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "accept": "application/vnd.github+json",
      "user-agent": "exporter-version-manager"
    }
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

function githubApiUrl(pathname) {
  return `${GITHUB_API_BASE_URL}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function createGitHubReleasePackages(item, release) {
  const version = release.tag_name || release.name || item.latestVersion || "unknown";
  const common = {
    exporterId: item.id,
    exporterName: item.name,
    version,
    source: "github-release",
    releaseUrl: release.html_url || item.officialRepo,
    publishedAt: release.published_at || new Date().toISOString(),
    updateSummary: item.updateSummary,
    summarySource: item.summarySource,
    syncStatus: "success"
  };
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const packages = assets.map((asset) => {
    const meta = inferReleaseAsset(asset.name || "");
    return createVersionPackage({
      ...common,
      id: `github-${hash(`${item.id}-${version}-${asset.name || asset.id}`)}`,
      fileName: asset.name || "",
      size: asset.size,
      checksum: asset.digest || "",
      downloadUrl: asset.browser_download_url || "",
      assetUrl: asset.url || "",
      assetType: meta.assetType,
      os: meta.os,
      arch: meta.arch,
      availableForBuild: meta.availableForBuild,
      note: meta.note
    });
  });
  packages.push(createVersionPackage({
    ...common,
    id: `github-${hash(`${item.id}-${version}-source-tarball`)}`,
    fileName: `${item.name || item.id}-${version}-source.tar.gz`,
    size: null,
    checksum: "",
    downloadUrl: release.tarball_url || "",
    assetUrl: release.tarball_url || "",
    assetType: "source-archive",
    os: "source",
    arch: "source",
    availableForBuild: true,
    note: "GitHub source archive，可作为企业源码装配基线"
  }));
  return packages;
}

function inferReleaseAsset(fileName) {
  const value = String(fileName || "").toLowerCase();
  const os = value.includes("windows") || value.endsWith(".exe") || value.endsWith(".msi") ? "windows"
    : value.includes("linux") ? "linux"
      : value.includes("darwin") || value.includes("macos") ? "darwin"
        : value.includes("freebsd") ? "freebsd"
          : value.includes("openbsd") ? "openbsd"
            : value.includes("netbsd") ? "netbsd"
              : value.includes("aix") ? "aix"
                : value.includes("solaris") ? "solaris"
                  : "unknown";
  const arch = value.includes("arm64") || value.includes("aarch64") ? "arm64"
    : value.includes("amd64") || value.includes("x86_64") ? "amd64"
      : value.includes("386") || value.includes("i386") ? "386"
        : value.includes("s390x") ? "s390x"
          : value.includes("riscv64") ? "riscv64"
            : value.includes("ppc64le") ? "ppc64le"
              : value.includes("ppc64") ? "ppc64"
                : value.includes("mips64le") ? "mips64le"
                  : value.includes("mips64") ? "mips64"
                    : value.includes("mipsle") ? "mipsle"
                      : value.includes("mips") ? "mips"
                        : value.includes("armv7") ? "armv7"
                          : value.includes("armv6") ? "armv6"
                            : value.includes("armv5") ? "armv5"
                              : "unknown";
  const isArchive = /\.(tar\.gz|tgz|zip|gz|xz)$/i.test(fileName);
  const isExecutable = /\.(exe|msi)$/i.test(fileName);
  const isChecksum = /(sha256|checksums?|\.sum$|\.txt$|\.json$|\.sig$)/i.test(fileName);
  const assetType = isChecksum ? "metadata" : os !== "unknown" || isExecutable ? "binary" : isArchive ? "archive" : "asset";
  return {
    os,
    arch,
    assetType,
    availableForBuild: assetType === "binary" || assetType === "archive",
    note: assetType === "metadata" ? "校验或元数据文件" : "GitHub release asset"
  };
}

function summarizeReleaseNotes(body) {
  const cleaned = String(body || "")
    .replace(/\r/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\*\*Full Changelog\*\*:.*/gi, "")
    .replace(/https:\/\/github\.com\/\S+/g, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "")
    .split("\n")
    .map(normalizeReleaseLine)
    .map(clipReleaseLine)
    .filter((line) => line && !line.startsWith("http") && !/^by @/.test(line) && !/^What's Changed/i.test(line))
    .filter((line) => !/^(Changes|Changelog|Features|Bug Fixes)$/i.test(line))
    .slice(0, 4);
  if (!cleaned.length) return "该版本未提供详细 release notes。";
  return cleanReleaseSummary(cleaned.join("；"));
}

function normalizeReleaseLine(line) {
  return String(line || "")
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s*/, "")
    .replace(/`/g, "")
    .replace(/\*\*/g, "")
    .replace(/^PR\s+#\d+\s+-\s+/i, "")
    .replace(/^BREAKING CHANGES:?$/i, "【破坏性变更】")
    .replace(/^BREAKING CHANGES?:\s*/i, "【破坏性变更】")
    .replace(/^\[FEATURE\]\s*/i, "【新增能力】")
    .replace(/^\[BUGFIX\]\s*/i, "【修复】")
    .replace(/^\[CHANGE\]\s*/i, "【变更】")
    .replace(/^\[ENHANCEMENT\]\s*/i, "【增强】")
    .replace(/^Changes:\s*/i, "")
    .replace(/^Fix\s+/i, "【修复】")
    .replace(/^Support\s+/i, "【新增能力】支持 ")
    .replace(/^Add support for\s+/i, "【新增能力】支持 ")
    .replace(/\s+by @\w+.*$/i, "")
    .trim();
}

function clipReleaseLine(line) {
  const value = String(line || "").trim();
  return value.length > 96 ? `${value.slice(0, 96)}...` : value;
}

function cleanReleaseSummary(summary) {
  return String(summary || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\s)[-*]\s+/g, "$1")
    .replace(/(^|；)\s*Changes:\s*/gi, "$1")
    .replace(/【新增能力】Add support for\s+/gi, "【新增能力】支持 ")
    .replace(/【新增能力】Allow\s+/gi, "【新增能力】允许 ")
    .replace(/【修复】Fix\s+/gi, "【修复】")
    .replace(/【[^】]+】\s*无[。.]?/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 520);
}

function createVersionPackage(input = {}) {
  return {
    id: clean(input.id || `${input.source || "package"}-${hash(`${input.exporterId}-${input.version}-${input.fileName || ""}`)}`),
    exporterId: clean(input.exporterId),
    exporterName: clean(input.exporterName || input.exporterId),
    version: clean(input.version),
    source: clean(input.source || "github-release"),
    sourceLabel: input.source === "manual-upload" ? "手动上传" : "GitHub Release",
    fileName: clean(input.fileName || ""),
    size: Number.isFinite(input.size) ? input.size : null,
    checksum: clean(input.checksum || ""),
    storagePath: clean(input.storagePath || ""),
    downloadUrl: clean(input.downloadUrl || ""),
    assetUrl: clean(input.assetUrl || ""),
    assetType: clean(input.assetType || ""),
    os: clean(input.os || ""),
    arch: clean(input.arch || ""),
    availableForBuild: Boolean(input.availableForBuild || input.storagePath),
    releaseUrl: clean(input.releaseUrl || ""),
    publishedAt: clean(input.publishedAt || input.uploadedAt || new Date().toISOString()),
    updateSummary: clean(input.updateSummary || ""),
    summarySource: clean(input.summarySource || "local"),
    syncStatus: clean(input.syncStatus || "success"),
    note: clean(input.note || ""),
    uploadedAt: clean(input.uploadedAt || "")
  };
}

function upsertCapabilityPackage(packages, pkg) {
  const list = Array.isArray(packages) ? packages : [];
  return [pkg].concat(list.filter((item) => item.id !== pkg.id));
}

function createCapabilityInfo(pkg, exporter = {}) {
  const id = clean(pkg.id || pkg.packageId || pkg.name);
  const kind = clean(pkg.kind || pkg.type || pkg.extensionPoint || "metric");
  const sourcePath = clean(pkg.sourcePath || pkg.path || `custom/capabilities/${id}/capability.go`);
  const modulePath = clean(exporter.modulePath || exporter.exporterConfig?.modulePath || "example.com/exporter");
  return {
    ...pkg,
    id,
    packageId: id,
    name: clean(pkg.name || id),
    kind,
    type: kind,
    version: clean(pkg.version || pkg.packageVersion || "1.0.0"),
    description: clean(pkg.description || "Reusable capability package"),
    owner: clean(pkg.owner || "platform-team"),
    import_path: clean(pkg.import_path || `${modulePath}/${sourcePath.replace(/\\/g, "/").replace(/\/[^/]+\.go$/, "")}`),
    source: clean(pkg.source || sourcePath),
    sourcePath,
    default_enabled: Boolean(pkg.default_enabled ?? pkg.defaultEnabled ?? false),
    provides: Array.isArray(pkg.provides) ? pkg.provides : [kind],
    requires: Array.isArray(pkg.requires) ? pkg.requires : [],
    metrics: Array.isArray(pkg.metrics) ? pkg.metrics : [],
    config: pkg.config && typeof pkg.config === "object" ? pkg.config : {},
    compatible: normalizeCompatibleRange(pkg.compatible),
    files: Array.isArray(pkg.files) && pkg.files.length ? pkg.files : [sourcePath]
  };
}

function resolveSelectedPackage(state, selection) {
  const pkg = (state.capabilityPackages || []).find((item) => item.id === (selection.packageId || selection.id));
  return {
    selectionId: selection.selectionId || selection.id,
    packageId: selection.packageId || selection.id,
    name: pkg?.name || selection.name,
    kind: pkg?.kind || pkg?.type || selection.kind || selection.type,
    type: pkg?.kind || pkg?.type || selection.kind || selection.type,
    version: selection.packageVersion || pkg?.version || "1.0.0",
    sourcePath: pkg?.sourcePath || selection.sourcePath || selection.path,
    import_path: pkg?.import_path || "",
    source: pkg?.source || pkg?.sourcePath || selection.sourcePath || selection.path,
    default_enabled: Boolean(pkg?.default_enabled ?? false),
    provides: pkg?.provides || [],
    requires: pkg?.requires || [],
    metrics: pkg?.metrics || [],
    config: pkg?.config || {},
    compatible: pkg?.compatible || {},
    files: pkg?.files || [],
    entry: pkg?.entry || selection.entry,
    checksum: hash(`${pkg?.id || selection.id}:${pkg?.version || selection.packageVersion || "1.0.0"}:${pkg?.sourcePath || selection.path}`),
    owner: pkg?.owner || "未登记",
    description: pkg?.description || selection.description || "",
    editableCode: pkg?.editableCode || selection.editableCode || "",
    generatedCode: pkg?.generatedCode || selection.generatedCode || ""
  };
}

function createCustomLock(exporter, packages, version) {
  return {
    path: "custom/custom.lock.yaml",
    generatedAt: new Date().toISOString(),
    exporter: exporter.id,
    buildVersion: version,
    officialBaseline: exporter.officialBaseline,
    companyExt: exporter.companyExt?.path || "company/ext",
    packages: packages.map((pkg) => ({
      packageId: pkg.packageId,
      kind: pkg.kind || pkg.type,
      version: pkg.version,
      sourcePath: pkg.sourcePath,
      import_path: pkg.import_path,
      provides: pkg.provides || [],
      requires: pkg.requires || [],
      checksum: pkg.checksum
    }))
  };
}

function createBuildConfig(exporter, packages, input = {}) {
  return {
    path: clean(input.buildConfigPath || "build/exporter-builder.yaml"),
    builder: "exporter-builder",
    sourceMode: "source-build",
    goMod: "go.mod",
    companyExt: "company/ext",
    exporterConfig: exporter.exporterConfig?.path || ".exporter.yaml",
    customConfig: "custom/custom.yaml",
    lockFile: "custom/custom.lock.yaml",
    generatedAssembly: "custom/all/all_gen.go",
    generatedRegistry: "company/ext/capabilities_gen.go",
    buildInfo: "dist/build-info.json",
    packageCount: packages.length
  };
}

function renderAssemblySource(build) {
  const packages = build.selectedPackages || [];
  return `package all

// Code generated by exporter-builder. DO NOT EDIT.
// Build: ${build.version}

import (
${packages.map((pkg) => `    _ "${pkg.import_path || `example.com/exporter/custom/capabilities/${pkg.packageId}`}"`).join("\n")}
)
`;
}

function renderCapabilitiesRegistrySource(build) {
  const packages = build.selectedPackages || [];
  return `package ext

// Code generated by exporter-builder. DO NOT EDIT.
// Build: ${build.version}

func init() {
${packages.map((pkg) => `    RegisterCapability(CapabilityInfo{
        Name: "${pkg.packageId}",
        Kind: CapabilityKind("${pkg.kind || pkg.type}"),
        Version: "${pkg.version}",
        Description: "${escapeGo(pkg.description || pkg.name || "")}",
        Owner: "${escapeGo(pkg.owner || "")}",
        ImportPath: "${pkg.import_path || ""}",
        Source: "${pkg.source || pkg.sourcePath || ""}",
        DefaultEnabled: ${pkg.default_enabled ? "true" : "false"},
        Provides: []string{${(pkg.provides || []).map((item) => `"${escapeGo(item)}"`).join(", ")}},
        Requires: []string{${(pkg.requires || []).map((item) => `"${escapeGo(item)}"`).join(", ")}},
        Metrics: []string{${(pkg.metrics || []).map((item) => `"${escapeGo(item)}"`).join(", ")}},
        Files: []string{${(pkg.files || []).map((item) => `"${escapeGo(item)}"`).join(", ")}},
    })`).join("\n")}
}
`;
}

function toYaml(value, indent = 0) {
  const space = " ".repeat(indent);
  if (Array.isArray(value)) {
    return value.map((item) => `${space}- ${typeof item === "object" && item !== null ? `\n${toYaml(item, indent + 2)}` : item}`).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, val]) => {
        if (val && typeof val === "object") return `${space}${key}:\n${toYaml(val, indent + 2)}`;
        return `${space}${key}: ${String(val ?? "")}`;
      })
      .join("\n");
  }
  return `${space}${String(value ?? "")}`;
}

function createTarGz(files) {
  const chunks = [];
  Object.entries(files).forEach(([name, content]) => {
    const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
    const header = createTarHeader(name, body.length);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  });
  chunks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(chunks));
}

function createTarHeader(name, size) {
  const header = Buffer.alloc(512, 0);
  writeTarText(header, 0, 100, name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeTarText(header, 257, 6, "ustar");
  writeTarText(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarOctal(header, 148, 8, checksum);
  return header;
}

function writeTarText(buffer, offset, length, value) {
  const text = Buffer.from(String(value || ""), "utf8");
  text.copy(buffer, offset, 0, Math.min(text.length, length));
}

function writeTarOctal(buffer, offset, length, value) {
  const text = Math.trunc(value).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function upsertVersionPackage(packages, pkg) {
  const list = Array.isArray(packages) ? packages : [];
  return [pkg]
    .concat(list.filter((item) => item.id !== pkg.id && !(item.version === pkg.version && item.source === pkg.source && item.fileName === pkg.fileName)))
    .slice(0, 30);
}

function findCatalogPackage(state, packageId) {
  const id = clean(packageId);
  if (!id) return null;
  for (const catalog of state.exporterCatalog || []) {
    const found = (catalog.packages || []).find((pkg) => pkg.id === id || pkg.version === id);
    if (found) return found;
  }
  return null;
}

function parseVersionFromFileName(fileName) {
  const match = clean(fileName).match(/(?:^|[-_])v?(\d+\.\d+\.\d+(?:[-+._a-zA-Z0-9]*)?)/);
  return match ? `v${match[1].replace(/^v/, "")}` : "";
}

function generateDiffs(exporter) {
  const trunkDiffs = exporter.trunkChanges.map((item) => ({
    id: `diff-trunk-${hash(item.id)}`,
    file: item.file,
    change: item.type === "company-ext-hook" ? "company/ext 稳定接口" : "版本补丁 / 主干侵入改动",
    risk: item.risk || "medium",
    boundary: item.type === "company-ext-hook" ? "company-ext" : "version-patch",
    summary: item.summary
  }));
  const configDiff = {
    id: `diff-custom-config-${hash(exporter.id)}`,
    file: "custom/custom.yaml",
    change: "custom 能力包装配清单",
    risk: "low",
    boundary: "custom-config",
    summary: "只记录当前企业发行选择了哪些可复用能力包，不把能力包伪装成主干补丁。"
  };
  const customDiffs = exporter.customItems
    .filter((item) => item.status === "enabled")
    .map((item) => ({
      id: `diff-${hash(item.id)}`,
      file: item.sourcePath || item.path,
      change: "custom 可复用能力包",
      risk: item.type === "config" ? "medium" : "low",
      boundary: "custom-package",
      summary: `${item.name}：${item.description || "可复用 custom 能力包"}`
    }));
  return trunkDiffs.concat(configDiff, customDiffs);
}

function normalizeRegistryHook(exporter, input = {}) {
  const hook = exporter.collectorRegistryHook || {};
  const companyExt = exporter.companyExt || {};
  return {
    file: clean(input.registryHookFile || hook.file || `${companyExt.path || "company/ext"}/registry.go`),
    symbol: clean(input.registryHookSymbol || hook.symbol || "RegisterCompanyExt"),
    strategy: "stable-hook",
    description: hook.description || "官方主干只保留 company/ext 稳定接口，custom 能力包在构建期装配。"
  };
}

function normalizeManifest(exporter) {
  const selected = exporter.customItems.filter((item) => item.status === "enabled");
  return {
    path: "custom/custom.yaml",
    schemaVersion: exporter.customManifest?.schemaVersion || "v1",
    kind: "custom-package-selection",
    compileMode: "source-build",
    exporterId: exporter.id,
    companyBranch: exporter.companyBranch || exporter.localBranch,
    officialBaseline: exporter.officialBaseline,
    officialPackageId: exporter.officialPackageId || "",
    exporterConfigPath: exporter.exporterConfig?.path || ".exporter.yaml",
    companyExtPath: exporter.companyExt?.path || "company/ext",
    customDir: "custom",
    registryHook: `${exporter.collectorRegistryHook.file}:${exporter.collectorRegistryHook.symbol}`,
    packages: selected.map((item) => ({
        selectionId: item.selectionId || item.id,
        packageId: item.packageId || item.id,
        packageVersion: item.packageVersion || "1.0.0",
        name: item.name,
        kind: item.kind || item.type,
        type: item.kind || item.type,
        extensionPoint: item.extensionPoint || item.kind || item.type,
        sourcePath: item.sourcePath || item.path,
        import_path: item.import_path || "",
        default_enabled: Boolean(item.default_enabled ?? false),
        provides: item.provides || [],
        requires: item.requires || [],
        metrics: item.metrics || [],
        config: item.config || {},
        compatible: item.compatible || {},
        files: item.files || [item.sourcePath || item.path],
        entry: item.entry,
        validationStatus: item.validation?.status || "unknown",
        description: item.description
      })),
    entries: selected.map((item) => ({
      id: item.packageId || item.id,
      name: item.name,
      kind: item.kind || item.type,
      type: item.kind || item.type,
      path: item.sourcePath || item.path,
      entry: item.entry,
      validationStatus: item.validation?.status || "unknown",
      description: item.description
    }))
  };
}

function normalizeExporterConfig(exporter) {
  return {
    path: ".exporter.yaml",
    schemaVersion: "v1",
    exporter: exporter.id,
    upstream: {
      repo: exporter.officialRepo,
      remote: exporter.upstreamRemote || "upstream",
      branch: exporter.officialBranch || "main",
      baseline: exporter.officialBaseline
    },
    company: {
      branch: exporter.companyBranch || exporter.localBranch,
      version: exporter.localVersion,
      ext: "company/ext"
    },
    customConfig: "custom/custom.yaml"
  };
}

function normalizeCompanyExt(exporter) {
  return {
    path: exporter.companyExt?.path || "company/ext",
    interfaceVersion: exporter.companyExt?.interfaceVersion || "v1",
    registryHook: exporter.companyExt?.registryHook || "company/ext/registry.go:RegisterCompanyExt",
    description: exporter.companyExt?.description || "稳定扩展接口，官方代码只保留最小接入点。"
  };
}

function normalizeTrunkChanges(exporter) {
  const existing = Array.isArray(exporter.trunkChanges) ? exporter.trunkChanges : [];
  if (existing.length) return existing;
  return [
    {
      id: "stable-registry-hook",
      file: "company/ext/registry.go",
      type: "company-ext-hook",
      risk: "low",
      summary: "保留 company/ext 稳定接口，其余二开能力通过 custom/custom.yaml 装配。"
    }
  ];
}

function getExtensionPoint(id) {
  return EXTENSION_POINTS.find((item) => item.id === id) || EXTENSION_POINTS[0];
}

function validateEditableCode(extensionPoint, code) {
  const errors = [];
  if (!code.trim()) errors.push("可编辑代码不能为空");
  if (!/return\s+/.test(code)) errors.push("代码需要包含 return，确保构建期生成的函数可返回结果");
  if (extensionPoint.id === "metric" && !/Metric\s*\{/.test(code)) {
    errors.push("Metric 扩展建议返回 Metric 结构");
  }
  if (extensionPoint.id === "scraper" && !/(endpoint|url|http)/i.test(code)) {
    errors.push("Scraper 扩展需要声明 endpoint/url/http 请求目标");
  }
  if (extensionPoint.id === "scraper" && !/Metric\s*\{/.test(code)) {
    errors.push("Scraper 扩展需要将外部服务响应转换为 Metric");
  }
  if (extensionPoint.id === "transform" && !/metrics/.test(code)) {
    errors.push("Transform 扩展需要处理 metrics 入参");
  }
  const syntaxError = validateGoSnippetSyntax(extensionPoint, code);
  if (syntaxError) errors.push(syntaxError);
  return {
    status: errors.length ? "failed" : "passed",
    errors
  };
}

function validateGoSnippetSyntax(extensionPoint, code) {
  if (!code.trim()) return "";
  const generated = renderGeneratedSource({ collectorRegistryHook: { symbol: "RegisterCompanyExt" } }, extensionPoint, {
    id: "syntax-check",
    name: "syntax-check",
    path: `custom/capabilities/syntax-check/${extensionPoint.defaultFile || "capability.go"}`,
    entry: `${extensionPoint.entryPrefix || "NewCapability"}_SyntaxCheck`,
    description: "syntax check",
    editableCode: code
  });
  const result = spawnSync("gofmt", [], {
    input: generated,
    encoding: "utf8",
    timeout: 10000
  });
  if (result.error && result.error.code === "ENOENT") return "";
  if (result.status !== 0) {
    return `Go 语法校验失败：${clean(result.stderr || result.stdout || result.error?.message || "gofmt failed")}`;
  }
  return "";
}

function renderGeneratedSource(exporter, extensionPoint, item) {
  const kind = extensionPoint.kind || extensionPoint.id || "metric";
  const packageName = goPackageName(path.basename(path.dirname(item.path || "capability")));
  const modulePath = exporter.exporterConfig?.modulePath || "example.com/exporter";
  const provides = item.provides || [`${kind}:${item.id || item.name}`];
  const requires = item.requires || [];
  const metrics = item.metrics || [];
  return `package ${packageName}

// Code generated by Exporter Studio.
// Extension: ${item.name}
// Source path: ${item.path}
// Registry hook: ${exporter.collectorRegistryHook?.symbol || "RegisterCompanyExt"}

${renderGoImports(modulePath, item.editableCode)}

type Metric struct {
    Name string
    Type string
    Help string
    Labels map[string]string
    Value float64
}

type Credentials struct {
    Source string
    Path string
    Values map[string]string
}

type Target struct {
    Address string
    Labels map[string]string
}

type ConfigProfile struct {
    Name string
    Values map[string]string
}

var _ = ext.CapabilityInfo{}

${renderCapabilityFunction(kind, item.entry, item.editableCode)}
`;
}

function renderCapabilityFunction(kind, entry, editableCode) {
  const name = entry || "NewCapability";
  const body = indentCode(editableCode || "return nil, nil", "    ");
  const prelude = kind === "transform"
    ? "    metrics := []Metric{}\n"
    : kind === "security"
      ? "    var next interface{}\n    _ = next\n"
      : "";
  return `func ${name}() (interface{}, error) {
${prelude}${prelude ? "" : ""}
${body}
}`;
}

function renderGoImports(modulePath, editableCode) {
  const code = String(editableCode || "");
  const imports = [`${modulePath}/company/ext`];
  const candidates = [
    ["fmt.", "fmt"],
    ["http.", "net/http"],
    ["time.", "time"],
    ["context.", "context"],
    ["io.", "io"],
    ["strings.", "strings"],
    ["strconv.", "strconv"],
    ["json.", "encoding/json"],
    ["url.", "net/url"],
    ["tls.", "crypto/tls"]
  ];
  for (const [needle, importPath] of candidates) {
    if (code.includes(needle) && !imports.includes(importPath)) imports.push(importPath);
  }
  if (imports.length === 1) return `import "${imports[0]}"`;
  return [
    "import (",
    ...imports.map((item) => `    "${item}"`),
    ")"
  ].join("\n");
}

function indentCode(code, prefix) {
  return String(code || "")
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

function toPascal(value) {
  return String(value || "Custom")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function addActivity(state, title, detail) {
  state.activity.unshift({
    id: `activity-${Date.now()}`,
    title,
    detail,
    createdAt: new Date().toISOString()
  });
  state.activity = state.activity.slice(0, 50);
}

function hash(value) {
  return crypto.createHash("sha1").update(String(value)).digest("hex").slice(0, 8);
}

function escapeGo(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function labelValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n");
}

function goStringArray(values) {
  return (Array.isArray(values) ? values : [])
    .map((item) => `"${escapeGo(item)}"`)
    .join(", ");
}

function goPackageName(value) {
  const name = String(value || "capability")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(name) ? name : `pkg_${name || "capability"}`;
}

function normalizeCompatibleRange(compatible) {
  const range = compatible && typeof compatible === "object" ? compatible : {};
  const exporters = Array.isArray(range.exporters) && range.exporters.length ? range.exporters.map(clean).filter(Boolean) : ["*"];
  const versionScoped = exporters.length > 0 && exporters.every((item) => /_exporter-v\d/i.test(item));
  return {
    exporters: versionScoped ? ["*"] : exporters,
    min_version: clean(range.min_version || range.minVersion || ""),
    max_version: clean(range.max_version || range.maxVersion || "")
  };
}

function cleanEnv(value) {
  return String(value || "").trim();
}

function clean(value) {
  return String(value || "").trim();
}

function sanitizeFileName(value) {
  return clean(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 160);
}

function normalizeCmgBranch(branch, exporterName) {
  const name = clean(exporterName || "exporter");
  const current = clean(branch);
  if (!current) return `cmg/${name}`;
  if (current.startsWith("company/")) return `cmg/${current.slice("company/".length)}`;
  return current;
}

function normalizeLocalVersion(version, exporterName) {
  const name = clean(exporterName || "exporter") || "exporter";
  const current = clean(version);
  if (!current) return `${name}-internal-1.0.0`;
  return current.startsWith(`${name}-`) ? current : `${name}-internal-1.0.0`;
}

function shouldUsePackageScopedId(requestedId, exporterName, input = {}) {
  if (!requestedId || requestedId !== exporterName) return false;
  return Boolean(input.officialPackageId || input.officialBaselinePackageId || input.packageId || input.officialBaseline);
}

function makeEnterpriseVersionId(exporterName, seed) {
  return `${clean(exporterName || "exporter")}-${sanitizeIdPart(seed || "baseline")}`;
}

function sanitizeIdPart(value) {
  return clean(value)
    .toLowerCase()
    .replace(/^github-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "baseline";
}

function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input || "").split(/[,\s，、]+/);
  return [...new Set(raw.map((item) => clean(item)).filter(Boolean))].slice(0, 12);
}

function relativePath(value) {
  return path.relative(process.cwd(), value).replace(/\\/g, "/");
}

function resolveBuildFile(value) {
  const file = clean(value);
  if (!file) return "";
  const resolved = path.resolve(process.cwd(), file);
  const buildRoot = path.resolve(BUILD_DIR);
  return resolved.startsWith(buildRoot) ? resolved : "";
}

module.exports = {
  addCustomItem,
  createBuild,
  deleteBuild,
  deleteCustomItem,
  deleteInstance,
  disableCustomItem,
  getCurrentExporter,
  getBuildDownload,
  getDashboard,
  refreshDiffs,
  saveExporter,
  saveCapabilityPackage,
  saveInstance,
  selectExporter,
  syncExporterCatalog,
  updateBuildTags,
  uploadOfficialVersion
};
