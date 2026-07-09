const qs = (selector) => document.querySelector(selector);
const qsa = (selector) => Array.from(document.querySelectorAll(selector));
const on = (selector, event, handler) => {
  const el = qs(selector);
  if (el) el.addEventListener(event, handler);
};

const viewMeta = {
  dashboard: ["工作台", "围绕官方基线、企业分支、能力包和构建发布维护 exporter 企业版本。"],
  governance: ["版本治理", "维护 upstream/main、官方基线、cmg branch、管理责任人和官方版本目录。"],
  custom: ["定制开发", "沉淀可复用能力包，通过固定扩展点约束 exporter 二次开发。"],
  delivery: ["发布运行", "选择企业版本、官方基线包和能力包，完成装配构建与产物下载。"],
  activity: ["操作记录", "查看目录同步、元数据维护、能力包保存和构建发布动作。"]
};

const capabilityCodeExamples = {
  collector: `// Collector 示例：采集一个内部健康状态指标
metrics := []Metric{
    {
        Name: "company_collector_up",
        Type: "gauge",
        Help: "Company collector health",
        Labels: map[string]string{"collector": "company"},
        Value: 1,
    },
}
return metrics, nil`,
  scraper: `// Scraper 示例：访问内部 HTTP 服务并转换为指标
endpoint := "http://127.0.0.1:8080/metrics/custom"
req, err := http.NewRequest("GET", endpoint, nil)
if err != nil {
    return nil, err
}
req.Header.Set("testauth", "your-token")

resp, err := http.DefaultClient.Do(req)
if err != nil {
    return nil, err
}
defer resp.Body.Close()

metric := Metric{
    Name: "external_service_up",
    Type: "gauge",
    Help: "External service scrape status",
    Labels: map[string]string{"endpoint": endpoint},
    Value: 1,
}
return []Metric{metric}, nil`,
  metric: `// Metric 示例：补充一个固定企业指标
metric := Metric{
    Name: "company_metric",
    Type: "gauge",
    Help: "Company custom metric",
    Labels: map[string]string{"source": "custom"},
    Value: 1,
}
return []Metric{metric}, nil`,
  transform: `// Transform 示例：给已有指标补充标准标签
for i := range metrics {
    if metrics[i].Labels == nil {
        metrics[i].Labels = map[string]string{}
    }
    metrics[i].Labels["company_region"] = "cn-north"
}
return metrics, nil`,
  security: `// Security 示例：要求访问 /metrics 时携带 testauth 请求头
requiredHeader := "testauth"
requiredValue := "your-token"

return func(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Header.Get(requiredHeader) != requiredValue {
            http.Error(w, "missing or invalid testauth header", http.StatusUnauthorized)
            return
        }
        next.ServeHTTP(w, r)
    })
}, nil`,
  credential_provider: `// Credential Provider 示例：从文件加载认证信息
path := "/etc/exporter/credentials.yaml"
credentials := Credentials{
    Source: "file",
    Path: path,
}
return credentials, nil`,
  discovery: `// Discovery 示例：返回一组静态采集目标
targets := []Target{
    {
        Address: "10.0.0.10:9100",
        Labels: map[string]string{"env": "prod", "job": "node"},
    },
}
return targets, nil`,
  config_profile: `// Config Profile 示例：沉淀厂商默认采集配置
profile := ConfigProfile{
    Name: "huawei-snmp",
    Labels: map[string]string{"vendor": "huawei"},
}
return profile, nil`,
  protocol_client: `// Protocol Client 示例：创建可复用 HTTP 客户端
client := &http.Client{
    Timeout: 3 * time.Second,
}
return client, nil`,
  cache: `// Cache 示例：声明一个内存缓存策略
cache := CacheConfig{
    Type: "memory",
    TTL: "30s",
    MaxEntries: 1024,
}
return cache, nil`,
  bundle: `// Bundle 示例：组合多个能力包供发布时一键选择
packages := []string{
    "authtest",
}
return packages, nil`
};

let dashboard = null;
let selectedExtensionPoint = null;
let editingCapabilityId = null;
let lastSavedCapabilityId = "";
let activeBuild = null;
let buildSearchQuery = "";

const buildTargetPresets = [
  {
    id: "linux-amd64",
    label: "Linux 服务器 / Intel、AMD x86_64",
    os: "linux",
    arch: "amd64",
    note: "适合大多数 Linux 物理机、虚拟机和云主机，产物没有 .exe 后缀。"
  },
  {
    id: "linux-arm64",
    label: "Linux 服务器 / ARM 64 位",
    os: "linux",
    arch: "arm64",
    note: "适合鲲鹏、飞腾、Ampere、AWS Graviton 等 ARM 64 位 Linux 服务器。"
  },
  {
    id: "darwin-arm64",
    label: "macOS / Apple 芯片 M1、M2、M3、M4",
    os: "darwin",
    arch: "arm64",
    note: "适合 Apple Silicon Mac。真实 node_exporter 的部分 macOS collector 依赖 CGO/macOS SDK，建议在 macOS 构建机执行；Windows 交叉编译可能失败。"
  },
  {
    id: "darwin-amd64",
    label: "macOS / Intel 芯片",
    os: "darwin",
    arch: "amd64",
    note: "适合较早的 Intel Mac。真实 node_exporter 的部分 macOS collector 依赖 CGO/macOS SDK，建议在 macOS 构建机执行；Windows 交叉编译可能失败。"
  },
  {
    id: "windows-amd64",
    label: "Windows / Intel、AMD x86_64",
    os: "windows",
    arch: "amd64",
    note: "适合常见 64 位 Windows 服务器，产物会带 .exe 后缀。"
  },
  {
    id: "custom",
    label: "其他系统或架构",
    os: "",
    arch: "",
    note: "用于 FreeBSD、AIX、s390x、32 位 ARM 等特殊环境，请展开高级字段手动填写。"
  }
];

qsa(".nav-item").forEach((item) => {
  item.addEventListener("click", () => setView(item.dataset.view));
});

document.addEventListener("click", (event) => {
  const goto = event.target.closest("[data-goto]");
  if (goto) setView(goto.dataset.goto);

  const editVersion = event.target.closest("[data-edit-exporter]");
  if (editVersion) openVersionModal(editVersion.dataset.editExporter);

  const selectVersion = event.target.closest("[data-select-exporter]");
  if (selectVersion) selectExporterVersion(selectVersion.dataset.selectExporter);

  const buildFromPackage = event.target.closest("[data-build-from-package]");
  if (buildFromPackage) {
    openVersionModal(null, {
      catalogId: buildFromPackage.dataset.catalogId,
      packageId: buildFromPackage.dataset.packageId
    });
  }

  const buildFromCatalog = event.target.closest("[data-build-from-catalog]");
  if (buildFromCatalog) {
    openVersionModal(null, {
      catalogId: buildFromCatalog.dataset.catalogId,
      packageId: buildFromCatalog.dataset.packageId
    });
  }

  const editPackage = event.target.closest("[data-edit-package]");
  if (editPackage) openCapabilityModal(editPackage.dataset.editPackage);

  const download = event.target.closest("[data-download-build]");
  if (download) {
    window.location.href = `/api/build/download?buildId=${encodeURIComponent(download.dataset.buildId)}&file=${encodeURIComponent(download.dataset.file)}`;
  }

  const preview = event.target.closest("[data-preview-build]");
  if (preview) openBuildPreview(preview.dataset.buildId, preview.dataset.file);

  const deleteBuildButton = event.target.closest("[data-delete-build]");
  if (deleteBuildButton) deleteBuildRecord(deleteBuildButton.dataset.buildId);

  const saveTags = event.target.closest("[data-save-build-tags]");
  if (saveTags) saveBuildTags(saveTags.dataset.buildId);
});

on("#syncCatalogBtn2", "click", syncCatalog);
on("#openBuildModalBtn", "click", openBuildModal);
on("#closeBuildModalBtn", "click", closeBuildModal);
on("#cancelBuildModalBtn", "click", closeBuildModal);
on("#buildBtn2", "click", createBuild);
on("#closeBuildPreviewBtn", "click", closeBuildPreview);
on("#buildSearchInput", "input", () => {
  buildSearchQuery = value("#buildSearchInput").toLowerCase();
  renderBuilds(dashboard?.exporters || []);
});
on("#openVersionModalBtn", "click", () => openVersionModal());
on("#closeVersionModalBtn", "click", closeVersionModal);
on("#cancelVersionModalBtn", "click", closeVersionModal);
on("#openCatalogUploadBtn", "click", () => qs("#catalogUploadPanel")?.classList.toggle("hidden"));
on("#uploadOfficialBtn", "click", uploadOfficialPackage);
on("#officialPackageId", "change", () => {
  const pkg = findPackageById(value("#officialPackageId"));
  if (pkg) {
    qs("#officialBaseline").value = pkg.version;
    setValue("#minorVersionNote", packageNote(pkg));
    setValue("#enterpriseVersionId", makeEnterpriseVersionId(value("#exporterName"), pkg.version || pkg.id));
  }
});
on("#exporterName", "change", () => {
  const catalog = findCatalogByName(value("#exporterName"));
  if (!catalog) return;
  setValue("#officialRepo", catalog.officialRepo || "");
  setValue("#officialBranch", catalog.officialBranch || "main");
  setValue("#companyBranch", `cmg/${catalog.name || catalog.id}`);
  setValue("#localVersion", `${catalog.name || catalog.id}-internal-1.0.0`);
      renderOfficialPackageOptions({
        name: catalog.name || catalog.id,
        officialPackageId: (catalog.packages || [])[0]?.id || "",
        officialBaseline: (catalog.packages || [])[0]?.version || catalog.latestVersion || ""
      });
      const pkg = findPackageById(value("#officialPackageId"));
      setValue("#minorVersionNote", packageNote(pkg));
      setValue("#enterpriseVersionId", makeEnterpriseVersionId(catalog.name || catalog.id, pkg?.version || pkg?.id || catalog.latestVersion));
      updateVersionDefaultsNote();
    });

on("#openCapabilityModalBtn", "click", () => openCapabilityModal());
on("#closeCapabilityModalBtn", "click", closeCapabilityModal);
on("#cancelCapabilityModalBtn", "click", closeCapabilityModal);
on("#resetTemplateBtn", "click", () => applyExtensionTemplate(selectedExtensionPoint, true));
on("#addCustomBtn", "click", saveCapabilityPackage);
on("#customType", "change", () => {
  selectedExtensionPoint = getExtensionPoint(value("#customType"));
  setValue("#customPath", deriveCapabilityPath());
  applyExtensionTemplate(selectedExtensionPoint, true);
  updateCodeFrameMeta(selectedExtensionPoint);
  updateCapabilityPreview();
});

on("#customId", "input", () => {
  if (!editingCapabilityId) setValue("#customPath", deriveCapabilityPath());
  updateCapabilityPreview();
});

["#customName", "#packageVersion", "#packageOwner", "#customPath", "#customDescription", "#editableCode"].forEach((selector) => {
  on(selector, "input", updateCapabilityPreview);
});

on("#buildExporterSelect", "change", async () => {
  await selectExporterVersion(value("#buildExporterSelect"), { silent: true });
  setView("delivery");
});
["#buildOfficialPackageSelect", "#buildVersion", "#buildOperator", "#buildNote", "#buildPatchNote", "#buildArgs", "#buildTargetPreset", "#buildTargetOs", "#buildTargetArch", "#buildTargetArm"].forEach((selector) => {
  on(selector, "input", renderBuildAssemblyPreview);
  on(selector, "change", renderBuildAssemblyPreview);
});
on("#buildOfficialPackageSelect", "change", syncBuildTargetFromPackage);
on("#buildTargetPreset", "change", applyBuildTargetPreset);
on("#buildTargetArch", "change", updateBuildTargetArmVisibility);
["#buildTargetOs", "#buildTargetArch", "#buildTargetArm"].forEach((selector) => {
  on(selector, "change", () => {
    syncBuildTargetPresetFromFields();
    updateBuildTargetHelp();
    updateBuildArgsFromTarget();
  });
});
on("#buildPackageChecklist", "change", renderBuildAssemblyPreview);

on("#saveExporterBtn", "click", saveExporterMetadata);
on("#closeBuildOverlayBtn", "click", () => showBuildOverlay(false));

async function refresh() {
  dashboard = await get("/api/dashboard");
  selectedExtensionPoint = selectedExtensionPoint || dashboard.extensionPoints?.[0] || null;
  const exporter = dashboard.exporter;

  renderOverview(dashboard.summary, exporter);
  renderExporter(exporter);
  renderVersionFlow(exporter);
  renderExporterVersions(dashboard.exporters || []);
  renderCatalog(dashboard.exporterCatalog || []);
  renderCatalogUploadOptions(dashboard.exporterCatalog || []);
  renderExtensionPoints(dashboard.extensionPoints || []);
  renderCapabilityPackages(dashboard.capabilityPackages || []);
  renderBuildWizard(dashboard);
  renderBuilds(dashboard.exporters || []);
  renderActivity(dashboard.activity || []);
  fillForms(exporter || createExporterDraft());
}

async function syncCatalog() {
  const buttons = [qs("#syncCatalogBtn2")].filter(Boolean);
  setInlineStatus("#catalogSyncStatus", "同步中，正在拉取 release 并整理说明...", "pending");
  buttons.forEach((button) => setBusy(button, true));
  try {
    const catalog = await post("/api/catalog/sync", {});
    const successCount = catalog.filter((item) => item.syncStatus === "success").length;
    const aiCount = catalog.filter((item) => item.summarySource === "hunyuan").length;
    setInlineStatus("#catalogSyncStatus", `已同步 ${successCount}/${catalog.length}，模型整理 ${aiCount} 项`, successCount ? "success" : "error");
    notify("Exporter 目录已同步", `已同步 ${catalog.length} 类 exporter 的 release 信息。`);
    await refresh();
    setView("governance");
  } catch (error) {
    setInlineStatus("#catalogSyncStatus", `同步失败：${error.message}`, "error");
    notify("同步失败", error.message);
  } finally {
    buttons.forEach((button) => setBusy(button, false));
  }
}

async function refreshDiffs() {
  const diffs = await post("/api/diff/refresh", {});
  notify("Git diff 已刷新", `当前共有 ${diffs.length} 条差异，已按 company/ext、custom 和版本补丁边界整理。`);
  await refresh();
}

function openBuildModal() {
  renderBuildWizard(dashboard || {});
  renderBuildAssemblyPreview();
  showModal("#buildModal", true);
}

function closeBuildModal() {
  showModal("#buildModal", false);
}

async function saveExporterMetadata() {
  const button = qs("#saveExporterBtn");
  setInlineStatus("#saveExporterStatus", "保存中...", "pending");
  setBusy(button, true);
  try {
    const exporterName = value("#exporterName");
    const companyBranch = normalizeCmgBranch(value("#companyBranch"), exporterName);
    const localVersion = value("#localVersion") || `${exporterName}-internal-1.0.0`;
    const officialPackageId = value("#officialPackageId");
    const officialBaseline = value("#officialBaseline");
    const result = await post("/api/exporter/save", {
      id: value("#enterpriseVersionId") || makeEnterpriseVersionId(exporterName, officialPackageId || officialBaseline),
      name: exporterName,
      officialRepo: value("#officialRepo"),
      upstreamRemote: value("#upstreamRemote") || "upstream",
      officialBranch: value("#officialBranch") || "main",
      officialPackageId,
      officialBaseline,
      minorVersionNote: value("#minorVersionNote"),
      monitoringSystem: value("#monitoringSystem"),
      department: value("#department"),
      contactName: value("#contactName"),
      contactInfo: value("#contactInfo"),
      localBranch: companyBranch,
      companyBranch,
      localVersion,
      customDir: value("#customDir") || "custom",
      registryHookFile: value("#registryHookFile") || "company/ext/registry.go",
      registryHookSymbol: value("#registryHookSymbol") || "RegisterCompanyExt"
    });
    setInlineStatus("#saveExporterStatus", "已保存", "success");
    notify("企业版本已保存", `${result.name} 使用 ${result.upstreamRemote}/${result.officialBranch} -> ${result.companyBranch}`);
    await refresh();
    closeVersionModal();
  } catch (error) {
    setInlineStatus("#saveExporterStatus", `保存失败：${error.message}`, "error");
    notify("保存失败", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function saveCapabilityPackage() {
  const button = qs("#addCustomBtn");
  setInlineStatus("#capabilitySaveStatus", "保存中...", "pending");
  setBusy(button, true);
  try {
    const result = await post("/api/capability/save", {
      id: value("#customId"),
      name: value("#customName"),
      kind: value("#customType"),
      type: value("#customType"),
      extensionPoint: value("#customType"),
      packageVersion: value("#packageVersion"),
      owner: value("#packageOwner"),
      path: value("#customPath") || deriveCapabilityPath(),
      description: value("#customDescription"),
      editableCode: value("#editableCode")
    });
    setInlineStatus("#capabilitySaveStatus", "已保存", "success");
    lastSavedCapabilityId = result.id;
    setInlineStatus("#capabilityListStatus", `已保存：${result.name}`, "success");
    notify("能力包已保存", `${result.name} 已进入资产库，发布构建时可选择装配。`);
    await refresh();
    closeCapabilityModal();
    setView("custom");
    qs("#capabilityPackageList")?.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (error) {
    setInlineStatus("#capabilitySaveStatus", `保存失败：${error.message}`, "error");
    notify("能力包保存失败", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function createBuild() {
  const button = qs("#buildBtn2");
  setBusy(button, true);
  resetBuildConsole();
  showBuildOverlay(true);
  try {
    const selectedPackageIds = qsa("#buildPackageChecklist input[type='checkbox']:checked").map((item) => item.value);
    const selectedPackages = (dashboard?.capabilityPackages || []).filter((pkg) => selectedPackageIds.includes(pkg.id));
    const officialPkg = findPackageById(value("#buildOfficialPackageSelect"));
    const buildVersion = value("#buildVersion") || `${dashboard?.exporter?.localVersion || "internal"}+custom.${(dashboard?.exporter?.builds?.length || 0) + 1}`;

    appendBuildLog("info", "读取 .exporter.yaml 与企业版本元数据");
    setBuildProgress(8, "准备构建上下文");
    await delay(180);
    appendBuildLog("info", `官方基线：${officialPkg ? `${officialPkg.version} / ${labelPackageSource(officialPkg.source)}` : "未选择官方版本包，使用当前 exporter 基线"}`);
    setBuildProgress(18, "确认官方基线");
    await delay(180);
    appendBuildLog("info", `目标平台：${labelBuildTarget({ os: value("#buildTargetOs"), arch: value("#buildTargetArch"), arm: value("#buildTargetArm") })}`);
    appendBuildLog("info", `读取 custom/custom.yaml，选中能力包 ${selectedPackageIds.length} 个`);
    selectedPackages.forEach((pkg) => appendBuildLog("info", `能力包：${pkg.id} / ${pkg.kind || pkg.type} / ${pkg.version}`));
    setBuildProgress(34, "读取能力包清单");
    await delay(220);
    appendBuildLog("info", "生成 custom/all/all_gen.go");
    appendBuildLog("info", "生成 company/ext/capabilities_gen.go");
    setBuildProgress(52, "生成装配代码");
    await delay(220);
    appendBuildLog("info", "写入 custom/custom.lock.yaml");
    appendBuildLog("info", "写入 dist/build-info.json");
    setBuildProgress(68, "锁定构建输入");
    await delay(220);
    appendBuildLog("info", `执行 exporter-builder，目标版本：${buildVersion}`);
    setBuildProgress(78, "提交后端构建任务");

    const build = await post("/api/build", {
      officialPackageId: value("#buildOfficialPackageSelect"),
      selectedPackageIds,
      version: buildVersion,
      targetOs: value("#buildTargetOs"),
      targetArch: value("#buildTargetArch"),
      targetArm: value("#buildTargetArm"),
      operator: value("#buildOperator"),
      note: value("#buildNote"),
      patchNote: value("#buildPatchNote"),
      args: value("#buildArgs"),
      tags: value("#buildTags")
    });

    activeBuild = build;
    setBuildProgress(92, "刷新构建记录");
    appendBuildLog("success", `构建完成：${build.version}`);
    appendBuildLog("success", `产物：${build.artifact}`);
    if (build.verification?.ok) {
      appendBuildLog("success", `源码装配验证通过：${build.verification.mode || build.verification.command || "static-go-source-check"}`);
    } else if (build.verification) {
      appendBuildLog("error", `源码装配验证失败：${build.verification.message || "未知错误"}`);
    }
    appendBuildLog("info", `产物类型：${labelArtifactKind(build.artifactKind)}`);
    appendBuildLog("info", `下载包：${build.packageFileName || `${build.version}.tar.gz`}`);
    appendBuildLog("info", "可在构建发布记录中下载 Go 源码装配包、custom.yaml、lock、build-info 和装配代码");
    await refresh();
    closeBuildModal();
    setView("delivery");
    setBuildProgress(100, "构建完成");
    setBuildOverlayDone(true);
    notify("企业版构建完成", `${build.version} 已装配 ${build.customCount} 个能力包，可在构建记录中下载。`);
  } catch (error) {
    setBuildProgress(100, "构建失败");
    appendBuildLog("error", `构建失败：${error.message}`);
    setBuildOverlayDone(true);
    notify("构建失败", error.message);
  } finally {
    setBusy(button, false);
  }
}

async function uploadOfficialPackage() {
  const button = qs("#uploadOfficialBtn");
  const file = qs("#officialPackageFile").files?.[0];
  if (!file) {
    setInlineStatus("#officialUploadStatus", "请选择文件", "error");
    return;
  }
  setBusy(button, true);
  setInlineStatus("#officialUploadStatus", "上传中...", "pending");
  try {
    const pkg = await post("/api/catalog/upload", {
      catalogId: value("#uploadCatalogId"),
      version: value("#uploadOfficialVersion"),
      fileName: file.name,
      contentBase64: await readFileAsBase64(file),
      note: value("#officialUploadNote")
    });
    setInlineStatus("#officialUploadStatus", "已保存到目录", "success");
    notify("官方版本包已上传", `${pkg.exporterName} ${pkg.version} / ${pkg.fileName}`);
    qs("#officialPackageFile").value = "";
    await refresh();
  } catch (error) {
    setInlineStatus("#officialUploadStatus", `上传失败：${error.message}`, "error");
    notify("上传失败", error.message);
  } finally {
    setBusy(button, false);
  }
}

function renderOverview(summary, exporter) {
  const cards = [
    ["Exporter", exporter?.name || "未创建"],
    ["官方基线", exporter?.officialBaseline || "-"],
    ["企业分支", exporter ? (exporter.companyBranch || exporter.localBranch) : "-"],
    ["能力包", `${dashboard.capabilityPackages?.length || 0} 个`],
    ["已选装配", `${summary.customCount} 个`],
    ["构建记录", `${summary.buildCount} 条`]
  ];
  html("#overview", cards.map(([label, val]) => `
    <article class="metric-card"><span>${esc(label)}</span><strong>${esc(val)}</strong></article>
  `).join(""));
}

function renderExporter(exporter) {
  if (!exporter) {
    html("#currentExporter", `<div class="empty">暂无企业版本。请到“版本治理”新增企业版本，或从右侧官方版本目录点击“构建企业版”。</div>`);
    return;
  }
  const rows = [
    ["upstream", `${exporter.upstreamRemote || "upstream"}/${exporter.officialBranch}`],
    ["官方基线", exporter.officialBaseline],
    ["cmg branch", exporter.companyBranch || exporter.localBranch],
    ["企业版本", exporter.localVersion],
    [".exporter.yaml", exporter.exporterConfig?.path || ".exporter.yaml"],
    ["company/ext", exporter.companyExt?.path || "company/ext"],
    ["custom 清单", exporter.customManifest?.path || "custom/custom.yaml"]
  ];
  html("#currentExporter", renderKv(rows));
}

function renderVersionFlow(exporter) {
  if (!exporter) {
    html("#versionFlow", `<div class="empty">暂无版本治理链路。新增企业版本后会展示 upstream -> cmg branch -> custom 装配关系。</div>`);
    return;
  }
  html("#versionFlow", `
    <div class="flow-step"><span>${esc(exporter.upstreamRemote || "upstream")}/${esc(exporter.officialBranch)}</span><strong>${esc(exporter.officialBaseline)}</strong></div>
    <div class="flow-arrow">-></div>
    <div class="flow-step"><span>${esc(exporter.companyExt?.path || "company/ext")}</span><strong>${esc(exporter.companyBranch || exporter.localBranch)}</strong></div>
    <div class="flow-arrow">-></div>
    <div class="flow-step"><span>${esc(exporter.customManifest?.path || "custom/custom.yaml")}</span><strong>${esc(exporter.localVersion)}</strong></div>
  `);
}

function renderExporterVersions(exporters) {
  html("#exporterVersionList", exporters.length ? exporters.map((item) => {
    return `
      <div class="version-row ${dashboard?.exporter?.id === item.id ? "active" : ""}">
        <div>
          <strong>${esc(item.name)}</strong>
          <span>${esc(item.monitoringSystem || "未登记")} / ${esc(item.department || "未登记")} / ${esc(item.contactName || "未登记")}</span>
          <small>cmg branch：${esc(item.companyBranch || item.localBranch || "")}</small>
        </div>
        <div class="version-cell"><span>官方基线</span><strong>${esc(item.officialBaseline)}</strong></div>
        <div class="version-cell"><span>企业版本</span><strong>${esc(item.localVersion)}</strong>${renderVersionTags(item)}</div>
        <div class="row-actions">
          <button class="secondary" data-select-exporter="${esc(item.id)}">设为当前</button>
          <button class="secondary" data-goto="delivery">去构建</button>
          <button data-edit-exporter="${esc(item.id)}">编辑</button>
        </div>
      </div>
    `;
  }).join("") : `<div class="empty">还没有企业版本，点击“新增企业版本”开始维护。</div>`);
}

function renderCatalog(catalog) {
  html("#catalogList", catalog.length ? catalog.map((item) => `
    <div class="row catalog-row">
      <div>
        <strong>${esc(item.name)} <span class="muted">/ ${esc(item.category)}</span></strong>
        <span class="catalog-meta">${esc(formatDate(item.latestPublishedAt))} / ${esc(labelSummarySource(item.summarySource))} / 最新官方版本 ${esc(item.latestVersion || "-")}</span>
        <small>${esc(item.updateSummary)}</small>
        ${renderPackagePreview(item.packages || [], item)}
      </div>
      <span class="badge">${esc(item.latestVersion)}</span>
      <span class="badge status-${esc(item.syncStatus)}">${esc(labelSync(item.syncStatus))}</span>
      <button class="secondary" data-build-from-catalog data-catalog-id="${esc(item.id || item.name)}" data-package-id="${esc(preferredCatalogPackage(item.packages || [], "", item)?.id || "")}">构建企业版</button>
      <a class="link-button" href="${esc(item.releaseUrl || item.officialRepo)}" target="_blank" rel="noreferrer">Release</a>
    </div>
  `).join("") : `<div class="empty">暂无 exporter 目录数据。</div>`);
}

function renderPackagePreview(packages, catalogItem = {}) {
  if (!packages.length) return "";
  const versions = groupOfficialPackages(packages, catalogItem);
  return `
    <div class="package-list">
      ${versions.map((group) => `
        <div class="package-option">
          <span class="package-pill">${esc(group.version)} / ${esc(labelPackageSource(group.primary?.source))} / ${esc(labelAssetType(group.primary?.assetType))}${group.primary?.fileName ? ` / ${esc(group.primary.fileName)}` : ""}</span>
          <small>${esc(summarizePackagePlatforms(group.packages))}</small>
        </div>
      `).join("")}
    </div>
  `;
}

function renderCatalogUploadOptions(catalog) {
  html("#uploadCatalogId", catalog.map((item) => `
    <option value="${esc(item.id)}">${esc(item.name)} / ${esc(item.category)}</option>
  `).join(""));
}

function renderExtensionPoints(points) {
  html("#extensionPointList", points.map((point) => `
    <button class="extension-card ${selectedExtensionPoint?.id === point.id ? "active" : ""}" data-extension="${esc(point.id)}" type="button">
      <strong>${esc(point.name)}</strong>
      <span>${esc(point.description)}</span>
      <small>${esc(labelRisk(point.risk))}</small>
    </button>
  `).join(""));
  qsa("[data-extension]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedExtensionPoint = points.find((point) => point.id === button.dataset.extension);
      renderExtensionPoints(points);
      if (!qs("#capabilityModal")?.classList.contains("hidden")) {
        setValue("#customType", selectedExtensionPoint.id);
        applyExtensionTemplate(selectedExtensionPoint, true);
      }
    });
  });
}

function renderCapabilityPackages(packages) {
  html("#capabilityPackageList", packages.length ? packages.map((pkg) => `
    <div class="row capability-row ${lastSavedCapabilityId === pkg.id ? "just-saved" : ""}">
      <div>
        <strong>${esc(pkg.name)}</strong>
        <span>${esc(pkg.sourcePath)}</span>
        <small>packageId：${esc(pkg.id)} / version：${esc(pkg.version)} / owner：${esc(pkg.owner || "未登记")}</small>
        <small>${esc(pkg.description)}</small>
      </div>
      <span class="badge">${esc(labelType(pkg.kind || pkg.type))}</span>
      <span class="badge status-${esc(packageStatus(pkg) === "failed" ? "failed" : "active")}">${esc(labelValidation(packageStatus(pkg)))}</span>
      <button data-edit-package="${esc(pkg.id)}">编辑</button>
    </div>
  `).join("") : `<div class="empty">暂无能力包。点击“新增能力包”创建第一个可复用 custom 能力。</div>`);
}

function renderBuildWizard(data) {
  const exporter = data.exporter;
  if (!exporter) {
    html("#buildExporterSelect", `<option value="">暂无企业版本</option>`);
    html("#buildOfficialPackageSelect", `<option value="">请先新增企业版本</option>`);
    html("#buildPackageChecklist", `<div class="empty">暂无可构建的企业版本。请先到“版本治理”新增企业版本。</div>`);
    html("#buildAssemblyPreview", `<div class="empty">暂无装配预览。</div>`);
    return;
  }
  const currentExporterValue = value("#buildExporterSelect") || exporter.id;
  html("#buildExporterSelect", (data.exporters || []).map((item) => `
    <option value="${esc(item.id)}">${esc(item.name)} / ${esc(item.localVersion)}</option>
  `).join(""));
  setValue("#buildExporterSelect", currentExporterValue);

  const packages = getCatalogPackages(exporter.name);
  html("#buildOfficialPackageSelect", packages.length ? packages.map((pkg) => `
    <option value="${esc(pkg.id)}">${esc(labelOfficialPackageOption(pkg))}</option>
  `).join("") : `<option value="">暂无可选官方版本包</option>`);
  const currentOfficialPackage = normalizeOfficialPackageChoice(findCatalogByName(exporter.name), findPackageById(exporter.officialPackageId));
  setValue("#buildOfficialPackageSelect", currentOfficialPackage?.id || packages.find((pkg) => pkg.version === exporter.officialBaseline)?.id || packages[0]?.id || "");
  renderBuildTargetOptions();
  syncBuildTargetFromPackage({ preserveManual: true });
  if (!value("#buildVersion")) setValue("#buildVersion", `${exporter.localVersion}+custom.${(exporter.builds?.length || 0) + 1}`);

  const selectedIds = new Set((exporter.customItems || []).filter((item) => item.status === "enabled").map((item) => item.packageId || item.id));
  html("#buildPackageChecklist", (data.capabilityPackages || []).length ? data.capabilityPackages.map((pkg) => `
    <label class="package-check ${isCapabilityCompatibleWithExporter(pkg, exporter) ? "" : "disabled"}">
      <input type="checkbox" value="${esc(pkg.id)}" ${selectedIds.has(pkg.id) && isCapabilityCompatibleWithExporter(pkg, exporter) ? "checked" : ""} ${isCapabilityCompatibleWithExporter(pkg, exporter) ? "" : "disabled"}>
      <span>
        <strong>${esc(pkg.name)}</strong>
        <small>${esc(labelType(pkg.kind || pkg.type))} / ${esc(pkg.version)} / ${esc(pkg.sourcePath)}</small>
        ${isCapabilityCompatibleWithExporter(pkg, exporter) ? "" : `<small class="field-note">不兼容当前 ${esc(exporter.name)}，${esc(labelCapabilityCompatibility(pkg))}</small>`}
      </span>
    </label>
  `).join("") : `<div class="empty">暂无能力包，请先到“定制开发”新增。</div>`);

  renderBuildAssemblyPreview();
}

function renderBuildTargetOptions() {
  html("#buildTargetPreset", buildTargetPresets.map((preset) => `
    <option value="${esc(preset.id)}">${esc(preset.label)}</option>
  `).join(""));
  html("#buildTargetOs", [
    ["linux", "Linux"],
    ["windows", "Windows"],
    ["darwin", "macOS / Darwin"],
    ["freebsd", "FreeBSD"],
    ["openbsd", "OpenBSD"],
    ["netbsd", "NetBSD"],
    ["aix", "AIX"],
    ["solaris", "Solaris"]
  ].map(([id, label]) => `<option value="${id}">${label}</option>`).join(""));
  html("#buildTargetArch", [
    ["amd64", "amd64 / x86_64"],
    ["arm64", "arm64 / ARM 64"],
    ["arm", "arm / ARM 32"],
    ["386", "386 / x86"],
    ["s390x", "s390x"],
    ["riscv64", "riscv64"],
    ["ppc64le", "ppc64le"],
    ["ppc64", "ppc64"],
    ["mips64le", "mips64le"],
    ["mips64", "mips64"],
    ["mipsle", "mipsle"],
    ["mips", "mips"]
  ].map(([id, label]) => `<option value="${id}">${label}</option>`).join(""));
  html("#buildTargetArm", [
    ["", "自动"],
    ["7", "ARMv7"],
    ["6", "ARMv6"],
    ["5", "ARMv5"]
  ].map(([id, label]) => `<option value="${id}">${label}</option>`).join(""));
}

function syncBuildTargetFromPackage(options = {}) {
  const officialPkg = findPackageById(value("#buildOfficialPackageSelect"));
  const target = inferBuildTarget(officialPkg, dashboard?.exporter);
  if (!options.preserveManual || !value("#buildTargetOs")) setValue("#buildTargetOs", target.os);
  if (!options.preserveManual || !value("#buildTargetArch")) setValue("#buildTargetArch", target.arch);
  if (!options.preserveManual || !value("#buildTargetArm")) setValue("#buildTargetArm", target.arm || "");
  syncBuildTargetPresetFromFields();
  updateBuildTargetArmVisibility();
  updateBuildTargetHelp();
  updateBuildArgsFromTarget();
  renderBuildAssemblyPreview();
}

function applyBuildTargetPreset() {
  const preset = getBuildTargetPreset(value("#buildTargetPreset"));
  if (!preset || preset.id === "custom") {
    updateBuildTargetHelp();
    renderBuildAssemblyPreview();
    return;
  }
  setValue("#buildTargetOs", preset.os);
  setValue("#buildTargetArch", preset.arch);
  setValue("#buildTargetArm", preset.arm || "");
  updateBuildTargetArmVisibility();
  updateBuildTargetHelp();
  updateBuildArgsFromTarget();
  renderBuildAssemblyPreview();
}

function syncBuildTargetPresetFromFields() {
  const preset = findBuildTargetPreset({
    os: value("#buildTargetOs"),
    arch: value("#buildTargetArch"),
    arm: value("#buildTargetArm")
  });
  setValue("#buildTargetPreset", preset?.id || "custom");
}

function updateBuildTargetHelp() {
  const target = {
    os: value("#buildTargetOs"),
    arch: value("#buildTargetArch"),
    arm: value("#buildTargetArm")
  };
  const preset = getBuildTargetPreset(value("#buildTargetPreset")) || findBuildTargetPreset(target);
  const rawTarget = rawBuildTargetLabel(target);
  const commandEnv = buildTargetEnv(target);
  const outputName = target.os === "windows" ? "node_exporter.exe" : "node_exporter";
  html("#buildTargetHelp", `
    <strong>${esc(preset?.label || "自定义运行环境")}</strong>
    <span>${esc(preset?.note || "请确认目标系统和芯片架构与实际运行机器一致。")}</span>
    <small>构建目标：${esc(rawTarget || "-")}；环境变量：${esc(commandEnv || "-")}；产物示例：${esc(outputName)}</small>
  `);
}

function updateBuildArgsFromTarget() {
  const env = buildTargetEnv({
    os: value("#buildTargetOs"),
    arch: value("#buildTargetArch"),
    arm: value("#buildTargetArm")
  });
  if (env) setValue("#buildArgs", env);
}

function updateBuildTargetArmVisibility() {
  const isArm = value("#buildTargetArch") === "arm";
  const label = qs("#buildTargetArmLabel");
  if (label) label.classList.toggle("hidden", !isArm);
  if (!isArm) setValue("#buildTargetArm", "");
}

function inferBuildTarget(pkg, exporter = {}) {
  const inferred = inferPackageTarget(pkg);
  if (inferred.os && inferred.arch) return inferred;
  const exporterName = String(exporter?.name || exporter?.id || "").toLowerCase();
  if (exporterName.includes("windows_exporter")) return { os: "windows", arch: "amd64", arm: "" };
  return { os: "linux", arch: "amd64", arm: "" };
}

function inferPackageTarget(pkg = {}) {
  const fileName = String(pkg.fileName || "").toLowerCase();
  const rawOs = String(pkg.os || "").toLowerCase();
  const rawArch = String(pkg.arch || "").toLowerCase();
  const os = ["linux", "windows", "darwin", "freebsd", "openbsd", "netbsd", "aix", "solaris"].includes(rawOs)
    ? rawOs
    : fileName.includes("windows") || fileName.endsWith(".exe") || fileName.endsWith(".msi") ? "windows"
      : fileName.includes("linux") ? "linux"
        : fileName.includes("darwin") || fileName.includes("macos") ? "darwin"
          : fileName.includes("freebsd") ? "freebsd"
            : fileName.includes("openbsd") ? "openbsd"
              : fileName.includes("netbsd") ? "netbsd"
                : fileName.includes("aix") ? "aix"
                  : fileName.includes("solaris") ? "solaris"
                    : "";
  const archSource = rawArch && rawArch !== "unknown" && rawArch !== "source" ? rawArch : fileName;
  const arm = /armv([567])/.exec(archSource)?.[1] || "";
  const arch = archSource.includes("arm64") || archSource.includes("aarch64") ? "arm64"
    : archSource.includes("amd64") || archSource.includes("x86_64") ? "amd64"
      : archSource.includes("386") || archSource.includes("i386") ? "386"
        : archSource.includes("s390x") ? "s390x"
          : archSource.includes("riscv64") ? "riscv64"
            : archSource.includes("ppc64le") ? "ppc64le"
              : archSource.includes("ppc64") ? "ppc64"
                : archSource.includes("mips64le") ? "mips64le"
                  : archSource.includes("mips64") ? "mips64"
                    : archSource.includes("mipsle") ? "mipsle"
                      : archSource.includes("mips") ? "mips"
                        : arm ? "arm" : "";
  return { os, arch, arm };
}

function renderBuildAssemblyPreview() {
  if (!dashboard) return;
  const exporter = dashboard.exporter;
  if (!exporter) {
    html("#buildAssemblyPreview", `<div class="empty">暂无装配预览。</div>`);
    return;
  }
  const selectedPackageIds = qsa("#buildPackageChecklist input[type='checkbox']:checked").map((item) => item.value);
  const selectedPackages = (dashboard.capabilityPackages || []).filter((pkg) => selectedPackageIds.includes(pkg.id));
  const officialPkg = findPackageById(value("#buildOfficialPackageSelect"));
  const rows = [
    ["企业版本", `${exporter.name} / ${value("#buildVersion") || "自动生成"}`],
    ["官方基线包", officialPkg ? `${officialPkg.version} / ${labelPackageSource(officialPkg.source)}` : exporter.officialBaseline],
    ["运行环境", getBuildTargetPreset(value("#buildTargetPreset"))?.label || "其他系统或架构"],
    ["目标平台", labelBuildTarget({ os: value("#buildTargetOs"), arch: value("#buildTargetArch"), arm: value("#buildTargetArm") })],
    ["构建环境变量", buildTargetEnv({ os: value("#buildTargetOs"), arch: value("#buildTargetArch"), arm: value("#buildTargetArm") })],
    ["稳定扩展接口", exporter.companyExt?.path || "company/ext"],
    ["装配清单", "custom/custom.yaml"],
    ["锁定文件", "custom/custom.lock.yaml"],
    ["装配入口", "custom/all/all_gen.go"],
    ["注册表", "company/ext/capabilities_gen.go"],
    ["构建信息", "dist/build-info.json"],
    ["能力包", selectedPackages.map((pkg) => pkg.name).join("、") || "未选择"]
  ];
  html("#buildAssemblyPreview", `
    <div class="kv">${renderKv(rows)}</div>
    <pre>${esc(renderCustomYamlPreview(exporter, selectedPackages))}</pre>
  `);
}

function renderBuilds(exporters) {
  const allBuilds = collectBuildRecords(exporters);
  if (!Array.isArray(exporters) || !exporters.length) {
    html("#buildList", `<div class="empty">暂无构建记录。企业版本创建后可在这里构建并下载内部版本。</div>`);
    return;
  }
  const builds = allBuilds.filter((build) => buildMatchesSearch(build));
  if (!allBuilds.length) {
    html("#buildList", `<div class="empty">暂无构建记录。完成一次装配构建后可在这里下载产物。</div>`);
    return;
  }
  html("#buildList", builds.length ? builds.map((build) => `
    <div class="row build-row" data-build-row="${esc(build.id)}">
      <div>
        <strong>${esc(build.version)}</strong>
        <span>${esc(build.artifact)}</span>
        <div class="build-tags">${renderBuildTags(build)}</div>
        <small>所属版本：${esc(build.exporterName || build.exporterId || "-")} / ${esc(build.enterpriseVersionId || "-")} / 企业版本 ${esc(build.enterpriseLocalVersion || "-")}</small>
        <small>官方基线：${esc(build.baseline || "")} / ${esc(labelPackageSource(build.officialPackageSource))}${build.officialPackageFileName ? ` / ${esc(build.officialPackageFileName)}` : ""}</small>
        <small>company/ext：${esc(build.companyExtPath || "")} / custom：${esc((build.customItemNames || []).join("、") || `${build.customCount || 0} 个`)}</small>
        <small>构建参数：${esc(build.manualConfig?.args || "-")} / 操作人：${esc(build.manualConfig?.operator || "-")}</small>
        ${build.assemblyValidation ? `<small>装配验证：${build.assemblyValidation.ok ? "通过" : "失败"} / ${esc(build.assemblyValidation.packageCount || 0)} 个能力包 / 覆盖 ${esc(countCoveredKinds(build.assemblyValidation.kindCoverage))} 类</small>` : ""}
        ${build.verification ? `<small>源码验证：${build.verification.ok ? "通过" : "失败"} / ${esc(build.verification.mode || build.verification.command || "static-go-source-check")} / ${esc(build.verification.message || "")}</small>` : ""}
        ${build.runtimeVerification ? `<small>运行指标验证：${build.runtimeVerification.ok ? "通过" : "失败"} / windows 指标 ${esc(build.runtimeVerification.windowsMetricCount || 0)} 个 / ${esc(build.runtimeVerification.endpoint || build.runtimeVerification.message || "")}</small>` : ""}
        ${build.packageFileName ? `<small>产物类型：${esc(labelArtifactKind(build.artifactKind))} / 目标平台：${esc(labelBuildTarget(build.target || build.compiledBinary?.target))} / 下载包：${esc(build.packageFileName)}</small>` : ""}
        ${build.compiledBinary?.ok ? `<small>二进制：${esc(build.compiledBinary.fileName || build.runtimeEntrypoint || "")}</small>` : ""}
        ${build.compiledBinary && !build.compiledBinary.ok ? `<small class="conflict-text">二进制失败：${esc(build.compiledBinary.message || build.compiledBinary.reason || "官方源码编译失败")}</small>` : ""}
        ${build.compiledBinary?.fallbackBlockedReason ? `<small class="conflict-text">${esc(build.compiledBinary.fallbackBlockedReason)}</small>` : ""}
        ${build.compiledBinary?.stderr ? `<small class="conflict-text">${esc(shortError(build.compiledBinary.stderr))}</small>` : ""}
        <div class="build-tag-editor">
          <input data-build-tags-input="${esc(build.id)}" value="${esc((build.tags || []).join("，"))}" placeholder="标签：认证，回归，Windows">
          <button class="secondary mini" data-save-build-tags data-build-id="${esc(build.id)}">保存标签</button>
        </div>
        <div class="download-list">
          <button class="primary-download mini" data-download-build data-build-id="${esc(build.id)}" data-file="package">下载企业包</button>
          ${build.compiledBinary?.ok ? `<button class="primary-download mini" data-download-build data-build-id="${esc(build.id)}" data-file="binary">下载二进制</button>` : ""}
          ${["artifact", "exporter", "custom", "lock", "build-info", "assembly-validation", "assembly", "registry", "log"].map((file) => `
            <button class="secondary mini" data-preview-build data-build-id="${esc(build.id)}" data-file="${esc(file)}">${esc(labelPreview(file))}</button>
          `).join("")}
          <button class="danger mini" data-delete-build data-build-id="${esc(build.id)}">删除</button>
        </div>
      </div>
      <span class="badge status-${esc(build.status === "failed" ? "failed" : "success")}">${esc(labelBuild(build.status))}</span>
    </div>
  `).join("") : `<div class="empty">没有匹配的构建记录。可以换个版本号、标签或能力包关键词搜索。</div>`);
}

function collectBuildRecords(exporters) {
  return (exporters || [])
    .flatMap((exporter) => (exporter.builds || []).map((build) => ({
      ...build,
      exporterId: exporter.id,
      exporterName: exporter.name,
      enterpriseVersionId: exporter.id,
      enterpriseLocalVersion: exporter.localVersion
    })))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function buildMatchesSearch(build) {
  const query = String(buildSearchQuery || "").trim();
  if (!query) return true;
  return buildSearchText(build).includes(query);
}

function buildSearchText(build) {
  return [
    build.version,
    build.status,
    labelBuild(build.status),
    build.baseline,
    build.artifact,
    build.exporterId,
    build.exporterName,
    build.enterpriseVersionId,
    build.enterpriseLocalVersion,
    build.companyBranch,
    build.manualConfig?.operator,
    build.manualConfig?.note,
    build.manualConfig?.args,
    ...(build.customItemNames || []),
    ...(build.tags || [])
  ].join(" ").toLowerCase();
}

function renderBuildTags(build) {
  const tags = build.tags?.length ? build.tags : [labelBuild(build.status), build.baseline, ...(build.customItemNames || [])].filter(Boolean).slice(0, 4);
  return tags.map((tag) => `<span class="version-tag tag-note">${esc(tag)}</span>`).join("");
}

function renderActivity(activity) {
  html("#activityLog", activity.length ? activity.map((item) => `
    <div class="log-item"><strong>${esc(item.title)}</strong><span>${esc(item.detail)}</span></div>
  `).join("") : `<div class="empty">暂无操作记录。</div>`);
}

function openVersionModal(exporterId, options = {}) {
  const exporter = exporterId
    ? (dashboard.exporters || []).find((item) => item.id === exporterId)
    : createExporterDraft(options);
  if (!exporter) return;
  qs("#versionModalTitle").textContent = exporterId ? "编辑企业版本" : "新增企业版本";
  fillForms(exporter);
  setInlineStatus("#saveExporterStatus", "", "");
  setInlineStatus("#officialUploadStatus", "", "");
  if (qs("#officialPackageFile")) qs("#officialPackageFile").value = "";
  showModal("#versionModal", true);
}

function closeVersionModal() {
  showModal("#versionModal", false);
}

function openCapabilityModal(packageId) {
  editingCapabilityId = packageId || null;
  const pkg = packageId
    ? (dashboard.capabilityPackages || []).find((item) => item.id === packageId)
    : createCapabilityDraft();
  if (!pkg) return;
  selectedExtensionPoint = getExtensionPoint(pkg.type || "metric");
  qs("#capabilityModalTitle").textContent = packageId ? "编辑能力包" : "新增能力包";
  renderExtensionTypeOptions();
  setValue("#customId", pkg.id || "");
  setValue("#customName", pkg.name || "");
  setValue("#customType", selectedExtensionPoint.id);
  setValue("#packageVersion", pkg.version || "1.0.0");
  setValue("#packageOwner", pkg.owner || "平台团队");
  setValue("#customPath", pkg.sourcePath || pkg.path || "");
  setValue("#customDescription", pkg.description || "");
  setValue("#editableCode", pkg.editableCode || selectedExtensionPoint.template || "");
  setInlineStatus("#capabilitySaveStatus", "", "");
  applyExtensionTemplate(selectedExtensionPoint, false);
  updateCapabilityPreview();
  showModal("#capabilityModal", true);
}

function closeCapabilityModal() {
  showModal("#capabilityModal", false);
  editingCapabilityId = null;
}

function createExporterDraft(options = {}) {
  const activeName = dashboard?.exporter?.name || dashboard?.exporter?.id || "";
  const catalog = options.catalogId
    ? (dashboard?.exporterCatalog || []).find((item) => item.id === options.catalogId || item.name === options.catalogId)
    : findCatalogByName(activeName) || (dashboard?.exporterCatalog || [])[0] || null;
  const name = catalog?.name || activeName || "snmp_exporter";
  const packages = catalog?.packages || [];
  const requestedPackage = options.packageId
    ? findPackageById(options.packageId)
    : packages.find((item) => item.id === dashboard?.exporter?.officialPackageId || item.version === dashboard?.exporter?.officialBaseline);
  const pkg = normalizeOfficialPackageChoice(catalog, requestedPackage) || preferredCatalogPackage(packages, "", catalog) || null;
  const baseline = pkg?.version || (dashboard?.exporter?.name === name ? dashboard?.exporter?.officialBaseline : catalog?.latestVersion) || "v0.30.0";
  return {
    id: makeEnterpriseVersionId(name, pkg?.version || pkg?.id || baseline),
    name,
    officialRepo: catalog?.officialRepo || "https://github.com/prometheus/snmp_exporter",
    upstreamRemote: "upstream",
    officialBranch: catalog?.officialBranch || "main",
    officialBaseline: baseline,
    minorVersionNote: packageNote(pkg),
    monitoringSystem: "统一监控平台",
    department: "网络运维部",
    contactName: "张工",
    contactInfo: "ops@example.com",
    companyBranch: `cmg/${name}`,
    localBranch: `cmg/${name}`,
    localVersion: `${name}-internal-1.0.0`,
    customDir: "custom",
    collectorRegistryHook: { file: "company/ext/registry.go", symbol: "RegisterCompanyExt" },
    officialPackageId: pkg?.id || ""
  };
}

function createCapabilityDraft() {
  const point = selectedExtensionPoint || dashboard.extensionPoints?.[0] || { id: "metric", template: "" };
  return {
    id: point.id === "scraper" ? "pkg-http-health" : "pkg-custom-metric",
    name: point.id === "scraper" ? "HTTP 健康探测指标" : "自定义指标能力",
    type: point.id,
    version: "1.0.0",
    owner: "平台团队",
    sourcePath: `custom/capabilities/${point.id === "scraper" ? "pkg-http-health" : "pkg-custom-metric"}/${point.defaultFile || "package.go"}`,
    description: point.id === "scraper" ? "访问内部 HTTP 服务并转换为 exporter 指标。" : "通过固定扩展点扩展 exporter 指标。",
    editableCode: point.template || ""
  };
}

function deriveCapabilityPath() {
  const point = selectedExtensionPoint || getExtensionPoint(value("#customType")) || { defaultFile: "capability.go" };
  const id = value("#customId") || "pkg-custom";
  return `custom/capabilities/${id}/${point.defaultFile || "capability.go"}`;
}

async function selectExporterVersion(id, options = {}) {
  if (!id) return;
  const result = await post("/api/exporter/select", { id });
  if (!options.silent) notify("当前企业版本已切换", `${result.name} / ${result.localVersion}`);
  await refresh();
}

function fillForms(exporter) {
  renderExporterNameOptions(exporter);
  setValue("#enterpriseVersionId", exporter.id || "");
  setValue("#exporterName", exporter.name);
  setValue("#officialRepo", exporter.officialRepo);
  setValue("#upstreamRemote", exporter.upstreamRemote || "upstream");
  setValue("#officialBranch", exporter.officialBranch || "main");
  setValue("#officialBaseline", exporter.officialBaseline);
  renderOfficialPackageOptions(exporter);
  setValue("#minorVersionNote", exporter.minorVersionNote || packageNote(findPackageById(exporter.officialPackageId)));
  setValue("#monitoringSystem", exporter.monitoringSystem || "");
  setValue("#department", exporter.department || "");
  setValue("#contactName", exporter.contactName || "");
  setValue("#contactInfo", exporter.contactInfo || "");
  setValue("#companyBranch", normalizeCmgBranch(exporter.companyBranch || exporter.localBranch, exporter.name));
  setValue("#localVersion", exporter.localVersion || `${exporter.name}-internal-1.0.0`);
  setValue("#customDir", exporter.customDir || "custom");
  setValue("#registryHookFile", exporter.collectorRegistryHook?.file || "company/ext/registry.go");
  setValue("#registryHookSymbol", exporter.collectorRegistryHook?.symbol || "RegisterCompanyExt");
  updateVersionDefaultsNote();
}

function renderExporterNameOptions(exporter = {}) {
  const catalog = dashboard?.exporterCatalog || [];
  const current = exporter.name || exporter.id || "";
  const hasCurrent = catalog.some((item) => item.name === current || item.id === current);
  const options = (hasCurrent ? catalog : [{ id: current, name: current, officialRepo: exporter.officialRepo }, ...catalog])
    .filter((item) => item.id || item.name)
    .map((item) => `<option value="${esc(item.name || item.id)}">${esc(item.name || item.id)}</option>`)
    .join("");
  html("#exporterName", options);
}

function updateVersionDefaultsNote() {
  const name = value("#exporterName") || "exporter";
  const note = qs("#versionDefaultsNote");
  if (!note) return;
  note.textContent = `转换规则：Exporter 选择 ${name} 且企业信息不填写时，系统默认生成 cmg/${name} 分支和 ${name}-internal-1.0.0 企业版本；custom/custom.yaml、company/ext hook 和构建锁定文件均由系统生成。`;
}

function normalizeCmgBranch(branch, exporterName) {
  const name = exporterName || "exporter";
  const current = String(branch || "").trim();
  if (!current) return `cmg/${name}`;
  if (current.startsWith("company/")) return `cmg/${current.slice("company/".length)}`;
  return current;
}

function renderOfficialPackageOptions(exporter) {
  const packages = getCatalogPackages(exporter.name);
  html("#officialPackageId", packages.length ? packages.map((pkg) => `
    <option value="${esc(pkg.id)}">${esc(labelOfficialPackageOption(pkg))}</option>
  `).join("") : `<option value="">目录暂无可选版本包</option>`);
  const current = normalizeOfficialPackageChoice(findCatalogByName(exporter.name), findPackageById(exporter.officialPackageId));
  const preferred = current?.id || packages.find((pkg) => pkg.version === exporter.officialBaseline)?.id || packages[0]?.id || "";
  setValue("#officialPackageId", preferred);
  const pkg = findPackageById(preferred);
  if (pkg) {
    setValue("#officialBaseline", pkg.version);
    if (!value("#minorVersionNote")) setValue("#minorVersionNote", exporter.minorVersionNote || packageNote(pkg));
  }
}

function renderVersionTags(item) {
  const tags = [
    `<span class="version-tag tag-minor">小版本 ${esc(item.minorVersion || item.officialBaseline || "未选择")}</span>`,
    item.officialPackageSource ? `<span class="version-tag ${item.officialPackageSource === "manual-upload" ? "tag-manual" : "tag-release"}">${esc(labelPackageSource(item.officialPackageSource))}</span>` : "",
    item.minorVersionNote ? `<span class="version-tag tag-note">${esc(item.minorVersionNote)}</span>` : ""
  ].filter(Boolean);
  return `<div class="version-tags">${tags.join("")}</div>`;
}

function packageNote(pkg) {
  if (!pkg) return "";
  return pkg.note || pkg.updateSummary || "";
}

function makeEnterpriseVersionId(name, seed) {
  return `${name || "exporter"}-${sanitizeForId(seed || "baseline")}`;
}

function sanitizeForId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^github-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "baseline";
}

function renderExtensionTypeOptions() {
  html("#customType", (dashboard.extensionPoints || []).map((point) => `
    <option value="${esc(point.id)}">${esc(point.name)}</option>
  `).join(""));
}

function applyExtensionTemplate(point, force) {
  if (!point) return;
  if (qs("#selectedExtensionTitle")) qs("#selectedExtensionTitle").textContent = point.name;
  if (qs("#selectedExtensionDesc")) qs("#selectedExtensionDesc").textContent = point.description;
  if (force || !value("#customPath")) {
    const packageId = value("#customId") || "pkg-custom";
    setValue("#customPath", `custom/capabilities/${packageId}/${point.defaultFile || "package.go"}`);
  }
  if (force || !value("#editableCode")) {
    setValue("#editableCode", point.template || "");
  }
  renderExtensionCodeExample(point);
  updateCodeFrameMeta(point);
  updateCapabilityPreview();
}

function updateCapabilityPreview() {
  const point = selectedExtensionPoint || getExtensionPoint(value("#customType"));
  if (!point || !qs("#validationBadge")) return;
  const validation = validateEditableCode(point, value("#editableCode"));
  qs("#validationBadge").textContent = labelValidation(validation.status);
  qs("#validationBadge").className = `badge status-${validation.status === "passed" ? "success" : validation.status === "failed" ? "failed" : "pending"}`;
  const entry = `${point.entryPrefix}_${toPascal(value("#customId"))}`;
  const rows = [
    ["扩展点", point.name],
    ["能力源码", value("#customPath")],
    ["装配方式", "发布运行时写入 custom/custom.yaml"],
    ["稳定接口", "company/ext"],
    ["入口函数", entry],
    ["校验", validation.errors.length ? validation.errors.join("；") : "通过"]
  ];
  html("#customImpact", renderKv(rows));
  text("#generatedCodePreview", renderGeneratedPreview(point, entry));
  updateCodeFrameMeta(point);
}

function renderExtensionCodeExample(point) {
  if (!point || !qs("#extensionCodeExample")) return;
  text("#extensionCodeExample", capabilityCodeExamples[point.id] || point.template || "");
  if (qs("#codeExampleTitle")) qs("#codeExampleTitle").textContent = `${point.name} 样例`;
}

function updateCodeFrameMeta(point) {
  if (qs("#editableCodeFile")) qs("#editableCodeFile").textContent = value("#customPath") || point?.defaultFile || "capability.go";
}

function renderGeneratedPreview(point, entry) {
  return `package custom

// Code generated by exporter-builder.
// Extension point: ${point.name}
// Registry hook: RegisterCompanyExt

func ${entry}() {
    // editable area starts
${value("#editableCode").split("\n").map((line) => `    ${line}`).join("\n")}
    // editable area ends
}`;
}

function renderCustomYamlPreview(exporter, packages) {
  const lines = [
    "schemaVersion: v1",
    "kind: custom-package-selection",
    `exporter: ${exporter.name}`,
    `officialBaseline: ${exporter.officialBaseline}`,
    `companyExt: ${exporter.companyExt?.path || "company/ext"}`,
    "packages:"
  ];
  if (!packages.length) {
    lines.push("  []");
    return lines.join("\n");
  }
  packages.forEach((pkg) => {
    lines.push(`  - packageId: ${pkg.id}`);
    lines.push(`    kind: ${pkg.kind || pkg.type}`);
    lines.push(`    version: ${pkg.version}`);
    lines.push(`    sourcePath: ${pkg.sourcePath}`);
    lines.push(`    import_path: ${pkg.import_path || ""}`);
    lines.push(`    entry: ${pkg.entry || "-"}`);
  });
  return lines.join("\n");
}

function validateEditableCode(point, code) {
  const errors = [];
  if (!code.trim()) errors.push("可编辑代码不能为空");
  if (!/return\s+/.test(code)) errors.push("需要包含 return");
  if (point.id === "metric" && !/Metric\s*\{/.test(code)) errors.push("Metric 扩展建议返回 Metric 结构");
  if (point.id === "scraper" && !/(endpoint|url|http)/i.test(code)) errors.push("Scraper 需要声明 endpoint/url/http 请求目标");
  if (point.id === "scraper" && !/Metric\s*\{/.test(code)) errors.push("Scraper 需要将服务响应转换为 Metric");
  if (point.id === "transform" && !/metrics/.test(code)) errors.push("Transform 需要处理 metrics 入参");
  return { status: errors.length ? "failed" : "passed", errors };
}

function getExtensionPoint(id) {
  return (dashboard?.extensionPoints || []).find((point) => point.id === id) || dashboard?.extensionPoints?.[0] || null;
}

function getCatalogPackages(exporterName) {
  const catalog = (dashboard?.exporterCatalog || []).find((item) => item.id === exporterName || item.name === exporterName);
  return getSelectableOfficialPackages(catalog?.packages || [], catalog);
}

function findPackageById(id) {
  if (!id) return null;
  for (const item of dashboard?.exporterCatalog || []) {
    const found = (item.packages || []).find((pkg) => pkg.id === id || pkg.version === id);
    if (found) return found;
  }
  return null;
}

function findCatalogByName(name) {
  return (dashboard?.exporterCatalog || []).find((item) => item.id === name || item.name === name);
}

function getSelectableOfficialPackages(packages, catalog = null) {
  return groupOfficialPackages(packages, catalog)
    .map((group) => group.primary)
    .filter(Boolean);
}

function groupOfficialPackages(packages, catalog = null) {
  const groups = new Map();
  for (const pkg of packages || []) {
    const version = pkg.version || "unknown";
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version).push(pkg);
  }
  return Array.from(groups.entries()).map(([version, items]) => ({
    version,
    packages: items,
    primary: preferredCatalogPackage(items, "", catalog)
  }));
}

function preferredCatalogPackage(packages, version = "", catalog = null) {
  const candidates = (packages || [])
    .filter((pkg) => !version || pkg.version === version)
    .filter((pkg) => pkg && pkg.id && pkg.assetType !== "metadata");
  if (!candidates.length) return null;
  return candidates.slice().sort((left, right) => officialPackageScore(left, catalog) - officialPackageScore(right, catalog))[0];
}

function normalizeOfficialPackageChoice(catalog, pkg) {
  if (!pkg) return null;
  if (["manual-upload", "source-archive"].includes(pkg.source) || pkg.assetType === "source-archive") return pkg;
  return preferredCatalogPackage(catalog?.packages || [], pkg.version, catalog) || pkg;
}

function officialPackageScore(pkg, catalog = null) {
  const exporterName = String(catalog?.name || catalog?.id || pkg.exporterName || pkg.exporterId || "").toLowerCase();
  if (exporterName === "windows_exporter") {
    if (pkg.source === "manual-upload") return 0;
    if (pkg.assetType === "binary" && pkg.os === "windows" && pkg.arch === "amd64" && /\.exe$/i.test(pkg.fileName || "")) return 1;
    if (pkg.assetType === "binary" && pkg.os === "windows" && /\.exe$/i.test(pkg.fileName || "")) return 2;
    if (pkg.assetType === "binary" && pkg.os === "windows") return 3;
    if (pkg.assetType === "source-archive") return 6;
    return 9;
  }
  if (pkg.source === "manual-upload") return 0;
  if (pkg.assetType === "source-archive") return 1;
  if (pkg.availableForBuild && pkg.assetType !== "metadata") return 5;
  return 9;
}

function summarizePackagePlatforms(packages) {
  const assets = (packages || []).filter((pkg) => pkg.assetType !== "source-archive" && pkg.assetType !== "metadata");
  if (!assets.length) return "官方源码基线；构建时选择目标系统和芯片架构。";
  const systems = Array.from(new Set(assets.map((pkg) => pkg.os).filter((item) => item && item !== "unknown" && item !== "source")));
  const archs = Array.from(new Set(assets.map((pkg) => pkg.arch).filter((item) => item && item !== "unknown" && item !== "source")));
  const systemText = systems.length ? systems.slice(0, 4).join("、") : "多平台";
  const archText = archs.length ? archs.slice(0, 5).join("、") : "多架构";
  return `平台资产已收起：${systemText}${systems.length > 4 ? "等" : ""}；架构：${archText}${archs.length > 5 ? "等" : ""}。`;
}

function labelOfficialPackageOption(pkg) {
  if (!pkg) return "-";
  const kind = pkg.source === "manual-upload" ? "手动上传固定包" : pkg.assetType === "source-archive" ? "源码基线包" : labelAssetType(pkg.assetType);
  return `${pkg.version} / ${kind}${pkg.fileName ? ` / ${pkg.fileName}` : ""}`;
}

function isCapabilityCompatibleWithExporter(pkg, exporter = {}) {
  const exporters = Array.isArray(pkg?.compatible?.exporters) && pkg.compatible.exporters.length
    ? pkg.compatible.exporters
    : ["*"];
  if (exporters.includes("*")) return true;
  const candidates = [
    exporter.id,
    exporter.name,
    String(exporter.id || "").replace(/-v\d.*$/i, ""),
    String(exporter.name || "").replace(/-v\d.*$/i, "")
  ].filter(Boolean);
  return exporters.some((item) => candidates.includes(item));
}

function labelCapabilityCompatibility(pkg) {
  const exporters = Array.isArray(pkg?.compatible?.exporters) && pkg.compatible.exporters.length
    ? pkg.compatible.exporters
    : ["*"];
  return exporters.includes("*") ? "可用于全部 exporter" : `仅兼容 ${exporters.join("、")}`;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").split(",").pop() || "");
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

function resetBuildConsole() {
  activeBuild = null;
  text("#buildOverlaySummary", "准备执行 exporter-builder");
  text("#buildLogOutput", "");
  setBuildProgress(0, "等待开始");
  setBuildOverlayDone(false);
}

function showBuildOverlay(show) {
  const overlay = qs("#buildOverlay");
  if (!overlay) return;
  overlay.classList.toggle("hidden", !show);
  overlay.setAttribute("aria-hidden", show ? "false" : "true");
}

function setBuildOverlayDone(done) {
  const closeButton = qs("#closeBuildOverlayBtn");
  if (closeButton) closeButton.disabled = !done;
}

function setBuildProgress(percent, summary) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  const fill = qs("#buildProgressFill");
  if (fill) fill.style.width = `${safePercent}%`;
  text("#buildProgressText", `${safePercent}%`);
  if (summary) text("#buildOverlaySummary", summary);
}

function appendBuildLog(level, message) {
  const target = qs("#buildLogOutput");
  if (!target) return;
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const prefix = { info: "INFO", success: "OK", error: "ERROR" }[level] || "INFO";
  target.textContent += `[${time}] [${prefix}] ${message}\n`;
  target.scrollTop = target.scrollHeight;
}

async function openBuildPreview(buildId, file) {
  text("#buildPreviewTitle", labelPreview(file));
  text("#buildPreviewMeta", `构建 ${buildId} / ${labelDownload(file)}`);
  text("#buildPreviewContent", "加载中...");
  showModal("#buildPreviewDrawer", true);
  try {
    const res = await fetch(`/api/build/download?buildId=${encodeURIComponent(buildId)}&file=${encodeURIComponent(file)}`);
    const content = await res.text();
    if (!res.ok) throw new Error(content || `HTTP ${res.status}`);
    text("#buildPreviewContent", content);
  } catch (error) {
    text("#buildPreviewContent", `加载失败：${error.message}`);
  }
}

function closeBuildPreview() {
  showModal("#buildPreviewDrawer", false);
}

async function deleteBuildRecord(buildId) {
  if (!buildId) return;
  if (!window.confirm("确认删除这条构建记录和本地构建产物吗？")) return;
  try {
    await post("/api/build/delete", { id: buildId });
    notify("构建记录已删除", "记录和本地构建产物已清理。");
    await refresh();
  } catch (error) {
    notify("删除构建记录失败", error.message);
  }
}

async function saveBuildTags(buildId) {
  if (!buildId) return;
  const input = qs(`[data-build-tags-input="${buildId}"]`);
  try {
    const build = await post("/api/build/tags", {
      buildId,
      tags: input ? input.value : ""
    });
    notify("构建标签已保存", `${build.version}：${(build.tags || []).join("、") || "无标签"}`);
    await refresh();
  } catch (error) {
    notify("保存构建标签失败", error.message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setView(view) {
  qsa(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  qsa(".view").forEach((panel) => panel.classList.toggle("active", panel.dataset.viewPanel === view));
  const [title, subtitle] = viewMeta[view] || viewMeta.dashboard;
  text("#viewTitle", title);
  text("#viewSubtitle", subtitle);
}

async function get(url) {
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok || payload.error) throw new Error(payload.error || `HTTP ${res.status}`);
  return payload;
}

function notify(title, detail) {
  const log = qs("#activityLog");
  if (!log) return;
  const item = document.createElement("div");
  item.className = "log-item";
  item.innerHTML = `<strong>${esc(title)}</strong><span>${esc(detail)}</span>`;
  log.prepend(item);
}

function html(selector, markup) {
  const el = qs(selector);
  if (el) el.innerHTML = markup;
}

function text(selector, value) {
  const el = qs(selector);
  if (el) el.textContent = value ?? "";
}

function value(selector) {
  const el = qs(selector);
  return el && "value" in el ? String(el.value || "").trim() : "";
}

function setValue(selector, val) {
  const el = qs(selector);
  if (el && "value" in el) el.value = val ?? "";
}

function setBusy(button, busy) {
  if (button) button.disabled = busy;
}

function setInlineStatus(selector, message, status = "") {
  const el = qs(selector);
  if (!el) return;
  el.textContent = message || "";
  el.className = `inline-status ${status}`.trim();
}

function showModal(selector, show) {
  const el = qs(selector);
  if (!el) return;
  el.classList.toggle("hidden", !show);
  el.setAttribute("aria-hidden", show ? "false" : "true");
}

function renderKv(rows) {
  return rows.map(([key, val]) => `
    <div class="kv-row"><div class="kv-key">${esc(key)}</div><div>${esc(val)}</div></div>
  `).join("");
}

function labelType(type) {
  return {
    collector: "Collector",
    scraper: "Scraper",
    metric: "指标",
    transform: "Transform",
    security: "安全",
    credential_provider: "凭据",
    discovery: "发现",
    config_profile: "配置模板",
    protocol_client: "协议客户端",
    cache: "缓存",
    bundle: "组合包",
    config: "配置",
    auth: "认证"
  }[type] || type;
}

function labelRisk(risk) {
  return { low: "低风险", medium: "中风险", high: "高风险" }[risk] || risk;
}

function labelBuild(status) {
  return { success: "成功", failed: "失败", running: "构建中" }[status] || status;
}

function labelSync(status) {
  return { success: "已同步", failed: "失败", pending: "待同步" }[status] || status;
}

function labelSummarySource(source) {
  return { hunyuan: "混元整理", local: "本地清洗" }[source] || "待整理";
}

function labelPackageSource(source) {
  return { "github-release": "GitHub Release", "manual-upload": "手动上传" }[source] || source || "版本包";
}

function labelAssetType(type) {
  return {
    binary: "二进制资产",
    archive: "归档资产",
    "source-archive": "源码包",
    metadata: "校验文件",
    asset: "资产"
  }[type] || type || "资产";
}

function labelArtifactKind(kind) {
  return {
    "go-source-assembly": "Go 源码装配包",
    "go-source-assembly-with-official-asset": "Go 源码装配包 + 官方资产",
    "local-runnable-exporter": "本地模拟运行包"
  }[kind] || kind || "构建产物";
}

function labelBuildTarget(target) {
  if (!target) return "-";
  if (typeof target === "string") return target;
  const raw = rawBuildTargetLabel(target);
  const preset = findBuildTargetPreset(target);
  if (target.label && target.label !== raw) return target.label;
  return preset ? `${preset.label}（${raw}）` : raw || "-";
}

function rawBuildTargetLabel(target) {
  if (!target) return "";
  const suffix = target.arch === "arm" && target.arm ? `v${target.arm}` : "";
  return [target.os, `${target.arch || ""}${suffix}`].filter(Boolean).join("/");
}

function buildTargetEnv(target) {
  const os = target?.os || "";
  const arch = target?.arch || "";
  if (!os || !arch) return "";
  return [`GOOS=${os}`, `GOARCH=${arch}`, arch === "arm" && target.arm ? `GOARM=${target.arm}` : ""].filter(Boolean).join(" ");
}

function getBuildTargetPreset(id) {
  return buildTargetPresets.find((preset) => preset.id === id) || null;
}

function findBuildTargetPreset(target = {}) {
  const os = target.os || "";
  const arch = target.arch || "";
  const arm = target.arm || "";
  return buildTargetPresets.find((preset) => preset.id !== "custom"
    && preset.os === os
    && preset.arch === arch
    && (preset.arm || "") === arm) || null;
}

function labelValidation(status) {
  return { passed: "校验通过", failed: "校验失败", pending: "待校验", active: "可用", unknown: "未知" }[status] || status || "未知";
}

function labelDownload(file) {
  return {
    package: "下载企业包",
    binary: "下载二进制",
    artifact: "产物说明",
    exporter: ".exporter.yaml",
    custom: "custom.yaml",
    lock: "custom.lock",
    "build-info": "build-info",
    "assembly-validation": "装配报告",
    assembly: "all_gen.go",
    registry: "capabilities_gen.go",
    log: "构建日志"
  }[file] || file;
}

function labelPreview(file) {
  return {
    binary: "二进制执行文件",
    artifact: "产物说明",
    exporter: ".exporter.yaml",
    custom: "custom.yaml",
    lock: "custom.lock.yaml",
    "build-info": "build-info.json",
    "assembly-validation": "装配验证报告",
    assembly: "custom/all/all_gen.go",
    registry: "company/ext/capabilities_gen.go",
    log: "构建日志"
  }[file] || labelDownload(file);
}

function shortError(value) {
  return String(value || "").replace(/\s+/g, " ").slice(0, 260);
}

function countCoveredKinds(kindCoverage) {
  if (!kindCoverage || typeof kindCoverage !== "object") return 0;
  return Object.values(kindCoverage).filter((count) => Number(count) > 0).length;
}

function packageStatus(pkg) {
  if (pkg.validation?.status && pkg.validation.status !== "unknown") return pkg.validation.status;
  return pkg.status || "active";
}

function toPascal(raw) {
  return String(raw || "Custom")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("") || "Custom";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(raw) {
  if (!raw) return "未发布";
  return new Date(raw).toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}

refresh().catch((error) => {
  notify("页面加载失败", error.message);
  console.error(error);
});
