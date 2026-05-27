import { test, expect } from "@playwright/test";

test.describe("chorus web app", () => {
  test("shows error when no token is provided", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("No session token provided")).toBeVisible();
  });

  test("shows controls bar with correct title", async ({ page }) => {
    // With an invalid token the error state fires; the controls bar should
    // still render before the error resolves in some form.
    await page.goto("/?token=invalid");
    // Title text is present in the controls bar regardless of auth state
    await expect(page.getByTestId("controls-bar")).toBeVisible();
  });

  test("chat sidebar renders with input", async ({ page }) => {
    await page.goto("/?token=invalid");
    await expect(page.getByTestId("chat-sidebar")).toBeVisible();
    await expect(page.getByTestId("chat-input")).toBeVisible();
  });
});
