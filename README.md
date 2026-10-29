# title-style

为 Paseo 会话（workspace）自动生成标题的插件：用设置页里可自定义的提示词调用模型，重命名侧边栏标题。默认生成简体中文标题，不局限于中文。

![Title Style Sidebar](https://raw.githubusercontent.com/zwmmm/title-style/main/assets/title-style-sidebar.png)

Paseo 内置的自动命名输出英文且没有全局语言配置。本插件在后台监听新会话的第一个 agent，用「元数据生成」配置的模型生成标题并覆盖，对整个 daemon 全局生效，包括非 git 目录。

## Install

```bash
paseo plugin add zwmmm/title-style
```

需要 Paseo ≥ 0.8.0，并且已开启插件（Settings → Plugins → Enable plugins，或 `~/.paseo/config.json` 中 `"pluginsEnabled": true`）。

## 设置

Settings → Plugins → title-style → 打开「设置」（界面语言跟随系统语言，中文/英文），修改后自动保存：

![Title Style Settings](https://raw.githubusercontent.com/zwmmm/title-style/main/assets/title-style-settings.png)

| 设置项 | 说明 |
| --- | --- |
| 提示词 | 生成标题的提示词，可以指定任何语言或风格 |
| 模型覆盖 | 留空时跟随 Settings → Host → Metadata 的模型配置；填 `provider/model` 可覆盖 |

默认提示词：

> 用简体中文生成一个简短的任务型标题（不超过 30 个字）：请求的操作 + 具体对象 + 关键标识符。直接输出标题文本，不要解释、引号或前后缀。

改坏了想恢复默认，把上面的文案粘回去即可。临时停用插件用插件列表的启停按钮。

## 工作方式

- 监听 `agent.created`：每个新会话的顶层 agent 创建后异步执行（子代理与委派代理不触发）
- 从首条 prompt 提取素材（最多 600 字符），调用模型返回 `{"title": "…"}`
- 通过 `setTitle` 写入 workspace 标题；Paseo 内置的英文命名结果会被覆盖，且不会反向覆盖本插件的标题
- 归属由 `~/.paseo/plugin-data/title-style/ownership.json` 记录：插件自己起过名的 workspace 会在每个新会话里更新标题；一旦标题不再是插件上次写的那个值（你手动改过），该 workspace 永久交给用户，不再碰
- 生成用的临时 agent 以委托子代理（delegated subagent）身份运行，完成后自动归档，全程静默，不产生应用内或推送通知

## Limitations

- 标题随每个新会话迭代更新，只反映最新一次会话
- 插件第一次遇到时已经有名字的 workspace（包括装插件之前就命名的、你手动起的）一律不动；只有无标题或「本会话刚创建、10 分钟以内」的 workspace 才会被接管
- 插件自己起过名的 workspace 里，如果你在标题生成的那几秒里手动改名，这一次仍可能被覆盖（Paseo 没有「标题由谁写入」的字段，无法区分内置命名与手动修改）
- 删除 `ownership.json` 等于把所有 workspace 重置为「无记录」状态
- 子代理、以及其他插件派生的 agent（标签里带 `*-agent-id`，如 `paseo.parent-agent-id`）不触发改名；定时任务会话（`paseo.schedule-*`）算真实会话，会改名
- 生成期间会话的第一个 agent 下会短暂出现一个名为「会话标题生成」的子代理，完成后自动归档
- 只处理会话标题；commit message 与 PR 文本的生成不受影响
- 每个新会话一次真实模型调用，按元数据生成所配模型的用量计费
