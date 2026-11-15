import { z } from 'zod';

export const dmPreferencePatchSchema = z.object({
  is_pinned: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  is_muted: z.boolean().optional(),
  is_favorite: z.boolean().optional(),
}).strict().refine(
  patch => Object.values(patch).some(value => value !== undefined),
  { message: 'Choose at least one chat setting to update.' },
);

export type DmPreferences = {
  is_pinned: boolean;
  is_archived: boolean;
  is_muted: boolean;
  is_favorite: boolean;
};

const asFlag = (value: unknown) => value === true || value === 1 || value === '1';

export function mergeDmPreferences(
  current: Partial<Record<keyof DmPreferences, unknown>> | null | undefined,
  patch: Partial<DmPreferences>,
): DmPreferences {
  return {
    is_pinned: patch.is_pinned ?? asFlag(current?.is_pinned),
    is_archived: patch.is_archived ?? asFlag(current?.is_archived),
    is_muted: patch.is_muted ?? asFlag(current?.is_muted),
    is_favorite: patch.is_favorite ?? asFlag(current?.is_favorite),
  };
}
