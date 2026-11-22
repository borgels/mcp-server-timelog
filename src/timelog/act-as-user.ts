import { ActAsRefusedError } from '../act-as.js';
import { TimelogHttpError } from '../errors.js';
import { OWN_TIME_ONLY } from './act-as-texts.js';
import { API, unwrapList, unwrapSingle } from './api.js';
import type { UpstreamClient } from './client.js';
import { currentActAs } from './policy.js';

export { NOT_OWN_REGISTRATION, OTHER_EMPLOYEE, OWN_TIME_ONLY } from './act-as-texts.js';

/** Users read per page in the lookup, and the most pages read. A longer list is refused, never cut short. */
export const LOOKUP_PAGE_SIZE = 500;
export const LOOKUP_MAX_PAGES = 20;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function userId(user: Record<string, unknown>): number | undefined {
  const id = user.UserID ?? user.ID;
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * The TimeLog UserID of the person the host names in actAs, or undefined when the call has no person (it runs as the
 * key's own user). Found as the key's user: every page of GET /api/v1/user, and exactly one active user (IsActive not
 * false) whose Email, trimmed and compared case-insensitively, is the address. None, more than one, or a list longer
 * than LOOKUP_MAX_PAGES pages (so a second user may be missing) is ActAsRefusedError('no_user'); TimeLog refusing the
 * list (403: the key's user may not see users) is ActAsRefusedError('not_permitted'). Nothing else is sent before it.
 *
 * The email is sent to TimeLog nowhere: the list is read whole and compared here. It is not kept, audited or returned.
 */
export async function personUserId(client: UpstreamClient): Promise<number | undefined> {
  const person = currentActAs();
  if (!person) return undefined;
  const ids: number[] = [];
  for (let page = 1; ; page += 1) {
    if (page > LOOKUP_MAX_PAGES) throw new ActAsRefusedError('no_user');
    let body: unknown;
    try {
      body = await client.get(`${API}/user`, { $page: page, $pagesize: LOOKUP_PAGE_SIZE });
    } catch (error) {
      if (error instanceof TimelogHttpError && error.status === 403) throw new ActAsRefusedError('not_permitted');
      throw error;
    }
    const { items, paging } = unwrapList(body);
    for (const item of items) {
      // Inactive users are left out; a user without the flag counts as active, as in list_employees.
      if (!isObject(item) || item.IsActive === false) continue;
      if (typeof item.Email !== 'string' || item.Email.trim().toLowerCase() !== person.email) continue;
      const id = userId(item);
      if (id !== undefined) ids.push(id);
    }
    const pages = paging.totalPages;
    // Without paging information (a plain list), on the last page or on an empty page, the list was read whole.
    if (pages === undefined || page >= pages || items.length === 0) break;
  }
  if (ids.length !== 1) throw new ActAsRefusedError('no_user');
  return ids[0];
}

/** The UserID of the key's own user (GET /api/v1/user/me), or undefined when TimeLog does not give one. */
export async function keyUserId(client: UpstreamClient): Promise<number | undefined> {
  const me = unwrapSingle(await client.get(`${API}/user/me`));
  return isObject(me) ? userId(me) : undefined;
}

/**
 * A period read made for the person: TimeLog's period reads have no user parameter and give only the key's own user's
 * time, so with a person they run only when the person is the key's user. Otherwise OWN_TIME_ONLY; nothing is read.
 */
export async function assertOwnTimeReadable(client: UpstreamClient): Promise<void> {
  const person = await personUserId(client);
  if (person === undefined) return;
  if ((await keyUserId(client)) !== person) throw new Error(OWN_TIME_ONLY);
}
