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

### 方式一：直接下载 exe（推荐）

到 [Releases](https://github.com/iownmmiku/astrbot-desktop-pet/releases) 下载
`AstrBotDesktopPet-x.y.z-portable.exe`，**双击即用，无需安装 Node.js**（便携版，约 74MB）。

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

## 操作方式

| 操作 | 效果 |
|---|---|
| 按住拖动 | 移动桌宠 |
| 单击 | 互动（随机动作/表情 + 戳一戳） |
| 双击 | 打开聊天框（回车发送，Esc 关闭） |
| 右键 | 显示/隐藏状态面板（心情/饱食/清洁/精力/等级） |
| 双击右上角圆点 | 打开设置面板 |
| 系统托盘 | 聊天 / 投喂 / 摸头 / 洗澡 / 睡觉 / 鼠标穿透 / 更换模型 / 退出 |

## 设置面板

- **插件服务器**：`127.0.0.1:9898` 或任意远程地址（含 `wss://` 加密）
- **连接令牌**：与插件 `auth_token` 一致
- **Live2D 模型**：任意 `.model3.json` 的本地路径或 URL（相对路径以 `src/` 为基准），
  例如 `D:/models/shizuku/shizuku.model3.json`
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
