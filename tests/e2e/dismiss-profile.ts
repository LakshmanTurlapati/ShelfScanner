import type { Page } from "@playwright/test";

export async function dismissProfile(page: Page) {
  const skip = page.getByRole("button", { name: "Skip for now" });
  await skip.click({ timeout: 6000 }).catch(() => undefined);
}
