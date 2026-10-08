/**
 * releases toolset: list, inspect, create, update and delete releases, plus tag deletion.
 *
 * A release is addressed by its numeric ID or by its tag name. Deleting a
 * release keeps its git tag unless asked otherwise; Forgejo refuses to delete a
 * tag that still has a release, so forgejo_delete_release(delete_tag: true)
 * removes the release first and then the tag.
 */

import { z } from 'zod';
import { ForgejoError } from '../forgejo/errors.js';
import type { ForgejoClient } from '../forgejo/client.js';
import { compact, login, projectRelease, type Json } from '../forgejo/projections.js';
import { repoPath } from '../forgejo/url.js';
import { bullets, fmtDate, formatBytes, formatNumber, table, untrusted } from '../utils/format.js';
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
  pagination,
  refSchema,
  repoRef,
  responseFormatSchema,
  textResult,
} from './shared.js';

// =============================================================================
// Schema pieces (factories: call once per field)
// =============================================================================

const releaseIdSchema = () => z.number().int().positive().describe('Release ID (shown by forgejo_list_releases)');

const tagNameSchema = (what: string) => z.string().trim().min(1).max(250).describe(what);

// =============================================================================
// Helpers
// =============================================================================

/** "draft", "pre-release", "draft, pre-release" or "published". */
function releaseStatus(r: Json): string {
  const tags = [r.draft && 'draft', r.prerelease && 'pre-release'].filter(Boolean);
  return tags.length ? tags.join(', ') : 'published';
}

/**
 * A tag name as one URL path segment. ".." or "." would be resolved by the URL parser
 * (DELETE /repos/o/r/tags/.. would become DELETE /repos/o/r), so they are refused.
 */
function tagSegment(tag: string): string {
  if (/^\.{1,2}$/.test(tag)) throw new ToolInputError(`"${tag}" is not a valid tag name.`);
  return encodeURIComponent(tag);
}

/** API path of one release: by ID, by tag, or the latest published one. */
function releasePath(owner: string, repo: string, sel: { id?: number; tag?: string; latest?: boolean }): string {
  if (sel.id !== undefined) return repoPath(owner, repo, 'releases', sel.id);
  if (sel.tag !== undefined) return repoPath(owner, repo, 'releases', 'tags', tagSegment(sel.tag));
  return repoPath(owner, repo, 'releases', 'latest');
}

/** Throw unless exactly one of the given selectors is set. */
function requireExactlyOne(selected: Record<string, unknown>, message: string): void {
  const count = Object.values(selected).filter(v => v !== undefined && v !== false).length;
  if (count !== 1) throw new ToolInputError(message);
}

/** Release ID for an `id` or `tag` selector (a tag is looked up with GET /releases/tags/{tag}). */
async function resolveReleaseId(client: ForgejoClient, owner: string, repo: string, sel: { id?: number; tag?: string }): Promise<number> {
  if (sel.id !== undefined) return sel.id;
  const release = await client.get<Json>(releasePath(owner, repo, { tag: sel.tag }));
  return Number(release.id);
}

/** List view: no notes, asset count instead of the asset list. */
function releaseSummary(r: Json) {
  const { body: _body, assets: _assets, ...rest } = projectRelease(r);
  return compact({ ...rest, asset_count: (r.assets ?? []).length });
}

/** Full view for JSON output: the projection plus source archive links. */
function releaseDetail(r: Json) {
  return compact({
    ...projectRelease(r),
    hide_archive_links: r.hide_archive_links || undefined,
    tarball_url: r.hide_archive_links ? undefined : r.tarball_url,
    zipball_url: r.hide_archive_links ? undefined : r.zipball_url,
  });
}

function renderReleaseTable(releases: Json[]): string {
  return table(
    ['Tag', 'Name', 'Status', 'Author', 'Published', 'Assets', 'ID'],
    releases.map(r => [r.tag_name, r.name, releaseStatus(r), login(r.author), fmtDate(r.published_at ?? r.created_at), (r.assets ?? []).length, r.id]),
  );
}

function renderRelease(r: Json): string {
  const author = login(r.author);
  const assets: Json[] = r.assets ?? [];
  const lines = [
    `## Release ${r.tag_name}${r.name && r.name !== r.tag_name ? `: ${r.name}` : ''}`,
    '',
    bullets([
      ['ID', r.id],
      ['Tag', r.tag_name],
      ['Target', r.target_commitish],
      ['Status', releaseStatus(r)],
      ['Author', author ? `@${author}` : undefined],
      ['Created', fmtDate(r.created_at)],
      ['Published', r.draft ? undefined : fmtDate(r.published_at)],
      ['Web', r.html_url],
      ['Source archives', r.hide_archive_links ? 'hidden' : [r.tarball_url, r.zipball_url].filter(Boolean)],
    ]),
    '',
    `### Assets (${assets.length})`,
    '',
    assets.length
      ? table(
          ['Name', 'Size', 'Downloads', 'Download URL'],
          assets.map(a => [a.name, formatBytes(Number(a.size)), formatNumber(Number(a.download_count ?? 0)), a.browser_download_url]),
        )
      : '_No assets._',
    '',
    untrusted(r.body, `Release notes${author ? ` by @${author}` : ''}`),
  ];
  return lines.join('\n');
}

/** One-line confirmation for write tools. */
function releaseLine(r: Json, owner: string, repo: string): string {
  const title = r.name && r.name !== r.tag_name ? `**${r.name}** (tag \`${r.tag_name}\`)` : `**${r.tag_name}**`;
  return `${title} in ${owner}/${repo} — ${releaseStatus(r)}, ID ${r.id}${r.html_url ? `: ${r.html_url}` : ''}`;
}

// =============================================================================
// Tools
// =============================================================================

export const listReleases = defineTool({
  name: 'forgejo_list_releases',
  title: 'List releases',
  toolset: 'releases',
  description:
    'List the releases of a repository, newest first, with tag, name, draft/pre-release status, author, publish date and asset count. ' +
    'Filter by draft or pre-release status, or search with `query`. Use forgejo_get_release for release notes and asset download links.',
  inputSchema: {
    ...repoRef(),
    draft: z.boolean().optional().describe('true: only drafts; false: no drafts; omit: both (drafts need write access to see)'),
    prerelease: z.boolean().optional().describe('true: only pre-releases; false: no pre-releases; omit: both'),
    query: z.string().trim().max(200).optional().describe('Search text matched against release titles and tags'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, draft, prerelease, query, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>(repoPath(owner, repo, 'releases'), { draft, 'pre-release': prerelease, q: query }, { page, limit });
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [`## Releases of ${owner}/${repo}`, '', renderReleaseTable(result.items), '', pageFooter(result, 'releases')].join('\n')
          : `No releases found in ${owner}/${repo}${query ? ` matching "${query}"` : ''}.`,
      () => ({ releases: result.items.map(releaseSummary), ...pageMeta(result) }),
    );
  },
});

export const getRelease = defineTool({
  name: 'forgejo_get_release',
  title: 'Get a release',
  toolset: 'releases',
  description:
    'Get one release with its notes and downloadable assets. Pass exactly one of `id`, `tag` (e.g. "v1.2.0") or `latest: true` ' +
    '(the most recent published, non-draft, non-pre-release release). Use forgejo_list_releases to find IDs and tags.',
  inputSchema: {
    ...repoRef(),
    id: releaseIdSchema().optional(),
    tag: tagNameSchema('Tag name of the release, e.g. "v1.2.0"').optional(),
    latest: z.boolean().optional().describe('true: get the latest published release (drafts and pre-releases are skipped)'),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, repo, id, tag, latest, response_format }, ctx) {
    requireExactlyOne({ id, tag, latest }, 'Pass exactly one of `id`, `tag` or `latest: true`.');
    const client = ctx.getClient();
    const release = await client.get<Json>(releasePath(owner, repo, { id, tag, latest }));
    return formatResult(response_format, () => renderRelease(release), () => releaseDetail(release));
  },
});

export const createRelease = defineTool({
  name: 'forgejo_create_release',
  title: 'Create a release',
  toolset: 'releases',
  description:
    'Create a release for a tag, with a title and markdown release notes. If the tag does not exist yet, Forgejo creates it from ' +
    '`target_commitish` (default: the default branch) when the release is published; a draft gets its tag only when it is published. ' +
    'Mark it as a draft or pre-release as needed. Use forgejo_update_release to edit it later (e.g. set draft: false to publish).',
  inputSchema: {
    ...repoRef(),
    tag_name: tagNameSchema('Tag for the release, e.g. "v1.2.0" (an existing tag, or a new one created from target_commitish)'),
    target_commitish: refSchema('Branch or commit SHA to create a new tag from (default: the default branch). Ignored if the tag exists.').optional(),
    name: z.string().trim().max(255).optional().describe('Release title (default: the tag name)'),
    body: z.string().max(100_000).optional().describe('Release notes in markdown'),
    draft: z.boolean().default(false).describe('Create as an unpublished draft (default false)'),
    prerelease: z.boolean().default(false).describe('Mark as a pre-release, e.g. a beta (default false)'),
    hide_archive_links: z.boolean().optional().describe('Hide the automatic source code (zip/tar.gz) download links'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE,
  async handler({ owner, repo, response_format, ...args }, ctx) {
    const client = ctx.getClient();
    const created = await client.post<Json>(repoPath(owner, repo, 'releases'), {
      tag_name: args.tag_name,
      target_commitish: args.target_commitish,
      name: args.name || args.tag_name,
      body: args.body,
      draft: args.draft,
      prerelease: args.prerelease,
      hide_archive_links: args.hide_archive_links,
    });
    return formatResult(response_format, () => `Created release ${releaseLine(created, owner, repo)}`, () => releaseDetail(created));
  },
});

export const updateRelease = defineTool({
  name: 'forgejo_update_release',
  title: 'Update a release',
  toolset: 'releases',
  description:
    'Edit a release found by `id` or `tag` (exactly one): title, notes, tag, target, draft/pre-release flags or archive links. ' +
    'Only the fields you pass are changed. Set draft: false to publish a draft. Use forgejo_get_release to see the current values first.',
  inputSchema: {
    ...repoRef(),
    id: releaseIdSchema().optional(),
    tag: tagNameSchema('Current tag name of the release to edit, e.g. "v1.2.0"').optional(),
    new_tag_name: tagNameSchema('Move the release to this tag (created from target_commitish if it does not exist)').optional(),
    target_commitish: refSchema('Branch or commit SHA for a new tag').optional(),
    name: z.string().trim().min(1).max(255).optional().describe('New release title'),
    body: z.string().max(100_000).optional().describe('New release notes in markdown (replaces the old notes)'),
    draft: z.boolean().optional().describe('false publishes a draft; true turns the release back into a draft'),
    prerelease: z.boolean().optional().describe('Mark or unmark as a pre-release'),
    hide_archive_links: z.boolean().optional().describe('Hide or show the source code (zip/tar.gz) download links'),
    response_format: responseFormatSchema(),
  },
  annotations: WRITE_IDEMPOTENT,
  async handler({ owner, repo, id, tag, new_tag_name, response_format, ...fields }, ctx) {
    requireExactlyOne({ id, tag }, 'Pass exactly one of `id` or `tag` to choose the release.');
    const patch = Object.fromEntries(Object.entries({ ...fields, tag_name: new_tag_name }).filter(([, v]) => v !== undefined));
    if (!Object.keys(patch).length) throw new ToolInputError('Pass at least one field to change (name, body, new_tag_name, target_commitish, draft, prerelease or hide_archive_links).');
    const client = ctx.getClient();
    const releaseId = await resolveReleaseId(client, owner, repo, { id, tag });
    const updated = await client.patch<Json>(repoPath(owner, repo, 'releases', releaseId), patch);
    return formatResult(
      response_format,
      () => `Updated release ${releaseLine(updated, owner, repo)}\nChanged: ${Object.keys(patch).join(', ')}.`,
      () => releaseDetail(updated),
    );
  },
});

export const deleteRelease = defineTool({
  name: 'forgejo_delete_release',
  title: 'Delete a release',
  toolset: 'releases',
  description:
    'Permanently delete a release (and its uploaded assets), found by `id` or `tag` (exactly one). The git tag is kept unless ' +
    '`delete_tag: true`, which also deletes the tag afterwards. To delete only a tag that has no release, use forgejo_delete_tag.',
  inputSchema: {
    ...repoRef(),
    id: releaseIdSchema().optional(),
    tag: tagNameSchema('Tag name of the release to delete, e.g. "v1.2.0"').optional(),
    delete_tag: z.boolean().default(false).describe('Also delete the git tag after deleting the release (default false)'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, id, tag, delete_tag }, ctx) {
    requireExactlyOne({ id, tag }, 'Pass exactly one of `id` or `tag` to choose the release.');
    const client = ctx.getClient();

    let tagName = tag;
    if (id !== undefined) {
      // The tag name is only needed (and only fetched) when the tag goes too.
      if (delete_tag) tagName = String((await client.get<Json>(releasePath(owner, repo, { id }))).tag_name ?? '');
      await client.delete(repoPath(owner, repo, 'releases', id));
    } else {
      await client.delete(releasePath(owner, repo, { tag }));
    }
    const what = `${id !== undefined ? `release ${id}` : 'the release'}${tagName ? ` for tag ${tagName}` : ''} in ${owner}/${repo}`;

    if (!delete_tag) return textResult(`Deleted ${what}. The git tag was kept (delete it with forgejo_delete_tag if needed).`);
    if (!tagName) return textResult(`Deleted ${what}. It had no tag name, so no tag was deleted.`);
    try {
      const res = await client.request('DELETE', repoPath(owner, repo, 'tags', tagSegment(tagName)), { okStatuses: [404] });
      if (res.status === 404) return textResult(`Deleted ${what}. The tag ${tagName} did not exist (draft releases have no tag until published).`);
    } catch (error) {
      if (error instanceof ForgejoError) {
        throw new ForgejoError(error.kind, `Deleted ${what}, but could not delete the tag ${tagName}: ${error.message}`, error.status);
      }
      throw error;
    }
    return textResult(`Deleted ${what} and the tag ${tagName}.`);
  },
});

export const deleteTag = defineTool({
  name: 'forgejo_delete_tag',
  title: 'Delete a tag',
  toolset: 'releases',
  description:
    'Permanently delete a git tag from a repository. Forgejo refuses (HTTP 409) while a release uses the tag: delete the release ' +
    'first, or use forgejo_delete_release with delete_tag: true to remove both. Protected tags cannot be deleted.',
  inputSchema: {
    ...repoRef(),
    tag: tagNameSchema('Name of the tag to delete, e.g. "v1.2.0"'),
  },
  annotations: DESTRUCTIVE,
  async handler({ owner, repo, tag }, ctx) {
    const client = ctx.getClient();
    await client.delete(repoPath(owner, repo, 'tags', tagSegment(tag)));
    return textResult(`Deleted tag ${tag} from ${owner}/${repo}.`);
  },
});

export const releaseTools = [listReleases, getRelease, createRelease, updateRelease, deleteRelease, deleteTag];
