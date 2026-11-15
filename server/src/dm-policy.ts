export type DmPrivacy = 'everyone' | 'friends' | 'nobody';
/** Evaluate the recipient's current DM privacy policy for one direct peer. */
export function canDirectMessagePeer(privacy: DmPrivacy, areFriends: boolean, eitherUserBlocked: boolean): boolean {
  if (eitherUserBlocked || privacy === 'nobody') return false;
  if (privacy === 'friends') return areFriends;
  return privacy === 'everyone';
}
