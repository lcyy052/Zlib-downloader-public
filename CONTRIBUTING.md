# 贡献指南

感谢帮助改进这个本地工具。提交贡献时，你确认有权以项目的 MIT 许可证提供该贡献；第三方代码应保留来源与许可证，不要复制网站内容或用户运行数据。

## 开发准备

安装 Node.js 22+，建议 24.14+；浏览器测试需要本机 Chrome。运行 `npm ci`，修改后执行：

```powershell
npm run check
npm test
npm run test:release
npm run release:check
```

浏览器 fixture：

```powershell
npm run test:queue-controls
npm run test:adapter
npm run test:booklist
npm run test:download
```

这些测试使用本地模拟资源与临时目录，不需要网站账号。生成公开示例截图：`npm run screenshots:public`，同样不连接真实服务。

## 不要误操作生产队列

- `test:queue-controls` 自带独立模拟服务，是队列展示的首选测试。
- `test:ui` 会清理并添加演示记录，只能对单独的演示服务运行。
- `test:views` 默认使用指定本地服务；带 `--live` 时访问真实搜索和封面，不作为离线 CI。
- `verify-live-download.mjs` 会下载并写回真实记录，不是只读工具。
- 需要真实站点验证时，先取得授权并确认正在运行的任务，不擅自暂停或重启已有服务，不复制日常浏览器资料。

## 维护原则

保持全局与书单的暂停范围独立；重启不自动启动任务。不要覆盖完整文件、静默清理失败记录，或将「处理完成」混同「全部成功」。

针对 bug 先增加可重复的 fixture，再改实现。下载修改覆盖取消隔离、临时文件清理和错误状态；分页修改覆盖空中间页、延迟 DOM、重复页码与部分结果保留。

截图、Issue 和测试数据全部脱敏，优先使用明确标记的演示资源。不要为了通过测试而关闭 TLS 校验或绕过站点权限。CI 只验证内部行为，不宣称真实网站永久可用。

## 提交与 PR

说明修改目的、实际运行的测试及未验证部分。PR 不附 Cookie、登录会话、电子书或原始生产日志。尚未指定仓库 URL，请发布后补充项目的真实反馈入口，不使用占位链接冒充有效地址。
