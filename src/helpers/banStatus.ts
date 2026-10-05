import { UserDocument } from "../models/user.model";

/**
 * Returns whether the user's ban is currently in effect. A ban with a `banUntil`
 * date in the past is lifted (and persisted) on the spot, so temporary bans
 * expire without an admin having to unban manually. A ban without `banUntil`
 * is permanent.
 */
export async function isBanActive(user: UserDocument): Promise<boolean> {
  if (!user.isBanned) return false;

  const until = user.banUntil ? new Date(user.banUntil) : null;
  if (until && !isNaN(until.getTime()) && until.getTime() <= Date.now()) {
    user.isBanned = false;
    user.banReason = "";
    user.banUntil = "";
    await user.save();
    return false;
  }
  return true;
}
