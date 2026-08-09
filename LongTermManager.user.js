// ==UserScript==
// @name         长期事项管理器 LongTerm Manager
// @namespace    https://local.longterm.manager/
// @version      1.0.1
// @updateURL    https://raw.githubusercontent.com/lph112358/LongTermManager/main/LongTermManager.user.js
// @downloadURL  https://raw.githubusercontent.com/lph112358/LongTermManager/main/LongTermManager.user.js
// @description  极简长期到期事项管理器。V1.0.0 正式版：长期到期提醒、循环续费、卡片管理、筛选统计、本地备份与数据恢复。
// @author       You
// @match        http://*/*
// @match        https://*/*
// @run-at       document-end
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_addStyle
// ==/UserScript==

(() => {
    'use strict';

    /* =========================================================
     * 01. Config
     * ======================================================= */
    const Config = Object.freeze({
        APP_NAME: '长期事项管理器',
        APP_VERSION: '1.0.0',
        SCHEMA_VERSION: 1,
        MANAGER_URL: 'https://example.com/#long-term-manager',
        MANAGER_HOST: 'example.com',
        MANAGER_HASH: '#long-term-manager',
        STORAGE_KEYS: Object.freeze({
            DATABASE: 'ltm_database',
            SNAPSHOTS: 'ltm_snapshots',
            RUNTIME: 'ltm_runtime',
        }),
        DEFAULT_REMINDER_DAYS: [30, 7, 1, 0],
        DEFAULT_CURRENCY: 'CNY',
        CURRENCIES: Object.freeze([
            ['CNY', '¥'],
            ['USD', '$'],
            ['EUR', '€'],
            ['GBP', '£'],
            ['JPY', '¥'],
            ['HKD', 'HK$'],
        ]),
        DEFAULT_CATEGORIES: Object.freeze([
            ['cat_subscription', '订阅'],
            ['cat_server', '服务器'],
            ['cat_domain', '域名'],
            ['cat_software', '软件'],
            ['cat_insurance', '保险'],
            ['cat_document', '证件'],
            ['cat_contract', '合同'],
            ['cat_device', '设备'],
            ['cat_other', '其他'],
        ]),
    });

    /* =========================================================
     * 02. Utils
     * ======================================================= */
    const Utils = {
        deepClone(value) {
            if (typeof structuredClone === 'function') return structuredClone(value);
            return JSON.parse(JSON.stringify(value));
        },

        id(prefix = 'id') {
            if (globalThis.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
            const rand = Math.random().toString(36).slice(2, 12);
            return `${prefix}_${Date.now().toString(36)}_${rand}`;
        },

        pad2(n) {
            return String(n).padStart(2, '0');
        },

        todayString() {
            const d = new Date();
            return `${d.getFullYear()}-${this.pad2(d.getMonth() + 1)}-${this.pad2(d.getDate())}`;
        },

        nowLocalISOString() {
            const d = new Date();
            const offset = -d.getTimezoneOffset();
            const sign = offset >= 0 ? '+' : '-';
            const oh = this.pad2(Math.floor(Math.abs(offset) / 60));
            const om = this.pad2(Math.abs(offset) % 60);
            return `${d.getFullYear()}-${this.pad2(d.getMonth() + 1)}-${this.pad2(d.getDate())}` +
                `T${this.pad2(d.getHours())}:${this.pad2(d.getMinutes())}:${this.pad2(d.getSeconds())}` +
                `${sign}${oh}:${om}`;
        },

        escapeHTML(value) {
            return String(value ?? '')
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#039;');
        },

        normalizeText(value) {
            return String(value ?? '').trim().toLowerCase();
        },

        parseDateParts(dateString) {
            const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
            if (!match) return null;
            const year = Number(match[1]);
            const month = Number(match[2]);
            const day = Number(match[3]);
            const test = new Date(Date.UTC(year, month - 1, day));
            if (
                test.getUTCFullYear() !== year ||
                test.getUTCMonth() + 1 !== month ||
                test.getUTCDate() !== day
            ) return null;
            return { year, month, day };
        },

        safeHttpUrl(value) {
            const text = String(value ?? '').trim();
            if (!text) return '';
            try {
                const u = new URL(text);
                if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
                return u.href;
            } catch {
                return '';
            }
        },

        currencySymbol(code) {
            return Config.CURRENCIES.find(([c]) => c === code)?.[1] || code || '';
        },

        formatAmount(amount, currency) {
            if (amount === null || amount === undefined || amount === '') return '';
            const symbol = this.currencySymbol(currency);
            const num = Number(amount);
            if (!Number.isFinite(num)) return '';
            return `${symbol}${Number.isInteger(num) ? num : num.toFixed(2)}`;
        },


        downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
            const blob = new Blob([text], { type: mime });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1500);
        },

        csvCell(value) {
            const text = String(value ?? '');
            return `"${text.replaceAll('"', '""')}"`;
        },
    };

    /* =========================================================
     * 03. DateEngine — 自然日 / 循环顺延核心
     * ======================================================= */
    const DateEngine = {
        dayNumber(dateString) {
            const p = Utils.parseDateParts(dateString);
            if (!p) return null;
            return Math.floor(Date.UTC(p.year, p.month - 1, p.day) / 86400000);
        },

        fromDayNumber(dayNumber) {
            const d = new Date(dayNumber * 86400000);
            return `${d.getUTCFullYear()}-${Utils.pad2(d.getUTCMonth() + 1)}-${Utils.pad2(d.getUTCDate())}`;
        },

        daysFromToday(dateString) {
            const target = this.dayNumber(dateString);
            const today = this.dayNumber(Utils.todayString());
            if (target === null || today === null) return null;
            return target - today;
        },

        dueLabel(dateString) {
            const days = this.daysFromToday(dateString);
            if (days === null) return '日期无效';
            if (days < 0) return `已逾期 ${Math.abs(days)} 天`;
            if (days === 0) return '今天';
            return `${days} 天后`;
        },

        riskClass(dateString) {
            const days = this.daysFromToday(dateString);
            if (days === null) return 'neutral';
            if (days <= 7) return 'danger';
            if (days <= 30) return 'warning';
            if (days <= 90) return 'notice';
            return 'neutral';
        },

        anchorFromDate(dateString) {
            const p = Utils.parseDateParts(dateString);
            if (!p) return { month: null, day: null };
            return { month: p.month, day: p.day };
        },

        daysInMonth(year, month) {
            return new Date(Date.UTC(year, month, 0)).getUTCDate();
        },

        formatParts(year, month, day) {
            return `${year}-${Utils.pad2(month)}-${Utils.pad2(day)}`;
        },

        addDays(dateString, days) {
            const base = this.dayNumber(dateString);
            if (base === null) throw new Error('日期无效');
            return this.fromDayNumber(base + days);
        },

        addMonths(dateString, months, anchorDay = null) {
            const p = Utils.parseDateParts(dateString);
            if (!p) throw new Error('日期无效');
            const total = (p.year * 12 + (p.month - 1)) + months;
            const year = Math.floor(total / 12);
            const month = ((total % 12) + 12) % 12 + 1;
            const desiredDay = Number(anchorDay) || p.day;
            const day = Math.min(desiredDay, this.daysInMonth(year, month));
            return this.formatParts(year, month, day);
        },

        addYears(dateString, years, anchor = null) {
            const p = Utils.parseDateParts(dateString);
            if (!p) throw new Error('日期无效');
            const year = p.year + years;
            const month = Number(anchor?.month) || p.month;
            const desiredDay = Number(anchor?.day) || p.day;
            const day = Math.min(desiredDay, this.daysInMonth(year, month));
            return this.formatParts(year, month, day);
        },

        addOneCycle(dateString, recurrence, anchor) {
            if (!recurrence?.enabled) throw new Error('该事项没有循环周期');
            const interval = Number(recurrence.interval);
            if (!Number.isInteger(interval) || interval <= 0) throw new Error('循环周期无效');
            if (recurrence.unit === 'day') return this.addDays(dateString, interval);
            if (recurrence.unit === 'month') return this.addMonths(dateString, interval, anchor?.day);
            if (recurrence.unit === 'year') return this.addYears(dateString, interval, anchor);
            throw new Error('循环周期单位无效');
        },

        previewCompletion(item, handledDate = Utils.todayString()) {
            if (!item) throw new Error('找不到该事项');
            if (item.type === 'oneTime') {
                return {
                    handledDate,
                    previousDueDate: item.dueDate,
                    nextDueDate: null,
                    skippedCycles: 1,
                    nextAnchor: item.anchor || this.anchorFromDate(item.dueDate),
                };
            }

            if (!item.recurrence?.enabled) throw new Error('循环事项缺少重复周期');
            const previousDueDate = item.dueDate;
            let nextAnchor = item.anchor || this.anchorFromDate(previousDueDate);
            let nextDueDate;
            let skippedCycles = 0;

            if (item.renewalMode === 'handled') {
                const handledNum = this.dayNumber(handledDate);
                const dueNum = this.dayNumber(previousDueDate);
                if (handledNum === null || dueNum === null) throw new Error('处理日期无效');

                // “按实际处理日”只在逾期处理时重置账期。
                // 如果在到期日之前（或当天）提前续费，仍从当前到期日顺延一周期，
                // 避免把尚未用完的剩余周期吃掉，也避免同一天重复点击时日期不前进。
                if (handledNum > dueNum) {
                    nextAnchor = this.anchorFromDate(handledDate);
                    nextDueDate = this.addOneCycle(handledDate, item.recurrence, nextAnchor);
                } else {
                    nextDueDate = this.addOneCycle(previousDueDate, item.recurrence, nextAnchor);
                }
                skippedCycles = 1;
            } else {
                nextDueDate = previousDueDate;
                const todayNum = this.dayNumber(handledDate);
                if (todayNum === null) throw new Error('处理日期无效');
                do {
                    nextDueDate = this.addOneCycle(nextDueDate, item.recurrence, nextAnchor);
                    skippedCycles += 1;
                    if (skippedCycles > 10000) throw new Error('循环日期计算异常');
                } while (this.dayNumber(nextDueDate) <= todayNum);
            }

            return { handledDate, previousDueDate, nextDueDate, skippedCycles, nextAnchor };
        },
    };

    /* =========================================================
     * 04. Models / Defaults
     * ======================================================= */
    const Models = {
        defaultCategories() {
            const now = Utils.nowLocalISOString();
            return Config.DEFAULT_CATEGORIES.map(([id, name], index) => ({
                id,
                name,
                builtIn: true,
                order: index + 1,
                createdAt: now,
                updatedAt: now,
            }));
        },

        defaultSettings() {
            return {
                reminder: {
                    enabled: true,
                    dailyOnce: true,
                    remindOverdue: true,
                    popupDelaySeconds: 3,
                },
                defaults: {
                    currency: Config.DEFAULT_CURRENCY,
                    reminderDays: [...Config.DEFAULT_REMINDER_DAYS],
                    renewalMode: 'scheduled',
                },
                filters: {
                    statusView: 'active',
                    categoryId: null,
                    dueRange: 'all',
                    customStart: '',
                    customEnd: '',
                    itemType: 'all',
                    currency: null,
                    sort: 'dueAsc',
                },
                ui: {
                    activeTab: 'items',
                },
            };
        },

        createDatabase() {
            const now = Utils.nowLocalISOString();
            return {
                schemaVersion: Config.SCHEMA_VERSION,
                appVersion: Config.APP_VERSION,
                createdAt: now,
                updatedAt: now,
                items: [],
                categories: this.defaultCategories(),
                settings: this.defaultSettings(),
            };
        },

        recurrenceFromPreset(preset, customInterval = 1, customUnit = 'month') {
            switch (preset) {
                case 'month1': return { enabled: true, interval: 1, unit: 'month' };
                case 'month3': return { enabled: true, interval: 3, unit: 'month' };
                case 'month6': return { enabled: true, interval: 6, unit: 'month' };
                case 'year1': return { enabled: true, interval: 1, unit: 'year' };
                case 'custom': return { enabled: true, interval: Number(customInterval), unit: customUnit };
                default: return { enabled: false, interval: null, unit: null };
            }
        },

        recurrencePreset(recurrence) {
            if (!recurrence?.enabled) return 'none';
            const { interval, unit } = recurrence;
            if (unit === 'month' && interval === 1) return 'month1';
            if (unit === 'month' && interval === 3) return 'month3';
            if (unit === 'month' && interval === 6) return 'month6';
            if (unit === 'year' && interval === 1) return 'year1';
            return 'custom';
        },
    };

    /* =========================================================
     * 05. Storage
     * ======================================================= */
    const Storage = {
        loadDatabase() {
            const raw = GM_getValue(Config.STORAGE_KEYS.DATABASE, null);
            if (!raw || typeof raw !== 'object') {
                const fresh = Models.createDatabase();
                this.saveDatabase(fresh);
                return fresh;
            }
            return this.normalizeDatabase(raw);
        },

        normalizeItem(rawItem) {
            const now = Utils.nowLocalISOString();
            const item = rawItem && typeof rawItem === 'object' ? Utils.deepClone(rawItem) : {};
            item.id = typeof item.id === 'string' && item.id ? item.id : Utils.id('item');
            item.name = String(item.name ?? '未命名事项').trim() || '未命名事项';
            item.type = ['recurring', 'oneTime'].includes(item.type)
                ? item.type
                : (item.recurrence?.enabled ? 'recurring' : 'oneTime');
            item.categoryId = typeof item.categoryId === 'string' && item.categoryId ? item.categoryId : null;
            item.dueDate = Utils.parseDateParts(item.dueDate) ? item.dueDate : Utils.todayString();

            if (item.type === 'recurring') {
                const recurrence = item.recurrence && typeof item.recurrence === 'object' ? item.recurrence : {};
                const interval = Number(recurrence.interval);
                const unit = ['day', 'month', 'year'].includes(recurrence.unit) ? recurrence.unit : 'year';
                item.recurrence = { enabled: true, interval: Number.isInteger(interval) && interval > 0 ? interval : 1, unit };
                item.renewalMode = ['scheduled', 'handled'].includes(item.renewalMode) ? item.renewalMode : 'scheduled';
            } else {
                item.recurrence = { enabled: false, interval: null, unit: null };
                item.renewalMode = null;
            }

            const anchor = item.anchor && typeof item.anchor === 'object' ? item.anchor : {};
            const fallbackAnchor = DateEngine.anchorFromDate(item.dueDate);
            item.anchor = {
                month: Number.isInteger(Number(anchor.month)) ? Number(anchor.month) : fallbackAnchor.month,
                day: Number.isInteger(Number(anchor.day)) ? Number(anchor.day) : fallbackAnchor.day,
            };

            if (item.amount === '' || item.amount === undefined || item.amount === null) item.amount = null;
            else {
                const n = Number(item.amount);
                item.amount = Number.isFinite(n) && n >= 0 ? n : null;
            }
            item.currency = item.amount !== null && Config.CURRENCIES.some(([code]) => code === item.currency) ? item.currency : (item.amount !== null ? Config.DEFAULT_CURRENCY : null);
            item.reminderDays = Array.isArray(item.reminderDays)
                ? [...new Set(item.reminderDays.map(Number).filter(n => Number.isInteger(n) && n >= 0))].sort((a,b)=>b-a)
                : [...Config.DEFAULT_REMINDER_DAYS];
            item.snoozeUntil = Utils.parseDateParts(item.snoozeUntil) ? item.snoozeUntil : null;
            item.url = typeof item.url === 'string' ? item.url.trim() : '';
            item.accountNote = typeof item.accountNote === 'string' ? item.accountNote : '';
            item.note = typeof item.note === 'string' ? item.note : '';
            item.status = ['active', 'paused', 'archived'].includes(item.status) ? item.status : 'active';
            item.trashedAt = typeof item.trashedAt === 'string' && item.trashedAt ? item.trashedAt : null;
            item.history = Array.isArray(item.history) ? item.history : [];
            item.createdAt = typeof item.createdAt === 'string' && item.createdAt ? item.createdAt : now;
            item.updatedAt = typeof item.updatedAt === 'string' && item.updatedAt ? item.updatedAt : item.createdAt;
            return item;
        },

        normalizeDatabase(raw) {
            const db = Utils.deepClone(raw);
            const defaults = Models.createDatabase();
            db.schemaVersion = Number.isInteger(Number(db.schemaVersion)) ? Number(db.schemaVersion) : Config.SCHEMA_VERSION;
            db.appVersion = typeof db.appVersion === 'string' ? db.appVersion : Config.APP_VERSION;
            db.createdAt ??= defaults.createdAt;
            db.updatedAt ??= defaults.updatedAt;
            db.items = Array.isArray(db.items) ? db.items.map(item => this.normalizeItem(item)) : [];
            db.categories = Array.isArray(db.categories) && db.categories.length
                ? db.categories.filter(c => c && typeof c === 'object').map((c, index) => ({
                    id: typeof c.id === 'string' && c.id ? c.id : Utils.id('cat'),
                    name: String(c.name ?? `分类${index + 1}`).trim() || `分类${index + 1}`,
                    builtIn: Boolean(c.builtIn),
                    order: Number.isFinite(Number(c.order)) ? Number(c.order) : index + 1,
                    createdAt: c.createdAt || defaults.createdAt,
                    updatedAt: c.updatedAt || defaults.updatedAt,
                }))
                : defaults.categories;
            db.settings = db.settings && typeof db.settings === 'object' ? db.settings : defaults.settings;
            db.settings.reminder = { ...defaults.settings.reminder, ...(db.settings.reminder || {}) };
            db.settings.defaults = { ...defaults.settings.defaults, ...(db.settings.defaults || {}) };
            db.settings.filters = { ...defaults.settings.filters, ...(db.settings.filters || {}) };
            db.settings.ui = { ...defaults.settings.ui, ...(db.settings.ui || {}) };
            return db;
        },

        saveDatabase(db) {
            const copy = Utils.deepClone(db);
            copy.appVersion = Config.APP_VERSION;
            copy.updatedAt = Utils.nowLocalISOString();
            GM_setValue(Config.STORAGE_KEYS.DATABASE, copy);
            return copy;
        },

        loadRuntime() {
            const raw = GM_getValue(Config.STORAGE_KEYS.RUNTIME, null);
            const runtime = raw && typeof raw === 'object' ? Utils.deepClone(raw) : {};
            runtime.lastAutoPopupDate = typeof runtime.lastAutoPopupDate === 'string' ? runtime.lastAutoPopupDate : null;
            runtime.mutedDate = typeof runtime.mutedDate === 'string' ? runtime.mutedDate : null;
            runtime.itemReminderState = runtime.itemReminderState && typeof runtime.itemReminderState === 'object'
                ? runtime.itemReminderState
                : {};
            return runtime;
        },

        saveRuntime(runtime) {
            const copy = Utils.deepClone(runtime || {});
            GM_setValue(Config.STORAGE_KEYS.RUNTIME, copy);
            return copy;
        },

        loadSnapshots() {
            const raw = GM_getValue(Config.STORAGE_KEYS.SNAPSHOTS, []);
            return Array.isArray(raw) ? Utils.deepClone(raw) : [];
        },

        saveSnapshots(snapshots) {
            const copy = Array.isArray(snapshots) ? Utils.deepClone(snapshots) : [];
            GM_setValue(Config.STORAGE_KEYS.SNAPSHOTS, copy);
            return copy;
        },
    };

    /* =========================================================
     * 06. Validation
     * ======================================================= */
    const Validation = {
        item(input) {
            const errors = [];
            const name = String(input.name ?? '').trim();
            if (!name) errors.push('名称不能为空');
            if (name.length > 100) errors.push('名称不能超过 100 个字符');
            if (String(input.note ?? '').length > 2000) errors.push('备注不能超过 2000 个字符');
            if (String(input.accountNote ?? '').length > 1000) errors.push('账号备注不能超过 1000 个字符');

            if (!['recurring', 'oneTime'].includes(input.type)) errors.push('事项类型无效');
            if (!Utils.parseDateParts(input.dueDate)) errors.push('请选择有效日期');

            const recurrence = input.recurrence || {};
            if (input.type === 'recurring') {
                if (!recurrence.enabled) errors.push('循环事项必须设置重复周期');
                if (!Number.isInteger(recurrence.interval) || recurrence.interval <= 0) {
                    errors.push('重复周期必须是大于 0 的整数');
                }
                if (!['day', 'month', 'year'].includes(recurrence.unit)) errors.push('重复周期单位无效');
            }

            if (input.amount !== null) {
                if (!Number.isFinite(input.amount) || input.amount < 0) errors.push('金额必须是大于等于 0 的数字');
                if (!Config.CURRENCIES.some(([code]) => code === input.currency)) errors.push('币种无效');
            }

            if (!['scheduled', 'handled', null].includes(input.renewalMode)) errors.push('顺延方式无效');
            if (!['active', 'paused', 'archived'].includes(input.status)) errors.push('状态无效');

            if (!Array.isArray(input.reminderDays) || input.reminderDays.some(n => !Number.isInteger(n) || n < 0)) {
                errors.push('提醒天数必须是大于等于 0 的整数');
            }

            if (input.url && !Utils.safeHttpUrl(input.url)) errors.push('网址必须以 http:// 或 https:// 开头');
            return errors;
        },
    };

    /* =========================================================
     * 07. ItemService
     * ======================================================= */
    const ItemService = {
        getDatabase() {
            return Storage.loadDatabase();
        },

        find(db, id) {
            return db.items.find(item => item.id === id) || null;
        },

        create(payload) {
            const db = Storage.loadDatabase();
            SnapshotManager.create('before-create', db);
            const now = Utils.nowLocalISOString();
            const item = {
                id: Utils.id('item'),
                name: payload.name,
                type: payload.type,
                categoryId: payload.categoryId || null,
                dueDate: payload.dueDate,
                recurrence: payload.recurrence,
                renewalMode: payload.type === 'recurring' ? payload.renewalMode : null,
                anchor: DateEngine.anchorFromDate(payload.dueDate),
                amount: payload.amount,
                currency: payload.amount === null ? null : payload.currency,
                reminderDays: payload.reminderDays,
                snoozeUntil: null,
                url: payload.url,
                accountNote: payload.accountNote,
                note: payload.note,
                status: payload.status,
                trashedAt: null,
                history: [],
                createdAt: now,
                updatedAt: now,
            };

            const errors = Validation.item(item);
            if (errors.length) throw new Error(errors.join('\n'));
            db.items.push(item);
            Storage.saveDatabase(db);
            return item;
        },

        update(id, payload) {
            const db = Storage.loadDatabase();
            SnapshotManager.create('before-edit', db);
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');

            const next = {
                ...item,
                name: payload.name,
                type: payload.type,
                categoryId: payload.categoryId || null,
                dueDate: payload.dueDate,
                recurrence: payload.recurrence,
                renewalMode: payload.type === 'recurring' ? payload.renewalMode : null,
                anchor: payload.dueDate === item.dueDate
                    ? (item.anchor || DateEngine.anchorFromDate(payload.dueDate))
                    : DateEngine.anchorFromDate(payload.dueDate),
                amount: payload.amount,
                currency: payload.amount === null ? null : payload.currency,
                reminderDays: payload.reminderDays,
                url: payload.url,
                accountNote: payload.accountNote,
                note: payload.note,
                status: payload.status,
                updatedAt: Utils.nowLocalISOString(),
            };

            const errors = Validation.item(next);
            if (errors.length) throw new Error(errors.join('\n'));
            Object.assign(item, next);
            Storage.saveDatabase(db);
            return item;
        },

        previewComplete(id, handledDate = Utils.todayString()) {
            const db = Storage.loadDatabase();
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');
            return DateEngine.previewCompletion(item, handledDate);
        },

        complete(id, handledDate = Utils.todayString(), historyNote = '') {
            const db = Storage.loadDatabase();
            SnapshotManager.create('before-complete', db);
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');
            if (item.trashedAt) throw new Error('回收站事项不能处理');

            const preview = DateEngine.previewCompletion(item, handledDate);
            const now = Utils.nowLocalISOString();
            const history = {
                id: Utils.id('history'),
                type: 'handled',
                handledDate: preview.handledDate,
                previousDueDate: preview.previousDueDate,
                nextDueDate: preview.nextDueDate,
                amount: item.amount,
                currency: item.currency,
                skippedCycles: preview.skippedCycles,
                note: String(historyNote || '').trim(),
                createdAt: now,
            };

            if (!Array.isArray(item.history)) item.history = [];
            item.history.unshift(history);
            item.snoozeUntil = null;

            if (item.type === 'oneTime') {
                item.status = 'archived';
            } else {
                item.dueDate = preview.nextDueDate;
                item.anchor = preview.nextAnchor;
                item.status = 'active';
            }

            item.updatedAt = now;
            Storage.saveDatabase(db);
            return { item, history, preview };
        },

        snoozeMaxDays(item, today = Utils.todayString()) {
            if (!item || item.trashedAt || item.status !== 'active') return 0;
            const todayNum = DateEngine.dayNumber(today);
            const dueNum = DateEngine.dayNumber(item.dueDate);
            const daysLeft = (todayNum === null || dueNum === null) ? null : (dueNum - todayNum);
            if (!Number.isInteger(daysLeft) || daysLeft <= 0) return 0;
            const nodes = [...new Set((Array.isArray(item.reminderDays) ? item.reminderDays : [])
                .filter(n => Number.isInteger(n) && n >= 0))]
                .sort((a, b) => b - a);
            if (!nodes.length) return 0;
            const maxNode = Math.max(...nodes);
            // 只有已经进入自己的提醒窗口后，才显示“稍后提醒”。
            if (daysLeft > maxNode) return 0;
            // 不允许跨过下一个更紧急的提醒节点；如果没有更小节点，则最多到到期当天。
            const lowerNodes = nodes.filter(node => node < daysLeft);
            const nextUrgentNode = lowerNodes.length ? Math.max(...lowerNodes) : 0;
            return Math.max(0, daysLeft - nextUrgentNode);
        },

        snoozeOptions(item, today = Utils.todayString()) {
            const maxDays = this.snoozeMaxDays(item, today);
            return [1, 3, 7].filter(days => days <= maxDays);
        },

        setSnooze(id, days, today = Utils.todayString()) {
            const db = Storage.loadDatabase();
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');
            if (item.trashedAt || item.status !== 'active') throw new Error('当前事项不能稍后提醒');
            const n = Number(days);
            if (!Number.isInteger(n) || n <= 0) throw new Error('稍后提醒天数无效');
            const maxDays = this.snoozeMaxDays(item, today);
            if (maxDays <= 0) throw new Error('当前事项不适合稍后提醒');
            if (n > maxDays) throw new Error(`最多可延后 ${maxDays} 天，以免跨过更紧急的提醒节点`);
            item.snoozeUntil = DateEngine.addDays(today, n);
            item.updatedAt = Utils.nowLocalISOString();
            Storage.saveDatabase(db);
            return item.snoozeUntil;
        },

        clearSnooze(id) {
            const db = Storage.loadDatabase();
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');
            item.snoozeUntil = null;
            item.updatedAt = Utils.nowLocalISOString();
            Storage.saveDatabase(db);
        },

        setStatus(id, status) {
            if (!['active', 'paused', 'archived'].includes(status)) throw new Error('状态无效');
            const db = Storage.loadDatabase();
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');
            if (item.trashedAt) throw new Error('回收站事项不能修改状态');
            if (item.status === status) return item;
            SnapshotManager.create('before-status-change', db);
            item.status = status;
            if (status !== 'active') item.snoozeUntil = null;
            item.updatedAt = Utils.nowLocalISOString();
            Storage.saveDatabase(db);
            return item;
        },

        moveToTrash(id) {
            const db = Storage.loadDatabase();
            SnapshotManager.create('before-delete', db);
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');
            item.trashedAt = Utils.nowLocalISOString();
            item.updatedAt = Utils.nowLocalISOString();
            Storage.saveDatabase(db);
        },

        restore(id) {
            const db = Storage.loadDatabase();
            SnapshotManager.create('before-restore-item', db);
            const item = this.find(db, id);
            if (!item) throw new Error('找不到该事项');
            item.trashedAt = null;
            item.updatedAt = Utils.nowLocalISOString();
            Storage.saveDatabase(db);
        },

        permanentDelete(id) {
            const db = Storage.loadDatabase();
            const item = this.find(db, id);
            if (!item || !item.trashedAt) throw new Error('只能永久删除回收站中的事项');
            SnapshotManager.create('before-permanent-delete', db);
            db.items = db.items.filter(i => i.id !== id);
            Storage.saveDatabase(db);
        },

        clearTrash() {
            const db = Storage.loadDatabase();
            const count = db.items.filter(i => i.trashedAt).length;
            if (!count) return 0;
            SnapshotManager.create('before-clear-trash', db);
            db.items = db.items.filter(i => !i.trashedAt);
            Storage.saveDatabase(db);
            return count;
        },
    };

    /* =========================================================
     * 08. Snapshot / Statistics / Backup / Categories
     * ======================================================= */
    const SnapshotManager = {
        MAX: 20,
        REASON_LABELS: {
            'before-create': '新建事项前',
            'before-edit': '编辑事项前',
            'before-complete': '处理事项前',
            'before-delete': '删除事项前',
            'before-restore-item': '恢复回收站事项前',
            'before-import': '导入备份前',
            'before-snapshot-restore': '恢复快照前',
            'before-category-change': '修改分类前',
            'before-settings-change': '修改设置前',
            'before-status-change': '修改事项状态前',
            'before-permanent-delete': '永久删除前',
            'before-clear-trash': '清空回收站前',
        },

        create(reason, database = null) {
            const db = database ? Utils.deepClone(database) : Storage.loadDatabase();
            const snapshots = Storage.loadSnapshots();
            snapshots.unshift({
                id: Utils.id('snapshot'),
                reason,
                createdAt: Utils.nowLocalISOString(),
                database: db,
            });
            Storage.saveSnapshots(snapshots.slice(0, this.MAX));
        },

        list() {
            return Storage.loadSnapshots();
        },

        restore(id) {
            const snapshots = Storage.loadSnapshots();
            const snapshot = snapshots.find(s => s.id === id);
            if (!snapshot?.database) throw new Error('找不到该快照');
            SnapshotManager.create('before-snapshot-restore');
            Storage.saveDatabase(Storage.normalizeDatabase(snapshot.database));
        },

        label(reason) {
            return this.REASON_LABELS[reason] || reason || '自动快照';
        },
    };

    const StatisticsEngine = {
        activeItems(db) {
            return db.items.filter(i => !i.trashedAt && i.status === 'active');
        },

        addMoney(map, currency, amount) {
            if (amount === null || amount === undefined || !currency) return;
            const n = Number(amount);
            if (!Number.isFinite(n)) return;
            map[currency] = (map[currency] || 0) + n;
        },

        recurringAnnualAmount(item) {
            if (item.type !== 'recurring' || !item.recurrence?.enabled || item.amount === null || !item.currency) return null;
            const interval = Number(item.recurrence.interval);
            if (!Number.isFinite(interval) || interval <= 0) return null;
            let perYear = null;
            if (item.recurrence.unit === 'day') perYear = 365 / interval;
            if (item.recurrence.unit === 'month') perYear = 12 / interval;
            if (item.recurrence.unit === 'year') perYear = 1 / interval;
            if (perYear === null) return null;
            return Number(item.amount) * perYear;
        },

        annualCosts(db) {
            const out = {};
            for (const item of this.activeItems(db)) {
                const annual = this.recurringAnnualAmount(item);
                if (annual !== null) this.addMoney(out, item.currency, annual);
            }
            return out;
        },

        futureCosts(db, maxDays, sameMonthOnly = false) {
            const out = {};
            const today = Utils.parseDateParts(Utils.todayString());
            for (const item of this.activeItems(db)) {
                if (item.amount === null || !item.currency) continue;
                const d = DateEngine.daysFromToday(item.dueDate);
                if (d === null || d < 0 || d > maxDays) continue;
                if (sameMonthOnly) {
                    const p = Utils.parseDateParts(item.dueDate);
                    if (!p || !today || p.year !== today.year || p.month !== today.month) continue;
                }
                this.addMoney(out, item.currency, item.amount);
            }
            return out;
        },

        dueCounts(db) {
            const result = { overdue: 0, d7: 0, d30: 0, d90: 0, far: 0 };
            for (const item of this.activeItems(db)) {
                const d = DateEngine.daysFromToday(item.dueDate);
                if (d === null) continue;
                if (d < 0) result.overdue++;
                else if (d <= 7) result.d7++;
                else if (d <= 30) result.d30++;
                else if (d <= 90) result.d90++;
                else result.far++;
            }
            return result;
        },

        statusCounts(db) {
            const normal = db.items.filter(i => !i.trashedAt && i.status === 'active').length;
            const paused = db.items.filter(i => !i.trashedAt && i.status === 'paused').length;
            const archived = db.items.filter(i => !i.trashedAt && i.status === 'archived').length;
            const trash = db.items.filter(i => i.trashedAt).length;
            return { normal, paused, archived, trash };
        },

        byCategoryAnnual(db) {
            const categoryMap = new Map(db.categories.map(c => [c.id, c.name]));
            const rows = new Map();
            for (const item of this.activeItems(db)) {
                const annual = this.recurringAnnualAmount(item);
                if (annual === null) continue;
                const category = categoryMap.get(item.categoryId) || '未分类';
                const key = `${category}|||${item.currency}`;
                rows.set(key, { category, currency: item.currency, amount: (rows.get(key)?.amount || 0) + annual });
            }
            return [...rows.values()].sort((a, b) => a.category.localeCompare(b.category, 'zh-CN') || a.currency.localeCompare(b.currency));
        },
    };

    const BackupManager = {
        exportJSON() {
            const db = Storage.loadDatabase();
            const payload = {
                backupType: 'LongTermManager',
                exportedAt: Utils.nowLocalISOString(),
                schemaVersion: db.schemaVersion,
                appVersion: Config.APP_VERSION,
                database: db,
            };
            const filename = `LongTermManager_Backup_${Utils.todayString()}.json`;
            Utils.downloadText(filename, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
        },

        exportCSV() {
            const db = Storage.loadDatabase();
            const categoryMap = new Map(db.categories.map(c => [c.id, c.name]));
            const headers = ['名称','分类','类型','下次日期','重复周期','金额','币种','状态','网址','备注','账号备注'];
            const rows = db.items.filter(i => !i.trashedAt).map(item => [
                item.name,
                categoryMap.get(item.categoryId) || '未分类',
                item.type === 'recurring' ? '循环事项' : '一次性事项',
                item.dueDate,
                ManagerUI.recurrenceLabel(item),
                item.amount ?? '',
                item.currency ?? '',
                item.status === 'active' ? '正常' : item.status === 'paused' ? '暂停' : '归档',
                item.url || '',
                item.note || '',
                item.accountNote || '',
            ]);
            const csv = '\ufeff' + [headers, ...rows].map(row => row.map(Utils.csvCell).join(',')).join('\r\n');
            Utils.downloadText(`LongTermManager_Items_${Utils.todayString()}.csv`, csv, 'text/csv;charset=utf-8');
        },

        validatePayload(payload) {
            const db = payload?.database || payload;
            if (!db || typeof db !== 'object') throw new Error('备份格式无效');
            if (!Array.isArray(db.items)) throw new Error('备份中缺少事项数据');
            if (!Array.isArray(db.categories)) throw new Error('备份中缺少分类数据');
            if (!db.settings || typeof db.settings !== 'object') throw new Error('备份中缺少设置数据');
            return Storage.normalizeDatabase(db);
        },

        importJSONText(text) {
            let payload;
            try { payload = JSON.parse(text); } catch { throw new Error('JSON 文件无法解析'); }
            const db = this.validatePayload(payload);
            SnapshotManager.create('before-import');
            Storage.saveDatabase(db);
            Storage.saveRuntime({ lastAutoPopupDate: null, mutedDate: null, itemReminderState: {} });
            return db;
        },
    };

    const CategoryService = {
        add(name) {
            const clean = String(name || '').trim();
            if (!clean) throw new Error('分类名称不能为空');
            const db = Storage.loadDatabase();
            if (db.categories.some(c => c.name.trim().toLowerCase() === clean.toLowerCase())) throw new Error('分类名称已存在');
            SnapshotManager.create('before-category-change', db);
            const now = Utils.nowLocalISOString();
            db.categories.push({ id: Utils.id('cat'), name: clean, builtIn: false, order: db.categories.length + 1, createdAt: now, updatedAt: now });
            Storage.saveDatabase(db);
        },

        rename(id, name) {
            const clean = String(name || '').trim();
            if (!clean) throw new Error('分类名称不能为空');
            const db = Storage.loadDatabase();
            const category = db.categories.find(c => c.id === id);
            if (!category) throw new Error('找不到分类');
            if (db.categories.some(c => c.id !== id && c.name.trim().toLowerCase() === clean.toLowerCase())) throw new Error('分类名称已存在');
            SnapshotManager.create('before-category-change', db);
            category.name = clean;
            category.updatedAt = Utils.nowLocalISOString();
            Storage.saveDatabase(db);
        },

        remove(id) {
            const db = Storage.loadDatabase();
            const category = db.categories.find(c => c.id === id);
            if (!category) throw new Error('找不到分类');
            SnapshotManager.create('before-category-change', db);
            for (const item of db.items) if (item.categoryId === id) item.categoryId = null;
            db.categories = db.categories.filter(c => c.id !== id);
            Storage.saveDatabase(db);
        },
    };

    /* =========================================================
     * 09. Manager UI
     * ======================================================= */
    const ManagerUI = {
        state: {
            tab: 'items',
            view: 'active',
            search: '',
            farCollapsed: true,
            categoryId: null,
            dueRange: 'all',
            customStart: '',
            customEnd: '',
            itemType: 'all',
            currency: null,
            sort: 'dueAsc',
            moreFiltersOpen: false,
        },

        mount() {
            const db = Storage.loadDatabase();
            const filters = db.settings?.filters || Models.defaultSettings().filters;
            this.state.view = ['active', 'paused', 'archived', 'trash'].includes(filters.statusView) ? filters.statusView : 'active';
            this.state.categoryId = filters.categoryId || null;
            this.state.dueRange = ['all', 'need', 'today', '7', '30', '90', 'year', 'custom'].includes(filters.dueRange) ? filters.dueRange : 'all';
            this.state.customStart = Utils.parseDateParts(filters.customStart) ? filters.customStart : '';
            this.state.customEnd = Utils.parseDateParts(filters.customEnd) ? filters.customEnd : '';
            this.state.itemType = ['all', 'recurring', 'oneTime'].includes(filters.itemType) ? filters.itemType : 'all';
            this.state.currency = Config.CURRENCIES.some(([code]) => code === filters.currency) ? filters.currency : null;
            this.state.sort = ['dueAsc', 'dueDesc', 'nameAsc', 'createdDesc', 'updatedDesc', 'amountDesc'].includes(filters.sort) ? filters.sort : 'dueAsc';
            if (this.state.sort === 'amountDesc' && !this.state.currency) this.state.sort = 'dueAsc';
            if (this.state.categoryId && this.state.categoryId !== '__uncategorized__' && !db.categories.some(c => c.id === this.state.categoryId)) this.state.categoryId = null;
            document.documentElement.lang = 'zh-CN';
            document.title = Config.APP_NAME;
            document.head.innerHTML = `
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>${Config.APP_NAME}</title>
            `;
            document.body.innerHTML = '<div id="ltm-app"></div><div id="ltm-modal-root"></div><div id="ltm-toast-root"></div>';
            GM_addStyle(this.styles());
            this.bindGlobalEvents();
            this.render();
        },

        styles() {
            return `
                :root {
                    color-scheme: light;
                    --ltm-bg: #f6f7f9;
                    --ltm-card: #ffffff;
                    --ltm-text: #17191c;
                    --ltm-muted: #737983;
                    --ltm-line: #e7e9ed;
                    --ltm-primary: #1f2937;
                    --ltm-soft: #eef1f4;
                    --ltm-danger: #c73535;
                    --ltm-danger-bg: #fff0f0;
                    --ltm-warning: #b56308;
                    --ltm-warning-bg: #fff6e7;
                    --ltm-notice: #8a6a00;
                    --ltm-notice-bg: #fffbe7;
                    --ltm-radius: 16px;
                }
                * { box-sizing: border-box; }
                html, body { margin: 0 !important; padding: 0 !important; min-height: 100% !important; background: var(--ltm-bg) !important; }
                body { font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif !important; color: var(--ltm-text) !important; }
                button, input, select, textarea { font: inherit; }
                button { cursor: pointer; }
                #ltm-app { min-height: 100vh; }
                .ltm-shell { width: min(1320px, calc(100% - 32px)); margin: 0 auto; padding: 28px 0 72px; }
                .ltm-topbar { display:flex; align-items:center; justify-content:space-between; gap:20px; margin-bottom: 22px; }
                .ltm-brand h1 { margin:0; font-size: 26px; letter-spacing:-.02em; }
                .ltm-brand p { margin:6px 0 0; color:var(--ltm-muted); font-size:13px; }
                .ltm-btn { border:1px solid var(--ltm-line); background:#fff; color:var(--ltm-text); border-radius:10px; padding:9px 13px; min-height:38px; }
                .ltm-btn:hover { background:#f8f9fb; }
                .ltm-btn-primary { background:var(--ltm-primary); color:#fff; border-color:var(--ltm-primary); font-weight:650; }
                .ltm-btn-primary:hover { background:#111827; }
                .ltm-btn-danger { color:var(--ltm-danger); background:#fff; }
                .ltm-btn-link { border:0; background:transparent; padding:6px 2px; color:var(--ltm-muted); }
                .ltm-btn:disabled { cursor:not-allowed; opacity:.45; }
                .ltm-nav { display:flex; gap:6px; background:#fff; border:1px solid var(--ltm-line); border-radius:12px; padding:5px; margin-bottom:18px; width:max-content; }
                .ltm-nav button { border:0; background:transparent; padding:8px 14px; border-radius:8px; color:var(--ltm-muted); }
                .ltm-nav button.active { background:var(--ltm-soft); color:var(--ltm-text); font-weight:650; }
                .ltm-summary { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:12px; margin-bottom:18px; }
                .ltm-metric { background:#fff; border:1px solid var(--ltm-line); border-radius:var(--ltm-radius); padding:17px; text-align:left; color:inherit; }
                button.ltm-metric { width:100%; cursor:pointer; transition:transform .12s ease, box-shadow .12s ease; }
                button.ltm-metric:hover { transform:translateY(-1px); box-shadow:0 5px 18px rgba(0,0,0,.05); }
                .ltm-metric .num { font-size:26px; font-weight:750; line-height:1; margin-bottom:7px; }
                .ltm-metric .label { color:var(--ltm-muted); font-size:13px; }
                .ltm-toolbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:10px; }
                .ltm-search { flex:1 1 320px; min-width:220px; border:1px solid var(--ltm-line); background:#fff; border-radius:11px; padding:10px 12px; outline:none; }
                .ltm-filterbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:0 0 10px; }
                .ltm-filter-select { min-height:38px; border:1px solid var(--ltm-line); background:#fff; color:var(--ltm-text); border-radius:10px; padding:8px 34px 8px 11px; outline:none; }
                .ltm-filter-select:focus { border-color:#9aa2ad; box-shadow:0 0 0 3px rgba(31,41,55,.06); }
                .ltm-more-filters { background:#fff; border:1px solid var(--ltm-line); border-radius:12px; padding:12px; margin:0 0 12px; display:grid; gap:12px; }
                .ltm-filter-section { display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; }
                .ltm-filter-label { width:74px; padding-top:7px; color:var(--ltm-muted); font-size:13px; flex:0 0 auto; }
                .ltm-chip-row { display:flex; flex-wrap:wrap; gap:7px; }
                .ltm-chip { border:1px solid var(--ltm-line); background:#fff; color:var(--ltm-muted); border-radius:999px; padding:7px 11px; font-size:13px; }
                .ltm-chip.active { background:var(--ltm-primary); color:#fff; border-color:var(--ltm-primary); }
                .ltm-filter-summary { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin:0 0 16px; min-height:28px; }
                .ltm-custom-range { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
                .ltm-custom-range input { min-height:38px; border:1px solid var(--ltm-line); border-radius:9px; padding:7px 9px; background:#fff; }
                .ltm-version-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px 18px; }
                .ltm-version-grid .ltm-setting-row { border-top:0; padding:5px 0; }

                .ltm-active-filters { display:flex; align-items:center; flex-wrap:wrap; gap:6px; color:var(--ltm-muted); font-size:13px; }
                .ltm-filter-tag { display:inline-flex; align-items:center; border:1px solid var(--ltm-line); background:#fff; color:#4b5563; border-radius:999px; padding:5px 9px; }
                .ltm-result-count { margin-left:auto; color:var(--ltm-muted); font-size:13px; white-space:nowrap; }
                .ltm-search:focus, .ltm-field input:focus, .ltm-field select:focus, .ltm-field textarea:focus { border-color:#9aa2ad; box-shadow:0 0 0 3px rgba(31,41,55,.06); }
                .ltm-view-tabs { display:flex; gap:6px; flex-wrap:wrap; }
                .ltm-view-tabs button { border:1px solid var(--ltm-line); background:#fff; border-radius:9px; padding:9px 11px; color:var(--ltm-muted); }
                .ltm-view-tabs button.active { background:var(--ltm-primary); color:#fff; border-color:var(--ltm-primary); }
                .ltm-list { display:grid; gap:12px; }
                .ltm-groups { display:grid; gap:22px; }
                .ltm-group { min-width:0; }
                .ltm-group-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:0 2px 10px; padding-bottom:8px; border-bottom:1px solid var(--ltm-line); }
                .ltm-group-title { display:flex; align-items:center; gap:8px; min-width:0; }
                .ltm-group-title h2 { margin:0; font-size:15px; letter-spacing:-.01em; }
                .ltm-group-count { color:var(--ltm-muted); font-size:12px; font-weight:650; }
                .ltm-group-toggle { border:0; background:transparent; color:var(--ltm-muted); font-size:12px; padding:5px 7px; border-radius:8px; }
                .ltm-group-toggle:hover { background:#fff; color:var(--ltm-text); }
                .ltm-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(285px,1fr)); gap:12px; align-items:stretch; }
                .ltm-card { position:relative; background:#fff; border:1px solid var(--ltm-line); border-left:4px solid #d9dde3; border-radius:var(--ltm-radius); padding:15px 15px 13px; display:flex; flex-direction:column; min-width:0; min-height:190px; }
                .ltm-card.risk-danger { border-left-color:var(--ltm-danger); }
                .ltm-card.risk-warning { border-left-color:var(--ltm-warning); }
                .ltm-card.risk-notice { border-left-color:#c4a02c; }
                .ltm-card-main { min-width:0; display:flex; flex-direction:column; flex:1; }
                .ltm-card-top { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; min-height:26px; }
                .ltm-card-category { color:var(--ltm-muted); font-size:12px; max-width:46%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
                .ltm-due { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:750; border-radius:999px; padding:4px 8px; background:var(--ltm-soft); color:#4b5563; white-space:nowrap; }
                .ltm-due.danger { color:var(--ltm-danger); background:var(--ltm-danger-bg); }
                .ltm-due.warning { color:var(--ltm-warning); background:var(--ltm-warning-bg); }
                .ltm-due.notice { color:var(--ltm-notice); background:var(--ltm-notice-bg); }
                .ltm-card h3 { margin:0; font-size:17px; line-height:1.35; letter-spacing:-.01em; overflow-wrap:anywhere; }
                .ltm-meta { display:flex; flex-wrap:wrap; gap:5px 9px; color:var(--ltm-muted); font-size:12px; margin-top:8px; line-height:1.5; }
                .ltm-amount { color:#3f4650; font-weight:700; }
                .ltm-note { margin-top:8px; color:#565d67; font-size:12px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
                .ltm-card-actions { display:flex; gap:7px; flex-wrap:wrap; margin-top:13px; padding-top:11px; border-top:1px solid #f0f1f3; }
                .ltm-card-actions .ltm-btn { min-height:32px; padding:6px 9px; font-size:12px; flex:0 0 auto; }
                .ltm-collapsed-summary { border:1px dashed #d7dbe1; background:rgba(255,255,255,.52); border-radius:12px; padding:13px 15px; color:var(--ltm-muted); font-size:13px; display:flex; justify-content:space-between; align-items:center; gap:12px; }
                .ltm-empty { border:1px dashed #d8dce2; border-radius:var(--ltm-radius); background:rgba(255,255,255,.6); padding:54px 24px; text-align:center; }
                .ltm-empty h3 { margin:0 0 8px; }
                .ltm-empty p { color:var(--ltm-muted); margin:0 0 18px; }
                .ltm-phase-note { margin-top:18px; padding:12px 14px; border-radius:11px; background:#eef4ff; color:#40536b; font-size:12px; }
                .ltm-modal-backdrop { position:fixed; inset:0; z-index:9999999; background:rgba(17,24,39,.42); display:flex; align-items:flex-start; justify-content:center; padding:5vh 16px; overflow:auto; }
                .ltm-modal { width:min(720px,100%); background:#fff; border-radius:18px; box-shadow:0 24px 80px rgba(0,0,0,.22); overflow:hidden; }
                .ltm-modal-head { padding:20px 22px 15px; border-bottom:1px solid var(--ltm-line); display:flex; justify-content:space-between; align-items:center; gap:12px; }
                .ltm-modal-head h2 { margin:0; font-size:20px; }
                .ltm-modal-body { padding:20px 22px; }
                .ltm-modal-foot { padding:15px 22px 20px; display:flex; justify-content:flex-end; gap:9px; border-top:1px solid var(--ltm-line); }
                .ltm-form-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
                .ltm-field { display:flex; flex-direction:column; gap:6px; }
                .ltm-field.full { grid-column:1/-1; }
                .ltm-field label { font-size:13px; font-weight:650; color:#444a53; }
                .ltm-field input, .ltm-field select, .ltm-field textarea { width:100%; border:1px solid var(--ltm-line); border-radius:10px; background:#fff; padding:10px 11px; outline:none; color:var(--ltm-text); }
                .ltm-field textarea { min-height:88px; resize:vertical; }
                .ltm-help { color:var(--ltm-muted); font-size:12px; line-height:1.5; }
                .ltm-inline { display:grid; grid-template-columns:1fr 130px; gap:8px; }
                .ltm-details { grid-column:1/-1; border:1px solid var(--ltm-line); border-radius:11px; padding:0 13px; }
                .ltm-details summary { cursor:pointer; padding:12px 0; font-weight:650; }
                .ltm-details-inner { padding:0 0 14px; display:grid; grid-template-columns:1fr 1fr; gap:14px; }
                .ltm-confirm-text { color:#4f5661; line-height:1.7; margin:0; white-space:pre-line; }
                .ltm-history { border-top:1px solid var(--ltm-line); margin-top:2px; padding-top:14px; }
                .ltm-history h3 { margin:0 0 10px; font-size:14px; }
                .ltm-history-row { padding:9px 0; border-top:1px dashed var(--ltm-line); font-size:13px; }
                .ltm-history-row:first-of-type { border-top:0; }
                #ltm-toast-root { position:fixed; right:18px; bottom:18px; z-index:10000000; display:grid; gap:8px; }
                .ltm-toast { background:#1f2937; color:white; border-radius:10px; padding:11px 14px; box-shadow:0 12px 30px rgba(0,0,0,.2); font-size:13px; animation:ltmIn .18s ease-out; }
                @keyframes ltmIn { from { transform:translateY(7px); opacity:0 } to { transform:none; opacity:1 } }
                .ltm-panel { background:#fff; border:1px solid var(--ltm-line); border-radius:var(--ltm-radius); padding:18px; }
                .ltm-panel + .ltm-panel { margin-top:14px; }
                .ltm-panel h2 { margin:0 0 14px; font-size:17px; }
                .ltm-panel h3 { margin:0 0 10px; font-size:14px; }
                .ltm-stats-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-bottom:14px; }
                .ltm-statbox { background:#fff; border:1px solid var(--ltm-line); border-radius:14px; padding:16px; }
                .ltm-statbox .title { color:var(--ltm-muted); font-size:12px; margin-bottom:8px; }
                .ltm-money-lines { display:grid; gap:5px; font-weight:750; font-size:18px; }
                .ltm-simple-table { width:100%; border-collapse:collapse; font-size:13px; }
                .ltm-simple-table th, .ltm-simple-table td { text-align:left; padding:10px 8px; border-top:1px solid var(--ltm-line); vertical-align:top; }
                .ltm-simple-table th { color:var(--ltm-muted); font-weight:650; font-size:12px; }
                .ltm-settings-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
                .ltm-setting-row { display:flex; align-items:center; justify-content:space-between; gap:15px; padding:11px 0; border-top:1px solid var(--ltm-line); }
                .ltm-setting-row:first-child { border-top:0; }
                .ltm-setting-row .desc { color:var(--ltm-muted); font-size:12px; margin-top:3px; }
                .ltm-setting-row input[type='text'], .ltm-setting-row input[type='number'], .ltm-setting-row select { border:1px solid var(--ltm-line); border-radius:9px; padding:8px 9px; min-width:130px; }
                .ltm-category-list { display:grid; gap:7px; }
                .ltm-category-row { display:flex; align-items:center; justify-content:space-between; gap:10px; border-top:1px solid var(--ltm-line); padding:9px 0; }
                .ltm-category-row:first-child { border-top:0; }
                .ltm-category-actions { display:flex; gap:6px; }
                .ltm-data-actions { display:flex; gap:8px; flex-wrap:wrap; }
                .ltm-snapshot-list { display:grid; gap:7px; margin-top:10px; max-height:330px; overflow:auto; }
                .ltm-snapshot-row { display:flex; justify-content:space-between; align-items:center; gap:12px; border-top:1px solid var(--ltm-line); padding:9px 0; }
                .ltm-snapshot-row:first-child { border-top:0; }
                .ltm-muted { color:var(--ltm-muted); }
                @media (max-width:720px) {
                    .ltm-shell { width:min(100% - 20px,1320px); padding-top:18px; }
                    .ltm-topbar { align-items:flex-start; }
                    .ltm-summary { grid-template-columns:1fr; }
                    .ltm-grid { grid-template-columns:1fr; }
                    .ltm-form-grid, .ltm-details-inner { grid-template-columns:1fr; }
                    .ltm-field.full, .ltm-details { grid-column:auto; }
                    .ltm-inline { grid-template-columns:1fr; }
                    .ltm-settings-grid { grid-template-columns:1fr; }
                    .ltm-version-grid { grid-template-columns:1fr; }
                    .ltm-filter-section { display:block; }
                    .ltm-filter-label { width:auto; margin-bottom:7px; padding-top:0; }
                    .ltm-filterbar .ltm-filter-select { flex:1 1 160px; min-width:0; }
                }
            `;
        },

        bindGlobalEvents() {
            document.addEventListener('click', (event) => {
                const target = event.target.closest('[data-action]');
                if (!target) return;
                const action = target.dataset.action;
                const id = target.dataset.id || null;

                if (action === 'new') this.openEditor();
                if (action === 'edit') this.openEditor(id);
                if (action === 'trash') this.confirmTrash(id);
                if (action === 'restore') this.restore(id);
                if (action === 'permanent-delete') this.confirmPermanentDelete(id);
                if (action === 'clear-trash') this.confirmClearTrash();
                if (action === 'complete') this.confirmComplete(id);
                if (action === 'snooze') this.openSnooze(id);
                if (action === 'snooze-choice') this.applySnooze(id, Number(target.dataset.days));
                if (action === 'clear-snooze') this.clearSnooze(id);
                if (action === 'set-status') this.setItemStatus(id, target.dataset.status);
                if (action === 'quick-filter') this.applyQuickFilter(target.dataset.range || 'all');
                if (action === 'apply-custom-range') this.applyCustomRange();
                if (action === 'close-modal') this.closeModal();
                if (action === 'tab') {
                    this.state.tab = target.dataset.tab || 'items';
                    this.render();
                }
                if (action === 'save-settings') this.saveSettingsFromUI();
                if (action === 'export-json') { BackupManager.exportJSON(); this.toast('完整备份已导出'); }
                if (action === 'export-csv') { BackupManager.exportCSV(); this.toast('CSV 已导出'); }
                if (action === 'import-json') document.getElementById('ltm-import-file')?.click();
                if (action === 'restore-snapshot') this.confirmSnapshotRestore(id);
                if (action === 'add-category') this.addCategory();
                if (action === 'rename-category') this.renameCategory(id);
                if (action === 'delete-category') this.deleteCategory(id);
                if (action === 'view') {
                    this.state.view = target.dataset.view;
                    this.persistFilterState();
                    this.render();
                }
                if (action === 'toggle-more-filters') {
                    this.state.moreFiltersOpen = !this.state.moreFiltersOpen;
                    this.render();
                }
                if (action === 'clear-filters') {
                    this.clearFilters();
                }
                if (action === 'filter-chip') {
                    const kind = target.dataset.kind;
                    const value = target.dataset.value;
                    if (kind === 'dueRange') {
                        this.state.dueRange = value;
                        if (value !== 'custom') { this.state.customStart = ''; this.state.customEnd = ''; }
                    }
                    if (kind === 'itemType') this.state.itemType = value;
                    if (kind === 'currency') {
                        this.state.currency = value === 'all' ? null : value;
                        if (!this.state.currency && this.state.sort === 'amountDesc') this.state.sort = 'dueAsc';
                    }
                    this.persistFilterState();
                    this.render();
                }
                if (action === 'toggle-far') {
                    this.state.farCollapsed = !this.state.farCollapsed;
                    this.renderListOnly();
                }
            });

            document.addEventListener('input', (event) => {
                if (event.target.id === 'ltm-search') {
                    this.state.search = event.target.value;
                    this.renderListOnly();
                }
            });

            document.addEventListener('change', (event) => {
                if (event.target.id === 'ltm-import-file') {
                    const file = event.target.files?.[0];
                    if (file) this.importBackupFile(file);
                    event.target.value = '';
                }
                if (event.target.id === 'ltm-item-type' || event.target.id === 'ltm-repeat-preset') {
                    this.syncEditorVisibility();
                }
                if (event.target.id === 'ltm-filter-category') {
                    this.state.categoryId = event.target.value || null;
                    this.persistFilterState();
                    this.render();
                }
                if (event.target.id === 'ltm-filter-sort') {
                    const requested = event.target.value || 'dueAsc';
                    this.state.sort = requested === 'amountDesc' && !this.state.currency ? 'dueAsc' : requested;
                    this.persistFilterState();
                    this.render();
                }
            });
        },

        persistFilterState() {
            const db = Storage.loadDatabase();
            db.settings ??= Models.defaultSettings();
            db.settings.filters = {
                ...(db.settings.filters || Models.defaultSettings().filters),
                statusView: this.state.view,
                categoryId: this.state.categoryId || null,
                dueRange: this.state.dueRange,
                customStart: this.state.customStart || '',
                customEnd: this.state.customEnd || '',
                itemType: this.state.itemType,
                currency: this.state.currency || null,
                sort: this.state.sort,
            };
            Storage.saveDatabase(db);
        },

        clearFilters() {
            this.state.search = '';
            this.state.view = 'active';
            this.state.categoryId = null;
            this.state.dueRange = 'all';
            this.state.customStart = '';
            this.state.customEnd = '';
            this.state.itemType = 'all';
            this.state.currency = null;
            this.state.sort = 'dueAsc';
            this.state.moreFiltersOpen = false;
            this.persistFilterState();
            this.render();
        },

        categoryMap(db) {
            return new Map(db.categories.map(c => [c.id, c]));
        },

        getVisibleItems(db) {
            let items = db.items.filter(item => {
                if (this.state.view === 'trash') return Boolean(item.trashedAt);
                if (item.trashedAt) return false;
                return item.status === this.state.view;
            });

            const q = Utils.normalizeText(this.state.search);
            if (q) {
                const categoryMap = this.categoryMap(db);
                items = items.filter(item => {
                    const categoryName = categoryMap.get(item.categoryId)?.name || '';
                    const haystack = [item.name, categoryName, item.note, item.accountNote, item.url]
                        .map(Utils.normalizeText)
                        .join('\n');
                    return haystack.includes(q);
                });
            }

            if (this.state.categoryId) {
                items = this.state.categoryId === '__uncategorized__'
                    ? items.filter(item => !item.categoryId)
                    : items.filter(item => item.categoryId === this.state.categoryId);
            }

            if (this.state.itemType !== 'all') {
                items = items.filter(item => item.type === this.state.itemType);
            }

            if (this.state.currency) {
                items = items.filter(item => item.currency === this.state.currency);
            }

            if (this.state.dueRange !== 'all') {
                const today = Utils.todayString();
                const year = Number(today.slice(0, 4));
                const customStartNum = DateEngine.dayNumber(this.state.customStart);
                const customEndNum = DateEngine.dayNumber(this.state.customEnd);
                items = items.filter(item => {
                    const d = DateEngine.daysFromToday(item.dueDate);
                    if (d === null) return false;
                    if (this.state.dueRange === 'need') return d <= 0;
                    if (this.state.dueRange === 'today') return d === 0;
                    if (this.state.dueRange === '7') return d >= 0 && d <= 7;
                    if (this.state.dueRange === '30') return d >= 0 && d <= 30;
                    if (this.state.dueRange === '90') return d >= 0 && d <= 90;
                    if (this.state.dueRange === 'year') return Number(item.dueDate.slice(0, 4)) === year;
                    if (this.state.dueRange === 'custom') {
                        const itemNum = DateEngine.dayNumber(item.dueDate);
                        if (itemNum === null || customStartNum === null || customEndNum === null) return false;
                        return itemNum >= customStartNum && itemNum <= customEndNum;
                    }
                    return true;
                });
            }

            const byDueAsc = (a, b) => {
                const ad = DateEngine.daysFromToday(a.dueDate);
                const bd = DateEngine.daysFromToday(b.dueDate);
                if (ad === null && bd === null) return a.name.localeCompare(b.name, 'zh-CN');
                if (ad === null) return 1;
                if (bd === null) return -1;
                if (ad !== bd) return ad - bd;
                return a.name.localeCompare(b.name, 'zh-CN');
            };

            return items.sort((a, b) => {
                switch (this.state.sort) {
                    case 'dueDesc': {
                        const ad = DateEngine.daysFromToday(a.dueDate);
                        const bd = DateEngine.daysFromToday(b.dueDate);
                        if (ad === null && bd === null) return a.name.localeCompare(b.name, 'zh-CN');
                        if (ad === null) return 1;
                        if (bd === null) return -1;
                        if (ad !== bd) return bd - ad;
                        return a.name.localeCompare(b.name, 'zh-CN');
                    }
                    case 'nameAsc':
                        return a.name.localeCompare(b.name, 'zh-CN');
                    case 'createdDesc':
                        return String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || byDueAsc(a, b);
                    case 'updatedDesc':
                        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) || byDueAsc(a, b);
                    case 'amountDesc': {
                        const aa = a.amount === null || a.amount === undefined ? -Infinity : Number(a.amount);
                        const ba = b.amount === null || b.amount === undefined ? -Infinity : Number(b.amount);
                        if (aa !== ba) return ba - aa;
                        return byDueAsc(a, b);
                    }
                    case 'dueAsc':
                    default:
                        return byDueAsc(a, b);
                }
            });
        },

        summary(db) {
            const active = db.items.filter(i => !i.trashedAt && i.status === 'active');
            const need = active.filter(i => {
                const d = DateEngine.daysFromToday(i.dueDate);
                return d !== null && d <= 0;
            }).length;
            const within30 = active.filter(i => {
                const d = DateEngine.daysFromToday(i.dueDate);
                return d !== null && d > 0 && d <= 30;
            }).length;
            return { need, within30, total: active.length };
        },

        render() {
            const db = Storage.loadDatabase();
            const root = document.getElementById('ltm-app');
            const metrics = this.summary(db);
            root.innerHTML = `
                <main class="ltm-shell">
                    <header class="ltm-topbar">
                        <div class="ltm-brand">
                            <h1>${Config.APP_NAME}</h1>
                            <p>V0.6.0 · 完全本地 · 长期到期事项 / 节点提醒 / 统计 / 备份恢复</p>
                        </div>
                        <button class="ltm-btn ltm-btn-primary" data-action="new">＋ 新建事项</button>
                    </header>

                    <nav class="ltm-nav" aria-label="主导航">
                        <button class="${this.state.tab === 'items' ? 'active' : ''}" data-action="tab" data-tab="items">事项</button>
                        <button class="${this.state.tab === 'stats' ? 'active' : ''}" data-action="tab" data-tab="stats">统计</button>
                        <button class="${this.state.tab === 'settings' ? 'active' : ''}" data-action="tab" data-tab="settings">设置</button>
                    </nav>

                    <section id="ltm-page-content">
                        ${this.state.tab === 'items' ? this.renderItemsPageShell(metrics) : ''}
                        ${this.state.tab === 'stats' ? this.renderStatsPage(db) : ''}
                        ${this.state.tab === 'settings' ? this.renderSettingsPage(db) : ''}
                    </section>
                    <input id="ltm-import-file" type="file" accept="application/json,.json" hidden>
                </main>
            `;
            if (this.state.tab === 'items') this.renderListOnly();
        },

        renderItemsPageShell(metrics) {
            const db = Storage.loadDatabase();
            const categories = [...db.categories].sort((a, b) => (a.order || 0) - (b.order || 0));
            const categoryOptions = categories.map(c => `<option value="${Utils.escapeHTML(c.id)}" ${this.state.categoryId === c.id ? 'selected' : ''}>${Utils.escapeHTML(c.name)}</option>`).join('');
            const amountSortDisabled = !this.state.currency;
            return `
                <section class="ltm-summary">
                    <button class="ltm-metric" data-action="quick-filter" data-range="need"><div class="num">${metrics.need}</div><div class="label">需要处理（逾期或今天） · 点击查看</div></button>
                    <button class="ltm-metric" data-action="quick-filter" data-range="30"><div class="num">${metrics.within30}</div><div class="label">未来 30 天 · 点击查看</div></button>
                    <button class="ltm-metric" data-action="quick-filter" data-range="all"><div class="num">${metrics.total}</div><div class="label">正常事项 · 点击查看全部</div></button>
                </section>
                <section class="ltm-toolbar">
                    <input id="ltm-search" class="ltm-search" type="search" placeholder="搜索名称、分类、备注、网址…" value="${Utils.escapeHTML(this.state.search)}">
                    <div class="ltm-view-tabs">
                        ${this.viewButton('active', '正常')}
                        ${this.viewButton('paused', '暂停')}
                        ${this.viewButton('archived', '归档')}
                        ${this.viewButton('trash', '回收站')}
                    </div>
                </section>
                <section class="ltm-filterbar">
                    <select id="ltm-filter-category" class="ltm-filter-select" aria-label="分类筛选">
                        <option value="">全部分类</option>
                        <option value="__uncategorized__" ${this.state.categoryId === '__uncategorized__' ? 'selected' : ''}>未分类</option>
                        ${categoryOptions}
                    </select>
                    <select id="ltm-filter-sort" class="ltm-filter-select" aria-label="排序">
                        <option value="dueAsc" ${this.state.sort === 'dueAsc' ? 'selected' : ''}>到期时间最近</option>
                        <option value="dueDesc" ${this.state.sort === 'dueDesc' ? 'selected' : ''}>到期时间最远</option>
                        <option value="nameAsc" ${this.state.sort === 'nameAsc' ? 'selected' : ''}>名称 A-Z</option>
                        <option value="createdDesc" ${this.state.sort === 'createdDesc' ? 'selected' : ''}>最近添加</option>
                        <option value="updatedDesc" ${this.state.sort === 'updatedDesc' ? 'selected' : ''}>最近修改</option>
                        <option value="amountDesc" ${this.state.sort === 'amountDesc' ? 'selected' : ''} ${amountSortDisabled ? 'disabled' : ''}>金额从高到低${amountSortDisabled ? '（先选币种）' : ''}</option>
                    </select>
                    <button class="ltm-btn" data-action="toggle-more-filters">${this.state.moreFiltersOpen ? '收起筛选' : '更多筛选'}</button>
                </section>
                ${this.state.moreFiltersOpen ? this.renderMoreFilters() : ''}
                <section id="ltm-filter-summary" class="ltm-filter-summary"></section>
                <section id="ltm-list-container"></section>
            `;
        },

        renderMoreFilters() {
            const dueOptions = [
                ['all', '不限'], ['need', '需处理'], ['today', '今天'], ['7', '7天内'], ['30', '30天内'], ['90', '90天内'], ['year', '今年'], ['custom', '自定义']
            ];
            const typeOptions = [['all', '全部'], ['recurring', '循环事项'], ['oneTime', '一次性事项']];
            const currencyOptions = [['all', '全部'], ...Config.CURRENCIES.map(([code]) => [code, code])];
            const chips = (kind, options, current) => options.map(([value, label]) => `<button class="ltm-chip ${current === value ? 'active' : ''}" data-action="filter-chip" data-kind="${kind}" data-value="${Utils.escapeHTML(value)}">${Utils.escapeHTML(label)}</button>`).join('');
            return `
                <section class="ltm-more-filters">
                    <div class="ltm-filter-section"><div class="ltm-filter-label">到期时间</div><div class="ltm-chip-row">${chips('dueRange', dueOptions, this.state.dueRange)}</div></div>
                    ${this.state.dueRange === 'custom' ? `
                        <div class="ltm-filter-section">
                            <div class="ltm-filter-label">日期范围</div>
                            <div class="ltm-custom-range">
                                <input id="ltm-custom-start" type="date" value="${Utils.escapeHTML(this.state.customStart)}" aria-label="开始日期">
                                <span>至</span>
                                <input id="ltm-custom-end" type="date" value="${Utils.escapeHTML(this.state.customEnd)}" aria-label="结束日期">
                                <button class="ltm-btn" data-action="apply-custom-range">应用范围</button>
                            </div>
                        </div>` : ''}
                    <div class="ltm-filter-section"><div class="ltm-filter-label">事项类型</div><div class="ltm-chip-row">${chips('itemType', typeOptions, this.state.itemType)}</div></div>
                    <div class="ltm-filter-section"><div class="ltm-filter-label">币种</div><div class="ltm-chip-row">${chips('currency', currencyOptions, this.state.currency || 'all')}</div></div>
                </section>
            `;
        },

        renderFilterSummary(db, visibleCount) {
            const host = document.getElementById('ltm-filter-summary');
            if (!host) return;
            const tags = [];
            if (this.state.search.trim()) tags.push(`搜索：${this.state.search.trim()}`);
            if (this.state.categoryId) tags.push(this.state.categoryId === '__uncategorized__' ? '未分类' : (this.categoryMap(db).get(this.state.categoryId)?.name || '未分类'));
            if (this.state.dueRange !== 'all') {
                const names = { need: '需处理', today: '今天', '7': '7天内', '30': '30天内', '90': '90天内', year: '今年' };
                if (this.state.dueRange === 'custom') tags.push(`${this.state.customStart || '?'} ～ ${this.state.customEnd || '?'}`);
                else tags.push(names[this.state.dueRange] || this.state.dueRange);
            }
            if (this.state.itemType !== 'all') tags.push(this.state.itemType === 'recurring' ? '循环事项' : '一次性事项');
            if (this.state.currency) tags.push(this.state.currency);
            if (this.state.sort !== 'dueAsc') {
                const names = { dueDesc: '到期最远', nameAsc: '名称A-Z', createdDesc: '最近添加', updatedDesc: '最近修改', amountDesc: '金额从高到低' };
                tags.push(names[this.state.sort] || this.state.sort);
            }
            const statusName = { active: '正常', paused: '暂停', archived: '归档', trash: '回收站' }[this.state.view] || this.state.view;
            if (this.state.view !== 'active') tags.unshift(statusName);
            host.innerHTML = `
                <div class="ltm-active-filters">
                    ${tags.length ? `<span>当前筛选：</span>${tags.map(t => `<span class="ltm-filter-tag">${Utils.escapeHTML(t)}</span>`).join('')}` : '<span>当前：全部正常事项</span>'}
                    ${tags.length || this.state.view !== 'active' ? '<button class="ltm-btn-link" data-action="clear-filters">清除筛选</button>' : ''}
                </div>
                <div class="ltm-result-count">${visibleCount} 个事项</div>
            `;
        },

        moneyHTML(map, empty = '—') {
            const rows = Object.entries(map || {}).sort(([a], [b]) => a.localeCompare(b));
            if (!rows.length) return `<span class="ltm-muted">${empty}</span>`;
            return rows.map(([currency, amount]) => `<div>${Utils.escapeHTML(currency)}&nbsp;&nbsp;${Utils.escapeHTML(Utils.formatAmount(Number(amount.toFixed(2)), currency))}</div>`).join('');
        },

        renderStatsPage(db) {
            const annual = StatisticsEngine.annualCosts(db);
            const next30 = StatisticsEngine.futureCosts(db, 30);
            const month = StatisticsEngine.futureCosts(db, 31, true);
            const due = StatisticsEngine.dueCounts(db);
            const status = StatisticsEngine.statusCounts(db);
            const byCategory = StatisticsEngine.byCategoryAnnual(db);
            return `
                <div class="ltm-stats-grid">
                    <div class="ltm-statbox"><div class="title">年度预计固定支出</div><div class="ltm-money-lines">${this.moneyHTML(annual)}</div></div>
                    <div class="ltm-statbox"><div class="title">未来 30 天预计支出</div><div class="ltm-money-lines">${this.moneyHTML(next30)}</div></div>
                    <div class="ltm-statbox"><div class="title">本月预计支出</div><div class="ltm-money-lines">${this.moneyHTML(month)}</div></div>
                </div>
                <div class="ltm-settings-grid">
                    <section class="ltm-panel">
                        <h2>未来到期</h2>
                        <div class="ltm-setting-row"><span>已逾期</span><strong>${due.overdue}</strong></div>
                        <div class="ltm-setting-row"><span>7 天内</span><strong>${due.d7}</strong></div>
                        <div class="ltm-setting-row"><span>8～30 天</span><strong>${due.d30}</strong></div>
                        <div class="ltm-setting-row"><span>31～90 天</span><strong>${due.d90}</strong></div>
                        <div class="ltm-setting-row"><span>90 天以上</span><strong>${due.far}</strong></div>
                    </section>
                    <section class="ltm-panel">
                        <h2>事项状态</h2>
                        <div class="ltm-setting-row"><span>正常</span><strong>${status.normal}</strong></div>
                        <div class="ltm-setting-row"><span>暂停</span><strong>${status.paused}</strong></div>
                        <div class="ltm-setting-row"><span>归档</span><strong>${status.archived}</strong></div>
                        <div class="ltm-setting-row"><span>回收站</span><strong>${status.trash}</strong></div>
                    </section>
                </div>
                <section class="ltm-panel">
                    <h2>按分类 · 年度固定支出</h2>
                    ${byCategory.length ? `<table class="ltm-simple-table"><thead><tr><th>分类</th><th>币种</th><th>预计 / 年</th></tr></thead><tbody>${byCategory.map(r => `<tr><td>${Utils.escapeHTML(r.category)}</td><td>${Utils.escapeHTML(r.currency)}</td><td><strong>${Utils.escapeHTML(Utils.formatAmount(Number(r.amount.toFixed(2)), r.currency))}</strong></td></tr>`).join('')}</tbody></table>` : '<div class="ltm-muted">还没有可统计的循环金额。</div>'}
                </section>
            `;
        },

        renderSettingsPage(db) {
            const settings = db.settings || Models.defaultSettings();
            const reminder = settings.reminder || Models.defaultSettings().reminder;
            const defaults = settings.defaults || Models.defaultSettings().defaults;
            const snapshots = SnapshotManager.list();
            return `
                <div class="ltm-settings-grid">
                    <section class="ltm-panel">
                        <h2>提醒设置</h2>
                        <div class="ltm-setting-row">
                            <div><strong>启用网页提醒</strong><div class="desc">关闭后普通网页不再弹长期事项提醒。</div></div>
                            <input id="ltm-setting-reminder-enabled" type="checkbox" ${reminder.enabled !== false ? 'checked' : ''}>
                        </div>
                        <div class="ltm-setting-row">
                            <div><strong>逾期每天提醒</strong><div class="desc">逾期事项每天最多进入一次汇总提醒。</div></div>
                            <input id="ltm-setting-overdue" type="checkbox" ${reminder.remindOverdue !== false ? 'checked' : ''}>
                        </div>
                        <div class="ltm-setting-row">
                            <div><strong>弹窗延迟</strong><div class="desc">普通网页打开后等待几秒再检查。</div></div>
                            <input id="ltm-setting-delay" type="number" min="0" max="30" step="1" value="${Number(reminder.popupDelaySeconds ?? 3)}">
                        </div>
                    </section>
                    <section class="ltm-panel">
                        <h2>新建默认值</h2>
                        <div class="ltm-setting-row">
                            <div><strong>默认币种</strong></div>
                            <select id="ltm-setting-currency">${Config.CURRENCIES.map(([code, symbol]) => `<option value="${code}" ${defaults.currency === code ? 'selected' : ''}>${code} ${symbol}</option>`).join('')}</select>
                        </div>
                        <div class="ltm-setting-row">
                            <div><strong>默认提醒节点</strong><div class="desc">例如 30, 7, 1, 0；0 表示当天。</div></div>
                            <input id="ltm-setting-reminders" type="text" value="${Utils.escapeHTML((defaults.reminderDays || Config.DEFAULT_REMINDER_DAYS).join(', '))}">
                        </div>
                        <div style="margin-top:14px"><button class="ltm-btn ltm-btn-primary" data-action="save-settings">保存设置</button></div>
                    </section>
                </div>

                <section class="ltm-panel">
                    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap"><h2 style="margin:0">分类管理</h2><button class="ltm-btn" data-action="add-category">＋ 新增分类</button></div>
                    <div class="ltm-category-list">${db.categories.slice().sort((a,b)=>(a.order||0)-(b.order||0)).map(c => `<div class="ltm-category-row"><span>${Utils.escapeHTML(c.name)}</span><div class="ltm-category-actions"><button class="ltm-btn" data-action="rename-category" data-id="${Utils.escapeHTML(c.id)}">重命名</button><button class="ltm-btn ltm-btn-danger" data-action="delete-category" data-id="${Utils.escapeHTML(c.id)}">删除</button></div></div>`).join('')}</div>
                </section>

                <section class="ltm-panel">
                    <h2>数据与备份</h2>
                    <div class="ltm-data-actions">
                        <button class="ltm-btn ltm-btn-primary" data-action="export-json">导出完整 JSON 备份</button>
                        <button class="ltm-btn" data-action="export-csv">导出事项 CSV</button>
                        <button class="ltm-btn" data-action="import-json">导入 JSON 备份</button>
                        <button class="ltm-btn ltm-btn-danger" data-action="clear-trash">清空回收站</button>
                    </div>
                    <div class="ltm-help" style="margin-top:9px">JSON 用于完整恢复；CSV 用于 Excel 查看整理。导入前系统会自动创建保护快照。</div>
                </section>

                <section class="ltm-panel">
                    <h2>自动快照 <span class="ltm-muted" style="font-size:12px;font-weight:400">最近 ${SnapshotManager.MAX} 份</span></h2>
                    ${snapshots.length ? `<div class="ltm-snapshot-list">${snapshots.map(s => `<div class="ltm-snapshot-row"><div><strong>${Utils.escapeHTML(SnapshotManager.label(s.reason))}</strong><div class="ltm-help">${Utils.escapeHTML(s.createdAt || '')}</div></div><button class="ltm-btn" data-action="restore-snapshot" data-id="${Utils.escapeHTML(s.id)}">恢复</button></div>`).join('')}</div>` : '<div class="ltm-muted">还没有自动快照。新建、编辑、续费、删除等操作后会逐渐产生。</div>'}
                </section>

                <section class="ltm-panel">
                    <h2>版本与数据</h2>
                    <div class="ltm-version-grid">
                        <div class="ltm-setting-row"><span>应用版本</span><strong>V${Utils.escapeHTML(Config.APP_VERSION)}</strong></div>
                        <div class="ltm-setting-row"><span>数据结构版本</span><strong>${Utils.escapeHTML(db.schemaVersion)}</strong></div>
                        <div class="ltm-setting-row"><span>事项数量</span><strong>${db.items.length}</strong></div>
                        <div class="ltm-setting-row"><span>分类数量</span><strong>${db.categories.length}</strong></div>
                        <div class="ltm-setting-row"><span>数据库创建</span><strong>${Utils.escapeHTML(db.createdAt || '—')}</strong></div>
                        <div class="ltm-setting-row"><span>最近更新</span><strong>${Utils.escapeHTML(db.updatedAt || '—')}</strong></div>
                    </div>
                    <div class="ltm-help" style="margin-top:8px">当前数据已通过 V0.6 兼容性规范化检查。升级脚本不会主动清空正式数据。</div>
                </section>
            `;
        },

        saveSettingsFromUI() {
            try {
                const db = Storage.loadDatabase();
                SnapshotManager.create('before-settings-change', db);
                const reminderTokens = document.getElementById('ltm-setting-reminders').value.split(',').map(v => v.trim()).filter(Boolean).map(Number);
                if (reminderTokens.some(v => !Number.isInteger(v) || v < 0)) throw new Error('默认提醒节点必须是大于等于 0 的整数');
                db.settings.reminder = {
                    ...(db.settings.reminder || {}),
                    enabled: document.getElementById('ltm-setting-reminder-enabled').checked,
                    dailyOnce: true,
                    remindOverdue: document.getElementById('ltm-setting-overdue').checked,
                    popupDelaySeconds: Math.min(30, Math.max(0, Number(document.getElementById('ltm-setting-delay').value || 3))),
                };
                db.settings.defaults = {
                    ...(db.settings.defaults || {}),
                    currency: document.getElementById('ltm-setting-currency').value,
                    reminderDays: [...new Set(reminderTokens)].sort((a,b)=>b-a),
                    renewalMode: db.settings.defaults?.renewalMode || 'scheduled',
                };
                Storage.saveDatabase(db);
                this.toast('设置已保存');
                this.render();
            } catch (error) { alert(error.message || '保存设置失败'); }
        },

        async importBackupFile(file) {
            try {
                const text = await file.text();
                let payload;
                try { payload = JSON.parse(text); } catch { throw new Error('JSON 文件格式无效'); }
                const candidate = BackupManager.validatePayload(payload);
                const exportedAt = payload?.exportedAt || candidate.updatedAt || '未知';
                const appVersion = payload?.appVersion || candidate.appVersion || '未知';
                const schemaVersion = payload?.schemaVersion ?? candidate.schemaVersion ?? '未知';
                const active = candidate.items.filter(i => !i.trashedAt && i.status === 'active').length;
                const archived = candidate.items.filter(i => !i.trashedAt && i.status === 'archived').length;
                const trash = candidate.items.filter(i => i.trashedAt).length;
                this.openConfirm({
                    title: '恢复完整备份？',
                    message: `备份时间：${exportedAt}\n应用版本：${appVersion}\n数据结构：${schemaVersion}\n事项总数：${candidate.items.length}（正常 ${active} / 归档 ${archived} / 回收站 ${trash}）\n分类：${candidate.categories.length}\n\n恢复将覆盖当前正式数据；覆盖前会自动创建“导入备份前”保护快照。`,
                    confirmText: '确认恢复',
                    onConfirm: () => {
                        try {
                            BackupManager.importJSONText(text);
                            this.closeModal();
                            this.state.tab = 'items';
                            this.state.view = 'active';
                            this.render();
                            this.toast('完整备份已恢复');
                        } catch (error) { this.closeModal(); alert(error.message || '导入失败'); }
                    },
                });
            } catch (error) { alert(error.message || '无法读取备份'); }
        },

        confirmSnapshotRestore(id) {
            this.openConfirm({
                title: '恢复这个快照？',
                message: '当前数据会先自动创建一份“恢复快照前”保护点，然后再恢复所选版本。',
                confirmText: '确认恢复',
                onConfirm: () => {
                    try {
                        SnapshotManager.restore(id);
                        this.closeModal();
                        this.state.tab = 'items';
                        this.state.view = 'active';
                        this.render();
                        this.toast('快照已恢复');
                    } catch (error) { this.closeModal(); this.toast(error.message || '恢复失败'); }
                },
            });
        },

        confirmPermanentDelete(id) {
            const db = Storage.loadDatabase();
            const item = ItemService.find(db, id);
            if (!item) return;
            this.openConfirm({
                title: '永久删除这条事项？',
                message: `“${item.name}”将从正式数据库中删除。系统会在删除前自动创建快照，因此仍可通过快照恢复整个数据库。`,
                confirmText: '永久删除',
                danger: true,
                onConfirm: () => {
                    try { ItemService.permanentDelete(id); this.closeModal(); this.render(); this.toast('已永久删除'); } catch (error) { this.closeModal(); this.toast(error.message || '删除失败'); }
                },
            });
        },

        confirmClearTrash() {
            const db = Storage.loadDatabase();
            const count = db.items.filter(i => i.trashedAt).length;
            if (!count) return this.toast('回收站已经是空的');
            this.openConfirm({
                title: '清空回收站？',
                message: `将永久删除回收站中的 ${count} 条事项。操作前会自动创建完整快照。`,
                confirmText: '清空回收站',
                danger: true,
                onConfirm: () => {
                    try { ItemService.clearTrash(); this.closeModal(); this.render(); this.toast(`已清空 ${count} 条事项`); } catch (error) { this.closeModal(); this.toast(error.message || '清空失败'); }
                },
            });
        },

        addCategory() {
            const name = prompt('新分类名称：');
            if (name === null) return;
            try { CategoryService.add(name); this.render(); this.toast('分类已新增'); } catch (error) { alert(error.message); }
        },

        renameCategory(id) {
            const db = Storage.loadDatabase();
            const category = db.categories.find(c => c.id === id);
            if (!category) return;
            const name = prompt('新的分类名称：', category.name);
            if (name === null) return;
            try { CategoryService.rename(id, name); this.render(); this.toast('分类已重命名'); } catch (error) { alert(error.message); }
        },

        deleteCategory(id) {
            const db = Storage.loadDatabase();
            const category = db.categories.find(c => c.id === id);
            if (!category) return;
            const used = db.items.filter(i => i.categoryId === id).length;
            this.openConfirm({
                title: `删除分类“${category.name}”？`,
                message: used ? `当前有 ${used} 条事项使用这个分类。删除分类后，它们会变为“未分类”，事项本身不会被删除。` : '删除分类不会删除任何事项。',
                confirmText: '删除分类',
                danger: true,
                onConfirm: () => {
                    try { CategoryService.remove(id); this.closeModal(); this.render(); this.toast('分类已删除'); } catch (error) { this.closeModal(); this.toast(error.message || '删除失败'); }
                },
            });
        },

        setItemStatus(id, status) {
            try {
                const item = ItemService.setStatus(id, status);
                const labels = { active: '已恢复为正常', paused: '已暂停', archived: '已归档' };
                this.render();
                this.toast(labels[item.status] || '状态已更新');
            } catch (error) { this.toast(error.message || '状态更新失败'); }
        },

        applyQuickFilter(range) {
            this.state.tab = 'items';
            this.state.view = 'active';
            this.state.search = '';
            this.state.categoryId = null;
            this.state.itemType = 'all';
            this.state.currency = null;
            this.state.sort = 'dueAsc';
            this.state.customStart = '';
            this.state.customEnd = '';
            this.state.dueRange = ['need', '30'].includes(range) ? range : 'all';
            this.persistFilterState();
            this.render();
        },

        applyCustomRange() {
            const start = document.getElementById('ltm-custom-start')?.value || '';
            const end = document.getElementById('ltm-custom-end')?.value || '';
            if (!Utils.parseDateParts(start) || !Utils.parseDateParts(end)) return this.toast('请选择完整的开始和结束日期');
            if (DateEngine.dayNumber(start) > DateEngine.dayNumber(end)) return this.toast('开始日期不能晚于结束日期');
            this.state.customStart = start;
            this.state.customEnd = end;
            this.state.dueRange = 'custom';
            this.persistFilterState();
            this.render();
        },

        viewButton(view, label) {
            const active = this.state.view === view ? 'active' : '';
            return `<button class="${active}" data-action="view" data-view="${view}">${label}</button>`;
        },

        renderListOnly() {
            const container = document.getElementById('ltm-list-container');
            if (!container) return;
            const db = Storage.loadDatabase();
            const items = this.getVisibleItems(db);
            const categoryMap = this.categoryMap(db);
            this.renderFilterSummary(db, items.length);

            if (!items.length) {
                const q = this.state.search.trim();
                const hasFilters = Boolean(q || this.state.categoryId || this.state.dueRange !== 'all' || this.state.itemType !== 'all' || this.state.currency || this.state.sort !== 'dueAsc' || this.state.view !== 'active');
                container.innerHTML = `
                    <div class="ltm-empty">
                        <h3>${hasFilters ? '没有匹配的事项' : '这里还没有事项'}</h3>
                        <p>${hasFilters ? '调整搜索或筛选条件试试。' : '先建立第一条长期事项。'}</p>
                        ${hasFilters ? '<button class="ltm-btn" data-action="clear-filters">清除筛选</button>' : '<button class="ltm-btn ltm-btn-primary" data-action="new">＋ 新建事项</button>'}
                    </div>
                `;
                return;
            }

            if (this.state.view === 'active') {
                container.innerHTML = this.renderActiveGroups(items, categoryMap);
            } else {
                container.innerHTML = `<div class="ltm-grid">${items.map(item => this.renderCard(item, categoryMap)).join('')}</div>`;
            }
        },

        renderActiveGroups(items, categoryMap) {
            const groups = [
                { key: 'overdue', title: '🔴 已逾期', match: d => d !== null && d < 0 },
                { key: 'week', title: '🔴 7 天内', match: d => d !== null && d >= 0 && d <= 7 },
                { key: 'month', title: '🟠 30 天内', match: d => d !== null && d > 7 && d <= 30 },
                { key: 'quarter', title: '🟡 90 天内', match: d => d !== null && d > 30 && d <= 90 },
                { key: 'far', title: '⚪ 90 天以上', match: d => d === null || d > 90 },
            ];

            const sections = groups.map(group => {
                const groupItems = items.filter(item => group.match(DateEngine.daysFromToday(item.dueDate)));
                if (!groupItems.length) return '';

                const isFar = group.key === 'far';
                const hasActiveFilter = Boolean(this.state.search.trim() || this.state.categoryId || this.state.dueRange !== 'all' || this.state.itemType !== 'all' || this.state.currency || this.state.sort !== 'dueAsc');
                const collapsed = isFar && this.state.farCollapsed && !hasActiveFilter;
                const toggle = isFar
                    ? `<button class="ltm-group-toggle" data-action="toggle-far">${collapsed ? '展开' : '折叠'}</button>`
                    : '';

                return `
                    <section class="ltm-group">
                        <div class="ltm-group-head">
                            <div class="ltm-group-title">
                                <h2>${group.title}</h2>
                                <span class="ltm-group-count">${groupItems.length} 项</span>
                            </div>
                            ${toggle}
                        </div>
                        ${collapsed
                            ? `<div class="ltm-collapsed-summary"><span>${groupItems.length} 个远期事项已折叠，减少页面滚动。</span><button class="ltm-btn" data-action="toggle-far">展开查看</button></div>`
                            : `<div class="ltm-grid">${groupItems.map(item => this.renderCard(item, categoryMap)).join('')}</div>`}
                    </section>
                `;
            }).join('');

            return `<div class="ltm-groups">${sections}</div>`;
        },

        renderCard(item, categoryMap) {
            const category = categoryMap.get(item.categoryId)?.name || '未分类';
            const dueLabel = DateEngine.dueLabel(item.dueDate);
            const risk = DateEngine.riskClass(item.dueDate);
            const amount = Utils.formatAmount(item.amount, item.currency);
            const repeat = this.recurrenceLabel(item);
            const url = Utils.safeHttpUrl(item.url);
            const completeLabel = item.type === 'recurring' ? '已续费' : '已处理';
            const today = Utils.todayString();
            const snoozeNum = item.snoozeUntil ? DateEngine.dayNumber(item.snoozeUntil) : null;
            const todayNum = DateEngine.dayNumber(today);
            const snoozing = snoozeNum !== null && todayNum !== null && todayNum < snoozeNum;
            const snoozeOptions = !snoozing ? ItemService.snoozeOptions(item, today) : [];

            let actions = '';
            if (item.trashedAt) {
                actions = `<button class="ltm-btn" data-action="restore" data-id="${Utils.escapeHTML(item.id)}">恢复</button><button class="ltm-btn ltm-btn-danger" data-action="permanent-delete" data-id="${Utils.escapeHTML(item.id)}">永久删除</button>`;
            } else {
                const primary = [
                    item.status === 'active' ? `<button class="ltm-btn ltm-btn-primary" data-action="complete" data-id="${Utils.escapeHTML(item.id)}">${completeLabel}</button>` : '',
                    item.status === 'active' && snoozing ? `<button class="ltm-btn" data-action="clear-snooze" data-id="${Utils.escapeHTML(item.id)}">取消稍后</button>` : '',
                    item.status === 'active' && !snoozing && snoozeOptions.length ? `<button class="ltm-btn" data-action="snooze" data-id="${Utils.escapeHTML(item.id)}">稍后提醒</button>` : '',
                    url ? `<a class="ltm-btn" href="${Utils.escapeHTML(url)}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;text-align:center;font-weight:650;">去处理 ↗</a>` : '',
                ].filter(Boolean).join('');

                const statusAction = item.status === 'active'
                    ? `<button class="ltm-btn" data-action="set-status" data-id="${Utils.escapeHTML(item.id)}" data-status="paused">暂停</button><button class="ltm-btn" data-action="set-status" data-id="${Utils.escapeHTML(item.id)}" data-status="archived">归档</button>`
                    : `<button class="ltm-btn" data-action="set-status" data-id="${Utils.escapeHTML(item.id)}" data-status="active">恢复正常</button>${item.status === 'paused' ? `<button class="ltm-btn" data-action="set-status" data-id="${Utils.escapeHTML(item.id)}" data-status="archived">归档</button>` : `<button class="ltm-btn" data-action="set-status" data-id="${Utils.escapeHTML(item.id)}" data-status="paused">转为暂停</button>`}`;

                const secondary = [
                    `<button class="ltm-btn" data-action="edit" data-id="${Utils.escapeHTML(item.id)}">编辑</button>`,
                    statusAction,
                    `<button class="ltm-btn ltm-btn-danger" data-action="trash" data-id="${Utils.escapeHTML(item.id)}">删除</button>`,
                ].join('');

                actions = primary + secondary;
            }

            const statusLabel = item.status === 'paused' ? '暂停' : item.status === 'archived' ? '归档' : '';
            return `
                <article class="ltm-card ${risk ? `risk-${risk}` : ''}">
                    <div class="ltm-card-main">
                        <div class="ltm-card-top">
                            <div class="ltm-due ${risk}">${Utils.escapeHTML(dueLabel)}</div>
                            <div class="ltm-card-category" title="${Utils.escapeHTML(category)}">${statusLabel ? `${Utils.escapeHTML(statusLabel)} · ` : ''}${Utils.escapeHTML(category)}</div>
                        </div>
                        <h3>${Utils.escapeHTML(item.name)}</h3>
                        <div class="ltm-meta">
                            <span>${Utils.escapeHTML(item.dueDate)}</span>
                            ${repeat ? `<span>·</span><span>${Utils.escapeHTML(repeat)}</span>` : ''}
                            ${amount ? `<span>·</span><span class="ltm-amount">${Utils.escapeHTML(amount)}</span>` : ''}
                        </div>
                        ${item.note ? `<div class="ltm-note">${Utils.escapeHTML(item.note)}</div>` : ''}
                        ${snoozing ? `<div class="ltm-note" style="margin-top:7px;color:#6b7280;">提醒暂停至 ${Utils.escapeHTML(item.snoozeUntil)}</div>` : ''}
                    </div>
                    <div class="ltm-card-actions">${actions}</div>
                </article>
            `;
        },

        recurrenceLabel(item) {
            if (item.type !== 'recurring' || !item.recurrence?.enabled) return '';
            const { interval, unit } = item.recurrence;
            const unitLabel = unit === 'day' ? '天' : unit === 'month' ? '个月' : '年';
            if (unit === 'month' && interval === 1) return '每月';
            if (unit === 'year' && interval === 1) return '每年';
            return `每 ${interval} ${unitLabel}`;
        },

        openEditor(id = null) {
            const db = Storage.loadDatabase();
            const item = id ? ItemService.find(db, id) : null;
            if (id && !item) return this.toast('找不到该事项');

            const defaults = db.settings?.defaults || Models.defaultSettings().defaults;
            const preset = item ? Models.recurrencePreset(item.recurrence) : 'year1';
            const recurrence = item?.recurrence || { interval: 1, unit: 'year' };
            const reminderDays = item?.reminderDays || defaults.reminderDays || Config.DEFAULT_REMINDER_DAYS;

            const categoryOptions = [
                '<option value="">未分类</option>',
                ...db.categories
                    .slice()
                    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
                    .map(c => `<option value="${Utils.escapeHTML(c.id)}" ${item?.categoryId === c.id ? 'selected' : ''}>${Utils.escapeHTML(c.name)}</option>`),
            ].join('');

            const currencyOptions = Config.CURRENCIES.map(([code, symbol]) => {
                const current = item?.currency || defaults.currency || Config.DEFAULT_CURRENCY;
                return `<option value="${code}" ${current === code ? 'selected' : ''}>${code} ${symbol}</option>`;
            }).join('');

            const status = item?.status || 'active';
            const type = item?.type || 'recurring';
            const renewalMode = item?.renewalMode || defaults.renewalMode || 'scheduled';
            const dueDate = item?.dueDate || Utils.todayString();

            const html = `
                <div class="ltm-modal-backdrop" id="ltm-modal-backdrop">
                    <div class="ltm-modal" role="dialog" aria-modal="true">
                        <div class="ltm-modal-head">
                            <h2>${item ? '编辑事项' : '新建事项'}</h2>
                            <button class="ltm-btn-link" data-action="close-modal" aria-label="关闭">✕</button>
                        </div>
                        <form id="ltm-item-form">
                            <div class="ltm-modal-body">
                                <div class="ltm-form-grid">
                                    <div class="ltm-field full">
                                        <label for="ltm-name">名称 *</label>
                                        <input id="ltm-name" name="name" maxlength="100" required value="${Utils.escapeHTML(item?.name || '')}" placeholder="例如：CloudCone VPS">
                                    </div>

                                    <div class="ltm-field">
                                        <label for="ltm-item-type">类型 *</label>
                                        <select id="ltm-item-type" name="type">
                                            <option value="recurring" ${type === 'recurring' ? 'selected' : ''}>循环事项</option>
                                            <option value="oneTime" ${type === 'oneTime' ? 'selected' : ''}>一次性事项</option>
                                        </select>
                                    </div>

                                    <div class="ltm-field">
                                        <label for="ltm-category">分类</label>
                                        <select id="ltm-category" name="categoryId">${categoryOptions}</select>
                                    </div>

                                    <div class="ltm-field">
                                        <label for="ltm-date">下次日期 *</label>
                                        <input id="ltm-date" name="dueDate" type="date" required value="${Utils.escapeHTML(dueDate)}">
                                    </div>

                                    <div class="ltm-field" id="ltm-repeat-field">
                                        <label for="ltm-repeat-preset">重复</label>
                                        <select id="ltm-repeat-preset" name="repeatPreset">
                                            <option value="month1" ${preset === 'month1' ? 'selected' : ''}>每月</option>
                                            <option value="month3" ${preset === 'month3' ? 'selected' : ''}>每 3 个月</option>
                                            <option value="month6" ${preset === 'month6' ? 'selected' : ''}>每 6 个月</option>
                                            <option value="year1" ${preset === 'year1' ? 'selected' : ''}>每年</option>
                                            <option value="custom" ${preset === 'custom' ? 'selected' : ''}>自定义</option>
                                        </select>
                                    </div>

                                    <div class="ltm-field full" id="ltm-custom-repeat" style="display:none;">
                                        <label>自定义周期</label>
                                        <div class="ltm-inline">
                                            <input id="ltm-custom-interval" type="number" min="1" step="1" value="${Number(recurrence.interval) || 1}">
                                            <select id="ltm-custom-unit">
                                                <option value="day" ${recurrence.unit === 'day' ? 'selected' : ''}>天</option>
                                                <option value="month" ${recurrence.unit === 'month' ? 'selected' : ''}>月</option>
                                                <option value="year" ${recurrence.unit === 'year' ? 'selected' : ''}>年</option>
                                            </select>
                                        </div>
                                    </div>

                                    <div class="ltm-field">
                                        <label for="ltm-amount">金额</label>
                                        <input id="ltm-amount" name="amount" type="number" min="0" step="0.01" value="${item?.amount ?? ''}" placeholder="可留空">
                                    </div>

                                    <div class="ltm-field">
                                        <label for="ltm-currency">币种</label>
                                        <select id="ltm-currency" name="currency">${currencyOptions}</select>
                                    </div>

                                    <div class="ltm-field full">
                                        <label for="ltm-url">处理网址</label>
                                        <input id="ltm-url" name="url" type="url" value="${Utils.escapeHTML(item?.url || '')}" placeholder="https://...">
                                    </div>

                                    <div class="ltm-field full">
                                        <label for="ltm-note">备注</label>
                                        <textarea id="ltm-note" name="note" placeholder="例如：洛杉矶节点，年付">${Utils.escapeHTML(item?.note || '')}</textarea>
                                    </div>

                                    <details class="ltm-details">
                                        <summary>更多设置</summary>
                                        <div class="ltm-details-inner">
                                            <div class="ltm-field full">
                                                <label for="ltm-reminders">提前提醒天数</label>
                                                <input id="ltm-reminders" value="${Utils.escapeHTML(reminderDays.join(', '))}" placeholder="30, 7, 1, 0">
                                                <div class="ltm-help">用英文逗号分隔；0 表示当天。每个节点最多提醒一次；错过节点后会在下次使用浏览器时补提醒。</div>
                                            </div>

                                            <div class="ltm-field" id="ltm-renewal-field">
                                                <label for="ltm-renewal">顺延方式</label>
                                                <select id="ltm-renewal">
                                                    <option value="scheduled" ${renewalMode === 'scheduled' ? 'selected' : ''}>按原到期日</option>
                                                    <option value="handled" ${renewalMode === 'handled' ? 'selected' : ''}>按实际处理日</option>
                                                </select>
                                            </div>

                                            <div class="ltm-field">
                                                <label for="ltm-status">状态</label>
                                                <select id="ltm-status">
                                                    <option value="active" ${status === 'active' ? 'selected' : ''}>正常</option>
                                                    <option value="paused" ${status === 'paused' ? 'selected' : ''}>暂停</option>
                                                    <option value="archived" ${status === 'archived' ? 'selected' : ''}>归档</option>
                                                </select>
                                            </div>

                                            <div class="ltm-field full">
                                                <label for="ltm-account-note">账号备注</label>
                                                <textarea id="ltm-account-note" placeholder="例如：Google 登录 / Visa 尾号 6288">${Utils.escapeHTML(item?.accountNote || '')}</textarea>
                                                <div class="ltm-help">不要保存密码、验证码、银行卡完整号码或 CVV。</div>
                                            </div>
                                        </div>
                                    </details>

                                    ${item && Array.isArray(item.history) && item.history.length ? `
                                        <div class="ltm-history full">
                                            <h3>处理历史</h3>
                                            ${item.history.slice(0, 20).map(h => `
                                                <div class="ltm-history-row">
                                                    <div><strong>${Utils.escapeHTML(h.handledDate || '')}</strong> · ${item.type === 'recurring' ? '已续费' : '已处理'}</div>
                                                    <div class="ltm-help">原到期：${Utils.escapeHTML(h.previousDueDate || '-')} ${h.nextDueDate ? `→ 下一次：${Utils.escapeHTML(h.nextDueDate)}` : '→ 已归档'}${Number(h.skippedCycles) > 1 ? ` · 跨过 ${Number(h.skippedCycles)} 期` : ''}${h.amount !== null && h.amount !== undefined ? ` · ${Utils.escapeHTML(Utils.formatAmount(h.amount, h.currency))}` : ''}</div>
                                                </div>
                                            `).join('')}
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                            <div class="ltm-modal-foot">
                                <button type="button" class="ltm-btn" data-action="close-modal">取消</button>
                                <button type="submit" class="ltm-btn ltm-btn-primary">${item ? '保存修改' : '保存事项'}</button>
                            </div>
                        </form>
                    </div>
                </div>
            `;

            document.getElementById('ltm-modal-root').innerHTML = html;
            this.syncEditorVisibility();

            const form = document.getElementById('ltm-item-form');
            form.addEventListener('submit', (event) => {
                event.preventDefault();
                try {
                    const payload = this.readEditorPayload();
                    if (item) ItemService.update(item.id, payload);
                    else ItemService.create(payload);
                    this.closeModal();
                    this.render();
                    this.toast(item ? '已保存修改' : '事项已创建');
                } catch (error) {
                    alert(error.message || '保存失败');
                }
            });

            requestAnimationFrame(() => document.getElementById('ltm-name')?.focus());
        },

        readEditorPayload() {
            const name = document.getElementById('ltm-name').value.trim();
            const type = document.getElementById('ltm-item-type').value;
            const categoryId = document.getElementById('ltm-category').value || null;
            const dueDate = document.getElementById('ltm-date').value;
            const repeatPreset = type === 'recurring' ? document.getElementById('ltm-repeat-preset').value : 'none';
            const customInterval = Number(document.getElementById('ltm-custom-interval')?.value || 1);
            const customUnit = document.getElementById('ltm-custom-unit')?.value || 'month';
            const recurrence = type === 'recurring'
                ? Models.recurrenceFromPreset(repeatPreset, customInterval, customUnit)
                : Models.recurrenceFromPreset('none');

            if (type === 'recurring' && repeatPreset === 'custom' && (!Number.isInteger(customInterval) || customInterval <= 0)) {
                throw new Error('自定义周期必须是大于 0 的整数');
            }
            const amountText = document.getElementById('ltm-amount').value.trim();
            const amount = amountText === '' ? null : Number(amountText);
            if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error('金额必须是大于等于 0 的数字');
            const currency = document.getElementById('ltm-currency').value;
            const urlText = document.getElementById('ltm-url').value.trim();
            const url = urlText ? Utils.safeHttpUrl(urlText) : '';
            if (urlText && !url) throw new Error('处理网址必须是有效的 http:// 或 https:// 地址');

            const reminderText = document.getElementById('ltm-reminders').value.trim();
            let reminderDays = [];
            if (reminderText) {
                const reminderTokens = reminderText.split(',').map(v => v.trim()).filter(Boolean);
                const parsedReminderDays = reminderTokens.map(v => Number(v));
                if (parsedReminderDays.some(v => !Number.isInteger(v) || v < 0)) {
                    throw new Error('提醒天数请使用大于等于 0 的整数，并用英文逗号分隔，例如：30, 7, 1, 0');
                }
                reminderDays = [...new Set(parsedReminderDays)].sort((a, b) => b - a);
            }

            if (name.length > 100) throw new Error('名称不能超过 100 个字符');
            const note = document.getElementById('ltm-note').value.trim();
            const accountNote = document.getElementById('ltm-account-note').value.trim();
            if (note.length > 2000) throw new Error('备注不能超过 2000 个字符');
            if (accountNote.length > 1000) throw new Error('账号备注不能超过 1000 个字符');

            return {
                name,
                type,
                categoryId,
                dueDate,
                recurrence,
                renewalMode: type === 'recurring' ? document.getElementById('ltm-renewal').value : null,
                amount,
                currency: amount === null ? null : currency,
                reminderDays,
                url,
                accountNote,
                note,
                status: document.getElementById('ltm-status').value,
            };
        },

        syncEditorVisibility() {
            const type = document.getElementById('ltm-item-type')?.value;
            const preset = document.getElementById('ltm-repeat-preset')?.value;
            const repeatField = document.getElementById('ltm-repeat-field');
            const customField = document.getElementById('ltm-custom-repeat');
            const renewalField = document.getElementById('ltm-renewal-field');
            if (!repeatField) return;
            const recurring = type === 'recurring';
            repeatField.style.display = recurring ? '' : 'none';
            if (renewalField) renewalField.style.display = recurring ? '' : 'none';
            if (customField) customField.style.display = recurring && preset === 'custom' ? '' : 'none';
        },

        confirmComplete(id) {
            const db = Storage.loadDatabase();
            const item = ItemService.find(db, id);
            if (!item) return this.toast('找不到该事项');

            let preview;
            try {
                preview = DateEngine.previewCompletion(item, Utils.todayString());
            } catch (error) {
                return this.toast(error.message || '日期计算失败');
            }

            const recurring = item.type === 'recurring';
            const title = recurring ? '确认已续费？' : '确认已处理？';
            const modeLabel = item.renewalMode === 'handled' ? '按实际处理日顺延' : '按原到期日顺延';
            const nextLine = recurring
                ? `下一次：${preview.nextDueDate}\n顺延：${modeLabel}${preview.skippedCycles > 1 ? `\n已跨过 ${preview.skippedCycles} 个周期，直接跳到第一个未来日期` : ''}`
                : '处理后：自动移入归档';

            this.openConfirm({
                title,
                message: `“${item.name}”\n原到期：${preview.previousDueDate}\n处理日：${preview.handledDate}\n${nextLine}`,
                confirmText: recurring ? '确认已续费' : '确认已处理',
                onConfirm: () => {
                    try {
                        ItemService.complete(id, Utils.todayString());
                        this.closeModal();
                        this.render();
                        this.toast(recurring ? `已续费，下一次 ${preview.nextDueDate}` : '已处理并归档');
                    } catch (error) {
                        this.closeModal();
                        this.toast(error.message || '处理失败');
                    }
                },
            });
        },

        openSnooze(id) {
            const db = Storage.loadDatabase();
            const item = ItemService.find(db, id);
            if (!item) return this.toast('找不到该事项');
            const options = ItemService.snoozeOptions(item, Utils.todayString());
            if (!options.length) return this.toast('当前没有可用的稍后提醒时长');
            const buttons = options.map(days => `<button class="ltm-btn" data-action="snooze-choice" data-id="${Utils.escapeHTML(item.id)}" data-days="${days}">${days} 天后</button>`).join('');
            document.getElementById('ltm-modal-root').innerHTML = `
                <div class="ltm-modal-backdrop">
                    <div class="ltm-modal" role="dialog" aria-modal="true" style="width:min(500px,100%);">
                        <div class="ltm-modal-head">
                            <h2>稍后提醒</h2>
                            <button class="ltm-btn-link" data-action="close-modal">✕</button>
                        </div>
                        <div class="ltm-modal-body">
                            <p class="ltm-confirm-text">“${Utils.escapeHTML(item.name)}”\n到期日：${Utils.escapeHTML(item.dueDate)}\n只暂停网页提醒，不会修改真实到期日。为了不跨过下一个更紧急提醒节点，可选时长已自动限制。</p>
                            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px;">${buttons}</div>
                        </div>
                        <div class="ltm-modal-foot"><button class="ltm-btn" data-action="close-modal">取消</button></div>
                    </div>
                </div>
            `;
        },

        applySnooze(id, days) {
            try {
                const until = ItemService.setSnooze(id, days, Utils.todayString());
                this.closeModal();
                this.render();
                this.toast(`已暂停提醒至 ${until}`);
            } catch (error) {
                this.closeModal();
                this.toast(error.message || '稍后提醒设置失败');
            }
        },

        clearSnooze(id) {
            try {
                ItemService.clearSnooze(id);
                this.render();
                this.toast('已恢复正常提醒');
            } catch (error) {
                this.toast(error.message || '恢复提醒失败');
            }
        },

        confirmTrash(id) {
            const db = Storage.loadDatabase();
            const item = ItemService.find(db, id);
            if (!item) return this.toast('找不到该事项');
            this.openConfirm({
                title: '移入回收站？',
                message: `“${item.name}”将进入回收站，不会立即永久删除。`,
                confirmText: '移入回收站',
                danger: true,
                onConfirm: () => {
                    ItemService.moveToTrash(id);
                    this.closeModal();
                    this.render();
                    this.toast('已移入回收站');
                },
            });
        },

        restore(id) {
            try {
                ItemService.restore(id);
                this.render();
                this.toast('事项已恢复');
            } catch (error) {
                this.toast(error.message || '恢复失败');
            }
        },

        openConfirm({ title, message, confirmText = '确认', danger = false, onConfirm }) {
            document.getElementById('ltm-modal-root').innerHTML = `
                <div class="ltm-modal-backdrop">
                    <div class="ltm-modal" role="dialog" aria-modal="true" style="width:min(480px,100%);">
                        <div class="ltm-modal-head">
                            <h2>${Utils.escapeHTML(title)}</h2>
                            <button class="ltm-btn-link" data-action="close-modal">✕</button>
                        </div>
                        <div class="ltm-modal-body">
                            <p class="ltm-confirm-text">${Utils.escapeHTML(message)}</p>
                        </div>
                        <div class="ltm-modal-foot">
                            <button class="ltm-btn" data-action="close-modal">取消</button>
                            <button id="ltm-confirm-button" class="ltm-btn ${danger ? 'ltm-btn-danger' : 'ltm-btn-primary'}">${Utils.escapeHTML(confirmText)}</button>
                        </div>
                    </div>
                </div>
            `;
            document.getElementById('ltm-confirm-button').addEventListener('click', onConfirm, { once: true });
        },

        closeModal() {
            const root = document.getElementById('ltm-modal-root');
            if (root) root.innerHTML = '';
        },

        toast(message) {
            const root = document.getElementById('ltm-toast-root');
            if (!root) return;
            const el = document.createElement('div');
            el.className = 'ltm-toast';
            el.textContent = message;
            root.appendChild(el);
            setTimeout(() => el.remove(), 2600);
        },
    };

    /* =========================================================
     * 09. Reminder Engine
     * ======================================================= */
    const ReminderEngine = {
        normalizeNodeState(runtime, item) {
            const stateMap = runtime.itemReminderState || (runtime.itemReminderState = {});
            let state = stateMap[item.id];
            if (!state || state.dueDate !== item.dueDate) {
                state = { dueDate: item.dueDate, notifiedNodes: [] };
                stateMap[item.id] = state;
            }
            if (!Array.isArray(state.notifiedNodes)) state.notifiedNodes = [];
            return state;
        },

        getEligible(db, runtime, today = Utils.todayString()) {
            const settings = db.settings?.reminder || Models.defaultSettings().reminder;
            if (!settings.enabled) return [];
            if (runtime.mutedDate === today) return [];
            if (settings.dailyOnce && runtime.lastAutoPopupDate === today) return [];

            const todayNum = DateEngine.dayNumber(today);
            if (todayNum === null) return [];
            const result = [];

            for (const item of db.items) {
                if (!item || item.trashedAt || item.status !== 'active') continue;
                const dueNum = DateEngine.dayNumber(item.dueDate);
                if (dueNum === null) continue;

                const daysLeft = dueNum - todayNum;
                let snoozeWake = false;
                if (item.snoozeUntil) {
                    const snoozeNum = DateEngine.dayNumber(item.snoozeUntil);
                    if (snoozeNum !== null && todayNum < snoozeNum) continue;
                    if (snoozeNum !== null && todayNum >= snoozeNum && daysLeft >= 0) snoozeWake = true;
                }

                if (daysLeft < 0) {
                    if (settings.remindOverdue) {
                        result.push({ item, type: 'overdue', daysLeft, crossedNodes: [] });
                    }
                    continue;
                }

                if (snoozeWake) {
                    result.push({ item, type: 'snooze', daysLeft, crossedNodes: [], pendingNodes: [] });
                    continue;
                }

                const nodes = [...new Set((Array.isArray(item.reminderDays) ? item.reminderDays : [])
                    .filter(n => Number.isInteger(n) && n >= 0))]
                    .sort((a, b) => b - a);
                if (!nodes.length) continue;

                const crossedNodes = nodes.filter(node => daysLeft <= node);
                if (!crossedNodes.length) continue;
                const state = this.normalizeNodeState(runtime, item);
                const notified = new Set(state.notifiedNodes);
                const pending = crossedNodes.filter(node => !notified.has(node));
                if (!pending.length) continue;

                result.push({ item, type: 'node', daysLeft, crossedNodes, pendingNodes: pending });
            }

            return result.sort((a, b) => {
                if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
                return String(a.item.name).localeCompare(String(b.item.name), 'zh-CN');
            });
        },

        markPopupShown(entries, runtime, db, today = Utils.todayString()) {
            let dbChanged = false;
            for (const entry of entries) {
                if (entry.type === 'node') {
                    const state = this.normalizeNodeState(runtime, entry.item);
                    const merged = new Set(state.notifiedNodes);
                    for (const node of entry.crossedNodes || []) merged.add(node);
                    state.notifiedNodes = [...merged].sort((a, b) => b - a);
                }
                if (entry.type === 'snooze' && entry.item.snoozeUntil) {
                    entry.item.snoozeUntil = null;
                    entry.item.updatedAt = Utils.nowLocalISOString();
                    dbChanged = true;
                }
            }
            runtime.lastAutoPopupDate = today;
            Storage.saveRuntime(runtime);
            if (dbChanged) Storage.saveDatabase(db);
        },

        muteToday() {
            const runtime = Storage.loadRuntime();
            runtime.mutedDate = Utils.todayString();
            runtime.lastAutoPopupDate = Utils.todayString();
            Storage.saveRuntime(runtime);
        },
    };

    /* =========================================================
     * 10. Reminder UI — 普通网页上的轻量汇总提醒
     * ======================================================= */
    const ReminderUI = {
        root: null,

        itemLine(entry) {
            const item = entry.item;
            const amount = Utils.formatAmount(item.amount, item.currency);
            let stateText;
            if (entry.daysLeft < 0) stateText = `已逾期 ${Math.abs(entry.daysLeft)} 天`;
            else if (entry.type === 'snooze') stateText = entry.daysLeft === 0 ? '稍后提醒 · 今天到期' : `稍后提醒 · 还有 ${entry.daysLeft} 天`;
            else if (entry.daysLeft === 0) stateText = '今天到期';
            else stateText = `还有 ${entry.daysLeft} 天`;
            return `
                <div class="ltm-r-item">
                    <div class="ltm-r-item-main">
                        <div class="ltm-r-name">${Utils.escapeHTML(item.name)}</div>
                        <div class="ltm-r-sub">${Utils.escapeHTML(item.dueDate)}${amount ? ` · ${Utils.escapeHTML(amount)}` : ''}</div>
                    </div>
                    <div class="ltm-r-state ${entry.daysLeft <= 7 ? 'urgent' : ''}">${Utils.escapeHTML(stateText)}</div>
                </div>
            `;
        },

        show(entries) {
            if (!entries.length || this.root) return;
            const host = document.createElement('div');
            host.id = 'ltm-reminder-host';
            host.style.cssText = 'position:fixed;z-index:2147483647;right:20px;bottom:20px;width:380px;max-width:calc(100vw - 24px);pointer-events:none;';
            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `
                <style>
                    *{box-sizing:border-box}
                    .box{pointer-events:auto;background:#fff;color:#17191c;border:1px solid #e4e7eb;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.18);font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
                    .head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 16px 12px;border-bottom:1px solid #edf0f2}
                    .title{font-size:16px;font-weight:750;margin:0 0 3px}.desc{font-size:12px;color:#737983}
                    .close{border:0;background:transparent;color:#8a9099;font-size:18px;line-height:1;padding:2px 4px;cursor:pointer}
                    .list{max-height:330px;overflow:auto;padding:5px 14px}
                    .ltm-r-item{display:flex;gap:14px;justify-content:space-between;align-items:center;padding:11px 2px;border-bottom:1px solid #f0f2f4}.ltm-r-item:last-child{border-bottom:0}
                    .ltm-r-item-main{min-width:0}.ltm-r-name{font-size:14px;font-weight:680;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}.ltm-r-sub{font-size:12px;color:#858b94;margin-top:4px}
                    .ltm-r-state{font-size:12px;font-weight:700;color:#b56308;background:#fff6e7;border-radius:999px;padding:5px 8px;white-space:nowrap}.ltm-r-state.urgent{color:#c73535;background:#fff0f0}
                    .foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 14px;background:#fafbfc;border-top:1px solid #edf0f2}
                    button{font:inherit;cursor:pointer;border-radius:9px;padding:8px 11px;border:1px solid #dfe3e8;background:#fff;color:#34383d}.primary{background:#1f2937;border-color:#1f2937;color:#fff;font-weight:650}
                    @media(max-width:520px){.ltm-r-name{max-width:160px}.foot{flex-wrap:wrap}}
                </style>
                <div class="box" role="status" aria-live="polite">
                    <div class="head">
                        <div><div class="title">长期事项提醒</div><div class="desc">${entries.length} 个事项需要注意</div></div>
                        <button class="close" data-act="close" aria-label="关闭">×</button>
                    </div>
                    <div class="list">${entries.map(e => this.itemLine(e)).join('')}</div>
                    <div class="foot">
                        <button data-act="mute">今天不再提醒</button>
                        <button class="primary" data-act="open">打开管理器</button>
                    </div>
                </div>
            `;
            document.documentElement.appendChild(host);
            this.root = host;

            const close = () => this.hide();
            shadow.addEventListener('click', (event) => {
                const action = event.target?.getAttribute?.('data-act');
                if (!action) return;
                if (action === 'open') {
                    GM_openInTab(Config.MANAGER_URL, { active: true, setParent: true });
                    close();
                } else if (action === 'mute') {
                    ReminderEngine.muteToday();
                    close();
                } else if (action === 'close') {
                    close();
                }
            });
        },

        hide() {
            if (this.root) this.root.remove();
            this.root = null;
        },
    };

    /* =========================================================
     * 09. Menu / Bootstrap
     * ======================================================= */
    function isManagerPage() {
        return location.hostname === Config.MANAGER_HOST && location.hash === Config.MANAGER_HASH;
    }

    function registerMenu() {
        GM_registerMenuCommand('打开长期事项管理器', () => {
            GM_openInTab(Config.MANAGER_URL, { active: true, setParent: true });
        });
    }

    function startReminderMode() {
        const db = Storage.loadDatabase();
        const settings = db.settings?.reminder || Models.defaultSettings().reminder;
        if (!settings.enabled) return;

        const run = () => {
            if (document.fullscreenElement) return;
            const currentDb = Storage.loadDatabase();
            const runtime = Storage.loadRuntime();
            const entries = ReminderEngine.getEligible(currentDb, runtime, Utils.todayString());
            if (!entries.length) return;

            // 先写入“今日已弹”和节点送达状态，再显示 UI，降低多标签页同时弹出的概率。
            ReminderEngine.markPopupShown(entries, runtime, currentDb, Utils.todayString());
            ReminderUI.show(entries);
        };

        const rawDelay = Number(settings.popupDelaySeconds);
        const delay = Math.max(0, Number.isFinite(rawDelay) ? rawDelay : 3) * 1000;
        const schedule = () => setTimeout(run, delay);
        if (document.visibilityState === 'visible') {
            schedule();
        } else {
            const onVisible = () => {
                if (document.visibilityState !== 'visible') return;
                document.removeEventListener('visibilitychange', onVisible);
                schedule();
            };
            document.addEventListener('visibilitychange', onVisible);
        }
    }

    function bootstrap() {
        registerMenu();
        if (isManagerPage()) {
            Storage.loadDatabase();
            ManagerUI.mount();
            return;
        }
        startReminderMode();
    }

    bootstrap();
})();
