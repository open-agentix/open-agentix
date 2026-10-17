import {
  exportAwpManifest,
  type ExportFinding,
  type ExportResult,
  type PublishedDefinition,
} from '@openagentix/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { agentVersionAwp, agentVersions, teams } from '../db/schema.js';
import { lockAgent } from './agent-revisions.js';

/**
 * AWP-3b: the effective AWP manifest of a published version, stored next to it (table
 * `agent_version_awp`, migration 0038). AWP is a draft (`v1alpha1`); a stored manifest is a mapping
 * of the stored definition, not a conformance claim. Published content is never rewritten.
 */

/** Identifies the converter that wrote a row (the exporter changes over time; the row does not). */
export const CONVERTER_ID = 'awp-export/1';

export type AwpStatus = 'converted' | 'legacy-unconvertible';
export type StoredAwpRow = typeof agentVersionAwp.$inferSelect;

/** At most this many findings and characters per message are stored (a hostile definition is bounded). */
const MAX_FINDINGS = 200;
const MAX_MESSAGE = 500;

export type Conversion =
  | { status: 'converted'; manifest: Record<string, unknown>; digest: string }
  | { status: 'legacy-unconvertible'; findings: ExportFinding[] };

const bounded = (findings: readonly ExportFinding[]): ExportFinding[] =>
  findings.slice(0, MAX_FINDINGS).map((f) => ({
    ...f,
    path: f.path.slice(0, MAX_MESSAGE),
    message: f.message.slice(0, MAX_MESSAGE),
  }));

/**
 * The strict conversion of one stored definition. It never throws: a conversion that cannot be done
 * (a refusal, or a definition shape the exporter does not understand) is `legacy-unconvertible` with
 * its reasons, and no manifest exists for it. `teamIdOfOwner` resolves the `owner` slug (an AWP owner
 * is a team, decision D15); the slug must be the team the agent belongs to.
 */
export async function convertDefinition(
  agent: { teamId: string | null },
  definition: PublishedDefinition,
  teamIdOfOwner: (slug: string) => Promise<string | null>,
): Promise<Conversion> {
  let result: ExportResult;
  try {
    if (agent.teamId !== null && (await teamIdOfOwner(definition.owner)) !== agent.teamId)
      result = {
        ok: false,
        findings: [
          {
            code: 'owner_team_mismatch',
            path: 'owner',
            message: `owner "${definition.owner}" is not the team of this agent`,
          },
        ],
      };
    else
      result = exportAwpManifest(definition, {
        ownerTeam: agent.teamId === null ? null : definition.owner,
      });
  } catch (e) {
    result = {
      ok: false,
      findings: [
        {
          code: 'conversion_error',
          path: '',
          message: `the stored definition could not be converted: ${(e as Error).message}`,
        },
      ],
    };
  }
  return result.ok
    ? {
        status: 'converted',
        manifest: result.manifest as Record<string, unknown>,
        digest: result.digest,
      }
    : { status: 'legacy-unconvertible', findings: bounded(result.findings) };
}

/** The slug-to-team lookup of one tenant, inside the given transaction or connection. */
export const teamLookup =
  (db: Db, tenantId: string) =>
  async (slug: string): Promise<string | null> => {
    const [t] = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.slug, slug), eq(teams.tenantId, tenantId)));
    return t?.id ?? null;
  };

/**
 * Stores the conversion of a version. Idempotent: a version that has a row keeps it (the table is
 * append-only and a version is converted once). Returns false when a row already existed.
 */
export async function storeConversion(
  db: Db,
  version: { id: string; agentId: string },
  conversion: Conversion,
): Promise<boolean> {
  const rows = await db
    .insert(agentVersionAwp)
    .values({
      versionId: version.id,
      agentId: version.agentId,
      status: conversion.status,
      manifest: conversion.status === 'converted' ? conversion.manifest : null,
      manifestDigest: conversion.status === 'converted' ? conversion.digest : null,
      findings: conversion.status === 'converted' ? [] : conversion.findings,
      converter: CONVERTER_ID,
    })
    .onConflictDoNothing()
    .returning({ id: agentVersionAwp.versionId });
  return rows.length > 0;
}

export interface BackfillResult {
  agents: number;
  converted: number;
  unconvertible: number;
}

const BATCH = 50;

/**
 * The one-time conversion of every published version that has no stored manifest yet. It runs after
 * the schema migration (`oax-api db:migrate` and migrate-on-start). Per agent one transaction that
 * holds the agent lock, so a concurrent publish of that agent waits; a version converted by a
 * concurrent run is skipped (idempotent), re-running converts nothing. Source, digest and definition
 * of a published version are only read.
 */
export async function convertLegacyVersions(
  db: Db,
  onError: (agentId: string, error: unknown) => void = () => undefined,
): Promise<BackfillResult> {
  const total: BackfillResult = { agents: 0, converted: 0, unconvertible: 0 };
  // Every agent is tried once per run: a failing agent stays unconverted (converted on read) and the
  // loop always ends, whatever the data looks like.
  const tried = new Set<string>();
  for (;;) {
    const pending = await db
      .selectDistinct({ agentId: agentVersions.agentId })
      .from(agentVersions)
      .leftJoin(agentVersionAwp, eq(agentVersionAwp.versionId, agentVersions.id))
      .where(isNull(agentVersionAwp.versionId))
      .orderBy(asc(agentVersions.agentId))
      .limit(BATCH + tried.size);
    const todo = pending.map((p) => p.agentId).filter((id) => !tried.has(id));
    if (todo.length === 0) return total;
    for (const agentId of todo) {
      tried.add(agentId);
      try {
        const r = await convertAgent(db, agentId);
        total.agents += 1;
        total.converted += r.converted;
        total.unconvertible += r.unconvertible;
      } catch (e) {
        // left for the read path; the next run tries it again
        onError(agentId, e);
      }
    }
  }
}

async function convertAgent(
  db: Db,
  agentId: string,
): Promise<{ converted: number; unconvertible: number }> {
  return db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const agent = await lockAgent(tx, agentId);
    const versions = await tx
      .select({ v: agentVersions })
      .from(agentVersions)
      .leftJoin(agentVersionAwp, eq(agentVersionAwp.versionId, agentVersions.id))
      .where(and(eq(agentVersions.agentId, agentId), isNull(agentVersionAwp.versionId)))
      .orderBy(asc(agentVersions.publishedAt));
    const lookup = teamLookup(tx, agent.tenantId);
    let converted = 0;
    let unconvertible = 0;
    for (const { v } of versions) {
      const c = await convertDefinition(agent, v.definition as PublishedDefinition, lookup);
      if (await storeConversion(tx, v, c)) {
        if (c.status === 'converted') converted += 1;
        else unconvertible += 1;
      }
    }
    return { converted, unconvertible };
  });
}

/** Rows of the agents in `agentIds` (one tenant is enforced by the caller). */
export async function awpRowOf(db: Db, versionId: string): Promise<StoredAwpRow | undefined> {
  const [row] = await db
    .select()
    .from(agentVersionAwp)
    .where(eq(agentVersionAwp.versionId, versionId));
  return row;
}

/** True when the version was marked `legacy-unconvertible`. */
export async function isUnconvertible(db: Db, versionId: string): Promise<boolean> {
  const row = await awpRowOf(db, versionId);
  return row?.status === 'legacy-unconvertible';
}
