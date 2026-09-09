import type {
  ApiError,
  Execution,
  Project,
  ProjectInput,
  ProjectPatch,
  Task,
  TaskEvent,
  TaskInput,
  TaskPatch,
  TaskPriority,
  WorkerSetting,
  WorkerHealth,
} from '@phantom/shared';

const baseUrl = import.meta.env.VITE_API_URL ?? '';

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly offline = false,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as Partial<ApiError>;
      const details = body.details?.map((detail) => detail.message).join(' ') ?? '';
      throw new ApiRequestError(
        `${body.error ?? `Request failed (${response.status}).`} ${details}`.trim(),
      );
    }
    return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError('The Phantom backend is offline. Start it and try again.', true);
  }
}

export const api = {
  projects: () => request<Project[]>('/api/projects'),
  createProject: (input: ProjectInput) =>
    request<Project>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  updateProject: (id: string, input: ProjectPatch) =>
    request<Project>(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  setProjectEnabled: (id: string, enabled: boolean) =>
    request<Project>(`/api/projects/${id}/enabled`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  deleteProject: (id: string) => request<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  tasks: () => request<Task[]>('/api/tasks'),
  createTask: (input: TaskInput) =>
    request<Task>('/api/tasks', { method: 'POST', body: JSON.stringify(input) }),
  updateTask: (id: string, input: TaskPatch) =>
    request<Task>(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  reprioritizeTask: (id: string, priority: TaskPriority) =>
    request<Task>(`/api/tasks/${id}/priority`, {
      method: 'PATCH',
      body: JSON.stringify({ priority }),
    }),
  deleteTask: (id: string) => request<void>(`/api/tasks/${id}`, { method: 'DELETE' }),
  requeueTask: (id: string) => request<Task>(`/api/tasks/${id}/requeue`, { method: 'POST' }),
  taskHistory: (id: string) => request<TaskEvent[]>(`/api/tasks/${id}/history`),
  taskExecutions: (id: string) => request<Execution[]>(`/api/tasks/${id}/executions`),
  workerHealth: () => request<WorkerHealth>('/api/worker/health'),
  workerSetting: () => request<WorkerSetting>('/api/settings/worker'),
  setWorkerPaused: (paused: boolean) =>
    request<WorkerSetting>('/api/settings/worker', {
      method: 'PATCH',
      body: JSON.stringify({ paused }),
    }),
};
