// AssetFold 的界面控制模块：渲染树形表单，并把用户操作同步到领域状态。

import {
  createAmountItem,
  createDirectory,
  createNoteItem,
  decodePath,
  encodePath,
  formatLocalIso,
  getDirectory,
  getSiblingDirectories,
  listUsedCurrencies,
  MAX_DIRECTORY_DEPTH,
  normalizeCurrency,
  SECTION_META,
  SUPPORTED_CURRENCIES,
  toDateTimeLocalValue,
  walkDirectories,
} from "./model.js";
import {
  calculateState,
  directoryTotalFor,
  formatCents,
  formatScale4,
  getRateIssues,
} from "./calculation.js";
import { exportJson, exportMarkdown, parseImportedJson } from "./import-export.js";
import { replaceStoredState, saveSession, saveState } from "./storage.js";

// 创建单实例应用，集中管理 DOM 事件、渲染、持久化和文件操作。
export function createApp({ state, session }) {
  const elements = {
    workspace: document.querySelector("#tree-workspace"),
    alert: document.querySelector("#calculation-alert"),
    saveStatus: document.querySelector("#save-status"),
    rateList: document.querySelector("#rate-list"),
    rateHealth: document.querySelector("#rate-health"),
    rateAttribution: document.querySelector("#rate-attribution"),
    exportTime: document.querySelector("#export-time"),
    importInput: document.querySelector("#json-import"),
    toastRegion: document.querySelector("#toast-region"),
  };

  elements.exportTime.value = toDateTimeLocalValue();
  renderAll();

  document.addEventListener("click", handleClick);
  document.addEventListener("input", handleInput);
  document.addEventListener("change", handleChange);
  elements.importInput.addEventListener("change", handleImport);
  window.addEventListener("pagehide", handlePageHide);

  // 完整刷新所有由状态派生的界面区域。
  function renderAll() {
    renderTabs();
    renderWorkspace();
    renderRates();
    renderCalculation();
    document.querySelectorAll(`input[name="conversion-mode"]`).forEach((input) => {
      input.checked = input.value === state.conversionMode;
    });
  }

  // 同步确定资产与待定资产标签页的选中状态。
  function renderTabs() {
    for (const section of ["confirmed", "pending"]) {
      const tab = document.querySelector(`#tab-${section}`);
      const active = session.activeSection === section;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
    }
  }

  // 渲染当前资产区域的空状态或完整目录树。
  function renderWorkspace() {
    const section = session.activeSection;
    const directories = state[section].directories;
    if (directories.length === 0) {
      elements.workspace.innerHTML = `
        <div class="empty-state">
          <div>
            <img class="empty-diagram" src="./assets/empty-diagram.svg" width="96" height="72" alt="">
            <h3>${SECTION_META[section].label}尚无目录</h3>
            <p>先创建一个顶级目录，再按需要添加子目录、金额或备注。</p>
            <button class="button button-primary" type="button" data-action="add-root-directory">新增顶级目录</button>
          </div>
        </div>`;
      return;
    }

    const calculation = calculateState(state);
    elements.workspace.innerHTML = `<div class="directory-list">${directories.map((directory, index) => renderDirectory(directory, section, [index], 1, calculation)).join("")}</div>`;
  }

  // 递归渲染单个目录，并根据同构状态提供合法的新增操作。
  function renderDirectory(directory, section, path, depth, calculation) {
    const encodedPath = encodePath(path);
    const pathKey = `${section}:${path.join(".")}`;
    const closed = session.closedPaths.includes(pathKey);
    const isBranch = Array.isArray(directory.directories);
    const children = isBranch ? directory.directories : directory.items;
    const empty = children.length === 0;
    const canAddDirectory = depth < MAX_DIRECTORY_DEPTH && (isBranch || empty);
    const canAddItem = !isBranch || empty;
    const total = directoryTotalFor(calculation, section, path);
    const siblings = getSiblingDirectories(state, section, path);
    const currentIndex = path.at(-1);

    const body = isBranch
      ? directory.directories.map((child, index) => renderDirectory(child, section, [...path, index], depth + 1, calculation)).join("")
      : renderItems(directory.items, section, path);

    return `
      <div class="directory-node">
        <article class="directory-card">
          <header class="directory-summary">
            <button class="icon-button directory-caret" type="button" data-action="toggle-directory" data-section="${section}" data-path="${encodedPath}" aria-label="${closed ? "展开" : "收起"}目录" aria-expanded="${!closed}">
              ${icon("chevron", closed ? "" : "is-open")}
            </button>
            <input class="directory-name" value="${escapeAttribute(directory.name)}" data-action="update-directory-name" data-section="${section}" data-path="${encodedPath}" aria-label="目录名称">
            <span class="directory-total">${formatScale4(total)} CNY</span>
            <div class="inline-actions">
              ${iconButton("arrow-up", "上移目录", "move-directory", section, encodedPath, "up", currentIndex === 0)}
              ${iconButton("arrow-down", "下移目录", "move-directory", section, encodedPath, "down", currentIndex === siblings.length - 1)}
              ${iconButton("trash", "删除目录", "delete-directory", section, encodedPath)}
            </div>
          </header>
          <div class="directory-body" ${closed ? "hidden" : ""}>
            <div class="directory-actions">
              ${canAddDirectory ? `<button class="button button-small" type="button" data-action="add-subdirectory" data-section="${section}" data-path="${encodedPath}">新增子目录</button>` : ""}
              ${canAddItem ? `<button class="button button-small" type="button" data-action="add-amount" data-section="${section}" data-path="${encodedPath}">新增金额</button>` : ""}
              ${canAddItem ? `<button class="button button-small" type="button" data-action="add-note" data-section="${section}" data-path="${encodedPath}">新增备注</button>` : ""}
              <span class="directory-depth">第 ${depth} 级 · ${isBranch ? "子目录" : "条目"}</span>
            </div>
            ${isBranch ? `<div class="directory-children">${body || `<p class="inline-empty">请选择目录内容类型</p>`}</div>` : `<div class="item-list">${body}</div>`}
          </div>
        </article>
      </div>`;
  }

  // 按原始顺序渲染叶目录中的金额和独立备注。
  function renderItems(items, section, directoryPath) {
    if (items.length === 0) return `<p class="inline-empty">添加金额或备注开始填写</p>`;
    return items.map((item, itemIndex) => item.type === "note"
      ? renderNoteItem(item, section, directoryPath, itemIndex, items.length)
      : renderAmountItem(item, section, directoryPath, itemIndex, items.length)).join("");
  }

  // 渲染区域专属方向、原币金额、货币和可选折算结果输入框。
  function renderAmountItem(item, section, directoryPath, itemIndex, itemCount) {
    const encodedPath = encodePath(directoryPath);
    const currency = normalizeCurrency(item.currency);
    const needsConversion = currency && currency !== "CNY" && state.conversionMode === "per-entry";
    const directionOptions = SECTION_META[section].directions.map(({ value, label }) => `<option value="${value}" ${item.direction === value ? "selected" : ""}>${label}</option>`).join("");
    const currencyOptions = SUPPORTED_CURRENCIES.map((value) => `<option value="${value}" ${currency === value ? "selected" : ""}>${value}</option>`).join("");
    const conversionField = needsConversion ? `
      <div class="item-field">
        <label>折合人民币</label>
        <input class="item-input converted-input" inputmode="decimal" value="${escapeAttribute(item.convertedCNY ?? "")}" placeholder="0.0000" data-action="update-item" data-section="${section}" data-path="${encodedPath}" data-index="${itemIndex}" data-field="convertedCNY">
      </div>` : "";

    return `
      <div class="amount-item ${needsConversion ? "has-conversion" : ""}">
        <div class="item-field">
          <label>名称</label>
          <input class="item-input" value="${escapeAttribute(item.name)}" placeholder="建议填写" data-action="update-item" data-section="${section}" data-path="${encodedPath}" data-index="${itemIndex}" data-field="name">
        </div>
        <div class="item-field">
          <label>方向</label>
          <select class="select-input" data-action="update-item" data-section="${section}" data-path="${encodedPath}" data-index="${itemIndex}" data-field="direction">${directionOptions}</select>
        </div>
        <div class="item-field">
          <label>金额</label>
          <input class="item-input money-input" inputmode="decimal" value="${escapeAttribute(item.amount)}" data-action="update-item" data-section="${section}" data-path="${encodedPath}" data-index="${itemIndex}" data-field="amount">
        </div>
        <div class="item-field">
          <label>货币</label>
          <select class="select-input currency-input" data-action="update-item" data-section="${section}" data-path="${encodedPath}" data-index="${itemIndex}" data-field="currency">${currencyOptions}</select>
        </div>
        ${conversionField}
        <div class="item-field">
          <label>备注</label>
          <input class="item-input" value="${escapeAttribute(item.note ?? "")}" placeholder="可选" data-action="update-item" data-section="${section}" data-path="${encodedPath}" data-index="${itemIndex}" data-field="note">
        </div>
        ${itemToolbar(section, encodedPath, itemIndex, itemCount)}
      </div>`;
  }

  // 渲染不参与计算且可以与金额共同排序的独立备注。
  function renderNoteItem(item, section, directoryPath, itemIndex, itemCount) {
    const encodedPath = encodePath(directoryPath);
    return `
      <div class="note-item">
        <textarea class="note-textarea" placeholder="填写不参与计算的说明" data-action="update-item" data-section="${section}" data-path="${encodedPath}" data-index="${itemIndex}" data-field="text">${escapeHtml(item.text)}</textarea>
        ${itemToolbar(section, encodedPath, itemIndex, itemCount)}
      </div>`;
  }

  // 创建金额或备注条目共用的移动与删除工具栏。
  function itemToolbar(section, encodedPath, index, count) {
    return `<div class="item-toolbar">
      ${iconButton("arrow-up", "上移条目", "move-item", section, encodedPath, "up", index === 0, index)}
      ${iconButton("arrow-down", "下移条目", "move-item", section, encodedPath, "down", index === count - 1, index)}
      ${iconButton("trash", "删除条目", "delete-item", section, encodedPath, "", false, index)}
    </div>`;
  }

  // 根据实际使用的外币和当前折算模式渲染汇率设置。
  function renderRates() {
    const currencies = listUsedCurrencies(state);
    const issues = getRateIssues(state);
    const issueMap = new Map(issues.map((issue) => [issue.currency, issue]));
    elements.rateAttribution.hidden = state.conversionMode !== "shared-rate" || currencies.length === 0;

    if (state.conversionMode === "per-entry") {
      elements.rateList.innerHTML = `<div class="rate-empty">外币金额在各条目中直接填写人民币折算结果。</div>`;
      updateRateHealth([]);
      return;
    }
    if (currencies.length === 0) {
      elements.rateList.innerHTML = `<div class="rate-empty">添加外币金额后，这里会显示对应汇率。</div>`;
      updateRateHealth([]);
      return;
    }

    elements.rateList.innerHTML = currencies.map((currency) => {
      const record = state.exchangeRates[currency] ?? {};
      const issue = issueMap.get(currency);
      return `
        <article class="rate-card ${issue ? "is-stale" : ""}">
          <div class="rate-heading">
            <span class="rate-currency">${escapeHtml(currency)}</span>
            <span class="rate-state">${issue ? escapeHtml(issue.message) : record.source === "automatic" ? "自动汇率" : "手动汇率"}</span>
          </div>
          <div class="rate-fields">
            <label class="rate-equation">
              <span>1 ${escapeHtml(currency)} =</span>
              <input class="item-input rate-input" inputmode="decimal" value="${escapeAttribute(record.rateToCNY ?? "")}" placeholder="0.000000" data-action="update-rate" data-currency="${escapeAttribute(currency)}" data-field="rateToCNY">
              <span>CNY</span>
            </label>
            <div class="rate-time">
              <input class="item-input" type="datetime-local" step="60" value="${escapeAttribute(toLocalInput(record.updatedAt))}" aria-label="${escapeAttribute(currency)} 汇率更新时间" data-action="update-rate" data-currency="${escapeAttribute(currency)}" data-field="updatedAt">
              <button class="button button-small" type="button" data-action="refresh-rate" data-currency="${escapeAttribute(currency)}">自动获取</button>
            </div>
          </div>
        </article>`;
    }).join("");
    updateRateHealth(issues);
  }

  // 更新汇率区域右上角的健康状态摘要。
  function updateRateHealth(issues) {
    elements.rateHealth.textContent = issues.length === 0 ? "汇率正常" : `${issues.length} 项提醒`;
    elements.rateHealth.classList.toggle("is-warning", issues.length > 0);
  }

  // 重新计算四项汇总，并把不完整条目集中显示为可操作错误。
  function renderCalculation() {
    const calculation = calculateState(state);
    const summaryIds = ["confirmed", "inflow", "outflow", "projected"];
    for (const key of summaryIds) {
      const element = document.querySelector(`#summary-${key}`);
      element.textContent = calculation.complete ? formatCents(calculation.displayCents[key], { showPlus: key === "inflow" }) : "—";
    }
    if (calculation.complete) {
      elements.alert.hidden = true;
      elements.alert.textContent = "";
    } else {
      elements.alert.hidden = false;
      const visible = calculation.errors.slice(0, 3);
      const more = calculation.errors.length > visible.length ? `；另有 ${calculation.errors.length - visible.length} 项` : "";
      elements.alert.textContent = `${visible.join("；")}${more}`;
    }
  }

  // 处理所有按钮点击；结构操作完成后统一立即保存并重新渲染。
  function handleClick(event) {
    const actionElement = event.target.closest("[data-action]");
    if (!actionElement) return;
    const action = actionElement.dataset.action;
    const section = actionElement.dataset.section ?? session.activeSection;
    const path = decodePath(actionElement.dataset.path ?? "%5B%5D");

    if (action === "switch-section") {
      session.activeSection = actionElement.dataset.section;
      saveSession(session);
      renderTabs();
      renderWorkspace();
      return;
    }
    if (action === "add-root-directory") {
      state[session.activeSection].directories.push(createDirectory());
      commitStructure();
      return;
    }
    if (action === "toggle-directory") {
      const key = `${section}:${path.join(".")}`;
      const index = session.closedPaths.indexOf(key);
      if (index >= 0) session.closedPaths.splice(index, 1);
      else session.closedPaths.push(key);
      saveSession(session);
      renderWorkspace();
      return;
    }
    if (action === "add-subdirectory") {
      const directory = getDirectory(state, section, path);
      if (!directory) return;
      if (Array.isArray(directory.items) && directory.items.length > 0) return;
      delete directory.items;
      directory.directories ??= [];
      directory.directories.push(createDirectory());
      commitStructure();
      return;
    }
    if (action === "add-amount" || action === "add-note") {
      const directory = getDirectory(state, section, path);
      if (!directory) return;
      if (Array.isArray(directory.directories) && directory.directories.length > 0) return;
      delete directory.directories;
      directory.items ??= [];
      directory.items.push(action === "add-amount" ? createAmountItem(section) : createNoteItem());
      commitStructure();
      return;
    }
    if (action === "move-directory") {
      moveDirectory(section, path, actionElement.dataset.direction);
      commitStructure();
      return;
    }
    if (action === "delete-directory") {
      const directory = getDirectory(state, section, path);
      if (!directory || !window.confirm(`删除目录“${directory.name}”及其全部内容？`)) return;
      getSiblingDirectories(state, section, path).splice(path.at(-1), 1);
      commitStructure();
      return;
    }
    if (action === "move-item" || action === "delete-item") {
      const directory = getDirectory(state, section, path);
      const index = Number(actionElement.dataset.index);
      if (!directory?.items?.[index]) return;
      if (action === "delete-item") directory.items.splice(index, 1);
      else moveInArray(directory.items, index, actionElement.dataset.direction);
      commitStructure();
      return;
    }
    if (action === "refresh-rate") {
      refreshRate(actionElement.dataset.currency, actionElement);
      return;
    }
    if (action === "export-json") {
      exportJson(state, selectedExportDate());
      showToast("JSON 已导出");
      return;
    }
    if (action === "export-markdown") {
      const result = exportMarkdown(state, selectedExportDate());
      if (result.ok) showToast("Markdown 已导出");
      else showToast(`无法导出：${result.errors[0]}`, true);
      return;
    }
    if (action === "open-import") elements.importInput.click();
  }

  // 处理连续文本输入，短防抖保存以避免每个按键同步写 localStorage。
  function handleInput(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "update-directory-name") {
      const directory = getDirectory(state, target.dataset.section, decodePath(target.dataset.path));
      if (directory) directory.name = target.value;
      scheduleSave();
      return;
    }
    if (action === "update-item") {
      const section = target.dataset.section;
      const directory = getDirectory(state, section, decodePath(target.dataset.path));
      const item = directory?.items?.[Number(target.dataset.index)];
      if (!item) return;
      const value = target.dataset.field === "currency" ? normalizeCurrency(target.value) : target.value;
      item[target.dataset.field] = value;
      if (item.type === "amount" && section === "confirmed" && isZero(item.amount) && item.direction === "deduct") item.direction = "add";
      scheduleSave();
      // 货币代码直接决定汇率面板内容，输入时同步更新，避免等待失焦。
      if (target.dataset.field === "currency") renderRates();
      renderCalculation();
      return;
    }
    if (action === "update-rate") {
      updateRateFromInput(target);
      scheduleSave();
      renderCalculation();
    }
  }

  // 处理需要完成值确认或可能改变结构的 change 事件。
  function handleChange(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    if (target.dataset.action === "change-conversion-mode") {
      if (!target.checked || target.value === state.conversionMode) return;
      const warning = target.value === "per-entry"
        ? "切换后会清除统一中间汇率，并要求每条外币金额填写人民币折算结果。继续吗？"
        : "切换后会清除现有的单条人民币折算结果。继续吗？";
      if (!window.confirm(warning)) {
        document.querySelector(`input[name="conversion-mode"][value="${state.conversionMode}"]`).checked = true;
        return;
      }
      if (target.value === "per-entry") state.exchangeRates = {};
      else walkDirectoriesInState((item) => delete item.convertedCNY);
      state.conversionMode = target.value;
      commitStructure();
      return;
    }
    if (target.dataset.action === "update-item") {
      const section = target.dataset.section;
      const directory = getDirectory(state, section, decodePath(target.dataset.path));
      const item = directory?.items?.[Number(target.dataset.index)];
      if (item && section === "confirmed" && isZero(item.amount) && item.direction === "deduct") {
        item.direction = "add";
        showToast("零金额已按累加处理");
      }
      commitStructure();
    }
    if (target.dataset.action === "update-rate") {
      updateRateFromInput(target);
      commitStructure();
    }
  }

  // 页面刷新或关闭前立即落盘，覆盖输入防抖尚未到期的极短窗口。
  function handlePageHide() {
    saveState(state, null, true);
  }

  // 校验用户选择的 JSON，并在明确确认后整体替换当前工作数据。
  async function handleImport() {
    const [file] = elements.importInput.files;
    elements.importInput.value = "";
    if (!file) return;
    const result = await parseImportedJson(file);
    if (!result.ok) {
      showToast(`导入失败：${result.errors.slice(0, 2).join("；")}`, true);
      return;
    }
    if (!window.confirm("导入将替换当前数据。继续吗？")) return;
    try {
      // 先完成持久化，再替换内存对象；存储失败时界面仍保持原数据。
      replaceStoredState(result.state);
    } catch (error) {
      showToast(`无法保存导入数据：${error instanceof Error ? error.message : "浏览器存储失败"}`, true);
      return;
    }
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, result.state);
    // 导入文件的导出时间只更新当前页面控件，不进入 localStorage 或 sessionStorage。
    if (result.exportedAt) elements.exportTime.value = toLocalInput(result.exportedAt);
    renderAll();
    const issues = getRateIssues(state);
    showToast(issues.length > 0 ? `导入完成，发现 ${issues.length} 项汇率提醒` : "JSON 导入完成", issues.length > 0);
  }

  // 从开放汇率接口获取单个货币对 CNY 的汇率，并保留接口发布时间。
  async function refreshRate(currency, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "获取中…";
    try {
      const response = await fetch("https://open.er-api.com/v6/latest/CNY", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const cnyToCurrency = Number(data.rates?.[currency]);
      if (!Number.isFinite(cnyToCurrency) || cnyToCurrency <= 0) throw new Error(`接口未提供 ${currency}`);
      // 接口以 CNY 为基准返回“1 CNY 可兑换多少外币”，此处取倒数得到 rateToCNY。
      state.exchangeRates[currency] = {
        rateToCNY: (1 / cnyToCurrency).toFixed(8).replace(/0+$/, "").replace(/\.$/, ""),
        updatedAt: formatLocalIso(new Date((data.time_last_update_unix ?? Date.now() / 1000) * 1000)),
        source: "automatic",
      };
      saveState(state, updateSavedStatus, true);
      renderAll();
      showToast(`${currency} 汇率已更新`);
    } catch (error) {
      showToast(`自动获取失败：${error.message}`, true);
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  // 把用户手工编辑的汇率或更新时间同步到对应货币记录。
  function updateRateFromInput(target) {
    const currency = normalizeCurrency(target.dataset.currency);
    const record = state.exchangeRates[currency] ?? { rateToCNY: "", updatedAt: formatLocalIso(new Date()), source: "manual" };
    if (target.dataset.field === "updatedAt") record.updatedAt = target.value ? formatLocalIso(new Date(target.value)) : "";
    else {
      record.rateToCNY = target.value.trim();
      record.updatedAt = formatLocalIso(new Date());
      record.source = "manual";
    }
    state.exchangeRates[currency] = record;
  }

  // 对新增、删除、移动等结构操作立即保存，并刷新全部派生界面。
  function commitStructure() {
    saveState(state, updateSavedStatus, true);
    renderAll();
  }

  // 标记保存中并安排短防抖写入。
  function scheduleSave() {
    elements.saveStatus.textContent = "保存中…";
    saveState(state, updateSavedStatus);
  }

  // 向页头报告最近保存时间；存储失败时给出明确错误状态。
  function updateSavedStatus(savedAt, error = null) {
    if (error instanceof Error) {
      elements.saveStatus.textContent = "保存失败";
      showToast(`自动保存失败：${error.message}`, true);
      return;
    }
    const date = new Date(savedAt);
    elements.saveStatus.textContent = `已保存 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }

  // 在同级目录数组中移动指定目录。
  function moveDirectory(section, path, direction) {
    const siblings = getSiblingDirectories(state, section, path);
    moveInArray(siblings, path.at(-1), direction);
  }

  // 交换数组中相邻元素；越界操作保持为无副作用。
  function moveInArray(items, index, direction) {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= items.length) return;
    [items[index], items[target]] = [items[target], items[index]];
  }

  // 遍历两类资产区域中的全部金额条目，用于清理互斥折算字段。
  function walkDirectoriesInState(callback) {
    for (const section of ["confirmed", "pending"]) {
      walkDirectories(state[section].directories, (directory) => {
        for (const item of directory.items ?? []) if (item.type === "amount") callback(item);
      });
    }
  }

  // 读取用户指定的导出时间，无效输入回落到浏览器当前时间。
  function selectedExportDate() {
    const date = new Date(elements.exportTime.value);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }

  // 显示会自动消失的简短操作结果，不阻塞后续输入。
  function showToast(message, isError = false) {
    const toast = document.createElement("div");
    toast.className = `toast ${isError ? "is-error" : ""}`;
    toast.textContent = message;
    elements.toastRegion.append(toast);
    setTimeout(() => toast.remove(), 4200);
  }
}

// 创建具有统一图标、路径参数和无障碍名称的操作按钮。
function iconButton(iconName, label, action, section, encodedPath, direction = "", disabled = false, index = null) {
  return `<button class="icon-button" type="button" title="${label}" aria-label="${label}" data-action="${action}" data-section="${section}" data-path="${encodedPath}" ${direction ? `data-direction="${direction}"` : ""} ${index !== null ? `data-index="${index}"` : ""} ${disabled ? "disabled" : ""}>${icon(iconName)}</button>`;
}

// 返回项目自带的少量线性 SVG 图标，避免引入图标依赖。
function icon(name, className = "") {
  const paths = {
    chevron: `<path d="m9 18 6-6-6-6"></path>`,
    "arrow-up": `<path d="m18 15-6-6-6 6"></path>`,
    "arrow-down": `<path d="m6 9 6 6 6-6"></path>`,
    trash: `<path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="m6 7 1 14h10l1-14M9 7V4h6v3"></path>`,
  };
  return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

// 判断金额文本是否表示零，用于强制确定资产零值采用累加方向。
function isZero(value) {
  return /^0+(?:\.0+)?$/.test(String(value ?? "").trim());
}

// 把带时区的持久化时间转换为 datetime-local 可显示的本地值。
function toLocalInput(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : toDateTimeLocalValue(date);
}

// 转义写入 HTML 文本节点的动态值，避免模板字符串注入标记。
function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// 在 HTML 文本转义基础上继续转义双引号，供属性值安全使用。
function escapeAttribute(value) {
  return escapeHtml(value).replaceAll('"', "&quot;");
}
