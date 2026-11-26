# Loom for iOS

A native SwiftUI app (iOS 17+, bundle `dev.loom.app.ios`, in the desktop app's `dev.loom.app`
namespace) for existing members of a Loom
organization. It lists your cloud workspaces and the bot workspaces shared with you, and lets
you read a session's conversation, send messages, answer an agent's questions, stop a turn,
start or stop a workspace, and read files linked in chat.

It speaks the stable runner protocol 6 (`src/shared/runner-contract.ts`) and asks for the
optional capabilities `bots.v1,mobile.v1` in `x-loom-capabilities`. A runner whose hello does not
grant `mobile.v1` is shown as needing an update, and is sent no call at all; a runner without
`bots.v1` is used normally and lists no bot workspaces. Only the channels a mobile sign-in is
allowed are called. There are no third-party packages.

## What this version leaves to the desktop

Creating sessions and workspaces, terminals, editing files, checkpoints, pull requests,
settings, invites, notifications and background work. A workspace with no sessions says to
start one in Loom on the desktop: the phone has no server-known model list and no copy of
your instruction files, so it resumes sessions rather than creating them.

## Build and test

Requires Xcode with an iOS 17+ simulator, and [XcodeGen](https://github.com/yonaskolb/XcodeGen)
only if you change `project.yml`.

```sh
cd mobile/ios
xcodegen generate            # only after editing project.yml; Loom.xcodeproj is checked in
xcodebuild test -project Loom.xcodeproj -scheme Loom \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath ../../.context/mobile/ios/DerivedData
```

Or open `Loom.xcodeproj` and run the `Loom` scheme. Running on a device needs your own
signing team set on the `Loom` target.

The tests need no network and no account. They use:

- `mobile/contracts/trust-fixture.json`, the synthetic Google token, DNS record, host proof and
  transport proof shared with the Android app;
- a fake runner and a raw TLS server on loopback, inside the simulator;
- TLS identities generated at test time in the simulator keychain and deleted afterwards. No
  private key is stored in the repository.

## Preview mode (screenshots)

A DEBUG build launched with `-LoomPreview` shows invented sample data under a yellow
"Preview" banner. It has no sign-in and no connection, and the code is compiled out of
release builds, so it cannot be used to get past authentication.

```sh
xcrun simctl launch booted dev.loom.app.ios -LoomPreview
xcrun simctl launch booted dev.loom.app.ios -LoomPreview -LoomPreviewRoute session:s1
```

Routes: `workspace:w1`, `session:s1`, `session:s5` (rich text sample), `files:w1`, `file:w1:src/payments/capture.ts`,
`changes:w1`, `diff:w1:src/payments/capture.ts`, `account`.

The chat-first shell opens grouped history when no conversation is selected. Choose
a session directly from its workspace group; workspace options open Workspace details.
Files open from chat path mentions and Markdown relative links. Files and Changes
lists are absent from production navigation. Tool calls toggle without chevrons;
the current provider, model and effort appear above the composer. Selection and drawer state stay in the account's view lifetime.
For the redesign sample use `session:s6`; `drawer:s6` shows its selected history row.

## How sign-in and connections are secured

1. You type your work email and your organization's host. Neither is prefilled or saved.
2. The system authentication session opens `/auth/start` with a PKCE challenge, state and
   nonce. The only callback accepted is exactly `dev.loom.app.ios:/oauth/callback` with this
   attempt's state, once. The app has no handler for opened URLs.
3. The code goes to `/auth/proof` without the verifier. The app then checks, on its own
   connections, that Google signed the returned identity for the email you typed, and that
   `_loom.<your Workspace domain>` in DNS lists this host and its signing key.
4. Before every credential-bearing connection (code exchange, renewal, sign-out and the
   WebSocket) the app fetches `/auth/transport` and verifies it against that domain. It then
   opens a fresh Network.framework TLS connection with session resumption and tickets off.
   Nothing is sent until the handshake has passed normal CA and hostname validation, the proof
   is still current, and the leaf certificate's SPKI hash equals the signed one.
5. The refresh token is kept in the Keychain (service `dev.loom.app.ios.credentials`; this
   device only, readable while unlocked, never synced), together with the host and verified
   domain as one item. A rotated token is used only once it is saved: if saving fails (a locked
   device), the new pair is held unused and saved before anything else is done with it. A
   Keychain that cannot be read is retried, never treated as signed out. A sign-in that cannot
   be saved is revoked. Access tokens, conversations, files and drafts stay in memory, owned by
   one scope per sign-in that is discarded when the sign-in ends. Ordinary question answers are
   kept while their card scrolls out of view; secret answers live only in the card on screen.
6. Signing out drops the private scope immediately and checks Keychain erasure. If the OS
   cannot erase it, the app clearly reports that sign-out is unfinished and retries erasure
   before any saved credential can be reused. The same Try again screen handles unlock and
   foreground retries. Closing the app before erasure finishes may leave the saved sign-in;
   no claim of completed sign-out is made in that state.
7. Going to the background closes the socket. Coming back reconnects and reloads what you may
   currently see. Signing out, or the host ending the sign-in, clears everything loaded.

Public fetches (Google's keys, DNS-over-HTTPS, `/auth/proof`, `/auth/transport`) never follow
redirects, stop after 15 seconds and accept at most 64 KiB.

## Transcript rendering

Foundation parses full Markdown, including GFM tables and nested lists. A small adapter groups
its native presentation intents into SwiftUI text, grids and code blocks. Parsing is serialized
outside the main actor so streamed updates do not start overlapping work. Text is selectable;
wide tables and code scroll horizontally. Image URLs are removed and only alt text is shown.
HTTP/HTTPS links open in the browser. Relative file links and prose path mentions
open the read-only reader in the current session’s workspace. Code remains literal.
Absolute paths, traversal and other URL schemes remain inert; chat links cannot
invoke control actions.

## Layout

| Folder | Contents |
| --- | --- |
| `Loom/Trust` | Google identity, DNS, host-proof and transport-proof verification; SPKI extraction |
| `Loom/Auth` | Host address, sign-in attempt and callback, code exchange, Keychain, token renewal |
| `Loom/Transport` | Public HTTP, pinned TLS transport, WebSocket, runner connection |
| `Loom/Model` | Runner rows, agent events, transcript folding, question answers |
| `Loom/Store` | The one observable store, and DEBUG preview data |
| `Loom/UI` | SwiftUI screens |
| `LoomTests` | XCTest acceptance tests and their loopback fixtures |

## Not covered by the local tests

A real Google sign-in, a real organization host and its certificate, a physical device, a
genuinely locked device's Keychain (simulated by failing the store), and App Store signing have
not been exercised. The app icon is the desktop app's `resources/icon.png`.
