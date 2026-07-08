# 真实 Exporter 构建落地方案

## 1. 目标

Exporter Studio 的目标不是用 Node.js 模拟 exporter，也不是做运行时 `.so plugin`，而是把企业定制能力以 Go 源码方式装配到企业版 exporter 构建流程中。

推荐模型：

```text
企业发行版本 =
官方 upstream 基线
+ cmg 企业分支
+ company/ext 稳定扩展接口
+ custom/custom.yaml 选择的一组能力包
+ 构建配置
+ 必要版本补丁
```

## 2. 当前已经落地

### GitHub Release / 手动上传

- 支持同步 GitHub Release。
- 支持识别 release asset 类型、OS、架构。
- 支持手动上传固定官方版本包。
- 支持 `GITHUB_API_BASE_URL` 指向内网 GitHub 代理或镜像。

### 能力包体系

- 统一称为 Capability Package。
- 通过 `kind` 区分类型：
  - `collector`
  - `scraper`
  - `metric`
  - `transform`
  - `security`
  - `credential_provider`
  - `discovery`
  - `config_profile`
  - `protocol_client`
  - `cache`
  - `bundle`
- 能力包统一放在：

```text
custom/capabilities/<capability-name>/
```

### 构建期生成

构建时根据企业版本、官方版本包和能力包选择生成：

```text
custom/custom.yaml
custom/custom.lock.yaml
custom/all/all_gen.go
company/ext/capabilities_gen.go
dist/build-info.json
dist/verification.json
dist/assembly-validation.json
build/exporter-builder.yaml
```

### 编译与下载

- 支持 Go 源码结构校验。
- 安装 Go 后执行真实 `go test ./...` 和 `go build`。
- 按目标平台生成二进制：
  - `linux/amd64` 不带 `.exe`
  - `windows/amd64` 带 `.exe`
- 构建记录支持下载源码包、二进制、构建日志和元数据。

## 3. 当前能力包嵌入方式

### company/ext

`company/ext` 定义稳定接口和能力包元数据注册表。

核心结构：

```go
type CapabilityInfo struct {
    Name           string
    Kind           CapabilityKind
    Version        string
    Description    string
    Owner          string
    ImportPath     string
    Source         string
    DefaultEnabled bool
    Provides       []string
    Requires       []string
    Metrics        []string
    Config         map[string]string
    Compatible     CompatibleRange
    Files          []string
}
```

### custom/all/all_gen.go

`custom/all/all_gen.go` 负责 blank import 本次构建选择的能力包，让 Go 编译器把它们编译进产物。

### company/ext/capabilities_gen.go

`company/ext/capabilities_gen.go` 统一注册 `CapabilityInfo` 元数据。

注意：能力包源码不再自己 `init()` 注册 `CapabilityInfo`，避免重复注册。元数据由构建器统一生成和注册。

## 4. 后续接入官方 exporter 主干

不同 exporter 的官方主干结构不同，所以稳定 hook 需要逐类落地。

### node_exporter

建议接入点：

- collector 注册表
- 主程序 import 区
- collector 初始化流程

目标：

```go
import _ "<module-path>/custom/all"
```

在 collector registry 附近接入 `company/ext`。

### windows_exporter

建议接入点：

- collector 初始化
- handler 或 middleware 初始化
- Windows exporter 启动参数处理后

认证类能力包应能在 `/metrics` handler 前生效。

### snmp_exporter

建议接入点：

- generator 生成配置流程
- module/profile 处理流程
- scrape 前后处理流程

`config_profile`、`protocol_client`、`scraper` 类能力包需要重点验证。

### blackbox_exporter

建议接入点：

- prober 注册
- module 配置解析
- probe 执行前后处理

## 5. 生产构建建议流程

```text
1. 拉取官方 exporter 指定 tag 源码。
2. 切换或创建 cmg 企业分支。
3. 应用最小稳定 hook 补丁。
4. exporter-builder 写入 company/ext 和 custom 目录。
5. 生成 custom/all/all_gen.go。
6. 生成 company/ext/capabilities_gen.go。
7. 生成 custom/custom.lock.yaml。
8. 生成 dist/build-info.json。
9. 执行 gofmt。
10. 执行 go test ./...。
11. 执行官方 exporter 构建命令。
12. 归档二进制、源码包、lock、build-info、构建日志。
```

## 6. 验收标准

一类 exporter 接入完成，应至少满足：

- 能基于官方 tag 构建。
- 官方默认指标不丢失。
- 未选择能力包时行为和官方版本一致。
- 选择 `security` 能力包后 `/metrics` 鉴权生效。
- 选择 `collector` / `scraper` 后新增指标可见。
- `custom/custom.lock.yaml` 可以复现当次构建。
- `dist/build-info.json` 能说明官方基线、企业版本、目标平台、能力包和构建结果。

## 7. 当前边界

当前系统已经能验证能力包体系、源码装配、Go 编译、目标平台二进制命名和下载流程。

要获得完整生产形态，还需要针对每类官方 exporter 落稳定 hook，并使用该 exporter 官方构建命令编译最终企业版。

