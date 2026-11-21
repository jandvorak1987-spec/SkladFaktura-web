# SkladFaktura Security Specification (Phase 0 TDD)

## 1. Data Invariants
1. **PII Isolation**: `/users/{userId}` is strictly private to `request.auth.uid == userId`. No blanket `isSignedIn()` reads.
2. **Workspace Master Gate**: Every subcollection (`products`, `movements`, `customers`, `invoices`, `members`) under `/workspaces/{workspaceId}` requires verified membership in `/workspaces/{workspaceId}/members/{request.auth.uid}`. Revoking a member removes access immediately.
3. **Anti-Privilege Escalation**: Self-joining a workspace via invite code MUST strictly assign `role: 'warehouse'` and verify `inviteCodeUsed` against the workspace's active `inviteCode`. Only `owner` (or bootstrapped admin) can promote/demote roles.
4. **Immutable Ledger**: `/workspaces/{workspaceId}/movements/{movementId}` entries are append-only (`update` and `delete` denied for non-admins) and must bind `performedByUid == request.auth.uid`.
5. **Terminal State Locking**: Invoices in terminal state `cancelled` cannot be modified by standard members.
6. **Temporal Integrity**: `createdAt` and `updatedAt` must strictly match `request.time`. `createdAt`, `workspaceId`, `ownerId`, and `createdBy` are immutable on updates.
7. **Volumetric Bounds**: Every string has explicit `.size()` bounds; arrays (`workspaceIds <= 10`, `invoice.items <= 50`) are strictly bounded with element checks; all path IDs match `^[a-zA-Z0-9_\\-]+$` and `<= 128` chars.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unverified Email Write**: Authenticated user with `email_verified: false` attempts to create a product -> DENIED.
2. **Self-Assigned Owner Role**: Colleague joins workspace with `{ role: "owner", inviteCodeUsed: "VALID-CODE" }` -> DENIED.
3. **Invalid Invite Code Join**: Attacker tries to join `/workspaces/ws1/members/attackerUid` with `{ role: "warehouse", inviteCodeUsed: "WRONG-CODE" }` -> DENIED.
4. **Cross-Tenant Product Read**: User outside `ws1` attempts `get` on `/workspaces/ws1/products/p1` -> DENIED.
5. **Shadow Ghost Field Injection**: Member creates product with extra key `isAdminApproved: true` -> DENIED.
6. **Identity Spoofing on Movement**: Member creates stock movement with `performedByUid: "colleague_uid"` -> DENIED.
7. **Timestamp Forgery**: Member creates invoice with client timestamp `createdAt: "2020-01-01"` instead of `request.time` -> DENIED.
8. **Immutable Field Mutation**: Member attempts to update `workspaceId` or `createdBy` on a product -> DENIED.
9. **Terminal State Bypass**: Member attempts to change a `cancelled` invoice back to `paid` -> DENIED.
10. **PII Scraping**: Signed-in colleague reads `/users/otherUid` -> DENIED.
11. **ID Poisoning**: Attacker creates document at `/workspaces/ws1/products/../../evil$id` or 500-char ID -> DENIED.
12. **Value Poisoning on Update**: Member updates `quantity` to a string `"999"` or `items` to an array of 100 entries -> DENIED.
