# dsh-alert-watcher

给 DeepSeek Harness（DSH）配一个**外部**提醒器：DSH 在跑的时候，下面三种情况会主动来找你——邮件 + 桌面通知 + 一份待处理清单。

1. **断网**（以及网络恢复时）：告诉你有哪几个会话当时在跑，需要回去补一句。
2. **有会话在等你决策**：向你提问、请你确认方案、等你批准权限，这些都在等你拍板。
3. **有改动需要重启 DSH 才生效**：环境变量、插件配置改了以后，当前进程读不到。

它是个独立的本地进程（不是 DSH 插件），所以 DSH 关掉、卡住、正在重启时它照样盯着；代价是要自己装 Node 和桌面版 Outlook。

## 前置条件

- Windows 10 / 11
- Node.js 20 以上（实测 22 通过）
- 已安装 DeepSeek Harness，DSH_HOME 默认在 `%USERPROFILE%\.dsh`
- **想收邮件**：本机装有桌面版 Outlook，且里面已经配好邮箱账户（脚本走 Outlook COM 发信，不需要密码）
- 没有 Outlook 也能用：把 `过程文件\config.json` 里的 `mail.enabled` 改成 `false`，只留桌面通知

## 快速开始

1. 把仓库下载或克隆到任意目录（别放在 `C:\Program Files` 这类需要管理员权限的地方）。
2. 打开 `过程文件\config.json`，把 `mail.to` 和 `mail.from` 改成你自己的邮箱地址。
3. 双击 **立即测试提醒.cmd** —— 邮箱收到信、桌面弹出通知，就说明通道通了。
4. 双击 **启动提醒.cmd**；想让它开机自动盯着，再跑一次 `过程文件\register-task.ps1`（注册计划任务 DSH-Alert-Watcher，登录时启动、并每 15 分钟巡检补拉）。

> 计划任务的动作走 `过程文件\run-hidden.exe`（无控制台启动器），所以每 15 分钟的巡检**不会闪黑窗**。这个 exe 首次注册时由 `register-task.ps1` 用 `RunHidden.cs` 现编译（找不到 csc 时退回 powershell 方式，能跑，但每次巡检会闪一下）。**不要把任务动作改回 `powershell.exe -WindowStyle Hidden`** —— 挡不住闪窗。

平时的入口就四个：`启动提醒.cmd`、`停止提醒.cmd`、`立即测试提醒.cmd`、`查看状态.cmd`。

> 注：`.cmd` 启动器是 GBK 编码（中文 Windows 控制台需要），在 GitHub 网页上预览可能显示成乱码，属正常现象；`.md`、`.mjs`、`.json` 都是 UTF-8。

## 配置项

都在 `过程文件\config.json`：

- `pollSeconds` 探测间隔，默认 10 秒
- `activeWindowMinutes` 断网时回溯多少分钟内的活跃会话
- `offlineAfterFailures` 连续探测失败几次算断网
- `renotifyMinutes` 断网期间重复提醒的间隔
- `remindAgainMinutes` 同一件决策没人处理时，多久再提醒一次
- `restartCheckSeconds` 检查「需不需要重启」的间隔
- `restartRemindMinutes` 需要重启这一类重复提醒的间隔
- `probe` 探活目标（默认 `api.deepseek.com:443`）
- `mail.to` / `mail.from` 收件人与发信账户；`mail.enabled` 邮件总开关
- `toast.enabled` 桌面通知开关

## 它怎么判断

- **断网**：每 `pollSeconds` 秒对 `api.deepseek.com:443` 建一次 TCP 连接，连续失败到阈值即判定断网；恢复时再提醒一次。
- **在等你决策**：先读 DSH 自己的会话投影缓存（`~/.dsh/storages/session_projcache/sessions/*.json`）筛出「轮次或步骤没闭合」的会话，再解它的会话日志（`~/.dsh/sessions/<工作区>/<会话>/session.v3.jsonl.zstd`，逐帧 zstd），看有没有**挂着不返回结果**的工具调用——挂起的正好是 `ask_user_question` / `exit_plan_mode` 就是在等你回答或确认，存在未配对的权限批准请求就是在等你批准。正在跑工具、模型正在生成，都不会打扰你。
- **子代理会话不提醒**：助手派出去干活的子会话（投影缓存里带 `subagent` 行的那些）一律跳过——它的标题就是派活时的那段提示词原文，你既认不出也点不进去，真有事由它的父会话出面提醒。
- **哪些会话算「当时在跑」**：有未闭合的步骤且一小时内写过日志、或十分钟内有动作、或确实在等你（提问/批准）。中途被杀掉的会话（轮次记录没闭合、日志几天没动）不算活跃，不会每次断网都被翻出来提醒。
- **需重启 DSH**：比对用户级环境变量（只存哈希，不存值）与插件配置文件的改动时间，是否晚于当前 DSH 主进程的启动时间；另外助手可以在 `过程文件\需要重启DSH.txt` 里留一句说明，DSH 重启后这条自动失效。

## 隐私与数据

- 它**只读**本机 DSH 自己的数据文件（会话投影缓存与会话日志），用来判断状态；**不联网上传任何内容**。
- 唯一的对外通信是：把提醒内容通过**本机 Outlook** 发到你自己配置的邮箱；桌面通知走 Windows 本机。
- 仓库里不含任何个人配置：`config.json` 里的邮箱是占位符；日志、状态、待处理清单、待发队列都在 `.gitignore` 里，不会被提交。
- 环境变量快照只记录「名字 → 值的哈希」，不落盘明文值。

## 目录结构

```
启动提醒.cmd 停止提醒.cmd 立即测试提醒.cmd 查看状态.cmd   四个入口
说明.md                                                  中文说明（本机使用视角）
快速迁移提示词.md                                         丢给 AI 助手照着装的提示词
过程文件/
  dsh-alert.mjs      常驻监测主程序（Node）
  decode-session.mjs 逐帧解 zstd 会话日志
  notify-mail.ps1    走 Outlook COM 发信（含重试与待发队列）
  notify-toast.ps1   桌面通知
  check-restart.ps1  判断「需不需要重启 DSH」
  start/stop-watcher.ps1  启停监测进程
  status.ps1         查看状态
  register-task.ps1  注册开机自启计划任务（用无控制台启动器，不闪黑窗）
  RunHidden.cs       启动器源码（首次注册时编译成 run-hidden.exe）
  config.json        配置
  logs/ state.json watcher.json  运行期产物（不入库）
```

## 许可

MIT，见 `LICENSE`。用得着就拿去改，出问题欢迎提 issue。
