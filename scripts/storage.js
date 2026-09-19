// AssetFold 的浏览器存储模块：持久化唯一工作数据和当前会话界面状态。

import { createInitialState, formatLocalIso, validateState } from "./model.js";

const STORAGE_KEY = "assetfold.current.v1";
const SESSION_KEY = "assetfold.session.v1";
let saveTimer = null;

// 从 localStorage 恢复当前工作数据；结构损坏时回落到空白数据。
export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw);
    const errors = validateState(parsed);
    if (errors.length > 0) {
      console.warn("AssetFold stored data failed validation", errors);
      return createInitialState();
    }
    return parsed;
  } catch (error) {
    console.warn("AssetFold could not load local data", error);
    return createInitialState();
  }
}

// 以短防抖或立即模式保存工作数据，并向界面报告保存时间。
export function saveState(state, onSaved, immediate = false) {
  clearTimeout(saveTimer);
  // 单键整体写入让状态更新保持原子性，并统一处理浏览器配额错误。
  const commit = () => {
    state.savedAt = formatLocalIso(new Date());
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      onSaved?.(state.savedAt, null);
    } catch (error) {
      onSaved?.(state.savedAt, error);
    }
  };
  if (immediate) commit();
  else saveTimer = setTimeout(commit, 180);
}

// 从 sessionStorage 恢复标签页和目录收起状态。
export function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return {
      activeSection: parsed.activeSection === "pending" ? "pending" : "confirmed",
      closedPaths: Array.isArray(parsed.closedPaths) ? parsed.closedPaths : [],
    };
  } catch {
    return { activeSection: "confirmed", closedPaths: [] };
  }
}

// 保存不需要跨浏览器会话保留的界面状态。
export function saveSession(session) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

// 取消尚未执行的保存，并清除工作数据及当前标签页的临时界面状态。
export function clearStoredData() {
  clearTimeout(saveTimer);
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(SESSION_KEY);
}

// 在 JSON 导入后立即整体替换 localStorage 中的工作数据。
export function replaceStoredState(state) {
  state.savedAt = formatLocalIso(new Date());
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
