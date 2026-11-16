# 技术交接与维护说明

更新：2026-11-06。本文是可公开的维护说明，不包含个人机器路径、账号会话、实际书单记录或实时任务数量。

## 架构

```text
浏览器界面（public）
       ↓ 本机 JSON API / SSE
本地服务（src/server.js）
       ↓ 队列与来源状态（src/queue.js）
浏览器适配器（src/provider.js）
       ├─ 登录、搜索、分页、定位文件请求
       ├─ Node HTTP 文件流（优先）
       └─ 隔离的 Chrome 响应文件流（回退）
```

数据在项目相对的 `.data/live` / `.data/demo` 保存；默认下载目录为 `downloads/books` / `downloads/demo`。不要假设别人的配置路径与你相同。服务只绑定 loopback，不提供远程账号体系。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `src/server.js` | HTTP API、配置、匹配任务、SSE、退出和诊断接入 |
| `src/provider.js` | 独立浏览器会话、站点适配、下载流程 |
| `src/queue.js` | 1–3 并发、批次来源状态、持久化、重试、取消 |
| `src/queue-storage.js` | 队列校验、损坏原件归档、完整备份/连续记录前缀恢复 |
| `src/booklist-pagination.js` | 响应结束判定、DOM 增长等待、API 页码推进 |
| `src/book-extract.js` | DOM 书籍信息解析 |
| `src/http-download.js` | Node 流式保存、超时、取消、临时文件 |
| `src/browser-stream-download.js` | Chrome 网络响应流回退 |
| `src/download-errors.js` | HTTP 错误文本和有限重试分类 |
| `src/download-start.js` | 启动槽内监听原页面和本次子页面下载，按 opener 归属隔离并发任务 |
| `src/task-limiter.js` | Chrome 传输池和取消隔离 |
| `src/download-proxy.js` | 仅当前进程的环境/Windows 代理配置 |
| `src/existing-download.js` | 已有文件的保守复用检查 |
| `src/download-name.js` | 安全命名和冲突处理 |
| `src/background-start.js`、`scripts/start-background.mjs` | 独立后台进程、健康检查、日志重定向 |
| `src/runtime-diagnostics.js` | 启动、内存/队列快照、警告与退出日志 |
| `public/app.js` | 页面交互、全局和书单暂停原因展示 |

## 必须维持的语义

1. 全局 paused 与每个书单的 source.state 是两个开关。全局 resume 不恢复单独暂停的书单；batch-resume 不打开全局开关。
2. 程序重启后恢复中断任务为 queued，默认暂停，不自动重试全部失败记录。
3. 相同资源在相同目标文件夹中避免重复排队；跨书单的目录归属不能仅按书名判断。
4. 每个任务记录 downloadRoot，修改设置只影响新任务，历史文件位置不随之改变。
5. 文件保存先写唯一 `.part`，成功后原子落盘；取消和失败清理临时文件，不覆盖已有完整文件。
6. 单本下载失败继续后续任务；持久化失败必须暂停调度并清理 controller。
7. 批次「处理完成」包含失败和取消，不能标为「全部下载成功」。
8. 只复用经名称、大小、格式签名检查的已有文件；不能把四舍五入的页面大小当成二进制一致。
9. 队列 JSON 损坏不能裸抛解析原文（可能含私人数据）。先归档原件，优先读取 `.bak`，再保守提取连续完整记录；修复前先持久化 recovery 暂停标记。恢复提示持续到全局 resume，添加/重试/额度检查不能绕过。
10. `atomicJson(..., { backup: true })` 刷盘新临时文件后先将主文件轮换至 `.bak`，再安装新文件；两次重命名间崩溃时主文件可能不存在，必须从备份恢复。损坏文件不可轮换覆盖已验证的备份。不要把本地损坏原件或实际恢复数量写入公开文档、测试 fixture。

## 下载链路边界

### 新页面触发下载（2026-11-06）

下载按钮可能先用脚本打开子页面，再跳转到文件。此时 Playwright 的 download 事件属于已初始化的子页面，仅监听原页面会误报启动超时并重试。waitForDownloadStart 在点击前同步订阅 context 的新页面事件和 page 的 popup 事件；先装 download 监听，再异步检查 opener 链，限定归属本次任务，结束、取消、超时均移除监听。

不要通过扫描 transfers 目录里“新出现的文件”推测任务进度：旧尝试的延迟下载可能被认成新任务，错误显示“保存中”或别人的字节数。原生 download/saveAs 通道显示传输已开始、等待 Chrome 完成，不伪造字节；download.failure() 也受 watch 的整体超时保护。transferStarted 标志使账号额度暂停时仍能保留已启动的原生传输。Node 和 Chrome 响应流继续显示真实字节及无数据超时。

`node scripts/check-download-initiation.mjs` 使用独立临时配置和本地 HTTP 服务，覆盖同页面、新标签、noopener、脚本打开页面再下载、三个并发任务的文件对应、旧临时文件不串进度和停滞超时。不会访问真实网站或消耗额度。

### 账号额度暂停（2026-10-15）

src/download-limit.js 统一识别网站已用/限额计数、明确的中英文每日额度提示及 429 请求限制。download() 在打开详情、找不到按钮时、取得初始化槽后再次检查；watchDownload 在等待文件启动时检测可见通知及本次下载的弹窗。不要用含“请检查额度”的普通错误或 522 推断额度耗尽，不要在文件点击后的计数增加时误拒绝最后一个合法文件。

DownloadQueue 的 autoPause 是账号级门，不改变各书单的 source.state。触发项回到 queued，停止新任务和未接收字节的初始化请求，已有字节的文件允许完成。add、retry、batch-resume 不隐式清除该门，只有明确的全局 resume 清除；网页恢复操作有确认提示。

自动暂停原因另存至队列文件旁的 .state.json，避免删掉触发记录或重启后丢失门状态。原 queue.json 仍是数组，以保持旧记录兼容。持久化仍串行原子写入，错误不吞掉；恢复时间不根据本机日期猜测。

test:quota 是真实 Chrome 的本地 fixture，不访问真实网站或消耗额度；覆盖上限预检、点击后提示、弹窗、Node/Chrome HTML 和 429、隐藏提示与书籍描述不误判。界面 fixture 覆盖额度原因、保留传输和恢复确认。npm test 通过 scripts/test-unit.mjs 明确列出主 test 目录，避免扫描本机备份及导出包中的旧测试副本。

### 额度自动恢复（2026-10-15）

src/quota-recovery.js 由服务管理生命周期，每分钟检查定时器，到 quotaCheckMinutes（5–1440，默认 30）再探测。quotaAutoResume 默认 false，可通过独立 POST /api/quota-recovery 修改，不要求清空已有队列、不重建登录会话。状态通过 queue.quotaRecovery / SSE 展示。定时器不会在服务退出后运行；开启且有额度自动暂停原因时，重启后重新安排下一次检查。

provider.checkDownloadQuota 新建后台页面，带 no-cache 读取站点首页、检查 HTTP/验证/登录页面，读取明确的已用/限额，关闭自身页面；不点击下载按钮、不刷新用户正在验证的页面。DownloadQueue.resumeAfterQuotaCheck 需要当前 autoPause 对象一致、非 manual、无其他保存异常、新计数明确可用且限额匹配原账号，才清除全局门。仅有明确耗尽文字但无原计数时不自动恢复，以免把游客额度当作账号恢复。已有失败不重排，各 source.state 不修改。

全局 pause 把额度原因标为 manual 并持久化，防止计时器或正在进行的检查覆盖用户选择；设置版本 generation、暂停原因对象一致性与 closing 状态保护并发。关闭服务先取消并等待额度探测再关闭队列/浏览器。HTTP 429 不自动恢复；不根据本机午夜猜测额度重置。test/quota-recovery.test.js 用可控时钟覆盖调度、未知/变化额度、手动优先、关闭与设置竞态；test:quota 用真实隔离 Chrome 验证 fresh 页面、错误/登录/矛盾提示、关闭标签页和零下载点击。

POST /api/quota-recovery/wait 是明确授权接管手动暂停队列的入口；先读取新页面，确认已用/限额确实耗尽，再调用 DownloadQueue.waitForQuotaRecovery，仅保存全局原因，不调用 download、不修改 jobs 或 sources。controlVersion 防止检查期间的手动暂停/继续被覆盖。需要有可运行的 queued 任务、无活动传输、无其他队列错误；配置开关单独开启不会绕过这些条件。

页面点击和下载初始化保留串行门；文件传输按全局并发执行，Chrome 回退另限制最多 2 路。等待传输槽不应消耗尚未启动请求的响应超时。取消一个任务不能结束另一个任务的页面、文件流或许可。

历史兼容问题包括附件交由 Chrome 原生下载管理器时发生异常。当前回退用响应流，不应重新引入第二套 `Browser.setDownloadBehavior` 控制，不能用一次本地原生下载成功推断真实 CDN 下载稳定。

HTTP 410/502/503/504/522 和部分网络超时有限重试；522 使用更长退避。429 不应无节制重试，应提示检查网站额度。错误尽量保留 HTTP 状态，不只显示 Chrome 的通用网络失败。

Node 代理接口依赖较新的运行时。旧 Node、PAC/SOCKS 不支持时回退，不能降低 TLS 校验、复制日常浏览器资料或擅自修改系统代理。

## 长书单分页

接口成功不等于页面增长；按钮因父容器隐藏也不等于真正末页。有返回书籍时等待 DOM 反映结果，若停滞则有限重载续读。空中间页可推进到下一页，API 游标必须严格前进。只有有效的末页证据才能完成；保留部分结果和数量差异提示。

不要按「读取了很多本」或「达到某个预期数字」伪造结束。诊断仅输出结构与计数，禁止完整 Cookie、签名 URL、书名清单等私人数据。

## 长期运行与诊断

后台子进程与启动终端分离，stdout/stderr 重定向到每次启动的文件。结构化日志每分钟记录内存和队列数量，约 2 MiB 后保留一份轮换文件。致命异常用 `uncaughtExceptionMonitor` 记录，不吞掉 Node 默认终止。

诊断失败不应制造二次崩溃。原始 stderr 不保证完全脱敏。没有日志证据时，只能确认服务退出，不能把内存不足、外部强杀或终端关闭写成确定根因。后台运行不能抵御关机、休眠、外部强杀，也没有无限重启机制。

## 验证与安全操作

先运行 README 中的本地测试。核心测试通过只能证明内部逻辑；真实站点选择器、账号额度和 CDN 状态需要另行受控验证，不得对外宣称永久可用。

涉及真实资源的测试必须有明确授权，先检查是否有正在运行的任务。生产服务和已验证浏览器不要被展示测试随意重启。独立 fixture 使用临时目录，不触碰 `.data/live`。

`scripts/verify-live-download.mjs` 会下载选定真实任务并写回原记录，不是只读测试。`scripts/verify-live-booklist.mjs` 会使用独立站点会话；按脚本要求避免与现有服务抢占 profile。不要把这些脚本放进自动 CI。

发布包通过允许清单生成，旧本机交接记录不进入公开源码。移除工作区文件不等于抹除 Git 历史，首次公开遵循 [RELEASING.md](RELEASING.md)。
