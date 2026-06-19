// =========================
// Chat_list - SillyTavern Extension
// Replace the Welcome Page "Recent Chats" with a full chat manager.
// List, rename, delete all chats — without entering them.
// =========================
import { getGroupAvatar, getGroupPastChats, groups, select_group_chats } from '../../../group-chats.js';
import { getPastCharacterChats, selectCharacterById, renameGroupOrCharacterChat, event_types, setActiveGroup } from '../../../../script.js';
import { Popup, POPUP_TYPE, POPUP_RESULT } from '../../../popup.js';
import { timestampToMoment } from '../../../utils.js';
import { extension_settings } from '../../../extensions.js';
import { t } from '../../../i18n.js';

const {
    getCurrentChatId,
    getRequestHeaders,
    openGroupChat,
    openCharacterChat,
    getThumbnailUrl,
    extensionSettings,
    saveSettingsDebounced,
    eventSource
} = SillyTavern.getContext();

const MODULE_NAME = 'Chat_list';
const MAX_CHATS_PER_PAGE = 100;

// =========================
// Settings
// =========================
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { enabled: true };
    }
    return extensionSettings[MODULE_NAME];
}

// =========================
// Chat Data Fetching
// =========================
async function getListOfCharacterChats(avatar) {
    try {
        const result = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ avatar_url: avatar, simple: true }),
        });
        if (!result.ok) return [];
        const data = await result.json();
        if (!Array.isArray(data)) return [];
        return data.map(x => String(x.file_name).replace('.jsonl', ''));
    } catch (error) {
        console.warn('[Chat_list] Failed to get character chats:', error);
        return [];
    }
}

// =========================
// Chat Actions
// =========================
async function openChatById(chatId, isGroup = false, groupId = null) {
    const context = SillyTavern.getContext();
    if (!chatId) return;
    if (isGroup && groupId && typeof openGroupChat === 'function') {
        await openGroupChat(groupId, chatId);
    } else if (context.groupId && typeof openGroupChat === 'function') {
        await openGroupChat(context.groupId, chatId);
    } else if (context.characterId !== undefined && typeof openCharacterChat === 'function') {
        await openCharacterChat(chatId);
    }
}

async function deleteChat(chat) {
    try {
        if (chat.isGroup) {
            const response = await fetch('/api/chats/group', {
                method: 'DELETE',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: chat.file_name + '.jsonl', group_id: chat.characterId }),
            });
            if (!response.ok) throw new Error('Failed to delete group chat');
        } else {
            const response = await fetch('/api/chats/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    chatfile: chat.file_name + '.jsonl',
                    avatar_url: chat.avatar,
                }),
            });
            if (!response.ok) throw new Error('Failed to delete chat');
        }
        return true;
    } catch (error) {
        console.error('[Chat_list] Delete failed:', error);
        toastr.error('Failed to delete chat.');
        return false;
    }
}

// =========================
// UI State
// =========================
let cachedChats = null;
let isInjected = false;

// =========================
// UI Rendering
// =========================

function createPreviewImage(chat) {
    if (chat.isGroup) {
        const wrapper = document.createElement('div');
        wrapper.className = 'cm-preview-img cm-group-preview';
        const group = groups.find(g => g.id === chat.characterId);
        if (group) {
            const result = getGroupAvatar(group);
            if (result && result.length > 0) {
                const el = result[0];
                el.style.width = '100%';
                el.style.height = '100%';
                el.style.minWidth = 'unset';
                wrapper.appendChild(el);
            }
        }
        return wrapper;
    } else {
        const img = document.createElement('img');
        img.className = 'cm-preview-img';
        img.src = typeof getThumbnailUrl === 'function' ? getThumbnailUrl('avatar', chat.avatar) : (chat.avatar || '');
        img.alt = chat.character || '';
        return img;
    }
}

function renderChatItem(chat, container, refreshCallback) {
    const currentChatId = getCurrentChatId();
    const isCurrentChat = chat.file_name === currentChatId;
    const stat = chat.stat;

    const item = document.createElement('div');
    item.className = 'cm-chat-item' + (isCurrentChat ? ' cm-current' : '');

    // Preview image
    const previewImg = createPreviewImage(chat);
    item.appendChild(previewImg);

    // Info section
    const info = document.createElement('div');
    info.className = 'cm-chat-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'cm-chat-name';
    const prefix = chat.isGroup ? '👥 ' : '';
    nameRow.textContent = prefix + chat.character + ': ' + chat.file_name;
    nameRow.title = chat.character + ': ' + chat.file_name;
    info.appendChild(nameRow);

    const bottomRow = document.createElement('div');
    bottomRow.className = 'cm-chat-bottom';

    const msgPreview = document.createElement('div');
    msgPreview.className = 'cm-chat-message';
    msgPreview.textContent = stat && stat.mes ? stat.mes : '';
    msgPreview.title = stat && stat.mes ? stat.mes : '';
    bottomRow.appendChild(msgPreview);

    info.appendChild(bottomRow);
    item.appendChild(info);

    // Action buttons container
    const actions = document.createElement('div');
    actions.className = 'cm-chat-actions';

    // Rename button
    const renameBtn = document.createElement('button');
    renameBtn.className = 'cm-action-btn';
    renameBtn.title = t`Rename chat`;
    renameBtn.innerHTML = '<i class="fa-solid fa-pencil-alt"></i>';
    renameBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const content = document.createElement('div');
        content.innerHTML = '<h3>' + t`Rename chat` + '</h3>';
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = chat.file_name;
        nameInput.style.width = '100%';
        nameInput.style.marginTop = '8px';
        content.appendChild(nameInput);
        const popup = new Popup(content, POPUP_TYPE.TEXT, '', {
            okButton: t`Rename`,
            cancelButton: t`Cancel`,
            wide: true
        });
        nameInput.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter') { ev.preventDefault(); popup.okButton.click(); }
        });
        const result = await popup.show();
        if (result === POPUP_RESULT.AFFIRMATIVE && nameInput.value.trim() && nameInput.value.trim() !== chat.file_name) {
            const ctx = SillyTavern.getContext();
            await renameGroupOrCharacterChat({
                characterId: chat.characterId,
                groupId: chat.isGroup ? chat.characterId : ctx.groupId,
                oldFileName: chat.file_name,
                newFileName: nameInput.value.trim(),
                loader: null
            });
            cachedChats = null;
            if (refreshCallback) await refreshCallback();
        }
    });
    actions.appendChild(renameBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'cm-action-btn cm-delete-btn';
    deleteBtn.title = t`Delete chat`;
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        const content = document.createElement('div');
        content.innerHTML = '<h3>' + t`Delete this chat?` + '</h3>';

        const preview = document.createElement('div');
        preview.className = 'cm-delete-preview';
        const pImg = createPreviewImage(chat);
        const pName = document.createElement('div');
        pName.className = 'cm-chat-name';
        pName.textContent = chat.character + ': ' + chat.file_name;
        preview.appendChild(pImg);
        preview.appendChild(pName);
        content.appendChild(preview);

        if (isCurrentChat) {
            const warning = document.createElement('p');
            warning.style.color = '#e74c3c';
            warning.style.fontWeight = 'bold';
            warning.style.marginTop = '8px';
            warning.textContent = t`⚠ This is the currently active chat!`;
            content.appendChild(warning);
        }

        const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Delete`,
            cancelButton: t`Cancel`
        });
        const result = await popup.show();
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            const success = await deleteChat(chat);
            if (success) {
                cachedChats = null;
                if (refreshCallback) await refreshCallback();
            }
        }
    });
    actions.appendChild(deleteBtn);

    item.appendChild(actions);
    container.appendChild(item);

    // Click to open chat
    item.addEventListener('click', async (e) => {
        if (e.target.closest('.cm-action-btn')) return;
        const ctx = SillyTavern.getContext();
        if (chat.isGroup) {
            const group = groups.find(g => g.id === chat.characterId);
            if (group) {
                setActiveGroup(group);
                select_group_chats(group.id, true);
                await openChatById(chat.file_name, true, group.id);
            }
        } else {
            if (String(ctx.characterId) !== String(chat.characterId)) {
                await selectCharacterById(chat.characterId);
                await new Promise(r => setTimeout(r, 150));
            }
            await openChatById(chat.file_name);
        }
    });
}

// =========================
// Data Fetching
// =========================
async function fetchAllChats() {
    if (cachedChats) return cachedChats;

    const context = SillyTavern.getContext();
    const characters = context.characters || {};
    let allChats = [];
    let chatStatsMap = {};

    // Fetch character chats in parallel
    const chatListPromises = Object.entries(characters).map(async ([charId, char]) => {
        try {
            const chats = await getListOfCharacterChats(char.avatar);
            return chats.filter(name => typeof name === 'string' && name).map(name => ({
                character: char.name || charId,
                avatar: char.avatar,
                file_name: name,
                characterId: charId,
                isGroup: false
            }));
        } catch { return []; }
    });

    // Fetch group chats in parallel
    let groupChats = [];
    try {
        const resp = await fetch('/api/groups/all', {
            method: 'POST',
            headers: getRequestHeaders(),
        });
        if (resp.ok) {
            const grps = await resp.json();
            const groupPromises = grps.map(async (group) => {
                try {
                    const chats = await getGroupPastChats(group.id);
                    return chats.map(chat => {
                        const fileName = typeof chat === 'string'
                            ? chat.replace('.jsonl', '')
                            : String(chat.file_name || chat).replace('.jsonl', '');
                        return {
                            character: group.name || 'Group ' + group.id,
                            avatar: group.avatar || '',
                            file_name: fileName,
                            characterId: group.id,
                            isGroup: true,
                            groupMembers: group.members || []
                        };
                    });
                } catch { return []; }
            });
            const results = await Promise.all(groupPromises);
            groupChats = results.flat();
        }
    } catch (e) {
        console.warn('[Chat_list] Failed to load group chats:', e);
    }

    const charChatLists = await Promise.all(chatListPromises);
    allChats = [...charChatLists.flat(), ...groupChats];

    // Fetch stats for sorting by last message date
    const uniqueCharIds = [...new Set(allChats.filter(c => !c.isGroup).map(c => c.characterId))];
    const uniqueGroupIds = [...new Set(allChats.filter(c => c.isGroup).map(c => c.characterId))];

    const charStatsPromises = uniqueCharIds.map(async (charId) => {
        try {
            const statsList = await getPastCharacterChats(charId);
            return statsList.map(stat => {
                const fn = String(stat.file_name).replace('.jsonl', '');
                return [charId + ':' + fn, stat];
            });
        } catch { return []; }
    });

    const groupStatsPromises = uniqueGroupIds.map(async (groupId) => {
        try {
            const statsList = await getGroupPastChats(groupId);
            return statsList.map(stat => {
                const fn = typeof stat === 'string'
                    ? stat.replace('.jsonl', '')
                    : String(stat.file_name || stat).replace('.jsonl', '');
                return [groupId + ':' + fn, stat];
            });
        } catch { return []; }
    });

    const statsEntries = (await Promise.all([...charStatsPromises, ...groupStatsPromises])).flat();
    chatStatsMap = Object.fromEntries(statsEntries);

    // Merge stats, parse dates, sort by most recent
    allChats = allChats.map(chat => {
        const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
        let lastMesDate = null;
        if (stat && stat.last_mes) {
            const m = timestampToMoment(stat.last_mes);
            if (m && m.isValid()) lastMesDate = m.toDate();
        }
        return { ...chat, stat, last_mes: lastMesDate };
    }).filter(chat => chat.last_mes);

    allChats.sort((a, b) => b.last_mes - a.last_mes);
    cachedChats = allChats;
    return allChats;
}

// =========================
// List Rendering
// =========================
async function renderChatList(container, filter = '', offset = 0) {
    const allChats = await fetchAllChats();
    const filterLower = filter.toLowerCase();

    const filtered = allChats.filter(chat => {
        if (!filterLower) return true;
        return (
            (chat.character && chat.character.toLowerCase().includes(filterLower)) ||
            (chat.file_name && chat.file_name.toLowerCase().includes(filterLower)) ||
            (chat.stat && chat.stat.mes && chat.stat.mes.toLowerCase().includes(filterLower))
        );
    });

    const total = filtered.length;
    const page = filtered.slice(offset, offset + MAX_CHATS_PER_PAGE);

    const listContainer = container.querySelector('#cm-list');
    if (listContainer) listContainer.innerHTML = '';
    const target = listContainer || container;

    const refreshCallback = async () => {
        cachedChats = null;
        await renderChatList(container, filter, offset);
    };

   const refreshCallback = async () => {
        cachedChats = null;
        await renderChatList(container, filter, offset);
    };

const refreshCallback = async () => {
        cachedChats = null;
        await renderChatList(container, filter, offset);
    };

    page.forEach(chat => renderChatItem(chat, target, refreshCallback));

    // Load more button
    // Load more button
    const loadMoreBtn = container.querySelector('#cm-load-more');
    if (loadMoreBtn) {
        if (offset + MAX_CHATS_PER_PAGE < total) {
            loadMoreBtn.classList.remove('hidden');
            loadMoreBtn.onclick = async () => {
                await renderChatList(container, filter, offset + MAX_CHATS_PER_PAGE);
            };
        } else {
            loadMoreBtn.classList.add('hidden');
        }
    }

    // Chat count display
    const countEl = container.querySelector('#cm-count');
    if (countEl) {
        countEl.textContent = t`Total` + ': ' + total + (filter ? (' (' + t`filtered` + ')') : '');
    }

    // Hide loader
    const loader = container.querySelector('#cm-loader');
    if (loader) loader.classList.add('hidden');
}

// =========================
// Manager UI Builder
// =========================
function buildManagerUI() {
    const container = document.createElement('div');
    container.id = 'cm-container';

    // Title row
    const titleRow = document.createElement('div');
    titleRow.className = 'cm-title-row';
    const titleText = document.createElement('div');
    titleText.className = 'cm-title';
    titleText.textContent = t`All Chats`;
    titleRow.appendChild(titleText);
    container.appendChild(titleRow);

    // Filter row
    const filterRow = document.createElement('div');
    filterRow.className = 'cm-filter-row';

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'cm-input-wrapper';

    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.placeholder = t`Filter chats...`;
    filterInput.className = 'cm-filter-input';

    const clearBtn = document.createElement('button');
    clearBtn.className = 'cm-clear-btn hidden';
    clearBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    clearBtn.title = t`Clear filter`;

    inputWrapper.appendChild(filterInput);
    inputWrapper.appendChild(clearBtn);
    filterRow.appendChild(inputWrapper);
    container.appendChild(filterRow);

    // Chat count
    const countEl = document.createElement('div');
    countEl.id = 'cm-count';
    countEl.className = 'cm-count';
    container.appendChild(countEl);

    // Loader
    const loader = document.createElement('div');
    loader.id = 'cm-loader';
    loader.className = 'cm-loader';
    loader.innerHTML = '<i class="fa-2x fa-solid fa-gear fa-spin"></i>';
    container.appendChild(loader);

    // Chat list
    const list = document.createElement('div');
    list.id = 'cm-list';
    container.appendChild(list);

    // Load more button
    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'cm-load-more';
    loadMoreBtn.className = 'cm-load-more hidden';
    loadMoreBtn.textContent = t`Load More`;
    container.appendChild(loadMoreBtn);

    // Events
    let debounceTimer = null;
    filterInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        clearBtn.classList.toggle('hidden', val.length === 0);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const listEl = container.querySelector('#cm-list');
            if (listEl) listEl.innerHTML = '';
            const loaderEl = container.querySelector('#cm-loader');
            if (loaderEl) loaderEl.classList.remove('hidden');
            renderChatList(container, val, 0);
        }, 300);
    });

    clearBtn.addEventListener('click', () => {
        filterInput.value = '';
        clearBtn.classList.add('hidden');
        const listEl = container.querySelector('#cm-list');
        if (listEl) listEl.innerHTML = '';
        const loaderEl = container.querySelector('#cm-loader');
        if (loaderEl) loaderEl.classList.remove('hidden');
        renderChatList(container, '', 0);
        filterInput.focus();
    });

    return container;
}

// =========================
// Welcome Page Injection
// =========================

/**
 * Inject Chat_list into the Welcome Page's Recent Chats area.
 * Replaces .welcomeRecent content with the full chat manager UI.
 */
function injectIntoWelcomePage() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return false;

    const welcomePanel = chatEl.querySelector('.welcomePanel');
    if (!welcomePanel) return false;

    // Find the .welcomeRecent container
    let welcomeRecent = welcomePanel.querySelector('.welcomeRecent');
    if (!welcomeRecent) {
        // If welcomeRecent doesn't exist yet, create it
        welcomeRecent = document.createElement('div');
        welcomeRecent.className = 'welcomeRecent';
        welcomePanel.appendChild(welcomeRecent);
    }

    // Check if we already injected
    if (welcomeRecent.querySelector('#cm-container')) return true;

    // Clear original Recent Chats content
    welcomeRecent.innerHTML = '';

    // Build and inject our UI
    const ui = buildManagerUI();
    welcomeRecent.appendChild(ui);

    // Start loading chats
    renderChatList(ui, '', 0);

    return true;
}

/**
 * Observe DOM changes to detect when the Welcome Page is rendered.
 * The welcome panel is dynamically inserted into #chat, so we watch for it.
 */
function setupWelcomePageObserver() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) {
        // Retry after a short delay if #chat isn't ready yet
        setTimeout(setupWelcomePageObserver, 500);
        return;
    }

    // Try to inject immediately if welcome page is already there
    injectIntoWelcomePage();

    // Observe for future welcome page renders
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                // Check if a welcomePanel was added
                if (node.classList?.contains('welcomePanel') || node.querySelector?.('.welcomePanel')) {
                    // Small delay to let the template finish rendering
                    setTimeout(() => injectIntoWelcomePage(), 50);
                    return;
                }
                // Also check for .mes elements that might contain welcomePanel
                if (node.classList?.contains('mes') && node.querySelector?.('.welcomePanel')) {
                    setTimeout(() => injectIntoWelcomePage(), 50);
                    return;
                }
            }
        }
    });

    observer.observe(chatEl, { childList: true, subtree: true });
}

// =========================
// Extension Settings UI
// =========================
function renderExtensionSettings() {
    const context = SillyTavern.getContext();
    const settingsKey = MODULE_NAME;
    const settings = context.extensionSettings[settingsKey] ?? {};
    const settingsContainer = document.getElementById(settingsKey + '-container') ?? document.getElementById('extensions_settings2');
    if (!settingsContainer) return;
    if (settingsContainer.querySelector('#' + settingsKey + '-drawer')) return;

    const drawer = document.createElement('div');
    drawer.id = settingsKey + '-drawer';
    drawer.classList.add('inline-drawer');

    const toggle = document.createElement('div');
    toggle.classList.add('inline-drawer-toggle', 'inline-drawer-header');

    const title = document.createElement('b');
    title.textContent = 'Chat_list';
    const icon = document.createElement('div');
    icon.classList.add('inline-drawer-icon', 'fa-solid', 'fa-circle-chevron-down', 'down');
    toggle.append(title, icon);

    const content = document.createElement('div');
    content.classList.add('inline-drawer-content');

    const label = document.createElement('label');
    label.classList.add('checkbox_label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = settings.enabled ?? true;
    checkbox.addEventListener('change', () => {
        settings.enabled = checkbox.checked;
        context.saveSettingsDebounced();
    });
    const span = document.createElement('span');
    span.textContent = t`Enable Chat_list (needs reload)`;
    label.append(checkbox, span);
    content.appendChild(label);

    drawer.append(toggle, content);
    settingsContainer.appendChild(drawer);

    toggle.addEventListener('click', function () {
        this.classList.toggle('open');
        icon.classList.toggle('down');
        icon.classList.toggle('up');
        content.classList.toggle('open');
    });
}

// =========================
// Init
// =========================
(function init() {
    const settings = getSettings();
    renderExtensionSettings();
    if (settings.enabled === false) return;
    setupWelcomePageObserver();
})();
