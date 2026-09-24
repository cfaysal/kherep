---
name: kherep-linkedin-draft
description: Use when the user asks to draft, revise, schedule, publish, or remove a LinkedIn post for a personal or organization account.
user-invocable: true
---

# Kherep LinkedIn Draft Workflow

Prepare LinkedIn content in chat, preserve the user's voice, and require explicit approval before any action that publishes, schedules, edits, or removes a live post.

## Discover capabilities

Inspect the installed connector or tool schema before relying on features. Determine which accounts are connected, supported media types, length limits, scheduling behavior, preview or dry-run support, and deletion semantics. Do not assume tool names, account identifiers, storage providers, schedulers, or API behavior from this skill.

If no publishing connector is installed, complete the draft and provide it for manual posting. Do not install or configure a connector unless the user asks.

## Draft workflow

1. Gather the topic, audience, account, goal, source material, language, desired voice, optional media, and timing. Use the user's identity and signature only when supplied in the current context or configured by the user.
2. Draft the complete post in chat. Keep claims traceable to the supplied source.
3. Apply `kherep-content-humanizer`, preserving facts and the selected brand or personal voice.
4. Show the final text and meaningful edits for review.
5. If the connector supports a dry run or preview, use it only after the text is approved and explain what it validates.
6. Publish or schedule only after explicit approval of the final text, account, media, and timing.
7. Return the connector's post URL or receipt and verify the visible post when the tool supports a read-back.

Approval of an earlier draft does not authorize a materially changed version. A request to draft does not authorize publication.

## Media

Use media only through a user-approved, reachable URL or connector-supported upload. Never expose credentials or upload private files to public storage. Check image readability at feed size, supply accurate alt text, and confirm document or carousel support from the live schema.

## Writing guidance

- Use the language requested by the user or implied by the intended audience.
- Prefer concrete outcomes and specific examples over generic claims.
- Derive personal voice from user-provided examples. Derive organization voice from approved brand guidance.
- Keep hashtags, emoji, formatting, signatures, and calls to action configurable.
- Do not invent names, roles, employers, customer claims, metrics, or account ownership.

## Safety

- Never represent a chat draft as a saved platform draft unless the connector proves that state.
- Never use repeated publish-and-delete cycles as a preview mechanism.
- Never expose account identifiers or private connector configuration in the response.
- Confirm before deleting or replacing a live post unless the current request explicitly authorizes it.

## Output

For drafting, return the ready-to-review post and concise edit notes. For an authorized external action, also return the account class, scheduled or published state, timestamp, and connector receipt without sensitive identifiers.
