# AstrBot 桌宠桌面端 🖥️🐾

参考 Steam《虚拟桌宠模拟器》的桌面宠物应用：透明无边框、置顶、可鼠标穿透的 Live2D 桌宠，
与 **[AstrBot 桌宠插件](https://github.com/iownmmiku/astrbot_plugin_desktop_pet)** 联动，
聊天由 AstrBot 配置的大模型驱动。

![技术栈](https://img.shields.io/badge/Electron-33-blue) ![渲染](https://img.shields.io/badge/Live2D-pixi--live2d--display-pink)

## 两个软件如何联动

```
┌────────────────────────────┐        WebSocket / HTTP         ┌─────────────────────────────┐
│   桌面端（本仓库，Electron）│  ◄──────────────────────────►  │  AstrBot 插件（Python/aiohttp）│
│                            │                                 │                             │
│  · 渲染 Live2D 模型         │   下行：speak 说话 / state 状态 │  · LLM 聊天（人格可配）        │
│  · 拖拽/点击/双击聊天       │        hello(含行为配置)        │  · 状态养成（心情/饱食/…）     │
│  · 气泡聊天 / 状态条        │        config 行为配置变更      │  · 行为配置统一持有+广播       │
│  · 随机走动/自言自语/犯困   │   上行：POST /api/chat 聊天     │  · 同步 AstrBot 各平台回复     │
│  · 设置面板（可回写配置）   │        POST /api/action 互动    │    到桌宠气泡                  │
│                            │        POST /api/config 回写    │                             │
└────────────────────────────┘                                 └─────────────────────────────┘
        ▲ 桌面端设置面板改行为配置 ──回写插件──► 插件广播 ──► 所有已连接桌面端实时生效（自动同步）
```

- 插件启动后在 `ws_host:ws_port`（默认 `127.0.0.1:9898`）监听；桌面端通过设置面板填入地址即可连接，
  **支持远程服务器**（`host:port`、`http(s)://…`、`ws(s)://…` 均可；远程时插件 `ws_host` 设为 `0.0.0.0`
  并建议配置 `auth_token`，桌面端填相同令牌）。
- 桌面端的聊天、投喂、抚摸等互动都调用插件 API；插件返回/广播的内容实时显示为桌宠气泡与状态条。
- 行为配置（自言自语台词池/频率、走速、犯困阈值、自由走动）由插件统一持有：桌面端连上自动同步，
  在任何一端修改都会回写插件并广播给所有客户端；离线时桌面端用本地缓存作为回退。

## 运行

### 方式一：下载分体压缩包（推荐）

到 [Releases](https://github.com/iownmmiku/astrbot-desktop-pet/releases) 下载
`AstrBotDesktopPet-x.y.z-win-x64.zip`，解压后运行其中的 exe 即可（无需安装 Node.js）。

**分体结构**：exe 只是启动器；用户数据存在系统用户目录，升级/替换 exe 不会丢失——

```
AstrBotDesktopPet-x.y.z-portable.exe   ← 启动器（可随时换新）
data/models/Haru/                      ← 随包发布的默认模型（只读资源）
%APPDATA%/astrbot-desktop-pet/         ← 用户数据（升级 exe 不受影响）
├── settings.json                      ← 全部设置
└── models/<你解压的模型包>/            ← 控制面板选择 .wpk/.zip 后自动解压到这里
```

exe 旁的 `data/models/` 里也可以自行添加模型文件夹；解压的模型包和设置都在用户目录，换版本不用重新填写。

### 方式二：源码运行

```bash
git clone https://github.com/iownmmiku/astrbot-desktop-pet.git
cd astrbot-desktop-pet
npm install
npm start
```

### 自己构建 exe

```bash
npm install
npm run build:win   # 输出到 dist/AstrBotDesktopPet-x.y.z-portable.exe
```

> 仓库已附带 Cubism 官方示例模型 Haru（`models/Haru`）与 Cubism Core 运行时（`vendor/`），
> 开箱即用；换模型见下文。

## 应用结构（v0.2.0 起为完整桌面应用）

启动后有两部分：

1. **控制面板窗口**：集中配置一切——插件服务器/令牌、Live2D 模型与缩放、桌宠状态查看与互动
  （投喂/摸头/洗澡/睡觉）、行为配置（与插件自动同步）。
2. **桌宠窗口**：透明无边框置顶的 Live2D 桌宠。

**关闭行为**：点击控制面板的关闭按钮时会询问「最小化到托盘 / 退出程序」（可记住选择）。
只要程序没有彻底退出，桌宠就会一直待在桌面上；桌宠窗口本身无法被单独关闭。
彻底退出只能通过关闭对话框选「退出程序」或托盘菜单「退出程序」。

设置由主进程统一持久化（`userData/settings.json`），控制面板修改后桌宠实时生效。

## 桌宠窗口操作

| 操作 | 效果 |
|---|---|
| 按住拖动 | 移动桌宠 |
| 单击 | 互动（随机动作/表情 + 戳一戳） |
| 双击 | 打开聊天框（回车发送，Esc 关闭） |
| 右键 | 显示/隐藏状态面板（心情/饱食/清洁/精力/等级） |
| 双击右上角圆点 | 打开控制面板 |
| 系统托盘 | 控制面板 / 聊天 / 投喂 / 摸头 / 洗澡 / 睡觉 / 鼠标穿透 / 退出程序 |

## 控制面板配置项

- **插件连接**：服务器地址（`127.0.0.1:9898` 或任意远程地址，含 `wss://` 加密）、连接令牌、测试连接
- **形象**：任意 `.model3.json` 的本地路径或 URL（相对路径以应用内 `src/` 为基准），缩放 0.5–2x；
  「选择模型 / 模型包」按钮可直接选用 `.model3.json`，或选择 **.wpk**（VPet《虚拟桌宠模拟器》创意工坊模型包）/ `.zip`
  ——会自动解压到应用数据目录并定位其中的 Live2D 模型，一键换装
- **桌宠状态**：状态条实时查看，一键投喂/摸头/洗澡/睡觉
- **行为配置**：自由走动 / 走速 / 犯困阈值 / 自言自语开关·间隔·台词池 / 犯困台词池
  （保存时回写插件并广播给所有客户端）

## 插件侧

插件仓库：<https://github.com/iownmmiku/astrbot_plugin_desktop_pet>
安装后在 AstrBot WebUI 插件页启用，聊天指令：`/桌宠`（状态）、`/投喂`。

## 通信协议

| 端点 | 说明 |
|---|---|
| `GET /ws?token=` | WebSocket；下行 `hello`（含行为配置）/ `speak` / `state` / `config` |
| `GET /api/state` | 当前桌宠状态 |
| `GET/POST /api/config` | 行为配置读取/回写（回写后广播） |
| `POST /api/chat` | `{text}` → `{reply, state}`（LLM 驱动） |
| `POST /api/action` | `{action: feed\|clean\|play\|sleep\|poke}` → `{reply, state}` |

token 通过 query `?token=` 或请求头 `X-Pet-Token` 校验；API 已开启 CORS。
