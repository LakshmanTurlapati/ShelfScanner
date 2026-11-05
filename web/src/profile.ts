import { del, get, set } from "idb-keyval";
import { GENRES, type Genre } from "../../shared/types.ts";

export const PROFILE_KEY = "shelf-scanner-profile";

export type ProfilePick = { prefer: string; over: string };

export type SkippedProfile = { status: "skipped" };

export type SavedProfile = {
  status: "saved";
  name: string;
  genres: Genre[];
  picks: ProfilePick[];
};

export type Profile = SkippedProfile | SavedProfile;

const GENRE_SET = new Set<string>(GENRES);

function isPick(value: unknown): value is ProfilePick {
  if (!value || typeof value !== "object") return false;
  const pick = value as { prefer?: unknown; over?: unknown };
  return typeof pick.prefer === "string" && pick.prefer.trim() !== "" && typeof pick.over === "string" && pick.over.trim() !== "";
}

function savedFrom(value: unknown): SavedProfile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { status?: unknown; name?: unknown; genres?: unknown; picks?: unknown };
  if (record.status !== "saved" || typeof record.name !== "string") return null;
  const genres = Array.isArray(record.genres)
    ? [...new Set(record.genres.filter((genre): genre is Genre => typeof genre === "string" && GENRE_SET.has(genre)))]
    : [];
  const picks = Array.isArray(record.picks)
    ? record.picks.filter(isPick).map((pick) => ({ prefer: pick.prefer.trim(), over: pick.over.trim() }))
    : [];
  return { status: "saved", name: record.name, genres, picks };
}

export async function loadProfile(): Promise<Profile | null> {
  const value = await get(PROFILE_KEY);
  if (value == null) return null;
  if (value && typeof value === "object" && (value as { status?: unknown }).status === "skipped") return { status: "skipped" };
  return savedFrom(value);
}

export async function skipProfile(): Promise<void> {
  await set(PROFILE_KEY, { status: "skipped" });
}

export async function saveProfile(input: { name: string; genres: readonly string[]; picks: readonly unknown[] }): Promise<void> {
  const saved = savedFrom({ status: "saved", name: input.name, genres: [...input.genres], picks: [...input.picks] });
  if (!saved) return;
  await set(PROFILE_KEY, saved);
}

// del(PROFILE_KEY) only. idb-keyval clear() would also delete shelf-scanner-sessions.
export async function clearProfile(): Promise<void> {
  await del(PROFILE_KEY);
}
