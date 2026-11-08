// =========================
// Chat_list - SillyTavern Extension
// Replace the Welcome Page "Recent Chats" with a full chat list.
// List, rename, delete all chats — without entering them.
// =========================
import {
    getGroupAvatar,
    getGroupPastChats,
    groups,
    select_group_chats,
    editGroup,
    createNewGroupChat,
    is_group_generating,
} from '../../../group-chats.js';

import {
    getPastCharacterChats,
    selectCharacterById,
    renameGroupOrCharacterChat,
    event_types,
    setActiveGroup,
    replaceCurrentChat,
    isChatSaving,
    is_send_press,
} from '../../../../script.js';
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

// 조건이 true가 될 때까지 대기 (최대 timeout ms)
async function waitFor(cond, timeout = 3000, interval = 50) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (cond()) return true;
        await new Promise(r => setTimeout(r, interval));
    }
    return cond();
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
// Chat Actions
// =========================
async function openChatById(chatId, isGroup = false, groupId = null) {
    if (!chatId) return;
    if (isGroup && groupId && typeof openGroupChat === 'function') {
        await openGroupChat(groupId, chatId);
    } else if (!isGroup && typeof openCharacterChat === 'function') {
        await openCharacterChat(chatId);
    }
}

function getChatKey(chat) {
    return `${chat.isGroup ? 'group' : 'character'}:${chat.characterId}:${chat.file_name}`;
}

function isCurrentManagedChat(chat) {
    const ctx = SillyTavern.getContext();
    const currentChatId = getCurrentChatId();

    if (!currentChatId || String(currentChatId) !== String(chat.file_name)) {
        return false;
    }
    if (chat.isGroup) {
        return String(ctx.groupId) === String(chat.characterId);
    }
    return !ctx.groupId && String(ctx.characterId) === String(chat.characterId);
}

function canMutateChatFiles() {
    if (isChatSaving) {
        toastr.info(
            t`Please wait until the chat is saved before renaming or deleting chats.`,
            t`Chat is still saving`,
        );
        return false;
    }
    if (is_send_press || is_group_generating) {
        toastr.info(
            t`Please stop the current generation before renaming or deleting chats.`,
            t`Generation in progress`,
        );
        return false;
    }
    return true;
}

async function deleteChat(chat) {
    if (!canMutateChatFiles()) return false;

    try {
        const isCurrent = isCurrentManagedChat(chat);

        if (chat.isGroup) {
            const group = groups.find(
                g => String(g.id) === String(chat.characterId)
            );

            if (
                !group ||
                !Array.isArray(group.chats) ||
                !group.chats.includes(chat.file_name)
            ) {
                throw new Error('Group chat not found');
            }

            // 1) 서버 파일 먼저 삭제
            const response = await fetch('/api/chats/group/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    id: chat.file_name,
                }),
            });

            if (!response.ok) {
                throw new Error(
                    `Failed to delete group chat (${response.status})`
                );
            }

            // 2) 서버 삭제 성공 후에만 그룹 메타데이터 수정
            group.chats.splice(group.chats.indexOf(chat.file_name), 1);

            if (isCurrent) {
                group.chat_id = '';

                const replacement =
                    group.chats[group.chats.length - 1];

                if (replacement) {
                    await openGroupChat(group.id, replacement);
                } else {
                    await createNewGroupChat(group.id);
                }
            } else {
                await editGroup(group.id, true, false);
            }

            if (eventSource && typeof eventSource.emit === 'function') {
                await eventSource.emit(
                    event_types.GROUP_CHAT_DELETED,
                    chat.file_name,
                );
            }
        } else {
            const response = await fetch('/api/chats/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    chatfile: chat.file_name + '.jsonl',
                    avatar_url: chat.avatar,
                }),
            });

            if (!response.ok) {
                throw new Error(
                    `Failed to delete chat (${response.status})`
                );
            }

            if (isCurrent) {
                await replaceCurrentChat();
            }

            if (eventSource && typeof eventSource.emit === 'function') {
                await eventSource.emit(
                    event_types.CHAT_DELETED,
                    chat.file_name,
                );
            }
        }
        cachedChats = null;
        return true;
    } catch (error) {
        console.error('[Chat_list] Delete failed:', error);
        toastr.error(t`Failed to delete chat.`);
        return false;
    }
}

// =========================
// UI State
// =========================
let cachedChats = null;
let isSelectMode = false;
let selectedChats = new Set();

// =========================
// Auto Refresh
// =========================
let chatListRefreshTimer = null;
let chatListRefreshRunning = false;

/**
 * Welcome 화면에 채팅 목록이 표시되고 있을 때만 새로고침한다.
 */
async function refreshChatListIfVisible() {
    clearTimeout(chatListRefreshTimer);

    chatListRefreshTimer = setTimeout(async () => {
        const container = document.getElementById('cm-container');
        if (!container) return;

        const welcomePanel = container.closest('.welcomePanel');
        if (!welcomePanel) return;
        if (welcomePanel.offsetParent === null) return;
        if (chatListRefreshRunning) return;

        chatListRefreshRunning = true;

        try {
            const filterInput =
                container.querySelector('#cm-filter-input') ??
                container.querySelector('.cm-filter-input');

            const filter = filterInput?.value?.trim() ?? '';

            cachedChats = null;

            const loader = container.querySelector('#cm-loader');
            if (loader) loader.classList.remove('hidden');

            await renderChatList(container, filter, 0);
        } catch (error) {
            console.error('[Chat_list] Auto refresh failed:', error);
        } finally {
            chatListRefreshRunning = false;
        }
    }, 15);
}

function setupChatListAutoRefresh() {
    if (!eventSource || typeof eventSource.on !== 'function') {
        console.warn('[Chat_list] eventSource.on is not available.');
        return;
    }

    eventSource.on(event_types.CHAT_CHANGED, refreshChatListIfVisible);
    eventSource.on(event_types.CHAT_CREATED, refreshChatListIfVisible);
    eventSource.on(event_types.CHAT_RENAMED, refreshChatListIfVisible);
    eventSource.on(event_types.CHAT_DELETED, refreshChatListIfVisible);
    eventSource.on(event_types.GROUP_CHAT_CREATED, refreshChatListIfVisible);
    eventSource.on(event_types.GROUP_CHAT_DELETED, refreshChatListIfVisible);
}

// =========================
// Concurrency Limiter
// =========================
async function mapWithConcurrency(items, limit, iteratee) {
    const results = new Array(items.length);
    let index = 0;
    async function worker() {
        while (index < items.length) {
            const current = index++;
            results[current] = await iteratee(items[current], current);
        }
    }
    const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
    await Promise.all(workers);
    return results;
}

const FETCH_CONCURRENCY = 4;

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
    const isCurrentChat = isCurrentManagedChat(chat);
    const stat = chat.stat;

    const item = document.createElement('div');
    item.className = 'cm-chat-item' + (isCurrentChat ? ' cm-current' : '');

    if (isSelectMode) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'cm-select-checkbox';
        const chatKey = getChatKey(chat);
        checkbox.checked = selectedChats.has(chatKey);
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            if (checkbox.checked) {
                selectedChats.add(chatKey);
            } else {
                selectedChats.delete(chatKey);
            }
        });
        item.appendChild(checkbox);
    }

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

    // ----- Rename -----
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
        if (result === POPUP_RESULT.AFFIRMATIVE) {
            if (!canMutateChatFiles()) return;

            // 사용자가 .jsonl까지 입력해도 중복으로 붙지 않게 제거
            const newFileName = nameInput.value
                .trim()
                .replace(/\.jsonl$/i, '')
                .trim();

            if (!newFileName) {
                toastr.warning(t`Chat name cannot be empty.`);
                return;
            }

            if (newFileName === chat.file_name) {
                return;
            }

            await renameGroupOrCharacterChat({
                characterId: chat.characterId,
                // 캐릭터 채팅일 때 현재 context.groupId를 넘기면 안 됨
                groupId: chat.isGroup ? chat.characterId : null,
                oldFileName: chat.file_name,
                newFileName,
                loader: null,
            });

            cachedChats = null;

            if (refreshCallback) {
                await refreshCallback();
            }
        }
    });
    actions.appendChild(renameBtn);

    // ----- Delete -----
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'cm-action-btn cm-delete-btn';
    deleteBtn.title = t`Delete chat`;
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();

        if (!canMutateChatFiles()) {
            return;
        }

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
                if (refreshCallback) await refreshCallback();
            }
        }
    });
    actions.appendChild(deleteBtn);

    item.appendChild(actions);
    container.appendChild(item);

    // ----- Open chat / toggle select -----
    item.addEventListener('click', async (e) => {
        if (e.target.closest('.cm-action-btn')) return;

        // 선택 모드면 체크박스 토글
        if (isSelectMode) {
            const chatKey = getChatKey(chat);
            const checkbox = item.querySelector('.cm-select-checkbox');
            if (selectedChats.has(chatKey)) {
                selectedChats.delete(chatKey);
                if (checkbox) checkbox.checked = false;
            } else {
                selectedChats.add(chatKey);
                if (checkbox) checkbox.checked = true;
            }
            return;
        }

        const ctx = SillyTavern.getContext();
        const currentChatId = getCurrentChatId();

        // 이미 열려있는 채팅이면 아무 동작 없이 종료
        if (chat.isGroup) {
            if (String(ctx.groupId) === String(chat.characterId) && currentChatId === chat.file_name) {
                return;
            }
        } else {
            if (!ctx.groupId && String(ctx.characterId) === String(chat.characterId) && currentChatId === chat.file_name) {
                return;
            }
        }

        // 저장/생성 진행 중이면 전환하지 않음
        // (이 상태에서 전환하면 엉뚱한 새 채팅이 생성될 수 있음)
        if (isChatSaving || is_send_press || is_group_generating) {
            toastr.info(t`Please wait until the chat is saved.`);
            return;
        }

        if (chat.isGroup) {
            const group = groups.find(g => g.id === chat.characterId);
            if (!group) return;
            await openGroupChat(group.id, chat.file_name);
        } else {
            if (ctx.groupId || String(ctx.characterId) !== String(chat.characterId)) {
                await selectCharacterById(chat.characterId);

                // 고정 대기 대신, 실제로 전환됐는지 확인 (최대 3초)
                const switched = await waitFor(() => {
                    const c = SillyTavern.getContext();
                    return !c.groupId && String(c.characterId) === String(chat.characterId);
                });

                if (!switched) {
                    toastr.warning(t`Character switch failed. Please try again.`);
                    return;
                }
            }

            // selectCharacterById가 이미 원하는 채팅을 로드했다면 재호출하지 않음
            if (getCurrentChatId() !== chat.file_name) {
                await openCharacterChat(chat.file_name);
            }
        }
    });
}

// =========================
// Data Fetching
// =========================
let fetchInFlight = null;

async function fetchAllChats() {
    if (cachedChats) return cachedChats;
    if (fetchInFlight) return fetchInFlight;

    fetchInFlight = (async () => {
        const context = SillyTavern.getContext();
        const characters = context.characters || {};

        let allChats = [];

        const charEntries = Object.entries(characters);

        // getPastCharacterChats() 하나로
        // file_name / last_mes / chat_items / file_size 등을 가져온다.
        const charChatLists = await mapWithConcurrency(
            charEntries,
            FETCH_CONCURRENCY,
            async ([charId, char]) => {
                try {
                    const statsList = await getPastCharacterChats(charId);

                    return statsList
                        .filter(stat => stat && stat.file_name)
                        .map(stat => ({
                            character: char.name || charId,
                            avatar: char.avatar,
                            file_name: String(stat.file_name).replace(/\.jsonl$/i, ''),
                            characterId: charId,
                            isGroup: false,
                            stat,
                        }));
                } catch {
                    return [];
                }
            },
        );

        let groupChats = [];

        try {
            const resp = await fetch('/api/groups/all', {
                method: 'POST',
                headers: getRequestHeaders(),
            });

            if (resp.ok) {
                const grps = await resp.json();

                const groupResults = await mapWithConcurrency(
                    grps,
                    FETCH_CONCURRENCY,
                    async (group) => {
                        try {
                            const chats = await getGroupPastChats(group.id);

                            return chats.map(chat => {
                                const stat = typeof chat === 'string' ? null : chat;

                                const fileName = typeof chat === 'string'
                                    ? chat.replace(/\.jsonl$/i, '')
                                    : String(chat.file_name || chat).replace(/\.jsonl$/i, '');

                                return {
                                    character: group.name || 'Group ' + group.id,
                                    avatar: group.avatar || '',
                                    file_name: fileName,
                                    characterId: group.id,
                                    isGroup: true,
                                    groupMembers: group.members || [],
                                    stat,
                                };
                            });
                        } catch {
                            return [];
                        }
                    },
                );

                groupChats = groupResults.flat();
            }
        } catch (e) {
            console.warn('[Chat_list] Failed to load group chats:', e);
        }

        allChats = [
            ...charChatLists.flat(),
            ...groupChats,
        ].map(chat => {
            const stat = chat.stat;

            let lastMesDate = null;

            if (stat && stat.last_mes) {
                const m = timestampToMoment(stat.last_mes);
                if (m && m.isValid()) {
                    lastMesDate = m.toDate();
                }
            }

            // 파일명 기반 fallback
            if (!lastMesDate) {
                const match = chat.file_name.match(/(\d{4}-\d{1,2}-\d{1,2})/);
                if (match) {
                    const parsed = new Date(match[1]);
                    if (!isNaN(parsed.getTime())) {
                        lastMesDate = parsed;
                    }
                }
            }

            if (!lastMesDate) {
                lastMesDate = new Date(0);
            }

            return {
                ...chat,
                last_mes: lastMesDate,
                messageCount: stat?.chat_items ?? null,
                fileSize: stat?.file_size ?? null,
            };
        });

        allChats.sort((a, b) => b.last_mes - a.last_mes);

        cachedChats = allChats;
        return allChats;
    })();

    try {
        return await fetchInFlight;
    } finally {
        fetchInFlight = null;
    }
}

// =========================
// List Rendering
// =========================
async function renderChatList(container, filter = '', offset = 0) {
    const allChats = await fetchAllChats();
    const filterLower = filter.toLowerCase();

    // 채팅방 이름(파일명)만 대상, 부분 일치, 대소문자 무시
    const filtered = allChats.filter(chat => {
        if (!filterLower) return true;
        return chat.file_name && chat.file_name.toLowerCase().includes(filterLower);
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

    const selectDeleteBtn = document.createElement('button');
    selectDeleteBtn.className = 'cm-action-btn cm-select-mode-btn';
    selectDeleteBtn.innerHTML = '<i class="fa-solid fa-check-square"></i> ' + t`Select`;
    selectDeleteBtn.title = t`Select multiple chats to delete`;

    selectDeleteBtn.addEventListener('click', () => {
        isSelectMode = !isSelectMode;
        selectedChats.clear();

        selectDeleteBtn.innerHTML = isSelectMode
            ? '<i class="fa-solid fa-xmark"></i> ' + t`Cancel`
            : '<i class="fa-solid fa-check-square"></i> ' + t`Select`;

        selectDeleteBtn.classList.toggle('cm-select-mode-active', isSelectMode);
        confirmDeleteBtn.classList.toggle('hidden', !isSelectMode);

        renderChatList(container, filterInput.value.trim(), 0);
    });

    const confirmDeleteBtn = document.createElement('button');
    confirmDeleteBtn.className =
        'cm-action-btn cm-delete-btn cm-confirm-delete-btn hidden';
    confirmDeleteBtn.innerHTML =
        '<i class="fa-solid fa-trash"></i> ' + t`Delete Selected`;

    confirmDeleteBtn.addEventListener('click', async () => {
        if (selectedChats.size === 0) {
            toastr.warning(t`No chats selected.`);
            return;
        }

        const allChats = await fetchAllChats();

        const toDelete = allChats.filter(
            c => selectedChats.has(getChatKey(c))
        );

        if (toDelete.length === 0) {
            toastr.warning(t`No valid chats selected.`);
            return;
        }

        // 현재 채팅은 반드시 마지막에 삭제한다.
        const orderedToDelete = [...toDelete].sort((a, b) => {
            const aCurrent = isCurrentManagedChat(a);
            const bCurrent = isCurrentManagedChat(b);
            return Number(aCurrent) - Number(bCurrent);
        });

        const content = document.createElement('div');
        content.innerHTML = '<h3>' + t`Delete selected chats?` + '</h3>';

        const countMsg = document.createElement('p');
        countMsg.textContent = toDelete.length + t` chats will be deleted.`;
        countMsg.style.color = '#e74c3c';
        countMsg.style.fontWeight = 'bold';
        content.appendChild(countMsg);

        const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
            okButton: t`Delete All`,
            cancelButton: t`Cancel`
        });

        const result = await popup.show();

        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        for (const chat of orderedToDelete) {
            await deleteChat(chat);
        }

        isSelectMode = false;
        selectedChats.clear();

        selectDeleteBtn.innerHTML =
            '<i class="fa-solid fa-check-square"></i> ' + t`Select`;
        selectDeleteBtn.classList.remove('cm-select-mode-active');
        confirmDeleteBtn.classList.add('hidden');

        cachedChats = null;

        await renderChatList(container, filterInput.value.trim(), 0);
    });

    // [Select/Cancel] [Delete Selected] 순서
    titleRow.appendChild(selectDeleteBtn);
    titleRow.appendChild(confirmDeleteBtn);

    const filterInput = document.createElement('input');
    filterInput.type = 'text';
    filterInput.id = 'cm-filter-input';
    filterInput.placeholder = t`Search by chat name...`;
    filterInput.className = 'cm-filter-input';

    container.appendChild(titleRow);

    const filterRow = document.createElement('div');
    filterRow.className = 'cm-filter-row';

    const inputWrapper = document.createElement('div');
    inputWrapper.className = 'cm-input-wrapper';

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

    let injecting = false;
    const observer = new MutationObserver((mutations) => {
        if (injecting) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                if (node.id === 'cm-container' || node.querySelector?.('#cm-container')) continue;
                if (node.classList?.contains('welcomePanel') || node.querySelector?.('.welcomePanel')) {
                    injecting = true;
                    observer.disconnect();
                    setTimeout(() => {
                        injectIntoWelcomePage();
                        injecting = false;
                        observer.observe(chatEl, { childList: true, subtree: true });
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
    if (settings.enabled === false) {
        return;
    }
    setupChatListAutoRefresh();
    setupWelcomePageObserver();
})();
