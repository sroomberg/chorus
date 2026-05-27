import { test, expect } from "@playwright/test";

test.describe("chorus web app", () => {
  test("shows error when no token is provided", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("No session token provided")).toBeVisible();
  });

  test("shows join screen when token is present", async ({ page }) => {
    await page.goto("/?token=sometoken");
    await expect(page.getByTestId("join-name-input")).toBeVisible();
    await expect(page.getByTestId("join-submit")).toBeVisible();
  });

  test("join button is disabled until name is entered", async ({ page }) => {
    await page.goto("/?token=sometoken");
    await expect(page.getByTestId("join-submit")).toBeDisabled();
    await page.getByTestId("join-name-input").fill("Alice");
    await expect(page.getByTestId("join-submit")).toBeEnabled();
  });

  test("submitting name transitions to session view", async ({ page }) => {
    await page.goto("/?token=sometoken");
    await page.getByTestId("join-name-input").fill("Alice");
    await page.getByTestId("join-submit").click();
    await expect(page.getByTestId("controls-bar")).toBeVisible();
    await expect(page.getByTestId("chat-sidebar")).toBeVisible();
  });
});
