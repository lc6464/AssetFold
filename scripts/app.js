// AssetFold 浏览器入口：恢复持久化状态并挂载唯一应用实例。

import { loadSession, loadState } from "./storage.js";
import { createApp } from "./ui.js";

// 数据和界面会话分别恢复，避免临时展开状态污染长期资产数据。
const state = loadState();
const session = loadSession();

createApp({ state, session });
