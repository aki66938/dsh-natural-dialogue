# 设计参考

## MaiBot

早期版本的默认文案及回复布局参考以下来源，历史归属保留在此：

- 项目：https://github.com/Mai-with-u/MaiBot
- 版本：`062d45cf8bd4272ac57d7ec03fcf405e5a458211`
- 文件：`src/config/official_configs.py` 的 BotConfig / PersonalityConfig
- 回复约束：`lib/reply.js` 参考 `prompts/zh-CN/maisaka_replyer.prompt`、私聊简短回复要求，并添加 DSH 的工具与完整任务输出适配。
- 消息排列及简短表达要求参考 `src/chat/replyer/maisaka_generator_base.py` 的 `_build_request_messages`、`_build_requested_reply_style_message`，适配为真实聊天轮次和独立参考消息。
- 作者：MaiBot contributors
- 上游许可证：GNU General Public License version 3，见本项目 LICENSE

当前版本已独立改写默认角色提示词与回复要求；历史参考关系不因改写而删除。运行逻辑为本项目编写的 DSH 适配实现，项目继续采用 GPL-3.0-only。
