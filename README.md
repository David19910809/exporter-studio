# Exporter Studio

Exporter Studio 是一个轻量级 exporter 版本治理和企业定制构建工具。

它以 Git upstream + cmg 企业分支为版本治理模型，以 `company/ext` 作为稳定扩展接口，以 `custom/capabilities` 作为可复用能力包资产库，通过 `custom/custom.yaml` 选择能力包，并在构建期生成装配代码、锁定文件、构建信息和目标平台二进制。

## 核心能力

- 同步 GitHub Release 或手动上传固定官方版本包。
- 维护 exporter 官方基线、企业版本、小版本备注、部门和联系人。
- 通过固定扩展点新增 Capability Package 能力包。
- 构建时选择企业版本、官方版本包和能力包。
- 自动生成：
  - `custom/custom.yaml`
  - `custom/custom.lock.yaml`
  - `custom/all/all_gen.go`
  - `company/ext/capabilities_gen.go`
  - `dist/build-info.json`
- 执行 Go 源码验证和目标平台二进制编译。
- 下载源码装配包、二进制、构建日志和构建元数据。

## 详细手册

开发和测试同学请先阅读：

- [Exporter Studio 使用与开发手册](docs/exporter-studio-manual.md)
- [真实 Exporter 构建落地方案](docs/real-exporter-build-plan.md)

## 启动

```powershell
npm start
```

打开：

```text
http://localhost:3000/
```

## 测试

```powershell
npm test
```

## Go 编译

真实构建二进制需要本机安装 Go，并确保：

```powershell
go version
```

可以正常执行。

当前默认目标平台规则：

- `node_exporter`：`linux/amd64`，产物无 `.exe` 后缀。
- `windows_exporter`：`windows/amd64`，产物有 `.exe` 后缀。

## 数据目录

本地运行数据保存在：

```text
.elmp/
```

包括同步到的版本目录、构建记录、构建产物和上传文件。

