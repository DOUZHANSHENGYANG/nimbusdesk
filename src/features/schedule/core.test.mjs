/**
 * 定时任务纯逻辑（core.ts）的单测。
 *
 * describeFrequency / weekdayNames 的文案要过**真实的 zh / en 键表**：
 * 表从 `src/lib/i18n.ts` 的对象字面量里抠出来求值（与 scripts/check-i18n.mjs
 * 同一套手法 —— 测试进程解析不了 `@/` 路径别名，但字面量是纯数据）。
 * 这样 i18n 表里的占位符写错（{{dasy}}、漏 {{time}}）会在这里直接炸出来。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
    FREQUENCY_KINDS,
    blankTask,
    defaultFrequency,
    describeFrequency,
    errorLabel,
    formatStamp,
    localDateTime,
    statusLabel,
    validateFrequency,
    validateTask,
    weekdayNames,
} from "./core.ts";

const I18N_DIR = new URL("../../lib/locales/", import.meta.url);
const ZH_FILE = fileURLToPath(new URL("zh.ts", I18N_DIR));
const EN_FILE = fileURLToPath(new URL("en.ts", I18N_DIR));

function extractObject(src, name) {
    const m = new RegExp(`const ${name}\\s*(?::[^=]+)?=\\s*\\{`).exec(src);
    if (!m) throw new Error(`i18n.ts 里找不到 const ${name} = {`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (escaped) { escaped = false; continue; }
        if (quote) {
            if (ch === "\\") escaped = true;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
        if (ch === "{") depth++;
        else if (ch === "}") {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`${name} 的对象字面量没有闭合`);
}

/** 走真实键表的 t：与 i18next 一样替换 {{var}}，缺的键直接返回键名 */
function makeT(table) {
    return (key, options) => {
        const parts = key.split(".");
        let value = table;
        for (const part of parts) {
            value = value?.[part];
            if (value === undefined) return key;
        }
        return String(value).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => String(options?.[name] ?? `{{${name}}}`));
    };
}

const zhTable = new Function(`return (${extractObject(readFileSync(ZH_FILE, "utf8"), "zh")})`)();
const enTable = new Function(`return (${extractObject(readFileSync(EN_FILE, "utf8"), "en")})`)();
const tZh = makeT(zhTable);
const tEn = makeT(enTable);

const DAY = (n) => ({ kind: "daily", time: `0${n}:30`.slice(-5) });

test("frequency descriptions read naturally in both languages", () => {
    assert.equal(describeFrequency({ kind: "once", at: "2026-10-22T09:30" }, tZh), "2026-10-22 09:30 运行一次");
    assert.equal(describeFrequency({ kind: "once", at: "2026-10-22T09:30" }, tEn), "Runs once at 2026-10-22 09:30");
    assert.equal(describeFrequency(DAY(9), tZh), "每天 09:30");
    assert.equal(describeFrequency(DAY(9), tEn), "Every day at 09:30");
    assert.equal(describeFrequency({ kind: "weekly", weekdays: [1, 5], time: "07:00" }, tZh), "每周一、周五 07:00");
    assert.equal(describeFrequency({ kind: "weekly", weekdays: [1, 5], time: "07:00" }, tEn), "Mon, Fri at 07:00");
    assert.equal(describeFrequency({ kind: "monthly", day: 31, time: "06:00" }, tZh), "每月 31 号 06:00");
    assert.equal(describeFrequency({ kind: "monthly", day: 31, time: "06:00" }, tEn), "Day 31 of every month at 06:00");
    assert.equal(describeFrequency({ kind: "yearly", month: 2, day: 29, time: "08:00" }, tZh), "每年 2 月 29 号 08:00");
    assert.equal(describeFrequency({ kind: "yearly", month: 2, day: 29, time: "08:00" }, tEn), "Every year on 2/29 at 08:00");
    assert.equal(describeFrequency({ kind: "interval", minutes: 30 }, tZh), "每 30 分钟");
    assert.equal(describeFrequency({ kind: "interval", minutes: 30 }, tEn), "Every 30 minutes");
});

test("weekday names dedupe, sort Monday-first and join with the language's separator", () => {
    assert.equal(weekdayNames([5, 1, 5], tZh), "周一、周五");
    assert.equal(weekdayNames([7], tEn), "Sun");
    assert.equal(weekdayNames([], tZh), "");
});

test("the i18n tables define every key the six frequencies and weekdays need", () => {
    for (const t of [tZh, tEn]) {
        for (const kind of FREQUENCY_KINDS) {
            assert.notEqual(t(`schedule.kind.${kind}`), `schedule.kind.${kind}`, `kind.${kind}`);
            const described = describeFrequency(defaultFrequency(kind, new Date(2026, 0, 1, 9, 30)), t);
            assert.ok(!described.includes("{{"), `${kind} 的占位符没被替换: ${described}`);
            assert.ok(described.trim().length > 0, `${kind} 的描述为空`);
        }
        for (let day = 1; day <= 7; day++) assert.notEqual(t(`schedule.weekday.${day}`), `schedule.weekday.${day}`, `weekday.${day}`);
        assert.equal(t("schedule.weekdaySep").length > 0, true);
    }
    assert.deepEqual(FREQUENCY_KINDS, ["once", "daily", "weekly", "monthly", "yearly", "interval"]);
});

test("validateFrequency accepts well-formed values of all six kinds", () => {
    const now = new Date("2026-10-22T09:00:00");
    assert.equal(validateFrequency({ kind: "once", at: "2026-10-22T09:30" }, now), null);
    assert.equal(validateFrequency(DAY(9), now), null);
    assert.equal(validateFrequency({ kind: "weekly", weekdays: [1, 5], time: "07:00" }, now), null);
    assert.equal(validateFrequency({ kind: "monthly", day: 31, time: "06:00" }, now), null);
    assert.equal(validateFrequency({ kind: "yearly", month: 2, day: 29, time: "08:00" }, now), null);
    assert.equal(validateFrequency({ kind: "interval", minutes: 1440 }, now), null);
});

test("validateFrequency rejects broken dates and past one-shots", () => {
    const now = new Date("2026-10-22T09:00:00");
    for (const at of ["", "2026-13-01T00:00", "2026-02-30T10:00", "2026-10-22", "2026-10-22T25:00", "nonsense"]) {
        assert.equal(validateFrequency({ kind: "once", at }, now), "schedule.err.dateInvalid", at);
    }
    // 2 月 30 日哪一年都不存在
    assert.equal(validateFrequency({ kind: "yearly", month: 2, day: 30, time: "08:00" }, now), "schedule.err.dayRange");
    // 2 月 29 日留给闰年
    assert.equal(validateFrequency({ kind: "yearly", month: 2, day: 29, time: "08:00" }, now), null);
    // 已经过去的一次性排了也不会跑，保存时就该说清楚
    assert.equal(validateFrequency({ kind: "once", at: "2026-10-22T08:59" }, now), "schedule.err.oncePast");
});

test("validateFrequency rejects broken times and out-of-range numbers", () => {
    const now = new Date("2026-10-22T09:00:00");
    for (const time of ["", "25:00", "12:60", "9", "aa:bb"]) {
        assert.equal(validateFrequency({ kind: "daily", time }, now), "schedule.err.timeInvalid", time);
        assert.equal(validateFrequency({ kind: "weekly", weekdays: [1], time }, now), "schedule.err.timeInvalid", time);
    }
    assert.equal(validateFrequency({ kind: "weekly", weekdays: [], time: "07:00" }, now), "schedule.err.weekdaysEmpty");
    assert.equal(validateFrequency({ kind: "weekly", weekdays: [0, 8], time: "07:00" }, now), "schedule.err.weekdaysEmpty");
    for (const day of [0, 32, 1.5]) assert.equal(validateFrequency({ kind: "monthly", day, time: "06:00" }, now), "schedule.err.dayRange", String(day));
    for (const month of [0, 13, 2.5]) assert.equal(validateFrequency({ kind: "yearly", month, day: 1, time: "06:00" }, now), "schedule.err.monthRange", String(month));
    for (const minutes of [0, 1441, 2.5]) assert.equal(validateFrequency({ kind: "interval", minutes }, now), "schedule.err.minutesRange", String(minutes));
});

test("validateTask guards name, action choice and AI parameters", () => {
    const now = new Date("2026-10-22T09:00:00");
    const base = { name: "晨报", frequency: DAY(9), action: { id: "backup", params: {} }, enabled: true, runIfMissed: false };
    assert.equal(validateTask(base, now), null);
    assert.equal(validateTask({ ...base, name: "  " }, now), "schedule.err.nameRequired");
    assert.equal(validateTask({ ...base, name: "字".repeat(101) }, now), "schedule.err.nameTooLong");
    assert.equal(validateTask({ ...base, frequency: DAY("aa") }, now), "schedule.err.timeInvalid");
    assert.equal(validateTask({ ...base, action: { id: "", params: {} } }, now), "schedule.err.actionRequired");
    // AI 动作：提示词与指令至少要有一个
    assert.equal(validateTask({ ...base, action: { id: "ai_prompt", params: {} } }, now), "schedule.err.aiPromptRequired");
    assert.equal(validateTask({ ...base, action: { id: "ai_prompt", params: { promptId: "p1" } } }, now), null);
    assert.equal(validateTask({ ...base, action: { id: "ai_prompt", params: { instruction: "写日报" } } }, now), null);
});

test("formatStamp renders timestamps for humans and tolerates junk", () => {
    assert.equal(formatStamp("2026-10-22T09:30:00"), "2026-10-22 09:30");
    assert.equal(formatStamp("2026-10-22T09:30"), "2026-10-22 09:30");
    assert.equal(formatStamp(null), "");
    assert.equal(formatStamp(undefined), "");
    assert.equal(formatStamp(""), "");
});

test("statusLabel and errorLabel map the three states and known error codes", () => {
    for (const status of ["success", "failed", "skipped", "unknown"]) {
        assert.equal(statusLabel(status), `schedule.history.status.${status}`);
    }
    assert.equal(statusLabel("weird"), "schedule.history.status.unknown");
    assert.deepEqual(errorLabel("SCHEDULE_TIMEOUT: 60000ms"), { code: "SCHEDULE_TIMEOUT", key: "schedule.errCode.SCHEDULE_TIMEOUT" });
    assert.equal(errorLabel("SOMETHING_NEW: details").key, null);
    assert.equal(errorLabel("SOMETHING_NEW: details").code, "SOMETHING_NEW");
    assert.equal(errorLabel("").key, null);
});

test("defaultFrequency gives usable defaults: once lands in the future, interval within range", () => {
    const now = new Date(2026, 9, 22, 9, 30);
    const once = defaultFrequency("once", now);
    assert.equal(once.kind, "once");
    assert.ok(new Date(once.at).getTime() > now.getTime(), "一次性默认在一小时后");
    assert.deepEqual(defaultFrequency("weekly", now), { kind: "weekly", weekdays: [1], time: "09:30" });
    assert.deepEqual(defaultFrequency("monthly", now), { kind: "monthly", day: 1, time: "09:30" });
    assert.deepEqual(defaultFrequency("yearly", now), { kind: "yearly", month: 1, day: 1, time: "09:30" });
    assert.deepEqual(defaultFrequency("interval", now), { kind: "interval", minutes: 30 });
    for (const kind of FREQUENCY_KINDS) assert.equal(validateFrequency(defaultFrequency(kind, now), now), null, kind);
});

test("localDateTime and blankTask shape the editor's draft", () => {
    assert.equal(localDateTime(new Date(2026, 9, 22, 9, 5)), "2026-10-22T09:05");
    assert.equal(localDateTime(new Date(2026, 0, 1, 0, 0)), "2026-01-01T00:00");
    const draft = blankTask(new Date(2026, 9, 22, 9, 0));
    assert.equal(draft.name, "");
    assert.equal(draft.action.id, "ai_prompt");
    assert.equal(draft.enabled, true);
    assert.equal(draft.runIfMissed, false);
    assert.deepEqual(draft.action.params, { promptId: "", instruction: "", title: "" });
});
