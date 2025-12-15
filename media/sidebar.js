// Azure DevOps Code Companion - Sidebar JavaScript
// External script for webview functionality

(function() {
    'use strict';

    // VS Code API
    const vscode = acquireVsCodeApi();

    // State
    let currentView = 'list';
    let workItems = [];
    let currentTimer = null;
    let searchDebounceTimer = null;

    // DOM Elements (cached on init)
    let elements = {};

    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', init);

    function init() {
        cacheElements();
        bindEventListeners();
        requestInitialData();
    }

    function cacheElements() {
        elements = {
            content: document.getElementById('content'),
            searchInput: document.getElementById('searchInput'),
            timerContainer: document.getElementById('timer-container'),
            timerDisplay: document.getElementById('timer-display'),
            timerTask: document.getElementById('timer-task'),
            statusOverview: document.getElementById('statusOverview'),
            sprintFilter: document.getElementById('sprintFilter'),
            typeFilter: document.getElementById('typeFilter'),
            assignedToFilter: document.getElementById('assignedToFilter'),
            excludeDone: document.getElementById('excludeDone'),
            excludeClosed: document.getElementById('excludeClosed'),
            excludeRemoved: document.getElementById('excludeRemoved'),
            excludeInReview: document.getElementById('excludeInReview')
        };
    }

    function bindEventListeners() {
        // Event delegation for clicks
        document.addEventListener('click', handleClick);

        // Event delegation for changes
        document.addEventListener('change', handleChange);

        // Search input with debounce
        if (elements.searchInput) {
            elements.searchInput.addEventListener('input', handleSearchInput);
            elements.searchInput.addEventListener('keypress', handleSearchKeypress);
        }

        // Keyboard navigation
        document.addEventListener('keydown', handleKeydown);
    }

    function handleClick(e) {
        const target = e.target;

        // Work item card click
        const workItemCard = target.closest('[data-action="selectWorkItem"]');
        if (workItemCard && !target.closest('button')) {
            const id = parseInt(workItemCard.getAttribute('data-id'));
            if (id) selectWorkItem(id);
            return;
        }

        // Button click
        const button = target.closest('button[data-action]');
        if (button) {
            e.stopPropagation();
            handleButtonAction(button);
            return;
        }

        // Status badge click
        const statusBadge = target.closest('.status-badge[data-state]');
        if (statusBadge) {
            handleStatusBadgeClick(statusBadge);
            return;
        }
    }

    function handleButtonAction(button) {
        const action = button.getAttribute('data-action');
        const id = button.getAttribute('data-id') ? parseInt(button.getAttribute('data-id')) : null;

        const actions = {
            'refresh': () => vscode.postMessage({ type: 'refresh' }),
            'createWorkItem': () => vscode.postMessage({ type: 'createWorkItem' }),
            'toggleKanban': () => {
                currentView = currentView === 'list' ? 'kanban' : 'list';
                vscode.postMessage({ type: 'toggleKanban' });
            },
            'showTimeReport': () => vscode.postMessage({ type: 'showTimeReport' }),
            'showPullRequests': () => vscode.postMessage({ type: 'showPullRequests' }),
            'showPipelines': () => vscode.postMessage({ type: 'showPipelines' }),
            'showBuilds': () => vscode.postMessage({ type: 'showBuilds' }),
            'showTests': () => vscode.postMessage({ type: 'showTests' }),
            'showWiki': () => vscode.postMessage({ type: 'showWiki' }),
            'showCapacity': () => vscode.postMessage({ type: 'showCapacity' }),
            'search': () => performSearch(),
            'clearSearch': () => clearSearch(),
            'pauseTimer': () => vscode.postMessage({ type: 'pauseTimer' }),
            'resumeTimer': () => vscode.postMessage({ type: 'resumeTimer' }),
            'stopTimer': () => vscode.postMessage({ type: 'stopTimer' }),
            'startTimer': () => id && vscode.postMessage({ type: 'startTimer', id }),
            'createBranch': () => id && vscode.postMessage({ type: 'createBranch', id }),
            'openInBrowser': () => id && vscode.postMessage({ type: 'openInBrowser', id }),
            'copyId': () => id && vscode.postMessage({ type: 'copyId', id }),
            'updateStatus': () => id && vscode.postMessage({ type: 'updateStatus', id })
        };

        if (actions[action]) {
            actions[action]();
        }
    }

    function handleChange(e) {
        const target = e.target;

        // Filter dropdowns and checkboxes
        if (target.matches('select[data-action="applyFilters"], input[data-action="applyFilters"]')) {
            applyFilters();
        }
    }

    function handleSearchInput(e) {
        const query = e.target.value.trim();

        // Clear previous debounce timer
        if (searchDebounceTimer) {
            clearTimeout(searchDebounceTimer);
        }

        // Show/hide clear button
        const clearBtn = document.querySelector('[data-action="clearSearch"]');
        if (clearBtn) {
            clearBtn.style.display = query ? 'block' : 'none';
        }

        // Debounce search for 150ms
        searchDebounceTimer = setTimeout(() => {
            if (query.length >= 2) {
                filterWorkItemsLocally(query);
            } else if (query.length === 0) {
                renderWorkItems(workItems, currentView === 'kanban');
            }
        }, 150);
    }

    function handleSearchKeypress(e) {
        if (e.key === 'Enter') {
            performSearch();
        }
    }

    function handleKeydown(e) {
        // Keyboard shortcuts
        if (e.ctrlKey || e.metaKey) {
            switch (e.key) {
                case 'r':
                    e.preventDefault();
                    vscode.postMessage({ type: 'refresh' });
                    break;
                case 'n':
                    e.preventDefault();
                    vscode.postMessage({ type: 'createWorkItem' });
                    break;
                case 'k':
                    e.preventDefault();
                    if (elements.searchInput) {
                        elements.searchInput.focus();
                        elements.searchInput.select();
                    }
                    break;
            }
        }

        // Arrow key navigation for work items
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const cards = document.querySelectorAll('.work-item-card');
            const focused = document.querySelector('.work-item-card:focus');
            if (cards.length > 0) {
                e.preventDefault();
                let index = focused ? Array.from(cards).indexOf(focused) : -1;
                if (e.key === 'ArrowDown') {
                    index = Math.min(index + 1, cards.length - 1);
                } else {
                    index = Math.max(index - 1, 0);
                }
                cards[index].focus();
            }
        }
    }

    function handleStatusBadgeClick(badge) {
        const state = badge.getAttribute('data-state');

        // Clear all exclude checkboxes
        if (elements.excludeDone) elements.excludeDone.checked = false;
        if (elements.excludeClosed) elements.excludeClosed.checked = false;
        if (elements.excludeRemoved) elements.excludeRemoved.checked = false;
        if (elements.excludeInReview) elements.excludeInReview.checked = false;

        // Filter to show only this state
        const filters = {
            sprint: elements.sprintFilter ? elements.sprintFilter.value : 'All',
            includeState: state,
            excludeStates: [],
            type: elements.typeFilter ? elements.typeFilter.value : 'All',
            assignedTo: elements.assignedToFilter ? elements.assignedToFilter.value : 'All'
        };

        vscode.postMessage({ type: 'filter', filters });
    }

    function performSearch() {
        const query = elements.searchInput ? elements.searchInput.value.trim() : '';
        if (query) {
            vscode.postMessage({ type: 'search', query });
        }
    }

    function clearSearch() {
        if (elements.searchInput) {
            elements.searchInput.value = '';
            const clearBtn = document.querySelector('[data-action="clearSearch"]');
            if (clearBtn) clearBtn.style.display = 'none';
        }
        renderWorkItems(workItems, currentView === 'kanban');
    }

    function applyFilters() {
        const excludeStates = [];
        if (elements.excludeDone && elements.excludeDone.checked) excludeStates.push('Done');
        if (elements.excludeClosed && elements.excludeClosed.checked) excludeStates.push('Closed');
        if (elements.excludeRemoved && elements.excludeRemoved.checked) excludeStates.push('Removed');
        if (elements.excludeInReview && elements.excludeInReview.checked) excludeStates.push('In Review');

        const filters = {
            sprint: elements.sprintFilter ? elements.sprintFilter.value : 'All',
            excludeStates: excludeStates,
            type: elements.typeFilter ? elements.typeFilter.value : 'All',
            assignedTo: elements.assignedToFilter ? elements.assignedToFilter.value : 'All'
        };

        vscode.postMessage({ type: 'filter', filters });
    }

    function selectWorkItem(id) {
        vscode.postMessage({ type: 'selectWorkItem', id });
    }

    // Fuzzy search with highlighting
    function filterWorkItemsLocally(query) {
        const lowerQuery = query.toLowerCase();
        const filtered = workItems.filter(item => {
            const title = (item.fields['System.Title'] || '').toLowerCase();
            const id = String(item.fields['System.Id'] || '');
            const type = (item.fields['System.WorkItemType'] || '').toLowerCase();
            const tags = (item.fields['System.Tags'] || '').toLowerCase();

            return title.includes(lowerQuery) ||
                   id.includes(lowerQuery) ||
                   type.includes(lowerQuery) ||
                   tags.includes(lowerQuery);
        });

        renderWorkItems(filtered, currentView === 'kanban', query);
    }

    // Render functions
    function renderWorkItems(items, isKanban = false, highlightQuery = '') {
        if (!elements.content) return;

        if (items.length === 0) {
            elements.content.innerHTML = `
                <div class="empty-state" role="status" aria-live="polite">
                    <div class="empty-icon">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
                            <rect x="9" y="3" width="6" height="4" rx="1"/>
                            <line x1="12" y1="11" x2="12" y2="17"/>
                            <line x1="9" y1="14" x2="15" y2="14"/>
                        </svg>
                    </div>
                    <p>No work items found</p>
                </div>
            `;
            return;
        }

        if (isKanban) {
            renderKanbanView(items, highlightQuery);
        } else {
            renderListView(items, highlightQuery);
        }
    }

    function renderListView(items, highlightQuery = '') {
        const html = `
            <ul class="work-items-list" role="list" aria-label="Work items">
                ${items.map(item => renderWorkItemCard(item, false, highlightQuery)).join('')}
            </ul>
        `;
        elements.content.innerHTML = html;
    }

    function renderKanbanView(items, highlightQuery = '') {
        const columns = {
            'New': [],
            'Active': [],
            'Resolved': [],
            'Closed': []
        };

        items.forEach(item => {
            const state = item.fields['System.State'];
            if (columns[state]) {
                columns[state].push(item);
            }
        });

        let html = '<div class="kanban-board" role="region" aria-label="Kanban board">';
        for (const [state, stateItems] of Object.entries(columns)) {
            html += `
                <div class="kanban-column" role="group" aria-label="${state} column">
                    <div class="kanban-header">
                        <span class="kanban-title">${state}</span>
                        <span class="kanban-count">${stateItems.length}</span>
                    </div>
                    <ul class="kanban-items" role="list">
                        ${stateItems.map(item => renderWorkItemCard(item, true, highlightQuery)).join('')}
                    </ul>
                </div>
            `;
        }
        html += '</div>';
        elements.content.innerHTML = html;
    }

    function renderWorkItemCard(item, compact = false, highlightQuery = '') {
        const id = item.fields['System.Id'];
        const title = item.fields['System.Title'] || 'Untitled';
        const type = item.fields['System.WorkItemType'] || 'Unknown';
        const state = item.fields['System.State'] || 'Unknown';
        const assignedTo = item.fields['System.AssignedTo']?.displayName || 'Unassigned';
        const priority = item.fields['Microsoft.VSTS.Common.Priority'] || 99;
        const tags = item.fields['System.Tags'] ? item.fields['System.Tags'].split(';').map(t => t.trim()).filter(Boolean) : [];

        if (!id) {
            console.error('Work item missing System.Id:', item);
            return '<li class="work-item-card error" role="listitem">Error: Work item missing ID</li>';
        }

        const typeIcon = getWorkItemTypeIcon(type);
        const typeClass = type.toLowerCase().replace(/\s+/g, '-');
        const stateClass = state.toLowerCase().replace(/\s+/g, '-');
        const priorityClass = getPriorityClass(priority);
        const isActive = currentTimer && currentTimer.workItemId === id;

        // Highlight search matches
        const displayTitle = highlightQuery ? highlightText(title, highlightQuery) : escapeHtml(title);
        const displayId = highlightQuery ? highlightText(String(id), highlightQuery) : id;

        return `
            <li class="work-item-card ${compact ? 'compact' : ''} ${isActive ? 'active-timer' : ''}"
                data-action="selectWorkItem"
                data-id="${id}"
                role="listitem"
                tabindex="0"
                aria-label="${type} ${id}: ${title}">
                <div class="work-item-header">
                    <span class="work-item-id" aria-label="ID">#${displayId}</span>
                    <span class="work-item-type ${typeClass}" aria-label="Type">
                        ${typeIcon}
                        <span class="type-label">${type}</span>
                    </span>
                    <span class="work-item-priority ${priorityClass}" aria-label="Priority ${priority}">P${priority}</span>
                    ${isActive ? '<span class="timer-indicator" aria-label="Timer active"><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10"/></svg> Active</span>' : ''}
                </div>
                <div class="work-item-title">${displayTitle}</div>
                <div class="work-item-meta">
                    <span class="work-item-state state-${stateClass}" aria-label="State">${state}</span>
                    <span class="work-item-assignee" aria-label="Assigned to">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="7" r="4"/>
                            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
                        </svg>
                        ${escapeHtml(assignedTo)}
                    </span>
                    <button class="status-quick-change" data-action="updateStatus" data-id="${id}" aria-label="Change status">
                        Change
                    </button>
                </div>
                ${tags.length > 0 ? `
                    <div class="work-item-tags" role="list" aria-label="Tags">
                        ${tags.map(tag => `<span class="tag" role="listitem">${escapeHtml(tag)}</span>`).join('')}
                    </div>
                ` : ''}
                <div class="work-item-actions" role="toolbar" aria-label="Actions">
                    <button data-action="startTimer" data-id="${id}" aria-label="Start timer" title="Start Timer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </button>
                    <button data-action="createBranch" data-id="${id}" aria-label="Create branch" title="Create Branch">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="6" y1="3" x2="6" y2="15"/>
                            <circle cx="18" cy="6" r="3"/>
                            <circle cx="6" cy="18" r="3"/>
                            <path d="M18 9a9 9 0 01-9 9"/>
                        </svg>
                    </button>
                    <button data-action="openInBrowser" data-id="${id}" aria-label="Open in browser" title="Open in Browser">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                            <polyline points="15 3 21 3 21 9"/>
                            <line x1="10" y1="14" x2="21" y2="3"/>
                        </svg>
                    </button>
                    <button data-action="copyId" data-id="${id}" aria-label="Copy ID" title="Copy ID">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2"/>
                            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                        </svg>
                    </button>
                </div>
            </li>
        `;
    }

    function getWorkItemTypeIcon(type) {
        const icons = {
            'Task': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/></svg>',
            'Bug': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="6" width="8" height="14" rx="4"/><path d="M19 10h2m-2 4h2M3 10h2m-2 4h2m4-10V2m4 2V2"/></svg>',
            'User Story': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>',
            'Feature': '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
            'Epic': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 00-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 012-3.95A12.88 12.88 0 0122 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 01-4 2z"/></svg>',
            'Issue': '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
        };
        return icons[type] || '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/></svg>';
    }

    function getPriorityClass(priority) {
        if (priority <= 1) return 'priority-critical';
        if (priority <= 2) return 'priority-high';
        if (priority <= 3) return 'priority-medium';
        return 'priority-low';
    }

    function highlightText(text, query) {
        if (!query) return escapeHtml(text);
        const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedQuery})`, 'gi');
        return escapeHtml(text).replace(regex, '<mark class="highlight">$1</mark>');
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    function updateTimer(timer) {
        if (!elements.timerContainer) return;

        if (timer) {
            currentTimer = timer;
            elements.timerContainer.style.display = 'block';
            elements.timerContainer.setAttribute('aria-hidden', 'false');

            const hours = Math.floor(timer.elapsedSeconds / 3600);
            const minutes = Math.floor((timer.elapsedSeconds % 3600) / 60);
            const seconds = timer.elapsedSeconds % 60;

            if (elements.timerDisplay) {
                elements.timerDisplay.textContent =
                    `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
            }

            if (elements.timerTask) {
                elements.timerTask.textContent = `#${timer.workItemId} - ${timer.workItemTitle}`;
            }

            const pauseButton = elements.timerContainer.querySelector('[data-action="pauseTimer"], [data-action="resumeTimer"]');
            if (pauseButton) {
                if (timer.isPaused) {
                    elements.timerDisplay.classList.add('paused');
                    pauseButton.textContent = 'Resume';
                    pauseButton.setAttribute('data-action', 'resumeTimer');
                    pauseButton.setAttribute('aria-label', 'Resume timer');
                } else {
                    elements.timerDisplay.classList.remove('paused');
                    pauseButton.textContent = 'Pause';
                    pauseButton.setAttribute('data-action', 'pauseTimer');
                    pauseButton.setAttribute('aria-label', 'Pause timer');
                }
            }

            // Re-render work items to update active state
            if (workItems.length > 0) {
                renderWorkItems(workItems, currentView === 'kanban');
            }
        } else {
            currentTimer = null;
            elements.timerContainer.style.display = 'none';
            elements.timerContainer.setAttribute('aria-hidden', 'true');
        }
    }

    function updateStatusOverview(items) {
        if (!elements.statusOverview) return;

        const statusCounts = {};
        items.forEach(item => {
            const state = item.fields['System.State'];
            statusCounts[state] = (statusCounts[state] || 0) + 1;
        });

        const total = items.length;

        let html = '<div class="status-badges" role="group" aria-label="Status overview">';
        for (const [state, count] of Object.entries(statusCounts)) {
            const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
            const escapedState = escapeHtml(state);
            const stateClass = state.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
            html += `
                <button class="status-badge state-${stateClass}"
                        data-state="${escapedState}"
                        role="button"
                        aria-label="${escapedState}: ${count} items (${percentage}%)">
                    <span class="status-name">${escapedState}</span>
                    <span class="status-count">${count}</span>
                    <span class="status-percentage">${percentage}%</span>
                </button>
            `;
        }
        html += `
            <div class="status-badge total" aria-label="Total: ${total} items">
                <span class="status-name">Total</span>
                <span class="status-count">${total}</span>
            </div>
        `;
        html += '</div>';
        elements.statusOverview.innerHTML = html;
    }

    function updateSprintFilter(sprints, currentSprint) {
        if (!elements.sprintFilter) return;

        // Clear existing options safely
        elements.sprintFilter.innerHTML = '';

        const allOption = document.createElement('option');
        allOption.value = 'All';
        allOption.textContent = 'All Sprints';
        elements.sprintFilter.appendChild(allOption);

        if (currentSprint) {
            const currentOption = document.createElement('option');
            currentOption.value = '@CurrentIteration';
            currentOption.textContent = `Current Sprint (${currentSprint.name})`;
            elements.sprintFilter.appendChild(currentOption);
        }

        sprints.forEach(sprint => {
            const option = document.createElement('option');
            option.value = sprint.path;
            option.textContent = sprint.name;
            if (sprint.id === currentSprint?.id) {
                option.textContent += ' (Current)';
            }
            elements.sprintFilter.appendChild(option);
        });
    }

    function restoreFilters(filters) {
        if (!filters) return;

        if (filters.sprint && elements.sprintFilter) elements.sprintFilter.value = filters.sprint;
        if (filters.type && elements.typeFilter) elements.typeFilter.value = filters.type;
        if (filters.assignedTo && elements.assignedToFilter) elements.assignedToFilter.value = filters.assignedTo;

        if (filters.excludeStates) {
            if (elements.excludeDone) elements.excludeDone.checked = filters.excludeStates.includes('Done');
            if (elements.excludeClosed) elements.excludeClosed.checked = filters.excludeStates.includes('Closed');
            if (elements.excludeRemoved) elements.excludeRemoved.checked = filters.excludeStates.includes('Removed');
            if (elements.excludeInReview) elements.excludeInReview.checked = filters.excludeStates.includes('In Review');
        }

        applyFilters();
    }

    function showError(message) {
        if (!elements.content) return;
        elements.content.innerHTML = `
            <div class="error-message" role="alert">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                <span>${escapeHtml(message)}</span>
            </div>
        `;
    }

    function showTimeReportView(reportData, period) {
        if (!elements.content) return;

        let totalTime = 0;
        const reportHtml = reportData.map(item => {
            totalTime += item.total;
            const hours = (item.total / 3600).toFixed(2);
            const workItem = item.workItem;

            return `
                <div class="time-report-item">
                    <div class="time-report-header">
                        <span class="work-item-id">#${item.workItemId}</span>
                        <span class="time-duration">${hours} hours</span>
                    </div>
                    <div class="work-item-title">${workItem ? escapeHtml(workItem.fields['System.Title']) : 'Work item not found'}</div>
                    <div class="time-entries">
                        ${item.entries.map(entry => {
                            const date = new Date(entry.startTime).toLocaleDateString();
                            const duration = (entry.duration / 3600).toFixed(2);
                            return `<div class="time-entry">${date}: ${duration} hours</div>`;
                        }).join('')}
                    </div>
                </div>
            `;
        }).join('');

        const totalHours = (totalTime / 3600).toFixed(2);

        elements.content.innerHTML = `
            <div class="time-report" role="region" aria-label="Time report">
                <div class="time-report-summary">
                    <h3>Time Report - ${period}</h3>
                    <div class="total-time">${totalHours} hours</div>
                </div>
                ${reportHtml}
            </div>
        `;
    }

    function showLoading() {
        if (!elements.content) return;
        elements.content.innerHTML = `
            <div class="loading-skeleton" role="status" aria-label="Loading">
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
                <div class="skeleton-card"></div>
                <span class="visually-hidden">Loading work items...</span>
            </div>
        `;
    }

    function requestInitialData() {
        vscode.postMessage({ type: 'refresh' });
        vscode.postMessage({ type: 'loadSprints' });
    }

    // Message handler
    window.addEventListener('message', event => {
        const message = event.data;

        switch (message.type) {
            case 'workItemsLoaded':
                workItems = message.workItems;
                renderWorkItems(workItems, message.kanbanView);
                updateStatusOverview(workItems);
                break;

            case 'sprintsLoaded':
                updateSprintFilter(message.sprints, message.currentSprint);
                break;

            case 'timerUpdate':
                currentTimer = message.timer;
                updateTimer(currentTimer);
                break;

            case 'error':
                showError(message.message);
                break;

            case 'showTimeReport':
                showTimeReportView(message.reportData, message.period);
                break;

            case 'showDetails':
                // TODO: Implement detailed view
                break;

            case 'restoreFilters':
                restoreFilters(message.filters);
                break;

            case 'loading':
                showLoading();
                break;
        }
    });
})();
