import type { Deps } from '../app.js';
import { bearerOf } from '../app.js';
import { HttpError } from '../../errors.js';
import {
  ApprovalCreatedSchema,
  ApprovalParams,
  ApprovalRequestBody,
  ApprovalStatusSchema,
  BudgetVerdictSchema,
  CancelStatusSchema,
  DecisionSchema,
  ErrorSchema,
  GateBody,
  RunIdParams,
  RunResultBody,
  StepBody,
  StepCredentialsRequestBody,
  StepCredentialsSchema,
  StepHandoverQuery,
  StepHandoverResultBody,
  StepHandoverSchema,
} from '../schemas.js';
import type { ZApp } from '../zapp.js';

const sec = [{ runToken: [] }];
const tags = ['worker'];

/** Worker node contract: every call carries the signed run token of exactly one run. */
export function registerWorkerRoutes(app: ZApp, { services }: Deps): void {
  const { control } = services;
  const token = (h: Parameters<typeof bearerOf>[0]) => {
    const t = bearerOf(h);
    if (!t) throw new HttpError(401, 'unauthenticated', 'run token required');
    return t;
  };

  app.post(
    '/v1/worker/runs/:id/gate',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Policy gate: decide a tool call before execution',
        security: sec,
        params: RunIdParams,
        body: GateBody,
        response: { 200: DecisionSchema, 401: ErrorSchema },
      },
    },
    async (req) => {
      await control.authorizeStep(token(req), req.params.id, req.body.agentId);
      const d = await control.decide(req.params.id, req.body.agentId, req.body.call);
      return { effect: d.effect, reasons: d.reasons };
    },
  );

  app.post(
    '/v1/worker/runs/:id/steps',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Record a step (with cost and audit entry)',
        security: sec,
        params: RunIdParams,
        body: StepBody,
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeStep(token(req), req.params.id, req.body.agentId);
      await control.recordStep(
        req.params.id,
        req.body,
        claims.sid ? { id: claims.workerId } : undefined,
      );
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/worker/runs/:id/approvals',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Request a human approval',
        security: sec,
        params: RunIdParams,
        body: ApprovalRequestBody,
        response: { 201: ApprovalCreatedSchema },
      },
    },
    async (req, reply) => {
      await control.authorizeStep(token(req), req.params.id, req.body.agentId);
      const approvalId = await control.requestApproval(
        req.params.id,
        req.body.agentId,
        req.body.call,
        req.body.reasons ?? [],
      );
      return reply.status(201).send({ approvalId });
    },
  );

  app.get(
    '/v1/worker/runs/:id/approvals/:approvalId',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Poll an approval',
        security: sec,
        params: ApprovalParams,
        response: { 200: ApprovalStatusSchema },
      },
    },
    async (req) => {
      await control.authorize(token(req), req.params.id);
      return { status: await control.approvalStatus(req.params.id, req.params.approvalId) };
    },
  );

  app.get(
    '/v1/worker/runs/:id/status',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Cancellation flag of a run',
        security: sec,
        params: RunIdParams,
        response: { 200: CancelStatusSchema },
      },
    },
    async (req) => {
      await control.authorize(token(req), req.params.id);
      return { cancelled: await control.isCancelled(req.params.id) };
    },
  );

  app.get(
    '/v1/worker/runs/:id/budget',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Monthly tenant, use case and team budgets of a run (hard stop)',
        security: sec,
        params: RunIdParams,
        response: { 200: BudgetVerdictSchema },
      },
    },
    async (req) => {
      await control.authorize(token(req), req.params.id);
      return services.budgets.verdictForRun(req.params.id);
    },
  );

  app.post(
    '/v1/worker/runs/:id/complete',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Report the final result of a run',
        security: sec,
        params: RunIdParams,
        body: RunResultBody,
      },
    },
    async (req, reply) => {
      await control.authorizeOrchestrator(token(req), req.params.id);
      await control.completeRun(req.params.id, req.body);
      return reply.status(204).send();
    },
  );

  // ---------- run node protocol: step-scoped run tokens only ----------

  app.get(
    '/v1/worker/runs/:id/handover',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Run node: the handover of its own step (spec, input, output schema)',
        security: sec,
        params: RunIdParams,
        querystring: StepHandoverQuery,
        response: { 200: StepHandoverSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(token(req), req.params.id, req.query.agentId);
      reply.header('cache-control', 'no-store');
      return services.runNodes.handover(claims, req.params.id, req.query.agentId);
    },
  );

  app.post(
    '/v1/worker/runs/:id/handover/result',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary: 'Run node: post the final result of its step',
        security: sec,
        params: RunIdParams,
        body: StepHandoverResultBody,
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(token(req), req.params.id, req.body.agentId);
      await services.runNodes.submitResult(claims, req.params.id, req.body);
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/worker/runs/:id/credentials',
    {
      config: { access: 'run-token' },
      schema: {
        tags,
        summary:
          'Credential broker: the secret values of exactly this step, once per step and session',
        security: sec,
        params: RunIdParams,
        body: StepCredentialsRequestBody,
        response: { 200: StepCredentialsSchema, 401: ErrorSchema, 403: ErrorSchema },
      },
    },
    async (req, reply) => {
      const claims = await control.authorizeNodeStep(token(req), req.params.id, req.body.agentId);
      // Values must never be cached by an intermediary or end up in a log.
      reply.header('cache-control', 'no-store');
      return services.runNodes.issueCredentials(claims, req.params.id, req.body.agentId);
    },
  );
}
