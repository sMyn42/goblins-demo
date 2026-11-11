import { test, expect, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
const completeWork = "x + 3 = 7\nx = 7 - 3\nx = 4";
async function signup(page: Page, role: "teacher" | "student", suffix: string, code?: string) {
  await page.goto(`/signup?role=${role}`);
  if (code) await page.getByLabel("Class join code").fill(code);
  await page.getByLabel("Your name").fill(role === "teacher" ? "Teacher" : "Student");
  await page.getByLabel("Username", { exact: true }).fill(`${role}_${suffix}`);
  await page.getByLabel("Passphrase", { exact: true }).fill("a safe classroom phrase");
  await page.getByRole("button", { name: role === "teacher" ? "Create account" : "Join class", exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
}
async function publish(page: Page, drafts: boolean) {
  await page.getByLabel("Class name").fill("Algebra");
  await page.getByRole("button", { name: "Create class", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Algebra", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Approve rubric for problem 1", exact: true }).click();
  await expect(page.locator("details.problem-editor")).not.toHaveAttribute("open");
  if (drafts) await page.getByLabel("Show draft grades to students while awaiting teacher approval").check();
  await page.getByRole("button", { name: "Publish assignment" }).click();
  await expect(page.getByRole("heading", { name: "Algebra practice", exact: true })).toBeVisible();
  return page.locator(".join-code-box code").innerText();
}
for (const drafts of [false, true]) test(`typed pipeline and teacher approval with draft visibility ${drafts}`, async ({ browser }) => {
  const teacherContext = await browser.newContext(), studentContext = await browser.newContext();
  const teacher = await teacherContext.newPage(), student = await studentContext.newPage();
  const suffix = randomBytes(4).toString("hex");
  try {
    await signup(teacher, "teacher", suffix);
    const code = await publish(teacher, drafts);
    await signup(student, "student", suffix, code);
    await student.getByRole("link", { name: "Algebra practice", exact: true }).click();
    await expect(student.getByText("Solve x + 3 = 7. Show your work.", { exact: true })).toBeVisible();
    await student.getByLabel("Your work").fill(completeWork);
    await student.getByRole("button", { name: "Submit answer", exact: true }).click();
    await expect(student.getByTestId("problem-status")).toHaveText("Waiting for teacher");
    await expect(student.getByTestId("assignment-status")).toContainText("Waiting for teacher");
    await expect(student.getByTestId("final-grade")).toHaveCount(0);
    if (drafts) await expect(student.getByTestId("draft-grade")).toContainText("Draft — awaiting teacher approval");
    else await expect(student.getByTestId("draft-grade")).toHaveCount(0);
    const status = await (await student.request.get("/api/practice")).json();
    expect(status.submissions[0].finalGrade).toBeNull();
    if (!drafts) expect(status.submissions[0].draftGrade).toBeNull();
    await teacher.getByRole("link", { name: "Algebra practice", exact: true }).click();
    await expect(teacher.getByRole("button", { name: "Approve and release", exact: true })).toBeVisible();
    await teacher.getByRole("button", { name: "Approve and release", exact: true }).click();
    await expect(student.getByTestId("final-grade")).toContainText("Teacher-approved final grade: 10 points");
    await student.reload();
    await expect(student.getByTestId("final-grade")).toBeVisible();
    await expect(student.getByRole("button", { name: "Submit answer", exact: true })).toHaveCount(0);
    const returningContext = await browser.newContext();
    try {
      const returning = await returningContext.newPage();
      await returning.goto("/login");
      await returning.getByLabel("Username", { exact: true }).fill(`student_${suffix}`);
      await returning.getByLabel("Passphrase", { exact: true }).fill("a safe classroom phrase");
      await returning.getByRole("button", { name: "Sign in", exact: true }).click();
      await returning.getByRole("link", { name: "Algebra practice", exact: true }).click();
      await expect(returning.getByTestId("final-grade")).toContainText("10 points");
    } finally { await returningContext.close(); }
    if (!drafts && process.env.UPDATE_SCREENSHOTS === "1") {
      await teacher.getByText("Student — answer and evidence", { exact: true }).click();
      await teacher.screenshot({ path: "docs/screenshots/teacher-grading-report.png", fullPage: true });
      await student.screenshot({ path: "docs/screenshots/student-final-grade.png", fullPage: true });
    }
  } finally { await teacherContext.close(); await studentContext.close(); }
});
test("canvas original is stored privately, mock OCR runs, and another student cannot read it", async ({ browser }) => {
  const teacherContext = await browser.newContext(), studentContext = await browser.newContext(), otherContext = await browser.newContext();
  const teacher = await teacherContext.newPage(), student = await studentContext.newPage(), other = await otherContext.newPage();
  const suffix = randomBytes(4).toString("hex");
  try {
    await signup(teacher, "teacher", suffix);
    const code = await publish(teacher, false);
    await signup(student, "student", suffix, code);
    await student.getByRole("link", { name: "Algebra practice", exact: true }).click();
    await student.getByRole("button", { name: "Write answer", exact: true }).click();
    const box = await student.getByLabel("Write your answer").boundingBox();
    if (!box) throw new Error("Canvas missing");
    await student.mouse.move(box.x + 30, box.y + 30); await student.mouse.down();
    await student.mouse.move(box.x + 100, box.y + 60, { steps: 5 }); await student.mouse.up();
    await student.getByRole("button", { name: "Submit answer", exact: true }).click();
    await expect(student.getByTestId("problem-status")).toHaveText("Waiting for teacher");
    const data = await (await student.request.get("/api/practice")).json();
    const imagePath = `/api/submissions/${data.submissions[0].id}/image`;
    const image = await student.request.get(imagePath);
    expect(image.ok()).toBe(true); expect(image.headers()["content-type"]).toBe("image/png");
    expect(image.headers()["cache-control"]).toContain("no-store");
    await signup(other, "student", `${suffix}_other`, code);
    expect((await other.request.get(imagePath)).status()).toBe(403);
    expect((await teacher.request.get(imagePath)).status()).toBe(200);
    await teacher.reload();
    await teacher.getByRole("link", { name: "Algebra practice", exact: true }).click();
    await teacher.getByText("Student — answer and evidence", { exact: true }).click();
    await expect(teacher.getByText("fixture-ocr-v1", { exact: false })).toBeVisible();
  } finally { await teacherContext.close(); await studentContext.close(); await otherContext.close(); }
});
