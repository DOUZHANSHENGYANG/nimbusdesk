# 定时任务：一句话生成

新建 / 编辑任务时，顶部多了一块「用一句话生成」：

1. 输入一句人话，例如「每个工作日早上 9 点，把昨天合入的 PR 整理成晨报」；
2. 点「AI 生成」，模型把这句话翻译成任务配置；
3. 生成结果直接落到已有的名称 / 频率 / 动作 / 自定义指令字段，**仍可手改**，
   保存前照样走原来的校验。

实现只复用现有能力：`chatWithProvider` 发一次普通对话请求，`parseTaskJson` 取最外层
JSON，再按 `schedule/actions.rs` 里登记的动作与字段收窄参数；没有新增后端命令，
也没有让模型直接写任务。

- 提示词要求只输出 JSON；模型偶尔包 ```json 围栏或加解释也能解析。
- 没提时间默认 09:00；没提动作默认「AI 提示词」；`instruction` 为空时回落到用户原话。
- 未配置 AI 服务商时按钮会给出错误，不影响手动填写。

截图：`docs/screenshots/schedule-ai.png`。

夹具：`src/features/schedule/fixtures/editor.html`（mock `schedule_snapshot`、`ai_chat`），
`node scripts/shot-schedule-ai.mjs` 会断言生成后的任务名与频率文本。
