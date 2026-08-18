import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { DeviceService } from '../../application/deviceService.js';
import type { PlannerV2Service } from '../../application/plannerV2Service.js';
import { plannerV2Routes } from './plannerV2.js';

async function plannerApp(planner: Partial<PlannerV2Service>) {
  const app = Fastify();
  await plannerV2Routes(app, {
    planner: planner as PlannerV2Service,
    deviceService: {} as DeviceService,
    webToken: 'planner-test-token',
  });
  await app.ready();
  return app;
}

const authorization = { authorization: 'Bearer planner-test-token' };

describe('Planner V2 task management routes', () => {
  it('returns every active time block linked to a task', async () => {
    const getTaskTimeBlocks = vi.fn().mockResolvedValue([
      { id: 'block-1', taskId: 'task-1', title: 'Deep work' },
    ]);
    const app = await plannerApp({ getTaskTimeBlocks });

    const response = await app.inject({
      method: 'GET',
      url: '/v2/tasks/task-1/time-blocks',
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      { id: 'block-1', taskId: 'task-1', title: 'Deep work' },
    ]);
    expect(getTaskTimeBlocks).toHaveBeenCalledWith('task-1');
    await app.close();
  });

  it('deletes a task through the authenticated planner API', async () => {
    const deleteTask = vi.fn().mockResolvedValue({
      id: 'task-1',
      deleted: true,
      removedTimeBlocks: 2,
    });
    const app = await plannerApp({ deleteTask });

    const response = await app.inject({
      method: 'DELETE',
      url: '/v2/tasks/task-1',
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'task-1',
      deleted: true,
      removedTimeBlocks: 2,
    });
    expect(deleteTask).toHaveBeenCalledWith('task-1');
    await app.close();
  });
});

describe('Planner V2 projects and goals routes', () => {
  it('creates a project through the authenticated planner API', async () => {
    const createProject = vi.fn().mockResolvedValue({
      id: 'project-1',
      title: 'Personal OS',
      goalId: null,
      color: '#705CF6',
      active: true,
    });
    const app = await plannerApp({ createProject });

    const response = await app.inject({
      method: 'POST',
      url: '/v2/projects',
      headers: { ...authorization, 'content-type': 'application/json' },
      payload: { title: 'Personal OS' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: 'project-1', title: 'Personal OS' });
    expect(createProject).toHaveBeenCalledWith({ title: 'Personal OS' });
    await app.close();
  });

  it('deletes a goal through the authenticated planner API', async () => {
    const deleteGoal = vi.fn().mockResolvedValue({ id: 'goal-1', deleted: true });
    const app = await plannerApp({ deleteGoal });

    const response = await app.inject({
      method: 'DELETE',
      url: '/v2/goals/goal-1',
      headers: authorization,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: 'goal-1', deleted: true });
    expect(deleteGoal).toHaveBeenCalledWith('goal-1');
    await app.close();
  });
});
