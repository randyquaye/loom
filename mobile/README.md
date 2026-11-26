# Loom mobile

Native iOS and Android companions for existing Loom cloud workspaces. Browse your
workspaces, resume agent conversations, answer questions, control workspace power,
and read files linked in chat. The runner continues agent work when the phone sleeps.

The main screen is a conversation. Its history drawer groups existing chats by
project and workspace; expanding a group loads its sessions without opening a
workspace dashboard. Search covers projects, workspaces and loaded session titles. Workspace options
open Workspace details; the profile opens account settings. Files open from relative
links and path mentions in chat; Files and Changes lists are absent from navigation. Light
and dark themes share neutral surfaces, readable transcripts and a rounded composer.
Tool calls expand without chevrons. The current model appears above the composer.
Long question forms expand inline; secret answers remain local to their visible card.

The apps use SwiftUI on iOS and Kotlin/Jetpack Compose on Android. They connect
directly to your organization's Loom runner; no mobile gateway or hosted relay is
required. Local desktop workspaces are unavailable on phones.

## First use

1. Update the runner to a build advertising the mobile.v1 capability. Existing
   desktop releases continue using their supported features independently.
2. Open the mobile app and enter your organization's HTTPS host and your primary
   Google Workspace email independently.
3. Complete sign-in in the system browser. The app verifies Google's identity,
   the organization's DNS authorization, and the runner's signed TLS binding.
4. Select a workspace and an existing session. Provider logins and new sessions
   are configured in the desktop app for this first mobile release.

Members see their own workspaces and explicitly shared bot workspaces. A shared
View grant permits inspection; Control permits sending, answering and power actions.
The runner enforces both resource access and a separate mobile API allowlist.

## Build locally

Platform project setup and commands are documented in ios/README.md and
android/README.md. The shared synthetic trust fixture is documented in
contracts/README.md. Native tests consume the same fixture as the desktop verifier.

The iOS project requires Xcode and an installed iOS simulator. The Android project
requires its pinned Gradle distribution, a supported JDK and the Android SDK.
Signing identities and SDK paths are local configuration; never commit credentials
or local.properties. Build outputs are ignored by the platform projects.

## Security and lifecycle

- Production connections require HTTPS/WSS, normal certificate authority and
  hostname validation, independent Google/DNS verification, and the current signed
  TLS public-key binding before any reusable credential is transmitted.
- Sign-in uses an external browser, PKCE, state, nonce and an exact platform callback.
  The callbacks are dev.loom.app.ios:/oauth/callback and dev.loom.app.android:/oauth/callback.
- Refresh credentials are stored with OS secure storage. Transcripts, source files
  and question drafts remain in memory. Secret answers use protected input fields.
- Reconnection fills transcript sequence gaps and retries identified sends using
  their original message ID. Ordinary control actions are not silently replayed.
- Sign-out, ended membership and lost workspace access clear private mobile state.
  Background suspension closes the socket; foregrounding reloads authorized state.

The phone does not receive provider API keys, AWS credentials or an administrator
secret. As with desktop, the organization's AWS operator can access host data.
See ../docs/security.md for Loom's trust boundaries and operating limitations.

## First-release boundaries

Existing admitted members and existing cloud sessions are supported. Workspace and
session creation, provider setup, raw terminals, file editing, forwarded ports,
destructive Git actions, bot administration, and push notifications remain desktop
features. The app does not run agents locally or promise continuous background
connectivity. A disconnected preview, where present, is debug-only and clearly labeled.

Local builds and automated checks do not establish production Google sign-in,
physical-device behavior, store approval or independent penetration testing.
Shipping to users requires organization acceptance testing, release signing,
privacy disclosures, and normal platform distribution setup. No app-store upload or
runner deployment is performed by the local build workflow.

## Local verification (2026-11-15)

iOS: 116 XCTest tests; Debug, optimized simulator Release, and unsigned device-SDK
Release builds. Android: 93 JVM tests, four maintained real Keystore device tests,
Debug/optimized Release builds and lint. Additional local emulator acceptance checked
real TLS rejection, signed proofs, native tables/safe links and question scrolling.
The full backend suite passed 992 tests, type checking, lint and production build.

These checks used disconnected sample UI and synthetic credentials. Live organization
sign-in and physical-device acceptance remain separate from the completed local checks.
