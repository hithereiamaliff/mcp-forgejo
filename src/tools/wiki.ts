/**
 * wiki toolset: list, read, create, edit and delete repository wiki pages.
 *
 * Forgejo's wiki API sends and expects page content base64-encoded; these tools
 * encode and decode it, so callers always work with plain markdown.
 *
 * Page names: the API addresses a page by its `sub_url` (shown by
 * forgejo_list_wiki_pages), which is Forgejo's URL-escaped form of the title,
 * e.g. "Home", "Getting-Started" (title "Getting Started") or "Set-up+guide.-"
 * (title "Set-up guide"). sub_url values are sent as-is; anything else is
 * treated as a title and encoded. If Forgejo answers 404, the name is looked up
 * among the page titles and the request is retried once with that page's sub_url.
 */

import { z } from 'zod';
import type { ApiResponse, ForgejoClient } from '../forgejo/client.js';
import { ForgejoError } from '../forgejo/errors.js';
import { compact, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { bullets, firstLine, fmtDate, formatNumber, shortSha, table, truncate, untrusted } from '../utils/format.js';
import { fetchAllPages } from './lookups.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  WRITE,
  WRITE_IDEMPOTENT,
  ToolInputError,
  defineTool,
  formatResult,
  pageFooter,
  pageMeta,
  pageSchema,
  pagination,
  repoRef,
  responseFormatSchema,
  textResult,
} from './shared.js';

/** Revisions come in pages of Forgejo's [git] COMMITS_RANGE_SIZE (default 50); the endpoint has no limit parameter. */
const REVISIONS_PAGE_SIZE = 50;

// =============================================================================
// Schema pieces (factories: call once per field)
// =============================================================================

const pageNameSchema = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('The page\'s sub_url from forgejo_list_wiki_pages (e.g. "Home" or "Getting-Started"); a plain page title usually works too');

const contentSchema = (what: string) => z.string().max(1_000_000).describe(what);

const commitMessageSchema = () => z.string().trim().max(1000).optional().describe('Commit message for the wiki change (optional)');

// =============================================================================
// Helpers
// =============================================================================

/** Already URL-escaped names, as Forgejo returns them in sub_url ("100%25-Free", "Set-up+guide.-"). */
const ESCAPED_NAME = /^(?:[A-Za-z0-9\-_.~+]|%[0-9A-Fa-f]{2})+$/;

/**
 * Path segment for a page name: sub_url values go as-is (re-encoding their "%"
 * or "+" would point at a different page); titles are encoded. "." and ".."
 * would be resolved by the URL parser (path traversal), so they are refused.
 */
export function wikiSegment(name: string): string {
  if (/^(?:\.|%2e){1,2}$/i.test(name)) throw new ToolInputError(`"${name}" is not a valid wiki page name.`);
  return ESCAPED_NAME.test(name) ? name : encodeURIComponent(name);
}

const encodeContent = (text: string): string => Buffer.from(text, 'utf-8').toString('base64');
const decodeContent = (base64: string | null | undefined): string => Buffer.from(base64 ?? '', 'base64').toString('utf-8');

/** The sub_url of the page whose title is `name` (exact match, else a unique case-insensitive match). */
async function findSubUrl(client: ForgejoClient, owner: string, repo: string, name: string): Promise<string> {
  let pages: Json[];
  try {
    pages = await fetchAllPages<Json>(client, repoPath(owner, repo, 'wiki', 'pages'));
  } catch (error) {
    if (error instanceof ForgejoError && error.kind === 'not_found') {
      throw new ToolInputError(`${owner}/${repo} has no wiki pages (the wiki may be empty or disabled, or the repository does not exist).`);
    }
    throw error;
  }
  const exact = pages.filter(p => p.title === name);
  const candidates = exact.length ? exact : pages.filter(p => String(p.title ?? '').toLowerCase() === name.toLowerCase());
  const match = candidates.length === 1 ? candidates[0] : undefined;
  if (!match?.sub_url || match.sub_url === name) {
    throw new ToolInputError(`No wiki page "${name}" in ${owner}/${repo}. Call forgejo_list_wiki_pages and pass the page's sub_url as page_name.`);
  }
  return String(match.sub_url);
}

/**
 * Send a request for one wiki page. On a 404 the name may be a title whose
 * sub_url differs (e.g. titles containing "-"), so look it up and retry once.
 * Returns the response data and the page name that worked.
 */
async function withWikiPage<T>(
  client: ForgejoClient,
  owner: string,
  repo: string,
  name: string,
  send: (segment: string, okStatuses?: number[]) => Promise<ApiResponse<T>>,
): Promise<{ data: T; pageName: string }> {
  const first = await send(wikiSegment(name), [404]);
  if (first.status !== 404) return { data: first.data, pageName: name };
  const subUrl = await findSubUrl(client, owner, repo, name);
  return { data: (await send(wikiSegment(subUrl))).data, pageName: subUrl };
}

function projectWikiCommit(c: Json | null | undefined) {
  if (!c) return undefined;
  return compact({ sha: c.sha, author: c.author?.name, date: c.author?.date ?? c.commiter?.date, message: c.message });
}

function projectWikiPage(p: Json) {
  return compact({
    title: p.title,
    sub_url: p.sub_url,
    html_url: p.html_url,
    commit_count: p.commit_count,
    last_commit: projectWikiCommit(p.last_commit),
  });
}

/** "2026-10-08 06:09 UTC by Alice (abc1234567)" */
function lastEdit(c: Json | null | undefined): string {
  if (!c) return '';
  const date = fmtDate(c.author?.date ?? c.commiter?.date);
  return [date, c.author?.name && `by ${c.author.name}`, c.sha && `(${shortSha(c.sha)})`].filter(Boolean).join(' ');
}

// =============================================================================
// Tools
// =============================================================================

export const listWikiPages = defineTool({
  name: 'forgejo_list_wiki_pages',
  title: 'List wiki pages',
  toolset: 'wiki',
  description:
    'List the pages of a repository wiki with their title, sub_url (the page_name to pass to the other wiki tools) and last edit. ' +
    'Use forgejo_get_wiki_page to read a page.',
  inputSchema: { ...repoRef(), ...pagination(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>(repoPath(owner, repo, 'wiki', 'pages'), {}, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Wiki pages of ${owner}/${repo}`,
              '',
              table(
                ['Title', 'Page name (sub_url)', 'Last edited', 'By'],
                result.items.map(p => [p.title, p.sub_url, fmtDate(p.last_commit?.author?.date ?? p.last_commit?.commiter?.date), p.last_commit?.author?.name]),
              ),
              '',
              pageFooter(result, 'pages'),
            ].join('\n')
          : result.page > 1
            ? pageFooter(result, 'pages')
            : `The wiki of ${owner}/${repo} has no pages.`,
      () => ({ pages: result.items.map(projectWikiPage), ...pageMeta(result) }),
    );
  },
});

export const getWikiPage = defineTool({
  name: 'forgejo_get_wiki_page',
  title: 'Read a wiki page',
  toolset: 'wiki',
  description:
    'Read one wiki page as markdown (decoded from Forgejo\'s base64), with its revision count and last edit. ' +
    'Find page names with forgejo_list_wiki_pages; see the edit history with forgejo_get_wiki_page_revisions.',
  inputSchema: {
    ...repoRef(),
    page_name: pageNameSchema(),
    max_chars: z
      .number()
      .int()
      .min(1000)
      .max(500_000)
      .default(50_000)
      .describe('Cut the content after this many characters (default 50000)'),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, page_name, max_chars, response_format }, ctx) {
    const client = ctx.getClient();
    const { data: page } = await withWikiPage<Json>(client, owner, repo, page_name, (segment, okStatuses) =>
      client.request('GET', repoPath(owner, repo, 'wiki', 'page', segment), { okStatuses }),
    );
    const full = decodeContent(page.content_base64);
    const { text, truncated } = truncate(full, max_chars);
    return formatResult(
      response_format,
      () =>
        [
          `## Wiki page: ${page.title}`,
          '',
          bullets([
            ['Page name (sub_url)', page.sub_url],
            ['Revisions', page.commit_count],
            ['Last edited', lastEdit(page.last_commit)],
            ['Web', page.html_url],
            [
              'Truncated',
              truncated ? `showing the first ${formatNumber(text.length)} of ${formatNumber(full.length)} characters (raise max_chars for more)` : undefined,
            ],
          ]),
          '',
          untrusted(text, `Content of wiki page "${page.title}"`),
        ].join('\n'),
      () => compact({ ...projectWikiPage(page), content: text, truncated: truncated || undefined, total_chars: truncated ? full.length : undefined }),
    );
  },
});

export const getWikiPageRevisions = defineTool({
  name: 'forgejo_get_wiki_page_revisions',
  title: 'Wiki page history',
  toolset: 'wiki',
  description:
    'List the edit history (commits) of one wiki page, newest first: SHA, author, date and commit message. ' +
    `Results come in pages of ${REVISIONS_PAGE_SIZE}; pass a higher \`page\` for older revisions. Use forgejo_get_wiki_page to read the current content.`,
  inputSchema: { ...repoRef(), page_name: pageNameSchema(), page: pageSchema(), response_format: responseFormatSchema() },
  annotations: READ_ONLY,
  async handler({ owner, repo, page_name, page, response_format }, ctx) {
    const client = ctx.getClient();
    const { data, pageName } = await withWikiPage<Json>(client, owner, repo, page_name, (segment, okStatuses) =>
      client.request('GET', repoPath(owner, repo, 'wiki', 'revisions', segment), { query: { page }, okStatuses }),
    );
    const commits: Json[] = Array.isArray(data?.commits) ? data.commits : [];
    const total = typeof data?.count === 'number' ? data.count : null;
    const result = {
      items: commits,
      page,
      limit: REVISIONS_PAGE_SIZE,
      total,
      hasMore: total !== null ? page * REVISIONS_PAGE_SIZE < total : commits.length >= REVISIONS_PAGE_SIZE,
    };
    return formatResult(
      response_format,
      () =>
        commits.length
          ? [
              `## History of wiki page ${pageName} in ${owner}/${repo}`,
              '',
              table(
                ['SHA', 'Author', 'Date', 'Message'],
                commits.map(c => [shortSha(c.sha), c.author?.name, fmtDate(c.author?.date ?? c.commiter?.date), firstLine(c.message).slice(0, 80)]),
              ),
              '',
              pageFooter(result, 'revisions'),
            ].join('\n')
          : page > 1
            ? pageFooter(result, 'revisions')
            : `No revisions found for wiki page ${pageName} in ${owner}/${repo}.`,
      () => ({ page_name: pageName, revisions: commits.map(projectWikiCommit), ...pageMeta(result) }),
    );
  },
});

export const createWikiPage = defineTool({
  name: 'forgejo_create_wiki_page',
  title: 'Create a wiki page',
  toolset: 'wiki',
  description:
    'Create a new wiki page from a title and markdown content (the wiki is created on first use if it is enabled). ' +
    'Fails if a page with that title already exists: use forgejo_update_wiki_page to change an existing page.',
  inputSchema: {
    ...repoRef(),
    title: z.string().trim().min(1).max(255).describe('Page title, e.g. "Getting Started" (becomes the page name)'),
    content: contentSchema('Page content in markdown'),
    message: commitMessageSchema(),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ owner, repo, title, content, message, response_format }, ctx) {
    const client = ctx.getClient();
    const created = await client.post<Json>(repoPath(owner, repo, 'wiki', 'new'), { title, content_base64: encodeContent(content), message });
    return formatResult(
      response_format,
      () => `Created wiki page **${created.title ?? title}** in ${owner}/${repo} (page_name: ${created.sub_url})${created.html_url ? `: ${created.html_url}` : ''}`,
      () => projectWikiPage(created),
    );
  },
});

export const updateWikiPage = defineTool({
  name: 'forgejo_update_wiki_page',
  title: 'Edit a wiki page',
  toolset: 'wiki',
  description:
    'Replace the content of an existing wiki page and/or rename it (new `title`). Content you pass replaces the whole page; ' +
    'read it first with forgejo_get_wiki_page to make a partial edit. Use forgejo_create_wiki_page for new pages.',
  inputSchema: {
    ...repoRef(),
    page_name: pageNameSchema(),
    title: z.string().trim().min(1).max(255).optional().describe('New title (renames the page). Omit to keep the current title.'),
    content: contentSchema('New page content in markdown (replaces the whole page). Omit to keep the current content.').optional(),
    message: commitMessageSchema(),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, page_name, title, content, message, response_format }, ctx) {
    if (title === undefined && content === undefined) throw new ToolInputError('Pass `content`, `title` or both.');
    const client = ctx.getClient();
    // Read the page first: it must exist (Forgejo would otherwise create a new one), and the
    // edit endpoint needs both title and content, so unchanged values are sent back as they are.
    const { data: current, pageName } = await withWikiPage<Json>(client, owner, repo, page_name, (segment, okStatuses) =>
      client.request('GET', repoPath(owner, repo, 'wiki', 'page', segment), { okStatuses }),
    );
    const updated = await client.patch<Json>(repoPath(owner, repo, 'wiki', 'page', wikiSegment(String(current.sub_url ?? pageName))), {
      title: title ?? current.title,
      content_base64: content !== undefined ? encodeContent(content) : (current.content_base64 ?? ''),
      message,
    });
    const changed = [content !== undefined && 'content', title !== undefined && title !== current.title && 'title'].filter(Boolean).join(' and ') || 'nothing';
    return formatResult(
      response_format,
      () =>
        `Updated wiki page **${updated.title ?? title ?? current.title}** in ${owner}/${repo} (changed: ${changed}; page_name: ${updated.sub_url})` +
        `${updated.html_url ? `: ${updated.html_url}` : ''}`,
      () => projectWikiPage(updated),
    );
  },
});

export const deleteWikiPage = defineTool({
  name: 'forgejo_delete_wiki_page',
  title: 'Delete a wiki page',
  toolset: 'wiki',
  description:
    'Delete a wiki page. Its history stays in the wiki\'s git repository, but the page disappears from the wiki. ' +
    'Find the page name with forgejo_list_wiki_pages.',
  inputSchema: { ...repoRef(), page_name: pageNameSchema() },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, page_name }, ctx) {
    const client = ctx.getClient();
    const { pageName } = await withWikiPage(client, owner, repo, page_name, (segment, okStatuses) =>
      client.request('DELETE', repoPath(owner, repo, 'wiki', 'page', segment), { okStatuses }),
    );
    return textResult(`Deleted wiki page ${pageName} from ${owner}/${repo}.`);
  },
});

export const wikiTools = [listWikiPages, getWikiPage, getWikiPageRevisions, createWikiPage, updateWikiPage, deleteWikiPage];
