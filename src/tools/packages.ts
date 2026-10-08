/**
 * packages toolset: browse the package registry of a user or organization,
 * inspect one package version and its files, and delete a version.
 *
 * Packages belong to an owner (user or org), not to a repository; a package can
 * optionally be linked to a repository. Each version is a separate entry.
 */

import { z } from 'zod';
import { compact, login, type Json } from '../forgejo/projections.js';
import { bullets, fmtDate, formatBytes, table } from '../utils/format.js';
import {
  DESTRUCTIVE,
  READ_ONLY,
  ToolInputError,
  defineTool,
  formatResult,
  pageFooter,
  pageMeta,
  pagination,
  responseFormatSchema,
  textResult,
} from './shared.js';

/**
 * Package types listed in the Forgejo API docs. Not enforced as an enum: newer
 * Forgejo versions add registries before the API docs list them.
 */
const KNOWN_TYPES =
  'alpine, cargo, chef, composer, conan, conda, container, cran, debian, generic, go, helm, maven, npm, nuget, pub, pypi, rpm, rubygems, swift, vagrant';

// =============================================================================
// Schema pieces (factories: call once per field)
// =============================================================================

const packageOwnerSchema = () =>
  z.string().trim().min(1).max(100).describe('User or organization that owns the packages (e.g. "aliff")');

const packageTypeSchema = (what: string) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(30)
    .regex(/^[a-z0-9_-]+$/, 'Use a package type such as "npm" or "container"')
    .describe(`${what}: one of ${KNOWN_TYPES} (or another type the instance supports)`);

const packageNameSchema = () =>
  z.string().trim().min(1).max(500).describe('Package name as shown by forgejo_list_packages (e.g. "my-lib", "@scope/pkg" or "org/image")');

const packageVersionSchema = () =>
  z.string().trim().min(1).max(500).describe('Package version, e.g. "1.2.0" (for container images: the tag, e.g. "latest")');

// =============================================================================
// Helpers
// =============================================================================

/**
 * One URL path segment. Names may contain "/" (e.g. "@scope/pkg"), so they are fully
 * encoded; "." and ".." would be resolved by the URL parser (path traversal), so they are refused.
 */
function segment(value: string, what: string): string {
  if (/^\.{1,2}$/.test(value)) throw new ToolInputError(`"${value}" is not a valid ${what}.`);
  return encodeURIComponent(value);
}

/** /packages/{owner}/{type}/{name}/{version} */
function packagePath(args: { owner: string; type: string; name: string; version: string }): string {
  return `/packages/${segment(args.owner, 'owner')}/${segment(args.type, 'package type')}/${segment(args.name, 'package name')}/${segment(args.version, 'version')}`;
}

function projectPackage(p: Json) {
  return compact({
    id: p.id,
    type: p.type,
    name: p.name,
    version: p.version,
    owner: login(p.owner),
    creator: login(p.creator),
    repository: p.repository?.full_name,
    created_at: p.created_at,
    html_url: p.html_url,
  });
}

function projectPackageFile(f: Json) {
  return compact({ name: f.name, size: f.Size ?? f.size, sha256: f.sha256 });
}

/** "[owner/repo](url)" for a linked repository, else its name (or nothing). */
function repoLink(r: Json | null | undefined): string {
  if (!r?.full_name) return '';
  return r.html_url ? `[${r.full_name}](${r.html_url})` : String(r.full_name);
}

// =============================================================================
// Tools
// =============================================================================

export const listPackages = defineTool({
  name: 'forgejo_list_packages',
  title: 'List packages',
  toolset: 'packages',
  description:
    'List the packages of a user or organization in the Forgejo package registry: one row per package version, with type, name, ' +
    'version, creation date and linked repository. Filter by `type` (e.g. "npm", "container") and search by name with `query`. ' +
    'Use forgejo_get_package for a version\'s files and checksums.',
  inputSchema: {
    owner: packageOwnerSchema(),
    type: packageTypeSchema('Only this package type').optional(),
    query: z.string().trim().max(200).optional().describe('Search text matched against package names'),
    ...pagination(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ owner, type, query, page, limit, response_format }, ctx) {
    const client = ctx.getClient();
    const result = await client.list<Json>(`/packages/${segment(owner, 'owner')}`, { type, q: query }, { page, limit });
    const filters = [type && `type ${type}`, query && `matching "${query}"`].filter(Boolean).join(', ');
    return formatResult(
      response_format,
      () =>
        result.items.length
          ? [
              `## Packages of ${owner}${filters ? ` (${filters})` : ''}`,
              '',
              table(
                ['Type', 'Name', 'Version', 'Created', 'Repository'],
                result.items.map(p => [p.type, p.name, p.version, fmtDate(p.created_at), repoLink(p.repository)]),
              ),
              '',
              pageFooter(result, 'package versions'),
            ].join('\n')
          : result.page > 1
            ? pageFooter(result, 'package versions')
            : `No packages found for ${owner}${filters ? ` (${filters})` : ''}.`,
      () => ({ packages: result.items.map(projectPackage), ...pageMeta(result) }),
    );
  },
});

export const getPackage = defineTool({
  name: 'forgejo_get_package',
  title: 'Get a package version',
  toolset: 'packages',
  description:
    'Get one version of a package: who published it and when, its linked repository and web page, and its files with sizes and ' +
    'SHA-256 checksums. Use forgejo_list_packages to find the owner, type, name and version.',
  inputSchema: {
    owner: packageOwnerSchema(),
    type: packageTypeSchema('Package type'),
    name: packageNameSchema(),
    version: packageVersionSchema(),
    response_format: responseFormatSchema(),
  },
  annotations: READ_ONLY,
  async handler({ response_format, ...args }, ctx) {
    const client = ctx.getClient();
    const path = packagePath(args);
    const [pkg, files] = await Promise.all([client.get<Json>(path), client.get<Json[]>(`${path}/files`)]);
    const fileList = Array.isArray(files) ? files : [];
    return formatResult(
      response_format,
      () =>
        [
          `## ${pkg.type ?? args.type} package ${pkg.name ?? args.name} ${pkg.version ?? args.version}`,
          '',
          bullets([
            ['ID', pkg.id],
            ['Owner', login(pkg.owner)],
            ['Published by', login(pkg.creator)],
            ['Created', fmtDate(pkg.created_at)],
            ['Repository', repoLink(pkg.repository)],
            ['Web', pkg.html_url],
          ]),
          '',
          `### Files (${fileList.length})`,
          '',
          fileList.length
            ? table(
                ['Name', 'Size', 'SHA-256'],
                fileList.map(f => [f.name, formatBytes(Number(f.Size ?? f.size)), f.sha256]),
              )
            : '_No files._',
        ].join('\n'),
      () => compact({ ...projectPackage(pkg), files: fileList.map(projectPackageFile) }),
    );
  },
});

export const deletePackageVersion = defineTool({
  name: 'forgejo_delete_package_version',
  title: 'Delete a package version',
  toolset: 'packages',
  description:
    'Permanently delete one version of a package (and its files) from the package registry. Other versions are kept; anything ' +
    'that depends on this version will no longer be able to download it. Find versions with forgejo_list_packages.',
  inputSchema: {
    owner: packageOwnerSchema(),
    type: packageTypeSchema('Package type'),
    name: packageNameSchema(),
    version: packageVersionSchema(),
  },
  annotations: DESTRUCTIVE,
  async handler(args, ctx) {
    const client = ctx.getClient();
    await client.delete(packagePath(args));
    return textResult(`Deleted ${args.type} package ${args.name} version ${args.version} (owner ${args.owner}).`);
  },
});

export const packageTools = [listPackages, getPackage, deletePackageVersion];
