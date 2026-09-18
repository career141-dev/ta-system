# Career141 — Capture from LinkedIn

A Chrome extension that files the LinkedIn profile you are looking at into an
opening's Excel Table.

## What it does, and what it will not do

It reads the page already open in your own logged-in session, when you press
the button. That is the whole of it.

It does **not** navigate to profiles, queue them, walk a search result page, run
on a timer, or read anything you have not opened yourself. Those lines are
deliberate: bulk collection is what LinkedIn sued Proxycurl over, and this is a
different thing — a person looking at a page, filing it.

Every capture records the URL it came from and who pressed the button.

## Installing it

1. Chrome → `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose this `extension` folder.
3. Open the platform you want to file into (`http://localhost:3100` locally,
   or `https://ta-system.career141.com` on staging) → any opening →
   **Headhunting → Excel Tables** → copy the access token from the *Capture
   from LinkedIn* panel. The token is per deployment — a local token will not
   work against staging and the other way round.
4. Click the extension's icon → ⚙ → paste that platform's address and token →
   **Connect**.
5. Choose who you are and which opening you are working, and you are set.

Pointing it at a platform address other than `localhost` or
`ta-system.career141.com` needs that host added to `host_permissions` in
`manifest.json` first — Chrome will not let the extension reach an address it
was not granted, and there is no in-extension prompt for it.

## Using it

Open a LinkedIn profile. A green **Add to Career141** button sits bottom-right,
naming the opening it will file into. Press it. The row appears in that
opening's Excel Table with the name, title and company already filled.

Capturing the same person twice updates their row rather than adding a second
one.

If you have their contact-info panel open, the email and phone are read too.
The extension never opens that panel itself.

## Changing which opening you are filing into

Click the extension icon and pick a different one. The button on the LinkedIn
page updates immediately.

## Known limits

- **Recruiter pages** (`/talent/…`) are best-effort. Public profile pages
  (`/in/…`) carry a schema.org record that survives LinkedIn's redesigns;
  Recruiter does not, so the fallback selectors there need a pass against a
  real page.
- LinkedIn changes their DOM often. The name, headline, company and location
  come from the embedded record and are stable; experience, education and
  skills come from the page and are the first things to break.
- The access token is a development shared secret. At connection it is replaced
  by the signed-in Clerk session.
