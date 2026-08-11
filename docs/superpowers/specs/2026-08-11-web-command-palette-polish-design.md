# Web Command Palette Polish Design

## Goal

修复 Web 命令提示面板在桌面端与触摸端的可读性、关闭边界和文本误选问题，同时校准头部动作间距，并消除登录卡在完整样式加载前从左上角跳到居中的首帧闪动。

## Confirmed causes

- 命令面板仅由输入值、Esc 和命令选择控制，没有页面外 `pointerdown` 或 textarea `blur` 的关闭入口。
- 命令选项未禁用文本选择和 iOS 长按 callout；`onMouseDown` 也没有覆盖触摸 pointer。
- 面板背景继续与 `transparent` 混色，消息内容会透过面板干扰阅读；移动端把选项最小高度提升到了 46px。
- `.app-header` 没有统一的子项间距，移动端又把连接状态右边距压缩到 2px。
- 构建后的入口先声明模块脚本、后声明完整 CSS，入口 HTML 没有登录布局的关键样式；CSS 尚未应用时，登录卡按普通文档流出现在左上角。

## Interaction design

命令面板继续由 textarea 驱动，不引入第二套 Popover 状态。打开时监听 document capture 阶段的 `pointerdown`：目标不在 composer form 内就关闭；textarea 自身失焦也关闭。命令 item 在 pointer down 时阻止默认文本选择并更新高亮，click/tap 仍只负责把命令回填到输入框。textarea 再次聚焦且内容仍以 `/` 开头时重新打开面板。

面板及其全部后代使用 `user-select: none`、`-webkit-user-select: none`、`-webkit-touch-callout: none` 和 `touch-action: manipulation`，避免移动端长按同时选中文字或弹出系统 callout。键盘上下选择、Enter 回填、Esc 关闭和完整占位符选中行为保持不变。

## Visual design

沿用 Graphite / Porcelain Glass 方向，但命令面板改为由 `panel` 与 `bg` 混合得到的不透明表面，保留边框、内高光与阴影表达层级，不再依赖透明度展示 Glass。桌面 item 收敛到约 38px，移动端维持约 42px 的可触摸高度；命令和描述字体不缩小，只减少垂直 padding 与列间距。

头部使用统一 gap；连接状态保留 `margin-left: auto`，但桌面与移动端都给状态点和第一枚动作按钮留下稳定间隔。

## First-paint stability

在 `src/webui/index.html` 的 `<head>` 中加入只负责页面尺寸和登录卡定位的关键 CSS。它不复制主题、颜色、动画和组件细节，只确保 `html/body/#root` 占满视口、body 无默认 margin、`.login` 首帧就是居中网格、登录 section 有稳定宽度和 `box-sizing`。完整 CSS 到达后相同属性自然接管，不产生布局位移。

## Verification

- 静态回归测试约束 pointer/blur 关闭、触摸防选中、面板不透明、header gap 和登录关键 CSS。
- 运行 Prettier、类型检查、ESLint/依赖矩阵、Vite 生产构建和全量 Bun 测试。
- 不修改服务端接口、命令目录、数据库或配置模板。
