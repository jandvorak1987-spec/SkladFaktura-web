/**
 * Security Rule Test Specification for SkladFaktura Firestore Rules.
 * Verifies all "Dirty Dozen" adversarial payloads are rejected with PERMISSION_DENIED
 * against firestore.rules when executed under the Firebase Rules Unit Testing emulator.
 */

export interface DirtyDozenCase {
  id: string;
  title: string;
  path: string;
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  expected: 'PERMISSION_DENIED';
  rationale: string;
}

export const DIRTY_DOZEN_CASES: DirtyDozenCase[] = [
  {
    id: 'DD-01',
    title: 'Unverified Email Write',
    path: '/workspaces/ws_demo/products/prod_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    rationale: 'isVerified() mandates request.auth.token.email_verified == true.',
  },
  {
    id: 'DD-02',
    title: 'Self-Assigned Owner Role on Join',
    path: '/workspaces/ws_demo/members/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    rationale: 'Self-join branch strictly requires incoming().role == "warehouse".',
  },
  {
    id: 'DD-03',
    title: 'Forged Invite Code on Join',
    path: '/workspaces/ws_demo/members/attacker_uid',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    rationale: 'incoming().inviteCodeUsed must equal parent workspace inviteCode.',
  },
  {
    id: 'DD-04',
    title: 'Cross-Tenant Product Read',
    path: '/workspaces/ws_other/products/prod_1',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    rationale: 'Master gate checks exists(/workspaces/{ws}/members/{uid}).',
  },
  {
    id: 'DD-05',
    title: 'Shadow Ghost Field Injection',
    path: '/workspaces/ws_demo/products/prod_2',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    rationale: 'isValidProduct enforces exact keys via hasAll and hasOnly.',
  },
  {
    id: 'DD-06',
    title: 'Identity Spoofing on Stock Movement',
    path: '/workspaces/ws_demo/movements/mov_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    rationale: 'isValidMovement enforces incoming().performedByUid == request.auth.uid.',
  },
  {
    id: 'DD-07',
    title: 'Client Timestamp Forgery',
    path: '/workspaces/ws_demo/invoices/inv_1',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    rationale: 'Temporal integrity requires incoming().createdAt == request.time.',
  },
  {
    id: 'DD-08',
    title: 'Immutable Field Mutation',
    path: '/workspaces/ws_demo/products/prod_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    rationale: 'affectedKeys().hasOnly excludes createdBy, createdAt, workspaceId.',
  },
  {
    id: 'DD-09',
    title: 'Terminal State Bypass on Cancelled Invoice',
    path: '/workspaces/ws_demo/invoices/inv_cancelled',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    rationale: 'Terminal state lock blocks updates when existing().status == "cancelled".',
  },
  {
    id: 'DD-10',
    title: 'PII Scraping on /users/{otherUid}',
    path: '/users/colleague_uid',
    operation: 'get',
    expected: 'PERMISSION_DENIED',
    rationale: '/users/{userId} is strictly isolated to isOwner(userId).',
  },
  {
    id: 'DD-11',
    title: 'Document ID Poisoning',
    path: '/workspaces/ws_demo/products/invalid$id!with%badchars',
    operation: 'create',
    expected: 'PERMISSION_DENIED',
    rationale: 'isValidId enforces ^[a-zA-Z0-9_\\-]+$ and size <= 128.',
  },
  {
    id: 'DD-12',
    title: 'Value Poisoning on Update',
    path: '/workspaces/ws_demo/products/prod_1',
    operation: 'update',
    expected: 'PERMISSION_DENIED',
    rationale: 'isValidProduct wraps entire update block and rejects wrong types/bounds.',
  },
];
