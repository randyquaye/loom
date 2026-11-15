import SwiftUI

enum Route: Hashable {
    case workspace(String)
    case session(String)
    case files(workspaceId: String, path: String)
    case file(workspaceId: String, path: String)
    case changes(String)
    case diff(workspaceId: String, path: String)
}

/// A screen inside a workspace exists only while the runner still lists that workspace. When it
/// stops (a bot grant revoked), the screen is replaced, and with it everything it loaded into its
/// own state: file text, diffs and typed answers are discarded, not merely hidden behind a notice.
struct WorkspaceScoped<Content: View>: View {
    @Environment(AccountScope.self) private var scope
    let route: Route
    @ViewBuilder let content: () -> Content

    private var workspaceId: String? {
        switch route {
        case .workspace(let id), .changes(let id): return id
        case .files(let id, _), .file(let id, _), .diff(let id, _): return id
        case .session(let id): return scope.session(id)?.workspaceId
        }
    }

    var body: some View {
        Group {
            if let workspaceId, scope.workspace(workspaceId) != nil {
                content()
            } else {
                ContentUnavailableView(
                    "No longer available",
                    systemImage: "eye.slash",
                    description: Text("It was removed or closed, or its workspace is no longer shared with you.")
                )
            }
        }
    }
}

/// A workspace's state in words and a symbol, never by color alone.
struct WorkspaceStatus {
    let text: String
    let symbol: String
    var isProblem = false

    init(_ row: WorkspaceRow, power: WorkspacePower?) {
        if row.archived {
            (text, symbol) = ("Archived", "archivebox")
            return
        }
        switch row.state {
        case "error": (text, symbol, isProblem) = ("Setup failed", "exclamationmark.triangle", true)
        case "initializing": (text, symbol) = ("Creating", "hourglass")
        case "setting_up": (text, symbol) = ("Setting up", "hourglass")
        default:
            switch power?.state {
            case "running": (text, symbol) = ("Running", "play.circle")
            case "stopped": (text, symbol) = ("Stopped", "stop.circle")
            case "starting": (text, symbol) = ("Starting", "hourglass")
            case "stopping": (text, symbol) = ("Stopping", "hourglass")
            case "error": (text, symbol, isProblem) = ("Could not start", "exclamationmark.triangle", true)
            default: (text, symbol) = ("Ready", "checkmark.circle")
            }
        }
    }
}

/// Explains a connection that is not live, in a row above the content.
struct ConnectionBanner: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if store.isPreview {
            PreviewBanner()
        } else {
            switch store.connection {
            case .connected:
                EmptyView()
            case .idle, .connecting:
                banner("Connecting to your organization's host…", symbol: "arrow.triangle.2.circlepath", retry: false)
            case .unreachable:
                banner("Can't reach or verify your organization's host. Trying again…", symbol: "wifi.exclamationmark", retry: true)
            case .signedOut:
                banner("Your sign-in has ended.", symbol: "person.crop.circle.badge.exclamationmark", retry: false)
            case .update(let message):
                banner(message, symbol: "arrow.down.circle", retry: true)
            }
        }
    }

    private func banner(_ text: String, symbol: String, retry: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).accessibilityHidden(true)
            Text(text).font(.footnote).frame(maxWidth: .infinity, alignment: .leading)
            if retry {
                Button("Retry") { Task { await store.retryConnection() } }
                    .font(.footnote.weight(.semibold))
                    .frame(minWidth: 44, minHeight: 44)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, retry ? 2 : 10)
        .background(Color(.secondarySystemBackground))
        .accessibilityElement(children: .combine)
    }
}

/// A loading failure with a way to try again.
struct FailureView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label("Couldn't load", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again", action: retry).frame(minHeight: 44)
        }
    }
}

/// The account-scoped chat selection survives opening history, but is never persisted.
struct WorkspacesView: View {
    @Environment(AccountScope.self) private var scope
    @State private var path: [Route] = []
    @State private var selectedSessionId: String?
    @State private var showDrawer = true
    @State private var expanded: Set<String> = []
    @State private var initialized = false
    @State private var showAccount = false

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                NavigationStack(path: $path) {
                    VStack(spacing: 0) {
                        header
                        ConnectionBanner()
                        if let id = selectedSessionId {
                            WorkspaceScoped(route: .session(id)) {
                                ConversationView(sessionId: id, openFile: { file in
                                    if let session = scope.session(id) { path.append(.file(workspaceId: session.workspaceId, path: file)) }
                                }).id(id)
                            }
                        } else {
                            ContentUnavailableView {
                                Label("Your workspaces", systemImage: "bubble.left.and.bubble.right")
                            } description: {
                                Text("Choose a workspace and session to continue where you left off.")
                            } actions: {
                                Button("Browse workspaces") { showDrawer = true }.frame(minHeight: 44)
                            }
                        }
                    }
                    .background(LoomStyle.canvas)
                    .toolbar(.hidden, for: .navigationBar)
                    .navigationDestination(for: Route.self) { route in
                        WorkspaceScoped(route: route) {
                            destination(route)
                        }
                        .safeAreaInset(edge: .top, spacing: 0) { ConnectionBanner() }
                        .toolbar(.visible, for: .navigationBar)
                        .toolbarBackground(LoomStyle.canvas, for: .navigationBar)
                    }
                }
                .accessibilityHidden(showDrawer)
                if showDrawer {
                    Color.black.opacity(0.22).ignoresSafeArea()
                        .onTapGesture { showDrawer = false }
                        .accessibilityHidden(true)
                    ChatHistoryView(
                        selectedSessionId: selectedSessionId, expanded: $expanded,
                        select: { id in
                            selectedSessionId = id
                            path.removeAll()
                            showDrawer = false
                        },
                        close: { showDrawer = false },
                        account: { showAccount = true; showDrawer = false },
                        details: { id in path.append(.workspace(id)); showDrawer = false }
                    )
                    .frame(width: min(360, max(geometry.size.width * 0.87, geometry.size.width - 70)))
                    .transition(.move(edge: .leading))
                    .gesture(DragGesture(minimumDistance: 30).onEnded { value in
                        if value.translation.width < -70 { showDrawer = false }
                    })
                }
            }
            .animation(.easeOut(duration: 0.22), value: showDrawer)
            .background(LoomStyle.canvas.ignoresSafeArea())
        }
        .sheet(isPresented: $showAccount) { AccountView().presentationDragIndicator(.visible) }
        .onChange(of: scope.hasLoadedInventory, initial: true) { _, loaded in
            guard loaded, !initialized else { return }
            initialized = true
            if let project = scope.projects.first,
               let row = scope.workspaces(in: project.id).first(where: { !$0.archived }) {
                expanded.insert(row.id)
            }
        }
        .onChange(of: selectionAvailable) { _, available in
            if !available { selectedSessionId = nil; path.removeAll(); showDrawer = true }
        }
        #if DEBUG
        .onAppear(perform: openPreviewRoute)
        #endif
    }

    private var selectionAvailable: Bool {
        guard let id = selectedSessionId else { return true }
        guard let session = scope.session(id) else { return false }
        return scope.workspace(session.workspaceId) != nil
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                showDrawer = true
            } label: { Image(systemName: "line.3.horizontal").font(.system(size: 20)).frame(width: 44, height: 44) }
                .accessibilityLabel("Workspaces")
            VStack(spacing: 2) {
                Text(selectedSessionId.flatMap { scope.session($0)?.title } ?? "Loom")
                    .font(.headline).lineLimit(1).accessibilityAddTraits(.isHeader)
                if let id = selectedSessionId, let session = scope.session(id), let workspace = scope.workspace(session.workspaceId) {
                    Text(workspace.name).font(.caption).foregroundStyle(LoomStyle.secondary).lineLimit(1)
                        .accessibilityLabel("Workspace: \(workspace.name)")
                }
            }.frame(maxWidth: .infinity)
            if let id = selectedSessionId, let session = scope.session(id) {
                Menu {
                    Button("Workspace details", systemImage: "info.circle") { path.append(.workspace(session.workspaceId)) }
                } label: { Image(systemName: "ellipsis").font(.system(size: 20)).frame(width: 44, height: 44) }
                    .accessibilityLabel("Workspace options")
            } else {
                Color.clear.frame(width: 44, height: 44).accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 8).frame(minHeight: 52)
        .buttonStyle(.plain)
    }

    @ViewBuilder private func destination(_ route: Route) -> some View {
        switch route {
        case .workspace(let id): WorkspaceView(workspaceId: id, sessionId: selectedSessionId)
        case .session(let id): ConversationView(sessionId: id, openFile: { file in
            if let session = scope.session(id) { path.append(.file(workspaceId: session.workspaceId, path: file)) }
        })
        case .files(let id, let path): FilesView(workspaceId: id, path: path)
        case .file(let id, let path): FileView(workspaceId: id, path: path)
        case .changes(let id): ChangesView(workspaceId: id)
        case .diff(let id, let path): DiffView(workspaceId: id, path: path)
        }
    }

    #if DEBUG
    private func openPreviewRoute() {
        guard scope.isPreview, selectedSessionId == nil, path.isEmpty,
              let route = UserDefaults.standard.string(forKey: "LoomPreviewRoute") else { return }
        let parts = route.split(separator: ":", maxSplits: 2).map(String.init)
        let id = parts.count > 1 ? parts[1] : ""
        let file = parts.count > 2 ? parts[2] : ""
        showDrawer = false
        switch parts.first {
        case "session", "drawer":
            selectedSessionId = id
            if let session = scope.session(id) { expanded.insert(session.workspaceId) }
            showDrawer = parts.first == "drawer"
        case "workspace": path = [.workspace(id)]
        case "files": path = [.files(workspaceId: id, path: file)]
        case "file": path = [.file(workspaceId: id, path: file)]
        case "changes": path = [.changes(id)]
        case "diff": path = [.changes(id), .diff(workspaceId: id, path: file)]
        case "account": showAccount = true
        default: showDrawer = true
        }
    }
    #endif
}

/// Says outright whether a shared bot workspace may be acted in.
struct AccessBadge: View {
    let access: SharedAccess

    var body: some View {
        Label(access == .control ? "Shared · Control" : "Shared · View only", systemImage: access == .control ? "person.2.fill" : "eye")
            .font(.caption2.weight(.semibold))
            .labelStyle(.titleAndIcon)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
            .foregroundStyle(LoomStyle.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }
}

struct AccountView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var confirmSignOut = false

    private var connectionText: String {
        if store.isPreview { return "Sample data · Not connected" }
        switch store.connection {
        case .connected: return "Connected"
        case .idle, .connecting: return "Connecting"
        case .unreachable: return "Not reachable"
        case .signedOut: return "Signed out"
        case .update: return "Update needed"
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let account = store.account {
                        DetailRow(title: "Email", value: account.email)
                        DetailRow(title: "Organization", value: account.origin.replacingOccurrences(of: "https://", with: ""))
                        DetailRow(title: "Verified domain", value: account.trustDomain)
                        DetailRow(title: "Connection", value: connectionText)
                    }
                    Divider().padding(.vertical, 4)
                    Text("On your phone").font(.headline)
                    Text("Continue sessions, answer questions, and view files linked in chat. Agents keep working when you close the app.")
                        .font(.subheadline).foregroundStyle(LoomStyle.secondary)
                    Text("Create workspaces and sessions, configure providers, and manage your organization in Loom on your desktop.")
                        .font(.footnote).foregroundStyle(LoomStyle.secondary)
                    Divider().padding(.vertical, 4)
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                        .frame(minHeight: 44).disabled(store.isPreview)
                    Text("Removes this device’s access and clears loaded content. Agents keep running.")
                        .font(.footnote).foregroundStyle(LoomStyle.secondary)
                }
                .padding(24).frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(LoomStyle.canvas)
            .safeAreaInset(edge: .top, spacing: 0) { if store.isPreview { PreviewBanner() } }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .confirmationDialog("Sign out of Loom on this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task {
                        await store.signOut()
                        dismiss()
                    }
                }
            } message: {
                Text("Unsent messages on this device are discarded.")
            }
        }
    }
}
