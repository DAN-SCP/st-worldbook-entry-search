import { getContext } from '../../../extensions.js';
import {
    METADATA_KEY,
    loadWorldInfo,
    openWorldInfoEditor,
    saveWorldInfo,
    selected_world_info,
    sortWorldInfoEntries,
    world_info,
} from '../../../world-info.js';
import { accountStorage } from '../../../util/AccountStorage.js';

const EXTENSION_ID = 'st-worldbook-entry-search';
const STORAGE_KEY = 'st-worldbook-entry-search-history';
const ENTRY_HISTORY_KEY = 'st-worldbook-entry-search-entry-history';
const WI_PER_PAGE_KEY = 'WI_PerPage';
const WI_PER_PAGE_DEFAULT = 25;
const MAX_HISTORY = 20;
const MAX_ENTRY_HISTORY = 20;
const SEARCH_DELAY = 200;
const MAX_RESULTS = 100;

let state = {
    isOpen: false,
    query: '',
    results: [],
    isLoading: false,
    status: '',
    lastSearchId: 0,
};

const elements = {};
let lastLauncherOpenAt = 0;

function debounce(fn, wait) {
    let timeout = null;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), wait);
    };
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function isMobileViewport() {
    return globalThis.matchMedia?.('(max-width: 700px)')?.matches || globalThis.innerWidth <= 700;
}

function bindPanelElements() {
    elements.backdrop = document.getElementById('wbes-backdrop');
    elements.input = document.getElementById('wbes-input');
    elements.history = document.getElementById('wbes-history-list');
    elements.entryHistory = document.getElementById('wbes-entry-history-list');
    elements.results = document.getElementById('wbes-results-list');
    elements.clearHistory = document.getElementById('wbes-clear-history');
    elements.clearEntryHistory = document.getElementById('wbes-clear-entry-history');
}

function hasCompletePanelElements() {
    bindPanelElements();
    return Boolean(
        elements.backdrop
        && elements.input
        && elements.history
        && elements.entryHistory
        && elements.results
        && elements.clearHistory
        && elements.clearEntryHistory
    );
}

function getMissingPanelElements() {
    bindPanelElements();
    return Object.entries({
        backdrop: elements.backdrop,
        input: elements.input,
        history: elements.history,
        entryHistory: elements.entryHistory,
        results: elements.results,
        clearHistory: elements.clearHistory,
        clearEntryHistory: elements.clearEntryHistory,
    }).filter(([, value]) => !value).map(([key]) => key);
}

function removeExistingUi() {
    document.getElementById('wbes-launcher')?.remove();
    document.getElementById('wbes-backdrop')?.remove();
    Object.keys(elements).forEach(key => {
        elements[key] = null;
    });
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function normalizeText(value) {
    return String(value ?? '').trim();
}

function normalizeArray(value) {
    if (Array.isArray(value)) {
        return value.map(normalizeText).filter(Boolean);
    }

    if (typeof value === 'string') {
        return value.split(',').map(normalizeText).filter(Boolean);
    }

    return [];
}

function getHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed.filter(Boolean).slice(0, MAX_HISTORY) : [];
    } catch {
        return [];
    }
}

function saveHistory(history) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
}

function dedupeHistory(history) {
    const seen = new Set();
    const next = [];

    for (const item of history) {
        const cleaned = normalizeText(item);
        const key = cleaned.toLowerCase();
        if (!cleaned || seen.has(key)) continue;

        seen.add(key);
        next.push(cleaned);
    }

    return next.slice(0, MAX_HISTORY);
}

function cleanupHistory() {
    const current = getHistory();
    const next = dedupeHistory(current);
    if (JSON.stringify(current) !== JSON.stringify(next)) {
        saveHistory(next);
    }
}

function addHistory(query) {
    const cleaned = normalizeText(query);
    if (!cleaned) return;

    const next = dedupeHistory([cleaned, ...getHistory().filter(item => item.toLowerCase() !== cleaned.toLowerCase())]);
    saveHistory(next);
    renderHistory();
}

function clearHistory() {
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
}

function getEntryHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(ENTRY_HISTORY_KEY) || '[]');
        return Array.isArray(parsed)
            ? parsed.filter(item => item?.worldName && item?.uid).slice(0, MAX_ENTRY_HISTORY)
            : [];
    } catch {
        return [];
    }
}

function saveEntryHistory(history) {
    localStorage.setItem(ENTRY_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_ENTRY_HISTORY)));
}

function addEntryHistory(result) {
    if (!result?.worldName || result?.uid === undefined) return;

    const item = {
        worldName: result.worldName,
        uid: String(result.uid),
        title: normalizeText(result.title) || `UID ${result.uid}`,
        keys: normalizeArray(result.keys),
    };
    const key = `${item.worldName}:${item.uid}`;
    const next = [item, ...getEntryHistory().filter(historyItem => `${historyItem.worldName}:${historyItem.uid}` !== key)];
    saveEntryHistory(next);
    renderEntryHistory();
}

function clearEntryHistory() {
    localStorage.removeItem(ENTRY_HISTORY_KEY);
    renderEntryHistory();
}

function toastInfo(message) {
    globalThis.toastr?.info?.(message, 'Worldbook Entry Search');
}

function toastSuccess(message) {
    globalThis.toastr?.success?.(message, 'Worldbook Entry Search');
}

function toastError(message) {
    globalThis.toastr?.error?.(message, 'Worldbook Entry Search');
}

function findEntryInData(data, uid) {
    const uidString = String(uid);
    const direct = data?.entries?.[uidString];
    if (direct) {
        return direct;
    }

    return Object.values(data?.entries ?? {}).find(entry => String(entry?.uid) === uidString) ?? null;
}

async function toggleWorldEntry(worldName, uid) {
    const data = await loadWorldInfo(worldName);
    const entry = findEntryInData(data, uid);
    if (!entry) {
        throw new Error(`没有找到 UID ${uid}`);
    }

    entry.disable = !entry.disable;
    await saveWorldInfo(worldName, data, true);
    return entry;
}

function getActiveWorldNames() {
    const context = getContext();
    const names = new Set();
    const knownNames = new Set(context.getWorldInfoNames?.() ?? []);

    const addName = (name) => {
        const cleaned = normalizeText(name);
        if (cleaned && (!knownNames.size || knownNames.has(cleaned))) {
            names.add(cleaned);
        }
    };

    for (const name of selected_world_info ?? []) {
        addName(name);
    }

    addName(context.chatMetadata?.[METADATA_KEY]);

    const character = context.characters?.[context.characterId];
    addName(character?.data?.extensions?.world);
    addName(character?.extensions?.world);

    const avatarBase = character?.avatar ? character.avatar.replace(/\.[^/.]+$/, '') : '';
    const charLore = Array.isArray(world_info?.charLore) ? world_info.charLore : [];
    const charLoreEntry = charLore.find(item => item?.name === avatarBase || item?.name === character?.avatar || item?.name === character?.name);
    for (const name of charLoreEntry?.extraBooks ?? []) {
        addName(name);
    }

    $('#world_info').find(':selected').each((_, option) => {
        addName(option.textContent);
        addName(option.value);
    });

    return [...names];
}

async function collectEntries() {
    const worldNames = getActiveWorldNames();
    const rows = [];

    for (const worldName of worldNames) {
        try {
            const data = await loadWorldInfo(worldName);
            const entries = data?.entries ?? {};
            for (const [fallbackUid, entry] of Object.entries(entries)) {
                const uid = entry?.uid ?? fallbackUid;
                const keys = normalizeArray(entry?.key);
                const title = normalizeText(entry?.comment) || keys[0] || `UID ${uid}`;

                rows.push({
                    uid: String(uid),
                    worldName,
                    title,
                    keys,
                    entry,
                });
            }
        } catch (error) {
            console.warn(`[${EXTENSION_ID}] Failed to load worldbook "${worldName}".`, error);
        }
    }

    return rows;
}

function rankEntry(row, query) {
    const needle = query.toLowerCase();
    const title = row.title.toLowerCase();
    const keys = row.keys.map(key => key.toLowerCase());
    const titleHit = title.includes(needle);
    const keyHit = keys.some(key => key.includes(needle));

    if (!titleHit && !keyHit) {
        return null;
    }

    let score = 0;
    if (title === needle) score += 100;
    if (title.startsWith(needle)) score += 60;
    if (titleHit) score += 40;
    if (keys.some(key => key === needle)) score += 30;
    if (keys.some(key => key.startsWith(needle))) score += 20;
    if (keyHit) score += 10;

    return { ...row, score, matchType: titleHit ? 'title' : 'keyword' };
}

async function runSearch(query) {
    const cleaned = normalizeText(query);
    const searchId = ++state.lastSearchId;

    state.query = cleaned;
    state.results = [];
    state.status = '';

    if (!cleaned) {
        state.isLoading = false;
        renderResults();
        return;
    }

    const activeWorlds = getActiveWorldNames();
    if (!activeWorlds.length) {
        state.isLoading = false;
        state.status = '当前没有检测到启用的世界书。';
        renderResults();
        return;
    }

    state.isLoading = true;
    renderResults();

    const entries = await collectEntries();
    if (searchId !== state.lastSearchId) return;

    state.results = entries
        .map(row => rankEntry(row, cleaned))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.worldName.localeCompare(b.worldName) || a.title.localeCompare(b.title))
        .slice(0, MAX_RESULTS);

    state.isLoading = false;
    state.status = state.results.length ? '' : '没有找到匹配的小条目。';
    renderResults();
}

const debouncedSearch = debounce(runSearch, SEARCH_DELAY);

function showPanel() {
    state.isOpen = true;
    if (!hasCompletePanelElements()) {
        buildUi();
    }
    if (!hasCompletePanelElements()) {
        console.error(`[${EXTENSION_ID}] Search panel could not be created. Missing:`, getMissingPanelElements());
        toastError('搜索面板创建失败，请刷新页面后重试。');
        return;
    }

    elements.backdrop.hidden = false;
    elements.backdrop.removeAttribute('hidden');
    elements.backdrop.classList.add('wbes-open');

    if (isMobileViewport()) {
        if (document.activeElement instanceof HTMLElement) {
            document.activeElement.blur();
        }
    } else {
        try {
            elements.input.focus({ preventScroll: true });
        } catch {
            elements.input.focus();
        }
    }

    renderHistory();
    renderEntryHistory();
    renderResults();
}

function hidePanel() {
    state.isOpen = false;
    if (!elements.backdrop) {
        bindPanelElements();
    }
    if (elements.backdrop) {
        elements.backdrop.classList.remove('wbes-open');
        elements.backdrop.hidden = true;
    }
}

function openPanelFromLauncher(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();

    const now = Date.now();
    if (now - lastLauncherOpenAt < 350) {
        return;
    }

    lastLauncherOpenAt = now;
    showPanel();
}

function renderHistory() {
    const history = getHistory();
    elements.history.innerHTML = history.length
        ? history.map(item => `<button type="button" class="wbes-history-item" data-query="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')
        : '<div class="wbes-muted">暂无搜索历史</div>';
    elements.clearHistory.disabled = history.length === 0;
}

async function renderEntryHistory() {
    if (!elements.entryHistory) return;

    const history = getEntryHistory();
    elements.entryHistory.innerHTML = history.length
        ? history.map((item, index) => `
            <div class="wbes-entry-history-item" data-index="${index}">
                <button type="button" class="wbes-entry-history-main" data-action="open" title="打开并定位">
                    <span class="wbes-entry-history-title">${escapeHtml(item.title || `UID ${item.uid}`)}</span>
                    <span class="wbes-entry-history-meta">${escapeHtml(item.worldName)} · UID ${escapeHtml(item.uid)}</span>
                </button>
                <button type="button" class="wbes-entry-toggle menu_button" data-action="toggle" title="启用或禁用该条目">...</button>
            </div>
        `).join('')
        : '<div class="wbes-muted">暂无条目历史</div>';
    elements.clearEntryHistory.disabled = history.length === 0;

    await refreshEntryHistoryStatuses();
}

async function refreshEntryHistoryStatuses() {
    const history = getEntryHistory();
    await Promise.all(history.map(async (item, index) => {
        const button = elements.entryHistory?.querySelector(`.wbes-entry-history-item[data-index="${index}"] .wbes-entry-toggle`);
        if (!(button instanceof HTMLButtonElement)) return;

        try {
            const data = await loadWorldInfo(item.worldName);
            const entry = findEntryInData(data, item.uid);
            if (!entry) {
                button.textContent = '缺失';
                button.disabled = true;
                return;
            }

            const enabled = !entry.disable;
            button.textContent = enabled ? '启用' : '禁用';
            button.classList.toggle('wbes-entry-enabled', enabled);
            button.classList.toggle('wbes-entry-disabled', !enabled);
        } catch (error) {
            console.warn(`[${EXTENSION_ID}] Failed to refresh entry status.`, item, error);
            button.textContent = '错误';
            button.disabled = true;
        }
    }));
}

function renderResults() {
    const activeCount = document.getElementById('wbes-active-count');
    if (activeCount) {
        activeCount.textContent = `${getActiveWorldNames().length} 本启用`;
    }

    if (state.isLoading) {
        elements.results.innerHTML = '<div class="wbes-muted">搜索中...</div>';
        return;
    }

    if (state.status) {
        elements.results.innerHTML = `<div class="wbes-muted">${escapeHtml(state.status)}</div>`;
        return;
    }

    if (!state.query) {
        elements.results.innerHTML = '<div class="wbes-muted">输入条目标题或关键词开始搜索。</div>';
        return;
    }

    elements.results.innerHTML = state.results.map((row, index) => {
        const keys = row.keys.length ? row.keys.slice(0, 8).join(', ') : '无关键词';
        const matchLabel = row.matchType === 'title' ? '标题命中' : '关键词命中';
        const enabled = !row.entry?.disable;
        const toggleClass = enabled ? 'wbes-entry-enabled' : 'wbes-entry-disabled';
        const toggleLabel = enabled ? '启用' : '禁用';
        return `
            <div class="wbes-result" data-index="${index}">
                <button type="button" class="wbes-result-main" data-action="open">
                    <span class="wbes-result-title">${escapeHtml(row.title)}</span>
                    <span class="wbes-result-meta">${escapeHtml(row.worldName)} · UID ${escapeHtml(row.uid)} · ${matchLabel}</span>
                    <span class="wbes-result-keys">${escapeHtml(keys)}</span>
                </button>
                <button type="button" class="wbes-result-toggle menu_button ${toggleClass}" data-action="toggle" title="启用或禁用该条目">${toggleLabel}</button>
            </div>
        `;
    }).join('');
}

async function waitForElement(selector, timeout = 3000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const element = document.querySelector(selector);
        if (element) return element;
        await delay(80);
    }
    return null;
}

function getPerPage() {
    const fromAccountStorage = Number(accountStorage.getItem(WI_PER_PAGE_KEY));
    if (Number.isFinite(fromAccountStorage) && fromAccountStorage > 0) {
        return fromAccountStorage;
    }

    const sizeChanger = document.querySelector('#world_info_pagination select');
    if (sizeChanger instanceof HTMLSelectElement) {
        const fromSelect = Number(sizeChanger.value);
        if (Number.isFinite(fromSelect) && fromSelect > 0) {
            return fromSelect;
        }
    }

    return WI_PER_PAGE_DEFAULT;
}

async function calculateEntryPage(worldName, uid) {
    const data = await loadWorldInfo(worldName);
    const entries = Object.keys(data?.entries ?? {})
        .map(entryUid => {
            const entry = data.entries[entryUid];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }

            entry.uid = Number(entry.uid ?? entryUid);
            entry.displayIndex = entry.displayIndex ?? entry.uid;
            entry.order = Number(entry.order ?? 100);
            entry.key = normalizeArray(entry.key);
            entry.keysecondary = normalizeArray(entry.keysecondary);
            return entry;
        })
        .filter(Boolean);

    const sortedEntries = sortWorldInfoEntries(entries);
    const uidNumber = Number(uid);
    const uidIndex = sortedEntries.findIndex(entry => Number(entry.uid) === uidNumber);

    if (uidIndex < 0) {
        return null;
    }

    return Math.floor(uidIndex / getPerPage()) + 1;
}

async function waitForEntryElement(uid, timeout = 4000) {
    const escapedUid = CSS.escape(String(uid));
    const selectors = [
        `.world_entry[data-uid="${escapedUid}"]`,
        `.world_entry_form[data-uid="${escapedUid}"]`,
        `.inline-drawer[data-uid="${escapedUid}"]`,
        `.world_entry input[data-uid="${escapedUid}"]`,
        `.world_entry textarea[data-uid="${escapedUid}"]`,
        `.world_entry_form [data-uid="${escapedUid}"]`,
        `[data-uid="${escapedUid}"]`,
    ];

    const started = Date.now();
    while (Date.now() - started < timeout) {
        for (const selector of selectors) {
            const target = document.querySelector(selector);
            if (target) {
                return target;
            }
        }
        await delay(80);
    }

    return null;
}

async function jumpToEntryPage(result) {
    try {
        const page = await calculateEntryPage(result.worldName, result.uid);
        const pagination = $('#world_info_pagination');

        if (page && pagination.length && typeof pagination.pagination === 'function') {
            pagination.pagination('go', page);
            await delay(120);
            return page;
        }
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] Failed to calculate or jump to entry page.`, error);
    }

    return null;
}

function expandAndHighlightEntry(target, result, page) {
    const container = target?.closest?.('.world_entry, .inline-drawer, .world_entry_form') ?? target;
    if (!(container instanceof HTMLElement)) {
        return false;
    }

    const toggle = container.querySelector('.inline-drawer-toggle, .inline-drawer-icon');
    const content = container.querySelector('.inline-drawer-content, .world_entry_edit');
    if (toggle && content && window.getComputedStyle(content).display === 'none') {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    container.classList.add('wbes-entry-highlight');
    setTimeout(() => container.classList.remove('wbes-entry-highlight'), 2600);

    const pageText = page ? `第 ${page} 页` : '当前页';
    toastSuccess(`已定位到 ${pageText}：${result.title}`);
    return true;
}

async function openResult(index) {
    const result = state.results[index];
    if (!result) return;

    addHistory(state.query || result.title);
    addEntryHistory(result);
    await locateResult(result);
}

async function openEntryHistoryItem(index) {
    const item = getEntryHistory()[index];
    if (!item) return;

    const data = await loadWorldInfo(item.worldName);
    const entry = findEntryInData(data, item.uid);
    const keys = normalizeArray(entry?.key ?? item.keys);
    const result = {
        worldName: item.worldName,
        uid: String(entry?.uid ?? item.uid),
        title: normalizeText(entry?.comment) || item.title || keys[0] || `UID ${item.uid}`,
        keys,
        entry,
    };

    addEntryHistory(result);
    await locateResult(result);
}

async function toggleEntryHistoryItem(index) {
    const item = getEntryHistory()[index];
    if (!item) return;

    try {
        const entry = await toggleWorldEntry(item.worldName, item.uid);
        toastSuccess(`${entry.disable ? '已禁用' : '已启用'}：${normalizeText(entry.comment) || item.title || item.uid}`);
        await renderEntryHistory();

        const currentWorldName = $('#world_editor_select option:selected').text();
        if (currentWorldName === item.worldName) {
            getContext().reloadWorldInfoEditor?.(item.worldName);
        }
    } catch (error) {
        console.error(`[${EXTENSION_ID}] Failed to toggle entry.`, item, error);
        toastError(`切换条目状态失败：${error?.message ?? error}`);
    }
}

async function toggleSearchResult(index) {
    const result = state.results[index];
    if (!result) return;

    try {
        const entry = await toggleWorldEntry(result.worldName, result.uid);
        result.entry = entry;
        result.title = normalizeText(entry.comment) || result.title;
        result.keys = normalizeArray(entry.key);

        toastSuccess(`${entry.disable ? '已禁用' : '已启用'}：${result.title}`);
        addEntryHistory(result);
        renderResults();
        await renderEntryHistory();

        const currentWorldName = $('#world_editor_select option:selected').text();
        if (currentWorldName === result.worldName) {
            getContext().reloadWorldInfoEditor?.(result.worldName);
        }
    } catch (error) {
        console.error(`[${EXTENSION_ID}] Failed to toggle search result.`, result, error);
        toastError(`切换条目状态失败：${error?.message ?? error}`);
    }
}

async function locateResult(result) {
    hidePanel();
    openWorldInfoEditor(result.worldName);

    await waitForElement('#world_popup_entries_list, #world_info_entries, #WorldInfo');
    const page = await jumpToEntryPage(result);
    const target = await waitForEntryElement(result.uid);

    if (expandAndHighlightEntry(target, result, page)) {
        return;
    }

    console.info(`[${EXTENSION_ID}] Entry opened at worldbook level; could not locate UID in editor DOM.`, result);
    const pageText = page ? `第 ${page} 页` : '对应页面';
    toastInfo(`已打开世界书 "${result.worldName}" 的${pageText}。请查找条目：${result.title} / UID ${result.uid}`);
}

function buildUi() {
    const existingLauncher = document.getElementById('wbes-launcher');
    const existingBackdrop = document.getElementById('wbes-backdrop');
    if (existingLauncher && existingBackdrop && hasCompletePanelElements()) {
        const launcher = existingLauncher;
        launcher.addEventListener('click', openPanelFromLauncher, true);
        launcher.addEventListener('pointerup', openPanelFromLauncher, true);
        launcher.addEventListener('touchend', openPanelFromLauncher, true);
        cleanupHistory();
        renderHistory();
        renderEntryHistory();
        renderResults();
        return;
    }

    if (existingLauncher || existingBackdrop) {
        removeExistingUi();
    }

    const launcher = document.createElement('button');
    launcher.id = 'wbes-launcher';
    launcher.type = 'button';
    launcher.className = 'menu_button menu_button_icon';
    launcher.title = '搜索当前启用世界书的小条目';
    launcher.innerHTML = '<i class="fa-solid fa-book-open"></i><span>世界书搜索</span>';
    launcher.addEventListener('click', openPanelFromLauncher, true);
    launcher.addEventListener('pointerup', openPanelFromLauncher, true);
    launcher.addEventListener('touchend', openPanelFromLauncher, true);

    const menu = document.getElementById('extensionsMenu');
    if (menu) {
        menu.appendChild(launcher);
    } else {
        document.body.appendChild(launcher);
    }

    const backdrop = document.createElement('div');
    backdrop.id = 'wbes-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = `
        <section id="wbes-panel" role="dialog" aria-modal="true" aria-label="世界书条目搜索">
            <header class="wbes-header">
                <h3>世界书条目搜索</h3>
                <button type="button" class="menu_button menu_button_icon" id="wbes-close" title="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </header>
            <div class="wbes-search-row">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input id="wbes-input" class="text_pole" type="search" autocomplete="off" placeholder="搜索条目标题或关键词">
            </div>
            <div class="wbes-body">
                <aside class="wbes-history">
                    <div class="wbes-section-title">
                        <span>搜索历史</span>
                        <button type="button" id="wbes-clear-history" class="menu_button" title="清空搜索历史">清空</button>
                    </div>
                    <div id="wbes-history-list"></div>
                    <div class="wbes-section-title wbes-entry-history-titlebar">
                        <span>最近条目</span>
                        <button type="button" id="wbes-clear-entry-history" class="menu_button" title="清空条目历史">清空</button>
                    </div>
                    <div id="wbes-entry-history-list"></div>
                </aside>
                <main class="wbes-results">
                    <div class="wbes-section-title">
                        <span>结果</span>
                        <span id="wbes-active-count"></span>
                    </div>
                    <div id="wbes-results-list"></div>
                </main>
            </div>
        </section>
    `;
    document.body.appendChild(backdrop);

    bindPanelElements();

    document.getElementById('wbes-close').addEventListener('click', hidePanel);
    elements.clearHistory.addEventListener('click', clearHistory);
    elements.clearEntryHistory.addEventListener('click', clearEntryHistory);
    backdrop.addEventListener('click', event => {
        if (event.target === backdrop) hidePanel();
    });

    elements.input.addEventListener('input', event => {
        if (event.target instanceof HTMLInputElement) {
            debouncedSearch(event.target.value);
        }
    });

    elements.input.addEventListener('keydown', event => {
        if (event.key === 'Escape') hidePanel();
        if (event.key === 'Enter' && state.results.length) openResult(0);
    });

    elements.history.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.wbes-history-item');
        if (!button) return;
        elements.input.value = button.dataset.query || '';
        addHistory(elements.input.value);
        runSearch(elements.input.value);
    });

    elements.entryHistory.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const item = event.target.closest('.wbes-entry-history-item');
        if (!(item instanceof HTMLElement)) return;

        const index = Number(item.dataset.index);
        const actionButton = event.target.closest('[data-action]');
        const action = actionButton?.dataset?.action;

        if (action === 'toggle') {
            toggleEntryHistoryItem(index);
        } else {
            openEntryHistoryItem(index);
        }
    });

    elements.results.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const item = event.target.closest('.wbes-result');
        if (!(item instanceof HTMLElement)) return;

        const index = Number(item.dataset.index);
        const actionButton = event.target.closest('[data-action]');
        const action = actionButton?.dataset?.action;

        if (action === 'toggle') {
            toggleSearchResult(index);
        } else {
            openResult(index);
        }
    });

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && state.isOpen) hidePanel();
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'w') {
            event.preventDefault();
            showPanel();
        }
    });

    cleanupHistory();
    renderHistory();
    renderEntryHistory();
    renderResults();
}

jQuery(async () => {
    buildUi();
});
