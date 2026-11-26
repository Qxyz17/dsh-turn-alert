# dsh-turn-alert

[![npm](https://img.shields.io/npm/v/dsh-turn-alert)](https://www.npmjs.com/package/dsh-turn-alert)
[![license](https://img.shields.io/npm/l/dsh-turn-alert)](LICENSE)

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加桌面提醒：**任务跑完、任务出错、或者卡在等你回答**时，弹一条 Windows 系统通知，并播放 Windows 自带的提示音。

只在 Windows 上工作，不依赖任何第三方运行时或音频文件，用系统自带的 Windows PowerShell 投递。

## 提醒规则

| 时机 | 通知标题 | 提示音（Windows 方案音） |
| --- | --- | --- |
| 一轮任务正常结束 | `DSH · 任务完成` | Asterisk（“通知”） |
| 一轮任务异常结束 | `DSH · 任务异常`（附错误信息） | Hand（“关键停止”） |
| 需要你回答问题 | `DSH · 需要你的回答`（附问题正文） | Exclamation（“感叹号”） |
| 等待工具授权 | `DSH · 等待你的授权`（附工具名） | Exclamation |

行为细节：

- 只提醒整段对话（root agent），子代理、后台任务不会刷屏。
- 一轮结束后等 1.2 秒再发，连续多轮会合并成一条。
- 你手动点“停止”中断的回合默认不响，只在你离开时提醒真正结束的任务。
- 通知正文带会话标题，一眼能看出是哪个会话跑完了。

## 安装

在 DSH 窗口左侧打开「插件」→「添加插件」，输入包名：

```
dsh-turn-alert
```

还没上架 npm 时，可以用 Git 地址安装：

```
https://github.com/Qxyz17/dsh-turn-alert
```

也可以用本地目录（克隆后填绝对路径）。安装后自动启用，无需重启。

## 配置

「插件」页里打开本插件即可改配置；也可以直接写进 profile 的 patch：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `onCompleted` | `true` | 正常结束时提醒 |
| `onError` | `true` | 异常结束时提醒 |
| `onQuestion` | `true` | 需要你回答时提醒 |
| `onApproval` | `true` | 等待工具授权时提醒 |
| `onInterrupted` | `false` | 用户点“停止”的回合也提醒 |
| `sound` | `true` | 播放系统提示音 |
| `includeSubagents` | `false` | 子代理也提醒（默认只提醒整段对话） |
| `settleMs` | `1200` | 回合结束后的合并等待时间 |

## 它是怎么响的

- 通知走 Windows 系统通知 API（WinRT `ToastNotificationManager`），以 DeepSeek Harness 自己的 AppUserModelID 投递，所以通知中心里显示的是应用名和图标，而不是 “Windows PowerShell”。AUMID 从开始菜单自动探测，探不到时退回托盘气泡通知。
- 声音用 `System.Media.SystemSounds` 播放系统方案音，不附带任何音频文件。
- 每次通知由一个短命的 Windows PowerShell 进程投递（约 1 秒），不占用 DSH 主进程。

## 排错

- **只听到声音、没有横幅**：检查 设置 → 系统 → 通知 → DeepSeek Harness 是否允许横幅，以及“专注助手 / 免打扰”是否开着。通知通常已经进了通知中心。
- **完全没有声音**：控制面板 → 声音 → 声音方案 不能是“无声”。
- **插件没生效**：确认「插件」页里 `dsh-turn-alert` 这一行是开启状态。

## English

Windows desktop alerts for DeepSeek Harness: a system notification plus the matching built-in Windows sound when a turn completes, fails, or waits for your answer. Toast notifications are posted as the DeepSeek Harness app (with a tray-balloon fallback), and no sound files are bundled — the OS scheme provides them.

## 开发与发布

纯 JS，没有构建步骤：

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：订阅回合结束、错误、提问三类事件 |
| `notify.ps1` | Windows 投递脚本：WinRT toast + 系统提示音，失败退回托盘气泡 |
| `cordis.patch.yml` | 插件行与默认配置 |

发布：打 `v*` tag 推上去，GitHub Actions 会用仓库里的 `NPM_TOKEN` secret 发布到 npm（也可以在本地登录后直接 `npm publish`）。

## License

MIT
