// =========================
// Chat_list - SillyTavern Extension
// Replace the Welcome Page "Recent Chats" with a full chat list.
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

function formatFileSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

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

// [FIX] openChatById 단순화
// 기존: context.groupId 잔재가 남아있으면 캐릭터 채팅도 openGroupChat으로 잘못 분기 → 이중 실행
// 수정: isGroup 플래그만 보고 분기, 컨텍스트 상태에 의존하지 않음
async function openChatById(chatId, isGroup = false, groupId = null) {
    if (!chatId) return;
    if (isGroup && groupId && typeof openGroupChat === 'function') {
        await openGroupChat(groupId, chatId);
    } else if (!isGroup && typeof openCharacterChat === 'function') {
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

        // [FIX] emit 먼저 완료한 뒤 캐시 무효화
        // 기존: cachedChats = null을 emit 전에 해서 이벤트 핸들러가 빈 캐시로 재요청 충돌
        if (eventSource && typeof eventSource.emit === 'function') {
            const currentChatId = getCurrentChatId();
            if (chat.file_name === currentChatId) {
                eventSource.emit(event_types.CHAT_CHANGED, { chatId: null });
            }
            try {
                eventSource.emit(event_types.CHAT_DELETED, {
                    chatId: chat.file_name,
                    characterId: chat.characterId,
                    isGroup: chat.isGroup,
                });
            } catch {
                // CHAT_DELETED 이벤트가 없는 ST 버전에서는 무시
            }
        }

        cachedChats = null; // emit 완료 후 무효화

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

// =========================
// Date Grouping Helper
// =========================
function getDateGroupLabel(date) {
    if (!date) return t`Unknown`;

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const chatDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (chatDay.getTime() === today.getTime()) {
        return t`Today`;
    }
    if (chatDay.getTime() === yesterday.getTime()) {
        return t`Yesterday`;
    }

    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() - today.getDay());
    if (chatDay >= weekStart) {
        return t`This Week`;
    }

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    if (chatDay >= monthStart) {
        return t`This Month`;
    }

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    return `${year}년 ${month}월`;
}

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

    const previewImg = createPreviewImage(chat);
    item.appendChild(previewImg);

    const info = document.createElement('div');
    info.className = 'cm-chat-info';

    const nameRow = document.createElement('div');
    nameRow.className = 'cm-chat-name';
    const prefix = chat.isGroup ? '👥 ' : '';
    nameRow.textContent = prefix + chat.character + ': ' + chat.file_name;
    nameRow.title = chat.character + ': ' + chat.file_name;
    info.appendChild(nameRow);

    const metaRow = document.createElement('div');
    metaRow.className = 'cm-chat-meta';

    if (chat.messageCount != null) {
        const msgBadge = document.createElement('span');
        msgBadge.className = 'cm-meta-badge';
        msgBadge.innerHTML = '<i class="fa-solid fa-message fa-xs"></i> ' + chat.messageCount;
        msgBadge.title = t`Messages`;
        metaRow.appendChild(msgBadge);
    }

    if (chat.fileSize) {
        const sizeBadge = document.createElement('span');
        sizeBadge.className = 'cm-meta-badge';
        sizeBadge.innerHTML = '<i class="fa-solid fa-file fa-xs"></i> ' + chat.fileSize;
        sizeBadge.title = t`File size`;
        metaRow.appendChild(sizeBadge);
    }

    if (metaRow.children.length > 0) {
        info.appendChild(metaRow);
    }

    const bottomRow = document.createElement('div');
    bottomRow.className = 'cm-chat-bottom';

    const msgPreview = document.createElement('div');
    msgPreview.className = 'cm-chat-message';
    msgPreview.textContent = stat && stat.mes ? stat.mes : '';
    msgPreview.title = stat && stat.mes ? stat.mes : '';
    bottomRow.appendChild(msgPreview);

    info.appendChild(bottomRow);
    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'cm-chat-actions';

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
                // [FIX] deleteChat 내부에서 이미 cachedChats = null 처리됨
                // 기존: 여기서 한 번 더 null 해서 이중 무효화 → 중복 refresh 요청 유발
                if (refreshCallback) await refreshCallback();
            }
        }
    });
    actions.appendChild(deleteBtn);

    item.appendChild(actions);
    container.appendChild(item);

    // [FIX] 클릭 핸들러를 단일 경로로 통합
    // 기존: setActiveGroup + select_group_chats 호출 후 openChatById도 호출 → 그룹 채팅 이중 실행
    //       캐릭터 채팅도 openChatById 내부에서 context.groupId 잔재로 openGroupChat이 잘못 호출될 수 있었음
    // 수정: 그룹은 openGroupChat 직접 호출, 캐릭터는 selectCharacterById + openCharacterChat 직접 호출
    //       openChatById를 거치지 않으므로 컨텍스트 오판 없음
    item.addEventListener('click', async (e) => {
        if (e.target.closest('.cm-action-btn')) return;
        const ctx = SillyTavern.getContext();

        if (chat.isGroup) {
            const group = groups.find(g => g.id === chat.characterId);
            if (!group) return;
            // openGroupChat 하나로 처리 (setActiveGroup + select_group_chats 중복 호출 제거)
            await openGroupChat(group.id, chat.file_name);
        } else {
            if (String(ctx.characterId) !== String(chat.characterId)) {
                await selectCharacterById(chat.characterId);
                await new Promise(r => setTimeout(r, 200)); // 150 → 200ms: 캐릭터 전환 완료 여유
            }
            await openCharacterChat(chat.file_name);
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

    allChats = allChats.map(chat => {
        const stat = chatStatsMap[chat.characterId + ':' + chat.file_name];
        let lastMesDate = null;
        if (stat && stat.last_mes) {
            const m = timestampToMoment(stat.last_mes);
            if (m && m.isValid()) lastMesDate = m.toDate();
        }
        if (!lastMesDate) {
            const match = chat.file_name.match(/(\d{4}-\d{1,2}-\d{1,2})/);
            if (match) {
                const parsed = new Date(match[1]);
                if (!isNaN(parsed.getTime())) lastMesDate = parsed;
            }
        }
        if (!lastMesDate) {
            lastMesDate = new Date(0);
        }

        const messageCount = stat?.chat_items ?? null;
        const fileSize = stat?.file_size ?? null;
        return { ...chat, stat, last_mes: lastMesDate, messageCount, fileSize };
    });

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
    const target = listContainer || container;

    if (offset === 0) {
        target.innerHTML = '';
    }

    const refreshCallback = async () => {
        cachedChats = null;
        await renderChatList(container, filter, 0);
    };

    let lastGroupLabel = null;
    if (offset > 0) {
        const existingSeparators = target.querySelectorAll('.cm-date-separator');
        if (existingSeparators.length > 0) {
            lastGroupLabel = existingSeparators[existingSeparators.length - 1].textContent;
        }
    }

    page.forEach(chat => {
        const label = getDateGroupLabel(chat.last_mes);
        if (label !== lastGroupLabel) {
            lastGroupLabel = label;
            const separator = document.createElement('div');
            separator.className = 'cm-date-separator';
            separator.textContent = label;
            target.appendChild(separator);
        }
        renderChatItem(chat, target, refreshCallback);
    });

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

    const countEl = container.querySelector('#cm-count');
    if (countEl) {
        countEl.textContent = t`Total` + ': ' + total + (filter ? (' (' + t`filtered` + ')') : '');
    }

    const loader = container.querySelector('#cm-loader');
    if (loader) loader.classList.add('hidden');
}

// =========================
// Manager UI Builder
// =========================
function buildManagerUI() {
    const container = document.createElement('div');
    container.id = 'cm-container';

    const titleRow = document.createElement('div');
    titleRow.className = 'cm-title-row';
    const titleText = document.createElement('div');
    titleText.className = 'cm-title';
    titleText.textContent = t`All Chats`;
    titleRow.appendChild(titleText);
    container.appendChild(titleRow);

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

    const countEl = document.createElement('div');
    countEl.id = 'cm-count';
    countEl.className = 'cm-count';
    container.appendChild(countEl);

    const loader = document.createElement('div');
    loader.id = 'cm-loader';
    loader.className = 'cm-loader';
    loader.innerHTML = '<i class="fa-2x fa-solid fa-gear fa-spin"></i>';
    container.appendChild(loader);

    const list = document.createElement('div');
    list.id = 'cm-list';
    container.appendChild(list);

    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.id = 'cm-load-more';
    loadMoreBtn.className = 'cm-load-more hidden';
    loadMoreBtn.textContent = t`Load More`;
    container.appendChild(loadMoreBtn);

    let debounceTimer = null;
    filterInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        clearBtn.classList.toggle('hidden', val.length === 0);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const loaderEl = container.querySelector('#cm-loader');
            if (loaderEl) loaderEl.classList.remove('hidden');
            renderChatList(container, val, 0);
        }, 300);
    });

    clearBtn.addEventListener('click', () => {
        filterInput.value = '';
        clearBtn.classList.add('hidden');
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
function injectIntoWelcomePage() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return false;

    const welcomePanel = chatEl.querySelector('.welcomePanel');
    if (!welcomePanel) return false;

    let welcomeRecent = welcomePanel.querySelector('.welcomeRecent');
    if (!welcomeRecent) {
        welcomeRecent = document.createElement('div');
        welcomeRecent.className = 'welcomeRecent';
        welcomePanel.appendChild(welcomeRecent);
    }

    if (welcomeRecent.querySelector('#cm-container')) return true;

    welcomeRecent.innerHTML = '';

    const ui = buildManagerUI();
    welcomeRecent.appendChild(ui);

    renderChatList(ui, '', 0);

    return true;
}

function setupWelcomePageObserver() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) {
        setTimeout(setupWelcomePageObserver, 500);
        return;
    }

    injectIntoWelcomePage();

    // [FIX] Observer 중복 실행 방지
    // 기존: 채팅 열고 닫을 때마다 DOM 변경 감지 → injectIntoWelcomePage 중복 호출 가능
    // 수정: injecting 플래그로 타이머 중복 실행 차단
    let injecting = false;
    const observer = new MutationObserver((mutations) => {
        if (injecting) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.classList?.contains('welcomePanel') || node.querySelector?.('.welcomePanel')) {
                    injecting = true;
                    setTimeout(() => {
                        injectIntoWelcomePage();
                        injecting = false;
                    }, 50);
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
