/**
 * Mail intake: reading an application email, and placing it on the right
 * advert from a shared mailbox (linkedin@, cv@, job@). Pure — no Graph, no
 * database.
 */
import { isCvAttachment, isNotAnApplication, parseApplicationEmail } from "../convex/lib/mailParse";
import { linkedinJobId, rankPosts, routeShared, type RoutablePost } from "../convex/lib/postRouting";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const post = (id: string, openingId: string, title: string, extra: Partial<RoutablePost> = {}): RoutablePost => ({
  id, openingId, title, previousTitles: [], aliasKeywords: [], city: null, country: "Sri Lanka",
  channel: "linkedin", campaignCode: "", externalUrl: null, postedAt: 0, status: "live", ...extra,
});

console.log("\nreading a LinkedIn notification");
{
  const p = parseApplicationEmail({
    subject: "New application: Brand Manager from Nimal Perera",
    fromAddress: "jobs-listings@linkedin.com",
    bodyHtml: `<p>Nimal Perera applied for your job</p>
      <a href="https://www.linkedin.com/comm/in/nimal-perera-12ab34?trk=x">View profile</a>
      <a href="https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=abc">Brand Manager</a>
      <p>Phone: 077 123 4567</p><p>nimal.perera@gmail.com</p><p>Sent by jobs-listings@linkedin.com</p>`,
  });
  eq("recognised as LinkedIn", p.isLinkedIn, true);
  eq("the job number from the link", p.linkedinJobId, "4012345678");
  eq("the applicant's name from the subject", p.applicantName, "Nimal Perera");
  eq("the profile link, tracking removed", p.profileUrl, "https://www.linkedin.com/in/nimal-perera-12ab34");
  eq("their email, not LinkedIn's", p.email, "nimal.perera@gmail.com");
  eq("their phone", p.phone, "0771234567");
}
{
  const p = parseApplicationEmail({ subject: "Kasun Silva applied to Head of Finance at Delmo", fromAddress: "jobs-noreply@linkedin.com", bodyText: "no links" });
  eq("'X applied to Y' names the person", p.applicantName, "Kasun Silva");
  eq("no job link is null, not a guess", p.linkedinJobId, null);
}
{
  const p = parseApplicationEmail({ subject: "CV for Accountant post", fromAddress: "someone@gmail.com", bodyText: "Please find my CV attached. Call me on +94 77 555 1234" });
  eq("a direct email is not LinkedIn", p.isLinkedIn, false);
  eq("no name invented from an ordinary subject", p.applicantName, null);
}

console.log("\nnot applications (formats seen on linkedin@, 16 September)");
eq("an automatic reply from the tenant domain", isNotAnApplication("someone@careerc141.onmicrosoft.com", "Automatic reply: RE: New application: Brand Manager from A B"), true);
eq("our own address", isNotAnApplication("azeem@career141.com", "New application: Brand Manager from A B"), true);
eq("an out-of-office from outside", isNotAnApplication("x@gmail.com", "Out of Office: RE: your CV"), true);
eq("a LinkedIn notification is an application", isNotAnApplication("jobs-listings@linkedin.com", "New application: Brand Manager from A B"), false);

console.log("\nwhich attachments are a CV");
eq("a PDF", isCvAttachment({ id: "1", name: "Nimal_CV.pdf", contentType: "application/pdf", size: 200000 }), true);
eq("a DOCX sent as octet-stream", isCvAttachment({ id: "2", name: "cv.docx", contentType: "application/octet-stream", size: 50000 }), true);
eq("an inline signature logo", isCvAttachment({ id: "3", name: "logo.png", contentType: "image/png", size: 4000, isInline: true }), false);
eq("an image is not a CV", isCvAttachment({ id: "4", name: "photo.jpg", contentType: "image/jpeg", size: 90000 }), false);
eq("over 25 MB", isCvAttachment({ id: "5", name: "big.pdf", contentType: "application/pdf", size: 30 * 1024 * 1024 }), false);
eq("a forwarded email item", isCvAttachment({ id: "6", name: "Fwd.pdf", contentType: "application/pdf", size: 1000, "@odata.type": "#microsoft.graph.itemAttachment" }), false);

console.log("\nLinkedIn job numbers");
eq("jobs/view", linkedinJobId("https://www.linkedin.com/jobs/view/3998877665/"), "3998877665");
eq("comm/jobs/view with a slug", linkedinJobId("https://www.linkedin.com/comm/jobs/view/brand-manager-at-delmo-3998877665"), "3998877665");
eq("currentJobId", linkedinJobId("https://www.linkedin.com/jobs/search/?currentJobId=3998877665&geoId=1"), "3998877665");
eq("nothing", linkedinJobId("https://example.com/jobs/view/123"), null);

console.log("\nrouting from a shared mailbox");
// Opening op_brand is advertised twice on LinkedIn (Colombo and Kandy);
// op_brand2 is another client hiring the same title; op_fin is unrelated.
const posts = [
  post("p1", "op_brand", "Brand Manager", { city: "Colombo", postedAt: 10, externalUrl: "https://www.linkedin.com/jobs/view/4011111111/" }),
  post("p2", "op_brand", "Brand Manager", { city: "Kandy", postedAt: 20, externalUrl: "https://www.linkedin.com/jobs/view/4022222222/" }),
  post("p3", "op_fin", "Head of Finance", { previousTitles: ["Finance Head"], campaignCode: "HF-7K3" }),
  post("p4", "op_mkt", "Marketing Executive", { aliasKeywords: ["Marketing Officer"], channel: "whatsapp" }),
];
{
  const r = routeShared({ subject: "New application: Brand Manager from A B", body: "https://www.linkedin.com/comm/jobs/view/4011111111/" }, posts);
  eq("the job number picks the exact post, over the newer one", [r?.postId, r?.how], ["p1", "linkedin_job"]);
}
{
  const r = routeShared({ subject: "New application: Brand Manager from A B", body: "based in Kandy" }, posts);
  eq("no number: the region picks the post", [r?.postId, r?.openingId, r?.alsoTo], ["p2", "op_brand", []]);
}
{
  const r = routeShared({ subject: "New application: Brand Manager from A B", body: "" }, posts);
  eq("two posts of ONE opening: filed once, to the newest post", [r?.postId, r?.openingId, r?.alsoTo], ["p2", "op_brand", []]);
}
{
  const both = [...posts, post("p5", "op_brand2", "Brand Manager", { postedAt: 5 })];
  const r = routeShared({ subject: "New application: Brand Manager from A B", body: "" }, both);
  eq("same title on another client's opening: filed to each", [r?.openingId, r?.alsoTo], ["op_brand", [{ postId: "p5", openingId: "op_brand2" }]]);
}
{
  const r = routeShared({ subject: "You have a new applicant ready for review for Brand Manager of Delmo" }, posts);
  eq("LinkedIn's 'new applicant ready for review for X of Client'", r?.openingId, "op_brand");
  const r2 = routeShared({ subject: "You have a new applicant ready for review for Head of Finance - Colombo" }, posts);
  eq("… and 'for X - Place'", r2?.postId, "p3");
}
{
  const coo = [post("c1", "op_gloves", "Chief Operating Officer - Gloves"), post("c2", "op_coo", "Chief Operating Officer")];
  const r = routeShared({ subject: "New application: Chief Operating Officer - Gloves from A B" }, coo);
  eq("the more specific advert wins, and is not also filed to the shorter title", [r?.openingId, r?.alsoTo], ["op_gloves", []]);
  eq("the shorter title still routes on its own", routeShared({ subject: "New application: Chief Operating Officer from A B" }, coo)?.openingId, "op_coo");
}
{
  // Real linkedin@ subjects that were filed to the wrong openings on 16 September.
  const desk = [
    post("s1", "op_sales", "Sales Manager"),
    post("s2", "op_hbo", "Head of Branch Operations"),
    post("s3", "op_school", "Head of School"),
    post("s4", "op_hos", "Head of Sales"),
    post("s5", "op_gmm", "General Manager – Marketing & Merchandising"),
    post("s6", "op_ehs", "EHS Manager"),
    post("s7", "op_price", "Pricing Manager – Sea & Air Freight"),
    post("s8", "op_spm", "Senior Pricing Manager"),
    post("s9", "op_dmm", "Divisional Merchandise Manager from Apparel Manufacturing Industry"),
    post("s10", "op_gmsea", "General Manager Sales and Marketing - Sea freight"),
    post("s11", "op_gmo", "General Manager - Operations / Sales / Marketing - Shipping / Freight forwarding"),
  ];
  const to = (subject: string) => {
    const r = routeShared({ subject }, desk);
    return r ? [r.openingId, ...r.alsoTo.map((a) => a.openingId)] : null;
  };
  eq("a longer title is not the shorter advert ('General Sales Manager' ≠ Sales Manager)", to("New application: General Sales Manager from Amila Tennakoon"), null);
  eq("'Group Head of Sales' ≠ Head of Sales", to("New application: Group Head of Sales from A B"), null);
  eq("the fragment 'Head' matches no 'Head of …'", to("You have a new applicant ready for review for Head of Operations"), null);
  eq("the fragment 'Manager' matches no '… Manager'", to("New application: Manager – Technical Sales & Business Development (Yeast) from A B"), null);
  eq("a word of the title is not the title ('DGM – Merchandising')", to("You have a new applicant ready for review for DGM – Merchandising"), null);
  eq("'General Manager Operations' is not the long GM advert", to("New application: General Manager Operations from A B"), null);
  eq("the whole title is an advert's head", to("New application: Pricing Manager from A B"), ["op_price"]);
  eq("… including a 'from <industry>' head", to("New application: Divisional Merchandise Manager from A B"), ["op_dmm"]);
  eq("either side of a spaced slash", to("New application: Country Head / General Manager Sales and Marketing - Sea freight from A B"), ["op_gmsea"]);
  eq("an exact title still routes", to("New application: Head of Branch Operations from A B"), ["op_hbo"]);
  eq("a title then a place still routes", to("New application: Sales Manager - Colombo from A B"), ["op_sales"]);
  eq("a title then a role-changing word does not", to("New application: Sales Manager Assistant from A B"), null);
}
eq("an old headline still routes",routeShared({ subject: "Application for Finance Head" }, posts)?.postId, "p3");
eq("a campaign code decides outright", [routeShared({ subject: "Re: my CV", body: "code HF-7K3" }, posts)?.postId, routeShared({ subject: "Re: my CV", body: "code HF-7K3" }, posts)?.how], ["p3", "campaign_code"]);
eq("a keyword the TA set routes", routeShared({ subject: "CV - Marketing Officer" }, posts)?.postId, "p4");
eq("the LinkedIn mailbox ignores non-LinkedIn adverts", routeShared({ subject: "CV - Marketing Officer", linkedinOnly: true }, posts), null);
eq("a partial match across the desk goes to the database, not a guess", routeShared({ subject: "Finance Manager application" }, posts), null);
eq("nothing matching", routeShared({ subject: "Hello" }, posts), null);
eq("rankPosts keeps the TA-mailbox tie rule", rankPosts(posts, "Brand Manager")?.primary.post.id, "p2");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
