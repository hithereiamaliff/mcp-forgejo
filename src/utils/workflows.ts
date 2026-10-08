/**
 * Summarising Forgejo Actions workflow files (.forgejo/workflows/*.yml).
 *
 * Forgejo has no "list workflows" API, so forgejo_list_workflows reads the
 * files from the repository and summarises each one here: the workflow name,
 * what triggers it (`on:`), its jobs, and the inputs a manual
 * (workflow_dispatch) run accepts. Broken YAML never throws: it comes back as
 * { ok: false, error } so one bad file doesn't hide the others.
 */

import { parse } from 'yaml';

/**
 * Directories Forgejo reads workflows from, in priority order. Forgejo only
 * uses the FIRST one that exists; files in the others are ignored.
 */
export const WORKFLOW_DIRS = ['.forgejo/workflows', '.gitea/workflows', '.github/workflows'] as const;

/** True for file names Forgejo treats as workflows (suffix check is case-sensitive, like Forgejo's). */
export function isWorkflowFile(name: string): boolean {
  return name.endsWith('.yml') || name.endsWith('.yaml');
}

/** One input of a workflow_dispatch trigger. */
export interface DispatchInput {
  name: string;
  type?: string;
  description?: string;
  required?: boolean;
  default?: string;
  /** Allowed values for `type: choice`. */
  options?: string[];
}

export interface WorkflowSummary {
  /** The workflow's `name:` (if set). */
  name?: string;
  /** Event names, e.g. ["push", "workflow_dispatch"]. */
  events: string[];
  /** Readable trigger descriptions, e.g. "push (branches: main)". */
  triggers: string[];
  /** True if the workflow can be started with forgejo_dispatch_workflow. */
  dispatchable: boolean;
  dispatchInputs: DispatchInput[];
  /** Job IDs, with the job's display name in brackets when it differs. */
  jobs: string[];
}

export type WorkflowParseResult = { ok: true; workflow: WorkflowSummary } | { ok: false; error: string };

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Scalars (and lists of scalars) as text; anything else becomes undefined. */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(asText).filter((v): v is string => v !== undefined);
  const single = asText(value);
  return single !== undefined ? [single] : [];
}

/** Trigger filters worth showing, in display order. */
const FILTER_KEYS = ['branches', 'branches-ignore', 'tags', 'tags-ignore', 'paths', 'paths-ignore', 'types'];
const MAX_DETAIL_CHARS = 160;

/** "push" + {branches: [main]} → "push (branches: main)". */
function describeTrigger(event: string, config: unknown): string {
  const details: string[] = [];
  if (event === 'schedule' && Array.isArray(config)) {
    const crons = config.map(entry => (isObject(entry) ? asText(entry.cron) : undefined)).filter(Boolean);
    if (crons.length) details.push(`cron: ${crons.join('; ')}`);
  } else if (isObject(config)) {
    for (const key of FILTER_KEYS) {
      const values = asList(config[key]);
      if (values.length) details.push(`${key}: ${values.join(', ')}`);
    }
  }
  if (!details.length) return event;
  let text = details.join('; ');
  if (text.length > MAX_DETAIL_CHARS) text = `${text.slice(0, MAX_DETAIL_CHARS)}…`;
  return `${event} (${text})`;
}

function dispatchInputs(config: unknown): DispatchInput[] {
  if (!isObject(config) || !isObject(config.inputs)) return [];
  return Object.entries(config.inputs).map(([name, spec]) => {
    if (!isObject(spec)) return { name };
    const options = Array.isArray(spec.options) ? asList(spec.options) : undefined;
    return {
      name,
      type: asText(spec.type),
      description: asText(spec.description),
      required: spec.required === true || spec.required === 'true' ? true : spec.required === false || spec.required === 'false' ? false : undefined,
      default: asText(spec.default),
      options: options?.length ? options : undefined,
    };
  });
}

function jobList(jobs: unknown): string[] {
  if (!isObject(jobs)) return [];
  return Object.entries(jobs).map(([id, job]) => {
    const name = isObject(job) ? asText(job.name) : undefined;
    return name && name !== id ? `${id} (${name})` : id;
  });
}

/** Summarise one workflow file. Never throws. */
export function parseWorkflow(source: string): WorkflowParseResult {
  let doc: unknown;
  try {
    // YAML 1.2 (the yaml package default) keeps `on:` as a string key; under
    // YAML 1.1 it would become the boolean true. maxAliasCount guards against
    // alias-expansion ("billion laughs") documents.
    doc = parse(source, { maxAliasCount: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // First line only (the rest is a source excerpt), without its trailing colon.
    return { ok: false, error: message.split(/\r?\n/, 1)[0].replace(/:\s*$/, '').slice(0, 200) };
  }
  if (!isObject(doc)) {
    return { ok: false, error: 'the file is not a YAML mapping (expected keys such as "on:" and "jobs:")' };
  }

  const on = 'on' in doc ? doc.on : doc.true;
  let events: string[] = [];
  let triggers: string[] = [];
  let inputs: DispatchInput[] = [];
  if (typeof on === 'string') {
    events = [on];
    triggers = [on];
  } else if (Array.isArray(on)) {
    events = asList(on);
    triggers = [...events];
  } else if (isObject(on)) {
    events = Object.keys(on);
    triggers = events.map(event => describeTrigger(event, on[event]));
    inputs = dispatchInputs(on.workflow_dispatch);
  }

  return {
    ok: true,
    workflow: {
      name: asText(doc.name),
      events,
      triggers,
      dispatchable: events.includes('workflow_dispatch'),
      dispatchInputs: inputs,
      jobs: jobList(doc.jobs),
    },
  };
}
