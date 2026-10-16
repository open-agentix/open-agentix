import { useQuery } from '@tanstack/react-query';
import { reviewPeopleQuery } from '../../api/queries';
import { meQuery } from '../../auth/auth';
import { useT } from '../../i18n/i18n';

/** `name(id)`: "You" for the signed-in user, the display name where the API gave one, else a short id. */
export function usePeople(agentId: string, reviewId: string): (id: string | null) => string {
  const t = useT();
  const me = useQuery(meQuery).data?.user.id;
  const people = useQuery(reviewPeopleQuery(agentId, reviewId)).data?.people ?? {};
  return (id) => {
    if (!id) return t('reviews.person.unknown');
    if (id === me) return t('reviews.person.you');
    return people[id] ?? t('reviews.person.other', { id: id.slice(0, 8) });
  };
}
