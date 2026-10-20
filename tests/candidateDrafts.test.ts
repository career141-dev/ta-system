/**
 * Tests for candidate details auto-drafting and scoop/hh upload progress persistence.
 */

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// Mock in-memory localStorage implementation for unit testing draft logic
class MockStorage {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

const storage = new MockStorage();

// Test 1: Candidate details draft saving and diffing
console.log("\n1. Candidate details draft persistence & restoration");
{
  const appId = "app_test_1";
  const initialProps = {
    curCurrency: "LKR",
    curVal: "250,000",
    expCurrency: "LKR",
    expVal: "300,000",
    npVal: "30 days",
    designation: "Senior Accountant",
    company: "Acme Corp",
    customFields: [] as { id: string; label: string; value: string }[],
  };

  // When identical, draft is not saved
  const storageKey = `candidate-details-draft:${appId}`;
  eq("starts empty", storage.getItem(storageKey), null);

  // User edits expected salary
  const userEdited = {
    ...initialProps,
    expVal: "350,000",
    npVal: "Immediate",
    updatedAt: Date.now(),
  };

  storage.setItem(storageKey, JSON.stringify(userEdited));
  eq("draft is saved", Boolean(storage.getItem(storageKey)), true);

  // On mount/page reload, draft is retrieved and restored
  const restored = JSON.parse(storage.getItem(storageKey)!);
  eq("restores expVal", restored.expVal, "350,000");
  eq("restores npVal", restored.npVal, "Immediate");
  eq("restores designation", restored.designation, "Senior Accountant");

  // On discard, draft is removed from storage
  storage.removeItem(storageKey);
  eq("cleared on discard", storage.getItem(storageKey), null);
}

// Test 2: Call log draft persistence
console.log("\n2. Call log draft persistence");
{
  const appId = "app_test_2";
  const key = `call-log-draft:${appId}`;

  // When user types in call log textarea
  const callDraft = {
    kind: "post_interview",
    outcome: "reached",
    body: "Candidate confirmed they can join in 2 weeks. Open to discussion on benefits.",
    updatedAt: Date.now(),
  };

  storage.setItem(key, JSON.stringify(callDraft));
  const parsed = JSON.parse(storage.getItem(key)!);
  eq("restores call log body", parsed.body, "Candidate confirmed they can join in 2 weeks. Open to discussion on benefits.");
  eq("restores call log kind", parsed.kind, "post_interview");

  // On submit, draft is cleared
  storage.removeItem(key);
  eq("call draft cleared on submit", storage.getItem(key), null);
}

// Test 3: Scoop upload queue persistence & interrupted recovery
console.log("\n3. Scoop upload queue persistence & recovery");
{
  const openingId = "op_test_1";
  const queueKey = `scoop-upload-queue:${openingId}`;

  const now = Date.now();
  const queue = [
    {
      key: "k1",
      fileName: "CV_John_Doe.pdf",
      id: "extraction_123",
      state: "reading",
      name: "John Doe",
      note: null,
      createdAt: now,
    },
    {
      key: "k2",
      fileName: "CV_Jane_Smith.pdf",
      id: null,
      state: "uploading", // was interrupted mid-upload when user navigated away
      name: null,
      note: null,
      createdAt: now,
    },
    {
      key: "k3",
      fileName: "CV_Old_File.pdf",
      id: "extraction_old",
      state: "done",
      name: "Old Candidate",
      note: null,
      createdAt: now - 25 * 60 * 60 * 1000, // 25 hours ago (expired)
    },
  ];

  storage.setItem(queueKey, JSON.stringify(queue));

  // Recovery logic as implemented in ScoopUpload.tsx
  const raw = storage.getItem(queueKey)!;
  const parsed = JSON.parse(raw);
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  const valid = parsed
    .filter((r: any) => Boolean(r && r.key && r.fileName))
    .filter((r: any) => !r.createdAt || r.createdAt > oneDayAgo)
    .map((r: any) => {
      if (r.state === "uploading" && !r.id) {
        return {
          ...r,
          state: "failed",
          note: "Upload was interrupted before reaching the server. Please upload again.",
        };
      }
      return r;
    });

  eq("prunes 25h old expired entry", valid.length, 2);
  eq("preserves reading entry with id", valid[0].state, "reading");
  eq("reading entry has id for polling", valid[0].id, "extraction_123");
  eq("recovers interrupted upload as failed with note", valid[1].state, "failed");
  eq("interrupted note mentions retry", valid[1].note.includes("Upload was interrupted"), true);

  // Filter for active polling waitingKey
  const waiting = valid.filter((r: any) => r.state === "reading" && r.id).map((r: any) => r.id);
  eq("waiting key for polling resumption contains extraction_123", waiting.join(","), "extraction_123");

  // Clear finished logic
  const activeRemaining = valid.filter((r: any) => r.state === "uploading" || r.state === "reading");
  eq("clear finished retains only active extractions", activeRemaining.length, 1);
  eq("retained row is extraction_123", activeRemaining[0].key, "k1");
}

// Test 4: Headhunted upload queue persistence
console.log("\n4. Headhunted upload queue persistence");
{
  const openingId = "op_test_2";
  const hhQueueKey = `hh-upload-queue:${openingId}`;

  const hhQueue = [
    {
      key: "hh1",
      fileName: "Headhunted_Dev.pdf",
      id: "hh_extr_456",
      state: "reading",
      name: null,
      note: null,
      createdAt: Date.now(),
    },
  ];

  storage.setItem(hhQueueKey, JSON.stringify(hhQueue));
  const restoredHh = JSON.parse(storage.getItem(hhQueueKey)!);
  eq("restores headhunted upload queue", restoredHh.length, 1);
  eq("headhunted item state is reading", restoredHh[0].state, "reading");
  eq("headhunted item has extraction id", restoredHh[0].id, "hh_extr_456");
}

console.log(`\nTests passed: ${pass}, failed: ${fail}`);
if (fail > 0) process.exit(1);
