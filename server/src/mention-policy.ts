/**
 * A channel mention must never reveal the existence or content of a channel
 * to a member who cannot read it.
 */
export function shouldNotifyChannelMention(
  senderId: string,
  recipientId: string,
  recipientCanReadChannel: boolean
): boolean {
  return recipientId !== senderId && recipientCanReadChannel;
}
