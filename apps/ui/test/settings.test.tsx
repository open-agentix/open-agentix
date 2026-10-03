import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { bedrockSnippet, isHttpsUrl } from '../src/features/settings/SettingsPage';
import { api } from './handlers';
import { server } from './server';
import { expectNoA11yViolations, heading, renderApp } from './utils';

describe('settings', () => {
  it('shows providers, runners, auth methods and builds a Bedrock VPC config', async () => {
    const { user } = await renderApp('/settings');
    await heading('Settings');
    expect(await screen.findByText('kubernetes-job')).toBeInTheDocument();
    expect(screen.getByText('Confidential', { selector: '.badge' })).toBeInTheDocument();
    await expectNoA11yViolations();
    const endpoint = screen.getByLabelText(/vpc interface endpoint/i);
    await user.type(endpoint, 'http://insecure');
    expect(screen.getByText('Use an https:// URL.')).toBeInTheDocument();
    await user.clear(endpoint);
    await user.type(endpoint, 'https://vpce-1.bedrock-runtime.eu-central-1.vpce.amazonaws.com');
    await user.type(screen.getByLabelText(/https proxy/i), 'http://proxy.internal:3128');
    expect(screen.getByText(/"proxyUrl": "http:\/\/proxy.internal:3128"/)).toBeInTheDocument();
  });

  it('shows errors', async () => {
    server.use(
      http.get(api('/v1/settings'), () =>
        HttpResponse.json({ error: 'x', message: 'settings down' }, { status: 500 }),
      ),
    );
    await renderApp('/settings');
    expect(await screen.findByText('settings down')).toBeInTheDocument();
  });

  it('builds provider snippets', () => {
    expect(
      JSON.parse(
        bedrockSnippet({ name: '', region: '', endpoint: '', proxyUrl: '', clearance: '' }),
      ),
    ).toEqual([{ name: 'bedrock', kind: 'bedrock', region: 'eu-central-1' }]);
    expect(isHttpsUrl('')).toBe(true);
    expect(isHttpsUrl('nope')).toBe(false);
  });
});
