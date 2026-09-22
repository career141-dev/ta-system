export default {
  providers: [
    {
      // The TA System's Clerk production instance (22 September) — the live
      // site at ta-system.career141.com signs in here. The development instance
      // below stays trusted until everyone has moved over.
      domain: "https://clerk.ta-system.career141.com",
      applicationID: "convex",
    },
    {
      // The TA System's Clerk development instance since 17 September
      // (replaces upward-squid-19, whose accounts no longer sign in).
      domain: "https://prime-elf-9817.clerk.accounts.dev",
      applicationID: "convex",
    },
    {
      domain: "https://clerk.career141.com",
      applicationID: "convex",
    }
  ]
};
