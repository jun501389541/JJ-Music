# JJ Music

**面向 Windows 的桌面音乐播放器，支持本地曲库、在线音乐、歌词、音质选择下载和跨平台歌单导入。**

当前版本：**0.1.6** · Windows x64 · Electron / Vue 3 / TypeScript

## 下载

前往 [Releases](https://github.com/jun501389541/JJ-Music/releases) 获取发行版本：

- [Windows 安装版](https://github.com/jun501389541/JJ-Music/releases/download/v0.1.6/JJ-Music-0.1.6-Setup-x64.exe)：按向导安装。
- [Windows 免安装版 ZIP](https://github.com/jun501389541/JJ-Music/releases/download/v0.1.6/JJ-Music-0.1.6-Portable-x64.zip)：完整解压后运行 JJ Music.exe，保留全部文件。
- [SHA-256 校验文件](https://github.com/jun501389541/JJ-Music/releases/download/v0.1.6/SHA256SUMS.txt)。

运行发行版无需安装 Node.js。更新前请先退出旧版；安装版和免安装版默认共用当前用户的配置。

0.1.1 至 0.1.5 的 Windows 包在部分电脑上无法启动音源（在线播放随之失效），请使用 0.1.6。

## 功能

| 功能 | 说明 |
| --- | --- |
| 本地曲库 | 文件夹扫描、增量索引、歌曲 / 曲风 / 专辑 / 艺术家分类与数量 |
| 发现音乐 | 最近播放、曲库概览 |
| 全局搜索 | 本地结果优先，支持 QQ、网易云、酷狗、酷我、咪咕在线搜索 |
| 播放界面 | 封面、歌词、频谱、播放列表、EQ、播放速度、睡眠定时 |
| 音源管理 | 导入 LX Music 自定义音源协议兼容脚本；自动抽测平台状态 |
| 在线下载 | 选择音源支持的音质、批量下载、进度、取消、失败重试、同名文件保护 |
| 歌词与标签 | LRC 保存，MP3 / FLAC 嵌入歌词及封面，包含平台提供的翻译和罗马音 |
| 歌单导入 | 网易云、QQ、酷狗、酷我公开网页版歌单链接或 ID；预览后保存为新歌单 |
| 个性化 | 深浅主题、强调色、歌词外观、列表密度、快捷键与多级菜单 |

## 开始使用

1. 在“音乐库”添加音乐文件夹，扫描本地歌曲。
2. 在“音源管理”导入可信的 .js 脚本或兼容的 user_api.json，启用后查看平台验证状态。
3. 在“全局搜索”查找歌曲。在线歌曲右键 → 下载歌曲 → 选择音质。
4. 在“设置 → 下载”选择目录，设置 LRC、嵌入歌词、翻译、罗马音和封面。
5. 在“导入歌单”选择平台，粘贴公开歌单链接或 ID，读取预览后保存。

平台“抽测通过”只代表本次样本可用，不保证所有歌曲都能播放或下载。项目不随包分发第三方音源脚本或音乐文件；第三方脚本具有当前用户的文件和网络访问能力，请使用可信来源。

## 从源码运行

使用 Node.js 24、npm 和 Windows x64。

    git clone https://github.com/jun501389541/JJ-Music.git
    cd JJ-Music
    npm ci
    npm run dev

开发与验证命令：

    npm run verify      # 类型检查、生产构建、离线测试
    npm run test:e2e    # 真实 Electron 播放验证，需要可用本地曲库
    npm run pack        # release/win-unpacked 完整免安装目录
    npm run dist        # Setup EXE + Portable ZIP

打包输出：

    release/
      JJ-Music-0.1.6-Setup-x64.exe
      JJ-Music-0.1.6-Portable-x64.zip
      SHA256SUMS.txt
      win-unpacked/

npm 缓存放在 `.cache`。Electron 与打包工具的二进制镜像改为通过环境变量配置（`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`），不再写入 `.npmrc`，因此默认从 GitHub Releases 获取；下载不通时按上面的变量指定镜像即可。打包脚本会先重新构建源码，并清除测试环境开关。

## 数据与限制

- 用户数据默认位于 %APPDATA%/jj-music。免安装指无需安装，不代表默认把配置存入程序目录。
- 支持 Chromium 可解码的 MP3、FLAC、M4A、AAC、OGG、Opus、WAV；APE、DSD、WMA 暂不支持播放。
- 标签嵌入支持 MP3 / FLAC；其他下载格式保留音频并提示限制。
- 内置在线歌词查询覆盖 QQ、网易云、酷我、咪咕；翻译与罗马音取决于平台返回内容。
- 下载不支持断点续传，重试从头开始；同时运行两个任务，每批最多 500 首，单文件最大 1 GB。
- 歌单导入保存本地快照，不自动同步。每次最多读取 5000 首，私密歌单、短链接或平台访问限制可能导致无法完整读取。
- 在线能力依赖外部平台和用户提供的音源，接口变化可能影响可用性。

## 文档与反馈

- [更新日志](CHANGELOG.md)
- [架构说明](docs/ARCHITECTURE.md)
- [下载与歌单导入](docs/DOWNLOADS_AND_PLAYLIST_IMPORT.md)
- [0.1.1 审阅与验证记录](docs/FINAL_REVIEW_0.1.1.md)
- [提交问题](https://github.com/jun501389541/JJ-Music/issues)

0.1.1 发布前通过 14 个测试套件、30 项播放端到端检查及 40 项实际打包程序检查。验证范围与已知边界详见审阅记录。

## 致谢与许可

界面设计参考 Salt Player for Windows；音源兼容性参考 [LX Music](https://github.com/lyswhut/lx-music-desktop) 的公开自定义音源协议。参考软件、第三方脚本与个人音乐数据均不包含在仓库或发行包内。

项目采用 [MIT License](LICENSE)。使用在线内容时，请遵守内容提供方的使用条件及适用规则。
