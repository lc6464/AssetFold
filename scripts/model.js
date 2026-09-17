// AssetFold 的领域模型：定义持久化结构、目录访问方法和导入结构校验。

/** @typedef {"add" | "deduct" | "inflow" | "outflow"} AmountDirection */
/** @typedef {{ type: "note", text: string }} NoteItem */
/** @typedef {{ type: "amount", name: string, amount: string, currency: string, direction: AmountDirection, note: string, convertedCNY?: string }} AmountItem */
/** @typedef {{ name: string, directories?: AssetDirectory[], items?: Array<AmountItem | NoteItem> }} AssetDirectory */

export const SCHEMA_VERSION = 1;
export const MAX_DIRECTORY_DEPTH = 4;
// 界面允许选择的常见货币代码；保持简单数组结构，便于后续直接增删。
export const SUPPORTED_CURRENCIES = [
  "CNY", "CNH", "HKD", "USD", "MOP", "SGD", "JPY", "EUR",
  "GBP", "AUD", "CAD", "TWD", "KRW", "MYR", "THB", "CHF", "NZD",
];
export const SECTION_META = Object.freeze({
  confirmed: {
    label: "确定资产",
    directions: [
      { value: "add", label: "累加" },
      { value: "deduct", label: "去重" },
    ],
  },
  pending: {
    label: "待定资产",
    directions: [
      { value: "inflow", label: "流入" },
      { value: "outflow", label: "流出" },
    ],
  },
});

// 创建一份可直接持久化的空白工作数据。
export function createInitialState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: formatLocalIso(new Date()),
    conversionMode: "shared-rate",
    exchangeRates: {},
    confirmed: { directories: [] },
    pending: { directories: [] },
  };
}

// 创建默认的空目录；空目录首次添加内容时再确定为分支或叶目录。
export function createDirectory(name = "新建目录") {
  return { name, directories: [] };
}

// 根据确定或待定区域创建具有合法默认方向的金额条目。
export function createAmountItem(section) {
  return {
    type: "amount",
    name: "",
    amount: "0.00",
    currency: "CNY",
    direction: section === "confirmed" ? "add" : "inflow",
    note: "",
  };
}

// 创建不参与任何计算的独立备注条目。
export function createNoteItem() {
  return { type: "note", text: "" };
}

// 按索引路径读取目录；路径失效时返回 null，避免结构操作误改其他节点。
export function getDirectory(state, section, path) {
  let directories = state[section].directories;
  let directory = null;
  for (const index of path) {
    directory = directories[index];
    if (!directory) return null;
    directories = directory.directories ?? [];
  }
  return directory;
}

// 获取指定目录所在的同级数组，供移动和删除操作使用。
export function getSiblingDirectories(state, section, path) {
  if (path.length === 1) return state[section].directories;
  const parent = getDirectory(state, section, path.slice(0, -1));
  return parent?.directories ?? [];
}

// 把索引路径编码为可安全写入 HTML data 属性的文本。
export function encodePath(path) {
  return encodeURIComponent(JSON.stringify(path));
}

// 从 HTML data 属性还原索引路径，并拒绝非整数路径片段。
export function decodePath(value) {
  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed) && parsed.every(Number.isInteger) ? parsed : [];
  } catch {
    return [];
  }
}

// 收集当前所有有效的非人民币货币代码，用于生成汇率设置项。
export function listUsedCurrencies(state) {
  const currencies = new Set();
  for (const section of ["confirmed", "pending"]) {
    walkDirectories(state[section].directories, (directory) => {
      for (const item of directory.items ?? []) {
        if (item.type === "amount" && normalizeCurrency(item.currency) !== "CNY") {
          currencies.add(normalizeCurrency(item.currency));
        }
      }
    });
  }
  return [...currencies].filter(Boolean).sort();
}

// 深度优先遍历目录树，并把每个目录的索引路径传给回调函数。
export function walkDirectories(directories, callback, path = []) {
  directories.forEach((directory, index) => {
    const currentPath = [...path, index];
    callback(directory, currentPath);
    if (Array.isArray(directory.directories)) {
      walkDirectories(directory.directories, callback, currentPath);
    }
  });
}

// 统一清理货币代码，确保比较和汇率索引使用大写形式。
export function normalizeCurrency(value) {
  return String(value ?? "").trim().toUpperCase();
}

// 生成包含浏览器本地时区偏移的 ISO 时间，用于 JSON 和本地持久化。
export function formatLocalIso(date) {
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`;
}

// 生成 datetime-local 控件可识别的本地时间文本。
export function toDateTimeLocalValue(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 校验导入数据的版本和结构安全性；允许尚未填写完整的工作草稿。
export function validateState(candidate) {
  const errors = [];
  if (!candidate || typeof candidate !== "object") return ["文件内容不是有效对象"];
  if (candidate.schemaVersion !== SCHEMA_VERSION) errors.push(`不支持的数据版本：${candidate.schemaVersion ?? "未知"}`);
  if (typeof candidate.savedAt !== "string") errors.push("保存时间字段无效");
  if (!["shared-rate", "per-entry"].includes(candidate.conversionMode)) errors.push("折算方式无效");

  for (const section of ["confirmed", "pending"]) {
    if (!candidate[section] || !Array.isArray(candidate[section].directories)) {
      errors.push(`${SECTION_META[section].label}缺少目录列表`);
      continue;
    }
    validateDirectories(candidate[section].directories, section, 1, errors, SECTION_META[section].label);
  }

  if (!candidate.exchangeRates || typeof candidate.exchangeRates !== "object" || Array.isArray(candidate.exchangeRates)) {
    errors.push("汇率数据无效");
  } else {
    for (const [currency, rate] of Object.entries(candidate.exchangeRates)) {
      if (!normalizeCurrency(currency) || !rate || typeof rate !== "object") {
        errors.push(`货币 ${currency || "未知"} 的汇率记录无效`);
        continue;
      }
      if (typeof rate.rateToCNY !== "string") errors.push(`${currency} 的人民币汇率字段无效`);
      if (typeof rate.updatedAt !== "string") errors.push(`${currency} 的汇率更新时间字段无效`);
      if (!["automatic", "manual"].includes(rate.source)) errors.push(`${currency} 的汇率来源字段无效`);
    }
  }
  return errors;
}

// 递归校验目录同构规则、最大深度和节点基本类型。
function validateDirectories(directories, section, depth, errors, trail) {
  if (depth > MAX_DIRECTORY_DEPTH) {
    // 第四级空目录仍可等待用户选择条目类型；只有真实存在的第五级节点才越界。
    if (directories.length > 0) errors.push(`${trail} 超过四级目录限制`);
    return;
  }
  directories.forEach((directory, index) => {
    const label = `${trail} / ${String(directory?.name ?? "").trim() || `第 ${index + 1} 项`}`;
    if (!directory || typeof directory !== "object") {
      errors.push(`${label} 不是有效目录`);
      return;
    }
    if (typeof directory.name !== "string") errors.push(`${label} 的目录名称无效`);
    const hasDirectories = Array.isArray(directory.directories);
    const hasItems = Array.isArray(directory.items);
    if (hasDirectories === hasItems) {
      errors.push(`${label} 必须且只能包含子目录或条目`);
      return;
    }
    if (hasDirectories) validateDirectories(directory.directories, section, depth + 1, errors, label);
    if (hasItems) validateItems(directory.items, section, errors, label);
  });
}

// 校验叶目录中的备注、金额和区域专属方向，保留未完成输入作为合法草稿。
function validateItems(items, section, errors, trail) {
  const validDirections = new Set(SECTION_META[section].directions.map((item) => item.value));
  items.forEach((item, index) => {
    const label = `${trail} / 第 ${index + 1} 项`;
    if (item?.type === "note") {
      if (typeof item.text !== "string") errors.push(`${label} 的备注内容无效`);
      return;
    }
    if (item?.type !== "amount") {
      errors.push(`${label} 的条目类型无效`);
      return;
    }
    if (typeof item.amount !== "string") errors.push(`${label} 的金额字段无效`);
    if (typeof item.currency !== "string") errors.push(`${label} 的货币字段无效`);
    else if (!SUPPORTED_CURRENCIES.includes(normalizeCurrency(item.currency))) errors.push(`${label} 使用了不支持的货币`);
    if (typeof item.name !== "string") errors.push(`${label} 的名称字段无效`);
    if (typeof item.note !== "string") errors.push(`${label} 的备注字段无效`);
    if (!validDirections.has(item.direction)) errors.push(`${label} 的方向不属于${SECTION_META[section].label}`);
    if (item.convertedCNY !== undefined && typeof item.convertedCNY !== "string") errors.push(`${label} 的人民币折算结果字段无效`);
  });
}
