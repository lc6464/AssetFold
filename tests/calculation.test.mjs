// AssetFold 计算回归测试：使用无现实含义的合成数据覆盖定点运算和结构约束。

import assert from "node:assert/strict";
import { calculateState, formatCents } from "../scripts/calculation.js";
import { createMarkdown } from "../scripts/import-export.js";
import { createInitialState, validateState } from "../scripts/model.js";

// 创建只含一个叶目录的合成状态，便于聚焦验证计算规则。
function createConfirmedState(items) {
    const state = createInitialState();
    state.confirmed.directories = [{ name: "测试目录", items }];
    return state;
}

// 创建一条合成金额，测试只覆盖必要字段。
function createConfirmedAmount(amount, direction = "add") {
    return {
        type: "amount",
        name: "合成金额",
        amount,
        currency: "CNY",
        direction,
        note: ""
    };
}

// 使用带数学常数特征且跨越多个数量级的数列验证批量累加。
{
    const values = [
        "987654321.09", "123456789.87", "31415926.53", "27182818.28",
        "161803398.87", "999999999.99", "42.42", "0.11"
    ];
    const state = createConfirmedState(values.map((value) => createConfirmedAmount(value)));
    const result = calculateState(state);

    assert.equal(result.complete, true);
    assert.equal(formatCents(result.displayCents.confirmed), "¥2,331,513,297.16");
}

// 大额负数不能按趋向零截断，存在余数时必须继续向数轴左侧取整。
{
    const state = createConfirmedState([createConfirmedAmount("9876543.2101", "deduct")]);
    const result = calculateState(state);

    assert.equal(formatCents(result.displayCents.confirmed), "−¥9,876,543.22");
}

// 单条合成折算结果先四舍五入到四位，再在最终汇总阶段向下取整到分。
{
    const state = createConfirmedState([{
        ...createConfirmedAmount("999999999.99999999"),
        currency: "CHF",
        convertedCNY: "123456789.87655"
    }]);
    state.conversionMode = "per-entry";
    const result = calculateState(state);

    assert.equal(result.raw.confirmed, 1234567898766n);
    assert.equal(formatCents(result.displayCents.confirmed), "¥123,456,789.87");
}

// 统一汇率使用具有规律的大数执行整数定点乘法，避免二进制浮点误差。
{
    const state = createConfirmedState([{
        ...createConfirmedAmount("12345678.90"),
        currency: "SGD"
    }]);
    state.exchangeRates.SGD = {
        rateToCNY: "0.8",
        updatedAt: "2000-01-01T00:00:00+00:00",
        source: "manual"
    };
    const result = calculateState(state);

    assert.equal(result.raw.confirmed, 98765431200n);
    assert.equal(formatCents(result.displayCents.confirmed), "¥9,876,543.12");
}

// 四项结果分别下整，预计资产必须从未下整的原始值重新计算。
{
    const state = createConfirmedState([createConfirmedAmount("0.0099")]);
    state.pending.directories = [{
        name: "待定测试",
        items: [
            { type: "amount", name: "流入", amount: "0.0099", currency: "CNY", direction: "inflow", note: "" },
            { type: "amount", name: "流出", amount: "0.0001", currency: "CNY", direction: "outflow", note: "" }
        ]
    }];
    const result = calculateState(state);

    assert.equal(formatCents(result.displayCents.confirmed), "¥0.00");
    assert.equal(formatCents(result.displayCents.inflow), "¥0.00");
    assert.equal(formatCents(result.displayCents.outflow), "−¥0.01");
    assert.equal(formatCents(result.displayCents.projected), "¥0.01");
}

// 数据校验器拒绝同目录混放子目录与条目，也拒绝超过四级的目录结构。
{
    const mixedState = createInitialState();
    mixedState.confirmed.directories = [{
        name: "混合目录",
        directories: [],
        items: []
    }];
    assert.match(validateState(mixedState).join("；"), /必须且只能包含子目录或条目/);

    const deepState = createInitialState();
    let directory = { name: "第 5 级", items: [] };
    for (let level = 4; level >= 1; level -= 1) {
        directory = { name: `第 ${level} 级`, directories: [directory] };
    }
    deepState.confirmed.directories = [directory];
    assert.match(validateState(deepState).join("；"), /超过四级目录限制/);

    const emptyFourthLevelState = createInitialState();
    emptyFourthLevelState.confirmed.directories = [{
        name: "第 1 级",
        directories: [{
            name: "第 2 级",
            directories: [{
                name: "第 3 级",
                directories: [{ name: "第 4 级", directories: [] }]
            }]
        }]
    }];
    assert.deepEqual(validateState(emptyFourthLevelState), []);

    const unsupportedCurrencyState = createConfirmedState([createConfirmedAmount("1.00")]);
    unsupportedCurrencyState.confirmed.directories[0].items[0].currency = "ZZZ";
    assert.match(validateState(unsupportedCurrencyState).join("；"), /使用了不支持的货币/);
}

// Markdown 中的每一级小计都带目录名称，连续出现时仍可明确对应来源。
{
    const state = createInitialState();
    state.confirmed.directories = [{
        name: "合成父目录",
        directories: [{
            name: "合成叶目录",
            items: [createConfirmedAmount("123.45")]
        }]
    }];
    const result = createMarkdown(state, new Date("2000-01-01T00:00:00+00:00"));

    assert.equal(result.ok, true);
    assert.match(result.content, /合成叶目录 小计：123\.4500 CNY/);
    assert.match(result.content, /合成父目录 小计：123\.4500 CNY/);
}

console.log("AssetFold calculation tests passed.");
