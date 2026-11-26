# Loom for Android

A native Kotlin/Jetpack Compose (Material 3) client for existing members of a Loom
organization. It lets you check cloud workspaces, start or stop them (Stop asks for
confirmation), continue existing sessions, send messages, stop a turn, answer agent
questions (single choice, multiple choice, secret fields) and read files linked in chat.
Agents keep running on the host while the phone sleeps.

The app does not create sessions or workspaces. Sessions keep the model and personal
instructions chosen on the desktop, and no server-side model catalog exists yet. If a
workspace has no sessions, the app tells you to start one in Loom on your desktop.
Invites, terminals, editing, checkpoints, PR merges and settings also stay desktop-only.

## Build

Requirements: Android SDK 37.0 with build-tools 36.0.0 (`sdk.dir` in an ignored
`local.properties`, or `ANDROID_HOME`), and a JDK 17–21, such as Android Studio's bundled JBR.

```sh
cd mobile/android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ./gradlew testDebugUnitTest assembleDebug lintDebug
```

The wrapper pins Gradle 9.6.1 with `distributionSha256Sum`. AGP 9.3.3 uses built-in Kotlin;
the matching Compose compiler is 2.4.21. Compile SDK 37, target 36, minimum 29.
OkHttp 5.5.1 includes the current compromised-intermediate trust fix; Tink is 1.24.0. The unit tests run on the JVM
and read the shared synthetic fixture `../contracts/trust-fixture.json`. With a device or
emulator attached, `./gradlew connectedDebugAndroidTest` also checks credential sealing
against the real Android Keystore, under a test-only key alias.

Debug builds only: a disconnected sample UI for screenshots and layout review. It is
labelled "PREVIEW" and never touches the network or saved credentials. Its code lives in
`app/src/debug`, so release builds do not contain it and ignore the extra:

```sh
adb shell am start -S -n dev.loom.app.android/.MainActivity --ez preview true
```

History groups conversations by project and workspace; expanding a group loads
only its sessions. Choosing a session replaces the previous session. Workspace details
and files opened from chat links use the normal back stack. Files and Changes lists
are absent from production navigation. Search covers projects, workspaces and loaded
sessions. Tool calls toggle without chevrons; the current model appears above the composer.
The neutral light/dark theme, compact header and rounded composer frame the chat.

Debug screenshot routes can be opened with an additional string extra, for example
`--es previewRoute session:s6` (everyday chat), `session:s1` (questions), `session:s2`
(view only), `files:w1`, `changes:w1`, `workspace:w1` or `account`. Route handling
lives exclusively in the disconnected debug source set.

Screenshots work only on that sample screen. Every other launch, the sign-in screen
included, sets `FLAG_SECURE` and disables the recents thumbnail.

Signing in needs a default browser with Auth Tab (Chrome 137 or later). The app does not
fall back to a Custom Tab or a plain browser launch; it asks you to update the browser.

## Design

- `trust/Trust.kt`: pure verification. It checks the Google RS256 ID token (JCA), the exact
  DoH TXT `_loom.<hd>` record, the Ed25519 host proof and the transport proof (Tink
  `Ed25519Verify`, since minSdk 29 has no platform Ed25519). Base64 must be canonical,
  the SPKI must be exactly 44 bytes, and signed JSON never escapes `/`.
- `ui/AssistantMarkdown.kt`: native Compose GFM rendering through the upstream Markdown
  renderer. Tables, lists, inline formatting and code remain native; images never load,
  HTTP/HTTPS links use the browser, and relative file links/path mentions open
  the current workspace’s read-only file reader. Code remains literal. Traversal,
  absolute paths and other URL schemes remain inert.
- `core/Json.kt`: Moshi's streaming `JsonReader`/`JsonWriter` behind a small adapter to
  plain Kotlin maps and lists. No reflection or generated adapters. The adapter adds what
  the trust code relies on: integer literals stay `Long`, duplicate keys and nesting past
  128 are refused. Moshi accepts `True`/`NULL` spellings and raw control characters inside
  strings, which the previous hand-written parser refused.
- `auth/AuthManager.kt`: the one owner of credentials. Every change to memory, disk and
  the published state is a transaction under one mutex: it writes the vault, then
  publishes. Network requests run outside it as children of the sign-in or attempt that
  started them. Ending that identity cancels them, and a late answer is applied only if
  the same identity is still current. A rotated refresh token is saved before its access
  token is handed out. If the save fails, the rotation is kept in memory and saved on the
  next request instead of replaying the consumed token, which the host would treat as
  theft and revoke.
- `auth/AuthBrowser.kt`: PKCE S256, state and nonce through AndroidX Browser 1.9 Auth Tab.
  The redirect `dev.loom.app.android:/oauth/callback` returns as an activity result from the
  browser the intent was addressed to. The manifest has no intent filter for it. The
  verifier is sent only after every proof passes.
- `auth/FileCredentialVault.kt`, `auth/KeystoreCipher.kt`: Keystore AES-256-GCM (StrongBox
  when available) in no-backup storage, replaced atomically. The record is erased only on
  sign-out or when it is proven unreadable (bad tag, key reported missing or permanently
  invalidated). A key store that fails to answer leaves the record intact and offers Try again.
  If erasure fails, sign-out is explicitly incomplete; the session is unusable and erasure
  retries before any new sign-in. Closing the app before erasure succeeds may leave the
  saved sign-in, so that state never claims sign-out finished.
- `net/PinnedTransport.kt`: every token, revoke and WebSocket connection fetches a fresh
  `/auth/transport` and re-anchors its key through DoH. Each gets a fresh `SSLContext`
  (no session reuse), platform CA and hostname checks, an expiry recheck and an exact
  leaf-SPKI pin. It runs a second leaf check before any request byte. No pooling,
  redirects or Origin header.
- `runner/RunnerConnection.kt`: base protocol 6 with `x-loom-capabilities:
  bots.v1,mobile.v1`, all on one serial dispatcher. Unless the host's hello grants
  `mobile.v1`, the app sends nothing after its own hello and shows "update required". It
  fences stale socket callbacks by generation, handles close 4400 and 4401/HTTP 401 (one
  renewed token, then signed out), and fails ordinary calls when disconnected. Identified
  `sessions:send` calls are resent with the same `messageId`, until their caller is
  cancelled. `rebind` hands the connection to the next sign-in: pending calls fail and
  the old socket is dropped.
- `runner/Transcript.kt`: in-order `{seq,event}` folding that buffers gaps, drops
  duplicates and replaces streamed text with the final text. It resolves questions and
  never keeps secret answers.
- `app/PrivateSession.kt`: everything fetched for one sign-in, and the requests fetching
  it. All work runs under the session's job; work for a workspace runs under that
  workspace's child job. Sign-out or a different sign-in disposes the session; losing a
  grant cancels that workspace's job. Cancelled requests never write. Nothing is persisted.
- `ui/QuestionCard.kt`: secret answers stay in the card and clear when it disappears.
  Ordinary answers live in the conversation, surviving lazy-list recycling; they clear on
  resolution, successful submission, navigation away, access loss or sign-out.
- `app/AppStore.kt`: the `StateFlow` the screens read. It holds no private data: it owns
  the current `PrivateSession` and mirrors its data.
- `allowBackup=false`, no cleartext, system CAs only.

## Not verified locally

- Real Google sign-in, a live organization host and DoH/TLS pinning against a real
  certificate.
- A completed Auth Tab round trip: it needs a real host to redirect back.
- A key store outage. `connectedDebugAndroidTest` runs `KeystoreCipher` against the real
  Android Keystore (round trip, tampering, deleted key), but an unavailable key store
  cannot be forced on a device; that path is tested only through the fake cipher in
  `FileCredentialVaultTest`.
- Physical devices. Local emulator checks exercise Android's real trust-manager path with
  an ephemeral test CA, accepted pins and zero request bytes on wrong pin/CA/host/expiry.
  Production system trust is never modified or replaced.
- Store signing.
