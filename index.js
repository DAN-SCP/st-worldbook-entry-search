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
const SEARCH_HISTORY_KEY = 'st-worldbook-entry-search-history';
const ENTRY_HISTORY_KEY = 'st-worldbook-entry-search-entry-history';
const WI_PER_PAGE_KEY = 'WI_PerPage';
const MAX_HISTORY = 20;
const MAX_ENTRY_HISTORY = 20;
const MAX_RESULTS = 120;
const SEARCH_DELAY = 200;
const DEFAULT_PER_PAGE = 25;

const state = {
    query: '',
    results: [],
    loading: false,
    status: '',
    searchId: 0,
};

const ui = {
    shell: null,
    input: null,
    results: null,
    history: null,
    entryHistory: null,
    activeCount: null,
    clearHistory: null,
    clearEntryHistory: null,
};

let lastOpenAt = 0;
let keyboardBound = false;
let mutationObserver = null;

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function debounce(fn, wait) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
    };
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

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function isMobile() {
    return Boolean(window.matchMedia?.('(max-width: 700px)')?.matches || window.innerWidth <= 700);
}

function toastInfo(message) {
    globalThis.toastr?.info?.(message, '世界书搜索');
}

function toastSuccess(message) {
    globalThis.toastr?.success?.(message, '世界书搜索');
}

function toastError(message) {
    globalThis.toastr?.error?.(message, '世界书搜索');
}

function getJsonArray(key) {
    try {
        const parsed = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function saveJsonArray(key, value, limit) {
    localStorage.setItem(key, JSON.stringify(value.slice(0, limit)));
}

function getSearchHistory() {
    const seen = new Set();
    const next = [];
    for (const item of getJsonArray(SEARCH_HISTORY_KEY)) {
        const text = normalizeText(item);
        const key = text.toLowerCase();
        if (!text || seen.has(key)) continue;
        seen.add(key);
        next.push(text);
    }
    return next.slice(0, MAX_HISTORY);
}

function addSearchHistory(query) {
    const text = normalizeText(query);
    if (!text) return;
    const next = [text, ...getSearchHistory().filter(item => item.toLowerCase() !== text.toLowerCase())];
    saveJsonArray(SEARCH_HISTORY_KEY, next, MAX_HISTORY);
    renderSearchHistory();
}

function clearSearchHistory() {
    localStorage.removeItem(SEARCH_HISTORY_KEY);
    renderSearchHistory();
}

function getEntryHistory() {
    return getJsonArray(ENTRY_HISTORY_KEY)
        .filter(item => item?.worldName && item?.uid !== undefined)
        .slice(0, MAX_ENTRY_HISTORY);
}

function addEntryHistory(result) {
    if (!result?.worldName || result?.uid === undefined) return;

    const item = {
        worldName: result.worldName,
        uid: String(result.uid),
        title: normalizeText(result.title) || `UID ${result.uid}`,
        keys: normalizeArray(result.keys),
    };
    const id = `${item.worldName}:${item.uid}`;
    const next = [item, ...getEntryHistory().filter(row => `${row.worldName}:${row.uid}` !== id)];
    saveJsonArray(ENTRY_HISTORY_KEY, next, MAX_ENTRY_HISTORY);
    renderEntryHistory();
}

function clearEntryHistory() {
    localStorage.removeItem(ENTRY_HISTORY_KEY);
    renderEntryHistory();
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

    for (const name of selected_world_info ?? []) addName(name);

    addName(context.chatMetadata?.[METADATA_KEY]);

    const character = context.characters?.[context.characterId];
    addName(character?.data?.extensions?.world);
    addName(character?.extensions?.world);

    const avatarBase = character?.avatar ? character.avatar.replace(/\.[^/.]+$/, '') : '';
    const charLore = Array.isArray(world_info?.charLore) ? world_info.charLore : [];
    const charLoreEntry = charLore.find(item => item?.name === avatarBase || item?.name === character?.avatar || item?.name === character?.name);
    for (const name of charLoreEntry?.extraBooks ?? []) addName(name);

    $('#world_info').find(':selected').each((_, option) => {
        addName(option.textContent);
        addName(option.value);
    });

    return [...names];
}

async function collectEntries() {
    const rows = [];
    for (const worldName of getActiveWorldNames()) {
        try {
            const data = await loadWorldInfo(worldName);
            for (const [fallbackUid, entry] of Object.entries(data?.entries ?? {})) {
                const uid = entry?.uid ?? fallbackUid;
                const keys = normalizeArray(entry?.key);
                rows.push({
                    worldName,
                    uid: String(uid),
                    title: normalizeText(entry?.comment) || keys[0] || `UID ${uid}`,
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
    if (!titleHit && !keyHit) return null;

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
    const searchId = ++state.searchId;

    state.query = cleaned;
    state.results = [];
    state.status = '';

    if (!cleaned) {
        state.loading = false;
        renderResults();
        return;
    }

    const activeWorlds = getActiveWorldNames();
    if (!activeWorlds.length) {
        state.loading = false;
        state.status = '当前没有检测到启用的世界书。';
        renderResults();
        return;
    }

    state.loading = true;
    renderResults();

    const entries = await collectEntries();
    if (searchId !== state.searchId) return;

    state.results = entries
        .map(row => rankEntry(row, cleaned))
        .filter(Boolean)
        .sort((a, b) => b.score - a.score || a.worldName.localeCompare(b.worldName) || a.title.localeCompare(b.title))
        .slice(0, MAX_RESULTS);

    state.loading = false;
    state.status = state.results.length ? '' : '没有找到匹配的小条目。';
    renderResults();
}

const debouncedSearch = debounce(runSearch, SEARCH_DELAY);

function findEntryInData(data, uid) {
    const uidString = String(uid);
    return data?.entries?.[uidString]
        ?? Object.values(data?.entries ?? {}).find(entry => String(entry?.uid) === uidString)
        ?? null;
}

async function toggleWorldEntry(worldName, uid) {
    const data = await loadWorldInfo(worldName);
    const entry = findEntryInData(data, uid);
    if (!entry) throw new Error(`没有找到 UID ${uid}`);
    entry.disable = !entry.disable;
    await saveWorldInfo(worldName, data, true);
    return entry;
}

function getPerPage() {
    const stored = Number(accountStorage.getItem(WI_PER_PAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;

    const select = document.querySelector('#world_info_pagination select');
    if (select instanceof HTMLSelectElement) {
        const value = Number(select.value);
        if (Number.isFinite(value) && value > 0) return value;
    }

    return DEFAULT_PER_PAGE;
}

async function calculateEntryPage(worldName, uid) {
    const data = await loadWorldInfo(worldName);
    const entries = Object.entries(data?.entries ?? {}).map(([fallbackUid, source]) => {
        if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
        return {
            ...source,
            uid: Number(source.uid ?? fallbackUid),
            displayIndex: source.displayIndex ?? Number(source.uid ?? fallbackUid),
            order: Number(source.order ?? 100),
            key: normalizeArray(source.key),
            keysecondary: normalizeArray(source.keysecondary),
        };
    }).filter(Boolean);

    const sorted = sortWorldInfoEntries(entries);
    const index = sorted.findIndex(entry => Number(entry.uid) === Number(uid));
    return index < 0 ? null : Math.floor(index / getPerPage()) + 1;
}

async function waitForElement(selector, timeout = 4000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const element = document.querySelector(selector);
        if (element) return element;
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
            await delay(150);
            return page;
        }
    } catch (error) {
        console.warn(`[${EXTENSION_ID}] Failed to jump to entry page.`, error);
    }
    return null;
}

async function waitForEntryElement(uid, timeout = 4500) {
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
            if (target) return target;
        }
        await delay(80);
    }
    return null;
}

function highlightEntry(target, result, page) {
    const container = target?.closest?.('.world_entry, .inline-drawer, .world_entry_form') ?? target;
    if (!(container instanceof HTMLElement)) return false;

    const toggle = container.querySelector('.inline-drawer-toggle, .inline-drawer-icon');
    const content = container.querySelector('.inline-drawer-content, .world_entry_edit');
    if (toggle && content && getComputedStyle(content).display === 'none') {
        toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
    container.classList.add('wbes-entry-highlight');
    setTimeout(() => container.classList.remove('wbes-entry-highlight'), 2600);
    toastSuccess(`已定位到${page ? `第 ${page} 页` : '当前页'}：${result.title}`);
    return true;
}

async function locateResult(result) {
    closePanel();
    openWorldInfoEditor(result.worldName);

    await waitForElement('#world_popup_entries_list, #world_info_entries, #WorldInfo');
    const page = await jumpToEntryPage(result);
    const target = await waitForEntryElement(result.uid);

    if (!highlightEntry(target, result, page)) {
        const pageText = page ? `第 ${page} 页` : '对应页面';
        toastInfo(`已打开世界书 "${result.worldName}" 的${pageText}，请查找：${result.title} / UID ${result.uid}`);
    }
}

async function openResult(index) {
    const result = state.results[index];
    if (!result) return;
    addSearchHistory(state.query || result.title);
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
        reloadCurrentWorldEditor(result.worldName);
    } catch (error) {
        toastError(`切换条目状态失败：${error?.message ?? error}`);
    }
}

async function toggleEntryHistoryItem(index) {
    const item = getEntryHistory()[index];
    if (!item) return;

    try {
        const entry = await toggleWorldEntry(item.worldName, item.uid);
        toastSuccess(`${entry.disable ? '已禁用' : '已启用'}：${normalizeText(entry.comment) || item.title || item.uid}`);
        await renderEntryHistory();
        reloadCurrentWorldEditor(item.worldName);
    } catch (error) {
        toastError(`切换条目状态失败：${error?.message ?? error}`);
    }
}

function reloadCurrentWorldEditor(worldName) {
    const currentWorldName = $('#world_editor_select option:selected').text();
    if (currentWorldName === worldName) {
        getContext().reloadWorldInfoEditor?.(worldName);
    }
}

function renderSearchHistory() {
    if (!ui.history || !ui.clearHistory) return;
    const history = getSearchHistory();
    ui.history.innerHTML = history.length
        ? history.map(item => `<button type="button" class="wbes-chip" data-query="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('')
        : '<div class="wbes-empty">暂无搜索历史</div>';
    ui.clearHistory.disabled = history.length === 0;
}

async function renderEntryHistory() {
    if (!ui.entryHistory || !ui.clearEntryHistory) return;
    const history = getEntryHistory();
    ui.entryHistory.innerHTML = history.length
        ? history.map((item, index) => `
            <div class="wbes-entry-history-row" data-index="${index}">
                <button type="button" class="wbes-entry-main" data-action="open">
                    <span>${escapeHtml(item.title || `UID ${item.uid}`)}</span>
                    <small>${escapeHtml(item.worldName)} · UID ${escapeHtml(item.uid)}</small>
                </button>
                <button type="button" class="wbes-toggle menu_button" data-action="toggle">...</button>
            </div>
        `).join('')
        : '<div class="wbes-empty">暂无最近条目</div>';
    ui.clearEntryHistory.disabled = history.length === 0;
    await refreshEntryHistoryStatus();
}

async function refreshEntryHistoryStatus() {
    const history = getEntryHistory();
    await Promise.all(history.map(async (item, index) => {
        const button = ui.entryHistory?.querySelector(`.wbes-entry-history-row[data-index="${index}"] .wbes-toggle`);
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
            button.classList.toggle('wbes-enabled', enabled);
            button.classList.toggle('wbes-disabled', !enabled);
        } catch {
            button.textContent = '错误';
            button.disabled = true;
        }
    }));
}

function renderResults() {
    if (!ui.results) return;
    if (ui.activeCount) ui.activeCount.textContent = `${getActiveWorldNames().length} 本启用`;

    if (state.loading) {
        ui.results.innerHTML = '<div class="wbes-empty">搜索中...</div>';
        return;
    }

    if (state.status) {
        ui.results.innerHTML = `<div class="wbes-empty">${escapeHtml(state.status)}</div>`;
        return;
    }

    if (!state.query) {
        ui.results.innerHTML = '<div class="wbes-empty">输入标题或关键词开始搜索。</div>';
        return;
    }

    ui.results.innerHTML = state.results.map((row, index) => {
        const keys = row.keys.length ? row.keys.slice(0, 8).join(', ') : '无关键词';
        const matchLabel = row.matchType === 'title' ? '标题命中' : '关键词命中';
        const enabled = !row.entry?.disable;
        return `
            <div class="wbes-result" data-index="${index}">
                <button type="button" class="wbes-result-main" data-action="open">
                    <span class="wbes-result-title">${escapeHtml(row.title)}</span>
                    <span class="wbes-result-meta">${escapeHtml(row.worldName)} · UID ${escapeHtml(row.uid)} · ${matchLabel}</span>
                    <span class="wbes-result-keys">${escapeHtml(keys)}</span>
                </button>
                <button type="button" class="wbes-toggle menu_button ${enabled ? 'wbes-enabled' : 'wbes-disabled'}" data-action="toggle">${enabled ? '启用' : '禁用'}</button>
            </div>
        `;
    }).join('');
}

function closePanel() {
    document.getElementById('wbes-shell')?.remove();
    ui.shell = null;
    ui.input = null;
    ui.results = null;
    ui.history = null;
    ui.entryHistory = null;
    ui.activeCount = null;
    ui.clearHistory = null;
    ui.clearEntryHistory = null;
}

function createPanel() {
    closePanel();

    const shell = document.createElement('div');
    shell.id = 'wbes-shell';
    shell.innerHTML = `
        <section id="wbes-panel" role="dialog" aria-modal="true" aria-label="世界书条目搜索">
            <header class="wbes-header">
                <h3>世界书条目搜索</h3>
                <button type="button" class="menu_button menu_button_icon" id="wbes-close" title="关闭">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </header>
            <label class="wbes-search">
                <i class="fa-solid fa-magnifying-glass"></i>
                <input id="wbes-input" class="text_pole" type="search" autocomplete="off" placeholder="搜索条目标题或关键词">
            </label>
            <div class="wbes-layout">
                <aside class="wbes-side">
                    <div class="wbes-section-title">
                        <span>搜索历史</span>
                        <button type="button" class="menu_button" id="wbes-clear-history">清空</button>
                    </div>
                    <div id="wbes-history"></div>
                    <div class="wbes-section-title">
                        <span>最近条目</span>
                        <button type="button" class="menu_button" id="wbes-clear-entry-history">清空</button>
                    </div>
                    <div id="wbes-entry-history"></div>
                </aside>
                <main class="wbes-main">
                    <div class="wbes-section-title">
                        <span>结果</span>
                        <span id="wbes-active-count"></span>
                    </div>
                    <div id="wbes-results"></div>
                </main>
            </div>
        </section>
    `;

    document.body.appendChild(shell);
    ui.shell = shell;
    ui.input = document.getElementById('wbes-input');
    ui.results = document.getElementById('wbes-results');
    ui.history = document.getElementById('wbes-history');
    ui.entryHistory = document.getElementById('wbes-entry-history');
    ui.activeCount = document.getElementById('wbes-active-count');
    ui.clearHistory = document.getElementById('wbes-clear-history');
    ui.clearEntryHistory = document.getElementById('wbes-clear-entry-history');

    bindPanelEvents(shell);
    renderSearchHistory();
    renderEntryHistory();
    renderResults();
}

function bindPanelEvents(shell) {
    document.getElementById('wbes-close')?.addEventListener('click', closePanel);

    shell.addEventListener('click', event => {
        if (event.target === shell) closePanel();
    });

    ui.input?.addEventListener('input', event => {
        if (event.target instanceof HTMLInputElement) debouncedSearch(event.target.value);
    });

    ui.input?.addEventListener('keydown', event => {
        if (event.key === 'Escape') closePanel();
        if (event.key === 'Enter' && state.results.length) openResult(0);
    });

    ui.clearHistory?.addEventListener('click', clearSearchHistory);
    ui.clearEntryHistory?.addEventListener('click', clearEntryHistory);

    ui.history?.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('.wbes-chip');
        if (!(button instanceof HTMLElement)) return;
        const query = button.dataset.query || '';
        ui.input.value = query;
        addSearchHistory(query);
        runSearch(query);
    });

    ui.entryHistory?.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const row = event.target.closest('.wbes-entry-history-row');
        if (!(row instanceof HTMLElement)) return;
        const index = Number(row.dataset.index);
        const action = event.target.closest('[data-action]')?.dataset?.action;
        if (action === 'toggle') {
            toggleEntryHistoryItem(index);
        } else {
            openEntryHistoryItem(index);
        }
    });

    ui.results?.addEventListener('click', event => {
        if (!(event.target instanceof Element)) return;
        const row = event.target.closest('.wbes-result');
        if (!(row instanceof HTMLElement)) return;
        const index = Number(row.dataset.index);
        const action = event.target.closest('[data-action]')?.dataset?.action;
        if (action === 'toggle') {
            toggleSearchResult(index);
        } else {
            openResult(index);
        }
    });
}

function openPanel(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();

    const now = Date.now();
    if (now - lastOpenAt < 250) return;
    lastOpenAt = now;

    $('#options').hide();
    createPanel();

    if (isMobile()) {
        document.activeElement instanceof HTMLElement && document.activeElement.blur();
    } else {
        ui.input?.focus({ preventScroll: true });
    }
}

function createLauncher(id, className) {
    const launcher = document.createElement('button');
    launcher.id = id;
    launcher.type = 'button';
    launcher.className = className;
    launcher.title = '世界书搜索';
    launcher.innerHTML = '<i class="fa-solid fa-book-open"></i><span>世界书搜索</span>';
    launcher.addEventListener('click', openPanel);
    return launcher;
}

function mountLaunchers() {
    const optionsContent = document.querySelector('#options .options-content');
    if (optionsContent && !document.getElementById('wbes-menu-launcher')) {
        const launcher = createLauncher('wbes-menu-launcher', 'list-group-item flex-container flexGap5 interactable');
        optionsContent.appendChild(launcher);
    }

    if (!document.getElementById('wbes-float-launcher')) {
        const launcher = createLauncher('wbes-float-launcher', 'menu_button');
        document.body.appendChild(launcher);
    }
}

function bindGlobalKeyboard() {
    if (keyboardBound) return;
    keyboardBound = true;

    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && ui.shell) closePanel();
        if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'w') {
            openPanel(event);
        }
    });
}

function observeMenu() {
    if (mutationObserver) return;
    mutationObserver = new MutationObserver(() => mountLaunchers());
    mutationObserver.observe(document.body, { childList: true, subtree: true });
}

function cleanupSearchHistory() {
    saveJsonArray(SEARCH_HISTORY_KEY, getSearchHistory(), MAX_HISTORY);
}

jQuery(async () => {
    cleanupSearchHistory();
    mountLaunchers();
    bindGlobalKeyboard();
    observeMenu();

    if (location.hash === '#wbes-open') {
        setTimeout(() => openPanel(), 300);
    }
});
