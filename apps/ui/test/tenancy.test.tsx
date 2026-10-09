import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import de from '../src/i18n/locales/de.json';
import en from '../src/i18n/locales/en.json';
import { TENANT_COLORS, tenantColorIndex, tenantInitials } from '../src/lib/tenant';
import { heading, renderApp } from './utils';

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('tenant colour tokens', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/tokens.css'), 'utf8');
  const pairs = [...css.matchAll(/--tenant-(\d+)-(bg|fg):\s*(#[0-9a-f]{6});/g)];

  it('defines 12 bg/fg pairs for light, dark and the system-dark block', () => {
    expect(pairs.length).toBe(TENANT_COLORS * 2 * 3);
  });

  it('keeps text contrast >= 4.5:1 in every theme block', () => {
    for (let block = 0; block < 3; block++) {
      for (let i = 0; i < TENANT_COLORS; i++) {
        const slice = pairs.slice(block * 24, block * 24 + 24).filter((m) => m[1] === String(i));
        const bg = slice.find((m) => m[2] === 'bg')![3]!;
        const fg = slice.find((m) => m[2] === 'fg')![3]!;
        expect(contrast(bg, fg), `block ${block} token ${i}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('maps a tenant id to a stable index in range', () => {
    const idx = tenantColorIndex('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(idx).toBe(tenantColorIndex('dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
    for (const id of ['a', 'b', 'tenant-3', '00000000-0000-4000-8000-000000000000']) {
      expect(tenantColorIndex(id)).toBeGreaterThanOrEqual(0);
      expect(tenantColorIndex(id)).toBeLessThan(TENANT_COLORS);
    }
  });

  it('derives two initials', () => {
    expect(tenantInitials('Example Org')).toBe('EO');
    expect(tenantInitials('Acme')).toBe('AC');
    expect(tenantInitials('')).toBe('?');
  });
});

describe('tenancy glossary', () => {
  it('uses the recommended terms in EN and DE', () => {
    expect(en.tenancy.organization).toBe('Organization');
    expect(en.tenancy.useCase).toBe('Use case');
    expect(en.tenancy.ownerTeam).toBe('Owner team');
    expect(en.tenancy.scope).toBe('Scope');
    expect(de.tenancy.organization).toBe('Organisation');
    expect(de.tenancy.useCase).toBe('Use Case');
    expect(de.tenancy.ownerTeam).toBe('Owner-Team');
    expect(de.tenancy.tenant).toBe('Tenant');
  });
});

describe('active tenant in the shell', () => {
  it('shows the tenant in the top bar and the sidebar, and in the document title', async () => {
    await renderApp('/');
    await heading(/hello ada admin/i);
    const badges = await screen.findAllByRole('group', { name: 'Active tenant' });
    expect(badges.length).toBe(2);
    for (const b of badges) expect(within(b).getByText('Acme')).toBeInTheDocument();
    await waitFor(() => expect(document.title).toBe('Dashboard · Acme · open-agentix'));
  });

  it('is localised', async () => {
    await renderApp('/', { locale: 'de' });
    expect((await screen.findAllByRole('group', { name: 'Aktiver Tenant' })).length).toBe(2);
  });

  it('shows no tenant UI while signed out', async () => {
    await renderApp('/login', { signedIn: false });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Active tenant' })).not.toBeInTheDocument();
  });
});
