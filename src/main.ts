import "./styles.css";
import { createTilt } from "./tilt";

type Profile = {
  handle: string;
  name: string;
  avatar: string;
  bio: string | null;
  joined: string | null;
  verified: boolean;
  followers: number | null;
  following: number | null;
  location: string | null;
  posts: number | null;
  source: "x" | "fx" | "vx" | "fallback";
};

type Theme = "onyx" | "blaze" | "chrome";

const THEMES: Record<string, Theme> = { onyx: "onyx", blaze: "blaze", chrome: "chrome" };

/**
 * Empty means "same origin", which is what Vercel / Workers deployments use.
 * Point it at a deployed function to host the static bundle somewhere without
 * one (GitHub Pages); with neither, the app degrades to unavatar-only.
 */
const API_BASE = import.meta.env.VITE_API_BASE ?? "";

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

const monthYear = new Intl.DateTimeFormat("en", { month: "short", year: "numeric" });
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

const $ = <T extends Element>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing required element: ${sel}`);
  return el;
};

const card = $<HTMLElement>("[data-card]");
const form = $<HTMLFormElement>("[data-form]");
const input = $<HTMLInputElement>("[data-input]");
const submit = $<HTMLButtonElement>("[data-submit]");
const notice = $<HTMLParagraphElement>("[data-notice]");
const hint = $<HTMLElement>("[data-hint]");
const nameEl = $<HTMLElement>("[data-name]");
const handleEl = $<HTMLElement>("[data-handle]");
const bioEl = $<HTMLElement>("[data-bio]");
const sinceEl = $<HTMLElement>("[data-since]");
const followersEl = $<HTMLElement>("[data-followers]");
const locationEl = $<HTMLElement>("[data-location]");
const postsEl = $<HTMLElement>("[data-posts]");
const validityEl = $<HTMLElement>("[data-validity]");
const verifiedEl = $<SVGSVGElement>("[data-verified]");
const authEl = $<HTMLElement>("[data-auth]");
const serialEl = $<HTMLElement>("[data-serial]");
const foil = $<HTMLElement>("[data-foil]");
const foilFace = $<HTMLImageElement>("[data-face]");
const ghost = $<HTMLElement>("[data-ghost]");
const ghostFace = $<HTMLImageElement>("[data-ghost-face]");
const ghostCode = $<HTMLElement>("[data-ghost-code]");
const microEl = $<HTMLElement>("[data-micro]");
const motionBtn = $<HTMLButtonElement>("[data-motion]");
const shareBtn = $<HTMLButtonElement>("[data-share]");
const shareLabel = $<HTMLElement>("[data-share-label]");
const downloadBtn = $<HTMLButtonElement>("[data-download]");
const downloadLabel = $<HTMLElement>("[data-download-label]");
const copyBtn = $<HTMLButtonElement>("[data-copy]");
const themeBar = $<HTMLElement>("[data-themes]");

// ---------------------------------------------------------------- tilt

/**
 * Touch-primary devices only (phones, tablets). Two consumers: the tilt button
 * -- `requestPermission()` also exists on a few desktop builds of Chrome
 * (touchscreen laptops), where a button that can never do anything would sit
 * dead on the page -- and the file share sheet, which desktop Chrome/Safari
 * advertise but whose OS sheet has no X target. See the share handler.
 */
const touchPrimary = window.matchMedia("(pointer: coarse)").matches;

/**
 * Android promotes itself to `granted` the moment the first sensor reading
 * arrives, with no prompt, so the UI has to react to that transition rather
 * than only to the iOS permission flow.
 */
let motionLive = false;

const tilt = createTilt(card, ({ x, y }) => {
  card.style.setProperty("--tx", x.toFixed(4));
  card.style.setProperty("--ty", y.toFixed(4));
  card.style.setProperty("--tm", Math.min(1, Math.hypot(x, y)).toFixed(4));

  if (!motionLive && tilt.motion === "granted" && touchPrimary) {
    motionLive = true;
    hint.textContent = "Tilt your phone. Lay it flat and hit Recenter to re-zero.";
    motionBtn.textContent = "Recenter";
    motionBtn.hidden = false;
  }
});

if (tilt.motion === "prompt" && touchPrimary) {
  motionBtn.hidden = false;
  hint.textContent = "Tap “Enable tilt”, then move your phone.";
} else if (tilt.motion === "unsupported" && !window.isSecureContext) {
  // Android over plain http reports no sensor at all rather than an error, so
  // without this the page would just silently never tilt.
  hint.textContent = "Tilt needs HTTPS — this page is insecure. Drag instead.";
}

motionBtn.addEventListener("click", async () => {
  if (tilt.motion === "granted") {
    tilt.recenter();
    return;
  }
  if ((await tilt.requestMotion()) === "denied") {
    hint.textContent = "Motion blocked — drag the card instead.";
    motionBtn.hidden = true;
  }
});

// ---------------------------------------------------------------- render

let currentHandle = "";
let currentName = "";
let currentProfile: Profile | null = null;

/**
 * How long a source may stay silent before another is put in the air BESIDE it
 * (never instead of it). Measured latencies across five handles: 0.06-0.42s
 * direct, 0.16-0.41s proxied, 0.11-1.43s unavatar warm, 25.4s unavatar cold.
 *
 * A timeout is the only honest signal here, because a refused request does not
 * necessarily produce an `error` event. That is not a detail: it is the entire
 * bug Doğancan hit. Measured against the shipped site in WebKit with
 * pbs.twimg.com blocked -- what a Zen private window does -- the portrait was
 * still blank after 20 seconds and the page had never issued a SECOND request.
 * The chain advanced on `error` alone, the blocked load simply hung, and nothing
 * ever moved it along.
 *
 * The first source is the account's own twimg file: it answers in well under
 * half a second or it is not coming, so a one-second leash costs one hedged
 * request and turns that permanent blank into a portrait at 1.3s. Later
 * candidates are proxies that fetch and re-encode, so they earn the longer wait.
 */
const AVATAR_FIRST_STALL_MS = 1000;
const AVATAR_STALL_MS = 4000;

/**
 * Bumped on every render. Type two handles quickly and the first card's requests
 * are still in the air when the second one paints; without this token the loser's
 * late bitmap would overwrite the winner's face, or its watchdog would hide it.
 */
let avatarEpoch = 0;

function profileSerial(handle: string) {
  let hash = 2166136261;
  for (const char of handle.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `XID ${Math.abs(hash >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function cardUrl() {
  const url = new URL(location.href);
  if (currentHandle) url.searchParams.set("u", currentHandle);
  return url;
}

// One source of truth for the tweet copy, used by both the native share sheet
// and the web intent so the two can never drift apart.
//
// The URL is written INTO the text rather than left to the separate `url` field.
// Web Share targets are free to ignore `url` when files are also present, and
// several do -- which is exactly what happened here: the post read "Grab yours:"
// with nothing after it. Inlining it means the link is part of the sentence and
// cannot be dropped.
//
// It carries the ACTIVE card's own URL (`?u=<handle>`), at Doğancan's request:
// the post shares the card that is actually on screen -- search for one handle
// and the shared link opens that handle's card. Visitors who land there still
// find the lookup right on the page, so the invitation to make their own is
// not lost. (Earlier versions pointed at the bare site root for that reason;
// the copy now points at the sharer's card instead.)
function shareText() {
  return `My X ID card. ✦\n\nClaim yours: ${cardUrl().toString()}`;
}

function shareIntentUrl() {
  const intent = new URL("https://twitter.com/intent/tweet");
  // `text` already carries the link, so no `url` param -- passing both makes X
  // append the same address twice.
  intent.searchParams.set("text", shareText());
  return intent.toString();
}

function render(profile: Profile) {
  currentProfile = profile;
  currentHandle = profile.handle;
  currentName = profile.name;

  nameEl.textContent = profile.name;
  handleEl.textContent = `@${profile.handle}`;
  verifiedEl.toggleAttribute("hidden", !profile.verified);
  bioEl.textContent = profile.bio?.trim() || "A public identity, minted from X.";

  const joined = profile.joined ? new Date(profile.joined) : null;
  sinceEl.textContent =
    joined && !Number.isNaN(joined.valueOf())
      ? monthYear.format(joined)
      : "—";

  followersEl.textContent = profile.followers === null ? "—" : compact.format(profile.followers);
  // The facts cell is narrow, so the location shows its first comma-separated
  // part -- the province/city ("Ankara, Türkiye" -> "Ankara"), the way a card
  // prints the place of birth rather than a full postal address.
  locationEl.textContent = profile.location?.split(",")[0]?.trim() || "—";
  postsEl.textContent = profile.posts === null ? "—" : compact.format(profile.posts);

  // The validity line in the footer: the joined date plus ten years, the way a
  // card states its expiry. Only meaningful when X gave us a real join date.
  const expiryFrom = profile.joined ? new Date(profile.joined) : null;
  const expiry = expiryFrom && !Number.isNaN(expiryFrom.valueOf()) ? expiryFrom : null;
  validityEl.hidden = !expiry;
  if (expiry) {
    expiry.setFullYear(expiry.getFullYear() + 10);
    validityEl.textContent = `VALID UNTIL ${monthYear.format(expiry)}`;
  }

  authEl.textContent =
    profile.source === "fallback"
      ? "AVATAR MODE"
      : profile.source === "x"
        ? "PUBLIC PROFILE · VERIFIED DATA"
        : "PUBLIC PROFILE · LIVE DATA";
  serialEl.textContent = profileSerial(profile.handle);
  // The string crossing the ghost portrait is the card's own serial, which is what
  // a real card does: the document number is printed into the secondary portrait
  // so that neither the number nor the face can be replaced on its own. Spaced
  // out because on the real card the characters are widely tracked.
  ghostCode.textContent = profileSerial(profile.handle).replace(/\s+/g, "");
  // The microprint band is the same document number, repeated until it spans
  // the strip -- fine enough to read as texture. overflow hidden clips the
  // repeat at the strip's edge, so the count only has to be long enough.
  microEl.textContent = (profileSerial(profile.handle).replace(/\s+/g, "") + " ").repeat(48);

  card.setAttribute(
    "aria-label",
    `Holographic X identity card for ${profile.name}, @${profile.handle}`,
  );

  // Swap only once a bitmap is ready so neither engraving flashes a blank frame.
  const show = (image: HTMLImageElement) => {
    foilFace.src = image.src;
    // Both portraits are the same head, as on a real card -- that is the whole
    // point of the ghost, so it deliberately shares the bitmap.
    ghostFace.src = image.src;
    // The ghost's laminate sweep is masked with the same bitmap so the sheen stays
    // on the head instead of painting a rectangle across the card. CSS cannot reach
    // an <img>'s src, so the URL is published as a custom property.
    ghost.style.setProperty("--ghost-src", `url("${image.src}")`);
    // Expose the stylesheet's filters for this photograph. A fixed gain cannot serve
    // both a dark and a bright one: brightness(3.3) was fitted to two dark avatars
    // and clipped 80.2% of a bright one before the tone curve ran, taking the face
    // region down to 18% of its detail. See exposure() for the measurements.
    applyExposure(exposure(image));
    foil.classList.remove("is-empty");
    ghost.classList.remove("is-empty");
  };

  const smallAvatar = profile.avatar.replace(
    /_400x400\.(jpg|jpeg|png|webp|gif)$/i,
    "_normal.$1",
  );
  const proxied = (url: string) => `https://wsrv.nl/?url=${encodeURIComponent(url)}`;
  /**
   * Ordered by the bitmap each one yields, best first -- not by how likely it is
   * to answer, because a later source is allowed to overtake an earlier one.
   *
   * `_400x400` is the original. The wsrv.nl entry re-serves that same file from a
   * third-party origin, and it is what rescues the portrait when the browser
   * refuses to speak to pbs.twimg.com at all: `twimg.com` is on the Disconnect
   * list under `Content`, which Firefox (and therefore Zen) blocks by default in
   * PRIVATE windows even on the Standard setting -- so in that one window the
   * account's own portrait is unreachable while the proxy is untouched.
   *
   * unavatar.io resolves the handle on its own, so it also survives a wrong avatar
   * URL, but it is slow on a cache miss -- 25.4s measured. `_normal` is 48x48
   * inside a 132px tile: a real last resort, and the reason a late arrival is
   * allowed to replace what is already on the card.
   *
   * Deduped: `_400x400` and `_normal` collapse to one entry whenever the pattern
   * did not match, which is the case for unavatar and other non-twimg sources.
   */
  const avatarSources = [
    ...new Set([
      profile.avatar,
      proxied(profile.avatar),
      `https://unavatar.io/x/${encodeURIComponent(profile.handle)}`,
      smallAvatar,
      proxied(smallAvatar),
    ]),
  ];

  const epoch = ++avatarEpoch;
  /** Widest bitmap adopted so far; 0 means the portrait is still blank. */
  let bestWidth = 0;
  let started = 0;
  let stall = 0;

  /**
   * Take a bitmap, but only if it beats what is already on the card.
   *
   * The chain used to hand the portrait to whatever answered last, which is how a
   * card that had already shown the 400px original ended up displaying the 48px
   * `_normal` thumbnail four seconds later. Comparing widths makes the sequence
   * monotonic instead: the first arrival appears immediately, and a better one
   * that lands later upgrades it. Exposure is remeasured because the bitmap
   * changed.
   */
  const adopt = (image: HTMLImageElement) => {
    if (epoch !== avatarEpoch || image.naturalWidth <= bestWidth) return;
    bestWidth = image.naturalWidth;
    window.clearTimeout(stall);
    foil.classList.remove("is-empty");
    ghost.classList.remove("is-empty");
    show(image);
  };

  /**
   * Put the next source in the air, and arm a watchdog on it.
   *
   * Each attempt gets its OWN Image, and that is the whole correction. Reassigning
   * `src` on one shared element makes every advance a CANCELLATION of the request
   * before it, so a slow-but-working source can never win a race it was pulled out
   * of -- and unavatar.io on a cache miss takes 25.4s. Nothing is cancelled here:
   * a stall only adds a candidate, and whichever bitmap lands first is shown.
   *
   * Running out of sources is not a failure either; it only means the card has
   * nothing to show YET. `is-empty` (which hides the portrait) may be set only
   * while no bitmap has ever been adopted, and a straggler that arrives afterwards
   * takes it straight back off. Both guards are load-bearing. Without the first, a
   * walk that has already found a good portrait blanks it on reaching the end of
   * the list -- measured at 13-21s after load on every handle. Without the second,
   * the card gives up on a source that was still coming.
   */
  const launch = () => {
    window.clearTimeout(stall);
    if (epoch !== avatarEpoch || bestWidth) return;
    const url = avatarSources[started];
    if (!url) {
      foil.classList.add("is-empty");
      ghost.classList.add("is-empty");
      return;
    }
    started += 1;
    const image = new Image();
    image.crossOrigin = "anonymous";
    // No referrer on the avatar fetch. Some avatar CDNs serve 403 to hotlinked
    // requests that carry a foreign Referer, and a cold session (incognito, no
    // cache) cannot mask such a miss the way a warmed one can.
    image.referrerPolicy = "no-referrer";
    image.decoding = "async";
    image.onload = () => adopt(image);
    image.onerror = launch;
    // Handlers first, so a bitmap already in cache cannot land before them.
    image.src = url;
    stall = window.setTimeout(launch, started === 1 ? AVATAR_FIRST_STALL_MS : AVATAR_STALL_MS);
  };

  launch();

  const url = new URL(location.href);
  url.searchParams.set("u", profile.handle);
  history.replaceState(null, "", url);
  document.title = `${profile.name} — X ID`;
}

function say(message: string, tone: "error" | "info" = "error") {
  notice.textContent = message;
  notice.dataset.tone = tone;
  notice.hidden = !message;
}

type FxProfile = {
  code?: number;
  user?: {
    screen_name?: string;
    name?: string;
    avatar_url?: string;
    description?: string;
    joined?: string;
    followers?: number;
    following?: number;
    tweets?: number;
    location?: string;
    verification?: { verified?: boolean };
  };
};

type VxProfile = {
  screen_name?: string;
  name?: string;
  profile_image_url?: string;
  description?: string;
  created_at?: string;
  followers_count?: number;
  following_count?: number;
  tweet_count?: number;
  location?: string;
};

function largeAvatar(url: string) {
  return url.replace(/_(normal|bigger|mini)\.(jpg|jpeg|png|webp|gif)$/i, "_400x400.$2");
}

async function fetchJson(url: string) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5500);
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok || !res.headers.get("content-type")?.includes("application/json")) {
      throw new Error(`public profile ${res.status}`);
    }
    return (await res.json()) as unknown;
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Static hosts cannot run our own `/api/x` function. FxTwitter and VxTwitter
 * expose the same public profile fields as CORS-enabled JSON for embed clients,
 * so they form a no-account fallback chain for GitHub Pages. The first-party
 * handler remains preferred whenever it is deployed.
 */
async function resolvePublicProfile(handle: string): Promise<Profile | null> {
  try {
    const body = (await fetchJson(
      `https://api.fxtwitter.com/${encodeURIComponent(handle)}`,
    )) as FxProfile;
    const user = body.user;
    if (body.code === 200 && user?.screen_name && user.avatar_url) {
      const joined = user.joined ? new Date(user.joined) : null;
      return {
        handle: user.screen_name,
        name: user.name?.trim() || user.screen_name,
        avatar: largeAvatar(user.avatar_url),
        bio: user.description?.trim() || null,
        joined: joined && !Number.isNaN(joined.valueOf()) ? joined.toISOString() : null,
        verified: Boolean(user.verification?.verified),
        followers: user.followers ?? null,
        following: user.following ?? null,
        location: user.location?.trim() || null,
        // FxTwitter calls it `tweets`, not statuses_count.
        posts: user.tweets ?? null,
        source: "fx",
      };
    }
  } catch {
    // VxTwitter is an independent backup, not another alias to the same API.
  }

  try {
    const user = (await fetchJson(
      `https://api.vxtwitter.com/${encodeURIComponent(handle)}`,
    )) as VxProfile;
    if (user.screen_name && user.profile_image_url) {
      const joined = user.created_at ? new Date(user.created_at) : null;
      return {
        handle: user.screen_name,
        name: user.name?.trim() || user.screen_name,
        avatar: largeAvatar(user.profile_image_url),
        bio: user.description?.trim() || null,
        joined: joined && !Number.isNaN(joined.valueOf()) ? joined.toISOString() : null,
        verified: false,
        followers: user.followers_count ?? null,
        following: user.following_count ?? null,
        location: user.location?.trim() || null,
        // VxTwitter calls it `tweet_count`, not statuses_count.
        posts: user.tweet_count ?? null,
        source: "vx",
      };
    }
  } catch {
    // The avatar-only path below is the final availability fallback.
  }

  return null;
}

function avatarOnlyProfile(handle: string): Profile {
  return {
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
}

async function load(rawHandle: string) {
  const handle = rawHandle.trim().replace(/^@/, "");
  if (!HANDLE_RE.test(handle)) {
    say("Handles are 1–15 letters, numbers, or underscores.");
    return;
  }

  say("");
  submit.disabled = true;
  submit.textContent = "…";

  try {
    const res = await fetch(`${API_BASE}/api/x?u=${encodeURIComponent(handle)}`, {
      headers: { accept: "application/json" },
    });

    // A bare 404 is ambiguous: it means "no such handle" from our function, but
    // also "no function deployed here" from a static host's own error page.
    // Only the JSON payload can tell them apart, and guessing wrong tells the
    // visitor their account does not exist.
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      if (body?.error === "not_found") {
        say(`No account named @${handle}.`);
        return;
      }
      throw new Error("no lookup service at this origin");
    }
    if (!res.ok) throw new Error(`api ${res.status}`);

    let profile = (await res.json()) as Profile;
    if (profile.source === "fallback") {
      profile = (await resolvePublicProfile(handle)) ?? profile;
    }
    render(profile);
    if (profile.source === "fallback") {
      say("X wouldn't share the details — showing the avatar only.", "info");
    }
  } catch {
    // Static host: recover full public data through the embed APIs before
    // conceding to avatar-only mode.
    const profile = (await resolvePublicProfile(handle)) ?? avatarOnlyProfile(handle);
    render(profile);
    if (profile.source === "fallback") {
      say("Profile services are busy — showing the avatar only.", "info");
    }
  } finally {
    submit.disabled = false;
    submit.textContent = "Mint";
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  input.blur();
  void load(input.value);
});

// ---------------------------------------------------------------- chrome

themeBar.addEventListener("click", (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-btn]");
  const theme = btn && THEMES[btn.dataset.themeBtn ?? ""];
  if (!btn || !theme) return;

  card.dataset.theme = theme;
  localStorage.setItem("xid:theme", theme);
  for (const other of themeBar.querySelectorAll<HTMLButtonElement>("[data-theme-btn]")) {
    other.setAttribute("aria-pressed", String(other === btn));
  }
});

const X_PATH =
  "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";

const EXPORT_THEMES: Record<Theme, {
  plate: readonly [string, string, string];
  text: string;
  dim: string;
  watermark: string;
}> = {
  onyx: {
    plate: ["#313144", "#111119", "#29263a"],
    text: "#f5f5f7",
    dim: "rgba(245,245,247,.68)",
    watermark: "rgba(255,255,255,.12)",
  },
  blaze: {
    plate: ["#a1129d", "#dc126f", "#f16832"],
    text: "#fff7fb",
    dim: "rgba(255,247,251,.78)",
    watermark: "rgba(75,0,44,.24)",
  },
  chrome: {
    plate: ["#e9ebf0", "#a1a7b3", "#f4f5f7"],
    text: "#111218",
    dim: "rgba(17,18,24,.64)",
    watermark: "rgba(22,25,36,.14)",
  },
};

function drawX(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fill(new Path2D(X_PATH));
  ctx.restore();
}

function drawXOutline(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  rotation: number,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.scale(size / 24, size / 24);
  ctx.lineWidth = 1.2 * (24 / size);
  ctx.stroke(new Path2D(X_PATH));
  ctx.restore();
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) {
  const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
  const sourceWidth = width / scale;
  const sourceHeight = height / scale;
  const sourceX = (image.naturalWidth - sourceWidth) / 2;
  const sourceY = (image.naturalHeight - sourceHeight) / 2;
  ctx.drawImage(
    image,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    x,
    y,
    width,
    height,
  );
}

/**
 * Measure a photograph and derive the engraving's exposure from it.
 *
 * The previous chain was `brightness(3.3)` -- a fixed gain fitted to two dark
 * avatars, @dcgancan (mean luma 36.3) and @avstorm (43.9), because those were the
 * only two test cases. A bright photograph destroys itself on it. Measured on
 * @dogancna (mean 182.8, median 243.1, 59.9% of pixels above 0.9): 80.2% of the
 * frame pins at the ceiling BEFORE the tone curve runs, and inside the face region
 * it is 98.1% pinned, leaving std 8.7 and 18% of the photo's detail. Everything
 * above 1/3.3 = 0.303 luma collapses to one value irrecoverably.
 *
 * A real engraving station does not apply a fixed gain -- it exposes each
 * photograph for the substrate's density range. That is what this does: per-image
 * levels plus a midtone lock, computed here and published to CSS as custom
 * properties, because a stylesheet cannot measure a bitmap.
 *
 * The statistics come from the CENTRE of the frame, not the whole thing. The
 * full-frame median describes the backdrop, not the subject -- 243.1 for @dogancna
 * (white studio ground) against 16.9 and 17.0 for the other two (dark grounds) --
 * and locking that asks for gamma 28.6 on one and 0.26 on the others. The subject's
 * own medians are far closer (158.9 / 69.8 / 114.5), and the portrait tiles crop to
 * roughly that region anyway via `object-fit: cover`.
 *
 * Every step is monotonic in luminance, so feature order always survives -- the
 * property that makes a tone map safe on a face.
 *
 * Result in the face region, @dogancna: ceiling stacking 98.1% -> 22.5%, detail
 * 18% -> 96%, std 8.7 -> 47.5. The two dark avatars stay at 91% and 66%.
 */
function exposure(image: HTMLImageElement) {
  const SAMPLE = 96;
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    drawCover(ctx, image, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    const centre: number[] = [];
    for (let y = 0; y < SAMPLE; y++) {
      for (let x = 0; x < SAMPLE; x++) {
        // the region the portrait tiles actually show
        if (y < SAMPLE * 0.3 || y > SAMPLE * 0.75) continue;
        if (x < SAMPLE * 0.28 || x > SAMPLE * 0.72) continue;
        const i = (y * SAMPLE + x) * 4;
        centre.push(
          (data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722) / 255,
        );
      }
    }
    if (centre.length < 64) return null;
    centre.sort((a, b) => a - b);
    const at = (p: number) => centre[Math.min(centre.length - 1, Math.max(0, Math.round(p * (centre.length - 1))))]!;
    let lo = at(0.05);
    let hi = at(0.95);
    if (hi - lo < 0.04) {
      // Degenerate subject (near-flat crop): fall back to the whole sample.
      lo = 0;
      hi = 1;
    }
    const median = Math.min(0.95, Math.max(0.05, (at(0.5) - lo) / Math.max(1e-6, hi - lo)));
    // TARGET is where the subject's midtone should land inside the band.
    const TARGET = 0.46;
    const gamma = Math.min(2.5, Math.max(0.4, Math.log(TARGET) / Math.log(median)));
    return { lo, hi, gamma };
  } catch {
    // A CORS-tainted bitmap cannot be read back; the CSS fallback covers it.
    return null;
  }
}

/**
 * Write an exposure into the stylesheet's filters.
 *
 * The levels and midtone stages of #portrait-engrave and #ghost-engrave are marked
 * with data-exp-levels / data-exp-gamma and carry identity values in the markup.
 * They are written here rather than driven by custom properties because SVG filter
 * primitives cannot read CSS variables -- `slope="var(--x)"` is not a thing. The
 * identity values in the HTML are therefore also the fallback: if the measurement
 * fails the portrait renders on the band alone rather than not at all.
 */
function applyExposure(exp: { lo: number; hi: number; gamma: number } | null) {
  const span = exp ? Math.max(1e-6, exp.hi - exp.lo) : 1;
  const slope = exp ? 1 / span : 1;
  const intercept = exp ? -exp.lo / span : 0;
  const gamma = exp ? exp.gamma : 1;
  document.querySelectorAll("[data-exp-levels] > *").forEach((fn) => {
    fn.setAttribute("slope", slope.toFixed(4));
    fn.setAttribute("intercept", intercept.toFixed(4));
  });
  document.querySelectorAll("[data-exp-gamma] > *").forEach((fn) => {
    fn.setAttribute("exponent", gamma.toFixed(4));
  });
}

/**
 * The grey laser engraving, as one function shared by both portraits.
 *
 * This mirrors the CSS chain exactly -- the per-image levels/gamma from
 * `exposure()` followed by `#portrait-engrave` / `#ghost-engrave`, which desaturate
 * and then map luma linearly into the engraving's tonal band. Keeping it in a
 * single place is deliberate: the export path has twice drifted away from the
 * stylesheet (a five-band posterisation, then a violet duotone) and each time the
 * card rendered correctly on screen and came out wrecked in the downloaded PNG.
 *
 * The constants are fitted, not guessed. The band (slope 0.600, intercept 0.220)
 * reproduces what polycarbonate engraving physically does: it burns grey into the
 * substrate and so cannot reach pure black or pure white. Real card portraits
 * measure p5 60.6 / p95 205.7; a raw avatar reaches p5 0.0. Fitted against both
 * test avatars at once under the constraint p5 >= 52 and p95 <= 212, which lands
 * @avstorm at 56.1/209.1 and @dcgancan at 56.3/209.1 -- 1.6 luma apart, where
 * per-avatar fits used to diverge by more than 40.
 *
 * `keyBackdrop` reproduces #ghost-engrave's alpha stage: alpha is taken from the
 * engraved luminance and gamma-shaped, so the photograph's dark backdrop drops out
 * and the head sits on the card with nothing behind it, the way an engraving does.
 * Only the ghost uses it -- the main portrait keeps its full frame, as on a card.
 */
function engrave(
  image: HTMLImageElement,
  width: number,
  height: number,
  contrast: number,
  keyBackdrop = false,
) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Engraving canvas is unavailable");
  drawCover(ctx, image, 0, 0, width, height);

  const SLOPE = 0.6;
  const INTERCEPT = 0.22;
  // Matches feFuncA gamma amplitude/exponent in #ghost-engrave. Both were swept
  // against both avatars: amplitude 4.5 keeps the backdrop at alpha 0.025 while the
  // face reaches 0.946, and preserves 2.5x the midtone variety of a first attempt at
  // 2.2, which had cleared the backdrop but left the face bipolar.
  const ALPHA_AMPLITUDE = 4.5;
  const ALPHA_EXPONENT = 4;

  // Per-image exposure, replacing a fixed brightness(3.3) that clipped 80.2% of a
  // bright photograph before the tone curve even ran. Falls back to the identity
  // levels if the bitmap cannot be measured, which keeps a tainted-canvas case
  // rendering rather than throwing.
  const exp = exposure(image) ?? { lo: 0, hi: 1, gamma: 1 };
  const span = Math.max(1e-6, exp.hi - exp.lo);

  const pixels = ctx.getImageData(0, 0, width, height);
  const { data } = pixels;
  for (let i = 0; i < data.length; i += 4) {
    // saturate(0) is a luminance projection, so the three channels collapse to one.
    const luma =
      (data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722) / 255;
    // levels, then the midtone lock -- both monotonic, so feature order survives.
    const levelled = Math.min(1, Math.max(0, (luma - exp.lo) / span));
    const locked = levelled ** exp.gamma;
    // contrast() pivots on 0.5, exactly as the CSS filter does.
    const shaped = Math.min(1, Math.max(0, (locked - 0.5) * contrast + 0.5));
    const engraved = Math.min(1, shaped * SLOPE + INTERCEPT);
    const grey = Math.round(engraved * 255);
    data[i] = grey;
    data[i + 1] = grey;
    data[i + 2] = grey;
    if (keyBackdrop) {
      const alpha = Math.min(1, ALPHA_AMPLITUDE * engraved ** ALPHA_EXPONENT);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (ctx.measureText(candidate).width <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    const lastIndex = maxLines - 1;
    let lastLine = lines[lastIndex] ?? "";
    while (lastLine && ctx.measureText(lastLine + "…").width > maxWidth) {
      lastLine = lastLine.slice(0, -1);
    }
    lines[lastIndex] = lastLine + "…";
  }
  lines.forEach((value, index) => ctx.fillText(value, x, y + index * lineHeight));
}

function canvasBlob(canvas: HTMLCanvasElement) {
  const encoded = canvas.toDataURL("image/png").split(",")[1];
  if (!encoded) throw new Error("Card image could not be encoded");
  const binary = window.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/png" });
}

async function createCardImage() {
  if (!currentProfile) throw new Error("No profile loaded");
  if (!foilFace.complete || foilFace.naturalWidth === 0) {
    await foilFace.decode();
  }

  const width = 1400;
  const height = 864;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Canvas is unavailable");

  const theme = (THEMES[card.dataset.theme ?? ""] ?? "onyx") as Theme;
  const palette = EXPORT_THEMES[theme];
  const tx = Number.parseFloat(card.style.getPropertyValue("--tx")) || 0;
  const swing = Math.max(0, Math.min(1, (tx + 1) * 0.5));
  const radius = 64;

  ctx.fillStyle = "#0b0b10";
  ctx.fillRect(0, 0, width, height);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(16, 16, width - 32, height - 32, radius);
  ctx.clip();

  const plate = ctx.createLinearGradient(0, 0, width, height);
  plate.addColorStop(0, palette.plate[0]);
  plate.addColorStop(0.48, palette.plate[1]);
  plate.addColorStop(1, palette.plate[2]);
  ctx.fillStyle = plate;
  ctx.fillRect(16, 16, width - 32, height - 32);

  ctx.strokeStyle = palette.watermark;
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 7; col++) {
      drawXOutline(
        ctx,
        720 + col * 105 + (row % 2) * 34,
        118 + row * 150,
        54 + ((row + col) % 3) * 12,
        ((row * 11 + col * 17) % 34 - 17) * (Math.PI / 180),
      );
    }
  }

  const gloss = ctx.createLinearGradient(width * (0.28 - tx * 0.2), 0, width * (0.72 - tx * 0.2), height);
  gloss.addColorStop(0, "rgba(255,255,255,0)");
  gloss.addColorStop(0.48, "rgba(255,255,255,.16)");
  gloss.addColorStop(0.52, "rgba(255,255,255,.34)");
  gloss.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gloss;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = palette.text;
  ctx.font = "800 64px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  let nameSize = 64;
  while (ctx.measureText(currentProfile.name).width > 800 && nameSize > 42) {
    nameSize -= 2;
    ctx.font = "800 " + nameSize + "px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  }
  ctx.fillText(currentProfile.name, 82, 112);

  ctx.fillStyle = palette.dim;
  ctx.font = "600 30px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText("@" + currentProfile.handle, 84, 160);

  ctx.fillStyle = palette.text;
  drawX(ctx, width - 230, 69, 58);
  ctx.font = "800 52px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText("ID", width - 155, 119);

  const portraitX = 82;
  const portraitY = 230;
  const portraitW = 365;
  const portraitH = 440;

  // The portrait is a grey laser engraving, matching the measured cards, and the
  // same curve the CSS applies: brightness 3.3, contrast 1.3, then a linear map
  // into the engraving's tonal band (slope 0.600, intercept 0.220). Two earlier
  // revisions let this path drift from the stylesheet -- first a five-band
  // posterisation, then a violet duotone -- and both times the card looked right
  // on screen and came out wrecked in the downloaded file. The maths lives in one
  // function now so the two paths cannot disagree about the print.
  const portraitCanvas = engrave(foilFace, portraitW, portraitH, 1.3);

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(portraitX, portraitY, portraitW, portraitH, 34);
  ctx.clip();
  ctx.drawImage(portraitCanvas, portraitX, portraitY);

  // The diffraction band: a spectral sweep whose position follows the tilt, the
  // same geometry as .foil__veil. `screen` adds light instead of replacing it.
  const haze = Math.max(0, Math.min(1, (Math.abs(tx) - 0.06) * 1.14));
  if (haze > 0) {
    const span = portraitW + portraitH;
    const shift = (swing - 0.5) * 1.9 * span;
    const bandGrad = ctx.createLinearGradient(
      portraitX - portraitH * 0.5 + shift,
      portraitY,
      portraitX + portraitW * 0.9 + shift,
      portraitY + portraitH,
    );
    bandGrad.addColorStop(0.26, "rgba(90,210,255,0)");
    bandGrad.addColorStop(0.38, "rgba(90,210,255,.34)");
    bandGrad.addColorStop(0.44, "rgba(186,214,255,.4)");
    bandGrad.addColorStop(0.5, "rgba(255,226,240,.56)");
    bandGrad.addColorStop(0.56, "rgba(255,150,196,.44)");
    bandGrad.addColorStop(0.62, "rgba(150,130,255,.34)");
    bandGrad.addColorStop(0.74, "rgba(150,130,255,0)");
    ctx.globalCompositeOperation = "screen";
    ctx.globalAlpha = haze * 0.5;
    ctx.fillStyle = bandGrad;
    ctx.fillRect(portraitX, portraitY, portraitW, portraitH);
  }

  // Foil microstructure, only visible off-axis like the real thing.
  ctx.globalCompositeOperation = "overlay";
  ctx.globalAlpha = 0.05 + haze * 0.22;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1;
  for (let line = -portraitH; line < portraitW; line += 10) {
    ctx.beginPath();
    ctx.moveTo(portraitX + line, portraitY);
    ctx.lineTo(portraitX + line + portraitH, portraitY + portraitH);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = theme === "chrome" ? "rgba(20,22,30,.36)" : "rgba(255,255,255,.38)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(portraitX, portraitY, portraitW, portraitH, 34);
  ctx.stroke();

  // The corner stamp, mirroring .foil__seal: a circular pressed mark at the
  // portrait's bottom-right corner, its X struck at an angle inside a round
  // frame. Coin emboss, not painted badge: one light falloff across the face,
  // crisp bright/dark rim arcs, and the light/dark edge pair on the glyph --
  // painted in passes so the relief survives the PNG. Drawn after the
  // portrait and before the details, so the text stays legible over it.
  const stampR = Math.round(portraitW * 0.25);
  const stampX = portraitX + portraitW;
  const stampY = portraitY + portraitH;
  const stampSize = stampR;
  ctx.save();
  ctx.translate(stampX, stampY);
  const surf = ctx.createLinearGradient(-stampR * 0.7, -stampR * 0.7, stampR * 0.7, stampR * 0.7);
  surf.addColorStop(0, "rgba(255,255,255,0.16)");
  surf.addColorStop(0.34, "rgba(255,255,255,0.04)");
  surf.addColorStop(0.66, "rgba(0,0,0,0.08)");
  surf.addColorStop(1, "rgba(0,0,0,0.22)");
  ctx.fillStyle = surf;
  ctx.beginPath();
  ctx.arc(0, 0, stampR, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = theme === "chrome" ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.5)";
  ctx.beginPath();
  ctx.arc(0, 0, stampR - 1.5, Math.PI * 0.75, Math.PI * 1.75);
  ctx.stroke();
  ctx.strokeStyle = theme === "chrome" ? "rgba(26,30,46,0.35)" : "rgba(0,0,0,0.45)";
  ctx.beginPath();
  ctx.arc(0, 0, stampR - 1.5, -Math.PI * 0.25, Math.PI * 0.75);
  ctx.stroke();
  ctx.strokeStyle = theme === "chrome" ? "rgba(22,25,36,0.42)" : "rgba(255,255,255,0.42)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, stampR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.rotate((-14 * Math.PI) / 180);
  ctx.fillStyle = theme === "chrome" ? "rgba(22,25,36,0.32)" : "rgba(0,0,0,0.36)";
  drawX(ctx, 1.5, 1.5, stampSize);
  ctx.fillStyle = theme === "chrome" ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.38)";
  drawX(ctx, -1.5, -1.5, stampSize);
  ctx.fillStyle = theme === "chrome" ? "rgba(17,18,24,0.2)" : "rgba(245,245,247,0.26)";
  drawX(ctx, 0, 0, stampSize);
  ctx.restore();

  const detailsX = 520;
  const detailsWidth = width - detailsX - 90;
  ctx.fillStyle = palette.text;
  ctx.font = "600 31px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  wrapCanvasText(
    ctx,
    currentProfile.bio?.trim() || "A public identity, minted from X.",
    detailsX,
    266,
    detailsWidth,
    43,
    2,
  );

  // The guilloché band between the bio and the facts (screen: .card__security):
  // fine diagonal rules, faint enough to read as stock, fading at both ends.
  const gx = ctx.createLinearGradient(detailsX, 0, width - 88, 0);
  const gInk = theme === "chrome" ? "rgba(17,18,24," : "rgba(245,245,247,";
  gx.addColorStop(0, gInk + "0)");
  gx.addColorStop(0.15, gInk + "0.08)");
  gx.addColorStop(0.85, gInk + "0.08)");
  gx.addColorStop(1, gInk + "0)");
  ctx.strokeStyle = gx;
  ctx.lineWidth = 1;
  for (let x = detailsX - 60; x < width - 28; x += 16) {
    ctx.beginPath();
    ctx.moveTo(x, 394);
    ctx.lineTo(x + 12, 352);
    ctx.stroke();
  }

  const divider = theme === "chrome" ? "rgba(18,20,28,.24)" : "rgba(255,255,255,.24)";
  ctx.strokeStyle = divider;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(detailsX, 420);
  ctx.lineTo(width - 88, 420);
  ctx.stroke();

  // The facts, now the same 2x2 grid as the screen: SINCE / FOLLOWERS over
  // LOCATION / POSTS, split at detailsX + 400. The values come straight from
  // the DOM, so the export cannot drift from the card.
  ctx.fillStyle = palette.dim;
  ctx.font = "750 18px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText("SINCE", detailsX, 470);
  ctx.fillStyle = palette.text;
  ctx.font = "700 35px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText(sinceEl.textContent || "—", detailsX, 512);

  ctx.fillStyle = palette.dim;
  ctx.font = "750 18px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText("FOLLOWERS", detailsX + 400, 470);
  ctx.fillStyle = palette.text;
  ctx.font = "700 35px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText(followersEl.textContent || "—", detailsX + 400, 512);

  ctx.strokeStyle = divider;
  ctx.beginPath();
  ctx.moveTo(detailsX, 548);
  ctx.lineTo(width - 88, 548);
  ctx.stroke();

  ctx.fillStyle = palette.dim;
  ctx.font = "750 18px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText("LOCATION", detailsX, 574);
  ctx.fillStyle = palette.text;
  // Locations run long; wrapCanvasText with one line applies the ellipsis.
  ctx.font = "700 32px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  wrapCanvasText(ctx, locationEl.textContent || "—", detailsX, 616, 380, 38, 1);

  ctx.fillStyle = palette.dim;
  ctx.font = "750 18px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText("POSTS", detailsX + 400, 574);
  ctx.fillStyle = palette.text;
  ctx.font = "700 32px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText(postsEl.textContent || "—", detailsX + 400, 616);

  // The microprint band: the document number repeated until it spans the strip
  // between the facts column and the footer rule, fine enough to read as
  // texture. Mirrors .card__micro on screen -- same band, same gradient fade
  // at the edges, and the same deterministic content, so the export cannot
  // drift from the card. Ends at the ghost's left edge (x 1138), keeping the
  // oval corner clear.
  const microText = (profileSerial(currentProfile.handle).replace(/\s+/g, "") + " ").repeat(48);
  const microFade = ctx.createLinearGradient(82, 0, 1138, 0);
  const microInk = theme === "chrome" ? "rgba(17,18,24," : "rgba(245,245,247,";
  microFade.addColorStop(0, microInk + "0)");
  microFade.addColorStop(0.12, microInk + "0.15)");
  microFade.addColorStop(0.88, microInk + "0.15)");
  microFade.addColorStop(1, microInk + "0)");
  ctx.fillStyle = microFade;
  ctx.font = "600 13px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.letterSpacing = "4px";
  ctx.fillText(microText, 82, 708);
  ctx.letterSpacing = "0px";

  // The ghost portrait, lower right, mirroring .ghost. Geometry is taken from the
  // rendered card rather than chosen: measured against the card face the ghost
  // occupies x 83-93% / y 57.1-85% -- which itself matches the real cards'
  // x 82-93% / y 52-78%. The ratio is the screen ghost's oval one (1.15), so the
  // export samples the same slice of the avatar that the on-screen tile does.
  //
  // The vertical placement is anchored to the footer rule rather than to a fraction
  // of the canvas. At y = 57.1% the tile ran to 746px and crossed the rule at 738,
  // so it is seated 26px above the rule instead -- the same clearance the screen
  // layout has, where the facts grid reserves the corner outright.
  const ghostRight = Math.round(width * 0.93);
  const ghostBottom = 712;
  const ghostW = ghostRight - Math.round(width * 0.83);
  // Matches the screen ghost's oval aspect ratio (1/1.15 in .ghost).
  const ghostH = Math.round(ghostW * 1.15);
  const ghostX = ghostRight - ghostW;
  const ghostY = ghostBottom - ghostH;

  // Same engraving, same contrast as the main portrait. It is NOT drawn at reduced
  // alpha: measured, the real ghost sits at luma 176.7 against the main portrait's
  // 168.5, so treating it as a faded watermark would be wrong. Its distinguishing
  // property is edge energy, which comes from the smaller render (measured 10.66
  // against the main portrait's 4.89) rather than from a contrast difference.
  //
  // keyBackdrop drops the photograph's dark field out, so the head sits on the card
  // with nothing behind it -- as on a real card, where the ghost is burned into the
  // polycarbonate and has no backing plate. The rounded-rectangle clip that used to
  // frame this is gone with it: clipping to a box would reinstate the boundary the
  // key removes. Everything the ghost paints from here is composited into an
  // offscreen tile first, then masked by the engraving's own alpha, so the serial
  // and the laminate cannot spill onto the bare card either.
  const ghostCanvas = engrave(foilFace, ghostW, ghostH, 1.3, true);

  const ghostTile = document.createElement("canvas");
  ghostTile.width = ghostW;
  ghostTile.height = ghostH;
  const gctx = ghostTile.getContext("2d");
  if (!gctx) throw new Error("Ghost canvas is unavailable");
  // The oval frame, same as the screen ghost. The keyed engraving alone cannot
  // kill a bright backdrop (luminance ~0.9 keys to full opacity), so the tile
  // is cut to an ellipse: whatever the head does not fill is plate, not
  // photograph. Everything drawn below (serial, laminate) stays inside it.
  gctx.beginPath();
  gctx.ellipse(ghostW / 2, ghostH / 2, ghostW / 2, ghostH / 2, 0, 0, Math.PI * 2);
  gctx.clip();
  gctx.drawImage(ghostCanvas, 0, 0);

  // The serial crossing the portrait at eye level. `difference` is what makes it
  // interleave with the engraving -- swallowed by the dark hair, legible over the
  // lit face -- which is how the two layers are printed into each other on a real
  // card so that neither can be lifted alone.
  gctx.globalCompositeOperation = "difference";
  gctx.globalAlpha = 0.34 + haze * 0.54;
  gctx.fillStyle = "rgba(255,255,255,.92)";
  gctx.font = "700 15px ui-monospace, SFMono-Regular, Menlo, monospace";
  gctx.textAlign = "center";
  gctx.fillText(
    (ghostCode.textContent || "").replace(/\s+/g, ""),
    ghostW / 2,
    ghostH * 0.52,
    ghostW * 1.12,
  );
  gctx.textAlign = "left";

  // The laminate runs across the ghost too: it is under the same sheet of
  // polycarbonate, so it cannot stay matte while the main portrait catches light.
  // Painted into the tile rather than onto the card, so the sweep stays on the head.
  if (haze > 0) {
    const gShift = (swing - 0.5) * 1.9 * (ghostW + ghostH);
    const gBand = gctx.createLinearGradient(
      -ghostH * 0.5 + gShift,
      0,
      ghostW * 0.9 + gShift,
      ghostH,
    );
    gBand.addColorStop(0.3, "rgba(90,210,255,0)");
    gBand.addColorStop(0.4, "rgba(90,210,255,.3)");
    gBand.addColorStop(0.5, "rgba(255,226,240,.5)");
    gBand.addColorStop(0.6, "rgba(150,130,255,.3)");
    gBand.addColorStop(0.7, "rgba(150,130,255,0)");
    gctx.globalCompositeOperation = "screen";
    gctx.globalAlpha = haze * 0.46;
    gctx.fillStyle = gBand;
    gctx.fillRect(0, 0, ghostW, ghostH);
  }

  // Re-apply the engraving's alpha to everything drawn above. `difference` and
  // `screen` both paint over transparent pixels, so without this the serial and the
  // laminate would show as a rectangle on the bare card -- exactly the box the
  // backdrop key removes.
  gctx.globalCompositeOperation = "destination-in";
  gctx.globalAlpha = 1;
  gctx.drawImage(ghostCanvas, 0, 0);

  ctx.globalCompositeOperation = "source-over";
  // 0.8, matching the screen ghost's opacity -- the oval sits over the plate
  // and lets a little of it through.
  ctx.globalAlpha = 0.8;
  ctx.drawImage(ghostTile, ghostX, ghostY);
  ctx.globalAlpha = 1;
  // The oval rim, same as the CSS border on .ghost.
  ctx.strokeStyle = theme === "chrome" ? "rgba(20,22,30,.3)" : "rgba(255,255,255,.32)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.ellipse(ghostX + ghostW / 2, ghostY + ghostH / 2, ghostW / 2, ghostH / 2, 0, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = divider;
  ctx.beginPath();
  ctx.moveTo(82, 738);
  ctx.lineTo(width - 82, 738);
  ctx.stroke();
  ctx.fillStyle = palette.dim;
  ctx.font = "750 17px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText(authEl.textContent || "PUBLIC PROFILE", 84, 786);
  // The validity line, centered between the auth label and the serial, matching
  // the screen footer's middle span. Hidden when there is no join date.
  ctx.textAlign = "center";
  ctx.fillText(validityEl.textContent || "", width / 2, 786);
  ctx.textAlign = "right";
  ctx.fillText(serialEl.textContent || "", width - 84, 786);
  ctx.textAlign = "left";

  ctx.strokeStyle = theme === "chrome" ? "rgba(18,20,28,.28)" : "rgba(255,255,255,.3)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(18, 18, width - 36, height - 36, radius);
  ctx.stroke();
  ctx.restore();

  return canvasBlob(canvas);
}

/**
 * Put the rendered card on the clipboard as an image.
 *
 * This is what makes desktop sharing worth doing. X's web intent cannot carry an
 * image -- attaching media needs an OAuth upload on the user's behalf -- and the
 * link cannot unfurl into the card either, because GitHub Pages serves one static
 * document for every `?u=`, so `twitter:image` cannot be per-handle. Measured on
 * the live site: `twitter:card` is `summary`, there is no `twitter:image`, and
 * `og:url` is fixed. A shared link therefore shows no card at all.
 *
 * An earlier build downloaded the PNG and asked the user to attach it by hand,
 * which left a file in Downloads for a step most people abandoned. The clipboard
 * removes both the file and the file picker: copy here, Cmd+V in the composer.
 *
 * ClipboardItem is handed a PROMISE rather than a resolved Blob. Rendering the card
 * takes an await, and Safari drops the user-activation window across an await
 * before the clipboard call -- passing the promise registers the write
 * synchronously and lets the bitmap arrive afterwards. Verified in Chromium that
 * both forms resolve and that the item reads back as image/png; the promise form is
 * used because it is the one that also holds in Safari.
 */
async function copyCardImage() {
  if (typeof ClipboardItem !== "function" || !navigator.clipboard?.write) {
    return false;
  }
  try {
    await navigator.clipboard.write([
      new ClipboardItem({ "image/png": createCardImage() }),
    ]);
    return true;
  } catch {
    // Firefox has no image clipboard support, and any browser can refuse without a
    // trusted gesture. The caller still opens the composer.
    return false;
  }
}

shareBtn.addEventListener("click", async () => {
  // Mobile first: Web Share Level 2 can hand the OS the actual PNG, which is the
  // best available path -- the user picks X and the image is already attached.
  //
  // The sheet is gated on touchPrimary for a reason: desktop Chrome and Safari
  // ALSO advertise `canShare({files})`, but the macOS/Windows sheet has no X
  // target unless the desktop X app is installed -- so on desktop the click
  // ended in a dead-end sheet and the card was never shared. Desktop always
  // takes the clipboard + composer path below instead.
  const shareProbe = new File([new Uint8Array(0)], "x-id.png", { type: "image/png" });
  const canShareFile =
    touchPrimary &&
    location.protocol === "https:" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [shareProbe] });

  shareBtn.disabled = true;
  shareLabel.textContent = "Rendering…";

  try {
    if (canShareFile) {
      const blob = await createCardImage();
      const file = new File([blob], `x-id-${currentHandle || "card"}.png`, {
        type: "image/png",
      });
      await navigator.share({
        files: [file],
        title: currentName ? `${currentName} — X ID` : "X ID",
        // No `url`: shareText() already carries it inline. Targets that honour both
        // would otherwise show the same address twice, and the ones that ignore
        // `url` alongside files are why it is inlined in the first place.
        text: shareText(),
      });
      shareLabel.textContent = "Shared";
      return;
    }

    // Desktop: copy the card, then open the composer with the text and link
    // already filled in. One paste completes the post, and nothing is downloaded.
    const copied = await copyCardImage();
    let textCopied = false;
    if (!copied) {
      // No image clipboard (Firefox, or the write was refused). The composer
      // still opens with the text, so put the same copy on the clipboard too:
      // one paste into a bare composer restores the post even if the intent tab
      // never opens, and the Download button still covers the image.
      try {
        await navigator.clipboard.writeText(shareText());
        textCopied = true;
      } catch {
        // The composer tab below carries the text either way.
      }
    }
    shareLabel.textContent = copied ? "Copied — paste in X" : "Opening X…";
    if (copied) {
      // Cleared on a timer: `say()` is otherwise sticky, and a hint left on screen
      // reads like an unresolved error once the user has already pasted.
      say("Card copied. Press Cmd/Ctrl+V in the composer to attach it.", "info");
      window.setTimeout(() => say(""), 7000);
    } else if (textCopied) {
      say("Text copied — attach the card from Download.", "info");
      window.setTimeout(() => say(""), 7000);
    }
    window.open(shareIntentUrl(), "_blank", "noopener");
  } catch (error) {
    // Dismissing the native share sheet is not an application error.
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      window.open(shareIntentUrl(), "_blank", "noopener");
    }
    shareLabel.textContent = "Share on X";
  } finally {
    shareBtn.disabled = false;
    window.setTimeout(() => {
      if (!shareBtn.disabled) shareLabel.textContent = "Share on X";
    }, 2600);
  }
});

downloadBtn.addEventListener("click", async () => {
  // Deliberately explicit. An earlier build downloaded a PNG as a side effect of
  // sharing, which left files in Downloads for an attach step most people never
  // completed; that was removed. A button that says Download and
  // produces a file is the opposite problem -- the user asked for it.
  downloadBtn.disabled = true;
  downloadLabel.textContent = "Rendering…";
  let href: string | null = null;
  try {
    const blob = await createCardImage();
    href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = `x-id-${currentHandle || "card"}.png`;
    link.click();
    downloadLabel.textContent = "Saved";
  } catch {
    downloadLabel.textContent = "Failed";
    say("Could not render the card image.");
    window.setTimeout(() => say(""), 5000);
  } finally {
    // Revoked on a delay: Safari can still be reading the blob when the click
    // returns, and revoking immediately produces an empty file.
    if (href) window.setTimeout(() => URL.revokeObjectURL(href!), 20000);
    downloadBtn.disabled = false;
    window.setTimeout(() => {
      if (!downloadBtn.disabled) downloadLabel.textContent = "Download";
    }, 2200);
  }
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(cardUrl().toString());
    copyBtn.textContent = "Copied";
  } catch {
    copyBtn.textContent = "Copy failed";
  }
  setTimeout(() => (copyBtn.textContent = "Copy link"), 1600);
});

// ---------------------------------------------------------------- boot

const savedTheme = THEMES[localStorage.getItem("xid:theme") ?? ""] ?? "onyx";
card.dataset.theme = savedTheme;
for (const btn of themeBar.querySelectorAll<HTMLButtonElement>("[data-theme-btn]")) {
  btn.setAttribute("aria-pressed", String(btn.dataset.themeBtn === savedTheme));
}

// The site root shows Doğancan's card. It doubles as the landing page the share
// copy points at ("Grab yours:"), so the card on screen has to be a real one --
// a visitor arriving from a tweet sees a finished example, then types their own
// handle into the lookup.
const initial = new URLSearchParams(location.search).get("u") ?? "dcgancan";
input.value = initial;
void load(initial);
