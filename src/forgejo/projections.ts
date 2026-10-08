/**
 * Compact shapes of Forgejo API objects.
 *
 * Raw API objects are huge (a Repository has ~70 fields, each with a nested
 * owner User). Tools return these projections instead, both for
 * response_format "json" and as the basis of the markdown output, so the model
 * gets the useful fields without burning context.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Json = Record<string, any>;

/** Drop undefined/null/empty-string/empty-array fields so JSON output stays small. */
export function compact<T extends Json>(obj: T): Partial<T> {
  const out: Json = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.startsWith('0001-01-01')) continue; // Forgejo's "never"
    out[key] = value;
  }
  return out as Partial<T>;
}

export const login = (u: Json | null | undefined): string => (u?.login ?? u?.username ?? '') as string;
export const logins = (users: Json[] | null | undefined): string[] => (users ?? []).map(login).filter(Boolean);
export const labelNames = (labels: Json[] | null | undefined): string[] => (labels ?? []).map(l => l?.name).filter(Boolean);

export function projectUser(u: Json) {
  return compact({
    login: login(u),
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    is_admin: u.is_admin,
    description: u.description,
    website: u.website,
    location: u.location,
    visibility: u.visibility,
    followers: u.followers_count,
    following: u.following_count,
    starred_repos: u.starred_repos_count,
    created: u.created,
    last_login: u.last_login,
    html_url: u.html_url,
  });
}

export function projectRepo(r: Json) {
  return compact({
    full_name: r.full_name,
    id: r.id,
    description: r.description,
    private: r.private,
    fork: r.fork,
    parent: r.parent?.full_name,
    mirror: r.mirror,
    template: r.template,
    archived: r.archived,
    empty: r.empty || undefined,
    default_branch: r.default_branch,
    language: r.language,
    topics: r.topics,
    stars: r.stars_count,
    forks: r.forks_count,
    watchers: r.watchers_count,
    open_issues: r.open_issues_count,
    open_pulls: r.open_pr_counter,
    releases: r.release_counter,
    size_kb: r.size,
    website: r.website,
    has_issues: r.has_issues,
    has_pull_requests: r.has_pull_requests,
    has_wiki: r.has_wiki,
    has_actions: r.has_actions,
    has_releases: r.has_releases,
    permissions: r.permissions ? compact({ admin: r.permissions.admin, push: r.permissions.push, pull: r.permissions.pull }) : undefined,
    created_at: r.created_at,
    updated_at: r.updated_at,
    html_url: r.html_url,
    clone_url: r.clone_url,
    ssh_url: r.ssh_url,
    mirror_updated: r.mirror ? r.mirror_updated : undefined,
    original_url: r.original_url,
  });
}

export function projectMilestoneRef(m: Json | null | undefined) {
  return m ? compact({ id: m.id, title: m.title, state: m.state, due_on: m.due_on }) : undefined;
}

export function projectIssue(i: Json, includeBody = false) {
  return compact({
    number: i.number,
    title: i.title,
    state: i.state,
    is_pull_request: i.pull_request ? true : undefined,
    merged: i.pull_request?.merged || undefined,
    repository: i.repository?.full_name,
    author: login(i.user),
    labels: labelNames(i.labels),
    assignees: logins(i.assignees),
    milestone: i.milestone?.title,
    comments: i.comments,
    locked: i.is_locked || undefined,
    due_date: i.due_date,
    ref: i.ref,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    html_url: i.html_url,
    body: includeBody ? i.body : undefined,
  });
}

export function projectPull(p: Json, includeBody = false) {
  return compact({
    number: p.number,
    title: p.title,
    state: p.state,
    draft: p.draft || undefined,
    merged: p.merged,
    mergeable: p.mergeable,
    author: login(p.user),
    head: p.head ? compact({ ref: p.head.ref, sha: p.head.sha, repo: p.head.repo?.full_name }) : undefined,
    base: p.base ? compact({ ref: p.base.ref, sha: p.base.sha, repo: p.base.repo?.full_name }) : undefined,
    labels: labelNames(p.labels),
    assignees: logins(p.assignees),
    requested_reviewers: logins(p.requested_reviewers),
    requested_teams: (p.requested_reviewers_teams ?? []).map((t: Json) => t?.name).filter(Boolean),
    milestone: p.milestone?.title,
    comments: p.comments,
    review_comments: p.review_comments,
    additions: p.additions,
    deletions: p.deletions,
    changed_files: p.changed_files,
    allow_maintainer_edit: p.allow_maintainer_edit,
    merge_base: p.merge_base,
    merge_commit_sha: p.merge_commit_sha,
    merged_by: p.merged ? login(p.merged_by) : undefined,
    created_at: p.created_at,
    updated_at: p.updated_at,
    merged_at: p.merged_at,
    closed_at: p.closed_at,
    due_date: p.due_date,
    html_url: p.html_url,
    body: includeBody ? p.body : undefined,
  });
}

export function projectComment(c: Json) {
  return compact({
    id: c.id,
    author: login(c.user),
    body: c.body,
    created_at: c.created_at,
    updated_at: c.updated_at !== c.created_at ? c.updated_at : undefined,
    html_url: c.html_url,
    attachments: (c.assets ?? []).map((a: Json) => a?.name).filter(Boolean),
  });
}

export function projectCommit(c: Json) {
  const commit = c.commit ?? {};
  return compact({
    sha: c.sha,
    message: commit.message,
    author: commit.author?.name ?? login(c.author),
    author_login: login(c.author) || undefined,
    date: commit.author?.date ?? c.created,
    committer: commit.committer?.name !== commit.author?.name ? commit.committer?.name : undefined,
    verified: commit.verification?.verified || undefined,
    parents: (c.parents ?? []).map((p: Json) => p?.sha).filter(Boolean),
    stats: c.stats ? compact({ additions: c.stats.additions, deletions: c.stats.deletions, total: c.stats.total }) : undefined,
    files: Array.isArray(c.files) ? c.files.map((f: Json) => compact({ filename: f.filename, status: f.status })) : undefined,
    html_url: c.html_url,
  });
}

export function projectBranch(b: Json) {
  return compact({
    name: b.name,
    commit: b.commit?.id,
    commit_message: (b.commit?.message ?? '').split('\n', 1)[0] || undefined,
    commit_date: b.commit?.timestamp,
    protected: b.protected || undefined,
    required_approvals: b.required_approvals || undefined,
    user_can_push: b.user_can_push,
    user_can_merge: b.user_can_merge,
  });
}

export function projectTag(t: Json) {
  return compact({
    name: t.name,
    commit: t.commit?.sha ?? t.id,
    message: t.message,
    zipball_url: t.zipball_url,
  });
}

export function projectLabel(l: Json) {
  return compact({
    id: l.id,
    name: l.name,
    color: l.color ? `#${String(l.color).replace(/^#/, '')}` : undefined,
    description: l.description,
    exclusive: l.exclusive || undefined,
    archived: l.is_archived || undefined,
    scope: l.url && /\/orgs\//.test(l.url) ? 'org' : undefined,
  });
}

export function projectMilestone(m: Json) {
  return compact({
    id: m.id,
    title: m.title,
    state: m.state,
    description: m.description,
    open_issues: m.open_issues,
    closed_issues: m.closed_issues,
    due_on: m.due_on,
    created_at: m.created_at,
    closed_at: m.closed_at,
  });
}

export function projectStatus(s: Json) {
  return compact({
    context: s.context,
    state: s.status ?? s.state,
    description: s.description,
    target_url: s.target_url,
    created_at: s.created_at,
  });
}

export function projectReview(r: Json) {
  return compact({
    id: r.id,
    reviewer: login(r.user) || r.team?.name,
    state: r.state,
    body: r.body,
    commit_id: r.commit_id,
    comments: r.comments_count,
    official: r.official || undefined,
    stale: r.stale || undefined,
    dismissed: r.dismissed || undefined,
    submitted_at: r.submitted_at,
    html_url: r.html_url,
  });
}

export function projectReviewComment(c: Json) {
  return compact({
    id: c.id,
    author: login(c.user),
    path: c.path,
    line: c.position || c.original_position || undefined,
    old_line: c.original_position && c.position !== c.original_position ? c.original_position : undefined,
    body: c.body,
    commit_id: c.commit_id,
    resolver: c.resolver ? login(c.resolver) : undefined,
    created_at: c.created_at,
    html_url: c.html_url,
  });
}

export function projectNotification(n: Json) {
  return compact({
    id: n.id,
    unread: n.unread,
    pinned: n.pinned || undefined,
    repository: n.repository?.full_name,
    type: n.subject?.type,
    title: n.subject?.title,
    state: n.subject?.state,
    html_url: n.subject?.html_url,
    latest_comment_url: n.subject?.latest_comment_html_url,
    updated_at: n.updated_at,
  });
}

export function projectChangedFile(f: Json) {
  return compact({
    filename: f.filename,
    previous_filename: f.previous_filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
  });
}

export function projectRelease(r: Json) {
  return compact({
    id: r.id,
    tag_name: r.tag_name,
    name: r.name,
    target: r.target_commitish,
    draft: r.draft || undefined,
    prerelease: r.prerelease || undefined,
    author: login(r.author),
    body: r.body,
    assets: (r.assets ?? []).map((a: Json) => compact({ id: a.id, name: a.name, size: a.size, download_count: a.download_count, url: a.browser_download_url })),
    created_at: r.created_at,
    published_at: r.published_at,
    html_url: r.html_url,
  });
}

export function projectOrg(o: Json) {
  return compact({
    name: o.name ?? o.username,
    id: o.id,
    full_name: o.full_name,
    description: o.description,
    website: o.website,
    location: o.location,
    email: o.email,
    visibility: o.visibility,
    repo_admin_change_team_access: o.repo_admin_change_team_access,
  });
}

export function projectTeam(t: Json) {
  return compact({
    id: t.id,
    name: t.name,
    description: t.description,
    permission: t.permission,
    includes_all_repositories: t.includes_all_repositories,
    can_create_org_repo: t.can_create_org_repo,
    units: t.units,
    units_map: t.units_map,
    organization: t.organization?.name ?? t.organization?.username,
  });
}
