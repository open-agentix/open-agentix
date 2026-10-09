/**
 * Fixed demo scenarios. Visitors can only pick one of these by id: the event data comes from this
 * table (also re-derived by the worker), never from request input, so no visitor-controlled text
 * ever reaches a language model.
 */
export const DEMO_EVENT_SOURCE = '/demo/scenarios';
export const DEMO_EVENT_TYPE = 'io.openagentix.demo.scenario';
export const DEMO_TRIGGER_PREFIX = 'demo-scenario:';
/**
 * Scenario runs are created in this tenant and nowhere else, whoever asks and whichever tenant
 * they act in (`X-OAX-Tenant`): the agent is looked up by name inside this tenant only.
 */
export const DEMO_SCENARIO_TENANT_SLUG = 'security';

export interface DemoScenario {
  id: string;
  title: string;
  description: string;
  /** Name of the seeded agent that runs the scenario. */
  agent: string;
  /** Fixed event payload. */
  data: Record<string, unknown>;
}

export const DEMO_SCENARIOS: readonly DemoScenario[] = [
  {
    id: 'cve-xz-backdoor',
    title: 'Triage the xz backdoor (CVE-2024-3094)',
    description:
      'A scanner finding arrives for an API image. The agent looks the CVE up and documents it on the ticket.',
    agent: 'cve-triage',
    data: {
      image: 'ghcr.io/example/api:1.4.2',
      finding: { cveId: 'CVE-2024-3094', package: 'xz-utils', installed: '5.6.0' },
      ticket: 'SEC-42',
    },
  },
  {
    id: 'cve-log4shell',
    title: 'Triage Log4Shell (CVE-2021-44228)',
    description: 'The same pipeline for a Java worker image with a critical logging flaw.',
    agent: 'cve-triage',
    data: {
      image: 'ghcr.io/example/worker:0.9.0',
      finding: { cveId: 'CVE-2021-44228', package: 'log4j-core', installed: '2.14.1' },
      ticket: 'SEC-44',
    },
  },
  {
    id: 'cve-http2-rapid-reset',
    title: 'Triage HTTP/2 Rapid Reset (CVE-2023-44487)',
    description: 'A denial-of-service finding on the web front end.',
    agent: 'cve-triage',
    data: {
      image: 'ghcr.io/example/web:2.0.1',
      finding: { cveId: 'CVE-2023-44487', package: 'nghttp2', installed: '1.55.0' },
      ticket: 'SEC-43',
    },
  },
];

export function findDemoScenario(id: string | undefined | null): DemoScenario | undefined {
  return DEMO_SCENARIOS.find((s) => s.id === id);
}

/** Servers the demo agents may use: in-memory demo servers only, no outbound tools. */
export const DEMO_TOOL_SERVERS: readonly string[] = ['cve-db', 'tickets'];
