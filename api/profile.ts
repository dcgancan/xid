/**
 * Profile resolution for X handles, without a paid API key.
 *
 * Primary path: activate a guest token against the public web bearer, then hit
 * the same GraphQL endpoint x.com's logged-out web client uses. This yields the
 * one field that makes the card worth printing -- `created_at`.
 *
 * Fallback path: unavatar.io, which mirrors avatars for any handle with no key.
 * It cannot give us a display name or a join date, so those degrade to null and
 * the UI lets the visitor fill them in.
 */

export type Profile = {
  handle: string;
  name: string;
  avatar: string;
  /** Public profile description, or null when only the avatar fallback answered. */
  bio: string | null;
  /** ISO 8601 account creation instant, or null when only the fallback answered. */
  joined: string | null;
  verified: boolean;
  followers: number | null;
  following: number | null;
  /** Profile-listed residence, or null when only the fallback answered. */
  location: string | null;
  /** Public post count, or null when only the fallback answered. */
  posts: number | null;
  source: "x" | "fallback";
};

export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** Public bearer shipped in x.com's own web bundle. Not a secret, not rate-limited per-key. */
const WEB_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const USER_BY_SCREEN_NAME = "https://api.x.com/graphql/G3KGOASz96M-Qu0nwmGXNg/UserByScreenName";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const GUEST_TOKEN_TTL = 2 * 60 * 60 * 1000;
const PROFILE_TTL = 6 * 60 * 60 * 1000;
const NEGATIVE_TTL = 5 * 60 * 1000;

type Cached<T> = { value: T; expires: number };

let guestToken: Cached<string> | null = null;
const profileCache = new Map<string, Cached<Profile | null>>();

export class ProfileNotFound extends Error {
  constructor(handle: string) {
    super(`No X account named @${handle}`);
    this.name = "ProfileNotFound";
  }
}

async function getGuestToken(force = false): Promise<string> {
  const now = Date.now();
  if (!force && guestToken && guestToken.expires > now) return guestToken.value;

  const res = await fetch("https://api.x.com/1.1/guest/activate.json", {
    method: "POST",
    headers: { authorization: `Bearer ${WEB_BEARER}`, "user-agent": UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`guest/activate ${res.status}`);

  const body = (await res.json()) as { guest_token?: string };
  if (!body.guest_token) throw new Error("guest/activate returned no token");

  guestToken = { value: body.guest_token, expires: now + GUEST_TOKEN_TTL };
  return body.guest_token;
}

type LegacyUser = {
  name?: string;
  screen_name?: string;
  description?: string;
  created_at?: string;
  followers_count?: number;
  friends_count?: number;
  statuses_count?: number;
  location?: string;
  profile_image_url_https?: string;
};

async function fetchFromX(handle: string, retryOnAuthFailure = true): Promise<Profile> {
  const token = await getGuestToken();
  const url = `${USER_BY_SCREEN_NAME}?variables=${encodeURIComponent(
    JSON.stringify({ screen_name: handle }),
  )}`;

  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${WEB_BEARER}`,
      "x-guest-token": token,
      "user-agent": UA,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(8000),
  });

  // A stale guest token reads as 401/403; burn it and try once with a fresh one.
  if ((res.status === 401 || res.status === 403) && retryOnAuthFailure) {
    await getGuestToken(true);
    return fetchFromX(handle, false);
  }
  if (!res.ok) throw new Error(`UserByScreenName ${res.status}`);

  const body = (await res.json()) as {
    data?: {
      user?: { result?: { __typename?: string; is_blue_verified?: boolean; legacy?: LegacyUser } };
    };
  };

  const result = body.data?.user?.result;
  if (!result || result.__typename === "UserUnavailable") throw new ProfileNotFound(handle);

  const legacy = result.legacy;
  if (!legacy?.screen_name) throw new ProfileNotFound(handle);

  const createdAt = legacy.created_at ? new Date(legacy.created_at) : null;
  // X serves 48px avatars by default; `_400x400` is the largest square variant.
  const avatar = legacy.profile_image_url_https?.replace(
    /_(normal|bigger|mini)\.(jpg|jpeg|png|webp|gif)$/i,
    "_400x400.$2",
  );

  return {
    handle: legacy.screen_name,
    name: legacy.name?.trim() || legacy.screen_name,
    avatar: avatar || `https://unavatar.io/x/${encodeURIComponent(handle)}`,
    bio: legacy.description?.trim() || null,
    joined: createdAt && !Number.isNaN(createdAt.valueOf()) ? createdAt.toISOString() : null,
    verified: Boolean(result.is_blue_verified),
    followers: legacy.followers_count ?? null,
    following: legacy.friends_count ?? null,
    location: legacy.location?.trim() || null,
    posts: legacy.statuses_count ?? null,
    source: "x",
  };
}

/**
 * @throws {ProfileNotFound} when X positively reports the handle does not exist.
 * Any other upstream failure degrades to the avatar-only fallback rather than
 * throwing, so a scraping outage never takes the card down.
 */
export async function resolveProfile(rawHandle: string): Promise<Profile> {
  const handle = rawHandle.trim().replace(/^@/, "");
  if (!HANDLE_RE.test(handle)) throw new ProfileNotFound(rawHandle);

  const key = handle.toLowerCase();
  const now = Date.now();
  const hit = profileCache.get(key);
  if (hit && hit.expires > now) {
    if (hit.value === null) throw new ProfileNotFound(handle);
    return hit.value;
  }

  try {
    const profile = await fetchFromX(handle);
    profileCache.set(key, { value: profile, expires: now + PROFILE_TTL });
    return profile;
  } catch (err) {
    if (err instanceof ProfileNotFound) {
      profileCache.set(key, { value: null, expires: now + NEGATIVE_TTL });
      throw err;
    }
    console.warn(`[xid] X lookup failed for @${handle}, using fallback:`, err);
    const profile: Profile = {
      handle,
      name: handle,
      avatar: `https://unavatar.io/x/${encodeURIComponent(handle)}`,
      bio: null,
      joined: null,
      verified: false,
      followers: null,
      following: null,
      location: null,
      posts: null,
      source: "fallback",
    };
    profileCache.set(key, { value: profile, expires: now + NEGATIVE_TTL });
    return profile;
  }
}
