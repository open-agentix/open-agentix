import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { useState } from 'react';
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from '../../../../../packages/core/src/rbac';
import { api, call } from '../../api/client';
import { teamsQuery, usersQuery, useTeamNames } from '../../api/queries';
import type { RoleName, Team, User } from '../../api/types';
import { useCan } from '../../auth/auth';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toast';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Loading,
  PageHeader,
  Section,
  SelectField,
  TabPanel,
  Tabs,
  TextField,
  errorMessage,
} from '../../components/ui';
import { useI18n } from '../../i18n/i18n';
import { useDocumentTitle } from '../../lib/hooks';
import type { UserTab } from '../../router';

const route = getRouteApi('/_app/users');

export function UsersPage() {
  const { t } = useI18n();
  useDocumentTitle(t('users.title'));
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const tab: UserTab = search.tab ?? 'users';
  return (
    <div className="page">
      <PageHeader title={t('users.title')} description={t('users.subtitle')} />
      <Tabs
        items={[
          { key: 'users' as const, label: t('users.tabs.users') },
          { key: 'teams' as const, label: t('users.tabs.teams') },
          { key: 'matrix' as const, label: t('users.tabs.matrix') },
        ]}
        value={tab}
        onChange={(next) => void navigate({ search: { tab: next }, replace: true })}
        label={t('users.title')}
        idPrefix="users"
      />
      <TabPanel idPrefix="users" active={tab}>
        {tab === 'users' ? <UsersTab /> : tab === 'teams' ? <TeamsTab /> : <RbacMatrix />}
      </TabPanel>
    </div>
  );
}

function UsersTab() {
  const { t, fmt } = useI18n();
  const can = useCan();
  const users = useQuery(usersQuery);
  const teamNames = useTeamNames();
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  if (users.isPending) return <Loading />;
  if (users.isError) return <ErrorState error={users.error} onRetry={() => void users.refetch()} />;
  return (
    <Section
      actions={
        can('users:write') ? (
          <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
            {t('users.new')}
          </Button>
        ) : null
      }
    >
      {users.data.items.length === 0 ? (
        <EmptyState icon="users" title={t('users.empty')} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{t('users.tabs.users')}</caption>
            <thead>
              <tr>
                <th scope="col">{t('users.name')}</th>
                <th scope="col">{t('users.roles')}</th>
                <th scope="col" className="hide-sm">
                  {t('users.teams')}
                </th>
                <th scope="col" className="hide-sm">
                  {t('users.lastLogin')}
                </th>
                <th scope="col">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((u) => (
                <tr key={u.id}>
                  <td>
                    <span className="strong">{u.displayName}</span>{' '}
                    {u.disabled ? <Badge tone="danger">{t('users.disabled')}</Badge> : null}
                    <br />
                    <span className="muted">
                      {u.email} · {u.source}
                    </span>
                  </td>
                  <td>
                    <span className="badges">
                      {u.globalRoles.map((r) => (
                        <Badge key={r} tone="accent">
                          {r}
                        </Badge>
                      ))}
                    </span>
                  </td>
                  <td className="hide-sm">
                    {u.teams
                      .map((m) => `${teamNames.get(m.teamId) ?? '?'} (${m.role})`)
                      .join(', ') || '–'}
                  </td>
                  <td className="hide-sm">{fmt.relative(u.lastLoginAt)}</td>
                  <td className="num">
                    {can('users:write') ? (
                      <Button
                        size="sm"
                        icon="edit"
                        onClick={() => setEditing(u)}
                        aria-label={t('users.editUser', { name: u.displayName })}
                      >
                        {t('common.edit')}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <UserDialog editing={editing} onClose={() => setEditing(null)} />
    </Section>
  );
}

function UserDialog({ editing, onClose }: { editing: User | 'new' | null; onClose: () => void }) {
  const t = useI18n().t;
  const toast = useToast();
  const queryClient = useQueryClient();
  const existing = editing && editing !== 'new' ? editing : null;
  const [opened, setOpened] = useState<typeof editing>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<RoleName[]>(['viewer']);
  const [disabled, setDisabled] = useState(false);
  if (opened !== editing) {
    setOpened(editing);
    setEmail(existing?.email ?? '');
    setDisplayName(existing?.displayName ?? '');
    setPassword('');
    setRoles((existing?.globalRoles as RoleName[] | undefined) ?? ['viewer']);
    setDisabled(existing?.disabled ?? false);
  }
  const save = useMutation({
    mutationFn: () =>
      existing
        ? call(
            api.PATCH('/v1/users/{id}', {
              params: { path: { id: existing.id } },
              body: { displayName, globalRoles: roles, disabled },
            }),
          )
        : call(
            api.POST('/v1/users', {
              body: {
                email: email.trim(),
                displayName: displayName.trim(),
                password,
                globalRoles: roles,
              },
            }),
          ),
    onSuccess: async (u) => {
      await queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
      toast.success(t('users.saved', { name: u.displayName }));
      onClose();
    },
  });
  const invalid =
    !displayName.trim() || (!existing && (!email.includes('@') || password.length < 12));
  return (
    <Dialog
      open={!!editing}
      onClose={onClose}
      title={existing ? t('users.editUser', { name: existing.displayName }) : t('users.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={invalid}
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {!existing ? (
          <TextField
            label={t('users.email')}
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        ) : null}
        <TextField
          label={t('users.name')}
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
        {!existing ? (
          <TextField
            label={t('users.password')}
            type="password"
            required
            autoComplete="new-password"
            hint={t('users.passwordHint')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        ) : null}
        <fieldset className="check-grid">
          <legend>{t('users.globalRoles')}</legend>
          {ROLES.map((r) => (
            <label key={r} className="check">
              <input
                type="checkbox"
                checked={roles.includes(r)}
                onChange={(e) =>
                  setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))
                }
              />
              <span>
                <span className="strong">{r}</span> <span className="muted">{t(`roles.${r}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {existing ? (
          <label className="check">
            <input
              type="checkbox"
              checked={disabled}
              onChange={(e) => setDisabled(e.target.checked)}
            />
            <span>{t('users.disableAccount')}</span>
          </label>
        ) : null}
        {save.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(save.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function TeamsTab() {
  const { t, fmt } = useI18n();
  const can = useCan();
  const teams = useQuery(teamsQuery);
  const [creating, setCreating] = useState(false);
  const [members, setMembers] = useState<Team | null>(null);
  if (teams.isPending) return <Loading />;
  if (teams.isError) return <ErrorState error={teams.error} onRetry={() => void teams.refetch()} />;
  return (
    <Section
      actions={
        can('users:write') ? (
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {t('users.newTeam')}
          </Button>
        ) : null
      }
    >
      {teams.data.items.length ? (
        <ul className="list">
          {teams.data.items.map((tm) => (
            <li key={tm.id} className="list-row">
              <span className="list-main">
                <span className="strong">{tm.name}</span>{' '}
                <span className="muted mono">{tm.slug}</span>
              </span>
              <span>
                {tm.monthlyBudgetUsd !== null
                  ? t('users.budget', { amount: fmt.usd(tm.monthlyBudgetUsd) })
                  : t('users.noBudget')}
              </span>
              {can('users:write') ? (
                <Button size="sm" icon="users" onClick={() => setMembers(tm)}>
                  {t('users.members')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState icon="users" title={t('users.noTeams')}>
          {t('users.noTeamsText')}
        </EmptyState>
      )}
      <TeamDialog open={creating} onClose={() => setCreating(false)} />
      <MembersDialog team={members} onClose={() => setMembers(null)} />
    </Section>
  );
}

function TeamDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useI18n().t;
  const toast = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [budget, setBudget] = useState('');
  const save = useMutation({
    mutationFn: () =>
      call(
        api.POST('/v1/teams', {
          body: {
            name: name.trim(),
            slug: slug.trim(),
            ...(budget ? { monthlyBudgetUsd: Number(budget) } : {}),
          },
        }),
      ),
    onSuccess: async (tm) => {
      await queryClient.invalidateQueries({ queryKey: teamsQuery.queryKey });
      toast.success(t('users.teamCreated', { name: tm.name }));
      setName('');
      setSlug('');
      setBudget('');
      onClose();
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('users.newTeam')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!name.trim() || !/^[a-z][a-z0-9-]*$/.test(slug)}
            onClick={() => save.mutate()}
          >
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField
          label={t('users.teamName')}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label={t('users.teamSlug')}
          required
          hint={t('users.teamSlugHint')}
          className="input mono"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
        />
        <TextField
          label={t('users.monthlyBudget')}
          type="number"
          min={0}
          step={1}
          inputMode="decimal"
          value={budget}
          onChange={(e) => setBudget(e.target.value)}
        />
        {save.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(save.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function MembersDialog({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const t = useI18n().t;
  const toast = useToast();
  const queryClient = useQueryClient();
  const users = useQuery(usersQuery);
  const [opened, setOpened] = useState<Team | null>(null);
  const [roles, setRoles] = useState<Record<string, RoleName | ''>>({});
  if (opened !== team) {
    setOpened(team);
    const initial: Record<string, RoleName | ''> = {};
    for (const u of users.data?.items ?? []) {
      const m = u.teams.find((x) => x.teamId === team?.id);
      initial[u.id] = (m?.role as RoleName | undefined) ?? '';
    }
    setRoles(initial);
  }
  const save = useMutation({
    mutationFn: () =>
      call(
        api.PUT('/v1/teams/{id}/members', {
          params: { path: { id: team?.id ?? '' } },
          body: {
            members: Object.entries(roles)
              .filter((e): e is [string, RoleName] => !!e[1])
              .map(([userId, role]) => ({ userId, role })),
          },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
      toast.success(t('users.membersSaved'));
      onClose();
    },
  });
  return (
    <Dialog
      open={!!team}
      onClose={onClose}
      title={t('users.membersOf', { team: team?.name ?? '' })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="stack">
        {(users.data?.items ?? []).map((u) => (
          <SelectField
            key={u.id}
            label={`${u.displayName} (${u.email})`}
            value={roles[u.id] ?? ''}
            onChange={(e) => setRoles({ ...roles, [u.id]: e.target.value as RoleName | '' })}
          >
            <option value="">{t('users.notMember')}</option>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </SelectField>
        ))}
        {save.isError ? (
          <p className="error-text" role="alert">
            {errorMessage(save.error)}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

export function RbacMatrix() {
  const t = useI18n().t;
  return (
    <Section title={t('users.matrixTitle')}>
      <p className="muted">{t('users.matrixText')}</p>
      <div
        className="table-wrap matrix-wrap"
        tabIndex={0}
        role="region"
        aria-label={t('common.tableRegion', { name: t('users.matrixTitle') })}
      >
        <table className="table matrix">
          <caption className="sr-only">{t('users.matrixTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('users.permission')}</th>
              {ROLES.map((r) => (
                <th key={r} scope="col" className="center">
                  {r}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {PERMISSIONS.map((p) => (
              <tr key={p}>
                <th scope="row" className="mono">
                  {p}
                </th>
                {ROLES.map((r) => {
                  const has = ROLE_PERMISSIONS[r].includes(p);
                  return (
                    <td key={r} className="center">
                      {has ? (
                        <Icon name="check" size={16} label={t('users.granted')} />
                      ) : (
                        <span className="sr-only">{t('users.notGranted')}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
