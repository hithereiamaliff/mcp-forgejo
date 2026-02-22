/**
 * Forgejo API Client
 * 
 * Axios-based client for interacting with Forgejo/Gitea REST API v1.
 * Supports authentication via access token passed as constructor param,
 * environment variable, or URL query parameter.
 */

import axios, { AxiosInstance, AxiosError } from 'axios';

export interface ForgejoConfig {
  url: string;
  token: string;
}

export class ForgejoClient {
  private api: AxiosInstance;
  private baseUrl: string;

  constructor(config: ForgejoConfig) {
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.api = axios.create({
      baseURL: `${this.baseUrl}/api/v1`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `token ${config.token}`,
      },
      timeout: 30000,
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private handleError(err: unknown, operation: string): never {
    if (err instanceof AxiosError) {
      const status = err.response?.status || 'unknown';
      const data = err.response?.data;
      const message = typeof data === 'object' && data?.message ? data.message : JSON.stringify(data);
      throw new Error(`${operation} failed (HTTP ${status}): ${message}`);
    }
    throw new Error(`${operation} failed: ${err}`);
  }

  // ========================================================================
  // User
  // ========================================================================

  async getMyUserInfo(): Promise<any> {
    try {
      const { data } = await this.api.get('/user');
      return data;
    } catch (err) {
      this.handleError(err, 'Get user info');
    }
  }

  // ========================================================================
  // Repositories
  // ========================================================================

  async listMyRepos(page = 1, limit = 100): Promise<any[]> {
    try {
      const { data } = await this.api.get('/user/repos', {
        params: { page, limit },
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List repositories');
    }
  }

  async createRepo(options: any): Promise<any> {
    try {
      const { data } = await this.api.post('/user/repos', options);
      return data;
    } catch (err) {
      this.handleError(err, 'Create repository');
    }
  }

  async createOrgRepo(org: string, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/orgs/${org}/repos`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Create org repository');
    }
  }

  async forkRepo(owner: string, repo: string, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/forks`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Fork repository');
    }
  }

  // ========================================================================
  // Branches
  // ========================================================================

  async listBranches(owner: string, repo: string, page = 1, limit = 100): Promise<any[]> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/branches`, {
        params: { page, limit },
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List branches');
    }
  }

  async createBranch(owner: string, repo: string, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/branches`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Create branch');
    }
  }

  async deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    try {
      await this.api.delete(`/repos/${owner}/${repo}/branches/${branch}`);
    } catch (err) {
      this.handleError(err, 'Delete branch');
    }
  }

  // ========================================================================
  // Files
  // ========================================================================

  async getFileContent(owner: string, repo: string, filepath: string, ref?: string): Promise<any> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/contents/${filepath}`, {
        params: ref ? { ref } : undefined,
      });
      return data;
    } catch (err) {
      this.handleError(err, 'Get file content');
    }
  }

  async createFile(owner: string, repo: string, filepath: string, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/contents/${filepath}`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Create file');
    }
  }

  async updateFile(owner: string, repo: string, filepath: string, options: any): Promise<any> {
    try {
      const { data } = await this.api.put(`/repos/${owner}/${repo}/contents/${filepath}`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Update file');
    }
  }

  async deleteFile(owner: string, repo: string, filepath: string, options: any): Promise<void> {
    try {
      await this.api.delete(`/repos/${owner}/${repo}/contents/${filepath}`, { data: options });
    } catch (err) {
      this.handleError(err, 'Delete file');
    }
  }

  // ========================================================================
  // Commits
  // ========================================================================

  async listCommits(owner: string, repo: string, options?: { sha?: string; path?: string; page?: number; limit?: number }): Promise<any[]> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/git/commits`, {
        params: options,
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List commits');
    }
  }

  // ========================================================================
  // Issues
  // ========================================================================

  async listIssues(owner: string, repo: string, options?: any): Promise<any[]> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/issues`, {
        params: options,
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List issues');
    }
  }

  async getIssue(owner: string, repo: string, index: number): Promise<any> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/issues/${index}`);
      return data;
    } catch (err) {
      this.handleError(err, 'Get issue');
    }
  }

  async createIssue(owner: string, repo: string, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/issues`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Create issue');
    }
  }

  async editIssue(owner: string, repo: string, index: number, options: any): Promise<any> {
    try {
      const { data } = await this.api.patch(`/repos/${owner}/${repo}/issues/${index}`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Update issue');
    }
  }

  async addIssueLabels(owner: string, repo: string, index: number, labels: number[]): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/issues/${index}/labels`, { labels });
      return data;
    } catch (err) {
      this.handleError(err, 'Add issue labels');
    }
  }

  // ========================================================================
  // Issue Comments
  // ========================================================================

  async listIssueComments(owner: string, repo: string, index: number, options?: any): Promise<any[]> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/issues/${index}/comments`, {
        params: options,
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List issue comments');
    }
  }

  async getIssueComment(owner: string, repo: string, commentId: number): Promise<any> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/issues/comments/${commentId}`);
      return data;
    } catch (err) {
      this.handleError(err, 'Get issue comment');
    }
  }

  async createIssueComment(owner: string, repo: string, index: number, body: string): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/issues/${index}/comments`, { body });
      return data;
    } catch (err) {
      this.handleError(err, 'Create issue comment');
    }
  }

  async editIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<any> {
    try {
      const { data } = await this.api.patch(`/repos/${owner}/${repo}/issues/comments/${commentId}`, { body });
      return data;
    } catch (err) {
      this.handleError(err, 'Edit issue comment');
    }
  }

  async deleteIssueComment(owner: string, repo: string, commentId: number): Promise<void> {
    try {
      await this.api.delete(`/repos/${owner}/${repo}/issues/comments/${commentId}`);
    } catch (err) {
      this.handleError(err, 'Delete issue comment');
    }
  }

  // ========================================================================
  // Pull Requests
  // ========================================================================

  async listPullRequests(owner: string, repo: string, options?: any): Promise<any[]> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/pulls`, {
        params: options,
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List pull requests');
    }
  }

  async getPullRequest(owner: string, repo: string, index: number): Promise<any> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/pulls/${index}`);
      return data;
    } catch (err) {
      this.handleError(err, 'Get pull request');
    }
  }

  async createPullRequest(owner: string, repo: string, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/pulls`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Create pull request');
    }
  }

  async editPullRequest(owner: string, repo: string, index: number, options: any): Promise<any> {
    try {
      const { data } = await this.api.patch(`/repos/${owner}/${repo}/pulls/${index}`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Update pull request');
    }
  }

  async mergePullRequest(owner: string, repo: string, index: number, options: any): Promise<void> {
    try {
      await this.api.post(`/repos/${owner}/${repo}/pulls/${index}/merge`, options);
    } catch (err) {
      this.handleError(err, 'Merge pull request');
    }
  }

  // ========================================================================
  // Pull Request Reviews
  // ========================================================================

  async listPullReviews(owner: string, repo: string, index: number, options?: any): Promise<any[]> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/pulls/${index}/reviews`, {
        params: options,
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List pull reviews');
    }
  }

  async getPullReview(owner: string, repo: string, index: number, reviewId: number): Promise<any> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}`);
      return data;
    } catch (err) {
      this.handleError(err, 'Get pull review');
    }
  }

  async listPullReviewComments(owner: string, repo: string, index: number, reviewId: number): Promise<any[]> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}/comments`);
      return data;
    } catch (err) {
      this.handleError(err, 'List pull review comments');
    }
  }

  async createPullReview(owner: string, repo: string, index: number, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/pulls/${index}/reviews`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Create pull review');
    }
  }

  async submitPullReview(owner: string, repo: string, index: number, reviewId: number, options: any): Promise<any> {
    try {
      const { data } = await this.api.post(`/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}`, options);
      return data;
    } catch (err) {
      this.handleError(err, 'Submit pull review');
    }
  }

  async dismissPullReview(owner: string, repo: string, index: number, reviewId: number, message: string): Promise<void> {
    try {
      await this.api.post(`/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}/dismissals`, { message });
    } catch (err) {
      this.handleError(err, 'Dismiss pull review');
    }
  }

  async deletePullReview(owner: string, repo: string, index: number, reviewId: number): Promise<void> {
    try {
      await this.api.delete(`/repos/${owner}/${repo}/pulls/${index}/reviews/${reviewId}`);
    } catch (err) {
      this.handleError(err, 'Delete pull review');
    }
  }

  async createReviewRequests(owner: string, repo: string, index: number, options: any): Promise<void> {
    try {
      await this.api.post(`/repos/${owner}/${repo}/pulls/${index}/requested_reviewers`, options);
    } catch (err) {
      this.handleError(err, 'Create review requests');
    }
  }

  async deleteReviewRequests(owner: string, repo: string, index: number, options: any): Promise<void> {
    try {
      await this.api.delete(`/repos/${owner}/${repo}/pulls/${index}/requested_reviewers`, { data: options });
    } catch (err) {
      this.handleError(err, 'Delete review requests');
    }
  }

  // ========================================================================
  // Search
  // ========================================================================

  async searchUsers(keyword: string, page = 1, limit = 100): Promise<any> {
    try {
      const { data } = await this.api.get('/users/search', {
        params: { q: keyword, page, limit },
      });
      return data;
    } catch (err) {
      this.handleError(err, 'Search users');
    }
  }

  async searchRepos(keyword: string, options?: { sort?: string; order?: string; page?: number; limit?: number }): Promise<any> {
    try {
      const { data } = await this.api.get('/repos/search', {
        params: { q: keyword, ...options },
      });
      return data;
    } catch (err) {
      this.handleError(err, 'Search repos');
    }
  }

  async searchOrgTeams(org: string, keyword?: string, page = 1, limit = 100): Promise<any> {
    try {
      const { data } = await this.api.get(`/orgs/${org}/teams/search`, {
        params: { q: keyword, page, limit },
      });
      return data;
    } catch (err) {
      this.handleError(err, 'Search org teams');
    }
  }

  // ========================================================================
  // Actions / Workflows
  // ========================================================================

  async dispatchWorkflow(owner: string, repo: string, workflow: string, options: any): Promise<void> {
    try {
      await this.api.post(`/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`, options);
    } catch (err) {
      this.handleError(err, 'Dispatch workflow');
    }
  }

  async listWorkflowRuns(owner: string, repo: string, options?: any): Promise<any> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/actions/runs`, {
        params: options,
      });
      return data;
    } catch (err) {
      this.handleError(err, 'List workflow runs');
    }
  }

  async getWorkflowRun(owner: string, repo: string, runId: number): Promise<any> {
    try {
      const { data } = await this.api.get(`/repos/${owner}/${repo}/actions/runs/${runId}`);
      return data;
    } catch (err) {
      this.handleError(err, 'Get workflow run');
    }
  }
}
