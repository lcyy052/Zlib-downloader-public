# 第三方依赖说明

本项目源码使用 MIT 许可证，依赖与外部服务的授权分别处理。

- **playwright-core**：由 Microsoft 及贡献者维护，Apache-2.0。依赖版本以 package-lock.json 为准。源码：[microsoft/playwright](https://github.com/microsoft/playwright)，许可证随 npm 安装保存在 node_modules/playwright-core/LICENSE，附带 NOTICE 应原样保留。本发布包不包含 node_modules。
- **Node.js**：用户自行安装，适用 Node.js 自身及其组成部分的许可证；本包不包含运行时。
- **Chrome / Edge**：用户自行安装，适用各浏览器自身的条款；本包不包含浏览器或用户资料。
- **GitHub Actions**：工作流引用官方 actions/checkout 和 actions/setup-node。项目不复制或重新授权这些工具。
- **Z-Library**：第三方网站，不是项目依赖包，也未授权本项目代表其官方身份。网站页面、电子书、封面和商标不因本项目的 MIT 许可证而获得使用授权。

公开应用截图使用本地模拟数据，示例不会提供第三方电子书文件。新增第三方代码、素材或打包依赖时，需要补充来源、许可证及其要求的声明；不能只添加一段免责说明。
