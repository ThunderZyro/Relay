export function validatePollOptions(options: string[]): string | null {
  if (options.length < 2 || options.length > 10) return 'A poll needs between 2 and 10 options.';
  const normalized = options.map(option => option.trim().toLocaleLowerCase());
  if (normalized.some(option => option.length === 0 || option.length > 80)) return 'Each poll option must contain 1 to 80 characters.';
  if (new Set(normalized).size !== normalized.length) return 'Poll options must be unique.';
  return null;
}

export function validatePollSelection(
  optionIds: string[],
  validOptionIds: ReadonlySet<string>,
  allowMultiple: boolean,
): string | null {
  if (optionIds.length < 1 || optionIds.length > 10) return 'Choose at least one poll option.';
  if (new Set(optionIds).size !== optionIds.length) return 'Poll options must be unique.';
  if (!allowMultiple && optionIds.length > 1) return 'This poll allows one answer only.';
  if (optionIds.some(optionId => !validOptionIds.has(optionId))) return 'One of those options does not belong to this poll.';
  return null;
}

export function isPollClosed(endsAt: string | null | undefined, now = Date.now()): boolean {
  return !!endsAt && new Date(endsAt).getTime() <= now;
}
