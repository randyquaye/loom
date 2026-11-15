import SwiftUI

struct ConversationView: View {
    @Environment(AccountScope.self) private var scope
    let sessionId: String
    var openFile: ((String) -> Void)? = nil
    /// Whether the end of the transcript is on screen. New output is followed only while it is.
    @State private var atBottom = true
    @State private var openedAtLatest = false
    @State private var confirmCancel = false

    private static let bottom = "transcript-bottom"

    var body: some View {
        Group {
            if let session = scope.session(sessionId) {
                conversation(session)
            } else {
                ContentUnavailableView(
                    "Session unavailable",
                    systemImage: "eye.slash",
                    description: Text("It was closed, or its workspace is no longer shared with you.")
                )
            }
        }
        .task(id: scope.connection == .connected) { await scope.openSession(sessionId) }
        .onAppear { scope.setVisibleSession(sessionId) }
        .onDisappear { scope.setVisibleSession(nil) }
        .environment(\.openChatFile, openFile)
    }

    private func conversation(_ session: SessionRow) -> some View {
        let timeline = scope.timeline(sessionId)
        let blocks = timeline?.transcript.blocks ?? []
        let running = scope.isRunning(sessionId: sessionId)
        let readOnly = !scope.canControl(session.workspaceId)
        // Changes whenever anything worth following arrives, including text growing in place.
        let tail = "\(timeline?.cursor ?? 0)-\(running)"
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if blocks.isEmpty { emptyTranscript(loaded: (timeline?.cursor ?? 0) > 0 || scope.timelineError(sessionId) != nil) }
                    ForEach(blocks) { block in
                        TranscriptRow(block: block, sessionId: sessionId, transcript: timeline?.transcript ?? Transcript(), readOnly: readOnly)
                    }
                    if running {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text("Working…").font(.subheadline).foregroundStyle(LoomStyle.secondary)
                        }
                        .frame(minHeight: 32)
                        .accessibilityElement(children: .combine)
                    }
                    if let error = scope.timelineError(sessionId) {
                        VStack(alignment: .leading, spacing: 6) {
                            Label("Couldn't load the latest messages. \(error)", systemImage: "exclamationmark.triangle").font(.footnote)
                            Button("Try again") { Task { await scope.openSession(sessionId) } }.frame(minHeight: 44)
                        }
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottom)
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: tail) {
                // Reading earlier messages is never interrupted by new ones.
                if atBottom { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .onChange(of: blocks.isEmpty, initial: true) { _, empty in
                // A conversation opens at its latest message, once there is one to show.
                guard !empty, !openedAtLatest else { return }
                openedAtLatest = true
                DispatchQueue.main.async { proxy.scrollTo(Self.bottom, anchor: .bottom) }
            }
            .overlay(alignment: .bottomTrailing) {
                if !atBottom && !blocks.isEmpty {
                    Button {
                        withAnimation { proxy.scrollTo(Self.bottom, anchor: .bottom) }
                    } label: {
                        Label("Jump to latest", systemImage: "arrow.down")
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 14)
                            .frame(minHeight: 44)
                            .background(.regularMaterial, in: Capsule())
                    }
                    .padding(12)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                Composer(sessionId: sessionId, workspaceId: session.workspaceId, running: running, confirmCancel: $confirmCancel)
            }
        }
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("Stop this turn?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Stop turn", role: .destructive) { Task { await scope.cancelTurn(sessionId: sessionId) } }
        } message: {
            Text("The agent stops where it is. What it already did is kept.")
        }
    }

    @ViewBuilder private func emptyTranscript(loaded: Bool) -> some View {
        if loaded || scope.isPreview {
            Text("No messages yet. Send one to start this session's first turn.")
                .font(.subheadline)
                .foregroundStyle(LoomStyle.secondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, 40)
        } else {
            ProgressView("Loading session…").frame(maxWidth: .infinity).padding(.top, 40)
        }
    }
}

/// The message field. Send and Stop are separate controls, and a message stays here until the
/// runner has acknowledged it.
private struct Composer: View {
    @Environment(AccountScope.self) private var scope
    let sessionId: String
    let workspaceId: String
    let running: Bool
    @Binding var confirmCancel: Bool
    @FocusState private var focused: Bool

    /// Why writing is unavailable, in words; nil when it is available.
    private var blocked: String? {
        if !scope.canControl(workspaceId) { return "View only. This workspace is shared with you without control." }
        if scope.connection != .connected { return "Not connected. You can keep typing; sending resumes when the connection is back." }
        return nil
    }

    var body: some View {
        let draft = scope.draft(sessionId)
        let queued = scope.queue(sessionId)
        let viewOnly = !scope.canControl(workspaceId)
        let canSend = blocked == nil && !draft.isSending && !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        VStack(alignment: .leading, spacing: 6) {
            if let session = scope.session(sessionId) {
                Text([session.backend, session.model, session.effort].filter { !$0.isEmpty }.joined(separator: " · "))
                    .font(.caption).foregroundStyle(LoomStyle.secondary).padding(.horizontal, 10)
                    .accessibilityLabel("Current model: \(session.backend), \(session.model), \(session.effort)")
            }
            if !queued.isEmpty {
                Label(queued.count == 1 ? "1 message queued" : "\(queued.count) messages queued", systemImage: "tray.full")
                    .font(.footnote)
                    .foregroundStyle(LoomStyle.secondary)
            }
            if let error = draft.error ?? scope.actionError("cancel:\(sessionId)") {
                Label("Not sent. \(error)", systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
            } else if draft.isSending {
                Label("Sending…", systemImage: "arrow.up.circle").font(.footnote).foregroundStyle(LoomStyle.secondary)
            } else if let blocked {
                Label(blocked, systemImage: viewOnly ? "eye" : "wifi.exclamationmark").font(.footnote).foregroundStyle(LoomStyle.secondary)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if running {
                    Button { confirmCancel = true } label: {
                        Image(systemName: "stop.fill").font(.system(size: 16)).frame(width: 44, height: 44)
                    }
                    .disabled(!scope.canWrite(workspaceId))
                    .accessibilityLabel("Stop turn")
                }
                TextField(
                    running ? "Queue a message" : "Message",
                    text: Binding(get: { scope.draft(sessionId).text }, set: { scope.setDraft(sessionId, $0) }),
                    axis: .vertical
                )
                .lineLimit(1...6)
                .focused($focused)
                .padding(.leading, 16)
                .padding(.vertical, 10)
                .frame(minHeight: 44)
                .disabled(viewOnly || draft.isSending)
                .accessibilityLabel("Message")

                Button { Task { await scope.sendDraft(sessionId: sessionId) } } label: {
                    Group {
                        if draft.isSending { ProgressView() } else {
                            Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(canSend ? LoomStyle.canvas : LoomStyle.secondary)
                                .frame(width: 36, height: 36)
                                .background(canSend ? LoomStyle.ink : Color.primary.opacity(0.08), in: Circle())
                        }
                    }
                    .frame(width: 44, height: 44)
                }
                .disabled(!canSend)
                .accessibilityLabel(draft.error == nil ? "Send" : "Send again")
            }
            .padding(6)
            .background(LoomStyle.quiet, in: RoundedRectangle(cornerRadius: 26))
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(LoomStyle.canvas)
    }
}
