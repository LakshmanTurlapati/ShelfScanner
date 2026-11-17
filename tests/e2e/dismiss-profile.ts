import type { Page } from "@playwright/test";

export async function acceptNotice(page: Page) {
  const agree = page.getByRole("button", { name: "Agree and continue" });
  await agree.click({ timeout: 6000 }).catch(() => undefined);
}

export async function dismissProfile(page: Page) {
  await acceptNotice(page);
  const skip = page.getByRole("button", { name: "Skip for now" });
  await skip.click({ timeout: 6000 }).catch(() => undefined);
}
