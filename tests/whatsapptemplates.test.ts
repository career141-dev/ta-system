import assert from "node:assert/strict";
import test from "node:test";
import {
  STANDARD_ASKS,
  TEMPLATE_NAME,
  TEMPLATE_PARAMS,
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
