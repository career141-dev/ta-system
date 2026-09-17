export default {
  providers: [
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
