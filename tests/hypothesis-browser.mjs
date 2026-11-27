// Run against a local frontend started with npm run start.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const reason = "Если тебе интересно разбирать механизмы, попробуй разобраться, как движение передаётся между деталями машины.";
const summary = "Тебе интересно разбираться в устройстве машин и проверять свои идеи на практике.";
const sessionId = "11111111-1111-4111-8111-111111111111";
const requestId = "55555555-5555-4555-8555-555555555555";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? "/usr/bin/chromium",
});
try {
  for (const mode of ["llm", "retrieval_only"]) {
    const page = await browser.newPage();
    await page.addInitScript(({ sessionId, requestId }) => {
      sessionStorage.setItem("vector-active-context", JSON.stringify({ mode:"own", grade:8, studentId:4 }));
      localStorage.setItem("X-Session-ID", sessionId);
      localStorage.setItem("vector-generation-request-own", JSON.stringify({ requestId, state:"open" }));
    }, { sessionId, requestId });
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      const json = url.pathname === "/api/session"
        ? { recommendation:null, activeJob:{ requestId, jobStatus:"running", retryAfterMs:1 } }
        : url.pathname.endsWith(requestId)
          ? { status:"generated", summary, recommendationId:requestId, generation:{ mode },
              hypotheses:[{ professionId:"prof_001", title:"Инженер-механик", reason }] }
          : {};
      return route.fulfill({ json });
    });
    await page.goto(process.env.TEST_BASE_URL ?? "http://127.0.0.1:3001");
    await page.getByText(summary, { exact:true }).waitFor();
    const notice = page.getByText(/ответ модели сейчас не использован/i);
    assert.equal(await notice.count(), mode === "llm" ? 0 : 1);
    await page.getByRole("button", { name:/Посмотреть профессиональные гипотезы/ }).click();
    await page.getByText(reason, { exact:true }).waitFor();
    assert.equal(await page.getByText(reason, { exact:true }).count(), 1);
    await page.close();
  }
  console.log("PASS: stored summary and exact reason render on fresh pages in llm and retrieval_only modes");
} finally {
  await browser.close();
}
