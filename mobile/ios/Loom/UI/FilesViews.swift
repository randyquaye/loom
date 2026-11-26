import SwiftUI

/// What a read-only screen is showing while it loads from the runner. Nothing here is kept
/// after the screen goes away.
private enum Loaded<Value> {
    case loading
    case value(Value)
    case failed(String)
}

private func message(_ error: Error) -> String {
    (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again."
}

struct FilesView: View {
    @Environment(AccountScope.self) private var scope
    let workspaceId: String
    /// Workspace-relative folder; empty for the root.
    let path: String
    @State private var nodes = Loaded<[FileNode]>.loading

    var body: some View {
        Group {
            switch nodes {
            case .loading:
                ProgressView("Loading files…")
            case .failed(let reason):
                FailureView(message: reason) { Task { await load() } }
            case .value(let nodes) where nodes.isEmpty:
                ContentUnavailableView("Empty folder", systemImage: "folder")
            case .value(let nodes):
                List(nodes) { node in
                    NavigationLink(value: node.isDirectory ? Route.files(workspaceId: workspaceId, path: node.path) : Route.file(workspaceId: workspaceId, path: node.path)) {
                        Label(node.name, systemImage: node.isDirectory ? "folder" : "doc.text")
                            .frame(minHeight: 44)
                            .accessibilityLabel(node.isDirectory ? "Folder \(node.name)" : "File \(node.name)")
                    }
                }
                .listStyle(.plain)
                .refreshable { await load() }
            }
        }
        .navigationTitle(path.isEmpty ? "Files" : (path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scope.connection == .connected) { await load() }
    }

    private func load() async {
        if case .value = nodes {} else { nodes = .loading }
        do {
            nodes = .value(try await scope.listDirectory(workspaceId: workspaceId, path: path))
        } catch {
            if case .value = nodes { return }
            nodes = .failed(message(error))
        }
    }
}

/// Monospaced lines, laid out lazily so a large file or diff stays responsive.
private struct CodeLines<Row: View>: View {
    let lines: [String]
    let wrap: Bool
    @ViewBuilder let row: (Int, String) -> Row

    var body: some View {
        GeometryReader { viewport in
            ScrollView(wrap ? .vertical : [.vertical, .horizontal]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { index, line in row(index, line) }
                }
                .padding(.vertical, 8)
                // Short content starts at the top-left instead of floating in the middle.
                .frame(
                    minWidth: viewport.size.width,
                    maxWidth: wrap ? viewport.size.width : nil,
                    minHeight: viewport.size.height,
                    alignment: .topLeading
                )
            }
        }
        .font(.footnote.monospaced())
    }
}

private struct WrapToggle: ToolbarContent {
    @Binding var wrap: Bool

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button { wrap.toggle() } label: {
                Label(wrap ? "Scroll long lines" : "Wrap long lines", systemImage: wrap ? "arrow.left.and.right" : "text.append")
            }
        }
    }
}

struct FileView: View {
    @Environment(AccountScope.self) private var scope
    let workspaceId: String
    let path: String
    @State private var file = Loaded<[String]>.loading
    @State private var wrap = true
    private static let lineLimit = 20_000

    var body: some View {
        Group {
            switch file {
            case .loading:
                ProgressView("Loading file…")
            case .failed(let reason):
                FailureView(message: reason) { Task { await load() } }
            case .value(let lines):
                CodeLines(lines: lines, wrap: wrap) { index, line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(index + 1)")
                            .foregroundStyle(.tertiary)
                            .frame(minWidth: 36, alignment: .trailing)
                            .accessibilityHidden(true)
                        Text(line.isEmpty ? " " : line).textSelection(.enabled).fixedSize(horizontal: !wrap, vertical: true)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 1)
                }
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { WrapToggle(wrap: $wrap) }
        .task { await load() }
    }

    private func load() async {
        file = .loading
        do {
            var lines = try await scope.readFile(workspaceId: workspaceId, path: path).text.components(separatedBy: "\n")
            if lines.count > Self.lineLimit {
                let hidden = lines.count - Self.lineLimit
                lines = Array(lines.prefix(Self.lineLimit)) + ["… \(hidden) more lines not shown"]
            }
            file = .value(lines)
        } catch {
            file = .failed(message(error))
        }
    }
}

struct ChangesView: View {
    @Environment(AccountScope.self) private var scope
    let workspaceId: String
    @State private var changes = Loaded<[ChangeEntry]>.loading

    private static func describe(_ entry: ChangeEntry) -> (text: String, symbol: String) {
        switch entry.status {
        case "added": return ("Added", "plus.circle")
        case "deleted": return ("Deleted", "minus.circle")
        case "renamed": return ("Renamed", "arrow.right.circle")
        case "untracked": return ("New, untracked", "questionmark.circle")
        default: return ("Modified", "pencil.circle")
        }
    }

    var body: some View {
        Group {
            switch changes {
            case .loading:
                ProgressView("Loading changes…")
            case .failed(let reason):
                FailureView(message: reason) { Task { await load() } }
            case .value(let entries) where entries.isEmpty:
                ContentUnavailableView("No changes", systemImage: "checkmark.circle", description: Text("The working tree matches its last commit."))
            case .value(let entries):
                List(entries) { entry in
                    let status = Self.describe(entry)
                    NavigationLink(value: Route.diff(workspaceId: workspaceId, path: entry.path)) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(entry.path).font(.subheadline.monospaced()).lineLimit(2).truncationMode(.middle)
                            Label(
                                status.text + (entry.staged && entry.unstaged ? " · staged and unstaged" : entry.staged ? " · staged" : ""),
                                systemImage: status.symbol
                            )
                            .font(.footnote)
                            .foregroundStyle(LoomStyle.secondary)
                        }
                        .frame(minHeight: 44)
                        .accessibilityElement(children: .combine)
                    }
                }
                .listStyle(.plain)
                .refreshable { await load() }
            }
        }
        .navigationTitle("Changes")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: scope.connection == .connected) { await load() }
    }

    private func load() async {
        if case .value = changes {} else { changes = .loading }
        do {
            changes = .value(try await scope.changes(workspaceId: workspaceId))
        } catch {
            if case .value = changes { return }
            changes = .failed(message(error))
        }
    }
}

/// A read-only unified diff. Added and removed lines keep their + and - and are announced as
/// such, so the difference never depends on color.
struct DiffView: View {
    @Environment(AccountScope.self) private var scope
    let workspaceId: String
    let path: String
    @State private var diff = Loaded<[String]>.loading
    @State private var wrap = false

    private enum Kind {
        case added
        case removed
        case hunk
        case context
    }

    private static func kind(_ line: String) -> Kind {
        if line.hasPrefix("+++") || line.hasPrefix("---") { return .context }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        if line.hasPrefix("@@") { return .hunk }
        return .context
    }

    var body: some View {
        Group {
            switch diff {
            case .loading:
                ProgressView("Loading diff…")
            case .failed(let reason):
                FailureView(message: reason) { Task { await load() } }
            case .value(let lines):
                CodeLines(lines: lines, wrap: wrap) { _, line in
                    let kind = Self.kind(line)
                    Text(line.isEmpty ? " " : line)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: !wrap, vertical: true)
                        .foregroundStyle(kind == .hunk ? LoomStyle.secondary : Color.primary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(kind == .added ? Color.green.opacity(0.18) : kind == .removed ? Color.red.opacity(0.18) : Color.clear)
                        .accessibilityLabel(kind == .added ? "Added: \(line.dropFirst())" : kind == .removed ? "Removed: \(line.dropFirst())" : line)
                }
            }
        }
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { WrapToggle(wrap: $wrap) }
        .task { await load() }
    }

    private func load() async {
        diff = .loading
        do {
            diff = .value(try await scope.diff(workspaceId: workspaceId, path: path).components(separatedBy: "\n"))
        } catch {
            diff = .failed(message(error))
        }
    }
}
