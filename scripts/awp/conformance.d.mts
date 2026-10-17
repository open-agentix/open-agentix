import type * as CoreModule from '../../packages/core/src/index.js';

export type Core = typeof CoreModule;
export const DEFAULT_VENDOR_DIR: string;
export const DEFAULT_EXAMPLES_DIR: string;
export const DEFAULT_CATALOG_FILE: string;
export const DEFAULT_BASELINE_FILE: string;
export const DEFAULT_REPORT_FILE: string;
export const REPORT_VERSION: number;
export const NOTICE: string;

export type CaseStatus = 'pass' | 'fail' | 'skipped';
export interface ReportCase {
  group: 'validator' | 'reference' | 'export' | 'golden';
  id: string;
  file: string;
  status: CaseStatus;
  expect?: string;
  detail?: string;
  [key: string]: unknown;
}
export interface GroupSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  passRate: number | null;
}
export interface Report {
  reportVersion: number;
  notice: string;
  suite: { name: string; version: string };
  awp: {
    version: string;
    status: string;
    repository: string;
    commit: string;
    tag: string | null;
  };
  profiles: { suiteDefaults: string[]; validatorSupports: string[] | null };
  summary: GroupSummary & {
    groups: Record<string, GroupSummary>;
    validatorAndExportsAllPass: boolean;
    differAtSupportedProfiles: number;
  };
  cases: ReportCase[];
}
export interface Comparison {
  required: number;
  regressions: { id: string; reason: string }[];
  neverPassed: string[];
}
export interface Engine {
  supportedProfiles?: string[];
  validate(
    source: string,
    options: { profiles: string[]; verifyDigest: boolean },
  ): { findings: { severity: string; code: string; path: string }[] };
}
export interface Reference {
  runSuite(): Promise<{
    results: { id: string; file: string; expect: string; ok: boolean; detail: string }[];
  }>;
  check(
    manifest: unknown,
    profiles: string[],
  ): Promise<{
    valid: boolean;
    diagnostics: { severity: string; code: string; path?: string }[];
    error?: string;
  }>;
  close(): void;
}
export function judgeCase(
  test: { expect: string; code?: string; path?: string },
  errors: { code: string; path: string }[],
): { ok: boolean; detail?: string; codeMatch?: boolean };
export function summarize(cases: ReportCase[]): Report['summary'];
export function sortCases(cases: ReportCase[]): ReportCase[];
export function baselineIds(baseline: unknown): string[];
export function compareToBaseline(report: Pick<Report, 'cases'>, baselines: unknown[]): Comparison;
export function baselineOf(
  report: Pick<Report, 'cases'>,
): { passing: string[] } & Record<string, unknown>;
export function formatSummary(report: Report, comparison?: Comparison | null): string;
export function createReference(vendorDir?: string): Reference;
export function collectReport(input: {
  engine: Engine;
  examples: ExampleExport[];
  goldens: Golden[];
  reference: Reference;
  vendorDir?: string;
}): Promise<Report>;
export function loadCore(distFile?: string): Promise<Core>;
export function createEngine(core: Core): Engine;
export interface ExampleExport {
  file: string;
  outcome: 'exported' | 'refused';
  manifest?: Record<string, unknown>;
  digest?: string;
  profiles?: string[];
  jcs?: string;
  hasGoldenDir?: boolean;
  findings?: { code: string }[];
}
export interface Golden {
  file: string;
  source: string;
  manifest: { metadata: { description?: string } & Record<string, unknown> } & Record<
    string,
    unknown
  >;
  jcs: string;
  export: ExampleExport | null;
}
export function loadExamples(
  core: Core,
  examplesDir?: string,
  catalogFile?: string,
): { examples: ExampleExport[]; goldens: Golden[] };
export function parseArgs(argv: string[]): {
  out: string;
  baselines: string[];
  writeBaseline: boolean;
  baselineOut: string;
  quiet: boolean;
};
export function main(
  argv: string[],
  out?: { log(message: string): void; error(message: string): void },
  deps?: { core?: Core; reference?: Reference },
): Promise<number>;
