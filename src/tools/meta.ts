/**
 * forgejo_hello: connection check and server info. Always enabled.
 */

import { TOOLSETS, TOOLSET_DESCRIPTIONS } from '../config.js';
import { meetsVersion } from '../forgejo/capabilities.js';
import { ForgejoError } from '../forgejo/errors.js';
import { login } from '../forgejo/projections.js';
import { SERVER_VERSION } from '../version.js';
import { bullets } from '../utils/format.js';
import { defineTool, textResult } from './shared.js';

export const hello = defineTool({
  name: 'forgejo_hello',
  title: 'Check the Forgejo connection',
  toolset: 'meta',
  description:
    'Check that the Forgejo MCP server is working and see how it is connected: server version, Forgejo instance URL and version, ' +
    'the authenticated user, enabled toolsets, read-only mode, and any tools that need a newer Forgejo version. ' +
    'Call this first if other tools fail with authentication or connection errors.',
  inputSchema: {},
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  async handler(_args, ctx) {
    const enabled = TOOLSETS.filter(t => ctx.toolsets.has(t));
    const disabled = TOOLSETS.filter(t => !ctx.toolsets.has(t));
    const lines = [
      `## Forgejo MCP Server v${SERVER_VERSION}`,
      '',
      bullets([
        ['Transport', ctx.transport === 'http' ? 'Streamable HTTP' : 'stdio (local)'],
        ['Connection mode', ctx.authMode],
        ['Read-only mode', ctx.readOnly ? 'on (write tools are hidden)' : 'off'],
        ['Enabled toolsets', enabled.join(', ')],
        ['Tools available', String(ctx.enabledTools.length)],
      ]),
    ];

    if (ctx.connectionProblem) {
      lines.push('', `### Not connected`, '', ctx.connectionProblem);
      return textResult(lines.join('\n'));
    }

    const client = ctx.getClient();
    const caps = await client.capabilities();
    lines.push(
      '',
      '### Forgejo instance',
      '',
      bullets([
        ['URL', client.baseUrl],
        ['Version', caps.version ?? 'unknown (could not read /api/v1/version)'],
        ['Max items per page', String(caps.maxResponseItems)],
        ['Access token', client.hasToken ? 'configured' : 'none (only public data is visible)'],
      ]),
    );

    if (client.hasToken) {
      try {
        const me = await client.get<Record<string, unknown>>('/user');
        lines.push(
          '',
          '### Authenticated user',
          '',
          bullets([
            ['Login', login(me)],
            ['Name', me.full_name],
            ['Site admin', me.is_admin ? 'yes' : undefined],
          ]),
        );
      } catch (error) {
        if (!(error instanceof ForgejoError)) throw error;
        const note =
          error.kind === 'scope'
            ? 'The token has no read:user scope, so the user name is unknown. That is fine for repository-only tokens; tools that need user data will say so.'
            : error.message;
        lines.push('', '### Authenticated user', '', note);
      }
    }

    const gated = ctx.enabledTools.filter(t => t.minVersion && !meetsVersion(caps, t.minVersion));
    if (gated.length) {
      lines.push(
        '',
        `### Needs a newer Forgejo`,
        '',
        `These enabled tools will refuse to run on ${caps.version}: ` + gated.map(t => `${t.name} (≥ ${t.minVersion})`).join(', '),
      );
    }

    if (disabled.length) {
      lines.push(
        '',
        '### More toolsets',
        '',
        'Not enabled for this connection (add them with ?toolsets=default,<name> on the server URL, or FORGEJO_TOOLSETS locally):',
        ...disabled.map(t => `- \`${t}\`: ${TOOLSET_DESCRIPTIONS[t]}`),
      );
    }
    return textResult(lines.join('\n'));
  },
});

export const metaTools = [hello];
