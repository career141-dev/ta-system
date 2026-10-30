import assert from "node:assert/strict";
import test from "node:test";
import {
  STANDARD_ASKS,
  TEMPLATE_NAME,
  TEMPLATE_PARAMS,
  NO_ROLE_LINK,
  initialOutreachText,
  roleLink,
  demoTemplateParams,
  templatePayload,
} from "../convex/lib/whatsappTemplates";

test("the demo uses the two approved Career141 templates with their approved parameter counts", () => {
  const sample = { candidateName: "Kamal Perera", jobTitle: "Accountant" };
  const initial = demoTemplateParams("initial_outreach", sample);
  const reminder = demoTemplateParams("reengagement", sample);

  assert.equal(TEMPLATE_NAME.initial_outreach, "career141_initial_outreach");
  assert.equal(TEMPLATE_NAME.reengagement, "career141_followup_reminder");
  assert.equal(initial.length, TEMPLATE_PARAMS.initial_outreach);
  assert.equal(reminder.length, TEMPLATE_PARAMS.reengagement);
  assert.deepEqual(initial.slice(0, 2), [sample.candidateName, sample.jobTitle]);
  assert.deepEqual(reminder, [sample.candidateName, sample.jobTitle]);
  assert.match(initial[2], /^https:\/\/www\.linkedin\.com\/jobs\/view\/\d+$/);
  for (const ask of STANDARD_ASKS) assert.match(initial[3], new RegExp(ask.replace("/", "\\/")));
});

test("the shared request builder preserves order and removes whitespace Meta rejects", () => {
  const payload = templatePayload(
    "initial_outreach",
    "94771234567",
    [" Kamal\nPerera ", "Senior\tAccountant", "One   two", "CV | Salary"],
    "en",
  );

  assert.deepEqual(payload, {
    messaging_product: "whatsapp",
    to: "94771234567",
    type: "template",
    template: {
      name: "career141_initial_outreach",
      language: { code: "en" },
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", text: "Kamal Perera" },
            { type: "text", text: "Senior Accountant" },
            { type: "text", text: "One two" },
            { type: "text", text: "CV | Salary" },
          ],
        },
      ],
    },
  });
});

test("{{3}} is the opening's LinkedIn job, on its public address, live before draft", () => {
  const link = roleLink(
    [
      { channel: "linkedin", status: "closed", externalUrl: "https://www.linkedin.com/jobs/view/1111111111" },
      { channel: "linkedin", status: "draft", externalUrl: "https://www.linkedin.com/jobs/view/2222222222" },
      { channel: "facebook", status: "live", externalUrl: "https://www.linkedin.com/jobs/view/3333333333" },
      { channel: "linkedin", status: "live", externalUrl: "https://www.linkedin.com/hiring/jobs/4444444444/detail" },
    ],
    "career141.com/apply/acct",
  );
  assert.equal(link, "https://www.linkedin.com/jobs/view/4444444444");
});

test("{{3}} falls back to the short apply link — a Recruiter project link is not for candidates", () => {
  const posts = [{ channel: "linkedin", status: "live", externalUrl: "https://www.linkedin.com/talent/hire/1528413625/discover" }];
  assert.equal(roleLink(posts, "career141.com/apply/acct"), "https://career141.com/apply/acct");
  assert.equal(roleLink([], "https://career141.com/apply/acct"), "https://career141.com/apply/acct");
});

test("{{3}} with neither link is the owner's sentence, and the stored text matches the template", () => {
  assert.equal(roleLink([{ channel: "linkedin", status: "live", externalUrl: null }], null), NO_ROLE_LINK);
  const text = initialOutreachText("Kamal", "Accountant", NO_ROLE_LINK, "• CV / Resume");
  assert.match(text, /^Hi Kamal,\n\nBased on your profile, we would like to connect with you regarding a Accountant opportunity/);
  assert.match(text, /using the link below:\n\nOur team will share the role details with you shortly\.\n\nTo proceed/);
  assert.match(text, /following details:\n\n• CV \/ Resume\n\nWe would appreciate/);
});
