# Better Obsidian

Obsidian 桌面端增强插件，整合平滑同步滚动、自动双栏、文档分割管理、文件列表回收站与快捷重命名。当前版本 **1.0.0**，最低需要 Obsidian **1.7.0**。

配套主题：[Codex UI For Obsidian](https://github.com/Plantforlife/Codex-UI-For-Obsidian)。插件可以独立使用，也为 Codex UI For Obsidian 的悬浮功能区提供文件列表可见性识别与文件夹选择反馈。

## 安装

### 手动安装

1. 从 [Releases](https://github.com/Plantforlife/better-obsidian/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. 在笔记库中新建 `.obsidian/plugins/better-obsidian/`，将三个文件放入该目录。
3. 重新加载 Obsidian，在「设置 → 第三方插件」中启用 **Better Obsidian**。

### BRAT

使用 BRAT 添加仓库 `Plantforlife/better-obsidian`，安装后启用 **Better Obsidian**。

## 功能

- **平滑同步滚动**：按内容块位置同步中央区域中同一篇 Markdown 笔记，支持源码、实时预览与阅读视图。
- **高度差处理**：两侧内容高度不同时，可选择按比例放慢或速度匹配后等待；滚轮缓动时间可调整。
- **自动双栏**：打开或新建笔记时，自动生成源码编辑 / 阅读双栏；也可通过命令切换回单栏。
- **文档分割管理**：向右 / 向下分割、切换对侧、关闭最近由插件创建的分割。
- **文件列表增强**：悬停显示垃圾桶图标，将文件移至 Obsidian 配置的回收站；默认启用二次确认。
- **快捷重命名与删除**：默认使用 F2 和 Delete，可在插件设置中录制自己的快捷键。
- **缩放控制**：启动时可重置窗口缩放为 100%，也提供立即重置命令。
- **Codex UI For Obsidian 联动**：识别左侧文件列表是否可见，并保留文件夹点击反馈。

默认开启自动双栏、同步滚动、滚轮平滑处理和启动时恢复 100% 缩放。可在「设置 → Better Obsidian」分别关闭或调整。删除操作调用 Obsidian 的 `fileManager.trashFile`，回收站位置遵循 Obsidian 设置。

## 快捷键与命令

| 操作 | Windows 默认快捷键 |
| --- | --- |
| 向右分割当前文档 | Ctrl + Alt + `\` |
| 向下分割当前文档 | Ctrl + Alt + Shift + `\` |
| 切换到对侧文档 | Ctrl + Alt + `]` |
| 关闭最近创建的分割 | Ctrl + Alt + `[` |
| 重命名文件 / 文件夹 | F2 |
| 在文件列表中删除文档 | Delete |

在命令面板搜索 **Better Obsidian**，可使用「对半分：源码 / 阅读」「切换平滑同步滚动」「以当前面板立即对齐」「重置窗口缩放为 100%」等命令。分割快捷键在 Obsidian「设置 → 快捷键」中修改；F2 / Delete 的自定义选项在插件自身设置中。

## 开发与验证

`main.js` 是可直接维护的 CommonJS JavaScript 源码，也是 Obsidian 的插件入口；不需要打包或安装运行依赖。`styles.css` 提供文件列表和设置控件样式，`manifest.json` 保留插件 ID `better-obsidian`。

使用 Node.js 检查 JavaScript 语法：

```sh
node --check main.js
```

发布内容来自现有安装版本。上传时执行了语法、文件完整性和 CSS 解析检查，没有重新完成 Obsidian 内的全部交互回归。同步与文件列表功能包含对 Obsidian 内部视图接口的调用，升级 Obsidian 后需复核兼容性。
