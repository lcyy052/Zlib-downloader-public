# GitHub 发布指南

## 已整理的范围

源码、MIT 许可证、公开使用说明、安全与贡献指南、依赖说明、模拟截图、离线 CI 配置，以及允许清单式发布工具。个人交接历史与实测记录保留在本机忽略的 `.local/private-docs/`，不进入发布包。

## 生成干净包

```powershell
npm run check
npm test
npm run test:release
npm run release:check
npm run release:prepare
```

prepare 会在忽略的 `release/` 中创建一个新的唯一目录和对应 ZIP；只从允许清单复制当前文件，不复制 Git 历史、依赖、账号、日志或下载产物。不会删除旧包或修改运行数据。压缩使用 Windows 自带 PowerShell / .NET，包含 .gitignore 与 .github 等点文件，并生成 ZIP 的 SHA-256 校验文件；其他系统可使用生成的源码目录自行压缩。

`release:check` 只审查待公开的允许清单及已跟踪文件路径，不打印凭据值。它能发现部分常见令牌、私钥、带凭据 URL、敏感运行文件、个人机器路径和符号链接；不是完整安全审计。还需要人工看截图和文档。

## 首次公开：从干净目录新建仓库

**不要直接把本地现有 Git 历史推送为公开仓库。** 旧提交可能包含已从当前工作区移出的个人文档、图片和运行细节；gitignore 不追溯历史，删除文件也不清除历史。

推荐步骤：

1. 运行 prepare，解压 ZIP 到另一个新目录；检查里面没有 `.git`、`.data`、`.local`、`downloads`、日志或电子书。
2. 在 GitHub 创建新仓库，可先选 Private。不要勾选自动创建 README/许可证，避免初次推送的历史冲突。
3. 在这个**新目录**运行：
   ```powershell
   git init -b main
   git add .
   git commit -m "Initial public release"
   ```
4. 使用 GitHub 创建仓库后提供的真实地址：
   ```powershell
   git remote add origin <替换为你的实际仓库地址>
   git push -u origin main
   ```
   尖括号是说明占位符，不要原样执行。推送前核对账号、仓库和公开范围。
5. 上传后检查 Actions。配置存在不等于 CI 已通过；本轮未创建远程仓库、推送代码或运行远程 CI。
6. 需要正式 Release 时，再由维护者决定版本和 tag；本轮未自动创建 Git tag、GitHub Release 或更改版本号。

若必须保留本地完整历史，应先进行专门的历史审查与必要脱敏；本轮没有重写历史、强制推送或删除原提交。旧本机备份与现有登录/队列均保留。

## 发布前手工检查

- LICENSE 中的归属、年份和许可证符合你的授权决定；若希望署真实姓名或 GitHub 名，可自行替换当前项目贡献者署名。
- 依赖有明确来源和许可证；无复制来的未知授权代码。
- 账号、Cookie、签名链接、代理凭据和书单记录没有出现在正文或图片里。
- 截图是模拟数据，不误导为真实下载成功或测速结果。
- 不打包电子书、浏览器、node_modules 或运行时。
- README 明确非官方身份、适用权限和功能限制；不宣称「全资源可用」「突破额度」或固定速度。
- Issue 不要求上传私人日志或会话；源码只保留 loopback 服务说明。
