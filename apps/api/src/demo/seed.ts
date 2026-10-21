import { randomBytes } from 'node:crypto';
import { CostModel, type Principal, type Role } from '@openagentix/core';
import { createEvent } from '@openagentix/events';
import {
  McpServerConfigSchema,
  ToolGateway,
  demoServerFactories,
  inMemoryServers,
  type Ticket,
} from '@openagentix/mcp';
import { ProviderRegistry, SimulatedProvider } from '@openagentix/providers';
import { InProcessRunner } from '@openagentix/runners';
import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../auth/passwords.js';
import { agents } from '../db/schema.js';
import type { AppContext } from '../context.js';
import { DEFAULT_TENANT_ID, runs, users as usersTable } from '../db/schema.js';
import type { Services } from '../services/index.js';
import { demoId } from './ids.js';
import {
  CVE_TRIAGE,
  FEATURE_BUILDER,
  HARDENING_REVIEW,
  LOG_SUMMARY,
  RELEASE_WATCH,
  TICKET_UPDATER,
} from './agents.js';
