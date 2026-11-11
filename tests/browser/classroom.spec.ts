import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

const passphrase = "a memorable classroom phrase";
const cookieName = process.env.E2E_PRODUCTION === "1" ? "__Host-goblins_session" : "goblins_session";
const suffix = () => randomBytes(4).toString("hex");
async function signUp(page: Page, role: "teacher" | "student", username: string, code?: string) {
  await page.goto(`/signup?role=${role}`);
  if (code) await page.getByLabel("Class join code").fill(code);
  await page.getByLabel("Your name").fill(role === "teacher" ? "Ms. Rivera" : "Alex Student");
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: role === "teacher" ? "Create account" : "Join class" }).click();
}

test("teacher creates class, student joins from another browser context, teacher sees roster", async ({ browser }) => {
  const teacherContext = await browser.newContext();
  const studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage();
  const student = await studentContext.newPage();
  const id = suffix();
  try {
    await signUp(teacher, "teacher", `teacher_${id}`);
    await expect(teacher).toHaveURL(/\/dashboard$/);
    await teacher.getByLabel("Class name").fill("Period 2 Algebra");
    await teacher.getByRole("button", { name: "Create class" }).click();
    await expect(teacher.getByRole("heading", { name: "Period 2 Algebra" })).toBeVisible();
    const code = await teacher.locator(".join-code-box code").innerText();
    expect(code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
    await teacherContext.grantPermissions(["clipboard-read", "clipboard-write"]);
    await teacher.getByRole("button", { name: "Copy code" }).click();
    await expect.poll(() => teacher.evaluate(() => navigator.clipboard.readText())).toBe(code);
    await signUp(student, "student", `student_${id}`, code);
    await expect(student).toHaveURL(/\/dashboard$/);
    await expect(student.getByRole("heading", { name: "Period 2 Algebra" })).toBeVisible();
    await expect(student.getByText("Class joined successfully")).toBeVisible();
    await expect(student.getByRole("table")).toHaveCount(0);
    await teacher.reload();
    await expect(teacher.getByRole("region", { name: "Students", exact: true }).getByRole("link", { name: "Alex Student", exact: true })).toBeVisible();
    const cookie = (await teacherContext.cookies()).find((c) => c.name === cookieName);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: process.env.E2E_PRODUCTION === "1" });
    await student.getByRole("button", { name: "Sign out" }).click();
    await expect(student).toHaveURL("/");
    expect((await studentContext.cookies()).find((c) => c.name === cookieName)).toBeUndefined();
    await student.goto("/dashboard");
    await expect(student).toHaveURL(/\/login$/);
    await student.getByLabel("Username", { exact: true }).fill(`student_${id}`);
    await student.getByLabel("Passphrase", { exact: true }).fill(passphrase);
    await student.getByRole("button", { name: "Sign in" }).click();
    await expect(student).toHaveURL(/\/dashboard$/);
    await expect(student.getByRole("heading", { name: "Period 2 Algebra" })).toBeVisible();
  } finally {
    await teacherContext.close();
    await studentContext.close();
  }
});

test("invalid join code keeps student on form with an actionable error", async ({ page }) => {
  const username = `student_${suffix()}`;
  await signUp(page, "student", username, "NOTVALID");
  await expect(page.locator("form").getByRole("alert")).toContainText("That class code is not valid");
  await expect(page).toHaveURL(/\/signup\?role=student$/);
  await expect(page.getByLabel("Class join code")).toHaveValue("NOTV-ALID");
  await expect(page.getByLabel("Your name")).toHaveValue("Alex Student");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(username);
  await expect(page.getByLabel("Passphrase", { exact: true })).toHaveValue(passphrase);
});

test("mobile account forms do not overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/signup?role=student", "/login"]) {
    await page.goto(path);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
});

test("home opens directly to role pills without branding or a landing page", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("group", { name: "Account type" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Student", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("heading", { name: "Join class" })).toBeVisible();
  await expect(page.locator("header, footer, .brand, .hero")).toHaveCount(0);
  await expect(page.getByText("Save your username and passphrase somewhere safe", { exact: false })).toBeVisible();
  await page.getByLabel("Your name").fill("Alex");
  await page.getByLabel("Username", { exact: true }).fill("alex_kept");
  await page.getByLabel("Passphrase", { exact: true }).fill(passphrase);
  await page.getByRole("button", { name: "Teacher", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Teacher account" })).toBeVisible();
  await expect(page.getByLabel("Class join code")).toHaveCount(0);
  await expect(page.getByLabel("Your name")).toHaveValue("Alex");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue("alex_kept");
  await expect(page.getByLabel("Passphrase", { exact: true })).toHaveValue(passphrase);
});

for (const role of ["student", "teacher"] as const) {
  test(`${role} short passphrase is red and preserves every field`, async ({ page }) => {
    await page.goto(`/signup?role=${role}`);
    if (role === "student") await page.getByLabel("Class join code").fill("ABCD1234EF56");
    await page.getByLabel("Your name").fill("Alex Kept");
    await page.getByLabel("Username", { exact: true }).fill("alex_kept");
    const input = page.getByLabel("Passphrase", { exact: true });
    await input.fill("short");
    await page.getByRole("button", { name: role === "student" ? "Join class" : "Create account", exact: true }).click();
    await expect(input).toHaveAttribute("minlength", "12");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveCSS("border-color", "rgb(180, 35, 24)");
    await expect(page.getByText("At least 12 characters required.")).toHaveCSS("color", "rgb(180, 35, 24)");
    await expect(page.getByLabel("Your name")).toHaveValue("Alex Kept");
    await expect(page.getByLabel("Username", { exact: true })).toHaveValue("alex_kept");
    await expect(input).toHaveValue("short");
    if (role === "student") await expect(page.getByLabel("Class join code")).toHaveValue("ABCD-1234-EF56");
    await input.fill("12345678901");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await input.fill("123456789012");
    await expect(input).not.toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Username", { exact: true })).toHaveValue("alex_kept");
  });
}

test("teacher duplicate username response preserves name, username and passphrase", async ({ page }) => {
  const username = `teacher_${suffix()}`;
  await signUp(page, "teacher", username);
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL("/");
  await signUp(page, "teacher", username);
  await expect(page.locator("form").getByRole("alert")).toContainText("That username is not available");
  await expect(page.getByLabel("Your name")).toHaveValue("Ms. Rivera");
  await expect(page.getByLabel("Username", { exact: true })).toHaveValue(username);
  await expect(page.getByLabel("Passphrase", { exact: true })).toHaveValue(passphrase);
});

test("rejects a cross-origin Server Action request", async ({ page, request }) => {
  await page.goto("/login");
  const fields = await page.locator('form input[type="hidden"]').evaluateAll((inputs) => Object.fromEntries(inputs.map((input) => {
    const field = input as HTMLInputElement;
    return [field.name, field.value];
  })));
  expect(Object.keys(fields).some((name) => name.startsWith("$ACTION_"))).toBe(true);
  const response = await request.post("/login", {
    headers: { Origin: "https://untrusted.example" },
    multipart: { ...fields, username: "test_user", passphrase },
  });
  expect(response.status()).toBeGreaterThanOrEqual(400);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});
