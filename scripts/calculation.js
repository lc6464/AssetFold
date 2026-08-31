// AssetFold 的纯计算模块：负责十进制定点换算、目录汇总和严格向下取整。

import { listUsedCurrencies, normalizeCurrency } from "./model.js";

export const INTERNAL_SCALE = 4;
const SCALE_FACTOR = 10n ** BigInt(INTERNAL_SCALE);
const FEN_FACTOR = 10n ** BigInt(INTERNAL_SCALE - 2);

// 计算两类资产区域、四项最终结果和每个目录的四位定点小计。
export function calculateState(state) {
  const errors = [];
  const directoryTotals = new Map();
  const confirmed = calculateSection(state, "confirmed", errors, directoryTotals);
  const pending = calculateSection(state, "pending", errors, directoryTotals);
  const raw = {
    confirmed: confirmed.add + confirmed.deduct,
    inflow: pending.inflow,
    outflow: pending.outflow,
  };
  raw.projected = raw.confirmed + raw.inflow + raw.outflow;

  return {
    complete: errors.length === 0,
    errors,
    raw,
    displayCents: {
      confirmed: floorScale4ToCents(raw.confirmed),
      inflow: floorScale4ToCents(raw.inflow),
      outflow: floorScale4ToCents(raw.outflow),
      projected: floorScale4ToCents(raw.projected),
    },
    directoryTotals,
  };
}

// 遍历单个资产区域，并按照区域允许的方向累计金额。
function calculateSection(state, section, errors, directoryTotals) {
  const totals = { add: 0n, deduct: 0n, inflow: 0n, outflow: 0n };
  // 递归函数返回当前目录的有符号小计，父目录直接累加子目录结果。
  const visit = (directory, path) => {
    let directoryTotal = 0n;
    if (Array.isArray(directory.directories)) {
      for (let index = 0; index < directory.directories.length; index += 1) {
        directoryTotal += visit(directory.directories[index], [...path, index]);
      }
    } else {
      for (let index = 0; index < directory.items.length; index += 1) {
        const item = directory.items[index];
        if (item.type !== "amount") continue;
        const result = amountToCnyScale4(item, state);
        if (!result.ok) {
          errors.push(`${section === "confirmed" ? "确定资产" : "待定资产"} / ${directory.name || "未命名目录"} / ${item.name || `第 ${index + 1} 项`}：${result.error}`);
          continue;
        }
        const signed = isNegativeDirection(item.direction) ? -result.value : result.value;
        directoryTotal += signed;
        totals[item.direction] += signed;
      }
    }
    directoryTotals.set(`${section}:${path.join(".")}`, directoryTotal);
    return directoryTotal;
  };

  state[section].directories.forEach((directory, index) => visit(directory, [index]));
  return totals;
}

// 将单条原币金额转换为四位人民币定点整数，不在此阶段应用正负方向。
export function amountToCnyScale4(item, state) {
  const currency = normalizeCurrency(item.currency);
  if (!currency) return { ok: false, error: "缺少货币" };
  const amount = parseUnsignedDecimal(item.amount);
  if (!amount) return { ok: false, error: "金额格式无效" };

  if (currency === "CNY") {
    return { ok: true, value: rescaleHalfUp(amount.integer, amount.scale, INTERNAL_SCALE) };
  }

  if (state.conversionMode === "per-entry") {
    const converted = parseUnsignedDecimal(item.convertedCNY);
    if (!converted) return { ok: false, error: "缺少有效的人民币折算结果" };
    return { ok: true, value: rescaleHalfUp(converted.integer, converted.scale, INTERNAL_SCALE) };
  }

  // 统一中间汇率模式使用“原币金额 × 对人民币汇率”，最后四舍五入到四位。
  const rateRecord = state.exchangeRates[currency];
  const rate = parseUnsignedDecimal(rateRecord?.rateToCNY);
  if (!rate || rate.integer <= 0n) return { ok: false, error: `缺少 ${currency} 的有效汇率` };
  return {
    ok: true,
    value: rescaleHalfUp(amount.integer * rate.integer, amount.scale + rate.scale, INTERNAL_SCALE),
  };
}

// 把非负十进制文本解析为“整数 + 小数位数”，全程避免二进制浮点误差。
export function parseUnsignedDecimal(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > 8) return null;
  return {
    integer: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

// 把非负整数从任意十进制精度四舍五入到目标精度。
export function rescaleHalfUp(integer, sourceScale, targetScale) {
  if (sourceScale === targetScale) return integer;
  if (sourceScale < targetScale) return integer * 10n ** BigInt(targetScale - sourceScale);
  const divisor = 10n ** BigInt(sourceScale - targetScale);
  const quotient = integer / divisor;
  const remainder = integer % divisor;
  return remainder * 2n >= divisor ? quotient + 1n : quotient;
}

// 将四位定点有符号金额严格向数轴左侧取整到人民币分。
export function floorScale4ToCents(value) {
  let quotient = value / FEN_FACTOR;
  const remainder = value % FEN_FACTOR;
  // BigInt 除法趋向零；负数存在余数时必须再减一分才是数学 floor。
  if (value < 0n && remainder !== 0n) quotient -= 1n;
  return quotient;
}

// 把四位定点整数格式化为带千位分隔符的人民币数值文本。
export function formatScale4(value, options = {}) {
  const sign = value < 0n ? "−" : options.showPlus && value > 0n ? "+" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / SCALE_FACTOR;
  const fraction = String(absolute % SCALE_FACTOR).padStart(INTERNAL_SCALE, "0");
  return `${sign}${groupDigits(whole.toString())}.${fraction}`;
}

// 把人民币分格式化为两位小数，并按需要展示正号。
export function formatCents(cents, options = {}) {
  const sign = cents < 0n ? "−" : options.showPlus && cents > 0n ? "+" : "";
  const absolute = cents < 0n ? -cents : cents;
  const whole = absolute / 100n;
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${sign}¥${groupDigits(whole.toString())}.${fraction}`;
}

// 检查当前实际使用的汇率是否缺失、过期或具有异常时间。
export function getRateIssues(state, now = Date.now()) {
  if (state.conversionMode !== "shared-rate") return [];
  const issues = [];
  for (const currency of listUsedCurrencies(state)) {
    const record = state.exchangeRates[currency];
    if (!record || !parseUnsignedDecimal(record.rateToCNY) || Number(record.rateToCNY) <= 0) {
      issues.push({ currency, type: "missing", message: `${currency} 缺少有效汇率` });
      continue;
    }
    const timestamp = Date.parse(record.updatedAt);
    if (Number.isNaN(timestamp)) {
      issues.push({ currency, type: "unknown", message: `${currency} 更新时间未知` });
    } else if (timestamp > now + 60_000) {
      issues.push({ currency, type: "future", message: `${currency} 更新时间晚于当前时间` });
    } else if (now - timestamp > 24 * 60 * 60 * 1000) {
      const days = Math.floor((now - timestamp) / (24 * 60 * 60 * 1000));
      issues.push({ currency, type: "stale", message: `${currency} 汇率已超过 ${Math.max(days, 1)} 天` });
    }
  }
  return issues;
}

// 读取指定目录的计算小计；尚未生成时安全回落到零。
export function directoryTotalFor(calculation, section, path) {
  return calculation.directoryTotals.get(`${section}:${path.join(".")}`) ?? 0n;
}

// 判断方向是否应作为负数计入汇总。
function isNegativeDirection(direction) {
  return direction === "deduct" || direction === "outflow";
}

// 为纯数字字符串添加千位分隔符。
function groupDigits(value) {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
