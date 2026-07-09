const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

process.env.EXPORTER_STUDIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "exporter-studio-test-"));

const {
  addCustomItem,
  createBuild,
  deleteBuild,
  getBuildDownload,
  getDashboard,
  refreshDiffs,
  saveCapabilityPackage,
  saveExporter,
  updateBuildTags,
  uploadOfficialVersion
} = require("../src/platform");
const { resetState, DATA_DIR, STORE_FILE } = require("../src/store");

test("custom item creates a visible diff", () => {
  resetState();
  const item = addCustomItem({
    id: "custom-test",
    name: "测试指标",
    type: "metric",
    path: "custom/snmp_exporter/test_metric.go",
    description: "测试 custom 目录差异"
  });

  assert.equal(item.exporterId, "snmp_exporter");
  assert.equal(item.scope, "selected-package");
  assert.equal(item.customConfigPath, "custom/custom.yaml");
  const diffs = refreshDiffs();
  assert.equal(diffs.some((diff) => diff.file === "custom/snmp_exporter/test_metric.go"), true);
  assert.equal(diffs.some((diff) => diff.boundary === "company-ext"), true);
  assert.equal(diffs.some((diff) => diff.boundary === "custom-config"), true);
});

test("build uses enabled custom count", () => {
  resetState();
  addCustomItem({
    id: "custom-build",
    name: "构建指标",
    type: "metric",
    path: "custom/snmp_exporter/build_metric.go",
    description: "参与构建"
  });

  const build = createBuild({});
  assert.equal(build.status, "success");
  assert.equal(build.customCount, 2);
  assert.equal(build.compileMode, "source-build");
  assert.equal(build.artifactKind, "go-source-assembly");
  assert.equal(build.verification.ok, true);
  assert.equal(build.downloadReady, true);
  assert.equal(build.target.os, "linux");
  assert.equal(build.target.arch, "amd64");
  assert.equal(build.target.label, "linux/amd64");
  assert.match(build.runtimeEntrypoint, /^dist\/snmp_exporter-build-/);
  assert.equal(build.runtimeEntrypoint.endsWith(".exe"), false);
  assert.equal(build.selectedPackages.some((pkg) => pkg.packageId === "custom-build"), true);
  assert.equal(build.customItemNames.includes("构建指标"), true);
  assert.match(build.registryHook, /RegisterCompanyExt/);
  assert.equal(build.customConfigPath, "custom/custom.yaml");
  assert.equal(build.lockFilePath, "custom/custom.lock.yaml");
  assert.equal(build.generatedAssemblyPath, "custom/all/all_gen.go");
  assert.equal(build.generatedRegistryPath, "company/ext/capabilities_gen.go");
  assert.equal(build.buildInfoPath, "dist/build-info.json");
  assert.match(build.artifact, /registry\.internal\/exporters\/snmp_exporter:/);
});

test("build records support tags and deletion", () => {
  resetState();
  const build = createBuild({
    tags: "认证, windows"
  });

  assert.deepEqual(build.tags, ["认证", "windows"]);

  const tagged = updateBuildTags({
    buildId: build.id,
    tags: "回归 Windows"
  });
  assert.deepEqual(tagged.tags, ["回归", "Windows"]);

  const deleted = deleteBuild(build.id);
  assert.equal(deleted.status, "deleted");
  assert.equal(getDashboard().exporter.builds.some((item) => item.id === build.id), false);
});

test("build target can be manually selected for arm and amd architectures", () => {
  resetState();
  const arm64Build = createBuild({
    version: "snmp_exporter-arm64-build",
    targetOs: "linux",
    targetArch: "arm64"
  });
  assert.equal(arm64Build.target.os, "linux");
  assert.equal(arm64Build.target.arch, "arm64");
  assert.equal(arm64Build.target.source, "manual");
  assert.equal(arm64Build.compiledBinary.target.arch, "arm64");
  assert.equal(arm64Build.compiledBinary.fileName.endsWith(".exe"), false);

  const armv7Build = createBuild({
    version: "snmp_exporter-armv7-build",
    targetOs: "linux",
    targetArch: "arm",
    targetArm: "7"
  });
  assert.equal(armv7Build.target.label, "linux/armv7");
  assert.equal(armv7Build.compiledBinary.target.arm, "7");

  const amd64Build = createBuild({
    version: "snmp_exporter-amd64-build",
    targetOs: "linux",
    targetArch: "amd64"
  });
  assert.equal(amd64Build.target.label, "linux/amd64");
  assert.equal(amd64Build.compiledBinary.target.arch, "amd64");
});

test("windows exporter builds use matching official exe instead of generated fallback", () => {
  resetState();
  const officialDir = path.join(DATA_DIR, "fixtures");
  fs.mkdirSync(officialDir, { recursive: true });
  const sourcePath = path.join(officialDir, "windows_exporter-v0.31.7-source.tar.gz");
  const arm64Path = path.join(officialDir, "windows_exporter-0.31.7-arm64.exe");
  const binaryPath = path.join(officialDir, "windows_exporter-0.31.7-amd64.exe");
  fs.writeFileSync(sourcePath, Buffer.from("fake source archive"));
  fs.writeFileSync(arm64Path, Buffer.from("fake windows arm64 exe"));
  fs.writeFileSync(binaryPath, Buffer.from("fake windows exe"));

  const state = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  const catalog = state.exporterCatalog.find((item) => item.id === "windows_exporter");
  catalog.packages = [
    {
      id: "windows-source",
      exporterId: "windows_exporter",
      exporterName: "windows_exporter",
      version: "v0.31.7",
      source: "github",
      fileName: "windows_exporter-v0.31.7-source.tar.gz",
      assetType: "source-archive",
      os: "source",
      arch: "source",
      storagePath: sourcePath,
      availableForBuild: true
    },
    {
      id: "windows-arm64-exe",
      exporterId: "windows_exporter",
      exporterName: "windows_exporter",
      version: "v0.31.7",
      source: "github",
      fileName: "windows_exporter-0.31.7-arm64.exe",
      assetType: "binary",
      os: "windows",
      arch: "arm64",
      storagePath: arm64Path,
      availableForBuild: true
    },
    {
      id: "windows-amd64-exe",
      exporterId: "windows_exporter",
      exporterName: "windows_exporter",
      version: "v0.31.7",
      source: "github",
      fileName: "windows_exporter-0.31.7-amd64.exe",
      assetType: "binary",
      os: "windows",
      arch: "amd64",
      storagePath: binaryPath,
      availableForBuild: true
    }
  ];
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");

  saveExporter({
    id: "windows_exporter",
    name: "windows_exporter",
    officialPackageId: "windows-arm64-exe",
    localVersion: "windows_exporter-internal-1.0.0"
  });
  const build = createBuild({
    selectedPackageIds: [],
    targetOs: "windows",
    targetArch: "amd64",
    version: "windows_exporter-internal-1.0.0"
  });
  const binary = getBuildDownload(build.id, "binary");

  assert.equal(build.status, "success");
  assert.equal(build.officialPackageId, "windows-amd64-exe");
  assert.equal(build.compiledBinary.source, "official-binary");
  assert.equal(build.compiledBinary.fileName.endsWith(".exe"), true);
  assert.deepEqual(binary.content, Buffer.from("fake windows exe"));
});

test("build downloads are resolved by build id across enterprise versions", () => {
  resetState();
  const firstBuild = createBuild({
    version: "snmp_exporter-internal-cross-version"
  });
  saveExporter({
    id: "node_exporter-v1-11-1",
    name: "node_exporter",
    officialBaseline: "v1.11.1",
    localVersion: "node_exporter-internal-1.0.0"
  });

  const artifact = getBuildDownload(firstBuild.id, "artifact");

  assert.match(artifact.content, /snmp_exporter-internal-cross-version/);
  assert.match(artifact.content, /exporter=snmp_exporter/);
  assert.equal(getDashboard().exporter.name, "node_exporter");
});

test("dashboard exposes exporter catalog", () => {
  resetState();
  const dashboard = getDashboard();
  assert.equal(dashboard.exporterCatalog.length >= 5, true);
  assert.equal(dashboard.exporterCatalog.some((item) => item.id === "node_exporter"), true);
});

test("exporter metadata stores management ownership", () => {
  resetState();
  const exporter = saveExporter({
    id: "snmp_exporter",
    name: "snmp_exporter",
    officialRepo: "https://github.com/prometheus/snmp_exporter",
    officialBaseline: "v0.30.1",
    monitoringSystem: "统一监控平台",
    department: "网络运维部",
    contactName: "张工",
    contactInfo: "ops@example.com"
  });

  assert.equal(exporter.monitoringSystem, "统一监控平台");
  assert.equal(exporter.department, "网络运维部");
  assert.equal(getDashboard().exporters.length >= 1, true);
});

test("official package upload is stored as fixed baseline artifact", () => {
  resetState();
  const pkg = uploadOfficialVersion({
    catalogId: "snmp_exporter",
    version: "v0.30.1-fixed",
    fileName: "snmp_exporter-v0.30.1.tar.gz",
    contentBase64: Buffer.from("fixed official package").toString("base64"),
    note: "固定官方包"
  });
  const dashboard = getDashboard();
  const catalog = dashboard.exporterCatalog.find((item) => item.id === "snmp_exporter");

  assert.equal(pkg.version, "v0.30.1-fixed");
  assert.equal(pkg.source, "manual-upload");
  assert.equal(catalog.packages.length, 1);
  assert.match(catalog.packages[0].checksum, /^[a-f0-9]{64}$/);
});

test("enterprise version selects official package from catalog", () => {
  resetState();
  const pkg = uploadOfficialVersion({
    catalogId: "snmp_exporter",
    version: "v0.30.1-fixed",
    fileName: "snmp_exporter-v0.30.1.tar.gz",
    contentBase64: Buffer.from("fixed official package").toString("base64")
  });
  const exporter = saveExporter({
    id: "snmp_exporter",
    name: "snmp_exporter",
    officialRepo: "https://github.com/prometheus/snmp_exporter",
    officialPackageId: pkg.id,
    monitoringSystem: "统一监控平台"
  });

  assert.equal(exporter.officialPackageId, pkg.id);
  assert.equal(exporter.officialBaseline, "v0.30.1-fixed");
  assert.equal(exporter.officialPackageSource, "manual-upload");
});

test("enterprise versions can coexist for multiple official minor versions", () => {
  resetState();
  const pkgA = uploadOfficialVersion({
    catalogId: "snmp_exporter",
    version: "v0.30.1",
    fileName: "snmp_exporter-v0.30.1.tar.gz",
    contentBase64: Buffer.from("minor version a").toString("base64"),
    note: "小版本 A"
  });
  const pkgB = uploadOfficialVersion({
    catalogId: "snmp_exporter",
    version: "v0.30.2",
    fileName: "snmp_exporter-v0.30.2.tar.gz",
    contentBase64: Buffer.from("minor version b").toString("base64"),
    note: "小版本 B"
  });

  const exporterA = saveExporter({
    id: "snmp_exporter",
    name: "snmp_exporter",
    officialPackageId: pkgA.id,
    minorVersionNote: "验证 v0.30.1"
  });
  const exporterB = saveExporter({
    id: "snmp_exporter",
    name: "snmp_exporter",
    officialPackageId: pkgB.id,
    minorVersionNote: "验证 v0.30.2"
  });
  const versions = getDashboard().exporters.filter((item) => item.name === "snmp_exporter");

  assert.notEqual(exporterA.id, exporterB.id);
  assert.equal(versions.some((item) => item.officialBaseline === "v0.30.1"), true);
  assert.equal(versions.some((item) => item.officialBaseline === "v0.30.2"), true);
  assert.equal(exporterB.minorVersionNote, "验证 v0.30.2");
});

test("dashboard exposes custom manifest and trunk changes", () => {
  resetState();
  const dashboard = getDashboard();
  assert.equal(dashboard.exporter.customManifest.compileMode, "source-build");
  assert.equal(dashboard.exporter.collectorRegistryHook.strategy, "stable-hook");
  assert.equal(dashboard.summary.trunkChangeCount >= 1, true);
});

test("dashboard exposes fixed custom extension points", () => {
  resetState();
  const dashboard = getDashboard();
  assert.deepEqual(
    dashboard.extensionPoints.map((point) => point.id),
    [
      "metric",
      "collector",
      "transform",
      "scraper",
      "security",
      "credential_provider",
      "discovery",
      "config_profile",
      "protocol_client",
      "cache",
      "bundle"
    ]
  );
});

test("custom extension stores editable and generated source", () => {
  resetState();
  const item = addCustomItem({
    id: "custom-transform",
    name: "标签标准化",
    extensionPoint: "transform",
    path: "custom/snmp_exporter/transforms/label_normalize.go",
    description: "补充标准标签",
    editableCode: "for i := range metrics {\n    metrics[i].Labels[\"region\"] = \"cn\"\n}\nreturn metrics, nil"
  });
  assert.equal(item.extensionPoint, "transform");
  assert.equal(item.validation.status, "passed");
  assert.match(item.generatedCode, /NewMetricTransform_CustomTransform/);
});

test("custom extension validation catches unsafe empty code", () => {
  resetState();
  const item = addCustomItem({
    id: "custom-bad",
    name: "坏模板",
    extensionPoint: "metric",
    editableCode: ""
  });
  assert.equal(item.validation.status, "failed");
});

test("custom extension validation catches invalid Go syntax", () => {
  resetState();
  const pkg = saveCapabilityPackage({
    id: "pkg-invalid-go",
    name: "坏 Go 代码",
    extensionPoint: "collector",
    editableCode: "metric := Metric{Name: \"bad\", Value: 1,\nsdfa\n}\nreturn []Metric{metric}, nil"
  });

  assert.equal(pkg.validation.status, "failed");
  assert.equal(pkg.validation.errors.some((item) => item.includes("Go 语法校验失败")), true);
});

test("capability snippets can declare imports that are hoisted into generated Go files", () => {
  resetState();
  const pkg = saveCapabilityPackage({
    id: "pkg-imported-collector",
    name: "引入包采集器",
    extensionPoint: "collector",
    path: "custom/capabilities/pkg-imported-collector/collector/company_collector.go",
    editableCode: `import (
    "strings"
    "net/url"
)
endpoint := strings.TrimSpace("http://127.0.0.1:9100/metrics")
parsed, err := url.Parse(endpoint)
if err != nil {
    return nil, err
}
metric := Metric{Name: "imported_collector_up", Type: "gauge", Labels: map[string]string{"host": parsed.Host}, Value: 1}
return []Metric{metric}, nil`
  });

  assert.equal(pkg.validation.status, "passed");
  assert.match(pkg.generatedCode, /import \([\s\S]*"net\/url"[\s\S]*\)/);
  assert.match(pkg.generatedCode, /import \([\s\S]*"strings"[\s\S]*\)/);
  assert.doesNotMatch(pkg.generatedCode.match(/func NewCompanyCollector_PkgImportedCollector\(\) \(\[\]Metric, error\) \{[\s\S]*?\n\}/)?.[0] || "", /^\s*import\s/m);

  const build = createBuild({
    selectedPackageIds: ["pkg-imported-collector"],
    version: "snmp_exporter-imported-collector"
  });
  assert.equal(build.status, "success");
  assert.equal(build.verification.ok, true);
  assert.equal(build.compiledBinary.ok, true);
});

test("scraper extension supports external service metric pulling", () => {
  resetState();
  const item = addCustomItem({
    id: "custom-http-scraper",
    name: "HTTP 服务拉取",
    extensionPoint: "scraper",
    path: "custom/snmp_exporter/scrapers/http_service.go",
    description: "访问内部 HTTP 服务并转换为指标",
    editableCode: "endpoint := \"http://127.0.0.1:8080/status\"\nmetric := Metric{Name: \"external_service_up\", Type: \"gauge\", Labels: map[string]string{\"endpoint\": endpoint}, Value: 1}\nreturn []Metric{metric}, nil"
  });

  assert.equal(item.extensionPoint, "scraper");
  assert.equal(item.validation.status, "passed");
  assert.match(item.generatedCode, /NewServiceScraper_CustomHttpScraper/);
});

test("capability package is stored as reusable asset without binding exporter version", () => {
  resetState();
  const pkg = saveCapabilityPackage({
    id: "pkg-http-health",
    name: "HTTP 健康探测",
    extensionPoint: "scraper",
    packageVersion: "1.2.0",
    owner: "监控平台组",
    path: "custom/capabilities/pkg-http-health/scraper/http_health.go",
    editableCode: "endpoint := \"http://127.0.0.1:8080/health\"\nmetric := Metric{Name: \"external_service_up\", Type: \"gauge\", Labels: map[string]string{\"endpoint\": endpoint}, Value: 1}\nreturn []Metric{metric}, nil"
  });
  const dashboard = getDashboard();

  assert.equal(pkg.id, "pkg-http-health");
  assert.equal(pkg.kind, "scraper");
  assert.match(pkg.import_path, /custom\/capabilities\/pkg-http-health/);
  assert.equal(Array.isArray(pkg.provides), true);
  assert.equal(Array.isArray(pkg.requires), true);
  assert.equal(Array.isArray(pkg.files), true);
  assert.equal(pkg.validation.status, "passed");
  assert.equal(dashboard.capabilityPackages.some((item) => item.id === "pkg-http-health"), true);
  assert.equal(dashboard.exporter.customItems.some((item) => item.packageId === "pkg-http-health"), false);
});

test("legacy version-scoped capability compatibility is treated as reusable", () => {
  resetState();
  const pkg = saveCapabilityPackage({
    id: "pkg-legacy-auth",
    name: "旧认证能力",
    extensionPoint: "security",
    compatible: { exporters: ["windows_exporter-v0-31-7"], min_version: "", max_version: "" },
    editableCode: "return next, nil"
  });

  assert.deepEqual(pkg.compatible.exporters, ["*"]);
});

test("build assembles selected reusable packages and exposes download payloads", () => {
  resetState();
  saveCapabilityPackage({
    id: "pkg-http-health",
    name: "HTTP 健康探测",
    extensionPoint: "scraper",
    path: "custom/capabilities/pkg-http-health/scraper/http_health.go",
    editableCode: "endpoint := \"http://127.0.0.1:8080/health\"\nmetric := Metric{Name: \"external_service_up\", Type: \"gauge\", Labels: map[string]string{\"endpoint\": endpoint}, Value: 1}\nreturn []Metric{metric}, nil"
  });

  const build = createBuild({
    selectedPackageIds: ["authtest", "pkg-http-health"],
    version: "snmp_exporter-internal-2.0.0",
    operator: "张工",
    note: "测试构建"
  });
  const custom = getBuildDownload(build.id, "custom");
  const lock = getBuildDownload(build.id, "lock");
  const assembly = getBuildDownload(build.id, "assembly");
  const enterprisePackage = getBuildDownload(build.id, "package");
  const binary = getBuildDownload(build.id, "binary");
  const packageContent = zlib.gunzipSync(enterprisePackage.content).toString("utf8");

  assert.equal(build.customCount, 2);
  assert.equal(build.selectedPackages.some((pkg) => pkg.packageId === "pkg-http-health"), true);
  assert.match(custom.content, /custom-package-selection/);
  assert.match(lock.content, /pkg-http-health/);
  assert.match(assembly.content, /pkg-http-health/);
  assert.equal(enterprisePackage.contentType, "application/gzip");
  assert.match(enterprisePackage.fileName, /snmp_exporter-internal-2\.0\.0\.tar\.gz/);
  assert.match(packageContent, /go\.mod/);
  assert.match(packageContent, /cmd\/exporter-studio\/main\.go/);
  assert.match(packageContent, /dist\/build-info\.json/);
  assert.match(packageContent, /custom\/all\/all_gen\.go/);
  assert.match(packageContent, /company\/ext\/capability\.go/);
  assert.match(packageContent, /custom\/capabilities\/pkg-http-health\/scraper\/http_health\.go/);
  assert.match(packageContent, /dist\/verification\.json/);
  assert.match(packageContent, /dist\/assembly-validation\.json/);
  assert.equal(build.verification.ok, true);
  assert.match(build.verification.mode, /go-build|go-test|static-go-source-check/);
  assert.equal(build.compiledBinary.ok, true);
  assert.equal(binary.contentType, "application/octet-stream");
  assert.equal(binary.content.length > 0, true);
});

test("build validates assembly semantics for every capability kind", () => {
  resetState();
  const definitions = [
    ["pkg-collector", "collector", "metric := Metric{Name: \"collector_up\", Type: \"gauge\", Value: 1}\nreturn []Metric{metric}, nil", ["collector:test"], [], ["collector_up"]],
    ["pkg-scraper", "scraper", "endpoint := \"http://127.0.0.1:8080/health\"\nmetric := Metric{Name: \"external_service_up\", Type: \"gauge\", Labels: map[string]string{\"endpoint\": endpoint}, Value: 1}\nreturn []Metric{metric}, nil", ["scraper:http"], [], ["external_service_up"]],
    ["pkg-metric", "metric", "metric := Metric{Name: \"custom_metric\", Type: \"gauge\", Value: 1}\nreturn []Metric{metric}, nil", ["metric:custom"], [], ["custom_metric"]],
    ["pkg-transform", "transform", "for i := range metrics { _ = i }\nreturn metrics, nil", ["transform:labels"], [], []],
    ["pkg-credentials", "credential_provider", "return Credentials{}, nil", ["credential_provider:file"], [], []],
    ["pkg-discovery", "discovery", "return []Target{}, nil", ["discovery:static"], [], []],
    ["pkg-profile", "config_profile", "return ConfigProfile{Name: \"default\"}, nil", ["config_profile:default"], [], []],
    ["pkg-protocol", "protocol_client", "return nil, nil", ["protocol:http"], [], []],
    ["pkg-cache", "cache", "return nil, nil", ["cache:memory"], [], []],
    ["pkg-bundle", "bundle", "return []string{\"pkg-collector\", \"pkg-scraper\"}, nil", ["bundle:test"], ["pkg-collector", "pkg-scraper"], []]
  ];
  for (const [id, kind, editableCode, provides, requires, metrics] of definitions) {
    saveCapabilityPackage({
      id,
      name: id,
      extensionPoint: kind,
      path: `custom/capabilities/${id}/capability.go`,
      editableCode,
      provides,
      requires,
      metrics,
      config: { enabled: "true" },
      compatible: { exporters: ["snmp_exporter"], min_version: "", max_version: "" }
    });
  }

  const build = createBuild({
    selectedPackageIds: [
      "authtest",
      "pkg-collector",
      "pkg-scraper",
      "pkg-metric",
      "pkg-transform",
      "pkg-credentials",
      "pkg-discovery",
      "pkg-profile",
      "pkg-protocol",
      "pkg-cache",
      "pkg-bundle"
    ],
    version: "snmp_exporter-all-kinds-1.0.0"
  });
  const validation = getBuildDownload(build.id, "assembly-validation");
  const report = JSON.parse(validation.content);

  assert.equal(build.assemblyValidation.ok, true);
  for (const kind of [
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
  ]) {
    assert.equal(report.kindCoverage[kind] > 0, true, `${kind} should be covered`);
  }
  assert.equal(build.selectedPackages.some((pkg) => pkg.packageId === "pkg-collector"), true);
  assert.equal(build.selectedPackages.some((pkg) => pkg.packageId === "authtest"), true);
  assert.equal(validation.contentType, "application/json; charset=utf-8");
});

test.after(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});
