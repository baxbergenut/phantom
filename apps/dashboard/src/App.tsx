import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  TASK_PRIORITIES,
  type Project,
  type ProjectInput,
  type Task,
  type TaskInput,
  type TaskPriority,
  type TaskStatus,
} from '@phantom/shared';

import { api, ApiRequestError } from './api';

const blankProject: ProjectInput = {
  name: '',
  localPath: '',
  remoteName: 'origin',
  remoteBranch: 'main',
  enabled: true,
  validationCommands: [],
};

const columns: Array<{ name: string; statuses: TaskStatus[] }> = [
  { name: 'Queue', statuses: ['queued'] },
  { name: 'In progress', statuses: ['classifying', 'waiting_quota', 'running', 'retrying'] },
  { name: 'Completed', statuses: ['completed'] },
  { name: 'Needs attention', statuses: ['failed', 'blocked'] },
];

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong.';
}

export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'board' | 'projects'>('board');
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showTaskForm, setShowTaskForm] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [projectRows, taskRows, worker] = await Promise.all([
        api.projects(),
        api.tasks(),
        api.workerSetting(),
      ]);
      setProjects(projectRows);
      setTasks(taskRows);
      setPaused(worker.paused);
      setOffline(false);
    } catch (nextError) {
      setOffline(nextError instanceof ApiRequestError && nextError.offline);
      setError(errorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function perform(action: () => Promise<unknown>) {
    setError('');
    try {
      await action();
      await refresh();
      return true;
    } catch (nextError) {
      setError(errorMessage(nextError));
      return false;
    }
  }

  return (
    <div className="app-shell">
      <header>
        <button className="brand" onClick={() => setView('board')}>
          <span className="brand-mark">P</span>
          <span>
            <strong>Phantom</strong>
            <small>Codex project manager</small>
          </span>
        </button>
        <nav aria-label="Primary navigation">
          <button className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}>
            Task board
          </button>
          <button
            className={view === 'projects' ? 'active' : ''}
            onClick={() => setView('projects')}
          >
            Projects
          </button>
        </nav>
        <button
          className={`pause-control ${paused ? 'paused' : ''}`}
          onClick={() => void perform(() => api.setWorkerPaused(!paused))}
        >
          <span className="status-dot" /> Worker {paused ? 'paused' : 'ready'}
        </button>
      </header>

      <main>
        {error && (
          <div className={`notice ${offline ? 'offline' : ''}`} role="alert">
            <strong>{offline ? 'Backend offline' : 'Could not complete request'}</strong>
            <span>{error}</span>
            <button onClick={() => void refresh()}>Retry</button>
          </div>
        )}

        {loading ? (
          <LoadingState />
        ) : view === 'projects' ? (
          <ProjectsView
            projects={projects}
            onAdd={() => {
              setEditingProject(null);
              setShowProjectForm(true);
            }}
            onEdit={(project) => {
              setEditingProject(project);
              setShowProjectForm(true);
            }}
            onToggle={(project) =>
              void perform(() => api.setProjectEnabled(project.id, !project.enabled))
            }
            onDelete={(project) => {
              if (window.confirm(`Delete ${project.name} and all of its tasks?`))
                void perform(() => api.deleteProject(project.id));
            }}
          />
        ) : (
          <BoardView
            tasks={tasks}
            projects={projects}
            onAdd={() => setShowTaskForm(true)}
            onSelect={setSelectedTask}
            onPriority={(task, priority) =>
              void perform(() => api.reprioritizeTask(task.id, priority))
            }
          />
        )}
      </main>

      {showProjectForm && (
        <ProjectForm
          project={editingProject}
          onClose={() => setShowProjectForm(false)}
          onSave={async (input) => {
            const succeeded = await perform(() =>
              editingProject
                ? api.updateProject(editingProject.id, input)
                : api.createProject(input),
            );
            if (succeeded) setShowProjectForm(false);
          }}
        />
      )}
      {showTaskForm && (
        <TaskForm
          projects={projects}
          onClose={() => setShowTaskForm(false)}
          onSave={async (input) => {
            const succeeded = await perform(() => api.createTask(input));
            if (succeeded) setShowTaskForm(false);
          }}
        />
      )}
      {selectedTask && (
        <TaskDetails
          task={tasks.find((task) => task.id === selectedTask.id) ?? selectedTask}
          onClose={() => setSelectedTask(null)}
          onDelete={async () => {
            const succeeded = await perform(() => api.deleteTask(selectedTask.id));
            if (succeeded) setSelectedTask(null);
          }}
          onRequeue={() => void perform(() => api.requeueTask(selectedTask.id))}
          onSave={(input) => perform(() => api.updateTask(selectedTask.id, input))}
        />
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <section className="loading-state">
      <div className="spinner" />
      <h2>Loading Phantom</h2>
      <p>Connecting to the local backend…</p>
    </section>
  );
}

function ProjectsView({
  projects,
  onAdd,
  onEdit,
  onToggle,
  onDelete,
}: {
  projects: Project[];
  onAdd: () => void;
  onEdit: (project: Project) => void;
  onToggle: (project: Project) => void;
  onDelete: (project: Project) => void;
}) {
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Repositories</p>
          <h1>Projects</h1>
          <p>Local Git working trees Phantom can use for queued tasks.</p>
        </div>
        <button className="primary" onClick={onAdd}>
          + Add project
        </button>
      </div>
      {projects.length === 0 ? (
        <EmptyState
          title="No projects yet"
          body="Register a local Git repository before creating your first task."
          action="Add project"
          onAction={onAdd}
        />
      ) : (
        <div className="project-grid">
          {projects.map((project) => (
            <article className="project-card" key={project.id}>
              <div className="card-top">
                <span className="folder-icon">⌁</span>
                <span className={`badge ${project.enabled ? 'enabled' : 'disabled'}`}>
                  {project.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <h2>{project.name}</h2>
              <code>{project.localPath}</code>
              <dl>
                <div>
                  <dt>Remote</dt>
                  <dd>{project.remoteName}</dd>
                </div>
                <div>
                  <dt>Branch</dt>
                  <dd>{project.remoteBranch}</dd>
                </div>
                <div>
                  <dt>Checks</dt>
                  <dd>{project.validationCommands.length}</dd>
                </div>
              </dl>
              <div className="card-actions">
                <button onClick={() => onEdit(project)}>Edit</button>
                <button onClick={() => onToggle(project)}>
                  {project.enabled ? 'Disable' : 'Enable'}
                </button>
                <button className="danger" onClick={() => onDelete(project)}>
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function BoardView({
  tasks,
  projects,
  onAdd,
  onSelect,
  onPriority,
}: {
  tasks: Task[];
  projects: Project[];
  onAdd: () => void;
  onSelect: (task: Task) => void;
  onPriority: (task: Task, priority: TaskPriority) => void;
}) {
  return (
    <section>
      <div className="page-heading">
        <div>
          <p className="eyebrow">Local queue</p>
          <h1>Task board</h1>
          <p>Priority first, then oldest task. Execution begins in Phase 2.</p>
        </div>
        <button className="primary" disabled={projects.length === 0} onClick={onAdd}>
          + New task
        </button>
      </div>
      {tasks.length === 0 ? (
        <EmptyState
          title="Your queue is clear"
          body={
            projects.length
              ? 'Create a task and give Phantom precise instructions.'
              : 'Add a project first, then create a task.'
          }
          action={projects.length ? 'Create task' : undefined}
          onAction={onAdd}
        />
      ) : (
        <div className="board">
          {columns.map((column) => {
            const cards = tasks.filter((task) => column.statuses.includes(task.status));
            return (
              <div className="board-column" key={column.name}>
                <div className="column-heading">
                  <h2>{column.name}</h2>
                  <span>{cards.length}</span>
                </div>
                <div className="column-body">
                  {cards.length === 0 ? (
                    <p className="column-empty">Nothing here</p>
                  ) : (
                    cards.map((task) => (
                      <article className="task-card" key={task.id} onClick={() => onSelect(task)}>
                        <div className="task-meta">
                          <span className={`priority ${task.priority}`}>{task.priority}</span>
                          <span>{task.projectName}</span>
                        </div>
                        <h3>{task.title}</h3>
                        <p>{task.instructions}</p>
                        <div className="task-footer">
                          <span className="status-label">{task.status.replace('_', ' ')}</span>
                          {task.status === 'queued' && (
                            <select
                              aria-label={`Priority for ${task.title}`}
                              value={task.priority}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) =>
                                onPriority(task, event.target.value as TaskPriority)
                              }
                            >
                              {TASK_PRIORITIES.map((priority) => (
                                <option key={priority}>{priority}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function EmptyState({
  title,
  body,
  action,
  onAction,
}: {
  title: string;
  body: string;
  action?: string | undefined;
  onAction: () => void;
}) {
  return (
    <div className="empty-state">
      <span>◇</span>
      <h2>{title}</h2>
      <p>{body}</p>
      {action && (
        <button className="primary" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <h2>{title}</h2>
          <button aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}

function ProjectForm({
  project,
  onClose,
  onSave,
}: {
  project: Project | null;
  onClose: () => void;
  onSave: (input: ProjectInput) => Promise<void>;
}) {
  const [form, setForm] = useState<ProjectInput>(
    project
      ? {
          name: project.name,
          localPath: project.localPath,
          remoteName: project.remoteName,
          remoteBranch: project.remoteBranch,
          enabled: project.enabled,
          validationCommands: project.validationCommands,
        }
      : blankProject,
  );
  const [commands, setCommands] = useState(form.validationCommands.join('\n'));
  const [saving, setSaving] = useState(false);
  return (
    <Modal title={project ? 'Edit project' : 'Add project'} onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          void onSave({
            ...form,
            validationCommands: commands
              .split('\n')
              .map((value) => value.trim())
              .filter(Boolean),
          }).finally(() => setSaving(false));
        }}
      >
        <label>
          Project name
          <input
            required
            maxLength={100}
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </label>
        <label>
          Local Git path
          <input
            required
            value={form.localPath}
            placeholder="C:\\code\\my-project"
            onChange={(event) => setForm({ ...form, localPath: event.target.value })}
          />
        </label>
        <div className="form-row">
          <label>
            Remote name
            <input
              required
              value={form.remoteName}
              onChange={(event) => setForm({ ...form, remoteName: event.target.value })}
            />
          </label>
          <label>
            Main branch
            <input
              required
              value={form.remoteBranch}
              onChange={(event) => setForm({ ...form, remoteBranch: event.target.value })}
            />
          </label>
        </div>
        <label>
          Validation commands <small>One per line, optional</small>
          <textarea
            rows={3}
            value={commands}
            placeholder="npm test"
            onChange={(event) => setCommands(event.target.value)}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />{' '}
          Enabled for future task execution
        </label>
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save project'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskForm({
  projects,
  onClose,
  onSave,
}: {
  projects: Project[];
  onClose: () => void;
  onSave: (input: TaskInput) => Promise<void>;
}) {
  const enabledProjects = projects.filter((project) => project.enabled);
  const [form, setForm] = useState<TaskInput>({
    projectId: enabledProjects[0]?.id ?? projects[0]?.id ?? '',
    title: '',
    instructions: '',
    priority: 'normal',
  });
  const [saving, setSaving] = useState(false);
  return (
    <Modal title="Create task" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSaving(true);
          void onSave(form).finally(() => setSaving(false));
        }}
      >
        <label>
          Project
          <select
            required
            value={form.projectId}
            onChange={(event) => setForm({ ...form, projectId: event.target.value })}
          >
            {projects.map((project) => (
              <option value={project.id} key={project.id}>
                {project.name}
                {project.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Title
          <input
            required
            maxLength={200}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
          />
        </label>
        <label>
          Instructions
          <textarea
            required
            rows={7}
            value={form.instructions}
            placeholder="Describe the desired outcome and acceptance criteria…"
            onChange={(event) => setForm({ ...form, instructions: event.target.value })}
          />
        </label>
        <label>
          Priority
          <select
            value={form.priority}
            onChange={(event) => setForm({ ...form, priority: event.target.value as TaskPriority })}
          >
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority}>{priority}</option>
            ))}
          </select>
        </label>
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            {saving ? 'Creating…' : 'Create task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskDetails({
  task,
  onClose,
  onDelete,
  onRequeue,
  onSave,
}: {
  task: Task;
  onClose: () => void;
  onDelete: () => Promise<void>;
  onRequeue: () => void;
  onSave: (input: {
    title: string;
    instructions: string;
    priority: TaskPriority;
  }) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [instructions, setInstructions] = useState(task.instructions);
  const [priority, setPriority] = useState(task.priority);
  const date = useMemo(() => new Date(task.createdAt).toLocaleString(), [task.createdAt]);
  return (
    <Modal title="Task details" onClose={onClose}>
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSave({ title, instructions, priority }).then(
              (saved) => saved && setEditing(false),
            );
          }}
        >
          <label>
            Title
            <input required value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label>
            Instructions
            <textarea
              required
              rows={8}
              value={instructions}
              onChange={(event) => setInstructions(event.target.value)}
            />
          </label>
          <label>
            Priority
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as TaskPriority)}
            >
              {TASK_PRIORITIES.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <div className="form-actions">
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button className="primary">Save changes</button>
          </div>
        </form>
      ) : (
        <div className="details">
          <div className="task-meta">
            <span className={`priority ${task.priority}`}>{task.priority}</span>
            <span className="status-label">{task.status.replace('_', ' ')}</span>
          </div>
          <h3>{task.title}</h3>
          <p className="instructions">{task.instructions}</p>
          <dl>
            <div>
              <dt>Project</dt>
              <dd>{task.projectName}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>{date}</dd>
            </div>
            <div>
              <dt>Attempts</dt>
              <dd>{task.attemptCount}</dd>
            </div>
          </dl>
          {task.statusReason && (
            <div className="reason">
              <strong>Status reason</strong>
              {task.statusReason}
            </div>
          )}
          <div className="form-actions">
            {task.status === 'queued' && (
              <>
                <button className="danger" onClick={() => void onDelete()}>
                  Delete task
                </button>
                <button onClick={() => setEditing(true)}>Edit</button>
              </>
            )}
            {(task.status === 'failed' || task.status === 'blocked') && (
              <button className="primary" onClick={onRequeue}>
                Requeue task
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
