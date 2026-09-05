import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceService } from '../../application/deviceService.js';
import type { AppConfig } from '../../config.js';
import { createPlannerAuthHook } from '../middleware/plannerAuth.js';
import { createPersonalOsUserHook } from '../middleware/personalOsAuth.js';
import type { IdentityService } from '../../modules/identity/identityService.js';
import type { FinanceService } from '../../application/financeService.js';
import type { FinanceAnalyticsService } from '../../application/financeAnalyticsService.js';

const bucketSchema = z.enum(['LIVING', 'SAFETY', 'GROWTH', 'FUN']);
const kindSchema = z.enum(['ESSENTIAL', 'FIXED', 'DISCRETIONARY', 'OTHER']);
const recurrenceSchema = z.enum(['FIXED', 'VARIABLE']);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const monthSchema = z.string().regex(/^\d{4}-\d{2}$/);
const grainSchema = z.enum(['week', 'month', 'quarter', 'year']);

function requireUserId(request: FastifyRequest): string {
  const userId = request.posUser?.id;
  if (!userId) {
    throw Object.assign(new Error('Sign in with Google to continue'), {
      statusCode: 401,
      code: 'UNAUTHENTICATED',
    });
  }
  return userId;
}

function sendServiceError(reply: FastifyReply, err: unknown) {
  const e = err as { statusCode?: number; code?: string; message?: string; name?: string };
  if (e.name === 'ZodError') {
    return reply.code(400).send({
      error: { code: 'INVALID_INPUT', message: 'Invalid request body' },
    });
  }
  const status = e.statusCode ?? 500;
  return reply.code(status).send({
    error: {
      code: e.code ?? 'INTERNAL',
      message: e.message ?? 'Finance request failed',
    },
  });
}

export async function financeRoutes(
  app: FastifyInstance,
  deps: {
    deviceService: DeviceService;
    config: AppConfig;
    identity: IdentityService;
    finance: FinanceService;
    financeAnalytics: FinanceAnalyticsService;
  },
) {
  const serviceAuth = createPlannerAuthHook(
    deps.deviceService,
    deps.config.PLANNER_WEB_TOKEN,
  );
  const userAuth = createPersonalOsUserHook(deps.identity);
  const auth = [serviceAuth, userAuth];

  app.get('/v2/finance/analytics', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const query = z.object({
        grain: grainSchema.optional(),
        period: z.string().min(4).max(16).optional(),
      }).parse(request.query ?? {});
      return reply.send(await deps.financeAnalytics.getAnalytics(userId, {
        grain: query.grain,
        period: query.period,
      }));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get('/v2/finance/summary', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const query = z.object({ month: monthSchema.optional() }).parse(request.query ?? {});
      const month = query.month ?? new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Ho_Chi_Minh',
        year: 'numeric',
        month: '2-digit',
      }).format(new Date());
      return reply.send(await deps.finance.getSummary(userId, month));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get('/v2/finance/allocation-settings', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      return reply.send(await deps.finance.getAllocationSettings(userId));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.put('/v2/finance/allocation-settings', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z.object({
        livingPct: z.number().int().min(0).max(100),
        safetyPct: z.number().int().min(0).max(100),
        growthPct: z.number().int().min(0).max(100),
        funPct: z.number().int().min(0).max(100),
        safetyTargetMonths: z.union([
          z.literal(3),
          z.literal(6),
          z.literal(9),
          z.literal(12),
        ]).optional(),
        currency: z.string().max(8).optional(),
      }).parse(request.body ?? {});
      return reply.send(await deps.finance.updateAllocationSettings(userId, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get('/v2/finance/income-sources', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      return reply.send({ sources: await deps.finance.listIncomeSources(userId) });
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/finance/income-sources', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z.object({
        name: z.string().trim().min(1).max(120),
        sortOrder: z.number().int().optional(),
      }).parse(request.body ?? {});
      return reply.code(201).send(await deps.finance.createIncomeSource(userId, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.patch('/v2/finance/income-sources/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = z.object({
        name: z.string().trim().min(1).max(120).optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      }).parse(request.body ?? {});
      return reply.send(await deps.finance.patchIncomeSource(userId, id, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.delete('/v2/finance/income-sources/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      return reply.send(await deps.finance.deleteIncomeSource(userId, id));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/finance/income-entries', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z.object({
        sourceId: z.string().min(1),
        amountVnd: z.number().int().nonnegative(),
        receivedAt: dateSchema.optional(),
        note: z.string().max(2000).optional(),
        allocations: z.array(z.object({
          bucket: bucketSchema,
          amountVnd: z.number().int().nonnegative(),
        })).optional(),
      }).parse(request.body ?? {});
      return reply.code(201).send(await deps.finance.createIncomeEntry(userId, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.patch('/v2/finance/income-entries/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = z.object({
        sourceId: z.string().min(1).optional(),
        amountVnd: z.number().int().nonnegative().optional(),
        receivedAt: dateSchema.optional(),
        note: z.string().max(2000).optional(),
      }).parse(request.body ?? {});
      return reply.send(await deps.finance.patchIncomeEntry(userId, id, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.delete('/v2/finance/income-entries/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      return reply.send(await deps.finance.deleteIncomeEntry(userId, id));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get('/v2/finance/expense-categories', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      return reply.send({ categories: await deps.finance.listExpenseCategories(userId) });
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/finance/expense-categories', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z.object({
        name: z.string().trim().min(1).max(120),
        kind: kindSchema.optional(),
        recurrence: recurrenceSchema.optional(),
        defaultBucket: bucketSchema.optional(),
        sortOrder: z.number().int().optional(),
      }).parse(request.body ?? {});
      return reply.code(201).send(await deps.finance.createExpenseCategory(userId, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.patch('/v2/finance/expense-categories/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = z.object({
        name: z.string().trim().min(1).max(120).optional(),
        kind: kindSchema.optional(),
        recurrence: recurrenceSchema.optional(),
        defaultBucket: bucketSchema.optional(),
        active: z.boolean().optional(),
        sortOrder: z.number().int().optional(),
      }).parse(request.body ?? {});
      return reply.send(await deps.finance.patchExpenseCategory(userId, id, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.delete('/v2/finance/expense-categories/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      return reply.send(await deps.finance.deleteExpenseCategory(userId, id));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/finance/expense-entries', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z.object({
        categoryId: z.string().min(1),
        amountVnd: z.number().int().nonnegative(),
        spentAt: dateSchema.optional(),
        note: z.string().max(2000).optional(),
        fundingBucket: bucketSchema.optional(),
      }).parse(request.body ?? {});
      return reply.code(201).send(await deps.finance.createExpenseEntry(userId, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.patch('/v2/finance/expense-entries/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = z.object({
        categoryId: z.string().min(1).optional(),
        amountVnd: z.number().int().nonnegative().optional(),
        spentAt: dateSchema.optional(),
        note: z.string().max(2000).optional(),
        fundingBucket: bucketSchema.optional(),
      }).parse(request.body ?? {});
      return reply.send(await deps.finance.patchExpenseEntry(userId, id, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.delete('/v2/finance/expense-entries/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      return reply.send(await deps.finance.deleteExpenseEntry(userId, id));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get('/v2/finance/debts', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      return reply.send({ debts: await deps.finance.listDebts(userId) });
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/finance/debts', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z.object({
        name: z.string().trim().min(1).max(120),
        outstandingVnd: z.number().int().nonnegative(),
        monthlyRequiredVnd: z.number().int().nonnegative(),
      }).parse(request.body ?? {});
      return reply.code(201).send(await deps.finance.createDebt(userId, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.patch('/v2/finance/debts/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = z.object({
        name: z.string().trim().min(1).max(120).optional(),
        outstandingVnd: z.number().int().nonnegative().optional(),
        monthlyRequiredVnd: z.number().int().nonnegative().optional(),
        active: z.boolean().optional(),
      }).parse(request.body ?? {});
      return reply.send(await deps.finance.patchDebt(userId, id, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.delete('/v2/finance/debts/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      return reply.send(await deps.finance.deleteDebt(userId, id));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.post('/v2/finance/debt-payments', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const body = z.object({
        debtId: z.string().min(1),
        amountVnd: z.number().int().positive(),
        paidAt: dateSchema.optional(),
        note: z.string().max(2000).optional(),
      }).parse(request.body ?? {});
      return reply.code(201).send(await deps.finance.createDebtPayment(userId, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.patch('/v2/finance/debt-payments/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      const body = z.object({
        amountVnd: z.number().int().positive().optional(),
        paidAt: dateSchema.optional(),
        note: z.string().max(2000).optional(),
      }).parse(request.body ?? {});
      return reply.send(await deps.finance.patchDebtPayment(userId, id, body));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.delete('/v2/finance/debt-payments/:id', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const { id } = request.params as { id: string };
      return reply.send(await deps.finance.deleteDebtPayment(userId, id));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });

  app.get('/v2/finance/transactions', { preHandler: auth }, async (request, reply) => {
    try {
      const userId = requireUserId(request);
      const query = z.object({
        type: z.enum(['all', 'income', 'expense', 'debt']).optional(),
        month: monthSchema.optional(),
        sourceId: z.string().optional(),
        categoryId: z.string().optional(),
        limit: z.coerce.number().int().positive().max(500).optional(),
      }).parse(request.query ?? {});
      return reply.send(await deps.finance.listTransactions(userId, query));
    } catch (err) {
      return sendServiceError(reply, err);
    }
  });
}
