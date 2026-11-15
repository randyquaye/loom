import SwiftUI

struct ChatHistoryView: View {
    @Environment(AppStore.self) private var store
    @Environment(AccountScope.self) private var scope
    let selectedSessionId: String?
    @Binding var expanded: Set<String>
    let select: (String) -> Void
    let close: () -> Void
    let account: () -> Void
    let details: (String) -> Void
    @State private var search = ""
    @State private var showArchived = false

    private var query: String { search.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func matches(_ row: WorkspaceRow, project: ProjectRow) -> Bool {
        (showArchived || !row.archived) && (query.isEmpty || project.name.localizedCaseInsensitiveContains(query)
            || row.name.localizedCaseInsensitiveContains(query)
            || scope.sessions(in: row.id).contains { $0.title.localizedCaseInsensitiveContains(query) })
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 4) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").font(.system(size: 18)).foregroundStyle(LoomStyle.secondary)
                    TextField("Search", text: $search)
                        .font(.subheadline)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .accessibilityLabel("Search projects, workspaces and loaded sessions")
                    if !search.isEmpty {
                        Button { search = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(LoomStyle.secondary) }
                            .accessibilityLabel("Clear search")
                    }
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 48)
                .background(LoomStyle.quiet, in: RoundedRectangle(cornerRadius: 16))
                Button(action: close) { Image(systemName: "xmark").font(.system(size: 18)).frame(width: 44, height: 44) }
                    .accessibilityLabel("Close workspaces")
            }
            .padding(.top, 8)
            .padding(.bottom, 12)
            if !query.isEmpty {
                Text("Searching projects, workspaces and loaded sessions").font(.caption).foregroundStyle(LoomStyle.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.leading, 8).padding(.bottom, 8)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if store.isPreview { PreviewBanner() }
                    if let error = scope.inventoryError {
                        Text("Couldn't refresh. \(error)").font(.footnote).foregroundStyle(.red).padding(8)
                        Button("Try again") { Task { await scope.refreshInventory() } }.frame(minHeight: 44)
                    }
                    if !scope.hasLoadedInventory && scope.inventoryError == nil {
                        ProgressView("Loading workspaces…").frame(maxWidth: .infinity, minHeight: 140)
                    }
                    let groups = scope.projects.filter { project in scope.workspaces(in: project.id).contains { matches($0, project: project) } }
                    if scope.hasLoadedInventory && groups.isEmpty {
                        Text(query.isEmpty ? "Cloud workspaces created on your desktop appear here." : "No matching projects, workspaces or sessions.")
                            .font(.subheadline).foregroundStyle(LoomStyle.secondary).padding(.vertical, 32).padding(.horizontal, 8)
                    }
                    ForEach(groups) { project in
                        Text(project.name).font(.subheadline).foregroundStyle(LoomStyle.secondary)
                            .padding(.top, 24).padding(.bottom, 8).padding(.horizontal, 8)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(scope.workspaces(in: project.id).filter { matches($0, project: project) }) { workspace in
                            workspaceGroup(workspace, project: project)
                        }
                    }
                }
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await refresh() }
            HStack(spacing: 0) {
                Button(action: account) {
                    HStack(spacing: 12) {
                        Image(systemName: "person.crop.circle.fill").font(.system(size: 28)).foregroundStyle(LoomStyle.secondary)
                        Text(store.account?.email.components(separatedBy: "@").first ?? "Account")
                            .font(.subheadline.weight(.medium)).lineLimit(1)
                        Spacer(minLength: 4)
                        Image(systemName: "gearshape").font(.system(size: 20))
                    }
                    .padding(8).frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .accessibilityLabel("Account and settings")
                Menu {
                    Button("Refresh workspaces", systemImage: "arrow.clockwise") { Task { await refresh() } }
                    Toggle("Show archived", isOn: $showArchived)
                } label: { Image(systemName: "ellipsis").font(.system(size: 20)).frame(width: 44, height: 44) }
                    .accessibilityLabel("Workspace list options")
            }
            .padding(.vertical, 8)
        }
        .padding(.horizontal, 16)
        .background(LoomStyle.canvas.ignoresSafeArea())
        .buttonStyle(.plain)
        .task(id: scope.connection == .connected ? expanded : Set<String>()) { await loadExpanded() }
        .accessibilityAddTraits(.isModal)
    }

    private func workspaceGroup(_ row: WorkspaceRow, project: ProjectRow) -> some View {
        let isExpanded = expanded.contains(row.id) || !query.isEmpty
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if expanded.contains(row.id) { expanded.remove(row.id) } else { expanded.insert(row.id) }
            } label: {
                HStack {
                    Text(row.name).font(.subheadline.weight(.medium)).multilineTextAlignment(.leading)
                    Spacer(minLength: 8)
                    Image(systemName: isExpanded ? "chevron.down" : "chevron.right").font(.system(size: 12)).foregroundStyle(LoomStyle.secondary)
                }
                .padding(.horizontal, 8).padding(.vertical, 10).frame(minHeight: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("\(row.name), \(isExpanded ? "expanded" : "collapsed")")
            .contextMenu { Button("Workspace details", systemImage: "info.circle") { details(row.id) } }
            if isExpanded { sessions(row, project: project) }
        }
    }

    @ViewBuilder private func sessions(_ row: WorkspaceRow, project: ProjectRow) -> some View {
        if scope.hasLoadedSessions(in: row.id) {
            let rows = scope.sessions(in: row.id).filter {
                query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)
                    || row.name.localizedCaseInsensitiveContains(query) || project.name.localizedCaseInsensitiveContains(query)
            }
            if rows.isEmpty {
                Text(query.isEmpty ? "Start a session in Loom on your desktop." : "No matching sessions in this workspace.")
                    .font(.caption).foregroundStyle(LoomStyle.secondary).padding(.leading, 20).padding(.vertical, 10)
            }
            ForEach(rows) { session in
                Button { select(session.id) } label: {
                    HStack(spacing: 8) {
                        Text(session.title).font(.body).lineLimit(2).multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        if scope.isRunning(sessionId: session.id) {
                            Image(systemName: "ellipsis").font(.caption).accessibilityLabel("Agent working")
                        } else if scope.hasUnread(sessionId: session.id) {
                            Image(systemName: "circle.fill").font(.system(size: 6)).accessibilityLabel("New reply")
                        }
                    }
                    .padding(.leading, 20).padding(.trailing, 12).padding(.vertical, 13)
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .background(selectedSessionId == session.id ? LoomStyle.quiet : Color.clear, in: RoundedRectangle(cornerRadius: 14))
                    .contentShape(Rectangle())
                }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(selectedSessionId == session.id ? .isSelected : [])
            }
        } else if let error = scope.sessionsError(in: row.id) {
            Text(error).font(.caption).foregroundStyle(LoomStyle.secondary).padding(.leading, 20)
            Button("Try again") { Task { await scope.loadSessions(workspaceId: row.id) } }.frame(minHeight: 44).padding(.leading, 20)
        } else {
            HStack(spacing: 8) {
                if scope.connection == .connected { ProgressView().controlSize(.small) }
                Text(scope.connection == .connected ? "Loading sessions…" : "Reconnect to load sessions").font(.caption).foregroundStyle(LoomStyle.secondary)
            }.padding(.leading, 20).padding(.vertical, 10)
        }
    }

    private func loadExpanded() async {
        guard scope.connection == .connected else { return }
        for id in expanded where scope.workspace(id) != nil { await scope.loadSessions(workspaceId: id) }
    }

    private func refresh() async {
        await scope.refreshInventory()
        await loadExpanded()
    }
}
