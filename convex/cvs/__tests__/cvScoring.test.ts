import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Use require() since tsx transpiles to CJS — no top-level await needed
import {
  getSkillDomain,
  normaliseSkill,
  scoreSkills,
  buildDeterministicTaReason,
} from "../cvScoring";

// ─── getSkillDomain ────────────────────────────────────────────────────────

describe("getSkillDomain", () => {
  it("returns 'programming' for C, C++, Java, Python, etc.", () => {
    assert.equal(getSkillDomain("C"), "programming");
    assert.equal(getSkillDomain("C++"), "programming");
    assert.equal(getSkillDomain("C#"), "programming");
    assert.equal(getSkillDomain("Java"), "programming");
    assert.equal(getSkillDomain("Python"), "programming");
    assert.equal(getSkillDomain("JavaScript"), "programming");
    assert.equal(getSkillDomain("TypeScript"), "programming");
    assert.equal(getSkillDomain("Go"), "programming");
    assert.equal(getSkillDomain("Ruby"), "programming");
    assert.equal(getSkillDomain("PHP"), "programming");
    assert.equal(getSkillDomain("Swift"), "programming");
    assert.equal(getSkillDomain("Kotlin"), "programming");
    assert.equal(getSkillDomain("R"), "programming");
  });

  it("returns 'business' for negotiation, sales, etc.", () => {
    assert.equal(getSkillDomain("Negotiation"), "business");
    assert.equal(getSkillDomain("Sales"), "business");
    assert.equal(getSkillDomain("Business Development"), "business");
    assert.equal(getSkillDomain("Account Management"), "business");
    assert.equal(getSkillDomain("Customer Relationship"), "business");
    assert.equal(getSkillDomain("Marketing"), "business");
    assert.equal(getSkillDomain("Finance"), "business");
  });

  it("returns 'trade' for tea trading, export, supply chain, etc.", () => {
    assert.equal(getSkillDomain("Tea Trading"), "trade");
    assert.equal(getSkillDomain("Export"), "trade");
    assert.equal(getSkillDomain("Import"), "trade");
    assert.equal(getSkillDomain("International Trade"), "trade");
    assert.equal(getSkillDomain("Supply Chain"), "trade");
    assert.equal(getSkillDomain("Logistics"), "trade");
    assert.equal(getSkillDomain("Procurement"), "trade");
    assert.equal(getSkillDomain("Customs Clearance"), "trade");
    assert.equal(getSkillDomain("Tea Grading"), "trade");
  });

  it("returns 'soft_skills' for communication, leadership, etc.", () => {
    assert.equal(getSkillDomain("Communication"), "soft_skills");
    assert.equal(getSkillDomain("Leadership"), "soft_skills");
    assert.equal(getSkillDomain("Team Management"), "soft_skills");
    assert.equal(getSkillDomain("Problem Solving"), "soft_skills");
    assert.equal(getSkillDomain("Presentation"), "soft_skills");
    assert.equal(getSkillDomain("Networking"), "soft_skills");
  });

  it("returns 'framework' for React, Angular, Vue, etc.", () => {
    assert.equal(getSkillDomain("React"), "framework");
    assert.equal(getSkillDomain("Angular"), "framework");
    assert.equal(getSkillDomain("Vue"), "framework");
    assert.equal(getSkillDomain("Node.js"), "framework");
    assert.equal(getSkillDomain("Django"), "framework");
    assert.equal(getSkillDomain("Spring"), "framework");
    assert.equal(getSkillDomain("Flutter"), "framework");
  });

  it("returns 'data' for Excel, Tableau, MongoDB, etc.", () => {
    assert.equal(getSkillDomain("Excel"), "data");
    assert.equal(getSkillDomain("Power BI"), "data");
    assert.equal(getSkillDomain("Tableau"), "data");
    assert.equal(getSkillDomain("MongoDB"), "data");
    assert.equal(getSkillDomain("Machine Learning"), "data");
  });

  it("returns 'infrastructure' for AWS, Docker, etc.", () => {
    assert.equal(getSkillDomain("AWS"), "infrastructure");
    assert.equal(getSkillDomain("Azure"), "infrastructure");
    assert.equal(getSkillDomain("Docker"), "infrastructure");
    assert.equal(getSkillDomain("Kubernetes"), "infrastructure");
    assert.equal(getSkillDomain("Git"), "infrastructure");
    assert.equal(getSkillDomain("Linux"), "infrastructure");
  });

  it("returns 'unknown' for unrecognized skills", () => {
    assert.equal(getSkillDomain("Random Skill"), "unknown");
    assert.equal(getSkillDomain("Banana Sorting"), "unknown");
    assert.equal(getSkillDomain("Quantum Field Theory"), "unknown");
  });
});

// ─── normaliseSkill ────────────────────────────────────────────────────────

describe("normaliseSkill", () => {
  it("normalizes programming language aliases", () => {
    assert.equal(normaliseSkill("js"), "JavaScript");
    assert.equal(normaliseSkill("node.js"), "Node.js");
    assert.equal(normaliseSkill("reactjs"), "React");
    assert.equal(normaliseSkill("react.js"), "React");
    assert.equal(normaliseSkill("vuejs"), "Vue");
    assert.equal(normaliseSkill("c sharp"), "C#");
    assert.equal(normaliseSkill("csharp"), "C#");
    assert.equal(normaliseSkill("golang"), "Go");
    assert.equal(normaliseSkill("python3"), "Python");
    assert.equal(normaliseSkill("ts"), "TypeScript");
  });

  it("normalizes business/trade aliases", () => {
    assert.equal(normaliseSkill("crm"), "Customer Relationship");
    assert.equal(normaliseSkill("customer relationship management"), "Customer Relationship");
    assert.equal(normaliseSkill("biz dev"), "Business Development");
    assert.equal(normaliseSkill("new business"), "Business Development");
    assert.equal(normaliseSkill("b2b sales"), "Sales");
    assert.equal(normaliseSkill("tea auction"), "Tea Trading");
    assert.equal(normaliseSkill("tea market"), "Tea Trading");
    assert.equal(normaliseSkill("export documentation"), "Export");
    assert.equal(normaliseSkill("supply chain management"), "Supply Chain");
    assert.equal(normaliseSkill("scm"), "Supply Chain");
  });

  it("normalizes soft skill aliases", () => {
    assert.equal(normaliseSkill("interpersonal skills"), "Communication");
    assert.equal(normaliseSkill("presentation skills"), "Communication");
    assert.equal(normaliseSkill("team lead"), "Leadership");
    assert.equal(normaliseSkill("people management"), "Leadership");
    assert.equal(normaliseSkill("team building"), "Team Management");
  });

  it("returns original skill if no alias found", () => {
    assert.equal(normaliseSkill("Banana Sorting"), "Banana Sorting");
    assert.equal(normaliseSkill("Quantum Computing"), "Quantum Computing");
  });
});

// ─── scoreSkills — Domain Gate Tests ───────────────────────────────────────

describe("scoreSkills — Domain Gate", () => {
  const TEA_TRADER_REQUIRED = [
    "Tea Trading",
    "Export",
    "International Trade",
    "Negotiation",
    "Sales",
    "Supply Chain",
    "Communication",
    "Tea Grading",
  ];

  const TEA_TRADER_PREFERRED = [
    "Tea Auction",
    "Procurement",
    "Logistics",
  ];

  it("C (programming) does NOT match any Tea Trader requirement", () => {
    const candidateSkills = ["C", "C++", "C#", "Java"];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 0, "No required skills should match");
    assert.equal(result.matchedPreferred.length, 0, "No preferred skills should match");
    assert.equal(result.missingRequired.length, TEA_TRADER_REQUIRED.length, "All required should be missing");
    assert.ok(result.score < 20, "Score should be very low for a non-matching candidate");
  });

  it("C++ (programming) does NOT match any Tea Trader requirement", () => {
    const candidateSkills = ["C++", "Python", "JavaScript"];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 0);
    assert.equal(result.matchedPreferred.length, 0);
  });

  it("Java (programming) does NOT match any Tea Trader requirement", () => {
    const candidateSkills = ["Java", "Spring Boot", "SQL"];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 0);
    assert.equal(result.matchedPreferred.length, 0);
  });

  it("Python (programming) does NOT match any Tea Trader requirement", () => {
    const candidateSkills = ["Python", "Django", "Machine Learning"];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 0);
    assert.equal(result.matchedPreferred.length, 0);
  });

  it("React (framework) does NOT match any Tea Trader requirement", () => {
    const candidateSkills = ["React", "TypeScript", "Node.js"];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 0);
    assert.equal(result.matchedPreferred.length, 0);
  });

  it("AWS (infrastructure) does NOT match any Tea Trader requirement", () => {
    const candidateSkills = ["AWS", "Docker", "Kubernetes"];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 0);
    assert.equal(result.matchedPreferred.length, 0);
  });

  it("Tea Trader skills DO match Tea Trader requirements", () => {
    const candidateSkills = [
      "Tea Trading",
      "Export",
      "International Trade",
      "Negotiation",
      "Sales",
      "Supply Chain",
      "Communication",
      "Tea Grading",
    ];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, TEA_TRADER_REQUIRED.length, "All required should match");
    assert.equal(result.missingRequired.length, 0, "Nothing should be missing");
    // Candidate matches all 8 required skills (70 pts) + 2 preferred skills ("Tea Auction" via synonym + "Tea Grading" directly = 20 pts) -> Total = 90
    assert.ok(result.score >= 80, "Score should be >= 80 (all required + preferred via synonym)");
  });

  it("Tea Trader candidate with synonyms matches correctly", () => {
    const candidateSkills = [
      "tea auction",
      "export docs",
      "international trade",
      "contract negotiation",
      "b2b sales",
      "supply chain management",
      "interpersonal skills",
      "tea tasting",
    ];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, TEA_TRADER_REQUIRED.length, "All required should match via synonyms");
    assert.equal(result.missingRequired.length, 0);
  });

  it("Partial Tea Trader match — some skills present", () => {
    const candidateSkills = ["Tea Trading", "Sales", "Communication"];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 3, "3 skills should match");
    assert.equal(result.missingRequired.length, 5, "5 skills should be missing");
    assert.ok(result.score >= 20, "Score should be moderate (>= 20)");
  });

  it("Cross-domain: programming skills don't bleed into business match", () => {
    const candidateSkills = [
      "C",
      "JavaScript",
      "Tea Trading",
      "Export",
      "Negotiation",
    ];
    const result = scoreSkills(TEA_TRADER_REQUIRED, TEA_TRADER_PREFERRED, candidateSkills);
    assert.equal(result.matchedRequired.length, 3, "Only Tea Trading, Export, Negotiation should match");
    assert.ok(!result.matchedRequired.includes("C"), "C should not be in matched");
    assert.ok(!result.matchedRequired.includes("JavaScript"), "JavaScript should not be in matched");
  });

  it("Tech JD: programming skills match correctly", () => {
    const techRequired = ["JavaScript", "React", "Node.js", "SQL", "Git"];
    const techPreferred = ["TypeScript", "Docker", "AWS"];
    const candidateSkills = ["JavaScript", "React", "Node.js", "MySQL", "GitHub", "TypeScript", "Docker"];
    const result = scoreSkills(techRequired, techPreferred, candidateSkills);
    assert.equal(result.matchedRequired.length, 5, "All required should match (MySQL→SQL, GitHub→Git)");
    assert.ok(result.score >= 90, "Score should be high");
  });

  it("No skills required returns default score", () => {
    const result = scoreSkills([], [], ["Any Skill"]);
    assert.equal(result.score, 75, "Default score when no requirements");
    assert.equal(result.matchedRequired.length, 0);
    assert.equal(result.missingRequired.length, 0);
  });
});

// ─── buildDeterministicTaReason — Domain Confidence ────────────────────────

describe("buildDeterministicTaReason — Domain Confidence", () => {
  it("includes domain relevance note for low-confidence matches", () => {
    const candidate = {
      index: 0,
      cv: {
        _id: "test-id" as any,
        fullName: "John Doe",
        currentTitle: "Software Engineer",
        skills: ["C", "Java"],
      },
      titleScore: 50,
      seniorityScore: 70,
      experienceScore: 60,
      skillScore: 10,
      industryScore: 45,
      locationScore: 85,
      overallScore: 55,
      locationStatus: "match" as const,
      matchedRequired: [],
      missingRequired: ["Tea Trading", "Export", "Negotiation"],
      matchedPreferred: [],
      reason: "",
    };
    const req = {
      title: "Tea Trader",
      requiredSkills: ["Tea Trading", "Export", "Negotiation", "Sales"],
      preferredSkills: [],
      minYearsExperience: 5,
      industry: "Tea Export",
      seniority: "mid",
      location: "Colombo",
      education: null,
      summary: "Tea trading role",
      keywords: [],
      languages: [],
      alternativeTitles: [],
      occupationSynonyms: [],
    };
    const reason = buildDeterministicTaReason(candidate, req as any);
    assert.ok(reason.includes("Partial alignment"), "Should indicate partial match");
    assert.ok(reason.includes("Skill gaps"), "Should mention skill gaps");
    assert.ok(!reason.includes("Key matching skills"), "Should not list matching skills when none matched");
  });

  it("does NOT include domain note for high-confidence matches", () => {
    const candidate = {
      index: 0,
      cv: {
        _id: "test-id" as any,
        fullName: "Jane Smith",
        currentTitle: "Tea Trader",
        skills: ["Tea Trading", "Export", "Negotiation"],
      },
      titleScore: 90,
      seniorityScore: 85,
      experienceScore: 80,
      skillScore: 95,
      industryScore: 100,
      locationScore: 100,
      overallScore: 90,
      locationStatus: "match" as const,
      matchedRequired: ["Tea Trading", "Export", "Negotiation"],
      missingRequired: [],
      matchedPreferred: [],
      reason: "",
    };
    const req = {
      title: "Tea Trader",
      requiredSkills: ["Tea Trading", "Export", "Negotiation", "Sales"],
      preferredSkills: [],
      minYearsExperience: 5,
      industry: "Tea Export",
      seniority: "mid",
      location: "Colombo",
      education: null,
      summary: "Tea trading role",
      keywords: [],
      languages: [],
      alternativeTitles: [],
      occupationSynonyms: [],
    };
    const reason = buildDeterministicTaReason(candidate, req as any);
    assert.ok(reason.includes("Strong TA match"), "Should indicate strong match");
    assert.ok(reason.includes("Key matching skills"), "Should list matching skills");
    assert.ok(!reason.includes("tangentially related"), "Should NOT include domain warning for high-confidence");
  });
});

// ─── Edge Cases ────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("empty candidate skills returns all missing", () => {
    const result = scoreSkills(
      ["Tea Trading", "Export"],
      [],
      []
    );
    assert.equal(result.matchedRequired.length, 0);
    assert.equal(result.missingRequired.length, 2);
    assert.equal(result.matchedPreferred.length, 0);
  });

  it("empty required skills returns default score", () => {
    const result = scoreSkills([], [], ["Tea Trading", "Export"]);
    assert.equal(result.score, 75);
  });

  it("duplicate candidate skills are handled correctly", () => {
    const result = scoreSkills(
      ["Tea Trading", "Export"],
      [],
      ["Tea Trading", "Tea Trading", "Export"]
    );
    assert.equal(result.matchedRequired.length, 2);
    assert.equal(result.missingRequired.length, 0);
  });

  it("case-insensitive matching works", () => {
    const result = scoreSkills(
      ["tea trading", "export"],
      [],
      ["Tea Trading", "Export"]
    );
    assert.equal(result.matchedRequired.length, 2);
    assert.equal(result.missingRequired.length, 0);
  });

  it("single-character skills only match exactly, never via substring", () => {
    // "C" should match "C" exactly
    const result1 = scoreSkills(["C"], [], ["C"]);
    assert.equal(result1.matchedRequired.length, 1, "C matches C exactly");

    // "C" should NOT match "C++" (different skill)
    const result2 = scoreSkills(["C++"], [], ["C"]);
    assert.equal(result2.matchedRequired.length, 0, "C does not match C++");

    // "C++" should NOT match "C" (different skill)
    const result3 = scoreSkills(["C"], [], ["C++"]);
    assert.equal(result3.matchedRequired.length, 0, "C++ does not match C");
  });

  it("unknown skills fall through to normal matching", () => {
    const result = scoreSkills(
      ["Banana Sorting"],
      [],
      ["banana sorting"]
    );
    assert.equal(result.matchedRequired.length, 1, "Unknown skills still match via normalization");
  });
});

describe("evaluateLocationMatch — Strict Location Gate", () => {
  const { evaluateLocationMatch } = require("../cvScoring");

  it("Colombo candidate matches Colombo job (100% pass)", () => {
    const result = evaluateLocationMatch("Colombo", "Colombo", true);
    assert.equal(result.score, 100);
    assert.equal(result.gate, "pass");
  });

  it("Dehiwala candidate matches Colombo metro job (100% pass)", () => {
    const result = evaluateLocationMatch("Colombo", "Dehiwala", true);
    assert.equal(result.score, 100);
    assert.equal(result.gate, "pass");
  });

  it("Kegalle candidate is EXCLUDED when strict Colombo location requested", () => {
    const result = evaluateLocationMatch("Colombo", "Kegalle", true);
    assert.equal(result.score, 0);
    assert.equal(result.gate, "excluded_mismatch");
    assert.equal(result.penalty, -40);
  });

  it("Kegalle candidate receives soft region match when strictLocation is false", () => {
    const result = evaluateLocationMatch("Colombo", "Kegalle", false);
    assert.equal(result.score, 85);
    assert.equal(result.gate, "region_pass");
  });
});
