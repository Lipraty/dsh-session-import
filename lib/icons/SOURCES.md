# Harness SVG 来源与权利说明

这些标识只用于在本地 Import 列表识别外部产品，不表示 DSH 与其有合作、赞助或官方授权。公开可下载不等于取得商标许可；下列开源代码许可也不替商标权人授予商标使用许可。若对外分发，应再次核对品牌使用条件并取得需要的许可。

获取日期：2026-10-15。仓库资源使用固定 commit URL，站点资源另保留原始 SVG 文件；客户端嵌入同一资源的 data URI，不在用户打开页面时请求第三方站点。

| 位置 | 实际标识 | 官方来源 | 说明 |
|---|---|---|---|
| omp | Oh My Pi 项目图标 | https://raw.githubusercontent.com/can1357/oh-my-pi/d0b56045fff4367a23d839bf8250d49c05486566/assets/icon.svg | 上游 MIT；原文件浅色图案不改色，以深色底衬显示。 |
| Claude Code | Claude 星芒品牌标识 | https://claude.ai/favicon.svg | 不是 Claude Code 专属吉祥物。网站资源无通用开源许可；Anthropic 商标指南要求特定许可及事先批准材料，未声称已取得此许可。图案未改形、未改色。 |
| Codex CLI | OpenAI 品牌 blossom | https://developers.openai.com/ | 从官方首页首个 `span[data-site-visibility-include="chatgpt-docs"] > svg` 提取，保留原路径，仅增加 SVG xmlns 使其可独立保存。不是专属 Codex logo。原始标记 currentColor，页面按单色遮罩跟随主题。 |
| OpenCode | OpenCode 项目图标 | https://raw.githubusercontent.com/anomalyco/opencode/81200db2a3a86fc72a60dff996557f59865a6f24/packages/console/app/src/asset/brand/opencode-logo-light-square.svg | 同目录 dark-square.svg 是官方深色版；上游 MIT，使用官方两版，不自行调色。品牌页：https://opencode.ai/brand |
| pi | 官方紧凑 badge | https://pi.dev/favicon.svg | https://pi.dev/press-kit 明确提供 compact badge。站点及仓库 MIT。原始 SVG 跟随系统深浅色；本地使用其轮廓作单色遮罩，跟随 DSH 选择的主题，避免系统与应用主题不一致。 |
| ZCode | 产品界面采用的 Z.AI 图标 | https://raw.githubusercontent.com/zai-org/ZCode/aac4755666d09fdcd70272fcf063c077a639015f/packages/ui/src/assets/provider-icons/logo-zai.svg | 不是独立 ZCode 专属 logo。官方 WindowsTopLeftLogo.tsx 使用该文件并以 ZCode 为 alt。上游 Apache-2.0；图标/商标仍可能有独立条件，原图未修改。 |

## 品牌与许可链接

- Anthropic：https://www.anthropic.com/legal/trademark-guidelines
- OpenAI：https://openai.com/brand/ （研究时返回 HTTP 403，未声称已完整核验当前条款；网站图案不受 Codex 仓库 Apache-2.0 自动覆盖。）
- Pi press kit：https://pi.dev/press-kit
- ZCode 使用位置：https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/packages/ui/src/WindowsTopLeftLogo.tsx
- ZCode 独立资源说明：https://github.com/zai-org/ZCode/blob/aac4755666d09fdcd70272fcf063c077a639015f/NOTICE.md

本目录保留 omp、OpenCode、pi 的 MIT 原文与 ZCode 的 Apache-2.0 原文。原始 SVG 不包含业务代码、脚本或外链加载。

注意：Codex 仓库的 `samples/openai-docs/assets/openai-small.svg` 实际为书本 UI 图标，未作为品牌 logo 使用。
