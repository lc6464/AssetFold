// AssetFold 的文件交换模块：生成 JSON/Markdown，并校验用户选择的 JSON 文件。

import { amountToCnyScale4, calculateState, directoryTotalFor, formatCents, formatScale4 } from "./calculation.js";
import { formatLocalIso, normalizeCurrency, SECTION_META, validateState } from "./model.js";

// 导出包含工作结构、汇率更新时间和用户指定导出时间的完整 JSON。
export function exportJson(state, exportDate) {
  const payload = structuredClone(state);
  payload.exportedAt = formatLocalIso(exportDate);
  downloadText(JSON.stringify(payload, null, 2), fileName(exportDate, "json"), "application/json;charset=utf-8");
}

// 导出按 Markdown 标题层级组织的资产记录；计算不完整时拒绝生成误导结果。
export function exportMarkdown(state, exportDate) {
  const result = createMarkdown(state, exportDate);
  if (!result.ok) return result;
  downloadText(result.content, fileName(exportDate, "md"), "text/markdown;charset=utf-8");
  return { ok: true };
}

// 生成可独立测试的 Markdown 文本，避免文件下载行为与内容拼装相互耦合。
export function createMarkdown(state, exportDate) {
  const calculation = calculateState(state);
  if (!calculation.complete) return { ok: false, errors: calculation.errors };

  const lines = [`# 资产统计 ${formatDisplayTime(exportDate)}`, ""];
  for (const section of ["confirmed", "pending"]) {
    lines.push(`## ${SECTION_META[section].label}`, "");
    const directories = state[section].directories;
    if (directories.length === 0) lines.push("_暂无条目_", "");
    directories.forEach((directory, index) => appendDirectory(lines, directory, section, [index], 3, state, calculation));
  }

  lines.push("## 汇总", "");
  lines.push(`确定资产：${formatCents(calculation.displayCents.confirmed)}`);
  lines.push(`待定流入：${formatCents(calculation.displayCents.inflow, { showPlus: true })}`);
  lines.push(`待定流出：${formatCents(calculation.displayCents.outflow)}`);
  lines.push(`预计资产：${formatCents(calculation.displayCents.projected)}`, "");

  return { ok: true, content: lines.join("\n") };
}

// 递归输出目录、条目、备注和四位定点目录小计。
function appendDirectory(lines, directory, section, path, headingLevel, state, calculation) {
  lines.push(`${"#".repeat(headingLevel)} ${directory.name}`, "");
  if (Array.isArray(directory.directories)) {
    directory.directories.forEach((child, index) => appendDirectory(lines, child, section, [...path, index], headingLevel + 1, state, calculation));
  } else {
    for (const item of directory.items) {
      // 独立备注保持在 items 数组中的相对位置，且不参与任何金额计算。
      if (item.type === "note") {
        lines.push(item.text || "（空备注）", "");
        continue;
      }
      const directionSign = ["deduct", "outflow"].includes(item.direction) ? "−" : "+";
      const name = item.name.trim() ? `${item.name.trim()}：` : "";
      lines.push(`${name}${directionSign}${item.amount} ${normalizeCurrency(item.currency)}`);
      if (normalizeCurrency(item.currency) !== "CNY") {
        const converted = amountToCnyScale4(item, state);
        if (state.conversionMode === "shared-rate") {
          const rate = state.exchangeRates[normalizeCurrency(item.currency)]?.rateToCNY;
          lines.push(`折合（1 ${normalizeCurrency(item.currency)} = ${rate} CNY）：${directionSign}${formatScale4(converted.value)} CNY`);
        } else {
          lines.push(`折合：${directionSign}${formatScale4(converted.value)} CNY`);
        }
      }
      if (item.note?.trim()) lines.push(`备注：${item.note.trim()}`);
      lines.push("");
    }
  }
  lines.push(`${directory.name} 小计：${formatScale4(directoryTotalFor(calculation, section, path))} CNY`, "");
}

// 读取并校验 JSON 文件；导出时间作为页面临时值返回，不写回持久化工作数据。
export async function parseImportedJson(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ["JSON 语法无效"] };
  }
  // 仅接受可以明确解析的导出时间；缺失或损坏的元数据不阻止资产主体导入。
  const exportedAt = typeof parsed?.exportedAt === "string" && !Number.isNaN(new Date(parsed.exportedAt).getTime())
    ? parsed.exportedAt
    : null;
  if (parsed && typeof parsed === "object") delete parsed.exportedAt;
  const errors = validateState(parsed);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, state: parsed, exportedAt };
}

// 使用临时 Blob URL 触发浏览器下载，并在点击后释放对象 URL。
function downloadText(content, name, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// 按导出时间生成便于本地排序的文件名。
function fileName(date, extension) {
  const pad = (value) => String(value).padStart(2, "0");
  return `AssetFold-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.${extension}`;
}

// 把导出时间格式化为 Markdown 主标题中的分钟精度文本。
function formatDisplayTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
