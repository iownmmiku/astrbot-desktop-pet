# AstrBot 桌宠桌面端 🐾

> **0.8.1** 新增桌宠快聊、草稿连接检测、互动倒计时、聊天阅读优化、启动与全屏陪伴、手动更新检查。建议同时升级插件到 **0.5.1**；使用方法与平台限制见 [0.8.1 发行说明](docs/RELEASE_0.8.1.md)。

透明置顶的 Electron + Live2D 桌宠，与 [AstrBot 桌宠插件](https://github.com/iownmmiku/astrbot_plugin_desktop_pet)联动。聊天使用 AstrBot 配置的模型和人格，养成状态由插件统一保存，桌面端负责形象、气泡、互动和控制台。

当前桌面端版本 **0.8.1**，配套插件版本 **0.5.1**。

[下载 Windows 发行版](https://github.com/iownmmiku/astrbot-desktop-pet/releases/latest) · [更新记录](CHANGELOG.md) · [接口协议](docs/PROTOCOL.md) · [本版验证记录](docs/VALIDATION_0.5.1_0.8.1.md)

## 开始使用

1. 在 AstrBot WebUI 的插件页安装 [astrbot_plugin_desktop_pet](https://github.com/iownmmiku/astrbot_plugin_desktop_pet)，启用插件并配置可用的聊天模型。
2. 从 [Releases](https://github.com/iownmmiku/astrbot-desktop-pet/releases) 下载 `AstrBotDesktopPet-0.8.1-win-x64.exe`，运行便携程序，无需安装 Node.js。
3. 在控制台的「连接设置」填写插件地址。本机默认 `127.0.0.1:9898`；插件设置了 `auth_token` 时，填入相同令牌。可先「测试当前填写内容」，再点击「保存并连接」。
4. 使用默认 Haru 示例模型，或在「形象与窗口」选择自己的 `.model3.json`。

关闭控制台会保留桌宠和系统托盘。通过托盘或控制台的「退出桌宠」彻底退出；`Ctrl+Alt+P` 可重新打开控制台。

Windows 便携包面向 **Windows x64**，未使用代码签名证书。

## 可以做什么

- **聊天与人格**：支持插件自定义人格、AstrBot 已配置人格及默认人格；聊天回复同步到气泡。
- **桌宠快聊**：双击桌宠打开小窗，收起后保留本次运行中的草稿；控制台与快聊支持复制消息、上翻保持位置和新消息提示。
- **状态养成**：查看心情、饱食、清洁、精力和经验等级，进行投喂、摸头、洗澡、睡觉、唤醒和戳一戳。
- **互动反馈**：显示处理中与冷却倒计时，多端同步；请求失败保留具体原因。
- **持续睡眠**：睡着后停止漫游，精力由插件逐渐恢复；可手动唤醒，满精力时自动醒来。
- **形象与窗口**：本地 Live2D 模型、0.5–2× 缩放、置顶、鼠标穿透、拖动和自由走动。缩放同时调整窗口与画布，屏幕放不下时适配工作区。
- **气泡队列**：连续回复依次显示，主动聊天优先；悬停可暂停消失，有待读消息时可切换下一条。
- **安静陪伴**：免打扰和「安静一小时」抑制自言自语及平台推送气泡，主动聊天和互动仍正常回应。
- **启动与专注**：可设置登录时启动、启动时收起控制台，以及 Windows 全屏期间自动安静；开发环境不会写系统启动项。
- **多端同步**：行为、人格和台词池由插件持有，在桌面端保存后同步到其他连接端。
- **连接恢复**：单一主进程维护 HTTP/WebSocket，断线自动退避重连，令牌错误单独提示。
- **请求恢复**：按插件公布的时限等待；聊天超时后可「检查结果」或使用原 ID「重试原请求」，HTTP 与实时推送按 ID 去重。
- **手动更新**：在「启动与更新」分别检查两端发行版，再自行打开发行页下载；不会自动下载或安装。

本版本没有事件记忆、持久聊天历史、语音输入或语音合成。聊天上下文仅在插件内存中保留，插件重启后清空。

## 桌面操作

| 操作 | 效果 |
| --- | --- |
| 拖动桌宠 | 移动窗口，位置自动保存 |
| 单击桌宠 | 戳一戳；模型具备对应动作时播放动作 |
| 双击桌宠 | 打开快聊小窗 |
| 右键桌宠 | 打开控制台 |
| 桌宠旁的花朵按钮 | 打开控制台 |
| `Ctrl+Alt+P` | 找回控制台 |
| 托盘菜单 | 打开控制台、找回桌宠、互动、切换穿透/免打扰、退出 |

快聊支持 `Enter` 发送、`Shift+Enter` 换行、`Esc` 收起；收起后保留本次运行中的草稿，可通过右上角「⋯」进入完整控制台。

第三方模型不一定提供睡眠、走动或互动动作组；只有模型包含匹配动作时才调用对应动画。

## 更换模型

在「形象与窗口」点击「选择模型文件」，选择完整模型文件夹中的 `.model3.json`。模型包应先解压，并保留 `.moc3`、贴图、动作、表情和其他资源的相对位置。本版不自动解包 `.wpk`，也不直接加载远程模型 URL。

随包提供 Haru 模型与本地运行库，启动时无需从 CDN 下载脚本。模型加载失败时使用内置小猫回退，并显示原因；也可点击「恢复默认形象」。

## 连接远程 AstrBot

插件的 `ws_host` 改为 `0.0.0.0`，配置非空 `auth_token`，桌面端填写服务器可访问地址和相同令牌。公网连接使用 HTTPS/WSS 反向代理；插件本身直接提供 HTTP/WS。

支持以下地址形式：

```text
127.0.0.1:9898
http://192.168.1.10:9898
https://example.com/pet
wss://example.com/pet/ws
```

使用路径前缀时，反向代理须同时转发前缀下的 `/api/*` 和 `/ws`，并在转发给插件时去掉前缀。连接令牌填写在单独的令牌栏，桌面端通过请求头发送。

更换服务器地址且令牌留空时，测试与保存都不会沿用旧服务器令牌，保存会清除旧令牌。同一地址留空保留；新服务器需要鉴权时请填写其对应令牌。

## 数据与重试边界

- 桌面设置保存在系统应用数据目录；Windows 默认是 `%APPDATA%/AstrBot 桌宠/settings.json`。令牌使用系统凭据加密，换系统账户后需要重新输入。
- 保存设置使用原子替换；旧版平铺设置首次保存前留备份，损坏 JSON 保留副本。替换程序不会主动清除应用数据。
- 养成状态、睡眠状态、互动冷却和行为覆盖配置保存在插件侧；桌面端本地没有第二份养成存档。
- 插件成功请求缓存保留最多 10 分钟、最多 128 条。重启、过期或逐出后查询可能为 `unknown`，不保证跨重启去重。客户端不会自动重发聊天或互动；结果不明时先检查原请求。
- 所有连接端共享同一桌宠及同一插件聊天上下文。桌面控制台「清空显示」只清本页显示。

## 源码运行与构建

推荐使用已验证的 **Node.js 24.18.0**。锁定依赖的引擎范围为 Node.js `^22.22.2`、`^24.15.0` 或 `>=26.0.0`；其他范围未作为本版开发环境验证。

```powershell
git clone https://github.com/iownmmiku/astrbot-desktop-pet.git
cd astrbot-desktop-pet
npm ci
npm start
```

`npm ci` 按 `package-lock.json` 安装依赖并下载 Electron 运行时。运行时、主进程依赖和模型资源均打包进发行版。

在 Windows 上构建：

```powershell
npm run build:win
# 输出：dist/AstrBotDesktopPet-0.8.1-win-x64.exe

npm run pack:win
# 输出：dist/win-unpacked/，用于检查解包后的应用
```

## 开发验证

```powershell
npm test
```

测试覆盖核心通信、控制台与快聊 DOM、主进程接线、连接诊断和系统功能适配。两项跨语言集成测试需要先启动配套插件的开发联调服务；未设置服务地址时跳过。计数以当前 `npm test` 输出为准。

将两个仓库放在同一父目录，可按以下方式重跑完整联调：

```powershell
# 从两个仓库的共同父目录执行
git clone https://github.com/iownmmiku/astrbot_plugin_desktop_pet.git
python -m venv .venv
.venv\Scripts\python -m pip install -r astrbot_plugin_desktop_pet\requirements.txt
.venv\Scripts\python astrbot_plugin_desktop_pet\tests\run_demo_server.py --port 19899

# 另一个终端，进入本仓库
cd astrbot-desktop-pet
$env:PET_INTEGRATION_URL = 'http://127.0.0.1:19899'
npm test
```

联调服务运行真实插件 HTTP/WebSocket，使用临时数据和模拟 LLM。0.8.1 的功能范围与验证边界见[发行说明](docs/RELEASE_0.8.1.md)；0.8.0 的 85 项两端验证基线保留在[历史验证记录](docs/VALIDATION.md)。真实 AstrBot 安装、用户模型账户、远程 TLS、不同显卡及第三方模型仍需在实际环境联调。

## 目录与第三方资源

```text
src/                 Electron 主进程、preload、控制台和桌宠界面
tests/               网络、窗口几何、气泡队列、DOM与联调回归
vendor/              本地 PixiJS、Cubism Core、Live2D显示库
models/Haru/         官方 Haru 示例模型
licenses/            第三方授权与声明副本
assets-manifest.json 预置资源来源和 SHA-256
docs/                通信协议与验证记录
```

组件和模型各自的授权见[第三方资源清单](THIRD_PARTY.md)、[授权文件目录](licenses/)及[资源来源记录](assets-manifest.json)。Live2D 运行库和示例模型的声明随仓库与发行版保留。

问题反馈：[桌面端 Issues](https://github.com/iownmmiku/astrbot-desktop-pet/issues)。插件配置、模型调用或服务端问题请同时注明[插件版本](https://github.com/iownmmiku/astrbot_plugin_desktop_pet)。
