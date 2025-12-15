import * as vscode from 'vscode';
import axios, { AxiosInstance } from 'axios';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

// Interfaces
interface WorkItem {
    id: number;
    rev: number;
    fields: {
        'System.Id': number;
        'System.Title': string;
        'System.State': string;
        'System.WorkItemType': string;
        'System.AssignedTo'?: {
            displayName: string;
            uniqueName: string;
        };
        'System.CreatedDate': string;
        'System.ChangedDate': string;
        'System.IterationPath'?: string;
        'System.AreaPath'?: string;
        'System.Tags'?: string;
        'System.Description'?: string;
        'Microsoft.VSTS.Common.Priority'?: number;
        'Microsoft.VSTS.Scheduling.Effort'?: number;
        'Microsoft.VSTS.Scheduling.RemainingWork'?: number;
        'Microsoft.VSTS.Scheduling.CompletedWork'?: number;
    };
    url: string;
    _links: any;
}

interface PullRequest {
    pullRequestId: number;
    title: string;
    description: string;
    status: string;
    createdBy: {
        displayName: string;
        uniqueName: string;
    };
    creationDate: string;
    sourceRefName: string;
    targetRefName: string;
    reviewers: any[];
}

interface BuildDefinition {
    id: number;
    name: string;
    path: string;
    type: string;
    revision: number;
}

interface Build {
    id: number;
    buildNumber: string;
    status: string;
    result: string;
    startTime: string;
    finishTime?: string;
    definition: BuildDefinition;
}

interface TimerState {
    workItemId: number;
    workItemTitle: string;
    startTime: number;
    pausedTime?: number;
    elapsedSeconds: number;
    isPaused: boolean;
    isPomodoro?: boolean;
    pomodoroCount?: number;
    pausedDueToInactivity?: boolean;
}

interface TimeEntry {
    id: string;
    workItemId: number;
    workItemTitle?: string;
    startTime: number;
    endTime: number;
    duration: number;
    description?: string;
    synced: boolean;
    syncError?: string;
    deviceId?: string;
}

// Global state
let azureDevOpsAPI: AzureDevOpsAPI | undefined;
let currentTimer: TimerState | undefined;
let timerInterval: NodeJS.Timeout | undefined;
let inactivityTimer: NodeJS.Timeout | undefined;
let statusBarItem: vscode.StatusBarItem;
let buildStatusBarItem: vscode.StatusBarItem;
let webviewProvider: AzureDevOpsViewProvider | undefined;
let lastActivity: number = Date.now();
let lastActivityResumeTime: number = 0;
let timeEntries: TimeEntry[] = [];
let recentWorkItems: WorkItem[] = [];
let context: vscode.ExtensionContext;

// Resource cleanup tracking
let buildMonitoringInterval: NodeJS.Timeout | undefined;
let autoRefreshInterval: NodeJS.Timeout | undefined;
let pomodoroBreakTimeout: NodeJS.Timeout | undefined;

// Error handling utilities
function handleError(error: any, context: string, showUser: boolean = true): void {
    const errorMessage = error?.response?.data?.message || error?.message || 'Unknown error occurred';
    const statusCode = error?.response?.status;
    
    console.error(`[${context}] Error:`, error);
    
    // Log additional debug information for troubleshooting
    if (error.config) {
        console.error(`[${context}] Request config:`, {
            url: error.config.url,
            baseURL: error.config.baseURL,
            method: error.config.method,
            headers: error.config.headers ? { 
                'Authorization': error.config.headers.Authorization ? '[REDACTED]' : undefined,
                'Content-Type': error.config.headers['Content-Type']
            } : undefined
        });
    }
    
    if (error.response) {
        console.error(`[${context}] Response data:`, error.response.data);
        console.error(`[${context}] Response status:`, error.response.status);
    }
    
    if (showUser) {
        let userMessage = '';
        const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
        const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
        
        switch (statusCode) {
            case 400:
                userMessage = `Bad Request: ${error.response?.data?.message || 'Invalid request format. Please check your organization and project names for special characters.'}`;
                break;
            case 401:
                userMessage = 'Authentication failed. Please check your Personal Access Token and ensure it hasn\'t expired.';
                vscode.commands.executeCommand('azureDevOps.setup');
                break;
            case 403:
                userMessage = 'Access denied. Please ensure your PAT has the required permissions:\n• Work Items (Read & Write)\n• Code (Read & Write)\n• Build (Read)\n• Pull Request (Read & Write)';
                break;
            case 404:
                userMessage = `Resource not found. Please verify:\n• Organization: "${org}"\n• Project: "${project}"\n• Names are spelled correctly and accessible`;
                break;
            case 500:
            case 502:
            case 503:
            case 504:
                userMessage = `Azure DevOps server error (${statusCode}). This is usually temporary - please try again in a few moments.`;
                break;
            default:
                userMessage = errorMessage;
        }
        
        vscode.window.showErrorMessage(`Azure DevOps ${context}: ${userMessage}`);
    }
    
}

async function withErrorHandling<T>(
    operation: () => Promise<T>,
    context: string,
    defaultValue?: T
): Promise<T | undefined> {
    try {
        return await operation();
    } catch (error) {
        handleError(error, context);
        return defaultValue;
    }
}

// Simple in-memory cache for API responses
class SimpleCache<T> {
    private cache = new Map<string, { data: T; timestamp: number }>();
    private ttl: number;

    constructor(ttlSeconds: number = 300) { // Default 5 minutes
        this.ttl = ttlSeconds * 1000;
    }

    set(key: string, data: T): void {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }

    get(key: string): T | undefined {
        const item = this.cache.get(key);
        if (!item) return undefined;

        if (Date.now() - item.timestamp > this.ttl) {
            this.cache.delete(key);
            return undefined;
        }

        return item.data;
    }

    clear(): void {
        this.cache.clear();
    }

    delete(key: string): void {
        this.cache.delete(key);
    }
}

// Cache instances
const workItemCache = new SimpleCache<WorkItem[]>(300); // 5 minutes
const iterationCache = new SimpleCache<any[]>(600); // 10 minutes
const repositoryCache = new SimpleCache<any[]>(900); // 15 minutes


// Rate limiting and retry utilities
class RateLimiter {
    private lastRequestTime = 0;
    private minInterval = 100; // Minimum 100ms between requests
    private retryDelays = [1000, 2000, 5000]; // Exponential backoff delays

    async throttle(): Promise<void> {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minInterval - timeSinceLastRequest));
        }
        this.lastRequestTime = Date.now();
    }

    async withRetry<T>(fn: () => Promise<T>, context: string): Promise<T> {
        let lastError: any;
        for (let attempt = 0; attempt < this.retryDelays.length + 1; attempt++) {
            try {
                // Only throttle on first attempt, not retries (retries already have backoff delay)
                if (attempt === 0) {
                    await this.throttle();
                }
                return await fn();
            } catch (error: any) {
                lastError = error;
                const status = error.response?.status;

                // Don't retry on client errors (except 429 rate limit)
                if (status && status >= 400 && status < 500 && status !== 429) {
                    throw error;
                }

                // If we've exhausted retries, throw
                if (attempt >= this.retryDelays.length) {
                    throw error;
                }

                const delay = this.retryDelays[attempt];
                console.warn(`[${context}] Request failed (attempt ${attempt + 1}/${this.retryDelays.length + 1}), retrying in ${delay}ms...`, error.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }
}

// Azure DevOps API class
class AzureDevOpsAPI {
    private axios: AxiosInstance;
    private organization: string;
    private project: string;
    private encodedOrganization: string;
    private encodedProject: string;
    private currentUserId?: string;
    private rateLimiter = new RateLimiter();

    constructor(organization: string, project: string, token: string) {
        // Validate and sanitize inputs
        if (!organization?.trim()) {
            throw new Error('Organization name is required');
        }
        if (!project?.trim()) {
            throw new Error('Project name is required');
        }
        if (!token?.trim()) {
            throw new Error('Personal Access Token is required');
        }

        this.organization = organization.trim();
        this.project = project.trim();
        
        // Properly encode organization and project names for URLs
        this.encodedOrganization = encodeURIComponent(this.organization);
        this.encodedProject = encodeURIComponent(this.project);
        
        const auth = Buffer.from(`:${token}`).toString('base64');
        
        // Azure DevOps API structure: https://dev.azure.com/{organization}/{project}/_apis
        // Use properly encoded names for URL construction
        this.axios = axios.create({
            baseURL: `https://dev.azure.com/${this.encodedOrganization}/${this.encodedProject}/_apis`,
            headers: {
                'Authorization': `Basic ${auth}`,
                'Content-Type': 'application/json'
            },
            params: {
                'api-version': '7.0'
            },
            timeout: 30000, // 30 second timeout
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        });
    }

    private buildFullUrl(path: string): string {
        return `https://dev.azure.com/${this.encodedOrganization}/${this.encodedProject}/_apis${path}`;
    }

    getBrowserUrl(path: string): string {
        return `https://dev.azure.com/${this.encodedOrganization}/${this.encodedProject}${path}`;
    }

    // Work Items
    async getWorkItems(query: string): Promise<WorkItem[]> {
        return this.rateLimiter.withRetry(async () => {
            const wiql = this.buildWIQL(query);
            console.log('Fetching work items with query:', wiql);
            console.log('API Base URL:', this.axios.defaults.baseURL);

            const queryResult = await this.axios.post('/wit/wiql', { query: wiql });

            if (!queryResult.data.workItems || queryResult.data.workItems.length === 0) {
                return [];
            }

            const ids = queryResult.data.workItems.map((wi: any) => wi.id).join(',');
            const workItemsResult = await this.axios.get(`/wit/workitems?ids=${ids}&$expand=all`);

            // Filter out work items without valid System.Id
            const validWorkItems = workItemsResult.data.value.filter((workItem: WorkItem) => {
                const hasValidId = workItem.fields && workItem.fields['System.Id'] !== undefined && workItem.fields['System.Id'] !== null;
                if (!hasValidId) {
                    console.warn('Work item missing System.Id field:', workItem);
                }
                return hasValidId;
            });

            return validWorkItems;
        }, 'getWorkItems');
    }

    async getWorkItemById(id: number): Promise<WorkItem | null> {
        return this.rateLimiter.withRetry(async () => {
            const result = await this.axios.get(`/wit/workitems/${id}?$expand=all&api-version=7.1`);
            return result.data;
        }, 'getWorkItemById').catch(error => {
            console.error(`Error fetching work item ${id}:`, error);
            return null;
        });
    }

    private buildWIQL(queryType: string): string {
        const baseFields = `[System.Id], [System.Title], [System.State], [System.WorkItemType], 
                           [System.AssignedTo], [System.CreatedDate], [System.ChangedDate],
                           [System.IterationPath], [System.Tags], [Microsoft.VSTS.Common.Priority]`;
        
        // Get selected sprint filter
        const selectedSprint = context.globalState.get<string>('selectedSprint');
        const sprintFilter = selectedSprint ? `AND [System.IterationPath] = '${selectedSprint}'` : '';
        
        switch (queryType) {
            case 'My Work Items':
                return `SELECT ${baseFields} FROM WorkItems 
                        WHERE [System.AssignedTo] = @Me 
                        AND [System.State] <> 'Closed' 
                        AND [System.State] <> 'Removed'
                        ${sprintFilter}
                        ORDER BY [System.ChangedDate] DESC`;
            
            case 'Current Sprint':
                // If a specific sprint is selected, use that instead of current
                if (selectedSprint) {
                    return `SELECT ${baseFields} FROM WorkItems 
                            WHERE [System.IterationPath] = '${selectedSprint}'
                            AND [System.State] <> 'Closed' 
                            AND [System.State] <> 'Removed'
                            ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC`;
                }
                return `SELECT ${baseFields} FROM WorkItems 
                        WHERE [System.IterationPath] UNDER @CurrentIteration 
                        AND [System.State] <> 'Closed' 
                        AND [System.State] <> 'Removed'
                        ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC`;
            
            case 'All Active':
                return `SELECT ${baseFields} FROM WorkItems 
                        WHERE [System.State] <> 'Closed' 
                        AND [System.State] <> 'Removed'
                        AND [System.State] <> 'Done'
                        ${sprintFilter}
                        ORDER BY [System.ChangedDate] DESC`;
            
            case 'Recently Updated':
                return `SELECT ${baseFields} FROM WorkItems 
                        WHERE [System.ChangedDate] >= @Today - 7
                        ${sprintFilter}
                        ORDER BY [System.ChangedDate] DESC`;
            
            default:
                return queryType; // Custom WIQL
        }
    }

    async createWorkItem(type: string, title: string, description?: string, assignedTo?: string): Promise<WorkItem> {
        const updates = [
            {
                op: 'add',
                path: '/fields/System.Title',
                value: title
            }
        ];

        if (description) {
            updates.push({
                op: 'add',
                path: '/fields/System.Description',
                value: description
            });
        }

        if (assignedTo) {
            updates.push({
                op: 'add',
                path: '/fields/System.AssignedTo',
                value: assignedTo
            });
        }

        const result = await this.axios.post(
            `/wit/workitems/$${type}?api-version=7.0`,
            updates,
            {
                headers: {
                    'Content-Type': 'application/json-patch+json'
                }
            }
        );

        return result.data;
    }

    async updateWorkItem(id: number, updates: any[]): Promise<WorkItem> {
        const result = await this.axios.patch(
            `/wit/workitems/${id}?api-version=7.1`,
            updates,
            {
                headers: {
                    'Content-Type': 'application/json-patch+json'
                }
            }
        );

        return result.data;
    }

    async addWorkItemComment(id: number, text: string): Promise<void> {
        await this.axios.post(
            `/wit/workitems/${id}/comments?api-version=7.0-preview.3`,
            { text }
        );
    }


    async createPullRequest(
        repositoryId: string,
        sourceBranch: string,
        targetBranch: string,
        title: string,
        description: string,
        workItemIds?: number[]
    ): Promise<PullRequest> {
        const pullRequest = {
            sourceRefName: `refs/heads/${sourceBranch}`,
            targetRefName: `refs/heads/${targetBranch}`,
            title,
            description
        };

        const result = await this.axios.post(
            this.buildFullUrl(`/git/repositories/${repositoryId}/pullrequests`),
            pullRequest
        );

        // Link work items if provided
        if (workItemIds && workItemIds.length > 0) {
            for (const workItemId of workItemIds) {
                await this.linkWorkItemToPullRequest(result.data.pullRequestId, workItemId, repositoryId);
            }
        }

        return result.data;
    }

    private async linkWorkItemToPullRequest(pullRequestId: number, workItemId: number, repositoryId: string): Promise<void> {
        const update = [
            {
                op: 'add',
                path: '/relations/-',
                value: {
                    rel: 'ArtifactLink',
                    url: `vstfs:///Git/PullRequestId/${this.project}%2F${repositoryId}%2F${pullRequestId}`,
                    attributes: {
                        name: 'Pull Request'
                    }
                }
            }
        ];

        await this.updateWorkItem(workItemId, update);
    }

    // Builds
    async getBuildDefinitions(): Promise<BuildDefinition[]> {
        const result = await this.axios.get(
            this.buildFullUrl('/build/definitions')
        );
        return result.data.value;
    }

    async getBuilds(definitionId?: number, top: number = 10): Promise<Build[]> {
        let path = `/build/builds?$top=${top}`;
        
        if (definitionId) {
            path += `&definitions=${definitionId}`;
        }

        const result = await this.axios.get(path);
        return result.data.value;
    }

    // Iterations/Sprints
    async getIterations(): Promise<any[]> {
        try {
            const result = await this.axios.get(
                `/work/teamsettings/iterations?api-version=7.0`
            );
            return result.data.value || [];
        } catch (error) {
            console.error('Error fetching iterations:', error);
            return [];
        }
    }

    async getCurrentIteration(): Promise<any> {
        try {
            const result = await this.axios.get(
                `/work/teamsettings/iterations?$timeframe=current&api-version=7.0`
            );
            return result.data.value?.[0];
        } catch (error) {
            console.error('Error fetching current iteration:', error);
            return null;
        }
    }

    // Git
    async getRepositories(): Promise<any[]> {
        const result = await this.axios.get(
            this.buildFullUrl('/git/repositories')
        );
        return result.data.value;
    }

    // Time tracking - increments CompletedWork
    async addTimeEntry(workItemId: number, hours: number, comment?: string): Promise<void> {
        const workItem = await this.getWorkItemById(workItemId);
        if (!workItem?.fields) {
            throw new Error(`Failed to fetch work item ${workItemId} or work item has no fields`);
        }
        const currentCompletedWork = workItem.fields['Microsoft.VSTS.Scheduling.CompletedWork'] || 0;
        const newCompletedWork = currentCompletedWork + hours;

        const updates = [
            {
                op: 'add',
                path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork',
                value: newCompletedWork
            }
        ];

        if (comment) {
            await this.addWorkItemComment(workItemId, `Time tracked: ${hours} hours (Total: ${newCompletedWork.toFixed(2)} hours). ${comment}`);
        }

        await this.updateWorkItem(workItemId, updates);
    }

    // Pull Request Management
    async getMyPullRequests(status: string = 'active'): Promise<PullRequest[]> {
        const result = await this.axios.get(
            this.buildFullUrl(`/git/pullrequests?searchCriteria.creatorId=me&searchCriteria.status=${status}`)
        );
        return result.data.value;
    }

    async getAllPullRequests(status: string = 'active'): Promise<PullRequest[]> {
        const repositories = await this.getRepositories();
        const allPRs: PullRequest[] = [];
        
        for (const repo of repositories) {
            try {
                const result = await this.axios.get(
                    `/git/repositories/${repo.id}/pullrequests?searchCriteria.status=${status}`
                );
                allPRs.push(...result.data.value);
            } catch (error) {
                console.error(`Error fetching PRs for repo ${repo.name}:`, error);
            }
        }
        
        return allPRs;
    }

    async getPullRequestDetails(pullRequestId: number, repositoryId: string): Promise<any> {
        const result = await this.axios.get(
            `/git/repositories/${repositoryId}/pullrequests/${pullRequestId}`
        );
        return result.data;
    }

    async getPullRequestWorkItems(pullRequestId: number, repositoryId: string): Promise<WorkItem[]> {
        const result = await this.axios.get(
            `/git/repositories/${repositoryId}/pullrequests/${pullRequestId}/workitems`
        );
        return result.data.value;
    }

    async getPullRequestComments(pullRequestId: number, repositoryId: string): Promise<any[]> {
        const result = await this.axios.get(
            `/git/repositories/${repositoryId}/pullrequests/${pullRequestId}/threads`
        );
        return result.data.value;
    }

    async addPullRequestComment(pullRequestId: number, repositoryId: string, comment: string): Promise<void> {
        await this.axios.post(
            `/git/repositories/${repositoryId}/pullrequests/${pullRequestId}/threads`,
            {
                comments: [{
                    content: comment,
                    commentType: 1
                }],
                status: 1
            }
        );
    }

    async approvePullRequest(pullRequestId: number, repositoryId: string): Promise<void> {
        const userId = await this.getCurrentUserId();
        await this.axios.put(
            `/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests/${pullRequestId}/reviewers/${userId}?api-version=7.0`,
            {
                vote: 10 // 10 = approved
            }
        );
    }

    async completePullRequest(pullRequestId: number, repositoryId: string, deleteSourceBranch: boolean = false): Promise<void> {
        await this.axios.patch(
            `/${this.project}/_apis/git/repositories/${repositoryId}/pullrequests/${pullRequestId}?api-version=7.0`,
            {
                status: 'completed',
                completionOptions: {
                    deleteSourceBranch: deleteSourceBranch
                }
            }
        );
    }

    // Pipeline/Build Management
    async getPipelines(): Promise<any[]> {
        const result = await this.axios.get(
            '/pipelines'
        );
        return result.data.value;
    }

    async runPipeline(pipelineId: number, branch?: string): Promise<any> {
        const body: any = {};
        if (branch) {
            body.resources = {
                repositories: {
                    self: {
                        refName: `refs/heads/${branch}`
                    }
                }
            };
        }
        
        const result = await this.axios.post(
            `/pipelines/${pipelineId}/runs`,
            body
        );
        return result.data;
    }

    async getPipelineRuns(pipelineId: number, top: number = 10): Promise<any[]> {
        const result = await this.axios.get(
            `/pipelines/${pipelineId}/runs?$top=${top}`
        );
        return result.data.value;
    }

    async getPipelineRunLogs(pipelineId: number, runId: number): Promise<string> {
        const result = await this.axios.get(
            `/pipelines/${pipelineId}/runs/${runId}/logs`
        );
        
        const logs = result.data.logs;
        let fullLog = '';
        
        for (const log of logs) {
            const logResult = await this.axios.get(log.url);
            fullLog += logResult.data + '\n';
        }
        
        return fullLog;
    }

    // Test Plans and Test Cases
    async getTestPlans(): Promise<any[]> {
        const result = await this.axios.get(
            '/testplan/plans'
        );
        return result.data.value;
    }

    async getTestSuites(planId: number): Promise<any[]> {
        const result = await this.axios.get(
            `/testplan/plans/${planId}/suites`
        );
        return result.data.value;
    }

    async getTestCases(planId: number, suiteId: number): Promise<any[]> {
        const result = await this.axios.get(
            `/testplan/plans/${planId}/suites/${suiteId}/testcases`
        );
        return result.data.value;
    }

    // Wiki/Documentation
    async getWikis(): Promise<any[]> {
        const result = await this.axios.get(
            '/wiki/wikis'
        );
        return result.data.value;
    }

    async getWikiPages(wikiId: string): Promise<any[]> {
        const result = await this.axios.get(
            `/wiki/wikis/${wikiId}/pages?recursionLevel=full`
        );
        return result.data.value;
    }

    async getWikiPageContent(wikiId: string, pagePath: string): Promise<string> {
        const result = await this.axios.get(
            `/wiki/wikis/${wikiId}/pages?path=${encodeURIComponent(pagePath)}&includeContent=true`
        );
        return result.data.content;
    }

    async createWikiPage(wikiId: string, pagePath: string, content: string): Promise<void> {
        await this.axios.put(
            `/${this.project}/_apis/wiki/wikis/${wikiId}/pages?path=${encodeURIComponent(pagePath)}&api-version=7.0`,
            {
                content: content
            }
        );
    }

    // Team and Capacity
    async getTeamCapacity(teamId: string, iterationId: string): Promise<any[]> {
        const result = await this.axios.get(
            `/${this.encodedProject}/${teamId}/_apis/work/teamsettings/iterations/${iterationId}/capacities`
        );
        return result.data.value;
    }

    async getIterationWorkItems(teamId: string, iterationId: string): Promise<any> {
        const result = await this.axios.get(
            `/${this.encodedProject}/${teamId}/_apis/work/teamsettings/iterations/${iterationId}/workitems`
        );
        return result.data;
    }

    // Notifications and Mentions
    async getNotifications(): Promise<any[]> {
        try {
            const result = await this.axios.get(
                `/_apis/notification/events?api-version=7.0`
            );
            return result.data.value;
        } catch (error) {
            console.error('Error fetching notifications:', error);
            return [];
        }
    }

    
    private async getCurrentUserId(): Promise<string> {
        if (!this.currentUserId) {
            const result = await this.axios.get('/_apis/connectiondata');
            this.currentUserId = result.data.authenticatedUser.id;
        }
        return this.currentUserId!;
    }
}

// Activation
export function activate(extensionContext: vscode.ExtensionContext) {
    context = extensionContext;
    
    console.log('Azure DevOps Code Companion is now active!');

    // Initialize status bar items
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    context.subscriptions.push(statusBarItem);
    
    // buildStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    // context.subscriptions.push(buildStatusBarItem);

    // Register all commands
    registerCommands();
    
    // Register webview provider
    webviewProvider = new AzureDevOpsViewProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('azureDevOpsWorkItems', webviewProvider)
    );
    
    // Track VS Code activity for timer auto-pause
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => updateActivity()),
        vscode.window.onDidChangeTextEditorSelection(() => updateActivity()),
        vscode.window.onDidChangeWindowState(() => updateActivity())
    );
    
    // Restore timer state
    restoreTimerState();
    
    // Load saved time entries
    loadTimeEntries();

    // Try to sync any pending time entries after a short delay (allows API to initialize)
    setTimeout(() => {
        syncPendingTimeEntries().catch(err => {
            console.error('Failed to sync pending time entries:', err);
        });
    }, 5000);

    // Set up periodic sync for pending entries (every 5 minutes)
    const pendingSyncInterval = setInterval(() => {
        syncPendingTimeEntries().catch(err => {
            console.error('Failed to sync pending time entries:', err);
        });
    }, 5 * 60 * 1000);
    context.subscriptions.push({ dispose: () => clearInterval(pendingSyncInterval) });

    // Check if setup is needed
    checkSetup();
    
    // Set up auto-refresh
    setupAutoRefresh();
    
    
    // Show welcome message for first-time users
    showWelcomeMessageIfNeeded();
    
    // Check milestones for review/support prompts
    checkMilestones();
}

export function deactivate() {
    // Save current timer state
    if (currentTimer) {
        context.globalState.update('currentTimer', currentTimer);
    }
    
    // Clear all intervals and timeouts
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = undefined;
    }
    if (inactivityTimer) {
        clearInterval(inactivityTimer);
        inactivityTimer = undefined;
    }
    if (buildMonitoringInterval) {
        clearInterval(buildMonitoringInterval);
        buildMonitoringInterval = undefined;
    }
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = undefined;
    }
    if (pomodoroBreakTimeout) {
        clearTimeout(pomodoroBreakTimeout);
        pomodoroBreakTimeout = undefined;
    }
    
    
    // Dispose of webview provider properly
    if (webviewProvider) {
        webviewProvider.dispose();
        webviewProvider = undefined;
    }
    
    // Clear API instance
    azureDevOpsAPI = undefined;
    
}

// Command registration
function registerCommands() {
    // Connection
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.setup', setupCommand)
    );
    
    // Work Items
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.showWorkItems', showWorkItemsCommand),
        vscode.commands.registerCommand('azureDevOps.createWorkItem', createWorkItemCommand),
        vscode.commands.registerCommand('azureDevOps.refreshWorkItems', refreshWorkItemsCommand),
        vscode.commands.registerCommand('azureDevOps.selectWorkItem', selectWorkItemCommand),
        vscode.commands.registerCommand('azureDevOps.copyWorkItemId', copyWorkItemIdCommand),
        vscode.commands.registerCommand('azureDevOps.viewWorkItemInBrowser', viewWorkItemInBrowserCommand),
        vscode.commands.registerCommand('azureDevOps.runQuery', runQueryCommand),
        vscode.commands.registerCommand('azureDevOps.toggleKanbanView', toggleKanbanViewCommand),
        vscode.commands.registerCommand('azureDevOps.selectSprint', selectSprintCommand),
        vscode.commands.registerCommand('azureDevOps.manageTemplates', manageTemplatesCommand),
        vscode.commands.registerCommand('azureDevOps.support', supportCommand),
        vscode.commands.registerCommand('azureDevOps.review', reviewCommand)
    );
    
    // Timer
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.startTimer', startTimerCommand),
        vscode.commands.registerCommand('azureDevOps.pauseTimer', pauseTimerCommand),
        vscode.commands.registerCommand('azureDevOps.resumeTimer', resumeTimerCommand),
        vscode.commands.registerCommand('azureDevOps.stopTimer', stopTimerCommand),
        vscode.commands.registerCommand('azureDevOps.showTimeReport', showTimeReportCommand)
    );
    
    // Git & Pull Requests
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.createBranch', createBranchCommand),
        vscode.commands.registerCommand('azureDevOps.createPullRequest', createPullRequestCommand),
        vscode.commands.registerCommand('azureDevOps.showPullRequests', showPullRequestsCommand),
        vscode.commands.registerCommand('azureDevOps.showAllPullRequests', showAllPullRequestsCommand),
        vscode.commands.registerCommand('azureDevOps.reviewPullRequest', reviewPullRequestCommand),
        vscode.commands.registerCommand('azureDevOps.linkWorkItemToCommit', linkWorkItemToCommitCommand),
        vscode.commands.registerCommand('azureDevOps.insertWorkItemReference', insertWorkItemReferenceCommand)
    );
    
    // Build
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.showBuildStatus', showBuildStatusCommand),
        vscode.commands.registerCommand('azureDevOps.showPipelines', showPipelinesCommand),
        vscode.commands.registerCommand('azureDevOps.runPipeline', runPipelineCommand)
    );
    
    // Test Management
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.showTestPlans', showTestPlansCommand)
    );
    
    // Wiki
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.showWikis', showWikisCommand)
    );
    
    // Team
    context.subscriptions.push(
        vscode.commands.registerCommand('azureDevOps.showTeamCapacity', showTeamCapacityCommand)
    );
}

// Input validation helpers
function validateOrganizationName(org: string): { isValid: boolean; error?: string } {
    if (!org || !org.trim()) {
        return { isValid: false, error: 'Organization name is required' };
    }
    
    const sanitized = org.trim();
    
    // Check for common invalid characters in Azure DevOps org names
    if (sanitized.includes('/') || sanitized.includes('\\') || sanitized.includes(':')) {
        return { isValid: false, error: 'Organization name contains invalid characters (/, \\, :)' };
    }
    
    // Check for URL patterns (users might paste full URLs)
    if (sanitized.includes('dev.azure.com') || sanitized.includes('visualstudio.com')) {
        return { isValid: false, error: 'Please enter only the organization name, not the full URL' };
    }
    
    if (sanitized.length < 2 || sanitized.length > 50) {
        return { isValid: false, error: 'Organization name must be between 2 and 50 characters' };
    }
    
    return { isValid: true };
}

function validateProjectName(project: string): { isValid: boolean; error?: string } {
    if (!project || !project.trim()) {
        return { isValid: false, error: 'Project name is required' };
    }
    
    const sanitized = project.trim();
    
    // Azure DevOps project names can contain spaces and many special characters
    // But let's check for obviously invalid patterns
    if (sanitized.includes('/') && !sanitized.includes(' ')) {
        return { isValid: false, error: 'Project name appears to contain a path. Please enter only the project name.' };
    }
    
    if (sanitized.length < 1 || sanitized.length > 64) {
        return { isValid: false, error: 'Project name must be between 1 and 64 characters' };
    }
    
    return { isValid: true };
}

function validatePAT(token: string): { isValid: boolean; error?: string } {
    if (!token || !token.trim()) {
        return { isValid: false, error: 'Personal Access Token is required' };
    }
    
    const sanitized = token.trim();
    
    // Basic PAT format validation (Azure DevOps PATs are typically 52 characters)
    if (sanitized.length < 20) {
        return { isValid: false, error: 'PAT appears to be too short. Please check you copied the complete token.' };
    }
    
    if (sanitized.length > 100) {
        return { isValid: false, error: 'PAT appears to be too long. Please check you copied only the token.' };
    }
    
    return { isValid: true };
}

// Setup command
async function setupCommand() {
    // Get organization with validation
    let org: string | undefined;
    while (!org) {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter your Azure DevOps organization name (e.g., "mycompany")',
            placeHolder: 'myorganization',
            value: vscode.workspace.getConfiguration('azureDevOps').get<string>('organization'),
            validateInput: (value) => {
                const validation = validateOrganizationName(value);
                return validation.isValid ? undefined : validation.error;
            }
        });
        if (input === undefined) return; // User cancelled
        
        const validation = validateOrganizationName(input);
        if (validation.isValid) {
            org = input.trim();
        } else {
            vscode.window.showErrorMessage(`Invalid organization name: ${validation.error}`);
        }
    }
    
    // Get project with validation
    let project: string | undefined;
    while (!project) {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter your Azure DevOps project name (e.g., "My Project")',
            placeHolder: 'myproject',
            value: vscode.workspace.getConfiguration('azureDevOps').get<string>('project'),
            validateInput: (value) => {
                const validation = validateProjectName(value);
                return validation.isValid ? undefined : validation.error;
            }
        });
        if (input === undefined) return; // User cancelled
        
        const validation = validateProjectName(input);
        if (validation.isValid) {
            project = input.trim();
        } else {
            vscode.window.showErrorMessage(`Invalid project name: ${validation.error}`);
        }
    }
    
    // Get PAT with validation
    let token: string | undefined;
    while (!token) {
        const input = await vscode.window.showInputBox({
            prompt: 'Enter your Personal Access Token (PAT) - requires Work Items, Code, Build, and Pull Request permissions',
            password: true,
            placeHolder: 'Paste your PAT here',
            ignoreFocusOut: true,
            validateInput: (value) => {
                const validation = validatePAT(value);
                return validation.isValid ? undefined : validation.error;
            }
        });
        if (input === undefined) return; // User cancelled
        
        const validation = validatePAT(input);
        if (validation.isValid) {
            token = input.trim();
        } else {
            vscode.window.showErrorMessage(`Invalid PAT: ${validation.error}`);
        }
    }
    
    // Save configuration
    await vscode.workspace.getConfiguration('azureDevOps').update('organization', org, true);
    await vscode.workspace.getConfiguration('azureDevOps').update('project', project, true);
    await context.secrets.store('azureDevOpsPAT', token);
    
    // Test connection
    try {
        console.log('Attempting to connect with:', { org, project });
        azureDevOpsAPI = new AzureDevOpsAPI(org, project, token);
        const workItems = await azureDevOpsAPI.getWorkItems('My Work Items');
        
        vscode.window.showInformationMessage(`Azure DevOps connected! Found ${workItems.length} work items.`);
        
        // Update context
        vscode.commands.executeCommand('setContext', 'azureDevOps.connected', true);
        
        // Refresh webview
        if (webviewProvider) {
            webviewProvider.refresh();
        }
        
        // Start monitoring builds
        monitorBuilds();
        
    } catch (error: any) {
        console.error('Setup failed:', error);
        const errorMessage = error.response?.status === 404 
            ? `Failed to connect: 404 Not Found. Please verify:\n- Organization: "${org}"\n- Project: "${project}"\n- PAT has correct permissions`
            : `Failed to connect: ${error.message}`;
        vscode.window.showErrorMessage(errorMessage);
    }
}

async function checkSetup() {
    const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
    const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
    const token = await context.secrets.get('azureDevOpsPAT');
    
    if (!org || !project || !token) {
        const setup = await vscode.window.showInformationMessage(
            'Azure DevOps Code Companion needs to be configured. Would you like to set it up now?',
            'Setup', 'Later'
        );
        
        if (setup === 'Setup') {
            vscode.commands.executeCommand('azureDevOps.setup');
        }
    } else {
        try {
            console.log('Setting up Azure DevOps API with:', { org, project });
            azureDevOpsAPI = new AzureDevOpsAPI(org, project, token);
            vscode.commands.executeCommand('setContext', 'azureDevOps.connected', true);
            
            // Start monitoring builds
            monitorBuilds();
        } catch (error) {
            console.error('Failed to initialize Azure DevOps API:', error);
        }
    }
}

// Work Items Commands
async function showWorkItemsCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    const queryType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultQuery') || 'My Work Items';
    const workItems = await azureDevOpsAPI.getWorkItems(queryType);
    
    if (workItems.length === 0) {
        vscode.window.showInformationMessage('No work items found');
        return;
    }
    
    const selected = await selectWorkItem(workItems);
    if (selected) {
        showWorkItemActions(selected);
    }
}

async function selectWorkItem(workItems: WorkItem[], title?: string): Promise<WorkItem | undefined> {
    const items = workItems.map(wi => ({
        label: `$(checklist) #${wi.fields['System.Id']} - ${wi.fields['System.Title']}`,
        description: `${wi.fields['System.WorkItemType']} • ${wi.fields['System.State']}`,
        detail: wi.fields['System.AssignedTo']?.displayName || 'Unassigned',
        workItem: wi
    }));
    
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: title || 'Select a work item',
        matchOnDescription: true,
        matchOnDetail: true
    });
    
    return selected?.workItem;
}

async function showWorkItemActions(workItem: WorkItem) {
    const actions = [
        { label: '$(play) Start Timer', value: 'timer' },
        { label: '$(git-branch) Create Branch', value: 'branch' },
        { label: '$(comment) Add Comment', value: 'comment' },
        { label: '$(edit) Update Status', value: 'status' },
        { label: '$(pencil) Edit Work Item', value: 'edit' },
        { label: '$(link-external) Open in Browser', value: 'browser' },
        { label: '$(copy) Copy ID', value: 'copy' },
        { label: '$(checklist) View Details', value: 'details' }
    ];
    
    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: `Actions for #${workItem.fields['System.Id']}`
    });
    
    switch (selected?.value) {
        case 'timer':
            startTimer(workItem);
            break;
        case 'branch':
            await createBranchFromWorkItem(workItem);
            break;
        case 'comment':
            await addWorkItemComment(workItem);
            break;
        case 'status':
            await updateWorkItemStatus(workItem);
            break;
        case 'edit':
            await editWorkItem(workItem);
            break;
        case 'browser':
            openWorkItemInBrowser(workItem);
            break;
        case 'copy':
            copyWorkItemId(workItem);
            break;
        case 'details':
            showWorkItemDetails(workItem);
            break;
    }
    
}

async function createWorkItemCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    const createOptions = [
        { label: '$(new-file) New Work Item', value: 'new' },
        { label: '$(file-code) From Template', value: 'template' },
        { label: '$(rocket) Quick Task', value: 'quick' },
        { label: '$(bug) Quick Bug', value: 'quickbug' }
    ];
    
    const createOption = await vscode.window.showQuickPick(createOptions, {
        placeHolder: 'How would you like to create a work item?'
    });
    
    if (!createOption) return;
    
    switch (createOption.value) {
        case 'template':
            await createWorkItemFromTemplate();
            break;
        case 'quick':
            await createQuickTask();
            break;
        case 'quickbug':
            await createQuickBug();
            break;
        default:
            await createStandardWorkItem();
            break;
    }
}

async function createStandardWorkItem() {
    const types = ['Task', 'Bug', 'User Story', 'Feature', 'Epic', 'Issue'];
    const defaultType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultWorkItemType') || 'Task';
    
    const type = await vscode.window.showQuickPick(types.map(t => ({ label: t })), {
        placeHolder: 'Select work item type'
    });
    if (!type) return;
    
    const title = await vscode.window.showInputBox({
        prompt: `Enter ${type.label} title`,
        placeHolder: `New ${type.label}`
    });
    if (!title) return;
    
    const description = await vscode.window.showInputBox({
        prompt: 'Enter description (optional)',
        placeHolder: 'Details about this work item...'
    });
    
    try {
        const workItem = await azureDevOpsAPI!.createWorkItem(type.label, title, description);
        vscode.window.showInformationMessage(`Created ${type.label} #${workItem.fields['System.Id']}: ${title}`);
        
        // Add to recent items
        recentWorkItems.unshift(workItem);
        if (recentWorkItems.length > 10) {
            recentWorkItems.pop();
        }
        
        // Refresh webview
        if (webviewProvider) {
            webviewProvider.refresh();
        }
        
        // Offer quick actions
        const action = await vscode.window.showInformationMessage(
            `${type.label} created! What would you like to do?`,
            'Start Timer', 'Create Branch', 'Open in Browser'
        );
        
        switch (action) {
            case 'Start Timer':
                startTimer(workItem);
                break;
            case 'Create Branch':
                await createBranchFromWorkItem(workItem);
                break;
            case 'Open in Browser':
                openWorkItemInBrowser(workItem);
                break;
        }
        
        
        // Update metrics
        const workItemsCreated = context.globalState.get<number>('workItemsCreated', 0);
        context.globalState.update('workItemsCreated', workItemsCreated + 1);
        checkMilestones();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create work item: ${error.message}`);
    }
}

async function createWorkItemFromTemplate() {
    const templates = context.globalState.get<any[]>('workItemTemplates', getDefaultTemplates());
    
    const template = await vscode.window.showQuickPick(
        templates.map(t => ({
            label: t.name,
            description: t.type,
            detail: t.description,
            template: t
        })),
        { placeHolder: 'Select a template' }
    );
    
    if (!template) return;
    
    const title = await vscode.window.showInputBox({
        prompt: 'Enter title',
        value: template.template.titlePrefix || ''
    });
    if (!title) return;
    
    try {
        const workItem = await azureDevOpsAPI!.createWorkItem(
            template.template.type,
            title,
            template.template.description
        );
        
        // Apply template fields
        const updates: any[] = [];
        if (template.template.tags) {
            updates.push({
                op: 'add',
                path: '/fields/System.Tags',
                value: template.template.tags
            });
        }
        if (template.template.priority) {
            updates.push({
                op: 'add',
                path: '/fields/Microsoft.VSTS.Common.Priority',
                value: template.template.priority
            });
        }
        if (template.template.assignTo === '@me') {
            // Assign to current user
            updates.push({
                op: 'add',
                path: '/fields/System.AssignedTo',
                value: 'me'
            });
        }
        
        if (updates.length > 0) {
            await azureDevOpsAPI!.updateWorkItem(workItem.fields['System.Id'], updates);
        }
        
        vscode.window.showInformationMessage(`Created ${template.template.type} from template: #${workItem.fields['System.Id']}`);
        
        if (webviewProvider) {
            webviewProvider.refresh();
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create work item from template: ${error.message}`);
    }
}

async function createQuickTask() {
    const title = await vscode.window.showInputBox({
        prompt: 'Quick task title',
        placeHolder: 'What needs to be done?'
    });
    if (!title) return;
    
    try {
        const workItem = await azureDevOpsAPI!.createWorkItem('Task', title);
        vscode.window.showInformationMessage(`Quick task created: #${workItem.fields['System.Id']}`);
        
        // Auto-start timer
        const autoStart = await vscode.window.showInformationMessage(
            'Task created! Start timer?',
            'Yes', 'No'
        );
        if (autoStart === 'Yes') {
            startTimer(workItem);
        }
        
        if (webviewProvider) {
            webviewProvider.refresh();
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create quick task: ${error.message}`);
    }
}

async function createQuickBug() {
    const title = await vscode.window.showInputBox({
        prompt: 'Bug title',
        placeHolder: 'What is the issue?'
    });
    if (!title) return;
    
    const repro = await vscode.window.showInputBox({
        prompt: 'Steps to reproduce (optional)',
        placeHolder: '1. Go to...\n2. Click on...\n3. See error',
        ignoreFocusOut: true
    });
    
    try {
        const description = repro ? `**Steps to Reproduce:**\n${repro}\n\n**Expected:** \n\n**Actual:** ` : '';
        const workItem = await azureDevOpsAPI!.createWorkItem('Bug', title, description);
        
        // Set bug priority to high by default
        await azureDevOpsAPI!.updateWorkItem(workItem.fields['System.Id'], [{
            op: 'add',
            path: '/fields/Microsoft.VSTS.Common.Priority',
            value: 2
        }]);
        
        vscode.window.showInformationMessage(`Bug created: #${workItem.fields['System.Id']}`);
        
        if (webviewProvider) {
            webviewProvider.refresh();
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create bug: ${error.message}`);
    }
}

function getDefaultTemplates() {
    return [
        {
            name: 'Code Review Task',
            type: 'Task',
            description: 'Review code changes and provide feedback',
            titlePrefix: 'Code Review: ',
            tags: 'code-review',
            priority: 2,
            assignTo: '@me'
        },
        {
            name: 'Unit Test Task',
            type: 'Task',
            description: 'Write unit tests for the implemented functionality',
            titlePrefix: 'Unit Tests: ',
            tags: 'testing;unit-test',
            priority: 2
        },
        {
            name: 'Documentation Task',
            type: 'Task',
            description: 'Update documentation for the feature',
            titlePrefix: 'Documentation: ',
            tags: 'documentation',
            priority: 3
        },
        {
            name: 'Performance Bug',
            type: 'Bug',
            description: 'Performance issue detected\n\n**Steps to Reproduce:**\n\n**Expected Performance:**\n\n**Actual Performance:**\n\n**Environment:**',
            titlePrefix: 'Performance: ',
            tags: 'performance',
            priority: 2
        },
        {
            name: 'Security Bug',
            type: 'Bug',
            description: 'Security vulnerability detected\n\n**Description:**\n\n**Impact:**\n\n**Steps to Reproduce:**\n\n**Proposed Fix:**',
            titlePrefix: 'Security: ',
            tags: 'security',
            priority: 1
        },
        {
            name: 'Feature Story',
            type: 'User Story',
            description: 'As a [user type], I want [feature] so that [benefit]\n\n**Acceptance Criteria:**\n- [ ] Criteria 1\n- [ ] Criteria 2\n- [ ] Criteria 3',
            titlePrefix: 'Feature: ',
            tags: 'feature',
            priority: 2
        }
    ];
}

async function refreshWorkItemsCommand() {
    if (webviewProvider) {
        webviewProvider.refresh();
        vscode.window.showInformationMessage('Work items refreshed');
    }
}

async function selectWorkItemCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    const queryType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultQuery') || 'My Work Items';
    const workItems = await azureDevOpsAPI.getWorkItems(queryType);
    
    const selected = await selectWorkItem(workItems);
    if (selected && webviewProvider) {
        webviewProvider.selectWorkItem(selected);
    }
}

function copyWorkItemIdCommand() {
    const workItem = webviewProvider?.getSelectedWorkItem();
    if (workItem) {
        copyWorkItemId(workItem);
    } else {
        vscode.window.showWarningMessage('No work item selected');
    }
}

function viewWorkItemInBrowserCommand() {
    const workItem = webviewProvider?.getSelectedWorkItem();
    if (workItem) {
        openWorkItemInBrowser(workItem);
    } else {
        vscode.window.showWarningMessage('No work item selected');
    }
}

async function runQueryCommand() {
    const query = await vscode.window.showInputBox({
        prompt: 'Enter WIQL query',
        placeHolder: 'SELECT [System.Id], [System.Title] FROM WorkItems WHERE ...',
        ignoreFocusOut: true
    });
    
    if (!query || !azureDevOpsAPI) return;
    
    try {
        const workItems = await azureDevOpsAPI.getWorkItems(query);
        vscode.window.showInformationMessage(`Query returned ${workItems.length} work items`);
        
        if (webviewProvider) {
            webviewProvider.showWorkItems(workItems);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Query failed: ${error.message}`);
    }
}

function toggleKanbanViewCommand() {
    if (webviewProvider) {
        webviewProvider.toggleKanbanView();
    }
}

async function selectSprintCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        // Get all iterations
        const iterations = await azureDevOpsAPI.getIterations();
        
        if (iterations.length === 0) {
            vscode.window.showInformationMessage('No sprints found in this project');
            return;
        }
        
        // Get current iteration to mark it
        const currentIteration = await azureDevOpsAPI.getCurrentIteration();
        
        // Create quick pick items
        const items = iterations.map(iter => ({
            label: iter.name,
            description: iter.path,
            detail: `${new Date(iter.attributes.startDate).toLocaleDateString()} - ${new Date(iter.attributes.finishDate).toLocaleDateString()}`,
            id: iter.id,
            path: iter.path,
            picked: currentIteration?.id === iter.id
        }));
        
        // Add "All Sprints" option
        items.unshift({
            label: '$(list-flat) All Sprints',
            description: 'Show work items from all sprints',
            detail: '',
            id: 'all',
            path: '',
            picked: false
        });
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a sprint to filter work items',
            title: 'Select Sprint'
        });
        
        if (selected) {
            // Store selected sprint
            if (selected.id === 'all') {
                context.globalState.update('selectedSprint', undefined);
                vscode.window.showInformationMessage('Showing work items from all sprints');
            } else {
                context.globalState.update('selectedSprint', selected.path);
                vscode.window.showInformationMessage(`Filtering by sprint: ${selected.label}`);
            }
            
            // Refresh work items
            if (webviewProvider) {
                webviewProvider.refresh();
            }
            
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to load sprints: ${error.message}`);
    }
}

function supportCommand() {
    vscode.env.openExternal(vscode.Uri.parse('https://github.com/sponsors/YonasValentin'));
}

function reviewCommand() {
    const extensionId = 'YonasValentinMougaardKristensen.azure-devops-code-companion';
    const reviewUrl = `https://marketplace.visualstudio.com/items?itemName=${extensionId}&ssr=false#review-details`;
    vscode.env.openExternal(vscode.Uri.parse(reviewUrl));
}

// Work item helper functions
async function addWorkItemComment(workItem: WorkItem) {
    if (!azureDevOpsAPI) return;
    
    const comment = await vscode.window.showInputBox({
        prompt: 'Enter your comment',
        placeHolder: 'Your comment here...',
        ignoreFocusOut: true
    });
    
    if (!comment) return;
    
    try {
        await azureDevOpsAPI.addWorkItemComment(workItem.fields['System.Id'], comment);
        vscode.window.showInformationMessage('Comment added successfully');
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to add comment: ${error.message}`);
    }
}

async function updateWorkItemStatus(workItem: WorkItem) {
    if (!azureDevOpsAPI) return;
    
    // Get valid state transitions based on work item type
    const type = workItem.fields['System.WorkItemType'];
    const currentState = workItem.fields['System.State'];
    
    // Common state transitions
    let states = ['New', 'Active', 'Resolved', 'Closed'];
    
    // Add special states based on type
    if (type === 'Bug') {
        states = ['New', 'Active', 'Resolved', 'Closed', 'Removed'];
    } else if (type === 'User Story' || type === 'Feature') {
        states = ['New', 'Active', 'Resolved', 'Closed', 'Removed'];
    } else if (type === 'Task') {
        states = ['To Do', 'In Progress', 'Done', 'Removed'];
    }
    
    // Filter out current state and create quick pick items
    const items = states
        .filter(s => s !== currentState)
        .map(state => ({
            label: state,
            description: getStateDescription(state),
            iconPath: new vscode.ThemeIcon(getStateIcon(state))
        }));
    
    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Change from ${currentState} to...`,
        title: `Update Status - ${workItem.fields['System.Title']}`
    });
    
    if (!selected) return;
    
    try {
        const updates = [{
            op: 'replace',
            path: '/fields/System.State',
            value: selected.label
        }];
        
        await azureDevOpsAPI.updateWorkItem(workItem.fields['System.Id'], updates);
        vscode.window.showInformationMessage(`Status updated to ${selected.label}`);
        
        // Refresh webview
        if (webviewProvider) {
            webviewProvider.refresh();
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to update status: ${error.message}`);
    }
}

function getStateDescription(state: string): string {
    switch (state) {
        case 'New': return 'Not started';
        case 'To Do': return 'Ready';
        case 'Active':
        case 'In Progress': return 'In progress';
        case 'Resolved': return 'Pending verification';
        case 'Done':
        case 'Closed': return 'Complete';
        case 'Removed': return 'Removed';
        default: return '';
    }
}

function getStateIcon(state: string): string {
    if (state === 'New' || state === 'To Do') return 'circle-outline';
    if (state === 'Active' || state === 'In Progress') return 'play-circle';
    if (state === 'Resolved') return 'check-all';
    if (state === 'Done') return 'pass-filled';
    if (state === 'Closed') return 'circle-slash';
    if (state === 'Removed') return 'trash';
    return 'circle';
}

async function editWorkItem(workItem: WorkItem) {
    const editOptions = [
        { label: '$(edit) Edit Title', value: 'title' },
        { label: '$(list-unordered) Edit Description', value: 'description' },
        { label: '$(person) Assign To', value: 'assignTo' },
        { label: '$(tag) Edit Tags', value: 'tags' },
        { label: '$(symbol-numeric) Edit Priority', value: 'priority' },
        { label: '$(calendar) Edit Iteration', value: 'iteration' },
        { label: '$(folder) Edit Area Path', value: 'area' },
        { label: '$(clock) Edit Effort/Story Points', value: 'effort' },
        { label: '$(dashboard) Edit All Fields', value: 'all' }
    ];
    
    const selected = await vscode.window.showQuickPick(editOptions, {
        placeHolder: `Edit work item #${workItem.fields['System.Id']}`
    });
    
    if (!selected || !azureDevOpsAPI) return;
    
    const updates: any[] = [];
    
    switch (selected.value) {
        case 'title':
            const newTitle = await vscode.window.showInputBox({
                prompt: 'Enter new title',
                value: workItem.fields['System.Title']
            });
            if (newTitle && newTitle !== workItem.fields['System.Title']) {
                updates.push({
                    op: 'add',
                    path: '/fields/System.Title',
                    value: newTitle
                });
            }
            break;
            
        case 'description':
            const newDescription = await vscode.window.showInputBox({
                prompt: 'Enter new description',
                value: workItem.fields['System.Description'] || '',
                ignoreFocusOut: true
            });
            if (newDescription !== undefined) {
                updates.push({
                    op: 'add',
                    path: '/fields/System.Description',
                    value: newDescription
                });
            }
            break;
            
        case 'assignTo':
            const assignTo = await vscode.window.showInputBox({
                prompt: 'Assign to (email or display name)',
                value: workItem.fields['System.AssignedTo']?.uniqueName || ''
            });
            if (assignTo !== undefined) {
                updates.push({
                    op: 'add',
                    path: '/fields/System.AssignedTo',
                    value: assignTo || null
                });
            }
            break;
            
        case 'tags':
            const currentTags = workItem.fields['System.Tags'] || '';
            const newTags = await vscode.window.showInputBox({
                prompt: 'Enter tags (separated by semicolons)',
                value: currentTags
            });
            if (newTags !== undefined && newTags !== currentTags) {
                updates.push({
                    op: 'add',
                    path: '/fields/System.Tags',
                    value: newTags
                });
            }
            break;
            
        case 'priority':
            const priorities = ['1', '2', '3', '4'];
            const currentPriority = workItem.fields['Microsoft.VSTS.Common.Priority']?.toString() || '2';
            const newPriority = await vscode.window.showQuickPick(
                priorities.map(p => ({ 
                    label: `Priority ${p}`,
                    description: p === '1' ? 'Critical' : p === '2' ? 'High' : p === '3' ? 'Medium' : 'Low',
                    priority: p
                })),
                { placeHolder: `Current priority: ${currentPriority}` }
            );
            if (newPriority) {
                updates.push({
                    op: 'add',
                    path: '/fields/Microsoft.VSTS.Common.Priority',
                    value: parseInt(newPriority.priority)
                });
            }
            break;
            
        case 'iteration':
            const iterations = await azureDevOpsAPI.getIterations();
            const currentIteration = workItem.fields['System.IterationPath'];
            const newIteration = await vscode.window.showQuickPick(
                iterations.map(i => ({ 
                    label: i.name,
                    description: i.path,
                    iteration: i
                })),
                { placeHolder: `Current iteration: ${currentIteration || 'None'}` }
            );
            if (newIteration) {
                updates.push({
                    op: 'add',
                    path: '/fields/System.IterationPath',
                    value: newIteration.iteration.path
                });
            }
            break;
            
        case 'effort':
            const currentEffort = workItem.fields['Microsoft.VSTS.Scheduling.Effort'] || 
                                 '';
            const newEffort = await vscode.window.showInputBox({
                prompt: 'Enter effort/story points',
                value: currentEffort.toString(),
                validateInput: (value) => {
                    if (value && isNaN(parseFloat(value))) {
                        return 'Please enter a valid number';
                    }
                    return null;
                }
            });
            if (newEffort) {
                const effortField = workItem.fields['Microsoft.VSTS.Scheduling.Effort'] !== undefined 
                    ? 'Microsoft.VSTS.Scheduling.Effort' 
                    : 'Microsoft.VSTS.Scheduling.StoryPoints';
                updates.push({
                    op: 'add',
                    path: `/fields/${effortField}`,
                    value: parseFloat(newEffort)
                });
            }
            break;
            
        case 'all':
            // Open work item in browser for full editing
            openWorkItemInBrowser(workItem);
            return;
    }
    
    if (updates.length > 0) {
        try {
            await azureDevOpsAPI.updateWorkItem(workItem.fields['System.Id'], updates);
            vscode.window.showInformationMessage(`Work item #${workItem.fields['System.Id']} updated successfully!`);
            
            // Refresh webview
            if (webviewProvider) {
                webviewProvider.refresh();
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to update work item: ${error.message}`);
        }
    }
}

function openWorkItemInBrowser(workItem: WorkItem) {
    if (azureDevOpsAPI) {
        const url = azureDevOpsAPI.getBrowserUrl(`/_workitems/edit/${workItem.fields['System.Id']}`);
        vscode.env.openExternal(vscode.Uri.parse(url));
    }
    
}

function copyWorkItemId(workItem: WorkItem) {
    vscode.env.clipboard.writeText(workItem.fields['System.Id'].toString());
    vscode.window.showInformationMessage(`Copied work item ID: ${workItem.fields['System.Id']}`);
}

function showWorkItemDetails(workItem: WorkItem) {
    if (webviewProvider) {
        webviewProvider.showWorkItemDetails(workItem);
    }
}

// Timer Commands
async function startTimerCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    const queryType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultQuery') || 'My Work Items';
    const workItems = await azureDevOpsAPI.getWorkItems(queryType);
    
    const selected = await selectWorkItem(workItems, 'Select work item to track time');
    if (selected) {
        startTimer(selected);
    }
}

// Mutex lock to prevent race conditions
let timerStartLock = false;

function startTimer(workItem: WorkItem) {
    // Race condition protection
    if (timerStartLock) {
        return;
    }

    if (currentTimer) {
        vscode.window.showWarningMessage('Timer already running. Stop it first.');
        return;
    }

    timerStartLock = true;

    try {
        const isPomodoro = vscode.workspace.getConfiguration('azureDevOps').get<boolean>('pomodoroEnabled');

        currentTimer = {
            workItemId: workItem.fields['System.Id'],
            workItemTitle: workItem.fields['System.Title'],
            startTime: Date.now(),
            elapsedSeconds: 0,
            isPaused: false,
            isPomodoro,
            pomodoroCount: 0
        };

        // Reset Pomodoro notification tracker
        context.globalState.update('lastPomodoroNotification', 0);
        context.globalState.update('currentTimer', currentTimer);
        startTimerInterval();
        startInactivityTimer();

        vscode.window.showInformationMessage(
            `Timer started for #${workItem.fields['System.Id']}: ${workItem.fields['System.Title']}`
        );

        // Set context for command visibility
        vscode.commands.executeCommand('setContext', 'azureDevOps.timerRunning', true);
        vscode.commands.executeCommand('setContext', 'azureDevOps.timerActive', true);

    } finally {
        timerStartLock = false;
    }
}

function pauseTimerCommand() {
    if (!currentTimer || currentTimer.isPaused) {
        vscode.window.showInformationMessage('No active timer to pause');
        return;
    }

    const rawElapsed = Math.floor((Date.now() - currentTimer.startTime) / 1000);
    currentTimer.elapsedSeconds = Math.max(0, Math.min(rawElapsed, 86400));

    currentTimer.isPaused = true;
    currentTimer.pausedTime = Date.now();

    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = undefined;
    }

    context.globalState.update('currentTimer', currentTimer);
    context.globalState.update('lastSaveTime', Date.now());
    updateTimerStatusBar();

    vscode.commands.executeCommand('setContext', 'azureDevOps.timerRunning', false);
    vscode.commands.executeCommand('setContext', 'azureDevOps.timerPaused', true);

    // Update webview
    if (webviewProvider) {
        webviewProvider.updateTimer(currentTimer);
    }

    vscode.window.showInformationMessage('Timer paused');
}

function resumeTimerCommand(autoResumed: boolean = false) {
    if (!currentTimer || !currentTimer.isPaused) {
        if (!autoResumed) {
            vscode.window.showInformationMessage('No paused timer to resume');
        }
        return;
    }

    if (currentTimer.pausedTime && currentTimer.pausedTime > 0) {
        const pausedDuration = Math.max(0, Date.now() - currentTimer.pausedTime);
        // Cap paused duration to 24 hours max to prevent time corruption
        const cappedPausedDuration = Math.min(pausedDuration, 24 * 60 * 60 * 1000);
        currentTimer.startTime += cappedPausedDuration;
    }

    currentTimer.isPaused = false;
    currentTimer.pausedTime = undefined;

    context.globalState.update('currentTimer', currentTimer);
    startTimerInterval();

    vscode.commands.executeCommand('setContext', 'azureDevOps.timerRunning', true);
    vscode.commands.executeCommand('setContext', 'azureDevOps.timerPaused', false);

    // Update webview
    if (webviewProvider) {
        webviewProvider.updateTimer(currentTimer);
    }

    if (autoResumed) {
        vscode.window.showInformationMessage('Timer resumed due to activity');
    } else {
        vscode.window.showInformationMessage('Timer resumed');
    }
}

function generateTimeEntryId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

async function stopTimerCommand() {
    if (!currentTimer) {
        vscode.window.showInformationMessage('No timer running');
        return;
    }

    let duration: number;
    if (currentTimer.isPaused) {
        duration = currentTimer.elapsedSeconds;
    } else {
        const rawDuration = Math.floor((Date.now() - currentTimer.startTime) / 1000);
        // Cap at 24 hours
        duration = Math.max(0, Math.min(rawDuration, 86400));
    }

    // Skip entries under 1 minute
    if (duration < 60) {
        const confirm = await vscode.window.showWarningMessage(
            `Timer duration is less than 1 minute (${duration} seconds). Save anyway?`,
            'Save', 'Discard'
        );
        if (confirm !== 'Save') {
            // Clear timer without saving
            clearTimerState();
            return;
        }
    }

    const hours = (duration / 3600).toFixed(2);

    // Save time entry with new fields
    const timeEntry: TimeEntry = {
        id: generateTimeEntryId(),
        workItemId: currentTimer.workItemId,
        workItemTitle: currentTimer.workItemTitle,
        startTime: currentTimer.startTime,
        endTime: Date.now(),
        duration: duration,
        synced: false,
        deviceId: vscode.env.machineId
    };

    timeEntries.push(timeEntry);
    saveTimeEntries();

    // Optionally update work item with time (with offline queue support)
    let syncedCurrentEntry = false;
    if (azureDevOpsAPI) {
        const update = await vscode.window.showInformationMessage(
            `Timer stopped. Total time: ${hours} hours. Update work item?`,
            'Yes', 'No'
        );

        if (update === 'Yes') {
            syncedCurrentEntry = await syncTimeEntryToAzure(timeEntry, parseFloat(hours));
        }
    }

    // Clear timer
    clearTimerState();


    // Update metrics
    const totalTimeTracked = context.globalState.get<number>('totalTimeTracked', 0);
    context.globalState.update('totalTimeTracked', totalTimeTracked + duration);
    checkMilestones();

    // Sync other pending entries
    // Skip the recently added entry to avoid double-sync
    const otherPendingEntries = timeEntries.filter(e => !e.synced && e.id !== timeEntry.id);
    if (otherPendingEntries.length > 0) {
        // Sync other pending entries in background (not await to avoid blocking)
        syncPendingTimeEntries().catch(err => {
            console.error('Failed to sync pending entries:', err);
        });
    }
}

function clearTimerState() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = undefined;
    }

    if (inactivityTimer) {
        clearInterval(inactivityTimer);
        inactivityTimer = undefined;
    }

    currentTimer = undefined;
    context.globalState.update('currentTimer', undefined);
    statusBarItem.hide();

    vscode.commands.executeCommand('setContext', 'azureDevOps.timerRunning', false);
    vscode.commands.executeCommand('setContext', 'azureDevOps.timerActive', false);
    vscode.commands.executeCommand('setContext', 'azureDevOps.timerPaused', false);
}

async function syncTimeEntryToAzure(entry: TimeEntry, hours: number): Promise<boolean> {
    if (!azureDevOpsAPI) return false;

    try {
        await azureDevOpsAPI.addTimeEntry(
            entry.workItemId,
            hours,
            'Time tracked via VS Code'
        );

        // Mark as synced
        entry.synced = true;
        entry.syncError = undefined;
        saveTimeEntries();

        vscode.window.showInformationMessage('Time entry added to work item');
        return true;
    } catch (error: any) {
        // Store error and keep in queue for retry
        entry.syncError = error.message || 'Unknown error';
        saveTimeEntries();

        vscode.window.showWarningMessage(
            `Failed to sync time entry: ${error.message}. Will retry automatically.`
        );
        return false;
    }
}

let isSyncingTimeEntries = false;

async function syncPendingTimeEntries(): Promise<void> {
    if (!azureDevOpsAPI) return;

    // Prevent concurrent sync
    if (isSyncingTimeEntries) {
        console.log('Sync already in progress, skipping...');
        return;
    }

    const pendingEntries = timeEntries.filter(e => !e.synced);
    if (pendingEntries.length === 0) return;

    isSyncingTimeEntries = true;
    let syncedCount = 0;

    try {
        for (const entry of pendingEntries) {
            // Re-check if entry is still unsynced (might have been synced elsewhere)
            if (entry.synced) continue;

            const hours = (entry.duration / 3600);
            const success = await syncTimeEntryToAzure(entry, hours);
            if (success) syncedCount++;

            // Add small delay between syncs to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        if (syncedCount > 0) {
            console.log(`Synced ${syncedCount} pending time entries`);
        }
    } finally {
        isSyncingTimeEntries = false;
    }
}

async function showTimeReportCommand() {
    const options = ['Today', 'This Week', 'This Month', 'All Time'];
    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select time period'
    });
    
    if (!selected) return;
    
    const now = Date.now();
    let startDate: number;
    
    switch (selected) {
        case 'Today':
            startDate = new Date().setHours(0, 0, 0, 0);
            break;
        case 'This Week':
            const weekStart = new Date();
            weekStart.setDate(weekStart.getDate() - weekStart.getDay());
            startDate = weekStart.setHours(0, 0, 0, 0);
            break;
        case 'This Month':
            startDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
            break;
        default:
            startDate = 0;
    }
    
    const filteredEntries = timeEntries.filter(entry => entry.startTime >= startDate);
    
    if (filteredEntries.length === 0) {
        vscode.window.showInformationMessage('No time entries found for the selected period');
        return;
    }
    
    // Group by work item
    const groupedEntries = new Map<number, { total: number, entries: TimeEntry[] }>();
    
    for (const entry of filteredEntries) {
        if (!groupedEntries.has(entry.workItemId)) {
            groupedEntries.set(entry.workItemId, { total: 0, entries: [] });
        }
        const group = groupedEntries.get(entry.workItemId)!;
        group.total += entry.duration;
        group.entries.push(entry);
    }
    
    // Show report in webview
    if (webviewProvider) {
        webviewProvider.showTimeReport(groupedEntries, selected);
    }
    
}

// Timer helper functions
function startTimerInterval() {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = undefined;
    }

    timerInterval = setInterval(() => {
        if (currentTimer && !currentTimer.isPaused) {
            const rawElapsed = Math.floor((Date.now() - currentTimer.startTime) / 1000);
            // Cap at 24 hours
            currentTimer.elapsedSeconds = Math.max(0, Math.min(rawElapsed, 86400));
            updateTimerStatusBar();
            
            // Check for Pomodoro break
            if (currentTimer.isPomodoro) {
                const pomodoroSeconds = 25 * 60; // 25 minutes in seconds
                const breakSeconds = 5 * 60;    // 5 minutes in seconds
                const cycleSeconds = pomodoroSeconds + breakSeconds;
                const elapsedInCycle = currentTimer.elapsedSeconds % cycleSeconds;

                // Trigger at exactly pomodoroSeconds (with 1 second window to avoid missing it)
                const pomodoroJustCompleted = elapsedInCycle === pomodoroSeconds;
                const lastPomodoroNotification = context.globalState.get<number>('lastPomodoroNotification', 0);
                const timeSinceLastNotification = currentTimer.elapsedSeconds - lastPomodoroNotification;

                if (pomodoroJustCompleted && timeSinceLastNotification >= pomodoroSeconds) {
                    context.globalState.update('lastPomodoroNotification', currentTimer.elapsedSeconds);

                    // Clear any existing break timeout
                    if (pomodoroBreakTimeout) {
                        clearTimeout(pomodoroBreakTimeout);
                        pomodoroBreakTimeout = undefined;
                    }

                    vscode.window.showInformationMessage(
                        'Pomodoro completed! Time for a 5-minute break.',
                        'Start Break', 'Continue Working'
                    ).then(selection => {
                        if (selection === 'Start Break') {
                            pauseTimerCommand();
                            pomodoroBreakTimeout = setTimeout(() => {
                                vscode.window.showInformationMessage('Break over! Ready to continue?', 'Resume')
                                    .then(resume => {
                                        if (resume === 'Resume') {
                                            resumeTimerCommand();
                                        }
                                    });
                            }, breakSeconds * 1000);
                        }
                    });

                    if (currentTimer.pomodoroCount !== undefined) {
                        currentTimer.pomodoroCount++;
                    }
                }
            }
            
            // Update webview
            if (webviewProvider) {
                webviewProvider.updateTimer(currentTimer);
            }
            
            // Save state periodically
            context.globalState.update('currentTimer', currentTimer);
        }
    }, 1000);
    
    updateTimerStatusBar();
    startInactivityTimer();
}

function updateTimerStatusBar() {
    if (!currentTimer) {
        statusBarItem.hide();
        return;
    }
    
    const hours = Math.floor(currentTimer.elapsedSeconds / 3600);
    const minutes = Math.floor((currentTimer.elapsedSeconds % 3600) / 60);
    const seconds = currentTimer.elapsedSeconds % 60;
    
    const timeString = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    
    statusBarItem.text = currentTimer.isPaused 
        ? `$(debug-pause) ${timeString} - #${currentTimer.workItemId} (Paused)`
        : `$(clock) ${timeString} - #${currentTimer.workItemId}`;
    
    statusBarItem.tooltip = `${currentTimer.workItemTitle}\nClick to stop timer`;
    statusBarItem.command = 'azureDevOps.stopTimer';
    statusBarItem.backgroundColor = currentTimer.isPaused 
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : new vscode.ThemeColor('azureDevOps.timerBackground');
    
    statusBarItem.show();
}

function startInactivityTimer() {
    const timeout = vscode.workspace.getConfiguration('azureDevOps').get<number>('timerInactivityTimeout') || 300;

    if (inactivityTimer) {
        clearInterval(inactivityTimer);
        inactivityTimer = undefined;
    }

    if (timeout <= 0) {
        return;
    }

    inactivityTimer = setInterval(() => {
        if (currentTimer && !currentTimer.isPaused) {
            const inactivityDuration = (Date.now() - lastActivity) / 1000;

            if (inactivityDuration >= timeout) {
                // Set flag before pausing to avoid race condition
                if (currentTimer) {
                    currentTimer.pausedDueToInactivity = true;
                }
                pauseTimerCommand();
                vscode.window.showWarningMessage(
                    `Timer paused after ${timeout} seconds of inactivity. It will auto-resume when you become active.`
                );
            }
        }
    }, 10000); // Check every 10 seconds
}

function updateActivity() {
    lastActivity = Date.now();

    // Auto-resume timer if it was paused due to inactivity
    // Debounce auto-resume (5 second minimum)
    if (currentTimer && currentTimer.isPaused && currentTimer.pausedDueToInactivity) {
        const now = Date.now();
        if (now - lastActivityResumeTime < 5000) {
            return; // Debounce: Don't auto-resume too frequently
        }

        const autoResume = vscode.workspace.getConfiguration('azureDevOps').get<boolean>('autoResumeOnActivity', true);
        if (autoResume) {
            lastActivityResumeTime = now;
            currentTimer.pausedDueToInactivity = false;
            resumeTimerCommand(true); // Pass flag to suppress duplicate message
        }
    }
}

function restoreTimerState() {
    const savedTimer = context.globalState.get<TimerState>('currentTimer');
    if (savedTimer) {
        if (!isValidTimerState(savedTimer)) {
            console.warn('Invalid timer state found, clearing...');
            context.globalState.update('currentTimer', undefined);
            return;
        }

        currentTimer = savedTimer;

        // Adjust start time if timer was running
        if (!currentTimer.isPaused) {
            const lastSaveTime = context.globalState.get<number>('lastSaveTime');
            if (lastSaveTime && lastSaveTime > 0) {
                // Add time elapsed since last save to the existing elapsed seconds
                const elapsedSinceLastSave = Math.max(0, Date.now() - lastSaveTime);
                // Limit to reasonable values (max 1 hour since last save)
                const cappedElapsed = Math.min(elapsedSinceLastSave, 60 * 60 * 1000);
                currentTimer.elapsedSeconds += Math.floor(cappedElapsed / 1000);
                currentTimer.elapsedSeconds = Math.min(currentTimer.elapsedSeconds, 86400);
                // Set startTime based on total elapsed time
                currentTimer.startTime = Date.now() - (currentTimer.elapsedSeconds * 1000);
            } else {
                // If no valid lastSaveTime, just restore based on current elapsed time
                currentTimer.startTime = Date.now() - (currentTimer.elapsedSeconds * 1000);
            }
        }

        startTimerInterval();

        vscode.window.showInformationMessage(
            `Restored timer for #${currentTimer.workItemId}: ${currentTimer.workItemTitle}`
        );

        // Update context
        vscode.commands.executeCommand('setContext', 'azureDevOps.timerActive', true);
        vscode.commands.executeCommand('setContext', 'azureDevOps.timerRunning', !currentTimer.isPaused);
        vscode.commands.executeCommand('setContext', 'azureDevOps.timerPaused', currentTimer.isPaused);
    }
}

function isValidTimerState(timer: any): timer is TimerState {
    return (
        timer &&
        typeof timer.workItemId === 'number' &&
        timer.workItemId > 0 &&
        typeof timer.workItemTitle === 'string' &&
        typeof timer.startTime === 'number' &&
        timer.startTime > 0 &&
        typeof timer.elapsedSeconds === 'number' &&
        timer.elapsedSeconds >= 0 &&
        timer.elapsedSeconds <= 86400 && // Max 24 hours
        typeof timer.isPaused === 'boolean'
    );
}

function loadTimeEntries() {
    const saved = context.globalState.get<TimeEntry[]>('timeEntries');
    if (saved) {
        timeEntries = saved;
    }
}

function saveTimeEntries() {
    context.globalState.update('timeEntries', timeEntries);
    context.globalState.update('lastSaveTime', Date.now());
}

// Git Integration
async function createBranchCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    const queryType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultQuery') || 'My Work Items';
    const workItems = await azureDevOpsAPI.getWorkItems(queryType);
    
    const selected = await selectWorkItem(workItems, 'Select work item for branch');
    if (selected) {
        await createBranchFromWorkItem(selected);
    }
}

async function createBranchFromWorkItem(workItem: WorkItem) {
    if (!await isGitRepository()) {
        vscode.window.showErrorMessage('Not in a git repository');
        return;
    }
    
    const workItemId = workItem.fields['System.Id'];
    const title = workItem.fields['System.Title'];
    const workItemType = workItem.fields['System.WorkItemType'];
    
    // Select branch type based on work item type
    const branchTypes = [
        { label: '$(git-branch) feature', value: 'feature', description: 'New feature or enhancement' },
        { label: '$(bug) bugfix', value: 'bugfix', description: 'Fix for a bug' },
        { label: '$(flame) hotfix', value: 'hotfix', description: 'Urgent fix for production' },
        { label: '$(beaker) chore', value: 'chore', description: 'Maintenance or refactoring' },
        { label: '$(book) docs', value: 'docs', description: 'Documentation only' },
        { label: '$(rocket) release', value: 'release', description: 'Release preparation' }
    ];
    
    // Auto-select based on work item type
    let defaultSelection = 'feature';
    if (workItemType.toLowerCase() === 'bug') {
        defaultSelection = 'bugfix';
    } else if (workItemType.toLowerCase() === 'task') {
        defaultSelection = 'chore';
    }
    
    const branchType = await vscode.window.showQuickPick(branchTypes, {
        placeHolder: 'Select branch type',
        title: `Creating branch for ${workItemType} #${workItemId}`
    });
    
    if (!branchType) return;
    
    // Sanitize title for branch name
    const sanitizedTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 50);

    // Get branch name template from settings
    const branchTemplate = vscode.workspace.getConfiguration('azureDevOps').get<string>('branchNameTemplate', '{type}/{id}-{title}');
    const defaultBranchName = branchTemplate
        .replace('{type}', branchType.value)
        .replace('{id}', workItemId.toString())
        .replace('{title}', sanitizedTitle);
    
    const branchName = await vscode.window.showInputBox({
        prompt: 'Enter branch name',
        value: defaultBranchName,
        validateInput: (value) => {
            if (!/^[a-zA-Z0-9\-_\/]+$/.test(value)) {
                return 'Branch name can only contain letters, numbers, hyphens, underscores, and slashes';
            }
            return null;
        }
    });
    
    if (!branchName) return;
    
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders![0];
        
        // Get current branch to determine base
        const { stdout: currentBranch } = await execAsync('git branch --show-current', {
            cwd: workspaceFolder.uri.fsPath
        });
        
        const baseBranch = await vscode.window.showInputBox({
            prompt: 'Base branch (leave empty to use current branch)',
            value: currentBranch.trim() === 'main' || currentBranch.trim() === 'master' ? '' : 'main'
        });
        
        if (baseBranch) {
            await execAsync(`git checkout ${baseBranch}`, {
                cwd: workspaceFolder.uri.fsPath
            });
        }
        
        await execAsync(`git checkout -b ${branchName}`, {
            cwd: workspaceFolder.uri.fsPath
        });
        
        vscode.window.showInformationMessage(`Created and switched to branch: ${branchName}`);
        
        // Auto-start timer if configured
        const autoStartOnBranch = vscode.workspace.getConfiguration('azureDevOps').get<boolean>('autoStartTimerOnBranch', true);
        
        if (autoStartOnBranch) {
            startTimer(workItem);
            vscode.window.showInformationMessage('Timer started automatically for this work item');
        } else {
            // Offer to start timer
            const startTimerNow = await vscode.window.showInformationMessage(
                'Branch created! Start tracking time?',
                'Yes', 'No'
            );
            
            if (startTimerNow === 'Yes') {
                startTimer(workItem);
            }
        }
        
        
        // Update metrics
        const branchesCreated = context.globalState.get<number>('branchesCreated', 0);
        context.globalState.update('branchesCreated', branchesCreated + 1);
        checkMilestones();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create branch: ${error.message}`);
    }
}

// Link Work Item to Commit - extracts work item ID from branch name and helps link it
async function linkWorkItemToCommitCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }

    if (!await isGitRepository()) {
        vscode.window.showErrorMessage('Not in a git repository');
        return;
    }

    try {
        const workspaceFolder = vscode.workspace.workspaceFolders![0];

        // Get current branch name
        const { stdout: currentBranch } = await execAsync('git branch --show-current', {
            cwd: workspaceFolder.uri.fsPath
        });

        // Try to extract work item ID from branch name (e.g., feature/12345-some-title or AB#12345)
        const branchName = currentBranch.trim();
        const workItemIdMatch = branchName.match(/(?:AB#|\/|^)(\d+)(?:-|$)/);

        let workItemId: number | undefined;

        if (workItemIdMatch) {
            workItemId = parseInt(workItemIdMatch[1], 10);
            const useDetected = await vscode.window.showQuickPick(
                [
                    { label: `Use detected: #${workItemId}`, value: 'detected' },
                    { label: 'Select different work item', value: 'select' }
                ],
                { placeHolder: `Work item #${workItemId} detected from branch name` }
            );

            if (!useDetected) return;
            if (useDetected.value === 'select') {
                workItemId = undefined;
            }
        }

        if (!workItemId) {
            const queryType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultQuery') || 'My Work Items';
            const workItems = await azureDevOpsAPI.getWorkItems(queryType);
            const selected = await selectWorkItem(workItems, 'Select work item to link');
            if (!selected) return;
            workItemId = selected.fields['System.Id'];
        }

        // Get commit message template
        const template = vscode.workspace.getConfiguration('azureDevOps').get<string>('commitMessageTemplate', 'AB#{id}: {message}');

        // Get the staged changes info
        const { stdout: stagedFiles } = await execAsync('git diff --cached --name-only', {
            cwd: workspaceFolder.uri.fsPath
        });

        if (!stagedFiles.trim()) {
            vscode.window.showWarningMessage('No staged changes. Stage your changes first with `git add`');
            return;
        }

        // Show input for commit message
        const message = await vscode.window.showInputBox({
            prompt: 'Enter commit message (work item reference will be added)',
            placeHolder: 'Fix the issue with...',
            validateInput: (value) => value.length < 5 ? 'Message too short' : null
        });

        if (!message) return;

        // Format the commit message
        const workItem = await azureDevOpsAPI.getWorkItemById(workItemId);
        const title = workItem?.fields?.['System.Title'] || '';
        const commitMessage = template
            .replace('{id}', workItemId.toString())
            .replace('{title}', title)
            .replace('{message}', message);

        // Offer to commit
        const action = await vscode.window.showQuickPick(
            [
                { label: '$(git-commit) Commit now', value: 'commit' },
                { label: '$(clippy) Copy to clipboard', value: 'copy' }
            ],
            { placeHolder: `Message: "${commitMessage}"` }
        );

        if (!action) return;

        if (action.value === 'commit') {
            await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, {
                cwd: workspaceFolder.uri.fsPath
            });
            vscode.window.showInformationMessage(`Committed with message: ${commitMessage}`);
        } else {
            await vscode.env.clipboard.writeText(commitMessage);
            vscode.window.showInformationMessage('Commit message copied to clipboard');
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to link work item: ${error.message}`);
    }
}

// Insert work item reference at cursor position in editor
async function insertWorkItemReferenceCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return;
    }

    try {
        const queryType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultQuery') || 'My Work Items';
        const workItems = await azureDevOpsAPI.getWorkItems(queryType);

        const selected = await vscode.window.showQuickPick(
            workItems.map(wi => ({
                label: `#${wi.fields['System.Id']} - ${wi.fields['System.Title']}`,
                description: `${wi.fields['System.WorkItemType']} • ${wi.fields['System.State']}`,
                workItem: wi
            })),
            {
                placeHolder: 'Select work item to insert reference',
                matchOnDescription: true
            }
        );

        if (!selected) return;

        const workItemId = selected.workItem.fields['System.Id'];

        // Choose format
        const format = await vscode.window.showQuickPick(
            [
                { label: 'AB#12345', value: `AB#${workItemId}`, description: 'Standard Azure DevOps format' },
                { label: '#12345', value: `#${workItemId}`, description: 'Short format' },
                { label: 'AB#12345 - Title', value: `AB#${workItemId} - ${selected.workItem.fields['System.Title']}`, description: 'With title' },
                { label: 'Fixes AB#12345', value: `Fixes AB#${workItemId}`, description: 'For commit messages' },
                { label: 'Related to AB#12345', value: `Related to AB#${workItemId}`, description: 'For related items' }
            ],
            { placeHolder: 'Select reference format' }
        );

        if (!format) return;

        // Insert at cursor position
        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, format.value);
        });

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to insert reference: ${error.message}`);
    }
}

async function createPullRequestCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    if (!await isGitRepository()) {
        vscode.window.showErrorMessage('Not in a git repository');
        return;
    }
    
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders![0];
        
        // Get current branch
        const { stdout: currentBranch } = await execAsync('git branch --show-current', {
            cwd: workspaceFolder.uri.fsPath
        });
        
        if (!currentBranch.trim() || currentBranch.trim() === 'main' || currentBranch.trim() === 'master') {
            vscode.window.showErrorMessage('Cannot create PR from main/master branch');
            return;
        }
        
        // Get repository info
        const repositories = await azureDevOpsAPI.getRepositories();
        if (repositories.length === 0) {
            vscode.window.showErrorMessage('No repositories found');
            return;
        }
        
        let repository;
        if (repositories.length === 1) {
            repository = repositories[0];
        } else {
            const selected = await vscode.window.showQuickPick(
                repositories.map(r => ({ label: r.name, repository: r })),
                { placeHolder: 'Select repository' }
            );
            if (!selected) return;
            repository = selected.repository;
        }
        
        // Extract work item ID from branch name
        const workItemMatch = currentBranch.match(/(\d+)/);
        const workItemId = workItemMatch ? parseInt(workItemMatch[1]) : undefined;
        
        const title = await vscode.window.showInputBox({
            prompt: 'Pull request title',
            value: currentBranch.trim().replace(/[\-_\/]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
        });
        if (!title) return;
        
        const description = await vscode.window.showInputBox({
            prompt: 'Pull request description',
            placeHolder: 'Describe your changes...'
        });
        
        const targetBranch = await vscode.window.showInputBox({
            prompt: 'Target branch',
            value: 'main'
        });
        if (!targetBranch) return;
        
        // Push current branch
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Pushing branch...'
        }, async () => {
            await execAsync(`git push -u origin ${currentBranch}`, {
                cwd: workspaceFolder.uri.fsPath
            });
        });
        
        // Create PR
        const pullRequest = await azureDevOpsAPI.createPullRequest(
            repository.id,
            currentBranch.trim(),
            targetBranch,
            title,
            description || '',
            workItemId ? [workItemId] : undefined
        );
        
        vscode.window.showInformationMessage('Pull request created successfully!');
        
        // Open PR in browser
        const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
        const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
        const prUrl = `https://dev.azure.com/${org}/${project}/_git/${repository.name}/pullrequest/${pullRequest.pullRequestId}`;
        
        const openInBrowser = await vscode.window.showInformationMessage(
            'Pull request created!',
            'Open in Browser'
        );
        
        if (openInBrowser) {
            vscode.env.openExternal(vscode.Uri.parse(prUrl));
        }
        
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create pull request: ${error.message}`);
    }
}

async function showPullRequestsCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        const pullRequests = await azureDevOpsAPI.getMyPullRequests();
        
        if (pullRequests.length === 0) {
            vscode.window.showInformationMessage('No active pull requests found');
            return;
        }
        
        const items = pullRequests.map(pr => ({
            label: `$(git-pull-request) ${pr.title}`,
            description: `#${pr.pullRequestId} • ${pr.status}`,
            detail: `${pr.sourceRefName} → ${pr.targetRefName}`,
            pr
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a pull request'
        });
        
        if (selected) {
            await showPullRequestActions(selected.pr);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch pull requests: ${error.message}`);
    }
}

async function showAllPullRequestsCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        const status = await vscode.window.showQuickPick(
            ['active', 'completed', 'abandoned', 'all'].map(s => ({ label: s })),
            { placeHolder: 'Select PR status' }
        );
        if (!status) return;
        
        const pullRequests = await azureDevOpsAPI.getAllPullRequests(status.label === 'all' ? undefined : status.label);
        
        if (pullRequests.length === 0) {
            vscode.window.showInformationMessage('No pull requests found');
            return;
        }
        
        const items = pullRequests.map(pr => ({
            label: `$(git-pull-request) ${pr.title}`,
            description: `#${pr.pullRequestId} • ${pr.status} • ${pr.createdBy.displayName}`,
            detail: `${pr.sourceRefName} → ${pr.targetRefName}`,
            pr
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a pull request'
        });
        
        if (selected) {
            await showPullRequestActions(selected.pr);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch pull requests: ${error.message}`);
    }
}

async function showPullRequestActions(pr: PullRequest) {
    const actions = [
        { label: '$(link-external) Open in Browser', value: 'open' },
        { label: '$(comment) View Comments', value: 'comments' },
        { label: '$(check) Approve', value: 'approve' },
        { label: '$(git-merge) Complete/Merge', value: 'complete' },
        { label: '$(tasklist) View Work Items', value: 'workitems' },
        { label: '$(eye) View Details', value: 'details' }
    ];
    
    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: `Actions for PR #${pr.pullRequestId}`
    });
    
    const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
    const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
    
    switch (selected?.value) {
        case 'open':
            const prUrl = `https://dev.azure.com/${org}/${project}/_git/pullrequest/${pr.pullRequestId}`;
            vscode.env.openExternal(vscode.Uri.parse(prUrl));
            break;
        case 'comments':
            await showPullRequestComments(pr);
            break;
        case 'approve':
            await approvePullRequest(pr);
            break;
        case 'complete':
            await completePullRequest(pr);
            break;
        case 'workitems':
            await showPullRequestWorkItems(pr);
            break;
        case 'details':
            await showPullRequestDetails(pr);
            break;
    }
}

async function reviewPullRequestCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    const prs = await azureDevOpsAPI.getAllPullRequests('active');
    const prToReview = await vscode.window.showQuickPick(
        prs.map(pr => ({
            label: `PR #${pr.pullRequestId}: ${pr.title}`,
            description: pr.createdBy.displayName,
            pr
        })),
        { placeHolder: 'Select PR to review' }
    );
    
    if (prToReview) {
        await showPullRequestActions(prToReview.pr);
    }
}

async function showPullRequestComments(pr: PullRequest) {
    // Need to get repository ID from PR
    const repositories = await azureDevOpsAPI!.getRepositories();
    const repo = repositories.find(r => pr.sourceRefName.includes(r.name));
    if (!repo) {
        vscode.window.showErrorMessage('Could not find repository');
        return;
    }
    
    const comments = await azureDevOpsAPI!.getPullRequestComments(pr.pullRequestId, repo.id);
    
    if (comments.length === 0) {
        vscode.window.showInformationMessage('No comments on this PR');
        return;
    }
    
    // Show comments in output channel
    const outputChannel = vscode.window.createOutputChannel('PR Comments');
    outputChannel.show();
    
    comments.forEach(thread => {
        if (thread.comments) {
            thread.comments.forEach((comment: any) => {
                outputChannel.appendLine(`${comment.author.displayName}: ${comment.content}`);
                outputChannel.appendLine('---');
            });
        }
    });
}

async function approvePullRequest(pr: PullRequest) {
    const confirm = await vscode.window.showWarningMessage(
        `Approve PR #${pr.pullRequestId}?`,
        'Yes', 'No'
    );
    
    if (confirm === 'Yes') {
        try {
            const repositories = await azureDevOpsAPI!.getRepositories();
            const repo = repositories.find(r => pr.sourceRefName.includes(r.name));
            if (!repo) {
                vscode.window.showErrorMessage('Could not find repository');
                return;
            }
            
            await azureDevOpsAPI!.approvePullRequest(pr.pullRequestId, repo.id);
            vscode.window.showInformationMessage('Pull request approved!');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to approve PR: ${error.message}`);
        }
    }
}

async function completePullRequest(pr: PullRequest) {
    const deleteSource = await vscode.window.showQuickPick(
        ['Yes', 'No'].map(l => ({ label: l })),
        { placeHolder: 'Delete source branch after merge?' }
    );
    
    if (deleteSource) {
        try {
            const repositories = await azureDevOpsAPI!.getRepositories();
            const repo = repositories.find(r => pr.sourceRefName.includes(r.name));
            if (!repo) {
                vscode.window.showErrorMessage('Could not find repository');
                return;
            }
            
            await azureDevOpsAPI!.completePullRequest(pr.pullRequestId, repo.id, deleteSource.label === 'Yes');
            vscode.window.showInformationMessage('Pull request completed!');
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to complete PR: ${error.message}`);
        }
    }
}

async function showPullRequestWorkItems(pr: PullRequest) {
    const repositories = await azureDevOpsAPI!.getRepositories();
    const repo = repositories.find(r => pr.sourceRefName.includes(r.name));
    if (!repo) {
        vscode.window.showErrorMessage('Could not find repository');
        return;
    }
    
    const workItems = await azureDevOpsAPI!.getPullRequestWorkItems(pr.pullRequestId, repo.id);
    
    if (workItems.length === 0) {
        vscode.window.showInformationMessage('No work items linked to this PR');
        return;
    }
    
    const selected = await selectWorkItem(workItems, 'Work items linked to PR');
    if (selected) {
        await showWorkItemActions(selected);
    }
}

async function showPullRequestDetails(pr: PullRequest) {
    const repositories = await azureDevOpsAPI!.getRepositories();
    const repo = repositories.find(r => pr.sourceRefName.includes(r.name));
    if (!repo) {
        vscode.window.showErrorMessage('Could not find repository');
        return;
    }
    
    const details = await azureDevOpsAPI!.getPullRequestDetails(pr.pullRequestId, repo.id);
    
    // Show details in output channel
    const outputChannel = vscode.window.createOutputChannel('PR Details');
    outputChannel.show();
    outputChannel.appendLine(`Title: ${details.title}`);
    outputChannel.appendLine(`ID: ${details.pullRequestId}`);
    outputChannel.appendLine(`Status: ${details.status}`);
    outputChannel.appendLine(`Created By: ${details.createdBy.displayName}`);
    outputChannel.appendLine(`Created: ${new Date(details.creationDate).toLocaleString()}`);
    outputChannel.appendLine(`Source: ${details.sourceRefName}`);
    outputChannel.appendLine(`Target: ${details.targetRefName}`);
    outputChannel.appendLine(`Description:\n${details.description || 'No description'}`);
}

// Build monitoring
async function showBuildStatusCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        const builds = await azureDevOpsAPI.getBuilds();
        
        if (builds.length === 0) {
            vscode.window.showInformationMessage('No builds found');
            return;
        }
        
        const items = builds.map(build => ({
            label: `$(pulse) ${build.definition.name} - Build #${build.buildNumber}`,
            description: `${build.status} ${build.result ? `• ${build.result}` : ''}`,
            detail: `Started: ${new Date(build.startTime).toLocaleString()}`,
            build
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a build to view'
        });
        
        if (selected) {
            await showBuildActions(selected.build);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch builds: ${error.message}`);
    }
}

async function showBuildActions(build: Build) {
    const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
    const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');

    const actions = [
        { label: '$(link-external) Open in Browser', value: 'open' },
        { label: '$(output) View Logs', value: 'logs' }
    ];

    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: `Actions for ${build.definition.name} #${build.buildNumber}`
    });

    if (selected?.value === 'open') {
        const buildUrl = `https://dev.azure.com/${org}/${project}/_build/results?buildId=${build.id}`;
        vscode.env.openExternal(vscode.Uri.parse(buildUrl));
    } else if (selected?.value === 'logs') {
        const logsUrl = `https://dev.azure.com/${org}/${project}/_build/results?buildId=${build.id}&view=logs`;
        vscode.env.openExternal(vscode.Uri.parse(logsUrl));
    }
}

async function showPipelinesCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        const pipelines = await azureDevOpsAPI.getPipelines();
        
        if (pipelines.length === 0) {
            vscode.window.showInformationMessage('No pipelines found');
            return;
        }
        
        const items = pipelines.map(pipeline => ({
            label: `$(symbol-event) ${pipeline.name}`,
            description: `ID: ${pipeline.id}`,
            detail: pipeline.folder || 'Root',
            pipeline
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a pipeline'
        });
        
        if (selected) {
            await showPipelineActions(selected.pipeline);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch pipelines: ${error.message}`);
    }
}

async function showPipelineActions(pipeline: any) {
    const actions = [
        { label: '$(play) Run Pipeline', value: 'run' },
        { label: '$(history) View Runs', value: 'runs' },
        { label: '$(link-external) Open in Browser', value: 'open' }
    ];

    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: `Actions for ${pipeline.name}`
    });

    if (selected?.value === 'run') {
        await runSpecificPipeline(pipeline);
    } else if (selected?.value === 'runs') {
        await showPipelineRuns(pipeline);
    } else if (selected?.value === 'open') {
        const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
        const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
        const pipelineUrl = `https://dev.azure.com/${org}/${project}/_build?definitionId=${pipeline.id}`;
        vscode.env.openExternal(vscode.Uri.parse(pipelineUrl));
    }
}

async function runPipelineCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    const pipelines = await azureDevOpsAPI.getPipelines();
    const selected = await vscode.window.showQuickPick(
        pipelines.map(p => ({
            label: p.name,
            pipeline: p
        })),
        { placeHolder: 'Select pipeline to run' }
    );
    
    if (selected) {
        await runSpecificPipeline(selected.pipeline);
    }
}

async function runSpecificPipeline(pipeline: any) {
    // Get current branch if in git repo
    let branch: string | undefined;
    if (await isGitRepository()) {
        try {
            const { stdout } = await execAsync('git branch --show-current', {
                cwd: vscode.workspace.workspaceFolders![0].uri.fsPath
            });
            branch = stdout.trim();
        } catch {}
    }
    
    const selectedBranch = await vscode.window.showInputBox({
        prompt: 'Branch to run pipeline on (leave empty for default)',
        value: branch
    });
    
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Running pipeline: ${pipeline.name}...`
        }, async () => {
            const run = await azureDevOpsAPI!.runPipeline(pipeline.id, selectedBranch);
            vscode.window.showInformationMessage(`Pipeline started! Run ID: ${run.id}`);
        });
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to run pipeline: ${error.message}`);
    }
}

async function showPipelineRuns(pipeline: any) {
    try {
        const runs = await azureDevOpsAPI!.getPipelineRuns(pipeline.id);
        
        if (runs.length === 0) {
            vscode.window.showInformationMessage('No runs found for this pipeline');
            return;
        }
        
        const items = runs.map(run => ({
            label: `Run #${run.id}`,
            description: `${run.state} • ${run.result || 'In Progress'}`,
            detail: `Started: ${new Date(run.createdDate).toLocaleString()}`,
            run
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a run to view'
        });
        
        if (selected) {
            await showPipelineRunActions(pipeline, selected.run);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch pipeline runs: ${error.message}`);
    }
}

async function showPipelineRunActions(pipeline: any, run: any) {
    const actions = [
        { label: '$(output) View Logs', value: 'logs' },
        { label: '$(link-external) Open in Browser', value: 'open' }
    ];
    
    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: `Actions for Run #${run.id}`
    });
    
    switch (selected?.value) {
        case 'logs':
            await showPipelineRunLogs(pipeline, run);
            break;
        case 'open':
            const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
            const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
            const runUrl = `https://dev.azure.com/${org}/${project}/_build/results?buildId=${run.id}`;
            vscode.env.openExternal(vscode.Uri.parse(runUrl));
            break;
    }
}

async function showPipelineRunLogs(pipeline: any, run: any) {
    try {
        const logs = await azureDevOpsAPI!.getPipelineRunLogs(pipeline.id, run.id);
        
        // Show logs in output channel
        const outputChannel = vscode.window.createOutputChannel(`Pipeline Logs - ${pipeline.name} #${run.id}`);
        outputChannel.show();
        outputChannel.append(logs);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch logs: ${error.message}`);
    }
}

async function monitorBuilds() {
    if (!azureDevOpsAPI || !vscode.workspace.getConfiguration('azureDevOps').get<boolean>('showBuildNotifications')) {
        return;
    }
    
    // Check builds every minute
    buildMonitoringInterval = setInterval(async () => {
        try {
            const builds = await azureDevOpsAPI!.getBuilds(undefined, 5);
            const latestBuild = builds[0];
            
            if (latestBuild) {
                updateBuildStatusBar(latestBuild);
                
                // Check if build just failed
                const lastKnownBuildId = context.globalState.get<number>('lastBuildId');
                if (lastKnownBuildId !== latestBuild.id && latestBuild.result === 'failed') {
                    vscode.window.showWarningMessage(
                        `Build failed: ${latestBuild.definition.name} #${latestBuild.buildNumber}`,
                        'View Build'
                    ).then(selection => {
                        if (selection === 'View Build') {
                            const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
                            const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
                            const buildUrl = `https://dev.azure.com/${org}/${project}/_build/results?buildId=${latestBuild.id}`;
                            vscode.env.openExternal(vscode.Uri.parse(buildUrl));
                        }
                    });
                }
                
                context.globalState.update('lastBuildId', latestBuild.id);
            }
        } catch (error) {
            console.error('Failed to monitor builds:', error);
        }
    }, 60000); // Check every minute
}

function updateBuildStatusBar(build: Build) {
    // Build status bar is disabled - no footer notifications
    return;
    
    // const icon = build.status === 'completed' 
    //     ? (build.result === 'succeeded' ? '$(check)' : '$(x)')
    //     : '$(sync~spin)';
    
    // buildStatusBarItem.text = `${icon} ${build.definition.name} #${build.buildNumber}`;
    // buildStatusBarItem.tooltip = `Status: ${build.status}\nResult: ${build.result || 'In Progress'}\nClick to view`;
    // buildStatusBarItem.command = 'azureDevOps.showBuildStatus';
    
    // buildStatusBarItem.backgroundColor = build.result === 'failed'
    //     ? new vscode.ThemeColor('statusBarItem.errorBackground')
    //     : undefined;
    
    // buildStatusBarItem.show();
}

async function isGitRepository(): Promise<boolean> {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) return false;
        
        await execAsync('git rev-parse --git-dir', { 
            cwd: workspaceFolder.uri.fsPath 
        });
        return true;
    } catch {
        return false;
    }
}

function setupAutoRefresh() {
    const interval = vscode.workspace.getConfiguration('azureDevOps').get<number>('workItemRefreshInterval');
    
    // Clear existing interval if any
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = undefined;
    }
    
    if (interval && interval > 0) {
        autoRefreshInterval = setInterval(() => {
            if (webviewProvider && azureDevOpsAPI) {
                webviewProvider.refresh();
            }
        }, interval * 1000);
    }
}


function generateClientId(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Test Management Commands
async function showTestPlansCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        const testPlans = await azureDevOpsAPI.getTestPlans();
        
        if (testPlans.length === 0) {
            vscode.window.showInformationMessage('No test plans found');
            return;
        }
        
        const items = testPlans.map(plan => ({
            label: `$(beaker) ${plan.name}`,
            description: `ID: ${plan.id}`,
            detail: `State: ${plan.state}`,
            plan
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a test plan'
        });
        
        if (selected) {
            await showTestPlanActions(selected.plan);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch test plans: ${error.message}`);
    }
}

async function showTestPlanActions(plan: any) {
    const actions = [
        { label: '$(list-tree) View Test Suites', value: 'suites' },
        { label: '$(link-external) Open in Browser', value: 'open' }
    ];

    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: `Actions for ${plan.name}`
    });

    if (selected?.value === 'suites') {
        await showTestSuites(plan);
    } else if (selected?.value === 'open') {
        const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
        const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
        const testUrl = `https://dev.azure.com/${org}/${project}/_testPlans/define?planId=${plan.id}`;
        vscode.env.openExternal(vscode.Uri.parse(testUrl));
    }
}

async function showTestSuites(plan: any) {
    try {
        const suites = await azureDevOpsAPI!.getTestSuites(plan.id);
        
        if (suites.length === 0) {
            vscode.window.showInformationMessage('No test suites found');
            return;
        }
        
        const items = suites.map(suite => ({
            label: `$(folder) ${suite.name}`,
            description: `ID: ${suite.id}`,
            detail: `Test cases: ${suite.testCaseCount || 0}`,
            suite
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a test suite'
        });
        
        if (selected) {
            await showTestCases(plan, selected.suite);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch test suites: ${error.message}`);
    }
}

async function showTestCases(plan: any, suite: any) {
    try {
        const testCases = await azureDevOpsAPI!.getTestCases(plan.id, suite.id);
        
        if (testCases.length === 0) {
            vscode.window.showInformationMessage('No test cases found');
            return;
        }
        
        const items = testCases.map(tc => ({
            label: `$(check) ${tc.workItem.name}`,
            description: `ID: ${tc.workItem.id}`,
            detail: `Priority: ${tc.priority}`,
            testCase: tc
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a test case'
        });
        
        if (selected) {
            // Show test case details
            const outputChannel = vscode.window.createOutputChannel('Test Case Details');
            outputChannel.show();
            outputChannel.appendLine(`Name: ${selected.testCase.workItem.name}`);
            outputChannel.appendLine(`ID: ${selected.testCase.workItem.id}`);
            outputChannel.appendLine(`Priority: ${selected.testCase.priority}`);
            outputChannel.appendLine(`State: ${selected.testCase.state}`);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch test cases: ${error.message}`);
    }
}

// Wiki Commands
async function showWikisCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        const wikis = await azureDevOpsAPI.getWikis();
        
        if (wikis.length === 0) {
            vscode.window.showInformationMessage('No wikis found');
            return;
        }
        
        const items = wikis.map(wiki => ({
            label: `$(book) ${wiki.name}`,
            description: wiki.type,
            detail: `Version: ${wiki.version}`,
            wiki
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a wiki'
        });
        
        if (selected) {
            await showWikiActions(selected.wiki);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch wikis: ${error.message}`);
    }
}

async function showWikiActions(wiki: any) {
    const actions = [
        { label: '$(list-tree) Browse Pages', value: 'browse' },
        { label: '$(new-file) Create Page', value: 'create' },
        { label: '$(link-external) Open in Browser', value: 'open' }
    ];

    const selected = await vscode.window.showQuickPick(actions, {
        placeHolder: `Actions for ${wiki.name}`
    });

    if (selected?.value === 'browse') {
        await browseWikiPages(wiki);
    } else if (selected?.value === 'create') {
        await createWikiPage(wiki);
    } else if (selected?.value === 'open') {
        const org = vscode.workspace.getConfiguration('azureDevOps').get<string>('organization');
        const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project');
        const wikiUrl = `https://dev.azure.com/${org}/${project}/_wiki/wikis/${wiki.name}`;
        vscode.env.openExternal(vscode.Uri.parse(wikiUrl));
    }
}

async function browseWikiPages(wiki: any) {
    try {
        const pages = await azureDevOpsAPI!.getWikiPages(wiki.id);
        
        if (pages.length === 0) {
            vscode.window.showInformationMessage('No pages found');
            return;
        }
        
        const items = pages.map(page => ({
            label: `$(file) ${page.path}`,
            description: `Order: ${page.order}`,
            page
        }));
        
        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a page to view'
        });
        
        if (selected) {
            const content = await azureDevOpsAPI!.getWikiPageContent(wiki.id, selected.page.path);
            
            // Create a temporary markdown file and open it
            const doc = await vscode.workspace.openTextDocument({
                content: content,
                language: 'markdown'
            });
            await vscode.window.showTextDocument(doc, { preview: true });
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch wiki pages: ${error.message}`);
    }
}

async function createWikiPage(wiki: any) {
    const path = await vscode.window.showInputBox({
        prompt: 'Enter page path (e.g., /Getting-Started)',
        placeHolder: '/Page-Name'
    });
    if (!path) return;
    
    const content = await vscode.window.showInputBox({
        prompt: 'Enter initial content',
        placeHolder: '# Page Title\n\nPage content...'
    });
    if (!content) return;
    
    try {
        await azureDevOpsAPI!.createWikiPage(wiki.id, path, content);
        vscode.window.showInformationMessage('Wiki page created!');
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create wiki page: ${error.message}`);
    }
}

// Team Capacity Commands
async function showTeamCapacityCommand() {
    if (!azureDevOpsAPI) {
        vscode.window.showErrorMessage('Please setup Azure DevOps connection first');
        return;
    }
    
    try {
        // Get current iteration
        const currentIteration = await azureDevOpsAPI.getCurrentIteration();
        if (!currentIteration) {
            vscode.window.showErrorMessage('No current iteration found');
            return;
        }
        
        // For team capacity, we need team ID - using default team for now
        const project = vscode.workspace.getConfiguration('azureDevOps').get<string>('project')!;
        const teamId = `${project} Team`; // Default team naming convention
        
        const capacity = await azureDevOpsAPI.getTeamCapacity(teamId, currentIteration.id);
        
        // Show capacity in output channel
        const outputChannel = vscode.window.createOutputChannel('Team Capacity');
        outputChannel.show();
        outputChannel.appendLine(`Sprint: ${currentIteration.name}`);
        outputChannel.appendLine(`Dates: ${new Date(currentIteration.attributes.startDate).toLocaleDateString()} - ${new Date(currentIteration.attributes.finishDate).toLocaleDateString()}`);
        outputChannel.appendLine('\nTeam Capacity:');
        outputChannel.appendLine('=================');
        
        let totalCapacity = 0;
        capacity.forEach(member => {
            const dailyCapacity = member.activities?.[0]?.capacityPerDay || 0;
            const daysOff = member.daysOff?.length || 0;
            const sprintDays = currentIteration.attributes.workingDays || 10;
            const memberCapacity = dailyCapacity * (sprintDays - daysOff);
            totalCapacity += memberCapacity;
            
            outputChannel.appendLine(`${member.teamMember.displayName}: ${memberCapacity} hours (${dailyCapacity}h/day, ${daysOff} days off)`);
        });
        
        outputChannel.appendLine(`\nTotal Team Capacity: ${totalCapacity} hours`);
        
        // Also get iteration work items
        const iterationWork = await azureDevOpsAPI.getIterationWorkItems(teamId, currentIteration.id);
        const totalWork = iterationWork.workItemRelations?.reduce((sum: number, wi: any) => {
            return sum + (wi.target?.remainingWork || 0);
        }, 0) || 0;
        
        outputChannel.appendLine(`Total Remaining Work: ${totalWork} hours`);
        outputChannel.appendLine(`Capacity vs Work: ${((totalWork / totalCapacity) * 100).toFixed(1)}% allocated`);
        
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to fetch team capacity: ${error.message}`);
    }
}

async function showWelcomeMessageIfNeeded() {
    const hasShownWelcome = context.globalState.get<boolean>('hasShownWelcome', false);
    
    if (!hasShownWelcome) {
        const message = '$(zap) Welcome to Azure DevOps Code Companion! Get started by setting up your connection to Azure DevOps.';
        const result = await vscode.window.showInformationMessage(
            message,
            'Setup Connection',
            'Later'
        );
        
        if (result === 'Setup Connection') {
            vscode.commands.executeCommand('azureDevOps.setup');
        }
        
        context.globalState.update('hasShownWelcome', true);
    }
}

async function checkMilestones() {
    const workItemsCreated = context.globalState.get<number>('workItemsCreated', 0);
    const timeTracked = context.globalState.get<number>('totalTimeTracked', 0);
    const branchesCreated = context.globalState.get<number>('branchesCreated', 0);
    const hasReviewed = context.globalState.get<boolean>('hasReviewed', false);
    const hasSupported = context.globalState.get<boolean>('hasSupported', false);
    const lastPromptDate = context.globalState.get<number>('lastPromptDate', 0);
    
    const daysSinceLastPrompt = (Date.now() - lastPromptDate) / (1000 * 60 * 60 * 24);
    
    if (daysSinceLastPrompt < 7) {
        return;
    }
    
    // Review milestone: 10 work items or 10 hours tracked
    if (!hasReviewed && (workItemsCreated >= 10 || timeTracked >= 36000)) {
        setTimeout(() => showReviewPrompt(), 5000);
    }
    // Support milestone: 20 work items or 20 hours tracked
    else if (!hasSupported && (workItemsCreated >= 20 || timeTracked >= 72000)) {
        setTimeout(() => showSupportPrompt(), 5000);
    }
}

async function showReviewPrompt() {
    const workItemsCreated = context.globalState.get<number>('workItemsCreated', 0);
    const timeTracked = context.globalState.get<number>('totalTimeTracked', 0);
    const hoursTracked = Math.round(timeTracked / 3600);
    
    const message = `🌟 You've been productive with Azure DevOps Code Companion! ${workItemsCreated} work items managed and ${hoursTracked} hours tracked. Would you mind leaving a quick review?`;
    
    const result = await vscode.window.showInformationMessage(
        message,
        'Leave a Review $(star-full)',
        'Maybe Later',
        'Don\'t Ask Again'
    );
    
    if (result === 'Leave a Review $(star-full)') {
        vscode.commands.executeCommand('azureDevOps.review');
        context.globalState.update('hasReviewed', true);
    } else if (result === 'Don\'t Ask Again') {
        context.globalState.update('hasReviewed', true);
    }
    
    context.globalState.update('lastPromptDate', Date.now());
}

async function showSupportPrompt() {
    const workItemsCreated = context.globalState.get<number>('workItemsCreated', 0);
    const timeTracked = context.globalState.get<number>('totalTimeTracked', 0);
    const hoursTracked = Math.round(timeTracked / 3600);
    
    const message = `☕ Azure DevOps Code Companion has helped you manage ${workItemsCreated} work items and track ${hoursTracked} hours! If it's saving you time, would you consider supporting development?`;
    
    const result = await vscode.window.showInformationMessage(
        message,
        'Support with Coffee ☕',
        'Maybe Later',
        'Already Supported'
    );
    
    if (result === 'Support with Coffee ☕') {
        vscode.commands.executeCommand('azureDevOps.support');
    } else if (result === 'Already Supported') {
        context.globalState.update('hasSupported', true);
        vscode.window.showInformationMessage('Thank you so much for your support! You\'re amazing! 🙏');
    }
    
    context.globalState.update('lastPromptDate', Date.now());
}

// Webview Provider
class AzureDevOpsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    private _view?: vscode.WebviewView;
    private _workItems: WorkItem[] = [];
    private _selectedWorkItem?: WorkItem;
    private _kanbanView: boolean = false;
    private _currentFilters: any = {};
    private _disposables: vscode.Disposable[] = [];

    constructor(private readonly _extensionUri: vscode.Uri) {
        // Load saved filters from global state will be done in resolveWebviewView
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        webviewContext: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this._extensionUri, 'media')
            ]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        // Dispose old listeners before adding new ones
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];

        const messageListener = webviewView.webview.onDidReceiveMessage(async data => {
            try {
            switch (data.type) {
                case 'refresh':
                    await this.refresh();
                    break;
                case 'selectWorkItem':
                    if (!data.id || data.id === undefined || data.id === null) {
                        console.error('selectWorkItem: Invalid or missing work item ID:', data.id);
                        vscode.window.showErrorMessage('Cannot select work item: Invalid work item ID');
                        break;
                    }
                    this._selectedWorkItem = this._workItems.find(wi => wi.fields['System.Id'] === data.id);
                    if (this._selectedWorkItem) {
                        await showWorkItemActions(this._selectedWorkItem);
                    } else {
                        console.error('selectWorkItem: Work item not found for ID:', data.id);
                        vscode.window.showErrorMessage(`Work item not found: ${data.id}`);
                    }
                    break;
                case 'startTimer':
                    if (!data.id || data.id === undefined || data.id === null) {
                        console.error('startTimer: Invalid or missing work item ID:', data.id);
                        vscode.window.showErrorMessage('Cannot start timer: Invalid work item ID');
                        break;
                    }
                    const workItem = this._workItems.find(wi => wi.fields['System.Id'] === data.id);
                    if (workItem) {
                        startTimer(workItem);
                    } else {
                        console.error('startTimer: Work item not found for ID:', data.id);
                        vscode.window.showErrorMessage(`Work item not found: ${data.id}`);
                    }
                    break;
                case 'createBranch':
                    if (!data.id || data.id === undefined || data.id === null) {
                        console.error('createBranch: Invalid or missing work item ID:', data.id);
                        vscode.window.showErrorMessage('Cannot create branch: Invalid work item ID');
                        break;
                    }
                    const branchWorkItem = this._workItems.find(wi => wi.fields['System.Id'] === data.id);
                    if (branchWorkItem) {
                        await createBranchFromWorkItem(branchWorkItem);
                    } else {
                        console.error('createBranch: Work item not found for ID:', data.id);
                        vscode.window.showErrorMessage(`Work item not found: ${data.id}`);
                    }
                    break;
                case 'openInBrowser':
                    if (!data.id || data.id === undefined || data.id === null) {
                        console.error('openInBrowser: Invalid or missing work item ID:', data.id);
                        vscode.window.showErrorMessage('Cannot open in browser: Invalid work item ID');
                        break;
                    }
                    const browserWorkItem = this._workItems.find(wi => wi.fields['System.Id'] === data.id);
                    if (browserWorkItem) {
                        openWorkItemInBrowser(browserWorkItem);
                    } else {
                        console.error('openInBrowser: Work item not found for ID:', data.id);
                        vscode.window.showErrorMessage(`Work item not found: ${data.id}`);
                    }
                    break;
                case 'copyId':
                    if (!data.id || data.id === undefined || data.id === null) {
                        console.error('copyId: Invalid or missing work item ID:', data.id);
                        vscode.window.showErrorMessage('Cannot copy ID: Invalid work item ID');
                        break;
                    }
                    const copyWorkItem = this._workItems.find(wi => wi.fields['System.Id'] === data.id);
                    if (copyWorkItem) {
                        copyWorkItemId(copyWorkItem);
                    } else {
                        console.error('copyId: Work item not found for ID:', data.id);
                        vscode.window.showErrorMessage(`Work item not found: ${data.id}`);
                    }
                    break;
                case 'updateStatus':
                    if (!data.id || data.id === undefined || data.id === null) {
                        console.error('updateStatus: Invalid or missing work item ID:', data.id);
                        vscode.window.showErrorMessage('Cannot update status: Invalid work item ID');
                        break;
                    }
                    const statusWorkItem = this._workItems.find(wi => wi.fields['System.Id'] === data.id);
                    if (statusWorkItem) {
                        await updateWorkItemStatus(statusWorkItem);
                    } else {
                        console.error('updateStatus: Work item not found for ID:', data.id);
                        vscode.window.showErrorMessage(`Work item not found: ${data.id}`);
                    }
                    break;
                case 'search':
                    await this.searchWorkItems(data.query);
                    break;
                case 'filter':
                    this._currentFilters = data.filters;
                    context.globalState.update('azureDevOps.filters', this._currentFilters);
                    await this.filterWorkItems(data.filters);
                    break;
                case 'createWorkItem':
                    await createWorkItemCommand();
                    break;
                case 'toggleKanban':
                    this._kanbanView = !this._kanbanView;
                    context.globalState.update('azureDevOps.kanbanView', this._kanbanView);
                    await this.refresh();
                    break;
                case 'showTimeReport':
                    await showTimeReportCommand();
                    break;
                case 'showPullRequests':
                    await vscode.commands.executeCommand('azureDevOps.showAllPullRequests');
                    break;
                case 'showPipelines':
                    await vscode.commands.executeCommand('azureDevOps.showPipelines');
                    break;
                case 'showBuilds':
                    await vscode.commands.executeCommand('azureDevOps.showBuildStatus');
                    break;
                case 'showTests':
                    await vscode.commands.executeCommand('azureDevOps.showTestPlans');
                    break;
                case 'showWiki':
                    await vscode.commands.executeCommand('azureDevOps.showWikis');
                    break;
                case 'showCapacity':
                    await vscode.commands.executeCommand('azureDevOps.showTeamCapacity');
                    break;
                case 'loadSprints':
                    await this.loadSprints();
                    break;
                case 'pauseTimer':
                    pauseTimerCommand();
                    break;
                case 'resumeTimer':
                    resumeTimerCommand();
                    break;
                case 'stopTimer':
                    stopTimerCommand();
                    break;
            }
            } catch (error: any) {
                console.error('Error handling webview message:', error);
                vscode.window.showErrorMessage(`Error: ${error.message || 'Unknown error occurred'}`);
            }
        });

        this._disposables.push(messageListener);

        // Load saved state from extension context
        this._currentFilters = context.globalState.get('azureDevOps.filters', {});
        this._kanbanView = context.globalState.get('azureDevOps.kanbanView', false);
        
        // Initial load
        this.refresh();
    }

    public async refresh() {
        if (!azureDevOpsAPI) {
            return;
        }

        try {
            const queryType = vscode.workspace.getConfiguration('azureDevOps').get<string>('defaultQuery') || 'My Work Items';
            this._workItems = await azureDevOpsAPI.getWorkItems(queryType);
            
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'workItemsLoaded',
                    workItems: this._workItems,
                    kanbanView: this._kanbanView
                });
                
                // Send saved filters
                if (Object.keys(this._currentFilters).length > 0) {
                    this._view.webview.postMessage({
                        type: 'restoreFilters',
                        filters: this._currentFilters
                    });
                }
                
                // Send current timer state
                if (currentTimer) {
                    this._view.webview.postMessage({
                        type: 'timerUpdate',
                        timer: currentTimer
                    });
                }
            }
        } catch (error) {
            console.error('Failed to refresh work items:', error);
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'error',
                    message: 'Failed to load work items'
                });
            }
        }
    }

    public selectWorkItem(workItem: WorkItem) {
        this._selectedWorkItem = workItem;
        if (this._view) {
            this._view.webview.postMessage({
                type: 'workItemSelected',
                workItem
            });
        }
    }

    public getSelectedWorkItem(): WorkItem | undefined {
        return this._selectedWorkItem;
    }

    public showWorkItems(workItems: WorkItem[]) {
        this._workItems = workItems;
        if (this._view) {
            this._view.webview.postMessage({
                type: 'workItemsLoaded',
                workItems: this._workItems,
                kanbanView: this._kanbanView
            });
        }
    }

    public showWorkItemDetails(workItem: WorkItem) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'showDetails',
                workItem
            });
        }
    }

    public updateTimer(timer: TimerState) {
        if (this._view) {
            this._view.webview.postMessage({
                type: 'timerUpdate',
                timer
            });
        }
    }

    public toggleKanbanView() {
        this._kanbanView = !this._kanbanView;
        this.refresh();
    }

    public showTimeReport(groupedEntries: Map<number, { total: number, entries: TimeEntry[] }>, period: string) {
        if (this._view) {
            const reportData = Array.from(groupedEntries.entries()).map(([workItemId, data]) => ({
                workItemId,
                total: data.total,
                entries: data.entries,
                workItem: this._workItems.find(wi => wi.fields['System.Id'] === workItemId)
            }));

            this._view.webview.postMessage({
                type: 'showTimeReport',
                reportData,
                period
            });
        }
    }

    private async searchWorkItems(query: string) {
        if (!azureDevOpsAPI) return;

        try {
            const workItems = await azureDevOpsAPI.getWorkItems(
                `SELECT [System.Id], [System.Title], [System.State] FROM WorkItems 
                 WHERE [System.Title] CONTAINS '${query}' OR [System.Id] = '${query}'
                 ORDER BY [System.ChangedDate] DESC`
            );
            
            this.showWorkItems(workItems);
        } catch (error) {
            console.error('Search failed:', error);
        }
    }

    private async filterWorkItems(filters: any) {
        if (!azureDevOpsAPI) return;

        let wiql = 'SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [System.AssignedTo], [System.IterationPath] FROM WorkItems WHERE ';
        const conditions: string[] = [];

        // Sprint filter
        if (filters.sprint && filters.sprint !== 'All') {
            if (filters.sprint === '@CurrentIteration') {
                conditions.push('[System.IterationPath] UNDER @CurrentIteration');
            } else {
                conditions.push(`[System.IterationPath] = '${filters.sprint}'`);
            }
        }

        // Include specific state (when clicking on status badge)
        if (filters.includeState) {
            conditions.push(`[System.State] = '${filters.includeState}'`);
        } 
        // Exclude states filter
        else if (filters.excludeStates && filters.excludeStates.length > 0) {
            filters.excludeStates.forEach((state: string) => {
                conditions.push(`[System.State] <> '${state}'`);
            });
        }
        
        if (filters.type && filters.type !== 'All') {
            conditions.push(`[System.WorkItemType] = '${filters.type}'`);
        }
        
        if (filters.assignedTo === 'Me') {
            conditions.push('[System.AssignedTo] = @Me');
        } else if (filters.assignedTo === 'Unassigned') {
            conditions.push('[System.AssignedTo] = ""');
        }

        if (conditions.length === 0) {
            conditions.push('[System.State] <> "Removed"');
        }

        wiql += conditions.join(' AND ') + ' ORDER BY [System.ChangedDate] DESC';

        try {
            const workItems = await azureDevOpsAPI.getWorkItems(wiql);
            this.showWorkItems(workItems);
        } catch (error) {
            console.error('Filter failed:', error);
        }
    }
    
    private async loadSprints() {
        if (!azureDevOpsAPI) return;
        
        try {
            const sprints = await azureDevOpsAPI.getIterations();
            const currentSprint = await azureDevOpsAPI.getCurrentIteration();
            
            if (this._view) {
                this._view.webview.postMessage({
                    type: 'sprintsLoaded',
                    sprints,
                    currentSprint
                });
            }
        } catch (error) {
            console.error('Failed to load sprints:', error);
        }
    }

    public dispose() {
        // Clean up disposables
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];

        // Clean up webview resources
        if (this._view) {
            this._view = undefined;
        }
        this._workItems = [];
        this._selectedWorkItem = undefined;
        this._currentFilters = {};
    }
    
    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css'));
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.js'));

        const nonce = getNonce();

        return `<!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <link href="${styleUri}" rel="stylesheet">
                <title>Azure DevOps Work Items</title>
            </head>
            <body>
                <div class="container">
                    <div class="header">
                        <h3>Work Items</h3>
                        <div class="header-actions">
                            <button class="icon-button" data-action="refresh" title="Refresh">
                                <i class="codicon codicon-refresh"></i>
                            </button>
                            <button class="icon-button" data-action="createWorkItem" title="Create Work Item">
                                <i class="codicon codicon-add"></i>
                            </button>
                            <button class="icon-button" data-action="toggleKanban" title="Toggle Kanban View">
                                <i class="codicon codicon-layout"></i>
                            </button>
                            <button class="icon-button" data-action="showTimeReport" title="Time Report">
                                <i class="codicon codicon-graph"></i>
                            </button>
                        </div>
                    </div>
                    
                    <div class="quick-actions">
                        <button class="action-button" data-action="showPullRequests" title="Pull Requests">
                            <i class="codicon codicon-git-pull-request"></i> PRs
                        </button>
                        <button class="action-button" data-action="showPipelines" title="Pipelines">
                            <i class="codicon codicon-symbol-event"></i> Pipelines
                        </button>
                        <button class="action-button" data-action="showBuilds" title="Builds">
                            <i class="codicon codicon-pulse"></i> Builds
                        </button>
                        <button class="action-button" data-action="showTests" title="Test Plans">
                            <i class="codicon codicon-beaker"></i> Tests
                        </button>
                        <button class="action-button" data-action="showWiki" title="Wiki">
                            <i class="codicon codicon-book"></i> Wiki
                        </button>
                        <button class="action-button" data-action="showCapacity" title="Team Capacity">
                            <i class="codicon codicon-organization"></i> Capacity
                        </button>
                    </div>

                    <div class="search-container">
                        <input type="text" id="searchInput" placeholder="Search work items..." />
                        <button data-action="search">Search</button>
                    </div>

                    <div class="status-overview" id="statusOverview">
                        <!-- Status overview will be rendered here -->
                    </div>
                    
                    <div class="filter-container">
                        <div class="filter-row">
                            <select id="sprintFilter" data-action="applyFilters">
                                <option value="All">All Sprints</option>
                                <!-- Sprint options will be populated dynamically -->
                            </select>
                            <select id="typeFilter" data-action="applyFilters">
                                <option value="All">All Types</option>
                                <option value="Task">Task</option>
                                <option value="Bug">Bug</option>
                                <option value="User Story">User Story</option>
                                <option value="Feature">Feature</option>
                            </select>
                            <select id="assignedToFilter" data-action="applyFilters">
                                <option value="All">All Assigned</option>
                                <option value="Me">Assigned to Me</option>
                                <option value="Unassigned">Unassigned</option>
                            </select>
                        </div>
                        <div class="filter-checkboxes">
                            <label class="checkbox-label">
                                <input type="checkbox" id="excludeDone" data-action="applyFilters">
                                <span>Exclude Done</span>
                            </label>
                            <label class="checkbox-label">
                                <input type="checkbox" id="excludeClosed" data-action="applyFilters">
                                <span>Exclude Closed</span>
                            </label>
                            <label class="checkbox-label">
                                <input type="checkbox" id="excludeRemoved" data-action="applyFilters">
                                <span>Exclude Removed</span>
                            </label>
                            <label class="checkbox-label">
                                <input type="checkbox" id="excludeInReview" data-action="applyFilters">
                                <span>Exclude In Review</span>
                            </label>
                        </div>
                    </div>

                    <div id="timer-container" class="timer-container" style="display: none;">
                        <div class="timer-info">
                            <span class="timer-icon"><i class="codicon codicon-clock"></i></span>
                            <span id="timer-display">00:00:00</span>
                            <span id="timer-task"></span>
                        </div>
                        <div class="timer-controls">
                            <button data-action="pauseTimer">Pause</button>
                            <button data-action="stopTimer">Stop</button>
                        </div>
                    </div>

                    <div id="content" class="content">
                        <div class="loading">
                            <i class="codicon codicon-loading codicon-modifier-spin"></i>
                            <p>Loading work items...</p>
                        </div>
                    </div>
                </div>

                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
            </html>`;
    }
}

// NOTE: ~540 lines of inline JavaScript moved to media/sidebar.js for better maintainability
// The external script handles: event delegation, work item rendering, timer display,
// filter management, and webview message handling.

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

// Template Management Functions
async function manageTemplatesCommand() {
    const options = [
        { label: '$(list-tree) View Templates', value: 'view' },
        { label: '$(add) Create Template', value: 'create' },
        { label: '$(edit) Edit Template', value: 'edit' },
        { label: '$(trash) Delete Template', value: 'delete' },
        { label: '$(sync) Reset to Defaults', value: 'reset' }
    ];
    
    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Manage work item templates'
    });
    
    if (!selected) return;
    
    switch (selected.value) {
        case 'view':
            await viewTemplates();
            break;
        case 'create':
            await createTemplate();
            break;
        case 'edit':
            await editTemplate();
            break;
        case 'delete':
            await deleteTemplate();
            break;
        case 'reset':
            const confirm = await vscode.window.showWarningMessage(
                'Reset all templates to defaults?',
                'Yes', 'No'
            );
            if (confirm === 'Yes') {
                context.globalState.update('workItemTemplates', getDefaultTemplates());
                vscode.window.showInformationMessage('Templates reset to defaults');
            }
            break;
    }
}

async function viewTemplates() {
    const templates = context.globalState.get<any[]>('workItemTemplates', getDefaultTemplates());
    
    const selected = await vscode.window.showQuickPick(
        templates.map(t => ({
            label: t.name,
            description: t.type,
            detail: t.description.substring(0, 100) + '...',
            template: t
        })),
        { placeHolder: 'Select a template to view details' }
    );
    
    if (selected) {
        // Show template details in output channel
        const outputChannel = vscode.window.createOutputChannel('Template Details');
        outputChannel.show();
        outputChannel.appendLine(`Name: ${selected.template.name}`);
        outputChannel.appendLine(`Type: ${selected.template.type}`);
        outputChannel.appendLine(`Priority: ${selected.template.priority || 'Default'}`);
        outputChannel.appendLine(`Tags: ${selected.template.tags || 'None'}`);
        outputChannel.appendLine(`Assign To: ${selected.template.assignTo || 'Unassigned'}`);
        outputChannel.appendLine(`\nDescription:\n${selected.template.description}`);
    }
}

async function createTemplate() {
    const name = await vscode.window.showInputBox({
        prompt: 'Template name',
        placeHolder: 'My Template'
    });
    if (!name) return;
    
    const types = ['Task', 'Bug', 'User Story', 'Feature', 'Epic', 'Issue'];
    const type = await vscode.window.showQuickPick(types, {
        placeHolder: 'Select work item type'
    });
    if (!type) return;
    
    const description = await vscode.window.showInputBox({
        prompt: 'Template description/content',
        placeHolder: 'Default description for this type of work item...',
        ignoreFocusOut: true
    });
    if (!description) return;
    
    const tags = await vscode.window.showInputBox({
        prompt: 'Tags (separated by semicolons, optional)',
        placeHolder: 'tag1;tag2'
    });
    
    const templates = context.globalState.get<any[]>('workItemTemplates', getDefaultTemplates());
    templates.push({
        name,
        type,
        description,
        tags: tags || '',
        priority: 2,
        custom: true
    });
    
    await context.globalState.update('workItemTemplates', templates);
    vscode.window.showInformationMessage(`Template '${name}' created!`);
}

async function editTemplate() {
    const templates = context.globalState.get<any[]>('workItemTemplates', getDefaultTemplates());
    const customTemplates = templates.filter(t => t.custom);
    
    if (customTemplates.length === 0) {
        vscode.window.showInformationMessage('No custom templates to edit. Default templates cannot be edited.');
        return;
    }
    
    const selected = await vscode.window.showQuickPick(
        customTemplates.map(t => ({
            label: t.name,
            template: t
        })),
        { placeHolder: 'Select template to edit' }
    );
    
    if (!selected) return;
    
    // For simplicity, allow editing description only
    const newDescription = await vscode.window.showInputBox({
        prompt: 'Edit description',
        value: selected.template.description,
        ignoreFocusOut: true
    });
    
    if (newDescription !== undefined) {
        selected.template.description = newDescription;
        await context.globalState.update('workItemTemplates', templates);
        vscode.window.showInformationMessage('Template updated!');
    }
}

async function deleteTemplate() {
    const templates = context.globalState.get<any[]>('workItemTemplates', getDefaultTemplates());
    const customTemplates = templates.filter(t => t.custom);
    
    if (customTemplates.length === 0) {
        vscode.window.showInformationMessage('No custom templates to delete.');
        return;
    }
    
    const selected = await vscode.window.showQuickPick(
        customTemplates.map(t => ({
            label: t.name,
            template: t
        })),
        { placeHolder: 'Select template to delete' }
    );
    
    if (selected) {
        const index = templates.indexOf(selected.template);
        if (index > -1) {
            templates.splice(index, 1);
            await context.globalState.update('workItemTemplates', templates);
            vscode.window.showInformationMessage(`Template '${selected.template.name}' deleted`);
        }
    }
}

