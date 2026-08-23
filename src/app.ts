import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { randomUUID } from 'node:crypto';
import type { AppConfig } from './config.js';
import { DeviceService } from './application/deviceService.js';
import { SyncService } from './application/syncService.js';
import { IntakeService } from './application/intakeService.js';
import { PlanService } from './application/planService.js';
import { WeeklyPlanService } from './application/weeklyPlanService.js';
import { GoalPlanningService } from './application/goalPlanningService.js';
import { PlanningScheduler } from './modules/planning/planningScheduler.js';
import { PreparationService } from './application/preparationService.js';
import { TodayService } from './application/todayService.js';
import { CompletionService } from './application/completionService.js';
import { FeedbackService } from './modules/preparation/feedbackService.js';
import type { Db } from './infrastructure/db/client.js';
import { JobQueue } from './infrastructure/jobs/jobQueue.js';
import { registerPreparationReplaceJob } from './infrastructure/jobs/preparationReplace.js';
import { createLlmProvider } from './infrastructure/providers/llm/index.js';
import { createSearchProvider } from './infrastructure/providers/search/index.js';
import {
  createPlacesProvider,
  createDistanceMatrixProvider,
} from './infrastructure/providers/maps/index.js';
import { FakeCalendarProvider } from './infrastructure/providers/calendar/fakeCalendarProvider.js';
import {
  GoogleCalendarProvider,
  parseConfiguredReadCalendarIds,
} from './infrastructure/providers/calendar/googleCalendarProvider.js';
import { isGoogleCalendarError } from './infrastructure/providers/calendar/googleErrors.js';
import type { CalendarProvider } from './infrastructure/providers/calendar/types.js';
import { IntegrationTokenService } from './modules/integrations/tokenService.js';
import { CalendarPullService } from './modules/integrations/calendarPullService.js';
import { healthRoutes } from './api/routes/health.js';
import { deviceRoutes } from './api/routes/device.js';
import { syncRoutes } from './api/routes/sync.js';
import { intakeRoutes } from './api/routes/intake.js';
import { preparationRoutes } from './api/routes/preparations.js';
import { todayRoutes } from './api/routes/today.js';
import { planRoutes } from './api/routes/plans.js';
import { completionRoutes } from './api/routes/completions.js';
import { peopleRoutes } from './api/routes/people.js';
import { waitingRoutes } from './api/routes/waiting.js';
import { decisionRoutes } from './api/routes/decisions.js';
import { PeopleService } from './modules/people/peopleService.js';
import { WaitingService } from './modules/waiting/waitingService.js';
import { DecisionService } from './modules/decisions/decisionService.js';
import { OpportunityService } from './modules/opportunities/opportunityService.js';
import { OpportunitySuggestService } from './modules/opportunities/suggestService.js';
import { WeekService, runOpportunityScanStub } from './modules/opportunities/weekService.js';
import { opportunityRoutes } from './api/routes/opportunities.js';
import { weekRoutes } from './api/routes/week.js';
import { deviceFcmRoutes } from './api/routes/deviceFcm.js';
import { proactiveRoutes } from './api/routes/proactive.js';
import { integrationRoutes } from './api/routes/integrations.js';
import { learningRoutes } from './api/routes/learning.js';
import { LearningCurriculumService } from './modules/learning/curriculumService.js';
import { createPushProvider, NotificationService } from './infrastructure/notifications/index.js';
import { ProactiveScanService } from './modules/proactive/scanService.js';
import { PlannerV2Service } from './application/plannerV2Service.js';
import { plannerV2Routes } from './api/routes/plannerV2.js';

export type AppDeps = {
  config: AppConfig;
  db: Db;
  jobQueue?: JobQueue;
  /** Test override for push provider */
  pushProvider?: ReturnType<typeof createPushProvider>;
  /** Test override for calendar provider */
  calendarProvider?: CalendarProvider;
};

export type BuiltApp = {
  app: FastifyInstance;
  jobQueue: JobQueue;
  notificationService: NotificationService;
  pushProvider: ReturnType<typeof createPushProvider>;
  calendarProvider: CalendarProvider;
  weeklyPlanService: WeeklyPlanService;
  planningScheduler: PlanningScheduler;
};

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const usePretty =
    deps.config.NODE_ENV === 'development' &&
    !process.env.RAILWAY_ENVIRONMENT &&
    !process.env.RAILWAY_SERVICE_ID;

  const app = Fastify({
    logger: {
      level: deps.config.LOG_LEVEL,
      // pino-pretty is a devDependency and is omitted from the production image.
      transport: usePretty ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    },
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
  });

  await app.register(cors, { origin: true });

  // Android Ktor sets Content-Type: application/json on all requests; body-less POSTs
  // (e.g. /preparations/:id/start) would otherwise fail with FST_ERR_CTP_EMPTY_JSON_BODY.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (req, body, done) => {
      const text = typeof body === 'string' ? body : '';
      if (!text || !text.trim()) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.setErrorHandler((err: unknown, request, reply) => {
    request.log.error(err);
    if (isGoogleCalendarError(err)) {
      return reply.code(err.statusCode).send({
        error: err.toJSON(),
      });
    }
    const error = err as { statusCode?: number; code?: string; name?: string; message?: string };
    const status = error.statusCode ?? 500;
    if (error.name === 'ZodError') {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message ?? 'Validation error',
        },
      });
    }
    return reply.code(status >= 400 && status < 600 ? status : 500).send({
      error: {
        code: error.code ?? 'INTERNAL',
        message: status === 500 ? 'Internal server error' : (error.message ?? 'Error'),
      },
    });
  });

  const jobQueue = deps.jobQueue ?? new JobQueue();
  const searchProvider = createSearchProvider(deps.config);
  const llmProvider = createLlmProvider(deps.config);
  const placesProvider = createPlacesProvider(deps.config);
  const distanceProvider = createDistanceMatrixProvider(deps.config);
  const pushProvider = deps.pushProvider ?? createPushProvider(deps.config);
  const notificationService = new NotificationService(
    deps.db,
    pushProvider,
    deps.config.NOTIFY_MAX_PER_DAY,
  );

  const encryptionKey =
    deps.config.INTEGRATION_ENCRYPTION_KEY ?? deps.config.DEVICE_AUTH_PEPPER;
  const tokenService = new IntegrationTokenService(deps.db, encryptionKey);

  const sharedFakeCalendar = new FakeCalendarProvider();
  const calendarProvider: CalendarProvider =
    deps.calendarProvider ??
    (deps.config.USE_FAKE_PROVIDERS || !deps.config.GOOGLE_OAUTH_CLIENT_ID
      ? sharedFakeCalendar
      : new GoogleCalendarProvider(
          async () => {
            const t = await tokenService.getGoogleCalendarTokens();
            if (!t) return null;
            return {
              accessToken: t.accessToken,
              refreshToken: t.refreshToken,
              expiresAt: t.expiresAt,
            };
          },
          async () => {
            const t = await tokenService.refreshGoogleAccessToken({
              clientId: deps.config.GOOGLE_OAUTH_CLIENT_ID,
              clientSecret: deps.config.GOOGLE_OAUTH_CLIENT_SECRET,
            });
            if (!t) return null;
            return {
              accessToken: t.accessToken,
              refreshToken: t.refreshToken,
              expiresAt: t.expiresAt,
            };
          },
          deps.config.GOOGLE_COS_CALENDAR_ID,
          parseConfiguredReadCalendarIds(deps.config.GOOGLE_READ_CALENDAR_IDS),
        ));

  const calendarPull = new CalendarPullService(
    deps.db,
    calendarProvider,
    jobQueue,
    notificationService,
    () => tokenService.isGoogleCalendarConnected(),
  );

  const deviceService = new DeviceService(deps.db, deps.config.DEVICE_AUTH_PEPPER);
  const syncService = new SyncService(deps.db);
  const preparationService = new PreparationService(
    deps.db,
    searchProvider,
    llmProvider,
    placesProvider,
    distanceProvider,
  );
  preparationService.setNotificationService(notificationService);
  const planService = new PlanService(deps.db, jobQueue);
  planService.setNotificationService(notificationService);
  planService.setCalendarProvider(calendarProvider);
  jobQueue.setDatabase(deps.db);
  const weeklyPlanService = new WeeklyPlanService(deps.db, jobQueue, planService);
  const goalPlanningService = new GoalPlanningService(deps.db);
  const planningScheduler = new PlanningScheduler(deps.db, jobQueue);
  const intakeService = new IntakeService(deps.db, llmProvider, jobQueue);
  const todayService = new TodayService(deps.db);
  const completionService = new CompletionService(deps.db);
  const feedbackService = new FeedbackService(deps.db, jobQueue);
  const peopleService = new PeopleService(deps.db);
  const waitingService = new WaitingService(deps.db);
  const decisionService = new DecisionService(deps.db);
  const opportunityService = new OpportunityService(deps.db);
  const suggestService = new OpportunitySuggestService(deps.db, searchProvider);
  const weekService = new WeekService(deps.db);
  const scanService = new ProactiveScanService(deps.db, jobQueue, notificationService);
  const learningService = new LearningCurriculumService(deps.db, jobQueue);
  const plannerV2Service = new PlannerV2Service(deps.db, calendarProvider);
  scanService.setLearningService(learningService);
  completionService.setLearningService(learningService);

  jobQueue.register('plan.generate_day', async (payload) => {
    await planService.generateDay({
      date: payload.date,
      taskId: payload.taskId,
      learningItemId: payload.learningItemId,
    });
  });

  jobQueue.register('plan.prepare_tomorrow', async (payload) => {
    await planService.prepareTomorrow({ date: payload.date });
  });

  jobQueue.register('plan.prepare_week', async (payload) => {
    await weeklyPlanService.prepareWeek({
      weekStart: payload.weekStart,
      trigger: payload.trigger ?? 'SCHEDULE',
    });
  });

  jobQueue.register('plan.morning_refresh', async (payload) => {
    await planService.morningRefresh({ date: payload.date });
  });

  jobQueue.register('plan.replan', async (payload) => {
    await planService.replan({
      date: payload.date,
      from: payload.from,
      disruption: payload.disruption as Parameters<PlanService['replan']>[0]['disruption'],
    });
  });

  jobQueue.register('calendar.sync_cos', async (payload) => {
    await planService.syncCosCalendar(payload.date);
  });

  jobQueue.register('preparation.run', async (payload) => {
    await preparationService.run(payload.preparationId);
  });

  jobQueue.register('preparation.refresh', async (payload) => {
    await preparationService.refresh(payload.preparationId);
  });

  registerPreparationReplaceJob(jobQueue, preparationService);

  jobQueue.register('proactive.opportunity_scan', async () => {
    await runOpportunityScanStub(deps.db);
  });

  jobQueue.register('proactive.scan', async () => {
    await scanService.run();
  });

  jobQueue.register('calendar.pull', async () => {
    const summary = await calendarPull.pull();
    if (summary.connected) await plannerV2Service.retryCalendarSync();
  });

  await healthRoutes(app);
  await deviceRoutes(app, { deviceService, config: deps.config });
  await deviceFcmRoutes(app, { deviceService, notificationService });
  await syncRoutes(app, { deviceService, syncService });
  await intakeRoutes(app, { deviceService, intakeService });
  await preparationRoutes(app, { deviceService, preparationService, feedbackService });
  await todayRoutes(app, { deviceService, todayService });
  await planRoutes(app, {
    deviceService,
    planService,
    weeklyPlanService,
    goalPlanningService,
    db: deps.db,
  });
  await completionRoutes(app, { deviceService, completionService });
  await peopleRoutes(app, { deviceService, peopleService });
  await waitingRoutes(app, { deviceService, waitingService });
  await decisionRoutes(app, { deviceService, decisionService });
  await opportunityRoutes(app, { deviceService, opportunityService, suggestService });
  await weekRoutes(app, { deviceService, weekService });
  await learningRoutes(app, { deviceService, learningService });
  await proactiveRoutes(app, { deviceService, scanService });
  await integrationRoutes(app, {
    deviceService,
    config: deps.config,
    tokenService,
    calendarPull,
    calendarProvider,
    plannerV2: plannerV2Service,
    db: deps.db,
  });
  await plannerV2Routes(app, {
    deviceService,
    planner: plannerV2Service,
    webToken: deps.config.PLANNER_WEB_TOKEN,
  });

  if (deps.config.WORKER_ENABLED) {
    const interval = deps.config.PROACTIVE_SCAN_INTERVAL_MS;
    setInterval(() => {
      jobQueue.enqueue('proactive.scan', {});
    }, interval);
    const calInterval = deps.config.CALENDAR_PULL_INTERVAL_MS;
    setInterval(() => {
      jobQueue.enqueue('calendar.pull', {});
    }, calInterval);
    jobQueue.startPolling(15_000);
    planningScheduler.start(60_000);
  }

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  return {
    app,
    jobQueue,
    notificationService,
    pushProvider,
    calendarProvider,
    weeklyPlanService,
    planningScheduler,
  };
}
